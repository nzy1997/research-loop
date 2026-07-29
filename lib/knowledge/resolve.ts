/**
 * Answers one question for an agent: "which files do I have to read before I
 * may state something about X?"
 *
 * The answer is a *reading bundle* — the root-to-topic chain of indexes plus the
 * selected content pages — in repository-relative POSIX form, so the caller
 * reads exactly those paths without guessing a root or walking the tree itself.
 *
 * Three rules make that answer trustworthy:
 *
 * - **it is deterministic.** Ranking is a pure function of the graph and the
 *   query: tiers first, then how many query terms matched, then the author's
 *   curated reading order, then POSIX path. No step consults the clock, the
 *   filesystem, or the order a directory happened to enumerate in, so the same
 *   tree and the same question always produce the same bundle;
 * - **it never guesses.** When the best candidates sit in more than one topic
 *   the result is `ambiguous` with every candidate attached, because choosing
 *   between two research objects is the user's judgement, not the resolver's.
 *   Within *one* topic a tie is not a guess — every tied page is selected;
 * - **it only ever reports validated, trusted pages.** `resolveKnowledge` loads
 *   the tree, validates it completely against the configured bibliography, and
 *   throws `KnowledgeValidationError` if anything is wrong; it never answers
 *   from pages that have not passed the gate. `drafts/` and `literature/` are
 *   not part of the graph at all, so no query can reach them.
 *
 * `resolveGraph` is the pure half and does no validation of its own: it ranks
 * whatever graph it is handed. That split is what lets the tests pin ordering on
 * trees the gate would refuse, and it is why the public entry point is the one
 * that stands behind the gate.
 */

import path from "node:path";

import {
  UNCURATED,
  comparePosix,
  curatedOrder,
  diagnosticFile,
  loadKnowledge,
  type KnowledgeGraph,
  type LoadKnowledgeOptions,
} from "./graph.js";
import type { ParsedKnowledgePage } from "./types.js";
import {
  KnowledgeValidationError,
  bibliographyPathFor,
  validateGraph,
} from "./validate.js";

/** Why a page is a candidate. The order of the tiers is the ranking contract. */
export type MatchKind =
  | "exact-title"
  | "exact-alias"
  | "title-term"
  | "alias-term"
  | "description-term"
  | "body-term";

export interface ResolveCandidate {
  /** Repository-relative POSIX path, for example `knowledge/ising/proof.qmd`. */
  page: string;
  /** Repository-relative POSIX path of the index that owns the page. */
  topic: string;
  title: string;
  matchKind: MatchKind;
  tier: number;
  /** How many distinct query terms the matching field carries. */
  matchedTerms: number;
}

/**
 * Everything the agent must read, in the order it must be read.
 *
 * `ancestorIndexes` runs from the root index down to and including the topic
 * index — the chain that gives the content its context — and `orderedFiles` is
 * that chain followed by the content pages, de-duplicated. Every entry is a
 * repository-relative POSIX path.
 */
export interface ReadingBundle {
  topic: string;
  ancestorIndexes: readonly string[];
  contentPages: readonly string[];
  orderedFiles: readonly string[];
}

export type ResolveResult =
  | {
      schemaVersion: 1;
      query: string;
      status: "match";
      bundle: ReadingBundle;
      /** Every candidate the bundle does not already name. */
      alternatives: readonly ResolveCandidate[];
    }
  | {
      schemaVersion: 1;
      query: string;
      status: "ambiguous";
      bundle: null;
      /** Every candidate, tied ones included: the caller chooses. */
      alternatives: readonly ResolveCandidate[];
    }
  | {
      schemaVersion: 1;
      query: string;
      status: "no-match";
      bundle: null;
      alternatives: readonly [];
    };

/** Thrown when a query carries nothing that could be searched for. */
export class KnowledgeQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeQueryError";
  }
}

/** The rank of each kind of match; lower wins. */
const TIER_OF: Readonly<Record<MatchKind, number>> = {
  "exact-title": 0,
  "exact-alias": 1,
  "title-term": 2,
  "alias-term": 3,
  "description-term": 4,
  "body-term": 5,
};

/**
 * Splits any text into comparable terms.
 *
 * NFKC folds the compatibility forms a query may arrive in — fullwidth Latin
 * from a CJK keyboard, ligatures, superscripts — onto the characters a page is
 * written with; lowercasing in a fixed locale keeps the result the same
 * everywhere the tool runs; and taking only letter/number runs means
 * punctuation, hyphenation, and Markdown syntax never decide a match.
 */
function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** The normalized form two texts must share to count as the same text. */
function tokenKey(text: string): string {
  return tokenize(text).join(" ");
}

/** A query, ready to compare: the whole normalized phrase and its terms. */
interface Query {
  key: string;
  /** The distinct terms, so a repeated word cannot count twice. */
  terms: readonly string[];
}

function parseQuery(query: string): Query {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    throw new KnowledgeQueryError(
      `the query ${JSON.stringify(query)} holds no letters or digits to search for`,
    );
  }
  return { key: tokens.join(" "), terms: [...new Set(tokens)] };
}

/** How many distinct query terms appear in one field. */
function countTerms(text: string, terms: readonly string[]): number {
  const present = new Set(tokenize(text));
  let matched = 0;
  for (const term of terms) {
    if (present.has(term)) {
      matched += 1;
    }
  }
  return matched;
}

/**
 * The best reason one page answers the query, or nothing.
 *
 * The fields are tried in tier order and the first hit wins, so a page that
 * merely mentions a word in its body can never outrank one that is titled with
 * it. An exact match means the whole query is the whole field once both are
 * normalized, which is why it counts every query term as matched.
 */
function rankPage(
  page: ParsedKnowledgePage,
  query: Query,
): { kind: MatchKind; matchedTerms: number } | undefined {
  const title = page.title ?? "";
  if (tokenKey(title) === query.key) {
    return { kind: "exact-title", matchedTerms: query.terms.length };
  }
  if (page.aliases.some((alias) => tokenKey(alias) === query.key)) {
    return { kind: "exact-alias", matchedTerms: query.terms.length };
  }

  const fields: readonly (readonly [MatchKind, string])[] = [
    ["title-term", title],
    // Joining is the union of every alias: an alias set is a bag of names for
    // one page, not competing candidates.
    ["alias-term", page.aliases.join(" ")],
    ["description-term", page.description ?? ""],
    // The body is matched as written, Markdown included, because the resolver
    // has no opinion about prose: it is the last and weakest tier by design.
    ["body-term", page.body],
  ];
  for (const [kind, text] of fields) {
    const matchedTerms = countTerms(text, query.terms);
    if (matchedTerms > 0) {
      return { kind, matchedTerms };
    }
  }
  return undefined;
}

/** The repository-relative POSIX path of a page id, for example `knowledge/x.qmd`. */
function repoPath(graph: KnowledgeGraph, id: string): string {
  return diagnosticFile(graph.repoRoot, path.join(graph.knowledgeRoot, ...id.split("/")));
}

/** A candidate plus the internal identity the ranking sorts on. */
interface Ranked {
  id: string;
  page: ParsedKnowledgePage;
  candidate: ResolveCandidate;
}

/** The root-to-page chain of indexes, ending at the page itself. */
function ancestorChain(graph: KnowledgeGraph, topicId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = topicId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = graph.parentByPage.get(current);
  }
  return chain.reverse();
}

/**
 * The bundle for one topic's selected pages.
 *
 * A selected *index* stands for its topic, so the bundle takes every direct
 * content page of its reading map — the whole topic, which is what a question
 * answered by a topic name asks for. Sub-topic indexes are not taken: their
 * pages belong to a question about them. A selected *content* page brings only
 * itself, together with any page that tied with it.
 */
function buildBundle(
  graph: KnowledgeGraph,
  order: ReadonlyMap<string, number>,
  selected: readonly Ranked[],
): ReadingBundle {
  const contentIds = new Set<string>();
  for (const entry of selected) {
    if (entry.page.kind !== "index") {
      contentIds.add(entry.id);
      continue;
    }
    for (const childId of graph.childrenByIndex.get(entry.id) ?? []) {
      if (graph.pages.get(childId)?.kind === "content") {
        contentIds.add(childId);
      }
    }
  }

  const rankOf = (id: string): number => order.get(id) ?? UNCURATED;
  const contentPages = [...contentIds]
    .sort((left, right) => rankOf(left) - rankOf(right) || comparePosix(left, right))
    .map((id) => repoPath(graph, id));

  const [first] = selected;
  const topicId = first.page.topicId;
  const ancestorIndexes = ancestorChain(graph, topicId).map((id) => repoPath(graph, id));

  return {
    topic: repoPath(graph, topicId),
    ancestorIndexes,
    contentPages,
    orderedFiles: [...new Set([...ancestorIndexes, ...contentPages])],
  };
}

/**
 * Ranks one loaded graph against one query, without judging the graph.
 *
 * Callers that publish or answer research questions must use
 * `resolveKnowledge`, which validates first.
 */
export function resolveGraph(
  graph: KnowledgeGraph,
  query: string,
  selectedPage?: string,
): ResolveResult {
  const parsed = parseQuery(query);
  const order = curatedOrder(graph);
  const rankOf = (id: string): number => order.get(id) ?? UNCURATED;

  const ranked: Ranked[] = [];
  for (const page of graph.pages.values()) {
    const match = rankPage(page, parsed);
    if (match === undefined) {
      continue;
    }
    ranked.push({
      id: page.id,
      page,
      candidate: {
        page: repoPath(graph, page.id),
        topic: repoPath(graph, page.topicId),
        title: page.title ?? "",
        matchKind: match.kind,
        tier: TIER_OF[match.kind],
        matchedTerms: match.matchedTerms,
      },
    });
  }

  ranked.sort(
    (left, right) =>
      left.candidate.tier - right.candidate.tier ||
      right.candidate.matchedTerms - left.candidate.matchedTerms ||
      rankOf(left.id) - rankOf(right.id) ||
      comparePosix(left.id, right.id),
  );

  if (ranked.length === 0) {
    if (selectedPage !== undefined) {
      throw new KnowledgeQueryError(
        `the selected page ${JSON.stringify(selectedPage)} cannot be applied because the query is not ambiguous`,
      );
    }
    return { schemaVersion: 1, query, status: "no-match", bundle: null, alternatives: [] };
  }

  // Everything as good as the best candidate is selected. Ranking beyond that
  // pair orders the answer; it never decides what the answer is.
  const [best] = ranked;
  const selected = ranked.filter(
    (entry) =>
      entry.candidate.tier === best.candidate.tier &&
      entry.candidate.matchedTerms === best.candidate.matchedTerms,
  );

  const topics = new Set(selected.map((entry) => entry.page.topicId));
  if (topics.size > 1) {
    if (selectedPage !== undefined) {
      const chosen = ranked.find((entry) => entry.candidate.page === selectedPage);
      if (chosen === undefined) {
        throw new KnowledgeQueryError(
          `the selected page ${JSON.stringify(selectedPage)} is not a resolver alternative`,
        );
      }
      const bundle = buildBundle(graph, order, [chosen]);
      const named = new Set(bundle.orderedFiles);
      return {
        schemaVersion: 1,
        query,
        status: "match",
        bundle,
        alternatives: ranked
          .filter((entry) => !named.has(entry.candidate.page))
          .map((entry) => entry.candidate),
      };
    }
    return {
      schemaVersion: 1,
      query,
      status: "ambiguous",
      bundle: null,
      alternatives: ranked.map((entry) => entry.candidate),
    };
  }

  if (selectedPage !== undefined) {
    throw new KnowledgeQueryError(
      `the selected page ${JSON.stringify(selectedPage)} cannot be applied because the query is not ambiguous`,
    );
  }
  const bundle = buildBundle(graph, order, selected);
  const named = new Set(bundle.orderedFiles);
  return {
    schemaVersion: 1,
    query,
    status: "match",
    bundle,
    alternatives: ranked
      .filter((entry) => !named.has(entry.candidate.page))
      .map((entry) => entry.candidate),
  };
}

/**
 * Resolves a query against the trusted knowledge tree.
 *
 * Load, then validate completely, then rank: an invalid tree throws
 * `KnowledgeValidationError` carrying every diagnostic rather than answering
 * from pages nothing has checked.
 */
export async function resolveKnowledge(
  query: string,
  options: LoadKnowledgeOptions & { bibliographyPath?: string; selectedPage?: string } = {},
): Promise<ResolveResult> {
  const graph = await loadKnowledge(options);
  const report = await validateGraph(graph, {
    bibliographyPath: bibliographyPathFor(graph.repoRoot, options.bibliographyPath),
  });
  if (!report.ok) {
    throw new KnowledgeValidationError(report);
  }
  return resolveGraph(graph, query, options.selectedPage);
}

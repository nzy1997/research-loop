/**
 * The resolver is the only door an agent walks through before it states a
 * research fact, so these tests pin the two properties that make it trustworthy:
 * it is *deterministic* — one query against one tree always yields the same
 * ranking, the same bundle, and the same alternatives — and it *never guesses*,
 * returning `ambiguous` with every tied candidate rather than an arbitrary
 * winner.
 *
 * Every case works on a real tree under `mkdtemp`: either the shared valid
 * fixture or a purpose-built tree whose reading maps deliberately disagree with
 * alphabetical order, because curated order beating path order is exactly the
 * behaviour that a hand-built graph object would fail to prove.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadKnowledge } from "../../lib/knowledge/graph.js";
import {
  KnowledgeQueryError,
  resolveGraph,
  resolveKnowledge,
  type ResolveCandidate,
} from "../../lib/knowledge/resolve.js";
import {
  KnowledgeValidationError,
  validateGraph,
  validateKnowledge,
} from "../../lib/knowledge/validate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "knowledge");
const CLI = path.join(REPO_ROOT, "scripts", "knowledge.ts");

const run = promisify(execFile);

/** A throwaway repository holding the shared valid fixture as `knowledge/`. */
async function makeRepo(t: TestContext): Promise<string> {
  const repo = await mkdtemp(path.join(await realpath(tmpdir()), "knowledge-resolve-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await cp(path.join(FIXTURES, "valid"), path.join(repo, "knowledge"), {
    recursive: true,
  });
  await mkdir(path.join(repo, "literature"), { recursive: true });
  await cp(path.join(FIXTURES, "ref.bib"), path.join(repo, "literature", "ref.bib"));
  return repo;
}

/** One `.qmd` source: frontmatter in the given order, then the body. */
function qmd(frontmatter: Record<string, string>, body: readonly string[]): string {
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    ...body,
    "",
  ].join("\n");
}

/** An index body whose `## Reading map` lists the given targets, in order. */
function indexBody(targets: readonly string[]): string[] {
  return [
    "Nothing here.",
    "",
    "## Reading map",
    "",
    ...(targets.length === 0
      ? ["No pages have been promoted yet."]
      : targets.map((target) => `- [Entry](${target})`)),
  ];
}

/** A throwaway repository holding exactly the given knowledge pages. */
async function makeTree(
  t: TestContext,
  pages: Record<string, string>,
): Promise<string> {
  const repo = await mkdtemp(path.join(await realpath(tmpdir()), "knowledge-resolve-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(pages)) {
    const file = path.join(repo, "knowledge", ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  await mkdir(path.join(repo, "literature"), { recursive: true });
  await cp(path.join(FIXTURES, "ref.bib"), path.join(repo, "literature", "ref.bib"));
  return repo;
}

/** `page kind tier matchedTerms`, the shape every ranking case asserts. */
function ranking(candidates: readonly ResolveCandidate[]): string[] {
  return candidates.map(
    (candidate) =>
      `${candidate.page} ${candidate.matchKind} ${candidate.tier} ${candidate.matchedTerms}`,
  );
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function knowledgeCli(...args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: REPO_ROOT },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// Normalization and the exact tiers, against the shared valid fixture.
// ---------------------------------------------------------------------------

test("an exact title resolves the whole topic it names", async (t) => {
  const repo = await makeRepo(t);
  const result = await resolveKnowledge("Ising model", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.query, "Ising model");
  assert.deepEqual(result.bundle, {
    topic: "knowledge/ising/index.qmd",
    ancestorIndexes: ["knowledge/index.qmd", "knowledge/ising/index.qmd"],
    contentPages: [
      "knowledge/ising/proof.qmd",
      "knowledge/ising/proposal.qmd",
      "knowledge/ising/verified-code.qmd",
    ],
    orderedFiles: [
      "knowledge/index.qmd",
      "knowledge/ising/index.qmd",
      "knowledge/ising/proof.qmd",
      "knowledge/ising/proposal.qmd",
      "knowledge/ising/verified-code.qmd",
    ],
  });
  assert.deepEqual(
    ranking(result.alternatives),
    [],
    "a page the bundle already names is not also an alternative",
  );
});

test("an exact alias resolves the same topic as its title", async (t) => {
  const repo = await makeRepo(t);
  const result = await resolveKnowledge("2D Ising", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.equal(result.bundle.topic, "knowledge/ising/index.qmd");
  assert.deepEqual(result.bundle.orderedFiles, [
    "knowledge/index.qmd",
    "knowledge/ising/index.qmd",
    "knowledge/ising/proof.qmd",
    "knowledge/ising/proposal.qmd",
    "knowledge/ising/verified-code.qmd",
  ]);
});

test("NFKC folding and case folding make a query equal to a title", async (t) => {
  const repo = await makeRepo(t);
  // Fullwidth `ISING`, an ideographic space, fullwidth `MODEL`.
  const query = "ＩＳＩＮＧ　ＭＯＤＥＬ";
  const result = await resolveKnowledge(query, { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.equal(result.query, query, "the result echoes the query as it was written");
  assert.equal(result.bundle.topic, "knowledge/ising/index.qmd");
});

test("a description term resolves the page that describes it", async (t) => {
  const repo = await makeRepo(t);
  const result = await resolveKnowledge("duality argument", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.deepEqual(result.bundle, {
    topic: "knowledge/ising/index.qmd",
    ancestorIndexes: ["knowledge/index.qmd", "knowledge/ising/index.qmd"],
    contentPages: ["knowledge/ising/proof.qmd"],
    orderedFiles: [
      "knowledge/index.qmd",
      "knowledge/ising/index.qmd",
      "knowledge/ising/proof.qmd",
    ],
  });
  assert.deepEqual(
    ranking(result.alternatives),
    ["knowledge/ising/verified-code.qmd body-term 5 1"],
    "a weaker body match stays visible as an alternative",
  );
});

test("a body term resolves a page nothing else mentions", async (t) => {
  const repo = await makeRepo(t);
  const result = await resolveKnowledge("Binder cumulant", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.deepEqual(result.bundle.contentPages, ["knowledge/ising/proposal.qmd"]);
  assert.deepEqual(ranking(result.alternatives), []);
});

// ---------------------------------------------------------------------------
// The ranking contract, against a tree with one page per tier.
// ---------------------------------------------------------------------------

/**
 * One topic holding a page for each tier of the same query.
 *
 * `zeta.qmd` is curated *before* `alpha.qmd` and they rank identically, so any
 * result that lists `alpha` first has fallen back to path order where curated
 * order was available.
 */
const TIER_TREE: Record<string, string> = {
  "index.qmd": qmd(
    { title: "Root", description: "The root of the tier fixture." },
    indexBody(["terms/index.qmd"]),
  ),
  "terms/index.qmd": qmd(
    { title: "Terms", description: "A topic that holds one page per tier." },
    indexBody([
      "exact.qmd",
      "alias-exact.qmd",
      "title-term.qmd",
      "zeta.qmd",
      "alpha.qmd",
      "alias-term.qmd",
      "description.qmd",
      "body.qmd",
    ]),
  ),
  "terms/exact.qmd": qmd(
    { title: "Spin glass", description: "One.", categories: "[theory]" },
    ["Nothing here."],
  ),
  "terms/alias-exact.qmd": qmd(
    {
      title: "Frustration",
      description: "Two.",
      categories: "[theory]",
      aliases: '["spin glass"]',
    },
    ["Nothing here."],
  ),
  "terms/title-term.qmd": qmd(
    { title: "Spin glass transitions", description: "Three.", categories: "[theory]" },
    ["Nothing here."],
  ),
  "terms/zeta.qmd": qmd(
    { title: "Spin waves", description: "Four.", categories: "[theory]" },
    ["Nothing here."],
  ),
  "terms/alpha.qmd": qmd(
    { title: "Spin dynamics", description: "Five.", categories: "[theory]" },
    ["Nothing here."],
  ),
  "terms/alias-term.qmd": qmd(
    {
      title: "Replica symmetry",
      description: "Six.",
      categories: "[theory]",
      aliases: '["spin glass models"]',
    },
    ["Nothing here."],
  ),
  "terms/description.qmd": qmd(
    {
      title: "Order parameter",
      description: "The spin glass order parameter.",
      categories: "[theory]",
    },
    ["Nothing here."],
  ),
  "terms/body.qmd": qmd(
    { title: "Numerics", description: "Sampling notes.", categories: "[theory]" },
    ["A spin glass sampler."],
  ),
};

test("the tier order is title, alias, title term, alias term, description, body", async (t) => {
  const repo = await makeTree(t, TIER_TREE);
  assert.equal(
    (await validateKnowledge({ repoRoot: repo })).ok,
    true,
    "the tier fixture must itself be a valid tree",
  );

  const result = await resolveKnowledge("spin glass", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.deepEqual(result.bundle.contentPages, ["knowledge/terms/exact.qmd"]);
  assert.deepEqual(ranking(result.alternatives), [
    "knowledge/terms/alias-exact.qmd exact-alias 1 2",
    "knowledge/terms/title-term.qmd title-term 2 2",
    "knowledge/terms/zeta.qmd title-term 2 1",
    "knowledge/terms/alpha.qmd title-term 2 1",
    "knowledge/terms/alias-term.qmd alias-term 3 2",
    "knowledge/terms/description.qmd description-term 4 2",
    "knowledge/terms/body.qmd body-term 5 2",
  ]);
  assert.deepEqual(
    result.alternatives.map((candidate) => candidate.topic),
    Array.from({ length: 7 }, () => "knowledge/terms/index.qmd"),
    "every candidate names the topic that owns it",
  );
  assert.equal(result.alternatives[0]?.title, "Frustration");
});

test("tied pages of one topic are all selected, in curated order", async (t) => {
  const repo = await makeTree(t, TIER_TREE);
  const result = await resolveKnowledge("spin waves dynamics", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.deepEqual(
    result.bundle.contentPages,
    ["knowledge/terms/zeta.qmd", "knowledge/terms/alpha.qmd"],
    "the reading map, not the alphabet, orders the selected pages",
  );
  assert.deepEqual(result.bundle.orderedFiles, [
    "knowledge/index.qmd",
    "knowledge/terms/index.qmd",
    "knowledge/terms/zeta.qmd",
    "knowledge/terms/alpha.qmd",
  ]);
  assert.deepEqual(ranking(result.alternatives), [
    "knowledge/terms/exact.qmd title-term 2 1",
    "knowledge/terms/title-term.qmd title-term 2 1",
    "knowledge/terms/alias-exact.qmd alias-term 3 1",
    "knowledge/terms/alias-term.qmd alias-term 3 1",
    "knowledge/terms/description.qmd description-term 4 1",
    "knowledge/terms/body.qmd body-term 5 1",
  ]);
});

test("resolving is pure: the same graph answers the same query identically", async (t) => {
  const repo = await makeTree(t, TIER_TREE);
  const graph = await loadKnowledge({ repoRoot: repo });

  const first = resolveGraph(graph, "spin glass");
  const second = resolveGraph(graph, "spin glass");

  assert.deepEqual(first, second);
  assert.deepEqual(first, await resolveKnowledge("spin glass", { repoRoot: repo }));
});

// ---------------------------------------------------------------------------
// Bundle semantics.
// ---------------------------------------------------------------------------

const NESTED_TREE: Record<string, string> = {
  "index.qmd": qmd(
    { title: "Root", description: "The root of the nested fixture." },
    indexBody(["kagome/index.qmd"]),
  ),
  "kagome/index.qmd": qmd(
    { title: "Kagome antiferromagnet", description: "A topic with a subtopic." },
    indexBody(["one.qmd", "sub/index.qmd", "two.qmd"]),
  ),
  "kagome/one.qmd": qmd(
    { title: "One", description: "First.", categories: "[theory]" },
    ["Nothing here."],
  ),
  "kagome/two.qmd": qmd(
    { title: "Two", description: "Second.", categories: "[experiment]" },
    ["Nothing here."],
  ),
  "kagome/sub/index.qmd": qmd(
    { title: "Deep subtopic", description: "A subtopic of the topic." },
    indexBody(["three.qmd"]),
  ),
  "kagome/sub/three.qmd": qmd(
    { title: "Three", description: "Third.", categories: "[codes]" },
    ["Nothing here."],
  ),
};

test("an index match takes every direct content page of its reading map", async (t) => {
  const repo = await makeTree(t, NESTED_TREE);
  assert.equal(
    (await validateKnowledge({ repoRoot: repo })).ok,
    true,
    "the nested fixture must itself be a valid tree",
  );

  const result = await resolveKnowledge("kagome antiferromagnet", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.deepEqual(result.bundle, {
    topic: "knowledge/kagome/index.qmd",
    ancestorIndexes: ["knowledge/index.qmd", "knowledge/kagome/index.qmd"],
    contentPages: ["knowledge/kagome/one.qmd", "knowledge/kagome/two.qmd"],
    orderedFiles: [
      "knowledge/index.qmd",
      "knowledge/kagome/index.qmd",
      "knowledge/kagome/one.qmd",
      "knowledge/kagome/two.qmd",
    ],
  });
});

test("a bundle prepends the whole root-to-target chain of indexes", async (t) => {
  const repo = await makeTree(t, NESTED_TREE);
  const result = await resolveKnowledge("deep subtopic", { repoRoot: repo });

  assert.ok(result.status === "match", `expected a match, got ${result.status}`);
  assert.deepEqual(result.bundle, {
    topic: "knowledge/kagome/sub/index.qmd",
    ancestorIndexes: [
      "knowledge/index.qmd",
      "knowledge/kagome/index.qmd",
      "knowledge/kagome/sub/index.qmd",
    ],
    contentPages: ["knowledge/kagome/sub/three.qmd"],
    orderedFiles: [
      "knowledge/index.qmd",
      "knowledge/kagome/index.qmd",
      "knowledge/kagome/sub/index.qmd",
      "knowledge/kagome/sub/three.qmd",
    ],
  });
});

const AMBIGUOUS_TREE = {
  "index.qmd": qmd(
    { title: "Root", description: "The root of the ambiguous fixture." },
    indexBody(["beta/index.qmd", "alpha/index.qmd"]),
  ),
  "beta/index.qmd": qmd(
    { title: "Beta topic", description: "Curated first, second alphabetically." },
    indexBody(["note.qmd"]),
  ),
  "beta/note.qmd": qmd(
    { title: "Kagome lattice", description: "One note.", categories: "[theory]" },
    ["Nothing here."],
  ),
  "alpha/index.qmd": qmd(
    { title: "Alpha topic", description: "Curated second, first alphabetically." },
    indexBody(["note.qmd"]),
  ),
  "alpha/note.qmd": qmd(
    { title: "Kagome lattice", description: "Another note.", categories: "[experiment]" },
    ["Nothing here."],
  ),
};

test("equally ranked matches in different topics are ambiguous, never guessed", async (t) => {
  const repo = await makeTree(t, AMBIGUOUS_TREE);
  assert.equal((await validateKnowledge({ repoRoot: repo })).ok, true);

  const result = await resolveKnowledge("kagome lattice", { repoRoot: repo });

  assert.ok(
    result.status === "ambiguous",
    `expected an ambiguous result, got ${result.status}`,
  );
  assert.equal(result.bundle, null);
  assert.deepEqual(ranking(result.alternatives), [
    "knowledge/beta/note.qmd exact-title 0 2",
    "knowledge/alpha/note.qmd exact-title 0 2",
  ]);
  assert.deepEqual(
    result.alternatives.map((candidate) => `${candidate.topic} ${candidate.title}`),
    ["knowledge/beta/index.qmd Kagome lattice", "knowledge/alpha/index.qmd Kagome lattice"],
  );
});

test("an explicit user selection materializes only that ambiguous candidate's bundle", async (t) => {
  const repo = await makeTree(t, AMBIGUOUS_TREE);

  const result = await resolveKnowledge("kagome lattice", {
    repoRoot: repo,
    selectedPage: "knowledge/alpha/note.qmd",
  });

  assert.ok(result.status === "match", `expected a selected match, got ${result.status}`);
  assert.deepEqual(result.bundle, {
    topic: "knowledge/alpha/index.qmd",
    ancestorIndexes: ["knowledge/index.qmd", "knowledge/alpha/index.qmd"],
    contentPages: ["knowledge/alpha/note.qmd"],
    orderedFiles: [
      "knowledge/index.qmd",
      "knowledge/alpha/index.qmd",
      "knowledge/alpha/note.qmd",
    ],
  });
});

test("a selected page is rejected when the query is no longer ambiguous", async (t) => {
  const repo = await makeTree(t, TIER_TREE);

  await assert.rejects(
    resolveKnowledge("spin glass", {
      repoRoot: repo,
      selectedPage: "knowledge/terms/alias-exact.qmd",
    }),
    /selected page.*query is not ambiguous/i,
  );
});

test("pages outside the curated tree fall back to a stable path order", async (t) => {
  // `resolveGraph` is the pure layer: it ranks whatever graph it is handed. A
  // page no reading map lists has no curated position, so POSIX path order is
  // the only tie-break left — and it must be used rather than the order the
  // filesystem happened to enumerate in. `resolveKnowledge` refuses this tree,
  // which the validation-gate case below pins.
  const repo = await makeTree(t, {
    "index.qmd": qmd({ title: "Root", description: "The root." }, indexBody([])),
    "winner.qmd": qmd(
      { title: "Kagome lattice", description: "First.", categories: "[theory]" },
      ["Nothing here."],
    ),
    "zzz.qmd": qmd(
      { title: "Kagome geometry", description: "Second.", categories: "[theory]" },
      ["Nothing here."],
    ),
    "aaa.qmd": qmd(
      { title: "Kagome geometry", description: "Third.", categories: "[theory]" },
      ["Nothing here."],
    ),
  });
  const graph = await loadKnowledge({ repoRoot: repo });
  assert.equal(
    (
      await validateGraph(graph, {
        bibliographyPath: path.join(repo, "literature", "ref.bib"),
      })
    ).ok,
    false,
    "an uncurated page is an invalid tree; only the pure layer answers here",
  );
  // The loader hands its pages over in sorted order, which would hide a missing
  // path tie-break behind a stable sort. Enumeration order is never allowed to
  // decide anything, so the same pages arrive in the opposite order here.
  const shuffled = { ...graph, pages: new Map([...graph.pages].reverse()) };

  const ranked = resolveGraph(graph, "kagome lattice");
  assert.ok(ranked.status === "match", `expected a match, got ${ranked.status}`);
  assert.deepEqual(ranked.bundle.contentPages, ["knowledge/winner.qmd"]);
  assert.deepEqual(ranking(ranked.alternatives), [
    "knowledge/aaa.qmd title-term 2 1",
    "knowledge/zzz.qmd title-term 2 1",
  ]);
  assert.deepEqual(resolveGraph(shuffled, "kagome lattice"), ranked);

  const tied = resolveGraph(graph, "kagome geometry");
  assert.ok(tied.status === "match", `expected a match, got ${tied.status}`);
  assert.deepEqual(tied.bundle, {
    topic: "knowledge/index.qmd",
    ancestorIndexes: ["knowledge/index.qmd"],
    contentPages: ["knowledge/aaa.qmd", "knowledge/zzz.qmd"],
    orderedFiles: ["knowledge/index.qmd", "knowledge/aaa.qmd", "knowledge/zzz.qmd"],
  });
  assert.deepEqual(resolveGraph(shuffled, "kagome geometry"), tied);
});

// ---------------------------------------------------------------------------
// The boundaries: no match, no drafts, no literature, no unvalidated pages.
// ---------------------------------------------------------------------------

test("a query nothing answers is no-match, and drafts and literature are never searched", async (t) => {
  const repo = await makeRepo(t);
  await mkdir(path.join(repo, "drafts", "imported"), { recursive: true });
  await writeFile(
    path.join(repo, "drafts", "imported", "note.md"),
    "# Chinchilla\n\nAn untrusted note about the chinchilla model.\n",
  );
  await appendFile(
    path.join(repo, "literature", "ref.bib"),
    "\n@article{kryptonite2026,\n  title = {Kryptonite in the transverse field},\n  year = {2026},\n  keywords = {ed}\n}\n",
  );

  for (const query of ["chinchilla", "kryptonite"]) {
    const result = await resolveKnowledge(query, { repoRoot: repo });
    assert.deepEqual(result, {
      schemaVersion: 1,
      query,
      status: "no-match",
      bundle: null,
      alternatives: [],
    });
  }

  // The words are findable; they were simply never in the trusted tree.
  await appendFile(
    path.join(repo, "knowledge", "ising", "proof.qmd"),
    "\nThe chinchilla is unrelated.\n",
  );
  const found = await resolveKnowledge("chinchilla", { repoRoot: repo });
  assert.ok(found.status === "match", `expected a match, got ${found.status}`);
  assert.deepEqual(found.bundle.contentPages, ["knowledge/ising/proof.qmd"]);
});

test("a query with no letters or digits is rejected", async (t) => {
  const repo = await makeRepo(t);
  const graph = await loadKnowledge({ repoRoot: repo });

  for (const query of ["", "   ", "--- ??? ---"]) {
    assert.throws(() => resolveGraph(graph, query), KnowledgeQueryError);
    await assert.rejects(
      () => resolveKnowledge(query, { repoRoot: repo }),
      KnowledgeQueryError,
    );
  }
});

test("resolveKnowledge refuses an invalid tree and reports every problem", async (t) => {
  const repo = await makeRepo(t);
  const index = path.join(repo, "knowledge", "ising", "index.qmd");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      "- [Proposal for a finite-size study](proposal.qmd)\n",
      "",
    ),
  );
  await appendFile(
    path.join(repo, "knowledge", "ising", "verified-code.qmd"),
    "\n<script>alert(1)</script>\n",
  );

  const report = await validateKnowledge({ repoRoot: repo });
  assert.deepEqual(
    report.diagnostics.map((diagnostic) => diagnostic.code),
    ["ORPHAN_CHILD", "SCRIPT_FORBIDDEN"],
  );

  await assert.rejects(
    // The query would have matched: the gate is validation, not the ranking.
    () => resolveKnowledge("Ising model", { repoRoot: repo }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeValidationError);
      assert.equal(error.name, "KnowledgeValidationError");
      assert.deepEqual(error.diagnostics, report.diagnostics);
      assert.equal(error.report.ok, false);
      assert.match(error.message, /SCRIPT_FORBIDDEN/);
      assert.match(error.message, /ORPHAN_CHILD/);
      return true;
    },
  );
});

test("the public interface exports exactly the entry points of this phase", async () => {
  const publicInterface = await import("../../lib/knowledge/index.js");

  assert.deepEqual(
    Object.keys(publicInterface).sort(),
    // The three error classes are runtime values a caller must be able to catch.
    [
      "KnowledgeQueryError",
      "KnowledgeSiteError",
      "KnowledgeValidationError",
      "buildKnowledgeSite",
      "loadKnowledge",
      "previewKnowledgeSite",
      "resolveKnowledge",
      "validateKnowledge",
    ],
  );
});

// ---------------------------------------------------------------------------
// The CLI, against the committed production tree.
// ---------------------------------------------------------------------------

test("`knowledge.ts check` accepts the production tree", async () => {
  const result = await knowledgeCli("check");

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\S/);
});

test("`knowledge.ts resolve` prints formatted JSON and exits 0 on no-match", async () => {
  const result = await knowledgeCli("resolve", "--query", "qxjzvplmokn");

  assert.equal(result.code, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    query: "qxjzvplmokn",
    status: "no-match",
    bundle: null,
    alternatives: [],
  });
  assert.equal(
    result.stdout,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "the JSON is exactly two-space indented, one document per run",
  );
});

test("the CLI exits 1 on an invocation it cannot honour", async () => {
  for (const args of [
    [],
    ["render"],
    ["check", "--query", "x"],
    ["resolve"],
    ["resolve", "--query", "   "],
    ["resolve", "--query", "x", "--repo-root", "/tmp"],
    // The production CLI has no path or output overrides at all: `build` may
    // read only this repository's tree and replace only its `public/knowledge`.
    ["build", "--knowledge-dir", "tests/fixtures/knowledge/valid"],
    ["build", "--output-dir", "/tmp/anywhere"],
    ["preview", "--knowledge-dir", "tests/fixtures/knowledge/valid"],
  ]) {
    const result = await knowledgeCli(...args);
    assert.equal(result.code, 1, `expected exit 1 for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /^knowledge: /);
    assert.equal(result.stdout, "");
  }
});

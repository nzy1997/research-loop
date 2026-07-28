/**
 * The trust boundary of this repository is enforced by code — the validator,
 * the resolver, the projection — but an agent only reaches that code if its
 * instructions send it there. These tests are the static half of that
 * guarantee: they pin what `AGENTS.md`, `CLAUDE.md`, and the local skills
 * must *say*, so the sentences the boundary depends on cannot be dropped,
 * softened, or edited away without a test failing.
 *
 * They check three kinds of property.
 *
 * - **Shape.** Each skill is a discoverable `skills/<name>/SKILL.md` with YAML
 *   frontmatter carrying exactly a matching `name` and a "Use when …"
 *   description that states triggering conditions only. A description that
 *   summarises the workflow is a description an agent will follow *instead of*
 *   reading the skill, so commands and step sequences are refused there.
 * - **Clauses.** Every requirement the plan places on a skill is one row in a
 *   table below, with the pattern that proves the sentence is present. A
 *   missing clause names itself in the failure message. Clauses are matched
 *   against the text with its line breaks collapsed, so re-wrapping a paragraph
 *   is never a test failure and only the words matter.
 * - **Agreement.** The skills, `docs/skills.md`, and the repository they
 *   describe must not drift: every `make` target a skill tells an agent to run
 *   is documented, and every `literature/<method>/` directory a skill names
 *   really exists.
 *
 * What they cannot check is compliance: no test makes a language model obey a
 * sentence. They make the sentence's absence a build failure, which is the part
 * that is mechanically enforceable.
 */

import assert from "node:assert/strict";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");

/** The complete set of local skills this repository commits. */
const SKILL_NAMES = ["download-ref", "read-knowledge", "review-draft", "assess-research-problem"] as const;

type SkillName = (typeof SKILL_NAMES)[number];

/** Only the leading block delimited by `---` lines counts as frontmatter. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

interface Skill {
  /** The raw YAML text, so its budget can be measured as written. */
  frontmatterText: string;
  frontmatter: Record<string, unknown>;
  description: string;
  /** Everything after the frontmatter block, exactly as written. */
  body: string;
  /** The body with its line breaks collapsed, for matching sentences. */
  prose: string;
}

/**
 * One line of text, so a clause cannot be broken by re-wrapping a paragraph.
 *
 * Every pattern below is about which words a document contains, never about
 * where its line breaks fall, and a `[^.\n]*` gap in a clause is there to keep
 * the match inside one sentence — not inside one source line.
 */
function flow(text: string): string {
  return text.replace(/\s+/gu, " ");
}

async function readSkill(name: SkillName): Promise<Skill> {
  const source = await readFile(path.join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
  const match = FRONTMATTER.exec(source);
  assert.ok(match, `${name}: SKILL.md must open with a --- delimited YAML frontmatter block`);

  const frontmatterText = match[1];
  const parsed: unknown = parse(frontmatterText);
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${name}: frontmatter must be a YAML mapping`,
  );
  const frontmatter = parsed as Record<string, unknown>;

  const description = frontmatter.description;
  assert.equal(typeof description, "string", `${name}: frontmatter needs a description`);

  const body = source.slice(match[0].length);
  return {
    frontmatterText,
    frontmatter,
    description: description as string,
    body,
    prose: flow(body),
  };
}

/** One sentence a skill must carry, and the pattern that proves it. */
interface Clause {
  readonly requirement: string;
  readonly in: "description" | "body";
  readonly pattern: RegExp;
}

/**
 * The plan's requirements for `read-knowledge`, clause by clause.
 *
 * The resolver command is matched literally, placeholder included: an agent
 * that is told to substitute the user's question cannot invent a narrower
 * query, and a skill that quietly switched to another command would fail here.
 */
const READ_KNOWLEDGE: readonly Clause[] = [
  {
    requirement: "triggers before stating a research fact",
    in: "description",
    pattern: /before stating[^,.]*research fact/i,
  },
  {
    requirement: "triggers before stating an interpretation",
    in: "description",
    pattern: /interpretation/i,
  },
  {
    requirement: "triggers on answers the learned knowledge might already cover",
    in: "description",
    pattern: /learned knowledge/i,
  },
  {
    requirement: "runs the resolver Make target with the user's question",
    in: "body",
    pattern: /make knowledge-resolve QUERY="<the user's research question>"/,
  },
  {
    requirement: "on match, reads every path of bundle.orderedFiles",
    in: "body",
    pattern: /read every[^.\n]*`bundle\.orderedFiles`/i,
  },
  {
    requirement: "on match, reads them before answering",
    in: "body",
    pattern: /before answering/i,
  },
  {
    requirement: "on ambiguous, presents the alternatives",
    in: "body",
    pattern: /present every[^.\n]*`alternatives`/i,
  },
  {
    requirement: "on ambiguous, does not choose silently",
    in: "body",
    pattern: /(never|do not|don't)[^.\n]*(choose|pick)[^.\n]*silently/i,
  },
  {
    requirement: "on no-match, says the learned knowledge has no match",
    in: "body",
    pattern: /the learned knowledge has no match/i,
  },
  {
    requirement: "never reads drafts/ as a fallback",
    in: "body",
    pattern: /never read[^.\n]*`drafts\/`/i,
  },
  {
    requirement: "never reads literature/ as a fallback",
    in: "body",
    pattern: /never read[^.\n]*`literature\/`/i,
  },
  {
    requirement: "neither untrusted tree is a trusted fallback",
    in: "body",
    pattern: /trusted fallback/i,
  },
  {
    requirement: "names the separate external-research workflow",
    in: "body",
    pattern: /external-research/i,
  },
  {
    requirement: "names the separate source-audit workflow",
    in: "body",
    pattern: /source-audit/i,
  },
  {
    requirement: "names download-ref as the literature workflow",
    in: "body",
    pattern: /`download-ref`/,
  },
];

/** The plan's requirements for `review-draft`, clause by clause. */
const REVIEW_DRAFT: readonly Clause[] = [
  {
    requirement: "triggers on one note under drafts/",
    in: "description",
    pattern: /`drafts\/`/,
  },
  {
    requirement: "accepts exactly one file under drafts/",
    in: "body",
    pattern: /exactly one file under `drafts\/`/i,
  },
  {
    requirement: "refuses more than one file",
    in: "body",
    pattern: /refuse[^.\n]*more than one file/i,
  },
  {
    requirement: "refuses a path outside drafts/",
    in: "body",
    pattern: /outside `drafts\/`/i,
  },
  {
    requirement: "reports exactly four sections",
    in: "body",
    pattern: /exactly four sections/i,
  },
  {
    requirement: "reports nothing besides those four sections",
    in: "body",
    pattern: /nothing else/i,
  },
  {
    requirement: "section 1 is language and grammar",
    in: "body",
    pattern: /\b1\. \*\*Language and grammar\*\*/,
  },
  {
    requirement: "section 2 is factual errors or uncertainty",
    in: "body",
    pattern: /\b2\. \*\*Factual errors or uncertainty\*\*/,
  },
  {
    requirement: "section 3 is Quarto and Markdown format",
    in: "body",
    pattern: /\b3\. \*\*Quarto and Markdown format\*\*/,
  },
  {
    requirement: "section 4 is the placement recommendation",
    in: "body",
    pattern: /\b4\. \*\*Placement recommendation\*\*/,
  },
  {
    requirement: "recommends exactly one destination",
    in: "body",
    pattern: /exactly one destination/i,
  },
  {
    requirement: "the destination is an existing knowledge page path",
    in: "body",
    pattern: /`knowledge\/<topic>\/<filename>\.qmd`/,
  },
  {
    requirement: "or one new topic directory with its own index.qmd",
    in: "body",
    pattern: /new topic directory[^.\n]*`index\.qmd`/i,
  },
  {
    requirement: "recommends exactly one category for a content page",
    in: "body",
    pattern: /exactly one category/i,
  },
  {
    requirement: "the category is one of the three declared kinds",
    in: "body",
    pattern: /`theory`, `experiment`, or `codes`/,
  },
  {
    requirement: "does not edit, move, split, rewrite, or promote before confirmation",
    in: "body",
    pattern: /do not edit, move, split, rewrite, or promote[^.\n]*before the user confirms/i,
  },
  {
    requirement: "after confirmation, works on a non-main branch",
    in: "body",
    pattern: /non-`main` branch/,
  },
  {
    requirement: "after confirmation, converts the note to .qmd",
    in: "body",
    pattern: /convert[^.\n]*`\.qmd`/i,
  },
  {
    requirement: "after confirmation, updates the parent reading map",
    in: "body",
    pattern: /`## Reading map`/,
  },
  {
    requirement: "after confirmation, validates the tree",
    in: "body",
    pattern: /make knowledge-check/,
  },
  {
    requirement: "after confirmation, presents a diff or pull request",
    in: "body",
    pattern: /(Git diff|pull request)/i,
  },
  {
    requirement: "only the user's merge makes the note trusted",
    in: "body",
    pattern: /only the user's merge[^.\n]*trusted/i,
  },
];

/** The plan's requirements for `download-ref`, clause by clause. */
const DOWNLOAD_REF: readonly Clause[] = [
  {
    requirement: "triggers on adding an external source to the literature corpus",
    in: "description",
    pattern: /literature/i,
  },
  {
    requirement: "fetches with the literature Make target",
    in: "body",
    pattern: /make literature-fetch KEY=<citekey>/,
  },
  {
    requirement: "edits the committed bibliography as the source of truth",
    in: "body",
    pattern: /`literature\/ref\.bib`[^.\n]*(source of truth|committed)/i,
  },
  {
    requirement: "regenerates the committed method indexes",
    in: "body",
    pattern: /make literature-index/,
  },
  {
    requirement: "the method index is committed",
    in: "body",
    pattern: /`INDEX\.md`/,
  },
  {
    requirement: "organises sources by method keyword",
    in: "body",
    pattern: /keywords = \{/,
  },
  {
    requirement: "external sources stay under literature/",
    in: "body",
    pattern: /(stay|stays|remain|remains)[^.\n]*`literature\/`/i,
  },
  {
    requirement: "source TeX and PDF are stored under .raw",
    in: "body",
    pattern: /`?\.raw\/<citekey>\/`?/,
  },
  {
    requirement: "extracted images are stored under .figures",
    in: "body",
    pattern: /`?\.figures\/<citekey>\/`?/,
  },
  {
    requirement: "never compiles the downloaded TeX",
    in: "body",
    // The verb must sit next to the prohibition: a section heading reading
    // "Never" would otherwise satisfy every rule underneath it.
    pattern: /never compile[^.\n]*(TeX|LaTeX)/i,
  },
  {
    requirement: "never produces a rendered full-text Markdown mirror",
    in: "body",
    pattern: /never produce[^.\n]*`rendered\.md`/i,
  },
  {
    requirement: "never promotes paper text into the knowledge tree",
    in: "body",
    pattern: /never copy[^.\n]*into `knowledge\/`/i,
  },
  {
    requirement: "verifies formulas against the source TeX or PDF",
    in: "body",
    pattern: /formula[^.\n]*source TeX/i,
  },
  {
    requirement: "refuses lossy extraction as a source for formulas",
    in: "body",
    pattern: /lossy/i,
  },
];

/** The plan's requirements for `assess-research-problem`, clause by clause. */
const ASSESS_RESEARCH_PROBLEM: readonly Clause[] = [
  {
    requirement: "triggers on judging whether a research problem is worth doing",
    in: "description",
    pattern: /worth (doing|pursuing)/i,
  },
  {
    requirement: "triggers on judging autoresearch fit",
    in: "description",
    pattern: /autoresearch/i,
  },
  {
    requirement: "separates research value from autoresearch suitability",
    in: "body",
    pattern: /research value[^.\n]*autoresearch suitability/i,
  },
  {
    requirement: "requires the read-knowledge resolver before research facts",
    in: "body",
    pattern: /make knowledge-resolve QUERY="<the candidate research question>"/,
  },
  {
    requirement: "does not use drafts as a fallback",
    in: "body",
    pattern: /(never|do not|don't)[^.\n]*`drafts\/`[^.\n]*fallback/i,
  },
  {
    requirement: "does not use literature as learned knowledge",
    in: "body",
    pattern: /(never|do not|don't)[^.\n]*`literature\/`[^.\n]*learned knowledge/i,
  },
  {
    requirement: "is read-only",
    in: "body",
    pattern: /read-only/i,
  },
  {
    requirement: "does not answer the research problem",
    in: "body",
    pattern: /(do not|don't|never)[^.\n]*answer[^.\n]*research (question|problem)/i,
  },
  {
    requirement: "does not create problem records",
    in: "body",
    pattern: /(do not|don't|never)[^.\n]*(create|write|update)[^.\n]*`problems\/`/i,
  },
  {
    requirement: "scores research value on a 0-100 axis",
    in: "body",
    pattern: /`V`[^.\n]*0[^.\n]*100/i,
  },
  {
    requirement: "scores autoresearch suitability on a 0-100 axis",
    in: "body",
    pattern: /`A`[^.\n]*0[^.\n]*100/i,
  },
  {
    requirement: "uses the harmonic mean for the combined score",
    in: "body",
    pattern: /harmonic mean/i,
  },
  {
    requirement: "contains the runtime soft penalty formula",
    in: "body",
    pattern: /T = clamp\(5 - log2\(max\(t, 5\) \/ 5\), 0, 5\)/,
  },
  {
    requirement: "states five minutes is not a hard limit",
    in: "body",
    pattern: /5 minutes[^.\n]*not a hard limit/i,
  },
  {
    requirement: "keeps unknowns as intervals",
    in: "body",
    pattern: /unknown[^.\n]*interval/i,
  },
  {
    requirement: "does not use any dimension as a hard veto",
    in: "body",
    pattern: /No individual dimension[^.\n]*hard veto/i,
  },
  {
    requirement: "handles P equals NP as high value and low suitability",
    in: "body",
    pattern: /P = NP[^.\n]*high research value[^.\n]*low autoresearch suitability/i,
  },
  {
    requirement: "returns the normalized problem section",
    in: "body",
    pattern: /`Normalized problem`/,
  },
  {
    requirement: "returns the verdict section",
    in: "body",
    pattern: /`Verdict`/,
  },
  {
    requirement: "returns exactly one largest bottleneck",
    in: "body",
    pattern: /`Largest bottleneck`[^.\n]*exactly one/i,
  },
  {
    requirement: "returns exactly one recommended reframe",
    in: "body",
    pattern: /`Recommended reframe`[^.\n]*exactly one/i,
  },
];

const CLAUSES: Readonly<Record<SkillName, readonly Clause[]>> = {
  "read-knowledge": READ_KNOWLEDGE,
  "review-draft": REVIEW_DRAFT,
  "download-ref": DOWNLOAD_REF,
  "assess-research-problem": ASSESS_RESEARCH_PROBLEM,
};

for (const name of SKILL_NAMES) {
  test(`${name} states every clause the trust boundary depends on`, async () => {
    const skill = await readSkill(name);
    for (const clause of CLAUSES[name]) {
      const subject = clause.in === "description" ? skill.description : skill.prose;
      assert.match(subject, clause.pattern, `${name}: ${clause.in} is missing: ${clause.requirement}`);
    }
  });

  test(`${name} is discoverable frontmatter, not a summary of its own workflow`, async () => {
    const skill = await readSkill(name);

    assert.deepEqual(
      Object.keys(skill.frontmatter).sort(),
      ["description", "name"],
      `${name}: frontmatter carries keys beyond name and description`,
    );
    assert.equal(skill.frontmatter.name, name, `${name}: frontmatter name must match its directory`);
    assert.match(name, /^[a-z][a-z0-9-]*$/, `${name}: skill names are lowercase and hyphenated`);

    // The whole block is injected into every agent's system prompt.
    assert.ok(
      skill.frontmatterText.length <= 1024,
      `${name}: frontmatter is ${skill.frontmatterText.length} characters, over the 1024 budget`,
    );
    assert.ok(
      skill.description.length <= 500,
      `${name}: description is ${skill.description.length} characters, over the 500 budget`,
    );
    assert.match(skill.description, /^Use when /, `${name}: description must start with "Use when "`);
    assert.doesNotMatch(
      skill.description,
      /\b(I|we|my|our|you|your)\b/i,
      `${name}: description must be third person`,
    );
    // A description that carries the procedure is a procedure agents follow
    // instead of reading the skill.
    assert.doesNotMatch(
      skill.description,
      /(^|\s)(make|npm|node|git|quarto) /,
      `${name}: description must state triggers, not commands`,
    );
    assert.doesNotMatch(
      skill.description,
      /\b(first|then|finally|step \d)\b/i,
      `${name}: description must state triggers, not a step sequence`,
    );
  });

  test(`${name} stays short enough to be read in full`, async () => {
    const skill = await readSkill(name);
    const words = skill.body.trim().split(/\s+/u).length;
    assert.ok(words <= 700, `${name}: body is ${words} words; keep it under 700`);
  });

  test(`${name} is a self-contained SKILL.md`, async () => {
    const entries = await readdir(path.join(SKILLS_ROOT, name));
    assert.deepEqual(
      entries.sort(),
      ["SKILL.md"],
      `${name}: a local skill is one SKILL.md; helpers belong in scripts/ and lib/`,
    );
  });
}

test("skills/ holds exactly the committed local skills", async () => {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [...SKILL_NAMES].sort(),
    "skills/ must hold exactly the documented local skills",
  );
  assert.ok(
    entries.every((entry) => entry.isDirectory()),
    "every entry of skills/ is a skill directory",
  );
});

test(".claude/skills links Claude Code discovery at the committed skills", async () => {
  const link = path.join(REPO_ROOT, ".claude", "skills");
  const stats = await lstat(link);
  assert.ok(stats.isSymbolicLink(), ".claude/skills must be a symbolic link, not a copy");
  assert.equal(await readlink(link), "../skills", ".claude/skills must point at ../skills");
  // The link is relative, so it must resolve inside the repository from .claude/.
  const entries = await readdir(link);
  assert.ok(entries.includes("read-knowledge"), ".claude/skills must resolve to the skills tree");
});

test("CLAUDE.md is one instruction pointing at AGENTS.md", async () => {
  const source = await readFile(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const lines = source.split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 1, "CLAUDE.md must stay a single instruction line");
  assert.match(lines[0], /@AGENTS\.md/, "CLAUDE.md must point at @AGENTS.md");
});

/** What `AGENTS.md` must state for the boundary to survive an agent session. */
const AGENTS_CLAUSES: readonly { requirement: string; pattern: RegExp }[] = [
  {
    requirement: "knowledge/ is the only trusted content authority",
    pattern: /`knowledge\/\*\*\/\*\.qmd`[^.\n]*only trusted/i,
  },
  {
    requirement: "drafts/ is untrusted and never published",
    pattern: /never publish[^.\n]*`drafts\/`/i,
  },
  {
    requirement: "literature/ is external evidence, not learned knowledge",
    pattern: /`literature\/`[^.\n]*external evidence/i,
  },
  {
    requirement: "the resolver runs before a research answer",
    pattern: /make knowledge-resolve QUERY=/,
  },
  {
    requirement: "every file of the returned bundle is read before answering",
    pattern: /`bundle\.orderedFiles`/,
  },
  {
    requirement: "the read-knowledge skill owns that workflow",
    pattern: /`read-knowledge`/,
  },
  {
    requirement: "a draft is reviewed and promoted only with the review-draft workflow",
    pattern: /`review-draft`/,
  },
  {
    requirement: "promotion happens only after the user confirms",
    pattern: /(confirms|confirmation)/i,
  },
  {
    requirement: "only the user's merge makes a note trusted",
    pattern: /only the user's merge[^.\n]*trusted/i,
  },
  {
    requirement: "the literature workflow is separate",
    pattern: /`download-ref`/,
  },
  {
    requirement: "every Quarto subprocess disables execution",
    pattern: /`--no-execute`/,
  },
  {
    requirement: "the production build validates and renders knowledge first",
    pattern: /make build|npm run build/,
  },
  {
    requirement: "validation is a command an agent can run",
    pattern: /make knowledge-check/,
  },
  {
    requirement: "the dashboard page is preserved",
    pattern: /`app\/page\.tsx`/,
  },
  {
    requirement: "the dashboard styles are preserved",
    pattern: /`app\/globals\.css`/,
  },
  {
    requirement: "the dashboard layout is preserved",
    pattern: /`app\/layout\.tsx`/,
  },
  {
    requirement: "the existing Sites project is reused verbatim",
    pattern: /appgprj_6a66e89526a88191a9e969c6f441086c/,
  },
  {
    requirement: "no replacement site is created",
    pattern: /(replacement site|never invent)/i,
  },
];

test("AGENTS.md encodes the trust boundary an agent has to respect", async () => {
  const source = flow(await readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8"));
  for (const clause of AGENTS_CLAUSES) {
    assert.match(source, clause.pattern, `AGENTS.md is missing: ${clause.requirement}`);
  }
});

test("AGENTS.md carries no compute instructions imported from the harness", async () => {
  const source = await readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
  // The migration source is a compute harness; this repository runs no jobs and
  // no solvers, so its method-specific operating instructions do not belong
  // here and must not arrive by copy-paste.
  assert.doesNotMatch(
    source,
    /\b(slurm|sbatch|srun|apptainer|singularity|quspin|itensors|netket|pepskit|mpskit|qmcpack|conda)\b/i,
    "AGENTS.md must not carry the quantum harness's method-specific compute instructions",
  );
});

test("docs/skills.md documents ownership, inputs, writes, and prohibitions", async () => {
  const source = flow(await readFile(path.join(REPO_ROOT, "docs", "skills.md"), "utf8"));

  const header = /\|\s*Skill\s*\|\s*Role\s*\|\s*Ownership[^|]*\|\s*Trusted inputs\s*\|\s*Writes\s*\|\s*Prohibited[^|]*\|/i;
  assert.match(source, header, "docs/skills.md needs the skill/role/ownership/inputs/writes/prohibited table");
  for (const name of SKILL_NAMES) {
    assert.match(source, new RegExp(`\\|\\s*\`${name}\``), `docs/skills.md has no row for ${name}`);
  }

  assert.match(
    source,
    /quantum\.harness[^.\n]*download-ref skill/i,
    "docs/skills.md must attribute the adapted download-ref skill to its source",
  );
  assert.match(
    source,
    /Superpowers[^.\n]*runtime dependenc/i,
    "docs/skills.md must state that external Superpowers skills are runtime dependencies",
  );
  assert.match(
    source,
    /not copied into this repository/i,
    "docs/skills.md must state that external skills are not copied into this repository",
  );
});

test("agent-facing docs do not preserve machine-specific checkout paths", async () => {
  for (const relativePath of [
    "AGENTS.md",
    "docs/skills.md",
    "docs/superpowers/specs/2026-07-27-quarto-knowledge-system-design.md",
    "docs/superpowers/specs/2026-07-28-dashboard-knowledge-entry-design.md",
    "docs/superpowers/specs/2026-07-28-literature-cache-integrity-design.md",
  ]) {
    const source = await readFile(path.join(REPO_ROOT, ...relativePath.split("/")), "utf8");
    assert.doesNotMatch(source, /\/(?:Users|home)\/[^`)\s]+/, relativePath);
  }
});

test("every command a skill hands an agent is documented in docs/skills.md", async () => {
  const documented = await readFile(path.join(REPO_ROOT, "docs", "skills.md"), "utf8");
  for (const name of SKILL_NAMES) {
    const { body } = await readSkill(name);
    // A command handed to an agent is written as code: a line of a fenced block
    // or an inline code span. Prose that happens to contain the word "make" is
    // not an instruction, and must not be read as one.
    const targets = new Set(
      [...body.matchAll(/^make ([a-z][a-z0-9-]*)/gm), ...body.matchAll(/`make ([a-z][a-z0-9-]*)/g)].map(
        (match) => match[1],
      ),
    );
    assert.ok(targets.size > 0, `${name}: a skill must hand the agent a command`);
    for (const target of targets) {
      assert.match(
        documented,
        new RegExp(`make ${target}\\b`),
        `docs/skills.md does not document "make ${target}", which ${name} tells agents to run`,
      );
    }
  }
});

test("every literature directory a skill names really exists", async () => {
  const present = new Set(
    (await readdir(path.join(REPO_ROOT, "literature"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const name of SKILL_NAMES) {
    const { body } = await readSkill(name);
    for (const match of body.matchAll(/literature\/([a-z][a-z0-9-]*)\//g)) {
      assert.ok(
        present.has(match[1]),
        `${name}: names literature/${match[1]}/, which is not a method directory`,
      );
    }
  }
});

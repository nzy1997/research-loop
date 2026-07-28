# Local agent skills

`skills/` is the canonical, committed source of this repository's local agent
skills. `.claude/skills` is a relative symlink to it so Claude Code discovers
them, and `CLAUDE.md` points at `AGENTS.md`, which Codex reads directly. Agent
correctness never depends on a skill directory being found implicitly.

Each skill is a single `SKILL.md`. Anything executable belongs in `scripts/` and
`lib/`, behind a Make target, where it can be tested.

## What each skill owns

| Skill | Role | Ownership / provenance | Trusted inputs | Writes | Prohibited behaviour |
|---|---|---|---|---|---|
| `read-knowledge` | Answer a research question from the trusted tree: resolve, read the whole returned bundle, then answer. | Original to Research Loop. | `knowledge/**/*.qmd`, reached only through the resolver. | Nothing. It reads and answers. | Answering without resolving; reading part of a bundle; treating `drafts/` or `literature/` as a fallback; choosing between ambiguous candidates for the user. |
| `assess-research-problem` | Judge whether a candidate research problem is worth pursuing and whether it fits this repository's autoresearch loop. | Original to Research Loop. | User-provided problem statement and trusted `knowledge/**/*.qmd` only through `read-knowledge`. | Nothing. It reads, scores, explains, and recommends one reframe. | Answering or solving the research problem; running experiments; creating `problems/`; modifying `knowledge/`, `drafts/`, or `literature/`; treating `drafts/` or `literature/` as learned knowledge. |
| `review-draft` | Review one untrusted note and recommend one destination and one category; promote it only after the user confirms. | Original to Research Loop. | One user-named file under `drafts/`. | After confirmation only, on a non-`main` branch: one `knowledge/<topic>/*.qmd` page and its parent `## Reading map`. | Editing, moving, splitting, rewriting, or promoting before confirmation; promoting onto `main`; merging its own branch; recommending more than one destination. |
| `download-ref` | Maintain the external literature corpus: one bibliography entry, the generated indexes, and the version-pinned arXiv source. | Adapted from the read-only `quantum.harness` download-ref skill. Layout and bibliography conventions are kept; every command and path was rewritten for this repository, and the harness's PDF-to-Markdown rendering helpers were deliberately not carried over. | `literature/ref.bib` and the arXiv source it pins. | `literature/ref.bib`, `literature/<method>/INDEX.md`, and the gitignored `.raw/` and `.figures/` trees. | Compiling downloaded TeX; producing `rendered.md` or any full-text mirror; hand-editing a generated `INDEX.md`; copying paper text into `knowledge/`. |

## Commands the skills hand to an agent

| Command | Used by |
|---|---|
| `make knowledge-resolve QUERY="…"` | `read-knowledge`, `assess-research-problem` |
| `make knowledge-check` | `review-draft` |
| `make draft-preview FILE=drafts/…` | `review-draft` |
| `make literature-index` | `download-ref` |
| `make literature-fetch KEY=<citekey>` | `download-ref` |
| `make literature-sync` | `download-ref` |

Skills call these targets rather than the TypeScript underneath them, so the
CLI stays the single observable interface to the knowledge graph.

## External skills

The Superpowers skills used while building this repository — `writing-skills`,
`test-driven-development`, `verification-before-completion`, and the rest — are
runtime dependencies of the agent, not part of this project. They are not
copied into this repository, and nothing here reimplements them; they are
installed wherever the agent runs.

## Contract tests

`tests/agent/skill-contracts.test.ts` parses each skill's frontmatter and body
and fails when a clause the trust boundary depends on is missing, when a skill's
description starts summarising its own workflow, when `.claude/skills` stops
being a symlink to `../skills`, or when a skill and this document disagree about
which commands exist. The tests cannot make a model obey a sentence; they make
its removal a build failure.

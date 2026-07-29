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
| `capture-chat-draft` | Turn the visible Zotero reading conversation into a grounded note with claims, hypotheses, and open questions separated. | Adapted from quarto-lab's skill for Research Loop's draft boundary. | The visible chat and user-selected Zotero record; neither is trusted knowledge. | `drafts/reading-notes/*.qmd`. | Editing literature or knowledge; inventing paper claims or page numbers; promoting the note. |
| `complete-gaps` | Fill specific proof and derivation gaps in an untrusted QMD without restructuring it. | Adapted from quarto-lab; writes were redirected from knowledge to drafts. | User-named draft, conversation, or pinned source evidence. | A file under `drafts/` or the named project workspace. | Editing trusted knowledge; guessing missing source claims; writing before plan approval. |
| `conference-survey` | Audit every oral in a conference archive and produce prioritized Chinese triage. | Adapted from quarto-lab; output is constrained to drafts. | Conference pages and cited external sources. | `drafts/conference-surveys/` QMD, TSV, summary, and optional JSON cache. | Writing into knowledge; keyword-only filtering; hiding excluded or inaccessible pages. |
| `read-knowledge` | Answer a research question from the trusted tree: resolve, read the whole returned bundle, then answer. | Original to Research Loop. | `knowledge/**/*.qmd`, reached only through the resolver. | Nothing. It reads and answers. | Answering without resolving; reading part of a bundle; treating `drafts/` or `literature/` as a fallback; choosing between ambiguous candidates for the user. |
| `assess-research-problem` | Judge whether a candidate research problem is worth pursuing and whether it fits this repository's autoresearch loop. | Original to Research Loop. | User-provided problem statement and trusted `knowledge/**/*.qmd` only through `read-knowledge`. | Nothing. It reads, scores, explains, and recommends one reframe. | Answering or solving the research problem; running experiments; creating `problems/`; modifying `knowledge/`, `drafts/`, or `literature/`; treating `drafts/` or `literature/` as learned knowledge. |
| `review-draft` | Review one untrusted note and recommend one destination and one category; promote it only after the user confirms. | Original to Research Loop. | One user-named file under `drafts/`. | After confirmation only, on a non-`main` branch: one `knowledge/<topic>/*.qmd` page and its parent `## Reading map`. | Editing, moving, splitting, rewriting, or promoting before confirmation; promoting onto `main`; merging its own branch; recommending more than one destination. |
| `download-ref` | Maintain the external literature corpus: one bibliography entry, the generated indexes, and the version-pinned arXiv source. | Adapted from the read-only `quantum.harness` download-ref skill. Layout and bibliography conventions are kept; every command and path was rewritten for this repository, and the harness's PDF-to-Markdown rendering helpers were deliberately not carried over. | `literature/ref.bib` and the arXiv source it pins. | `literature/ref.bib`, `literature/<method>/INDEX.md`, and the gitignored `.raw/` and `.figures/` trees. | Compiling downloaded TeX; producing `rendered.md` or any full-text mirror; hand-editing a generated `INDEX.md`; copying paper text into `knowledge/`. |
| `add-problem` | Register one discussed candidate in the Problem Console as a draft after an exact preview and explicit confirmation. | Original to Research Loop. | The user-visible idea discussion and one candidate ID hint; neither is trusted learned knowledge. | After confirmation only: one `problems/Prob-NNN/` draft and its generation record, through `make problem-publish`. | Accepting, rejecting, scoring, or qualifying the candidate; writing before confirmation; overwriting a reserved ID; publishing `problem.json` before the other records. |
| `prepare-autoresearch` | Prepare a host-staged autoresearch candidate contract before execution. | Original to Research Loop. | A host-provided staging root and user-confirmed problem context; neither is trusted learned knowledge. | Safe preparation artifacts and digests only beneath the supplied staging root. | Writing official problem records directly, editing trusted knowledge, drafts, literature, or configuration; creating batches or attempts; fabricating domain authority; retaining private or blind data in the candidate workspace. |
| `expand-notes` | Turn rough academic material into polished Quarto drafts that can later be promoted. | Adapted from quarto-lab's `expand-notes`; its formal-block conventions are retained, while frontmatter, bibliography, categories, and promotion rules follow Research Loop. | User-named notes, LaTeX, lecture material, or conversation content; external evidence only when cited. | `drafts/` before approval; after approval, the selected `knowledge/` page and parent reading map. | Copying paper full text into knowledge; page-local bibliographies; unsupported frontmatter; promoting without confirmation. |
| `generate-issues` | Turn one note into three to five actionable research directions. | Adapted from quarto-lab; generated issues remain untrusted. | A user-selected note, its resolved bundle when trusted, and current primary literature. | After approval, `projects/<project>/issues/*.qmd`. | Writing into knowledge; unaudited claims; creating files before proposal approval. |
| `integrate-paper` | Transfer verified results from QMD notes into an existing LaTeX manuscript. | Adapted from quarto-lab; source trust and write boundaries follow Research Loop. | Resolver-returned knowledge plus user-selected drafts and literature evidence. | The user-named manuscript and its bibliography, after section-map approval. | Editing knowledge; overwriting appendix content wholesale; compiling before approval. |
| `render-site` | Validate, build, and preview the trusted knowledge site through the safe repository seam. | Adapted from quarto-lab's `render-site` to Research Loop's paths and Make targets. | Validated `knowledge/**/*.qmd` and `literature/ref.bib`. | Generated `public/knowledge/` through the builder only. | Calling Quarto directly; editing generated output; publishing drafts or literature full text. |
| `screen-paper` | Give a fast paper-relevance verdict against explicit criteria. | Adapted from quarto-lab; the original hardcoded lab focus was removed. | Paper abstract/full text, explicit user criteria, and resolver-returned context. | Nothing. | Modifying the repository; treating abstract-only screening as deep review; inventing a lab focus. |

## Commands the skills hand to an agent

| Command | Used by |
|---|---|
| `make knowledge-resolve QUERY="…"` | `read-knowledge`, `assess-research-problem` |
| `make knowledge-check` | `review-draft` |
| `make knowledge-check` | `expand-notes`, `render-site` |
| `make build` | `render-site` |
| `make knowledge-preview` | `render-site` |
| `make draft-preview FILE=drafts/…` | `review-draft` |
| `make draft-preview FILE=drafts/…` | `capture-chat-draft`, `complete-gaps`, `conference-survey` |
| `make knowledge-resolve QUERY="…"` | `generate-issues`, `integrate-paper`, `screen-paper` |
| `make literature-index` | `download-ref` |
| `make literature-fetch KEY=<citekey>` | `download-ref` |
| `make literature-sync` | `download-ref` |
| `make problem-index` | `add-problem`; refreshes generated problem data. |
| `make problem-publish STAGE="..." ID=Prob-NNN` | `add-problem`; validates a staged draft, publishes the manifest last, and rebuilds the index. |
| `make autoresearch-service` | `prepare-autoresearch`; runs the loopback-only preparation sidecar. |

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

# Research Loop — Agent Instructions

Research Loop is a shared human-and-agent knowledge system: the preserved
dashboard at `/`, a Quarto knowledge site at `/knowledge/`, and a trust
boundary between what the user has approved and everything else. The boundary
is physical — separate trees, separate commands — not a matter of good
intentions.

## The trust boundary

| Tree | Status | Rule |
|---|---|---|
| `knowledge/**/*.qmd` | trusted | The only trusted content authority; a page is trusted because the user reviewed and merged it. |
| `drafts/` | untrusted | Imported or agent-written notes, with no required shape. Never publish `drafts/` and never answer from it. |
| `literature/` | external | External evidence, not learned knowledge. `.raw/` and `.figures/` stay local and gitignored. |
| `public/knowledge/` | generated | Written only by the build. Never edit it by hand, never commit it. |

## Before stating a research fact

Run the resolver and read what it returns — every time, before any research
fact, parameter, benchmark, or interpretation:

```bash
make knowledge-resolve QUERY="<the user's research question>"
```

- `match` — read every path in `bundle.orderedFiles`, in order, before answering.
- `ambiguous` — present the alternatives and let the user choose; never choose silently.
- `no-match` — say the learned knowledge has no match, and do not fall back to `drafts/` or `literature/`.

The `read-knowledge` skill carries the full workflow, including how to label an
answer that comes from outside the trusted tree.

## Promoting a draft

Use the `review-draft` skill. The agent reviews one note and recommends one
destination and one category; the user confirms; only then does anything move.
Promotion happens on a non-`main` branch and is presented as a Git diff or pull
request. Only the user's merge makes a note trusted.

## Adding a problem

Use the `add-problem` skill to register one user-confirmed candidate in the
Problem Console as `draft`. Write no files before the exact preview is
confirmed. Qualification is a separate workflow.

## External literature

Use the `download-ref` skill. Keep external material under `literature/`, never
compile downloaded LaTeX, and never mirror paper text into `knowledge/`.

See `docs/skills.md` for what each skill owns, reads, and may write.

## Building and validating

- `make knowledge-check` validates the trusted tree; it is the gate a promotion has to pass.
- `make build` (`npm run build`) validates and renders `knowledge/` into `public/knowledge/`, then builds the app. Validation or render failure aborts the build and leaves the previous output in place.
- Every Quarto render or preview subprocess includes `--no-execute`. Knowledge frontmatter is a strict allowlist. Both are security boundaries, not style rules.
- `make test` runs the full local suite.

## Preserved surfaces

- Preserve the current dashboard source and appearance. Do not rewrite `app/page.tsx`, `app/globals.css`, or `app/layout.tsx` to make tests pass.
- Reuse the opaque Sites project ID in `.openai/hosting.json` exactly: `appgprj_6a66e89526a88191a9e969c6f441086c`. Never invent, reformat, or replace it, and never create a replacement site; deployment may stay blocked until that project is visible.
- The only autonomous backend is the local loopback autoresearch sidecar.
  It may write `.generated/autoresearch-*` staging and, after host validation,
  `problems/<id>/infrastructure/`. It must not write trusted knowledge, publish
  private data, expose a deployed execution route, or start a campaign without
  the user's separate problem-page confirmation.

## Implementation guardrails

- Implement only in the current `research-loop` checkout. Treat any external `quantum.harness` checkout as read-only migration input.
- Use test-first commits. Do not combine unrelated tasks or silently repair unrelated repository state.

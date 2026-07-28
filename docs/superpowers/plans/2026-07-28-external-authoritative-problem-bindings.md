# External Authoritative Problem Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a local Research Loop problem record point read-only at an immutable external authoritative definition, while validating and detecting drift in that binding.

**Architecture:** `problem.json` gains one optional `sourceBinding` object for a Git repository, immutable revision, repository-relative path, and SHA-256 digest. A pure module compares an observed external descriptor with that binding. The indexer preserves valid bindings and the generic detail page renders metadata only.

**Tech Stack:** Node.js ESM, Node built-in test runner, Next.js/React.

---

### Task 1: Define and validate the external binding contract

**Files:**

- Create: `lib/problems/source-binding.mjs`
- Modify: `lib/problems/schema.mjs`
- Create: `tests/problem-source-binding.test.mjs`
- Modify: `tests/problem-schema.test.mjs`

- [x] Write failing tests for a valid binding, an HTTP repository, a mutable revision, a path traversal, an invalid digest, and revision/digest drift.
- [x] Run `node --test tests/problem-source-binding.test.mjs tests/problem-schema.test.mjs`; observed an unknown `sourceBinding` field and a missing module.
- [x] Implement `validateSourceBinding(binding)` and `verifySourceBinding(binding, observed)`. Accept only `kind: "git-path"`, HTTPS repository URLs, lowercase 40- or 64-hex commit IDs, normalized repository-relative POSIX paths, and `sha256:` plus 64 lowercase hex characters. Permit the optional field in the manifest validator and prefix validation diagnostics with `sourceBinding.`.
- [x] Rerun the focused tests; 11/11 passed.
- [x] Commit the contract as `feat: define external problem source bindings`.

### Task 2: Preserve bindings through indexing and render them read-only

**Files:**

- Modify: `tests/problem-indexer.test.mjs`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `app/problems/[id]/page.tsx`
- Modify: `app/globals.css`

- [x] Write failing tests showing a binding survives indexing and a non-example detail route contains an “Authoritative source” panel with the repository, revision, path, digest, and an explicit non-authoritative local-record disclaimer. Assert no sync/edit/run action appears.
- [x] Run the focused route test; it failed at the missing “Authoritative source” heading after the clean worktree dependencies were installed.
- [x] Conditionally render a semantic read-only definition list; link only the repository with `target="_blank"` and `rel="noreferrer"`. Add only panel layout styles. Do not fetch, synchronize, execute, edit, or import the remote source.
- [x] Rerun focused tests; the generic source-panel route test passed. The complete rendered suite retains one pre-existing Windows path-separator assertion failure.
- [x] Commit the integration as `feat: display external authoritative problem sources`.

### Task 3: Document, verify, and publish

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-28-external-authoritative-problem-bindings.md`

- [x] Document the optional binding object and state that it records—not imports or executes—a remote authority. Show `verifySourceBinding` comparing a separately retrieved descriptor.
- [x] Run focused source-binding/schema tests (11/11 pass) and the complete problem unit command directly (39/40 pass). The sole failing existing assertion expects POSIX separators while Windows diagnostics use backslashes; no behavior was changed for it.
- [ ] Run `git diff --check`, inspect `git status --short`, then commit the documentation.
- [ ] Push `codex/external-problem-bindings` and open a draft PR against `nzy1997/research-loop:main`. The PR description must say the feature is generic and contains no Quantum Harness issue package or dataset.

## Self-review

- The contract, drift comparison, index preservation, read-only UI, documentation, and PR are each covered by a task.
- The contract names are consistent: `sourceBinding`, `validateSourceBinding`, and `verifySourceBinding`.
- This plan intentionally excludes remote fetching and all domain-specific Quantum Harness content.

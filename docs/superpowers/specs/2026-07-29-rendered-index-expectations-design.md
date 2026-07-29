# Rendered Index Expectations

## Context

`problems/Prob-001` is a tracked, validated AutoQEC campaign record on the
default branch. The ordinary problem-index build therefore includes it. Two
rendered-page assertions still describe an earlier repository state in which
`Prob-001` was a disabled showcase and the ordinary index was empty.

## Decision

Keep production indexing unchanged and update only the stale rendered-page
expectations. The dashboard smoke test will require the tracked campaign title
and link, and will require the empty-state action to be absent. The index test
will require `Prob-001`, reserve `Prob-002` as the next ID, and assert the
current aggregate counts: one total, accepted, and solved problem, with no
published, rejected, or archived problems.

## Scope and safety

No dashboard source, problem data, trusted knowledge, or generated output is
edited. The change is limited to `tests/rendered-html.test.mjs`. Verification
must include the focused rendered tests and the repository's complete test
chain in an isolated checkout so local problem data and worktrees cannot alter
the generated index.

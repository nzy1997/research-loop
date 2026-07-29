# Rendered Index Expectations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align rendered dashboard tests with the tracked `Prob-001` AutoQEC campaign and restore a green full test chain.

**Architecture:** Keep the production indexer and dashboard unchanged because they correctly expose tracked problem records. Replace only the two stale empty-index assertions with expectations derived from the committed `Prob-001` record and its aggregate lifecycle counts.

**Tech Stack:** Node.js test runner, Vinext server rendering, GitHub pull request workflow.

## Global Constraints

- Modify only `tests/rendered-html.test.mjs`; do not edit dashboard source, problem data, trusted knowledge, or generated output.
- The ordinary index must expose tracked `Prob-001` and reserve `Prob-002`.
- Validate in an isolated checkout so local problem data and `.worktrees/` do not affect the result.

---

### Task 1: Update ordinary rendered-index expectations

**Files:**
- Modify: `tests/rendered-html.test.mjs:126-179`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `.generated/problem-index.json` produced by `npm run build` from tracked `problems/Prob-001`.
- Produces: Rendered-page assertions that describe the committed dashboard content and index summary.

- [ ] **Step 1: Confirm the existing regression test fails for the obsolete empty-state assumptions**

Run:

```bash
npm run build && npm run test:rendered
```

Expected: FAIL in `server-renders the problem console shell` because `+ Add first problem` is absent, and FAIL in `ordinary local build excludes and reserves the showcase problem` because the index contains `Prob-001`.

- [ ] **Step 2: Replace the stale dashboard assertions**

Change the homepage assertions to:

```js
assert.match(html, /AutoQEC CSS Distance Campaign/);
assert.match(html, /href="\/problems\/Prob-001"/);
assert.doesNotMatch(html, />\+ Add first problem<\/a>/);
```

- [ ] **Step 3: Replace the stale index assertions**

Rename the test to `ordinary local build indexes the tracked campaign and reserves the next problem ID`, then assert:

```js
assert.deepEqual(generatedIndex.problems.map((problem) => problem.id), ["Prob-001"]);
assert.equal(generatedIndex.nextProblemId, "Prob-002");
assert.deepEqual(generatedIndex.diagnostics, []);
assert.deepEqual(generatedIndex.summary, {
  total: 1,
  accepted: 1,
  solved: 1,
  published: 0,
  rejected: 0,
  archived: 0,
});
```

- [ ] **Step 4: Run the focused rendered tests**

Run in an isolated checkout after `npm run build`:

```bash
npm run test:rendered
```

Expected: 16 tests pass with no failures.

- [ ] **Step 5: Run the complete verification chain**

Run in the same isolated checkout:

```bash
npm test
```

Expected: lint, problem tests, unit tests, both builds, rendered tests, page tests, and Playwright E2E all pass.

- [ ] **Step 6: Commit, push, and merge PR #9**

```bash
git add tests/rendered-html.test.mjs docs/superpowers/plans/2026-07-29-rendered-index-expectations.md
git commit -m "test: align rendered index expectations"
git push origin codex/local-assessment-reports
gh pr ready 9
gh pr merge 9 --squash --delete-branch
```

Expected: PR #9 is merged into `main` after the verified commit is available on the remote.

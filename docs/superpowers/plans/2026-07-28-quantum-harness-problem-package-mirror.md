# Quantum Harness Problem Package Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add qh-124 through qh-128 to Research Loop as indexed, auditable console records while preserving the quantum.harness Problem Packages as the solver-authoritative source.

**Architecture:** Each \`problems/Prob-12N/\` directory contains a minimal Research Loop manifest, a human-readable projection, a provenance snapshot, and an unmodified copy of the corresponding source package. Research Loop indexes only \`problem.json\`; no console record may claim an executable gate or a solved scientific result while the source package remains \`specified\`.

**Tech Stack:** Node.js built-in test runner, existing Research Loop ES modules, JSON/Markdown, copied YAML package artifacts.

---

## File structure

| Path | Responsibility |
| --- | --- |
| \`problems/Prob-124/ ... problems/Prob-128/\` | Five console records, all with a lossless source-package mirror. |
| \`problems/Prob-12N/problem.json\` | Strict v1 console summary used by the indexer. |
| \`problems/Prob-12N/problem.md\` | Reader-facing projection with the source package location and hard-gate state. |
| \`problems/Prob-12N/generation/\` | Imported issue source, normalized-package decision, and import manifest. |
| \`problems/Prob-12N/package/\` | Verbatim copy of the originating \`autoresearch/problems/calibration/qh-12N-...\` package. |
| \`tests/quantum-harness-import.test.mjs\` | Assert all five mirrors remain complete, indexed, and consistent with source status. |

### Task 1: Test the source-authoritative console contract

**Files:**
- Create: \`tests/quantum-harness-import.test.mjs\`

- [ ] **Step 1: Write the failing import test.**

\`\`\`js
test("indexes five specified quantum-harness mirrors without promoting them", async () => {
  const index = await buildProblemIndex({ rootDir: process.cwd() });
  assert.deepEqual(index.problems.map(({ id }) => id), [
    "Prob-124", "Prob-125", "Prob-126", "Prob-127", "Prob-128",
  ]);
  for (const problem of index.problems) {
    assert.equal(problem.status, "qualifying");
    assert.equal(problem.gate.readiness, "specified");
  }
});
\`\`\`

- [ ] **Step 2: Run it to verify it fails.**

Run: \`node --test tests/quantum-harness-import.test.mjs\`
Expected: FAIL because no \`Prob-124\` through \`Prob-128\` records exist.

- [ ] **Step 3: Add the smallest source-consistency assertion.**

\`\`\`js
for (const id of ["124", "125", "126", "127", "128"]) {
  const imported = JSON.parse(await readFile(
    join(process.cwd(), "problems", \`Prob-\${id}\`, "generation", "import-manifest.json"),
    "utf8",
  ));
  assert.equal(imported.sourcePackage.status, "specified");
  assert.match(imported.sourcePackage.path, new RegExp(\`qh-\${id}-\`));
}
\`\`\`

- [ ] **Step 4: Commit the red test.**

\`\`\`bash
git add tests/quantum-harness-import.test.mjs
git commit -m "test: define quantum harness import contract"
\`\`\`

### Task 2: Materialize the five lossless mirrors

**Files:**
- Create: \`problems/Prob-124/\`, \`problems/Prob-125/\`, \`problems/Prob-126/\`, \`problems/Prob-127/\`, \`problems/Prob-128/\`
- Create: each record's \`problem.json\`, \`problem.md\`, \`generation/initial-prompt.md\`, \`generation/decision.md\`, \`generation/import-manifest.json\`, and \`package/\` tree

- [ ] **Step 1: Copy source packages without transforming their content.**

Copy exactly these source directories into matching \`package/\` roots:

\`\`\`text
quantum.harness/autoresearch/problems/calibration/qh-124-kagome-energy-bracket
quantum.harness/autoresearch/problems/calibration/qh-125-j1j2-variational-sota
quantum.harness/autoresearch/problems/calibration/qh-126-aklt-spectral-gap
quantum.harness/autoresearch/problems/calibration/qh-127-contraction-cost
quantum.harness/autoresearch/problems/calibration/qh-128-trotter-bound
\`\`\`

- [ ] **Step 2: Create exactly one schema-valid manifest per source package.**

Use this field shape, substituting the original title and concise objective from \`package/problem.yaml\`:

\`\`\`json
{
  "schemaVersion": 1,
  "id": "Prob-124",
  "title": "Original qh-124 title",
  "summary": "Normalized hard-judgment package imported from Quantum Harness; solver input is specified but not ready.",
  "status": "qualifying",
  "gate": { "type": "quantum-harness-hard-gate", "readiness": "specified" },
  "provenance": { "sourceCount": 1 },
  "lastActivity": {
    "summary": "Imported from qh-124; source package remains specified.",
    "at": "2026-07-28T00:00:00Z"
  },
  "createdAt": "2026-07-28T00:00:00Z",
  "updatedAt": "2026-07-28T00:00:00Z"
}
\`\`\`

- [ ] **Step 3: Create the readable projection and auditable generation records.**

Each \`problem.md\` must include the original issue URL, current source-package status, exact relative \`package/\` path, hard-gate summary, and an explicit sentence: “This console record is not the solver input; \`package/\` is authoritative.” Each import manifest records source repository, source package path, source commit \`ca0c683\`, copied-file SHA-256 list, and \`status: specified\`.

- [ ] **Step 4: Run the new import test.**

Run: \`node --test tests/quantum-harness-import.test.mjs\`
Expected: PASS.

- [ ] **Step 5: Commit the records.**

\`\`\`bash
git add problems tests/quantum-harness-import.test.mjs
git commit -m "feat: import quantum harness problem packages"
\`\`\`

### Task 3: Validate indexed presentation and source integrity

**Files:**
- Modify: \`package.json\`
- Test: \`tests/quantum-harness-import.test.mjs\`

- [ ] **Step 1: Extend the test with an index/projection check.**

\`\`\`js
assert.equal(index.summary.total, 5);
assert.equal(index.summary.accepted, 0);
assert.equal(index.summary.solved, 0);
assert.equal(index.diagnostics.length, 0);
for (const id of ["124", "125", "126", "127", "128"]) {
  const markdown = await readFile(join("problems", \`Prob-\${id}\`, "problem.md"), "utf8");
  assert.match(markdown, /package\\/ is authoritative/);
}
\`\`\`

- [ ] **Step 2: Add the test to the existing test command.**

Append \`tests/quantum-harness-import.test.mjs\` to the first \`node --test\` invocation in \`package.json\`.

- [ ] **Step 3: Run the targeted test and full project suite.**

Run: \`node --test tests/quantum-harness-import.test.mjs\`
Expected: PASS.

Run: \`npm test\`
Expected: PASS, including index build, app build, rendered HTML, and Pages showcase checks.

- [ ] **Step 4: Commit the verification wiring.**

\`\`\`bash
git add package.json tests/quantum-harness-import.test.mjs
git commit -m "test: verify imported quantum harness packages"
\`\`\`

## Plan self-review

The plan preserves the source package as the only solver authority, maps all five packages to non-promoted \`qualifying/specified\` console state, retains generation provenance, adds no fake benchmark/validator values, and verifies both the repository index and user-facing build.

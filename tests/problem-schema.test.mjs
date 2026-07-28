import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_WITH_GATE_STATUSES,
  PROBLEM_STATUSES,
  REQUIRED_PROBLEM_MD_HEADINGS,
  validateProblemManifest,
} from "../lib/problems/schema.mjs";

const completeProblemMd = REQUIRED_PROBLEM_MD_HEADINGS
  .map((heading) => `## ${heading}\nConcrete content for ${heading}.`)
  .join("\n\n");

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "Prob-001",
    title: "Certified timestep bounds for 1D lattice dynamics",
    summary: "Tighter machine-checkable bounds for fresh simulation instances.",
    status: "draft",
    gate: {
      type: "interval-arithmetic",
      readiness: "specified",
    },
    provenance: {
      sourceCount: 3,
    },
    lastActivity: {
      summary: "Problem draft created by Codex.",
      at: "2026-07-27T10:00:00Z",
    },
    createdAt: "2026-07-27T10:00:00Z",
    updatedAt: "2026-07-27T10:00:00Z",
    ...overrides,
  };
}

test("accepts every lifecycle status with its required conditional fields", () => {
  for (const status of PROBLEM_STATUSES) {
    const readiness = ACTIVE_WITH_GATE_STATUSES.includes(status)
      ? "executable"
      : "specified";
    const candidate = manifest({
      status,
      gate: { type: "interval-arithmetic", readiness },
      ...(status === "rejected"
        ? { rejection: { kind: "automatic", reason: "No ungameable executable gate." } }
        : {}),
    });

    const result = validateProblemManifest(candidate, {
      relativePath: `problems/${status}/problem.json`,
      problemMdText: ACTIVE_WITH_GATE_STATUSES.includes(status) ? completeProblemMd : null,
    });

    assert.equal(result.ok, true, status);
  }
});

test("rejects unknown top-level manifest fields", () => {
  const result = validateProblemManifest(manifest({ typoStatus: "accepted" }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.field), ["typoStatus"]);
  assert.match(result.errors[0].message, /Unknown top-level field/);
});

test("accepts an optional immutable external source binding", () => {
  const sourceBinding = {
    kind: "git-path",
    repository: "https://github.com/example/research-problems",
    revision: "0123456789abcdef0123456789abcdef01234567",
    path: "problems/Prob-001",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  const result = validateProblemManifest(manifest({ sourceBinding }));

  assert.equal(result.ok, true);
});

test("requires executable or passed gate readiness for accepted and later statuses", () => {
  const result = validateProblemManifest(
    manifest({
      status: "accepted",
      gate: { type: "interval-arithmetic", readiness: "specified" },
    }),
    { problemMdText: completeProblemMd },
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.field).join(","), /gate\.readiness/);
});

test("requires rejection kind and reason when status is rejected", () => {
  const result = validateProblemManifest(manifest({ status: "rejected" }));

  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.field).join(","), /rejection/);
});

test("requires complete problem markdown for accepted and later statuses", () => {
  const result = validateProblemManifest(manifest({ status: "solved" }), {
    problemMdText: "## Background and Gap\nOnly one section.",
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.field).join(","), /problem\.md/);
});

test("does not count headings inside fenced code blocks as problem markdown sections", () => {
  const result = validateProblemManifest(
    manifest({
      status: "accepted",
      gate: { type: "interval-arithmetic", readiness: "executable" },
    }),
    { problemMdText: `\`\`\`markdown\n${completeProblemMd}\n\`\`\`` },
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.field).join(","), /problem\.md/);
});

test("does not close fenced code blocks on a fence with trailing text", () => {
  const result = validateProblemManifest(
    manifest({
      status: "accepted",
      gate: { type: "interval-arithmetic", readiness: "executable" },
    }),
    { problemMdText: `\`\`\`markdown\n\`\`\`not-a-closing-fence\n${completeProblemMd}\n\`\`\`` },
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.field).join(","), /problem\.md/);
});

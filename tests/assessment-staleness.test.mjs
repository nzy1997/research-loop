import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildInputSnapshot, sha256Text } from "../lib/assessments/input-snapshot.mjs";
import { evaluateAssessmentStaleness } from "../lib/assessments/staleness.mjs";

test("hashes text with sha256", () => {
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("builds input snapshot from problem, skill, schema, and matched bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-input-"));
  await mkdir(join(root, "problems", "Prob-001"), { recursive: true });
  await mkdir(join(root, "knowledge", "example"), { recursive: true });
  await mkdir(join(root, "skills", "assess-research-problem"), { recursive: true });
  await mkdir(join(root, "schemas"), { recursive: true });
  await writeFile(join(root, "problems", "Prob-001", "problem.json"), "{\"id\":\"Prob-001\"}\n");
  await writeFile(join(root, "problems", "Prob-001", "problem.md"), "Problem markdown.");
  await writeFile(join(root, "knowledge", "example", "index.qmd"), "Trusted bundle.");
  await writeFile(join(root, "skills", "assess-research-problem", "SKILL.md"), "Skill text.");
  await writeFile(join(root, "schemas", "research-problem-assessment.schema.json"), "{}");

  const input = await buildInputSnapshot({
    rootDir: root,
    problem: { id: "Prob-001", title: "Fixture", summary: "Summary" },
    envelope: {
      knowledgeResolution: {
        query: "Fixture",
        status: "match",
        topic: "knowledge/example/index.qmd",
        orderedFiles: ["knowledge/example/index.qmd"],
      },
    },
    skillPath: join(root, "skills", "assess-research-problem", "SKILL.md"),
    schemaPath: join(root, "schemas", "research-problem-assessment.schema.json"),
    selectedAlternative: { page: "knowledge/example/index.qmd" },
  });

  assert.equal(input.problemId, "Prob-001");
  assert.equal(input.resolver.status, "match");
  assert.equal(input.resolver.selectedPage, "knowledge/example/index.qmd");
  assert.equal(input.bundle[0].path, "knowledge/example/index.qmd");
  assert.match(input.problemJsonHash, /^[a-f0-9]{64}$/);
  assert.match(input.skillHash, /^[a-f0-9]{64}$/);
});

test("marks stale when resolver bundle path changes", async () => {
  const input = {
    problemId: "Prob-001",
    problemJsonHash: "same",
    problemMdHash: "same",
    skillHash: "same",
    schemaHash: "same",
    resolver: { query: "Fixture", status: "match", topic: "knowledge/a.qmd", orderedFiles: ["knowledge/a.qmd"] },
    bundle: [{ path: "knowledge/a.qmd", hash: "same" }],
  };
  const result = await evaluateAssessmentStaleness({
    rootDir: "/tmp/not-read",
    input,
    currentHashes: {
      problemJsonHash: "same",
      problemMdHash: "same",
      skillHash: "same",
      schemaHash: "same",
      bundle: [{ path: "knowledge/a.qmd", hash: "same" }],
    },
    resolveKnowledge: async () => ({
      status: "match",
      topic: "knowledge/b.qmd",
      orderedFiles: ["knowledge/b.qmd"],
    }),
  });
  assert.equal(result.stale, true);
  assert.match(result.reasons.join("\n"), /resolver result changed/);
});

test("keeps a matching report current with the resolver's bundle result shape", async () => {
  const input = {
    problemId: "Prob-001",
    problemJsonHash: "same",
    problemMdHash: "same",
    skillHash: "same",
    schemaHash: "same",
    resolver: { query: "Fixture", status: "match", topic: "knowledge/a.qmd", orderedFiles: ["knowledge/a.qmd"] },
    bundle: [{ path: "knowledge/a.qmd", hash: "same" }],
  };
  const result = await evaluateAssessmentStaleness({
    rootDir: "/tmp/not-read",
    input,
    currentHashes: {
      problemJsonHash: "same",
      problemMdHash: "same",
      skillHash: "same",
      schemaHash: "same",
      bundle: [{ path: "knowledge/a.qmd", hash: "same" }],
    },
    resolveKnowledge: async () => ({
      status: "match",
      bundle: {
        topic: "knowledge/a.qmd",
        orderedFiles: ["knowledge/a.qmd"],
      },
    }),
  });
  assert.deepEqual(result, { stale: false, reasons: [] });
});

test("rechecks a user-selected report with the same selected resolver page", async () => {
  const input = {
    problemId: "Prob-001",
    problemJsonHash: "same",
    problemMdHash: "same",
    skillHash: "same",
    schemaHash: "same",
    resolver: {
      query: "Fixture",
      status: "match",
      topic: "knowledge/a/index.qmd",
      orderedFiles: ["knowledge/a.qmd"],
      selectedPage: "knowledge/a.qmd",
    },
    bundle: [{ path: "knowledge/a.qmd", hash: "same" }],
  };
  const result = await evaluateAssessmentStaleness({
    rootDir: "/tmp/not-read",
    input,
    currentHashes: {
      problemJsonHash: "same",
      problemMdHash: "same",
      skillHash: "same",
      schemaHash: "same",
      bundle: [{ path: "knowledge/a.qmd", hash: "same" }],
    },
    resolveKnowledge: async (_query, options) => options?.selectedPage === "knowledge/a.qmd"
      ? {
          status: "match",
          bundle: { topic: "knowledge/a/index.qmd", orderedFiles: ["knowledge/a.qmd"] },
        }
      : { status: "ambiguous", bundle: null, alternatives: [] },
  });

  assert.deepEqual(result, { stale: false, reasons: [] });
});

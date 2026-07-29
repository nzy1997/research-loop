import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAssessmentPrompt,
  checkCodexPreflight,
  runCodexAssessment,
} from "../lib/assessments/codex-adapter.mjs";

function fakeEnvelopeText() {
  const dimsV = [
    ["importance", 20], ["gap_and_novelty", 20], ["plausibility", 15],
    ["learning_from_failure", 15], ["generality_and_publication", 15],
    ["expected_value_relative_to_cost", 15],
  ].map(([id, weight]) => ({ id, label: id, weight, score: { min: 4, estimate: 4, max: 4 }, evidenceState: "supported", rationale: id, evidenceRefs: ["p1"] }));
  const dimsA = [
    ["modifiable_search_object", 20], ["executable_objective", 20],
    ["correctness_and_anti_gaming", 15], ["incremental_feedback", 15],
    ["fresh_evaluation", 10], ["reproducibility_and_auditability", 10],
    ["attempt_runtime", 10],
  ].map(([id, weight]) => ({ id, label: id, weight, score: { min: 4, estimate: 4, max: 4 }, evidenceState: "supported", rationale: id, evidenceRefs: ["p1"] }));
  return JSON.stringify({
    outcome: "assessment",
    language: "en",
    knowledgeResolution: { query: "Fixture", status: "match", topic: "knowledge/x.qmd", orderedFiles: ["knowledge/x.qmd"] },
    assessment: {
      schemaVersion: 1,
      normalizedProblem: "Fixture",
      verdict: { label: "DO_NOW", provisional: false, possibleLabels: ["DO_NOW"] },
      recommendation: "proceed",
      scores: {
        researchValue: { min: 80, estimate: 80, max: 80 },
        autoresearchSuitability: { min: 80, estimate: 80, max: 80 },
        combined: { min: 80, estimate: 80, max: 80 },
      },
      confidence: { level: "high", rationale: "Supported." },
      dimensions: { researchValue: dimsV, autoresearchSuitability: dimsA },
      largestBottleneck: "None.",
      recommendedReframe: { kind: "none", text: "No bounded reframe is needed." },
      informationGaps: [],
      evidence: [{ id: "p1", kind: "problem", path: "problems/Prob-001/problem.md", locator: null, summary: "Problem text." }],
    },
    clarification: null,
  });
}

test("preflight checks version and login status with fixed commands", async () => {
  const calls = [];
  const result = await checkCodexPreflight({
    rootDir: "/repo",
    skillPath: "/repo/skills/assess-research-problem/SKILL.md",
    schemaPath: "/repo/schemas/research-problem-assessment.schema.json",
    execFileFn(command, args, options, callback) {
      calls.push({ command, args, cwd: options.cwd });
      callback(null, args.includes("--version") ? "codex-cli 0.145.0\n" : "Logged in\n", "");
    },
    fileExists: async () => true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["login", "status"]]);
  assert.deepEqual(calls.map((call) => call.cwd), ["/repo", "/repo"]);
});

test("prompt names the repo skill and forbids lifecycle mutation", () => {
  const prompt = buildAssessmentPrompt({
    problem: { id: "Prob-001", title: "Fixture", summary: "Summary" },
    problemMarkdown: "## Background and Gap\nText.",
  });
  assert.match(prompt, /assess-research-problem/);
  assert.match(prompt, /Do not modify problem\.json/);
  assert.match(prompt, /Return only the structured schema response/);
});

test("a host-selected bundle tells Codex to continue without asking for ambiguity input again", () => {
  const prompt = buildAssessmentPrompt({
    problem: { id: "Prob-001", title: "Fixture", summary: "Summary" },
    problemMarkdown: "## Background and Gap\nText.",
    selectedAlternative: {
      page: "knowledge/alpha/note.qmd",
      topic: "knowledge/alpha/index.qmd",
      title: "Alpha",
      matchKind: "exact-title",
    },
    trustedResolution: {
      schemaVersion: 1,
      query: "Fixture",
      status: "match",
      bundle: {
        topic: "knowledge/alpha/index.qmd",
        ancestorIndexes: ["knowledge/index.qmd", "knowledge/alpha/index.qmd"],
        contentPages: ["knowledge/alpha/note.qmd"],
        orderedFiles: [
          "knowledge/index.qmd",
          "knowledge/alpha/index.qmd",
          "knowledge/alpha/note.qmd",
        ],
      },
      alternatives: [],
    },
  });

  assert.match(prompt, /host resolver has already applied the user's explicit selection/i);
  assert.match(prompt, /knowledge\/alpha\/note\.qmd/);
  assert.match(prompt, /do not return needs_input/i);
  assert.doesNotMatch(prompt, /If the resolver is ambiguous, return outcome needs_input/);
});

test("codex runner uses safe argv, read-only sandbox, ephemeral mode, JSONL, schema, and output-last-message", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-codex-"));
  const runDir = join(root, ".generated", "assessment-runs", "run");
  await mkdir(runDir, { recursive: true });
  const calls = [];
  function spawnFn(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      await writeFile(join(runDir, "final-message.json"), fakeEnvelopeText());
      child.stdout.emit("data", Buffer.from("{\"type\":\"stage\",\"stage\":\"done\"}\n"));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  }
  const result = await runCodexAssessment({
    rootDir: root,
    problem: { id: "Prob-001", title: "Fixture", summary: "Summary" },
    problemMarkdown: "Problem markdown.",
    runDir,
    schemaPath: join(root, "schemas", "research-problem-assessment.schema.json"),
    spawnFn,
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args.slice(0, 8), [
    "exec",
    "--sandbox", "read-only",
    "--ephemeral",
    "--json",
    "--output-schema", join(root, "schemas", "research-problem-assessment.schema.json"),
    "--output-last-message",
  ]);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.shell, false);
});

test("codex runner captures stream data that drains after exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-codex-drain-"));
  const runDir = join(root, ".generated", "assessment-runs", "run");
  await mkdir(runDir, { recursive: true });
  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      await writeFile(join(runDir, "final-message.json"), fakeEnvelopeText());
      child.emit("exit", 0, null);
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from("{\"type\":\"complete\"}\n"));
        child.stderr.emit("data", Buffer.from("late diagnostic\n"));
        child.emit("close", 0, null);
      }, 10);
    });
    return child;
  }
  const result = await runCodexAssessment({
    rootDir: root,
    problem: { id: "Prob-001", title: "Fixture", summary: "Summary" },
    problemMarkdown: "Problem markdown.",
    runDir,
    schemaPath: join(root, "schemas", "research-problem-assessment.schema.json"),
    spawnFn,
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.eventsText, "{\"type\":\"complete\"}\n");
  assert.equal(result.stderr, "late diagnostic\n");
});

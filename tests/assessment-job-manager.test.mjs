import assert from "node:assert/strict";
import test from "node:test";

import { validateAssessmentEnvelope } from "../lib/assessments/contract.mjs";
import { createAssessmentJobManager } from "../lib/assessments/job-manager.mjs";

function fakeRepository() {
  return {
    getProblem(id) {
      return id === "Prob-001"
        ? { id, title: "Fixture", summary: "Summary" }
        : null;
    },
    async readProblemMarkdown(id) {
      return `# ${id}\n\nProblem body.`;
    },
  };
}

function fakeStore() {
  const runs = [];
  return {
    runs,
    async createAcceptedRun({ problemId, parentRunId = null }) {
      const run = { schemaVersion: 1, runId: `20260728T01020${runs.length}Z-a1b2c3`, problemId, parentRunId, status: "queued", stagingDir: `/tmp/${runs.length}` };
      runs.push(run);
      return run;
    },
    async appendEvent() {},
    async writeTerminalArtifacts(run, artifacts) {
      run.status = artifacts.status;
      run.error = artifacts.error ?? null;
      run.summary = artifacts.summary ?? null;
      run.artifacts = artifacts;
      return run;
    },
    async listRuns(problemId) {
      return runs.filter((run) => run.problemId === problemId);
    },
    async findRun(runId) {
      return runs.find((run) => run.runId === runId) ?? null;
    },
    async readClarification(problemId, runId) {
      return runs.find((run) => run.problemId === problemId && run.runId === runId)?.artifacts?.clarification ?? null;
    },
    async readInput(problemId, runId) {
      return runs.find((run) => run.problemId === problemId && run.runId === runId)?.artifacts?.input ?? null;
    },
  };
}

function dimension({ id, label, weight }) {
  return {
    id,
    label,
    weight,
    score: { min: 4, estimate: 4, max: 4 },
    evidenceState: "supported",
    rationale: `${label} is supported in the fixture.`,
    evidenceRefs: ["p1"],
  };
}

function completedCodexResult() {
  const envelope = {
    outcome: "assessment",
    language: "en",
    knowledgeResolution: {
      query: "Fixture",
      status: "match",
      topic: "knowledge/topic.qmd",
      orderedFiles: ["knowledge/topic.qmd"],
    },
    assessment: {
      schemaVersion: 1,
      normalizedProblem: "Fixture problem.",
      verdict: { label: "DO_NOW", provisional: false, possibleLabels: ["DO_NOW"] },
      recommendation: "proceed",
      scores: {
        researchValue: { min: 80, estimate: 80, max: 80 },
        autoresearchSuitability: { min: 80, estimate: 80, max: 80 },
        combined: { min: 80, estimate: 80, max: 80 },
      },
      confidence: { level: "medium", rationale: "Fixture confidence." },
      dimensions: {
        researchValue: [
          { id: "importance", label: "Importance", weight: 20 },
          { id: "gap_and_novelty", label: "Gap and novelty", weight: 20 },
          { id: "plausibility", label: "Plausibility", weight: 15 },
          { id: "learning_from_failure", label: "Learning from failure", weight: 15 },
          { id: "generality_and_publication", label: "Generality and publication potential", weight: 15 },
          { id: "expected_value_relative_to_cost", label: "Expected value relative to cost", weight: 15 },
        ].map(dimension),
        autoresearchSuitability: [
          { id: "modifiable_search_object", label: "Modifiable search object", weight: 20 },
          { id: "executable_objective", label: "Executable objective", weight: 20 },
          { id: "correctness_and_anti_gaming", label: "Correctness and anti-gaming", weight: 15 },
          { id: "incremental_feedback", label: "Incremental feedback", weight: 15 },
          { id: "fresh_evaluation", label: "Fresh evaluation", weight: 10 },
          { id: "reproducibility_and_auditability", label: "Reproducibility and auditability", weight: 10 },
          { id: "attempt_runtime", label: "Attempt runtime", weight: 10 },
        ].map(dimension),
      },
      largestBottleneck: "No bottleneck in the fixture.",
      recommendedReframe: { kind: "none", text: "No reframe needed." },
      informationGaps: ["None in fixture."],
      evidence: [{ id: "p1", kind: "problem", path: "problems/Prob-001/problem.md", locator: null, summary: "Fixture problem." }],
    },
    clarification: null,
  };
  const validation = validateAssessmentEnvelope(envelope);
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  return {
    ok: true,
    envelope: validation.value,
    computed: validation.computed,
    eventsText: '{"type":"complete"}\n',
    stderr: "",
  };
}

test("rejects unknown problem IDs before accepting a run", async () => {
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store: fakeStore(),
    codex: { preflight: async () => ({ ok: true }), run: async () => ({ ok: true }) },
  });
  const result = await manager.start("Prob-999");
  assert.equal(result.accepted, false);
  assert.equal(result.code, "UNKNOWN_PROBLEM");
});

test("returns the active run for duplicate starts", async () => {
  let release;
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async () => new Promise((resolve) => { release = () => resolve({ ok: false, code: "CODEX_EXIT", message: "done", eventsText: "", stderr: "" }); }),
    },
  });
  const first = await manager.start("Prob-001");
  const second = await manager.start("Prob-001");
  assert.equal(second.runId, first.runId);
  release();
});

test("problem state exposes public active job fields only", async () => {
  let release;
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async ({ onChild }) => {
        onChild?.({ kill() {}, spawnargs: ["codex", "exec", "secret prompt"] });
        return new Promise((resolve) => {
          release = () => resolve({ ok: false, code: "CODEX_EXIT", message: "done", eventsText: "", stderr: "" });
        });
      },
    },
  });

  const accepted = await manager.start("Prob-001");
  const state = await manager.getProblemState("Prob-001");

  assert.equal(state.activeJob.runId, accepted.runId);
  assert.equal(state.activeJob.status, "running");
  assert.equal("run" in state.activeJob, false);
  assert.equal("child" in state.activeJob, false);
  assert.equal("stagingDir" in state.activeJob, false);
  assert.equal(JSON.stringify(state).includes("secret prompt"), false);
  release();
});

test("runs jobs one at a time in FIFO order", async () => {
  const order = [];
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async ({ problem }) => {
        order.push(problem.id);
        return { ok: false, code: "CODEX_EXIT", message: "forced failure", eventsText: "", stderr: "" };
      },
    },
  });
  await manager.start("Prob-001");
  await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["Prob-001"]);
  assert.equal(store.runs.length, 1);
});

test("selection consumes a clarification run and records the selected alternative", async () => {
  const alternative = { page: "knowledge/topic.qmd", topic: "topic", title: "Topic", matchKind: "title" };
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async ({ selectedAlternative }) => selectedAlternative
        ? { ok: false, code: "CODEX_EXIT", message: "done", eventsText: "", stderr: "" }
        : { ok: true, envelope: { outcome: "needs_input", clarification: { alternatives: [alternative] } }, stderr: "" },
    },
  });

  const parent = await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await manager.select(parent.runId, { ...alternative, title: "Wrong" })).code, "INVALID_SELECTION");
  const child = await manager.select(parent.runId, alternative);
  const repeated = await manager.select(parent.runId, alternative);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(repeated.runId, child.runId);
  assert.equal(store.runs.length, 2);
  assert.deepEqual(store.runs[1].artifacts.selection, alternative);
  assert.equal((await manager.getProblemState("Prob-001")).activeJob, null);
});

test("selection supplies the exact host bundle and rejects a child query change", async () => {
  const selected = { page: "knowledge/a.qmd", topic: "knowledge/a/index.qmd", title: "A", matchKind: "exact-title" };
  const other = { page: "knowledge/b.qmd", topic: "knowledge/b/index.qmd", title: "B", matchKind: "exact-title" };
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async ({ selectedAlternative, trustedResolution }) => {
        if (!selectedAlternative) {
          return {
            ok: true,
            envelope: {
              outcome: "needs_input",
              language: "en",
              knowledgeResolution: { query: "Fixture", status: "ambiguous", topic: null, orderedFiles: [] },
              assessment: null,
              clarification: { query: "Fixture", reason: "Choose one.", alternatives: [selected, other] },
            },
            stderr: "",
          };
        }
        if (trustedResolution?.bundle?.orderedFiles.at(-1) !== selected.page) {
          return { ok: false, code: "MISSING_TRUSTED_SELECTION", message: "selected bundle was not supplied", stderr: "" };
        }
        const completed = completedCodexResult();
        completed.envelope.knowledgeResolution = {
          query: "Forged child query",
          status: "match",
          topic: selected.topic,
          orderedFiles: ["knowledge/index.qmd", selected.topic, selected.page],
        };
        return completed;
      },
    },
    resolveKnowledge: async (_query, options) => options?.selectedPage
      ? {
          schemaVersion: 1,
          query: "Fixture",
          status: "match",
          bundle: {
            topic: selected.topic,
            ancestorIndexes: ["knowledge/index.qmd", selected.topic],
            contentPages: [selected.page],
            orderedFiles: ["knowledge/index.qmd", selected.topic, selected.page],
          },
          alternatives: [],
        }
      : {
          schemaVersion: 1,
          query: "Fixture",
          status: "ambiguous",
          bundle: null,
          alternatives: [
            { ...selected, tier: 0, matchedTerms: 1 },
            { ...other, tier: 0, matchedTerms: 1 },
          ],
        },
    snapshot: { build: async () => ({ schemaVersion: 1, problemId: "Prob-001" }) },
    reportRenderer: { render: () => "<!doctype html><title>Assessment</title>" },
  });

  const parent = await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const child = await manager.select(parent.runId, selected);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const childRun = store.runs.find((run) => run.runId === child.runId);
  assert.equal(childRun?.status, "failed");
  assert.equal(childRun?.artifacts.error.code, "KNOWLEDGE_RESOLUTION_MISMATCH");
  assert.equal(childRun?.artifacts.assessment, undefined);
});

test("hydrates a persisted clarification after restart for deduplication and selection", async () => {
  const alternative = { page: "knowledge/topic.qmd", topic: "topic", title: "Topic", matchKind: "title" };
  const store = fakeStore();
  const codex = {
    preflight: async () => ({ ok: true }),
    run: async ({ selectedAlternative }) => selectedAlternative
      ? { ok: false, code: "CODEX_EXIT", message: "done", eventsText: "", stderr: "" }
      : { ok: true, envelope: { outcome: "needs_input", clarification: { alternatives: [alternative] } }, stderr: "" },
  };
  const firstManager = createAssessmentJobManager({ rootDir: "/repo", repository: fakeRepository(), store, codex });
  const parent = await firstManager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const restartedManager = createAssessmentJobManager({ rootDir: "/repo", repository: fakeRepository(), store, codex });
  const state = await restartedManager.getProblemState("Prob-001");
  const duplicate = await restartedManager.start("Prob-001");
  const child = await restartedManager.select(parent.runId, alternative);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const retriedSelection = await createAssessmentJobManager({ rootDir: "/repo", repository: fakeRepository(), store, codex })
    .select(parent.runId, alternative);

  assert.equal(state.activeJob.runId, parent.runId);
  assert.deepEqual(state.activeJob.clarification.alternatives, [alternative]);
  assert.equal(duplicate.runId, parent.runId);
  assert.equal(child.accepted, true);
  assert.equal(retriedSelection.runId, child.runId);
  assert.equal(store.runs.length, 2);
  assert.equal(store.runs[1].parentRunId, parent.runId);
});

test("persists completed run summaries for problem page polling", async () => {
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async () => completedCodexResult(),
    },
    snapshot: {
      build: async () => ({ schemaVersion: 1, problemId: "Prob-001" }),
    },
    reportRenderer: {
      render: () => "<!doctype html><title>Assessment</title>",
    },
  });

  await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const state = await manager.getProblemState("Prob-001");
  const run = state.runs.find((item) => item.status === "completed");

  assert.equal(run.summary.verdict, "DO_NOW");
  assert.equal(run.summary.recommendation, "proceed");
  assert.equal(run.summary.lifecycleMutation, false);
  assert.equal(run.summary.reportHref, `/__local/assessments/reports/Prob-001/${run.runId}`);
  assert.equal("stagingDir" in run, false);
  assert.equal("artifacts" in run, false);
  assert.equal(store.runs[0].artifacts.assessment.envelope.assessment.normalizedProblem, "Fixture problem.");
  assert.equal(store.runs[0].artifacts.eventsText, '{"type":"complete"}\n');
});

test("retains Codex events when assessment post-processing fails", async () => {
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async () => completedCodexResult(),
    },
    snapshot: {
      build: async () => { throw new Error("snapshot failed"); },
    },
  });

  await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(store.runs[0].status, "failed");
  assert.equal(store.runs[0].artifacts.error.message, "snapshot failed");
  assert.equal(store.runs[0].artifacts.eventsText, '{"type":"complete"}\n');
});

test("rejects a completed assessment when the host resolver disagrees with the model", async () => {
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async () => completedCodexResult(),
    },
    resolveKnowledge: async () => ({
      schemaVersion: 1,
      query: "Fixture",
      status: "no-match",
      bundle: null,
      alternatives: [],
    }),
    snapshot: {
      build: async () => {
        throw new Error("a mismatched assessment must not build a trusted snapshot");
      },
    },
  });

  await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(store.runs[0].status, "failed");
  assert.deepEqual(store.runs[0].artifacts.error, {
    code: "KNOWLEDGE_RESOLUTION_MISMATCH",
    message: "Codex knowledge resolution does not match the trusted host resolver.",
  });
  assert.equal(store.runs[0].artifacts.assessment, undefined);
  assert.equal(store.runs[0].artifacts.reportHtml, undefined);
});

test("rejects model-supplied ambiguity alternatives that differ from the host resolver", async () => {
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async () => ({
        ok: true,
        envelope: {
          outcome: "needs_input",
          language: "en",
          knowledgeResolution: {
            query: "Fixture",
            status: "ambiguous",
            topic: null,
            orderedFiles: [],
          },
          assessment: null,
          clarification: {
            query: "Fixture",
            reason: "Choose one trusted topic.",
            alternatives: [
              { page: "knowledge/a.qmd", topic: "knowledge/a/index.qmd", title: "Altered A", matchKind: "exact-title" },
              { page: "knowledge/b.qmd", topic: "knowledge/b/index.qmd", title: "B", matchKind: "exact-title" },
            ],
          },
        },
        stderr: "",
      }),
    },
    resolveKnowledge: async () => ({
      schemaVersion: 1,
      query: "Fixture",
      status: "ambiguous",
      bundle: null,
      alternatives: [
        { page: "knowledge/a.qmd", topic: "knowledge/a/index.qmd", title: "A", matchKind: "exact-title", tier: 0, matchedTerms: 1 },
        { page: "knowledge/b.qmd", topic: "knowledge/b/index.qmd", title: "B", matchKind: "exact-title", tier: 0, matchedTerms: 1 },
      ],
    }),
  });

  await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(store.runs[0].status, "failed");
  assert.equal(store.runs[0].artifacts.error.code, "KNOWLEDGE_RESOLUTION_MISMATCH");
  assert.equal(store.runs[0].artifacts.clarification, undefined);
});

test("problem state surfaces stale latest summaries", async () => {
  const store = fakeStore();
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: fakeRepository(),
    store,
    codex: {
      preflight: async () => ({ ok: true }),
      run: async () => completedCodexResult(),
    },
    snapshot: {
      build: async () => ({
        schemaVersion: 1,
        problemId: "Prob-001",
        resolver: { query: "Fixture", status: "match", topic: "knowledge/topic.qmd", orderedFiles: ["knowledge/topic.qmd"] },
      }),
    },
    reportRenderer: {
      render: () => "<!doctype html><title>Assessment</title>",
    },
    resolveKnowledge: async () => ({
      schemaVersion: 1,
      query: "Fixture",
      status: "match",
      bundle: { topic: "knowledge/topic.qmd", orderedFiles: ["knowledge/topic.qmd"] },
      alternatives: [],
    }),
    staleness: {
      evaluate: async ({ input, resolveKnowledge }) => {
        await resolveKnowledge(input.resolver.query);
        return { stale: true, reasons: ["problemMdHash changed"] };
      },
    },
  });

  await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const state = await manager.getProblemState("Prob-001");

  assert.equal(state.latest.verdict, "DO_NOW");
  assert.equal(state.stale, true);
  assert.deepEqual(state.staleReasons, ["problemMdHash changed"]);
});

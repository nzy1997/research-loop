import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPreparationWorker } from "../lib/autoresearch/preparation-worker.mjs";

const JOB = "ARJ-20260728T080000Z-deadbeef";
const CHILD_JOB = "ARJ-20260728T080001Z-deadbeef";
const PROBLEM = "Prob-007";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function manifest(id = "INF-001") {
  const source = "print('candidate')\n";
  return {
    schemaVersion: 1, kind: "autoresearch-infrastructure", problemId: PROBLEM, id, status: "ready",
    candidate: { templatePath: "candidate-template/candidate.py", writablePaths: ["candidate.py"] },
    objective: { metricId: "score", label: "Score", direction: "maximize", acceptanceThreshold: 0.7 },
    commands: { publicCheck: ["python3", "public.py"], containmentCheck: ["python3", "contain.py"], evaluateDevelopment: ["python3", "evaluate.py"], reproduceBaseline: ["python3", "baseline.py"] },
    datasets: { public: { manifestPath: "datasets/public.json", digest: "a".repeat(64) }, development: { manifestPath: "datasets/development.json", digest: "b".repeat(64) }, blind: { manifestPath: "datasets/blind.json", digest: "c".repeat(64) } },
    resources: { attemptTimeoutSeconds: 60, terminationGraceSeconds: 5, memoryMb: 1024, network: "denied" },
    files: [{ path: "candidate-template/candidate.py", sha256: digest(source), size: Buffer.byteLength(source), executable: false }],
    createdAt: "2026-07-28T08:00:00.000Z",
  };
}

function problem(status = "qualifying") {
  const acceptedOrLater = ["accepted", "solving", "solved", "publishing", "published"].includes(status);
  const value = {
    schemaVersion: 1, id: PROBLEM, title: "Fixture", summary: "Fixture summary", status,
    gate: { type: "fixture", readiness: acceptedOrLater ? "executable" : "specified" }, provenance: { sourceCount: 0 },
    lastActivity: { summary: "Created", at: "2026-07-28T08:00:00.000Z" },
    createdAt: "2026-07-28T08:00:00.000Z", updatedAt: "2026-07-28T08:00:00.000Z",
  };
  if (status === "rejected") value.rejection = { kind: "human", reason: "Fixture rejection" };
  return value;
}

async function fixture(t, { status, parentJobId = null } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "preparation-worker-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const problemDir = join(rootDir, "problems", PROBLEM);
  await mkdir(problemDir, { recursive: true });
  await writeFile(join(problemDir, "problem.json"), `${JSON.stringify(problem(status))}\n`);
  await writeFile(join(problemDir, "problem.md"), "# Background and Gap\n# Research Objective\n# Publication Threshold\n# Executable Gate\n# Novelty Evidence\n# Provenance\n# Fresh Evaluation Plan\n");
  const workspaceDir = join(rootDir, ".generated", "autoresearch-jobs", JOB, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  return { rootDir, workspaceDir, jobs: new Map([[JOB, { jobId: JOB, problemId: PROBLEM, parentJobId, state: "queued" }]]) };
}

function dependencies(context, { envelope = { outcome: "prepared", summary: "Ready", manifestPath: "infrastructure.json", question: null }, preflight = { status: "passed" }, existing = [], publish = { status: "published", id: "INF-001" }, codexError, manifestValue = manifest(), list, publishError, stageMutation, reportMutation, expectedProblemStatus = "qualifying" } = {}) {
  const order = [];
  const jobStore = {
    async read(jobId) { order.push(`read:${jobId}`); return context.jobs.get(jobId); },
    async transition(jobId, state) { order.push(state); const job = context.jobs.get(jobId); context.jobs.set(jobId, { ...job, state }); },
    async appendEvent(jobId, event) { order.push(`event:${event.code ?? event.type}`); return { jobId, event }; },
  };
  const artifactStore = {
    async createPreparationStage({ jobId }) { order.push("stage"); if (stageMutation) await stageMutation(); return { stageDir: join(context.rootDir, ".generated", "autoresearch-jobs", jobId), workspaceDir: context.workspaceDir }; },
    async listInfrastructureRevisions() { order.push("list"); return list ? list() : [...existing]; },
    async writeAtomicJson(path, value) { order.push("report"); await writeFile(path, `${JSON.stringify(value)}\n`); if (reportMutation) await reportMutation(); },
    async publishInfrastructureRevision() { order.push("publish"); if (publishError) throw publishError; return publish; },
  };
  const codexAdapter = async ({ stageDir, problem: preparedProblem, answers }) => { order.push("codex"); assert.equal(stageDir, join(context.rootDir, ".generated", "autoresearch-jobs", JOB)); assert.equal(preparedProblem.status, expectedProblemStatus); assert.deepEqual(answers, { metric: "score" }); if (codexError) throw codexError; if (envelope.outcome === "prepared") await writeFile(join(context.workspaceDir, "infrastructure.json"), `${JSON.stringify(manifestValue)}\n`); return envelope; };
  const preflightRunner = async ({ stageDir, manifest: result }) => { order.push("preflight-run"); assert.equal(stageDir, context.workspaceDir); assert.equal(result.id, "INF-001"); return preflight; };
  return { order, jobStore, artifactStore, codexAdapter, preflightRunner };
}

test("preparation worker validates, stages, prepares, preflights, and publishes in the required order", async (t) => {
  const context = await fixture(t);
  const deps = dependencies(context, { stageMutation: () => writeFile(join(context.rootDir, "problems", PROBLEM, "problem.json"), `${JSON.stringify(problem("draft"))}\n`) });
  const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...deps });

  const result = await worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } });

  assert.deepEqual(result, { state: "ready", infrastructureId: "INF-001" });
  assert.deepEqual(deps.order, ["read:ARJ-20260728T080000Z-deadbeef", "stage", "scaffolding", "building_benchmark", "preparing_datasets", "list", "codex", "preflight", "preflight-run", "report", "list", "publish", "ready"]);
  assert.deepEqual(JSON.parse(await readFile(join(context.rootDir, ".generated", "autoresearch-jobs", JOB, "preflight-report.json"), "utf8")), { status: "passed" });
});

test("needs-input records exactly one question without publishing and a child reuses its parent staging snapshot", async (t) => {
  const context = await fixture(t);
  const question = { id: "metric", prompt: "Choose metric", answerType: "choice", choices: ["score", "loss"] };
  const first = dependencies(context, { envelope: { outcome: "needs_input", summary: "Need metric", manifestPath: null, question } });
  const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...first });
  assert.deepEqual(await worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), { state: "needs_input", question });
  assert.deepEqual(first.order, ["read:ARJ-20260728T080000Z-deadbeef", "stage", "scaffolding", "building_benchmark", "preparing_datasets", "list", "codex", "event:needs-input", "needs_input"]);
  assert.equal(first.order.includes("publish"), false);
  const eventsBeforeRetry = first.order.filter((item) => item === "event:needs-input").length;
  assert.deepEqual(await worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), { state: "needs_input" });
  assert.equal(first.order.filter((item) => item === "event:needs-input").length, eventsBeforeRetry);
  assert.equal(first.order.at(-1), `read:${JOB}`);

  context.jobs.set(CHILD_JOB, { jobId: CHILD_JOB, problemId: PROBLEM, parentJobId: JOB, state: "queued" });
  const resumed = dependencies(context);
  const childWorker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...resumed });
  await childWorker({ jobId: CHILD_JOB, problemId: PROBLEM, answers: { metric: "score" } });
  assert.equal(resumed.order.includes("stage"), false);
  assert.equal(resumed.order.includes("publish"), true);
});

test("preparation worker rejects ineligible problem statuses before staging", async (t) => {
  for (const status of ["draft", "rejected", "archived", "solved", "publishing", "published"]) {
    const context = await fixture(t, { status });
    const deps = dependencies(context);
    const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...deps });
    await assert.rejects(() => worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), new RegExp(status));
    assert.equal(deps.order.includes("stage"), false);
  }
});

test("preparation worker also permits an accepted problem with an executable gate", async (t) => {
  const context = await fixture(t, { status: "accepted" });
  const deps = dependencies(context, { expectedProblemStatus: "accepted" });
  const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...deps });
  assert.deepEqual(await worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), { state: "ready", infrastructureId: "INF-001" });
});

test("preparation failures transition the job without publishing, while stale index becomes ready with a bounded diagnostic", async (t) => {
  const failed = await fixture(t);
  const failureDeps = dependencies(failed, { preflight: { status: "failed" } });
  const failedWorker = createPreparationWorker({ rootDir: failed.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...failureDeps });
  await assert.rejects(() => failedWorker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), /preflight/i);
  assert.equal(failureDeps.order.includes("publish"), false);
  assert.equal(failureDeps.order.at(-1), "failed");

  const stale = await fixture(t);
  const staleDeps = dependencies(stale, { publish: { status: "published-index-stale", id: "INF-001", error: "index unavailable" } });
  const staleWorker = createPreparationWorker({ rootDir: stale.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...staleDeps });
  assert.deepEqual(await staleWorker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), { state: "ready", infrastructureId: "INF-001" });
  assert.deepEqual(staleDeps.order.slice(-3), ["publish", "event:ready-index-stale", "ready"]);
});

test("an aborted preparation transitions to interrupted instead of failed", async (t) => {
  const context = await fixture(t);
  const deps = dependencies(context);
  const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...deps });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" }, signal: controller.signal }),
    /abort/i,
  );
  assert.equal(context.jobs.get(JOB).state, "interrupted");
  assert.equal(deps.order.includes("codex"), false);
});

test("an abort after the preflight report prevents publication and readiness", async (t) => {
  const context = await fixture(t);
  const controller = new AbortController();
  const deps = dependencies(context, { reportMutation: () => controller.abort() });
  const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...deps });

  await assert.rejects(
    () => worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" }, signal: controller.signal }),
    /abort/i,
  );
  assert.equal(deps.order.includes("publish"), false);
  assert.equal(context.jobs.get(JOB).state, "interrupted");
});

test("Codex, manifest, collision, and publication failures leave no revision or attempt artifacts", async (t) => {
  const cases = [
    ["Codex preflight", { codexError: new Error("Codex preparation preflight failed") }, /Codex preparation preflight failed/],
    ["invalid output", { envelope: { outcome: "unexpected" } }, /Invalid preparation contract/],
    ["invalid manifest", { manifestValue: { id: "INF-001" } }, /Invalid preparation contract/],
    ["revision collision", { list: (() => { let calls = 0; return () => (++calls === 1 ? [] : ["INF-001"]); })() }, /collision/],
    ["publication copy", { publishError: new Error("copy failed") }, /copy failed/],
  ];
  for (const [name, options, expected] of cases) {
    const context = await fixture(t);
    const deps = dependencies(context, options);
    const worker = createPreparationWorker({ rootDir: context.rootDir, privateDataRoot: "/private-data", rebuildIndex: async () => {}, ...deps });
    await assert.rejects(() => worker({ jobId: JOB, problemId: PROBLEM, answers: { metric: "score" } }), expected, name);
    assert.equal(deps.order.at(-1), "failed", name);
    assert.equal((await readFile(join(context.rootDir, "problems", PROBLEM, "problem.json"), "utf8")).includes("Fixture"), true, name);
    await assert.rejects(() => readFile(join(context.rootDir, "problems", PROBLEM, "attempts")), /ENOENT/, name);
    await assert.rejects(() => readFile(join(context.rootDir, "problems", PROBLEM, "batches")), /ENOENT/, name);
  }
});

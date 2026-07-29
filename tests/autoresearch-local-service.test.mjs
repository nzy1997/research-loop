import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createJobStore } from "../lib/autoresearch/job-store.mjs";
import { startLocalAutoresearchService } from "../lib/autoresearch/local-service.mjs";
import { startService } from "../scripts/local-autoresearch-service.mjs";

const TOKEN = "test-capability-token";
const JOB = "ARJ-20260728T080000Z-deadbeef";
const PROBLEM = "Prob-007";

function job(overrides = {}) {
  return { jobId: JOB, problemId: PROBLEM, kind: "preparation", state: "queued", createdAt: "2026-07-28T08:00:00.000Z", updatedAt: "2026-07-28T08:00:00.000Z", ...overrides };
}

function fixtures({ initial = job() } = {}) {
  const jobs = new Map([[initial.jobId, initial]]);
  const calls = { create: [], enqueue: [], resume: [] };
  return {
    calls,
    jobStore: {
      async create(value) { calls.create.push(value); const created = job({ jobId: "ARJ-20260728T080001Z-cafebabe", ...value }); jobs.set(created.jobId, created); return created; },
      async read(id) { const value = jobs.get(id); if (!value) { const error = new Error("missing"); error.code = "ENOENT"; throw error; } return value; },
      async list() { return [...jobs.values()]; },
    },
    scheduler: {
      enqueue(value) { calls.enqueue.push(value); return value; },
      resumeAfterInput(value) { calls.resume.push(value); return value; },
    },
  };
}

async function service(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "autoresearch-local-service-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const deps = fixtures(options);
  const running = await startLocalAutoresearchService({ rootDir, token: TOKEN, scheduler: deps.scheduler, jobStore: deps.jobStore });
  t.after(() => running.close());
  return { ...running, ...deps, rootDir };
}

function request(origin, path, options = {}) {
  return fetch(`${origin}${path}`, { ...options, headers: { "x-research-loop-capability": TOKEN, ...options.headers } });
}

test("rejects non-loopback host input", async () => {
  await assert.rejects(
    () => startLocalAutoresearchService({ host: "0.0.0.0", token: TOKEN, scheduler: {}, jobStore: {} }),
    /loopback/i,
  );
});

test("requires the local capability and returns no-store JSON errors", async (t) => {
  const { origin } = await service(t);
  for (const token of [undefined, "wrong"]) {
    const response = await fetch(`${origin}/__local/autoresearch/problems/${PROBLEM}`, { headers: token ? { "x-research-loop-capability": token } : {} });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: { code: "INVALID_REQUEST", message: "Local capability is required." } });
  }
});

test("validates routes, methods, body size, JSON, and identifiers before scheduling", async (t) => {
  const { origin, calls } = await service(t);
  let response = await request(origin, "/__local/autoresearch/nope");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "INVALID_REQUEST", message: "Route not found." } });
  response = await request(origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "GET" });
  assert.equal(response.status, 405);
  response = await request(origin, "/__local/autoresearch/problems/nope/prepare", { method: "POST", body: "{}" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "INVALID_REQUEST", message: "problemId must match Prob-###." } });
  response = await request(origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{" });
  assert.equal(response.status, 400);
  response = await request(origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: JSON.stringify({ padding: "x".repeat(17 * 1024) }) });
  assert.equal(response.status, 413);
  response = await request(origin, "/__local/autoresearch/jobs/not-a-job/input", { method: "POST", body: "{}" });
  assert.equal(response.status, 400);
  response = await request(origin, `/__local/autoresearch/jobs/${JOB}/input`, { method: "POST", body: JSON.stringify({ answers: { "bad id": "value" } }) });
  assert.equal(response.status, 400);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.enqueue, []);
});

test("deduplicates prepare jobs and returns a bounded public status", async (t) => {
  const { origin, calls } = await service(t, { initial: job({ state: "failed" }) });
  const first = await request(origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" });
  assert.equal(first.status, 202);
  const firstJob = await first.json();
  assert.equal(firstJob.jobId, "ARJ-20260728T080001Z-cafebabe");
  const duplicate = await request(origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" });
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).jobId, firstJob.jobId);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.enqueue.length, 1);
  const status = await request(origin, `/__local/autoresearch/problems/${PROBLEM}`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { jobId: firstJob.jobId, problemId: PROBLEM, state: "queued" });
});

test("prepare reuses the latest persisted nonterminal job before creating a reservation", async (t) => {
  const { origin, calls } = await service(t, { initial: job({ state: "needs_input" }) });

  const response = await request(origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" });

  assert.equal(response.status, 202);
  assert.equal((await response.json()).jobId, JOB);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.enqueue.length, 0);
});

test("concurrent prepare requests reserve one job before asynchronous creation", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "autoresearch-local-service-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const calls = [];
  const created = job({ jobId: "ARJ-20260728T080001Z-cafebabe" });
  const jobStore = {
    async create(value) { calls.push(value); await delay(15); return created; },
    async read() { return created; },
    async list() { return calls.length === 0 ? [] : [created]; },
  };
  const scheduler = { enqueue(value) { return value; }, resumeAfterInput() {} };
  const running = await startLocalAutoresearchService({ rootDir, token: TOKEN, scheduler, jobStore });
  t.after(() => running.close());
  const responses = await Promise.all([
    request(running.origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" }),
    request(running.origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await Promise.all(responses.map((response) => response.json())), [
    { jobId: created.jobId, problemId: PROBLEM, state: "queued" },
    { jobId: created.jobId, problemId: PROBLEM, state: "queued" },
  ]);
});

test("concurrent and repeated input submissions reuse one persisted child job", async (t) => {
  const { origin, calls } = await service(t, { initial: job({ state: "needs_input" }) });
  const submit = () => request(origin, `/__local/autoresearch/jobs/${JOB}/input`, {
    method: "POST",
    body: JSON.stringify({ answers: { metric: "score" } }),
  });

  const responses = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map((response) => response.status), [202, 202]);
  const payloads = await Promise.all(responses.map((response) => response.json()));
  assert.equal(payloads[0].jobId, "ARJ-20260728T080001Z-cafebabe");
  assert.equal(payloads[1].jobId, payloads[0].jobId);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.resume.length, 1);

  const repeated = await submit();
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json()).jobId, payloads[0].jobId);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.resume.length, 1);
});

test("a restarted service resumes the latest persisted needs-input job", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "autoresearch-restart-"));
  const privateDataRoot = join(rootDir, "private");
  await mkdir(privateDataRoot);
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createJobStore({ rootDir });
  const parent = await store.create({ problemId: PROBLEM, kind: "preparation" });
  for (const state of ["scaffolding", "building_benchmark", "preparing_datasets", "needs_input"]) await store.transition(parent.jobId, state);

  const running = await startService({ rootDir, privateDataRoot, token: TOKEN });
  t.after(() => running.close());
  const response = await request(running.origin, `/__local/autoresearch/jobs/${parent.jobId}/input`, {
    method: "POST",
    body: JSON.stringify({ answers: { metric: "score" } }),
  });

  assert.equal(response.status, 202);
  const children = (await store.list()).filter((item) => item.parentJobId === parent.jobId);
  assert.equal(children.length, 1);
});

test("releases a reservation when its latest persisted job state is terminal", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "autoresearch-local-service-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const jobs = new Map();
  const calls = { create: 0, enqueue: 0 };
  const jobStore = {
    async create(value) {
      calls.create += 1;
      const created = job({ ...value, jobId: calls.create === 1 ? "ARJ-20260728T080001Z-cafebabe" : "ARJ-20260728T080002Z-01234567" });
      jobs.set(created.jobId, created);
      return { ...created };
    },
    async read(jobId) { return { ...jobs.get(jobId) }; },
    async list() { return [...jobs.values()].map((item) => ({ ...item })); },
  };
  const scheduler = { enqueue(value) { calls.enqueue += 1; return value; }, resumeAfterInput() {} };
  const running = await startLocalAutoresearchService({ rootDir, token: TOKEN, scheduler, jobStore });
  t.after(() => running.close());
  const first = await request(running.origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" });
  assert.equal((await first.json()).jobId, "ARJ-20260728T080001Z-cafebabe");
  jobs.get("ARJ-20260728T080001Z-cafebabe").state = "failed";
  const second = await request(running.origin, `/__local/autoresearch/problems/${PROBLEM}/prepare`, { method: "POST", body: "{}" });
  assert.equal((await second.json()).jobId, "ARJ-20260728T080002Z-01234567");
  assert.deepEqual(calls, { create: 2, enqueue: 2 });
});

test("exposes only the active bounded question and downloads event logs as text", async (t) => {
  const { origin, rootDir } = await service(t, { initial: job({ state: "needs_input", secret: TOKEN, path: "/private/path", stderr: "nope" }) });
  await mkdir(join(rootDir, "jobs", JOB), { recursive: true });
  await writeFile(join(rootDir, "jobs", JOB, "events.jsonl"), `${JSON.stringify({ code: "needs-input", question: { id: "metric", prompt: "Choose a metric", answerType: "choice", choices: ["score", "loss"] } })}\n${JSON.stringify({ stderr: "secret", token: TOKEN })}\n`);
  const response = await request(origin, `/__local/autoresearch/jobs/${JOB}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { jobId: JOB, problemId: PROBLEM, state: "needs_input", question: { id: "metric", prompt: "Choose a metric", answerType: "choice", choices: ["score", "loss"] } });
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
  assert.equal("events" in body, false);
  const log = await request(origin, `/__local/autoresearch/logs/${PROBLEM}/${JOB}`);
  assert.equal(log.status, 200);
  assert.equal(log.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(log.headers.get("content-disposition"), /attachment/);
  assert.match(await log.text(), /needs-input/);
});

test("omits malformed or unbounded persisted questions from public status", async (t) => {
  const { origin, rootDir } = await service(t, { initial: job({ state: "needs_input" }) });
  await mkdir(join(rootDir, "jobs", JOB), { recursive: true });
  await writeFile(join(rootDir, "jobs", JOB, "events.jsonl"), `${JSON.stringify({ code: "needs-input", question: { id: "metric", prompt: "x".repeat(10_000), answerType: "arbitrary", choices: Array.from({ length: 100 }, () => "choice") } })}\n`);
  const response = await request(origin, `/__local/autoresearch/jobs/${JOB}`);
  assert.deepEqual(await response.json(), { jobId: JOB, problemId: PROBLEM, state: "needs_input" });
});

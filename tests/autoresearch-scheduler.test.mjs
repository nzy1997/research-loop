import assert from "node:assert/strict";
import test from "node:test";

import { createScheduler } from "../lib/autoresearch/scheduler.mjs";
import * as serviceScript from "../scripts/local-autoresearch-service.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function turns() {
  await Promise.resolve();
  await Promise.resolve();
}

test("runs two distinct problems concurrently and starts the third FIFO", async () => {
  const blockers = new Map();
  const started = [];
  const scheduler = createScheduler({ concurrency: 2, runJob: async (job) => {
    started.push(job.jobId);
    const blocker = deferred();
    blockers.set(job.jobId, blocker);
    return blocker.promise;
  } });
  scheduler.enqueue({ jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" });
  scheduler.enqueue({ jobId: "two", problemId: "Prob-002", kind: "preparation", state: "queued" });
  scheduler.enqueue({ jobId: "three", problemId: "Prob-003", kind: "preparation", state: "queued" });
  await turns();
  assert.deepEqual(started, ["one", "two"]);
  assert.deepEqual(scheduler.snapshot(), {
    concurrency: 2,
    active: [
      { jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" },
      { jobId: "two", problemId: "Prob-002", kind: "preparation", state: "queued" },
    ],
    queued: [{ jobId: "three", problemId: "Prob-003", position: 1 }],
  });
  blockers.get("one").resolve({ state: "ready" });
  await turns();
  assert.deepEqual(started, ["one", "two", "three"]);
  blockers.get("two").resolve({ state: "ready" });
  blockers.get("three").resolve({ state: "ready" });
  await scheduler.shutdown();
});

test("deduplicates a problem to its reserved active job", async () => {
  const blocker = deferred();
  const scheduler = createScheduler({ concurrency: 2, runJob: async () => blocker.promise });
  const first = scheduler.enqueue({ jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" });
  const duplicate = scheduler.enqueue({ jobId: "two", problemId: "Prob-001", kind: "preparation", state: "queued" });
  await turns();
  assert.equal(first.jobId, "one");
  assert.equal(duplicate.jobId, "one");
  blocker.resolve({ state: "ready" });
  await scheduler.shutdown();
});

test("needs input releases its slot but keeps the problem reservation", async () => {
  const started = [];
  const first = deferred();
  const scheduler = createScheduler({ concurrency: 2, runJob: async (job) => {
    started.push(job.jobId);
    return job.jobId === "one" ? first.promise : { state: "ready" };
  } });
  scheduler.enqueue({ jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" });
  scheduler.enqueue({ jobId: "two", problemId: "Prob-002", kind: "preparation", state: "queued" });
  scheduler.enqueue({ jobId: "three", problemId: "Prob-003", kind: "preparation", state: "queued" });
  await turns();
  first.resolve({ state: "needs_input" });
  await turns();
  assert.deepEqual(started, ["one", "two", "three"]);
  assert.equal(scheduler.enqueue({ jobId: "again", problemId: "Prob-001", kind: "preparation", state: "queued" }).jobId, "one");
  await scheduler.shutdown();
});

test("restores a persisted needs-input reservation without rerunning its parent", async () => {
  const started = [];
  const scheduler = createScheduler({ concurrency: 1, runJob: async (job) => {
    started.push(job.jobId);
    return { state: "ready" };
  } });
  const parent = { jobId: "one", problemId: "Prob-001", kind: "preparation", state: "needs_input" };

  assert.deepEqual(scheduler.restoreSuspended(parent), parent);
  assert.equal(scheduler.enqueue({ jobId: "duplicate", problemId: "Prob-001", kind: "preparation", state: "queued" }).jobId, "one");
  const child = scheduler.resumeAfterInput({ jobId: "one-child", problemId: "Prob-001", kind: "preparation", state: "queued", parentJobId: "one" });
  await turns();

  assert.equal(child.jobId, "one-child");
  assert.deepEqual(started, ["one-child"]);
  await scheduler.shutdown();
});

test("restores only the latest persisted needs-input job for each problem", async () => {
  const scheduler = createScheduler({ concurrency: 1, runJob: async () => ({ state: "ready" }) });
  const jobs = [
    { jobId: "old-parent", problemId: "Prob-001", kind: "preparation", state: "needs_input" },
    { jobId: "completed-child", problemId: "Prob-001", kind: "preparation", state: "ready", parentJobId: "old-parent" },
    { jobId: "current-parent", problemId: "Prob-002", kind: "preparation", state: "needs_input" },
  ];

  assert.deepEqual(await serviceScript.restoreLatestSuspendedJobs({ jobStore: { async list() { return jobs; } }, scheduler }), ["current-parent"]);
  assert.equal(scheduler.enqueue({ jobId: "duplicate", problemId: "Prob-002", kind: "preparation", state: "queued" }).jobId, "current-parent");
  assert.equal(scheduler.enqueue({ jobId: "new", problemId: "Prob-001", kind: "preparation", state: "queued" }).jobId, "new");
  await scheduler.shutdown();
});

test("restores a persisted queued input child with its answers", async () => {
  const started = [];
  const scheduler = createScheduler({ concurrency: 1, runJob: async (job) => {
    started.push(job);
    return { state: "ready" };
  } });
  const parent = { jobId: "parent", problemId: "Prob-001", kind: "preparation", state: "needs_input" };
  const child = {
    jobId: "child", problemId: "Prob-001", kind: "preparation", state: "queued",
    parentJobId: "parent", answers: { metric: "score" },
  };

  assert.deepEqual(
    await serviceScript.restoreLatestSuspendedJobs({
      jobStore: { async list() { return [parent, child]; }, async read() { return parent; } },
      scheduler,
    }),
    ["child"],
  );
  await turns();

  assert.deepEqual(started, [child]);
  await scheduler.shutdown();
});

test("queues a resumed child behind existing work", async () => {
  const started = [];
  const first = deferred();
  const second = deferred();
  const scheduler = createScheduler({ concurrency: 1, runJob: async (job) => {
    started.push(job.jobId);
    if (job.jobId === "one") return first.promise;
    if (job.jobId === "two") return second.promise;
    return { state: "ready" };
  } });
  scheduler.enqueue({ jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" });
  scheduler.enqueue({ jobId: "two", problemId: "Prob-002", kind: "preparation", state: "queued" });
  await turns();
  first.resolve({ state: "needs_input" });
  await turns();
  const child = scheduler.resumeAfterInput({ jobId: "one-child", problemId: "Prob-001", kind: "preparation", state: "queued", parentJobId: "one" });
  assert.equal(child.jobId, "one-child");
  second.resolve({ state: "ready" });
  await turns();
  assert.deepEqual(started, ["one", "two", "one-child"]);
  await scheduler.shutdown();
});

test("shutdown prevents new starts and waits for worker termination", async () => {
  const worker = deferred();
  const terminated = deferred();
  let starts = 0;
  const scheduler = createScheduler({ concurrency: 1, runJob: () => {
    starts += 1;
    return { promise: worker.promise, terminate: () => terminated.promise };
  } });
  scheduler.enqueue({ jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" });
  scheduler.enqueue({ jobId: "two", problemId: "Prob-002", kind: "preparation", state: "queued" });
  await turns();
  const stopped = scheduler.shutdown();
  worker.resolve({ state: "ready" });
  await turns();
  assert.equal(starts, 1);
  let finished = false;
  void stopped.then(() => { finished = true; });
  await turns();
  assert.equal(finished, false);
  terminated.resolve();
  await stopped;
});

test("the service runner aborts active preparation work during scheduler shutdown", async () => {
  let observedSignal;
  const runJob = serviceScript.createCancelablePreparationRunner(async ({ signal }) => {
    observedSignal = signal;
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ state: "interrupted" }), { once: true }));
  });
  const scheduler = createScheduler({ concurrency: 1, runJob });
  scheduler.enqueue({ jobId: "one", problemId: "Prob-001", kind: "preparation", state: "queued" });
  await turns();

  await scheduler.shutdown();

  assert.equal(observedSignal.aborted, true);
});

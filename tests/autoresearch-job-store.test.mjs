import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PREPARATION_STATES, createJobStore } from "../lib/autoresearch/job-store.mjs";

const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "autoresearch-jobs-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let sequence = 0;
  return {
    rootDir,
    store: createJobStore({
      rootDir,
      now: () => FIXED_NOW,
      randomBytes: (length) => Buffer.alloc(length, ++sequence),
    }),
  };
}

test("creates an immutable queued job and only accepts forward preparation transitions", async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(PREPARATION_STATES, ["queued", "scaffolding", "building_benchmark", "preparing_datasets", "preflight", "needs_input", "ready", "failed", "interrupted"]);
  const created = await store.create({ problemId: "Prob-007", kind: "preparation" });
  assert.match(created.jobId, /^ARJ-20260728T120000Z-01010101$/);
  assert.equal(created.state, "queued");
  assert.equal(created.problemId, "Prob-007");
  assert.equal(created.kind, "preparation");
  assert.equal(created.createdAt, FIXED_NOW.toISOString());

  for (const state of ["scaffolding", "building_benchmark", "preparing_datasets", "preflight", "ready"]) {
    await store.transition(created.jobId, state);
  }
  assert.equal((await store.read(created.jobId)).state, "ready");
  await assert.rejects(() => store.transition(created.jobId, "preflight"), /terminal|transition/i);
  await assert.rejects(() => store.transition(created.jobId, "queued"), /terminal|transition/i);
});

test("rejects skipped and backward states while retaining immutable lineage", async (t) => {
  const { store } = await fixture(t);
  const parent = await store.create({ problemId: "Prob-007", kind: "preparation" });
  const child = await store.create({ problemId: "Prob-007", kind: "preparation", parentJobId: parent.jobId });
  await assert.rejects(() => store.transition(child.jobId, "preflight"), /transition/i);
  await store.transition(child.jobId, "scaffolding");
  await assert.rejects(() => store.transition(child.jobId, "queued"), /transition/i);
  assert.deepEqual(await store.read(child.jobId), {
    jobId: child.jobId, problemId: "Prob-007", kind: "preparation", parentJobId: parent.jobId,
    state: "scaffolding", createdAt: FIXED_NOW.toISOString(), updatedAt: FIXED_NOW.toISOString(),
  });
});

test("allows preparation to pause for input before preflight", async (t) => {
  const { store } = await fixture(t);
  const job = await store.create({ problemId: "Prob-007", kind: "preparation" });

  for (const state of ["scaffolding", "building_benchmark", "preparing_datasets", "needs_input"]) {
    await store.transition(job.jobId, state);
  }

  assert.equal((await store.read(job.jobId)).state, "needs_input");
  await assert.rejects(() => store.transition(job.jobId, "preflight"), /transition/i);
});

test("persists complete job snapshots atomically and monotonically numbered events", async (t) => {
  const { rootDir, store } = await fixture(t);
  const job = await store.create({ problemId: "Prob-007", kind: "preparation" });
  const jobDir = join(rootDir, "jobs", job.jobId);
  await writeFile(join(jobDir, "job.json"), `${JSON.stringify(job)}\n`);
  await store.transition(job.jobId, "scaffolding");
  assert.deepEqual(JSON.parse(await readFile(join(jobDir, "job.json"), "utf8")), await store.read(job.jobId));
  await store.appendEvent(job.jobId, { type: "started" });
  await store.appendEvent(job.jobId, { type: "progress", detail: "public" });
  const events = (await readFile(join(jobDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.map((event) => event.type), ["started", "progress"]);
  assert.ok(events.every((event) => event.at === FIXED_NOW.toISOString()));
});

test("serializes concurrent event appends and consecutive state transitions for one job", async (t) => {
  const { rootDir, store } = await fixture(t);
  const job = await store.create({ problemId: "Prob-007", kind: "preparation" });
  await Promise.all([
    store.appendEvent(job.jobId, { type: "first" }),
    store.appendEvent(job.jobId, { type: "second" }),
    store.appendEvent(job.jobId, { type: "third" }),
  ]);
  const events = (await readFile(join(rootDir, "jobs", job.jobId, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  await Promise.all([
    store.transition(job.jobId, "scaffolding"),
    store.transition(job.jobId, "building_benchmark"),
  ]);
  assert.equal((await store.read(job.jobId)).state, "building_benchmark");
});

test("recovers executing jobs as interrupted but preserves suspended and terminal jobs", async (t) => {
  const { store } = await fixture(t);
  const scaffolding = await store.create({ problemId: "Prob-001", kind: "preparation" });
  const waiting = await store.create({ problemId: "Prob-002", kind: "preparation" });
  const finished = await store.create({ problemId: "Prob-003", kind: "preparation" });
  await store.transition(scaffolding.jobId, "scaffolding");
  await store.transition(waiting.jobId, "scaffolding");
  await store.transition(waiting.jobId, "building_benchmark");
  await store.transition(waiting.jobId, "preparing_datasets");
  await store.transition(waiting.jobId, "preflight");
  await store.transition(waiting.jobId, "needs_input");
  await store.transition(finished.jobId, "failed");

  const recovered = await store.recoverInterrupted();
  assert.deepEqual(recovered, [scaffolding.jobId]);
  assert.equal((await store.read(scaffolding.jobId)).state, "interrupted");
  assert.equal((await store.read(waiting.jobId)).state, "needs_input");
  assert.equal((await store.read(finished.jobId)).state, "failed");
  assert.deepEqual((await store.list()).map((job) => job.jobId), [scaffolding.jobId, waiting.jobId, finished.jobId]);
});

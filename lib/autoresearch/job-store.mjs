import { randomBytes as systemRandomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { JOB_ID_PATTERN, isProblemId } from "./ids.mjs";

export const PREPARATION_STATES = Object.freeze(["queued", "scaffolding", "building_benchmark", "preparing_datasets", "preflight", "needs_input", "ready", "failed", "interrupted"]);

const EXECUTING_STATES = new Set(["scaffolding", "building_benchmark", "preparing_datasets", "preflight"]);
const TERMINAL_STATES = new Set(["ready", "failed", "interrupted"]);
const ANSWER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const FORWARD = new Map([
  ["queued", new Set(["scaffolding", "failed", "interrupted"])],
  ["scaffolding", new Set(["building_benchmark", "failed", "interrupted"])],
  ["building_benchmark", new Set(["preparing_datasets", "failed", "interrupted"])],
  ["preparing_datasets", new Set(["preflight", "needs_input", "failed", "interrupted"])],
  ["preflight", new Set(["needs_input", "ready", "failed", "interrupted"])],
  ["needs_input", new Set(["failed", "interrupted"])],
]);

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("now must produce a valid date");
  return date.toISOString();
}

function idFor(now, randomBytes) {
  const date = new Date(timestamp(now));
  const compact = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `ARJ-${compact}-${Buffer.from(randomBytes(4)).toString("hex")}`;
}

function assertJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw new TypeError("Invalid preparation job ID");
}

function assertState(state) {
  if (!PREPARATION_STATES.includes(state)) throw new TypeError("Invalid preparation state");
}

function assertAnswers(answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new TypeError("Invalid preparation answers");
  for (const [id, value] of Object.entries(answers)) {
    if (!ANSWER_ID.test(id)) throw new TypeError("Invalid preparation answer ID");
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "string" && value.length > 4096) || (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Invalid preparation answer value");
    }
  }
}

function jobsRoot(rootDir) {
  if (typeof rootDir !== "string" || rootDir.length === 0) throw new TypeError("rootDir is required");
  return join(rootDir, "jobs");
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createJobStore({ rootDir = process.cwd(), now = () => new Date(), randomBytes = systemRandomBytes } = {}) {
  if (typeof now !== "function" || typeof randomBytes !== "function") throw new TypeError("now and randomBytes must be functions");
  const root = jobsRoot(rootDir);
  const jobTails = new Map();
  const fileFor = (jobId) => join(root, jobId, "job.json");
  const eventFileFor = (jobId) => join(root, jobId, "events.jsonl");

  function serialize(jobId, operation) {
    const prior = jobTails.get(jobId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    const tail = next.catch(() => undefined);
    jobTails.set(jobId, tail);
    tail.finally(() => { if (jobTails.get(jobId) === tail) jobTails.delete(jobId); });
    return next;
  }

  async function read(jobId) {
    assertJobId(jobId);
    let value;
    try { value = JSON.parse(await readFile(fileFor(jobId), "utf8")); } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid job record: ${jobId}`);
      throw error;
    }
    assertJobId(value.jobId);
    if (value.jobId !== jobId || !isProblemId(value.problemId) || typeof value.kind !== "string" || !value.kind) throw new Error(`Invalid job record: ${jobId}`);
    if (value.parentJobId !== undefined && value.parentJobId !== null) assertJobId(value.parentJobId);
    if (value.answers !== undefined) assertAnswers(value.answers);
    assertState(value.state);
    return value;
  }

  async function create({ problemId, kind, parentJobId = null, answers } = {}) {
    if (!isProblemId(problemId)) throw new TypeError("Invalid problem ID");
    if (typeof kind !== "string" || !kind) throw new TypeError("kind is required");
    if (parentJobId !== null) {
      assertJobId(parentJobId);
      const parent = await read(parentJobId);
      if (parent.problemId !== problemId) throw new RangeError("Child job must retain its parent's problem ID");
    }
    if (answers !== undefined) {
      if (parentJobId === null) throw new TypeError("Only child jobs may persist preparation answers");
      assertAnswers(answers);
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const jobId = idFor(now, randomBytes);
      const directory = join(root, jobId);
      const createdAt = timestamp(now);
      const job = { jobId, problemId, kind, parentJobId, ...(answers === undefined ? {} : { answers: { ...answers } }), state: "queued", createdAt, updatedAt: createdAt };
      try {
        await mkdir(directory, { recursive: false, mode: 0o700 });
        try {
          await writeFile(fileFor(jobId), `${JSON.stringify(job)}\n`, { flag: "wx", mode: 0o600 });
          await writeFile(eventFileFor(jobId), "", { flag: "wx", mode: 0o600 });
          return job;
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    throw new Error("Unable to allocate unique preparation job ID");
  }

  async function transition(jobId, state) {
    assertState(state);
    return serialize(jobId, async () => {
      const current = await read(jobId);
      if (TERMINAL_STATES.has(current.state) || !FORWARD.get(current.state)?.has(state)) throw new RangeError(`Invalid preparation transition: ${current.state} -> ${state}`);
      const next = { ...current, state, updatedAt: timestamp(now) };
      await atomicJson(fileFor(jobId), next);
      return next;
    });
  }

  async function appendEvent(jobId, event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
    return serialize(jobId, async () => {
      await read(jobId);
      const path = eventFileFor(jobId);
      const existing = await readFile(path, "utf8");
      const prior = existing.trim() ? existing.trim().split("\n").length : 0;
      const entry = { ...event, sequence: prior + 1, at: timestamp(now) };
      await writeFile(path, `${JSON.stringify(entry)}\n`, { flag: "a", mode: 0o600 });
      return entry;
    });
  }

  async function list() {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const jobs = [];
    for (const entry of entries) if (entry.isDirectory() && JOB_ID_PATTERN.test(entry.name)) jobs.push(await read(entry.name));
    return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId));
  }

  async function recoverInterrupted() {
    const recovered = [];
    for (const job of await list()) await serialize(job.jobId, async () => {
      const current = await read(job.jobId);
      if (!EXECUTING_STATES.has(current.state)) return;
      const next = { ...current, state: "interrupted", updatedAt: timestamp(now) };
      await atomicJson(fileFor(job.jobId), next);
      recovered.push(job.jobId);
    });
    return recovered;
  }

  return Object.freeze({ create, read, transition, appendEvent, list, recoverInterrupted });
}

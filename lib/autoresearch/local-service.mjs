import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readLatestReadyInfrastructure } from "./artifact-store.mjs";
import { JOB_ID_PATTERN, isProblemId } from "./ids.mjs";

const BODY_LIMIT = 16 * 1024;
const CAPABILITY_HEADER = "x-research-loop-capability";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ANSWER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const QUESTION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_QUESTION_PROMPT_LENGTH = 2_000;
const MAX_QUESTION_CHOICE_LENGTH = 200;
const TERMINAL = new Set(["ready", "failed", "interrupted"]);

function isLoopback(host) {
  return typeof host === "string" && LOOPBACK_HOSTS.has(host);
}

function error(response, status, message) {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message } }));
}

function json(response, status, value) {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const parts = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > BODY_LIMIT) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    parts.push(part);
  }
  if (bytes === 0) return {};
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

function validateAnswers(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || (body.answers !== undefined && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)))) {
    throw new Error("answers must be an object.");
  }
  const answers = body.answers ?? {};
  for (const [id, value] of Object.entries(answers)) {
    if (!ANSWER_ID.test(id)) throw new Error("answerId must use lowercase letters, numbers, hyphens, or underscores.");
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "string" && value.length > 4096)) throw new Error("answer values must be short strings, numbers, or booleans.");
  }
  return answers;
}

function publicQuestion(event) {
  const question = event?.code === "needs-input" ? event.question : null;
  if (!question || typeof question !== "object" || Array.isArray(question)) return null;
  const { id, prompt, answerType, choices } = question;
  if (!QUESTION_ID.test(id) || typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_QUESTION_PROMPT_LENGTH) return null;
  if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string" || choice.length === 0 || choice.length > MAX_QUESTION_CHOICE_LENGTH)) return null;
  if (answerType === "text" && choices.length === 0) return { id, prompt, answerType, choices: [] };
  if (answerType === "choice" && choices.length >= 2 && choices.length <= 8 && new Set(choices).size === choices.length) return { id, prompt, answerType, choices };
  return null;
}

async function eventsFor(rootDir, jobId) {
  try {
    const text = await readFile(join(rootDir, "jobs", jobId, "events.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function publicStatus({ rootDir, jobStore, job }) {
  job = await jobStore.read(job.jobId);
  const status = { jobId: job.jobId, problemId: job.problemId, state: job.state };
  const events = await eventsFor(rootDir, job.jobId);
  if (job.state === "needs_input") {
    const question = [...events].reverse().map(publicQuestion).find(Boolean);
    if (question) status.question = question;
  }
  if (job.state === "ready") {
    const infrastructure = await readLatestReadyInfrastructure({ rootDir, problemId: job.problemId });
    if (infrastructure) status.infrastructureId = infrastructure.id;
  }
  if (events.some((event) => event?.code === "ready-index-stale")) status.diagnostic = "ready-index-stale";
  return status;
}

function route(pathname) {
  let match;
  if (pathname === "/health") return { name: "health" };
  if ((match = /^\/__local\/autoresearch\/problems\/([^/]+)\/prepare$/.exec(pathname))) return { name: "prepare", problemId: match[1] };
  if ((match = /^\/__local\/autoresearch\/problems\/([^/]+)$/.exec(pathname))) return { name: "problem", problemId: match[1] };
  if ((match = /^\/__local\/autoresearch\/jobs\/([^/]+)\/input$/.exec(pathname))) return { name: "input", jobId: match[1] };
  if ((match = /^\/__local\/autoresearch\/jobs\/([^/]+)$/.exec(pathname))) return { name: "job", jobId: match[1] };
  if ((match = /^\/__local\/autoresearch\/logs\/([^/]+)\/([^/]+)$/.exec(pathname))) return { name: "log", problemId: match[1], jobId: match[2] };
  return null;
}

export async function startLocalAutoresearchService({ rootDir = process.cwd(), host = "127.0.0.1", port = 0, token, scheduler, jobStore } = {}) {
  if (!isLoopback(host)) throw new TypeError("Local autoresearch service host must be loopback.");
  if (typeof token !== "string" || token.length < 1) throw new TypeError("token is required");
  for (const name of ["enqueue", "resumeAfterInput"]) if (typeof scheduler?.[name] !== "function") throw new TypeError(`scheduler.${name} is required`);
  for (const name of ["create", "read", "list"]) if (typeof jobStore?.[name] !== "function") throw new TypeError(`jobStore.${name} is required`);
  const activeByProblem = new Map();
  const inputByParent = new Map();
  const server = createServer(async (request, response) => {
    try {
      const current = route(new URL(request.url, `http://${host}`).pathname);
      if (!current) return error(response, 404, "Route not found.");
      if (current.name === "health") return json(response, 200, { ok: true });
      if (request.headers[CAPABILITY_HEADER] !== token) return error(response, 403, "Local capability is required.");
      const methods = { prepare: "POST", problem: "GET", input: "POST", job: "GET", log: "GET" };
      if (request.method !== methods[current.name]) return error(response, 405, "Method not allowed.");
      if (current.problemId !== undefined && !isProblemId(current.problemId)) return error(response, 400, "problemId must match Prob-###.");
      if (current.jobId !== undefined && !JOB_ID_PATTERN.test(current.jobId)) return error(response, 400, "jobId must match ARJ-YYYYMMDDTHHMMSSZ-xxxxxxxx.");
      if (current.name === "prepare") {
        validateAnswers(await readBody(request));
        while (true) {
          const existing = activeByProblem.get(current.problemId);
          if (existing) {
            const reservedJob = await existing;
            const currentJob = await jobStore.read(reservedJob.jobId);
            if (!TERMINAL.has(currentJob.state)) return json(response, 202, await publicStatus({ rootDir, jobStore, job: currentJob }));
            if (activeByProblem.get(current.problemId) === existing) activeByProblem.delete(current.problemId);
            continue;
          }
          const reservation = (async () => {
            const persisted = (await jobStore.list()).filter((item) => item.problemId === current.problemId).at(-1);
            if (persisted && !TERMINAL.has(persisted.state)) return persisted;
            const created = await jobStore.create({ problemId: current.problemId, kind: "preparation" });
            const accepted = scheduler.enqueue(created);
            return accepted?.jobId === created.jobId ? created : jobStore.read(accepted.jobId);
          })();
          activeByProblem.set(current.problemId, reservation);
          try {
            const selected = await reservation;
            if (TERMINAL.has(selected.state) && activeByProblem.get(current.problemId) === reservation) activeByProblem.delete(current.problemId);
            return json(response, 202, await publicStatus({ rootDir, jobStore, job: selected }));
          } catch (caught) {
            if (activeByProblem.get(current.problemId) === reservation) activeByProblem.delete(current.problemId);
            throw caught;
          }
        }
      }
      if (current.name === "input") {
        const answers = validateAnswers(await readBody(request));
        let reservation = inputByParent.get(current.jobId);
        if (!reservation) {
          reservation = (async () => {
            const parent = await jobStore.read(current.jobId);
            if (parent.state !== "needs_input") {
              const invalid = new Error("job is not waiting for input.");
              invalid.status = 400;
              throw invalid;
            }
            const existingChild = (await jobStore.list()).filter((item) => item.parentJobId === parent.jobId).at(-1);
            if (existingChild) return existingChild;
            const child = await jobStore.create({ problemId: parent.problemId, kind: "preparation", parentJobId: parent.jobId, answers });
            try {
              return scheduler.resumeAfterInput({ ...child, answers });
            } catch (resumeError) {
              try { await jobStore.transition?.(child.jobId, "failed"); } catch { /* preserve the scheduler failure */ }
              throw resumeError;
            }
          })();
          inputByParent.set(current.jobId, reservation);
        }
        let accepted;
        try { accepted = await reservation; } finally {
          if (inputByParent.get(current.jobId) === reservation) inputByParent.delete(current.jobId);
        }
        activeByProblem.set(accepted.problemId, Promise.resolve(accepted));
        return json(response, 202, await publicStatus({ rootDir, jobStore, job: accepted }));
      }
      const job = current.name === "problem"
        ? await activeByProblem.get(current.problemId) ?? (await jobStore.list()).filter((item) => item.problemId === current.problemId).at(-1)
        : await jobStore.read(current.jobId);
      if (!job || (current.problemId && job.problemId !== current.problemId)) return error(response, 404, "Job not found.");
      if (current.name === "log") {
        const text = (await eventsFor(rootDir, job.jobId)).map((event) => JSON.stringify(event)).join("\n");
        response.writeHead(200, { "cache-control": "no-store", "content-disposition": `attachment; filename="${job.jobId}.log"`, "content-type": "text/plain; charset=utf-8" });
        return response.end(text ? `${text}\n` : "");
      }
      return json(response, 200, await publicStatus({ rootDir, jobStore, job }));
    } catch (caught) {
      if (caught?.code === "ENOENT") return error(response, 404, "Job not found.");
      return error(response, caught?.status ?? 400, caught?.message ?? "Invalid request.");
    }
  });
  await new Promise((resolveStart, rejectStart) => { server.once("error", rejectStart); server.listen(port, host, () => { server.off("error", rejectStart); resolveStart(); }); });
  const address = server.address();
  return Object.freeze({ origin: `http://${host}:${address.port}`, token, close: () => new Promise((resolveClose, rejectClose) => server.close((closeError) => closeError ? rejectClose(closeError) : resolveClose())) });
}

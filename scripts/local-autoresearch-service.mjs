import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJobStore } from "../lib/autoresearch/job-store.mjs";
import { runPreparationCodex } from "../lib/autoresearch/codex-preparation.mjs";
import { startLocalAutoresearchService } from "../lib/autoresearch/local-service.mjs";
import { createPreparationWorker } from "../lib/autoresearch/preparation-worker.mjs";
import { createScheduler } from "../lib/autoresearch/scheduler.mjs";

function rebuildIndex(rootDir, outputRootDir = process.cwd()) {
  const resolvedRootDir = resolve(rootDir);
  const resolvedOutputRootDir = resolve(outputRootDir);
  return new Promise((resolveBuild, rejectBuild) => {
    const args = ["scripts/build-problem-index.mjs", "--reserve-id", "Prob-000"];
    if (resolvedRootDir !== resolvedOutputRootDir) {
      args.splice(
        1,
        0,
        "--root",
        resolvedRootDir,
        "--out",
        join(resolvedOutputRootDir, ".generated", "problem-index.json"),
        "--research-out",
        join(resolvedOutputRootDir, ".generated", "research-index.json"),
      );
    }
    const child = spawn(process.execPath, args, { cwd: resolvedOutputRootDir, stdio: "inherit" });
    child.once("error", rejectBuild);
    child.once("exit", (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`Problem index build exited with status ${code}.`)));
  });
}

export async function restoreLatestSuspendedJobs({ jobStore, scheduler }) {
  const latestByProblem = new Map();
  for (const job of await jobStore.list()) latestByProblem.set(job.problemId, job);
  const restored = [];
  for (const job of latestByProblem.values()) {
    if (job.state === "needs_input") scheduler.restoreSuspended(job);
    else if (job.state === "queued" && job.parentJobId) {
      const parent = await jobStore.read(job.parentJobId);
      if (parent.state !== "needs_input" || !job.answers || typeof job.answers !== "object" || Array.isArray(job.answers)) {
        await jobStore.transition?.(job.jobId, "interrupted");
        continue;
      }
      scheduler.restoreSuspended(parent);
      scheduler.resumeAfterInput(job);
    } else if (job.state === "queued") scheduler.enqueue(job);
    else continue;
    restored.push(job.jobId);
  }
  return restored;
}

export function createCancelablePreparationRunner(worker) {
  if (typeof worker !== "function") throw new TypeError("worker is required");
  return (job) => {
    const controller = new AbortController();
    return {
      promise: Promise.resolve().then(() => worker({ ...job, signal: controller.signal })),
      terminate: () => controller.abort(),
    };
  };
}

export async function startService({
  rootDir = process.cwd(), host = "127.0.0.1", port = 0, token = randomBytes(24).toString("base64url"),
  privateDataRoot = process.env.AUTORESEARCH_PRIVATE_ROOT,
  codexPath = process.env.AUTORESEARCH_CODEX_PATH ?? "codex",
  schemaPath = process.env.AUTORESEARCH_SCHEMA_PATH ?? resolve(process.cwd(), "schemas", "autoresearch-preparation-output.schema.json"),
  indexOutputRoot = process.env.AUTORESEARCH_INDEX_OUTPUT_ROOT ?? process.cwd(),
} = {}) {
  if (typeof privateDataRoot !== "string" || privateDataRoot.length === 0) throw new TypeError("AUTORESEARCH_PRIVATE_ROOT is required");
  const resolvedRoot = resolve(rootDir);
  const resolvedSchemaPath = resolve(schemaPath);
  const jobStore = createJobStore({ rootDir: resolvedRoot });
  const worker = createPreparationWorker({
    rootDir: resolvedRoot,
    privateDataRoot,
    codexAdapter: (input) => runPreparationCodex({ ...input, codexPath, schemaPath: resolvedSchemaPath }),
    jobStore,
    rebuildIndex: (root) => rebuildIndex(root, indexOutputRoot),
  });
  const scheduler = createScheduler({ concurrency: 2, runJob: createCancelablePreparationRunner(worker) });
  await jobStore.recoverInterrupted();
  await restoreLatestSuspendedJobs({ jobStore, scheduler });
  const service = await startLocalAutoresearchService({ rootDir: resolvedRoot, host, port, token, scheduler, jobStore });
  return Object.freeze({ ...service, close: async () => { await scheduler.shutdown(); await service.close(); } });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const service = await startService();
  console.log(service.origin);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => service.close().finally(() => process.exit(0)));
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  appendEvent,
  createPreparationStage,
  listInfrastructureRevisions,
  publishInfrastructureRevision,
  readLatestReadyInfrastructure,
  writeAtomicJson,
} from "../lib/autoresearch/artifact-store.mjs";

const JOB_ID = "ARJ-20260728T080000Z-deadbeef";
const PROBLEM_ID = "Prob-007";
const MAX_REVISION_BYTES = 512 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function manifestFor(fileText, id = "INF-001") {
  return {
    schemaVersion: 1, kind: "autoresearch-infrastructure", problemId: PROBLEM_ID, id, status: "ready",
    candidate: { templatePath: "candidate-template/candidate.py", writablePaths: ["candidate.py"] },
    objective: { metricId: "normalized-quality", label: "Normalized quality", direction: "maximize", acceptanceThreshold: 0.7 },
    commands: {
      publicCheck: ["python3", "public/check.py"], containmentCheck: ["python3", "tests/containment.py"],
      evaluateDevelopment: ["python3", "evaluator/development.py"], reproduceBaseline: ["python3", "baselines/run.py"],
    },
    datasets: {
      public: { manifestPath: "datasets/public.json", digest: "a".repeat(64) },
      development: { manifestPath: "datasets/development.json", digest: "b".repeat(64) },
      blind: { manifestPath: "datasets/blind.json", digest: "c".repeat(64) },
    },
    resources: { attemptTimeoutSeconds: 300, terminationGraceSeconds: 5, memoryMb: 4096, network: "denied" },
    files: [{ path: "candidate-template/candidate.py", sha256: digest(fileText), size: Buffer.byteLength(fileText), executable: false }],
    createdAt: "2026-07-28T08:00:00.000Z",
  };
}

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "autoresearch-artifacts-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const stage = await createPreparationStage({ rootDir, jobId: JOB_ID, problemId: PROBLEM_ID });
  return { rootDir, ...stage };
}

async function readyWorkspace(stage, contents = "safe\n") {
  await mkdir(join(stage.workspaceDir, "candidate-template"), { recursive: true });
  await writeFile(join(stage.workspaceDir, "candidate-template", "candidate.py"), contents);
  const manifest = manifestFor(contents);
  await writeAtomicJson(join(stage.workspaceDir, "infrastructure.json"), manifest);
  return { contents, manifest };
}

test("preparation staging creates only private state, logs, and an isolated workspace", async (t) => {
  const stage = await fixture(t);
  assert.deepEqual((await readdir(stage.stageDir)).sort(), ["events.jsonl", "job.json", "stderr.log", "workspace"]);
  assert.deepEqual(JSON.parse(await readFile(join(stage.stageDir, "job.json"), "utf8")), { jobId: JOB_ID, problemId: PROBLEM_ID });
  assert.equal((await lstat(stage.workspaceDir)).isDirectory(), true);
  await assert.rejects(() => createPreparationStage({ rootDir: stage.rootDir, jobId: JOB_ID, problemId: PROBLEM_ID }), /exist|collision/i);
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(stage.stageDir, "job.json"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(stage.stageDir, "events.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(stage.stageDir, "stderr.log"))).mode & 0o777, 0o600);
  }
});

test("stage events append as JSONL and atomic JSON replacement leaves complete state", async (t) => {
  const stage = await fixture(t);
  await appendEvent({ stageDir: stage.stageDir, event: { type: "started" } });
  await appendEvent({ stageDir: stage.stageDir, event: { type: "finished", ok: true } });
  assert.equal(await readFile(join(stage.stageDir, "events.jsonl"), "utf8"), '{"type":"started"}\n{"type":"finished","ok":true}\n');
  const state = join(stage.stageDir, "state.json");
  await writeFile(state, "{ broken");
  await writeAtomicJson(state, { outcome: "prepared" });
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), { outcome: "prepared" });
  assert.deepEqual((await readdir(stage.stageDir)).filter((name) => name.includes(".tmp")), []);
});

test("staging refuses a configured root that is a symlink", async (t) => {
  const realRoot = await mkdtemp(join(tmpdir(), "autoresearch-real-"));
  const linkRoot = await mkdtemp(join(tmpdir(), "autoresearch-link-"));
  t.after(() => Promise.all([rm(realRoot, { recursive: true, force: true }), rm(linkRoot, { recursive: true, force: true })]));
  const linked = join(linkRoot, "root");
  await symlink(realRoot, linked);
  await assert.rejects(() => createPreparationStage({ rootDir: linked, jobId: JOB_ID, problemId: PROBLEM_ID }), /symlink/i);
});

test("publication copies verified files then publishes the manifest last and keeps published revisions on index failure", async (t) => {
  const stage = await fixture(t);
  const source = join(stage.workspaceDir, "candidate-template", "candidate.py");
  const contents = "print('candidate')\n";
  await mkdir(join(stage.workspaceDir, "candidate-template"), { recursive: true });
  await writeFile(source, contents);
  await writeAtomicJson(join(stage.workspaceDir, "infrastructure.json"), manifestFor(contents));
  const order = [];
  const fs = await import("node:fs/promises");
  const result = await publishInfrastructureRevision({
    rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001",
    fileOps: {
      mkdir: async (...args) => { order.push(`mkdir:${args[0]}`); return fs.mkdir(...args); },
      copyFile: async (...args) => { order.push(`copy:${args[1]}`); return fs.copyFile(...args); },
      rename: async (...args) => { order.push(`rename:${args[1]}`); return fs.rename(...args); },
      rm: fs.rm,
    },
    rebuildIndex: async () => { throw new Error("index unavailable"); },
  });
  assert.equal(result.status, "published-index-stale");
  const target = join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure", "INF-001");
  assert.equal(await readFile(join(target, "candidate-template", "candidate.py"), "utf8"), contents);
  assert.deepEqual(JSON.parse(await readFile(join(target, "infrastructure.json"), "utf8")), manifestFor(contents));
  assert.equal((await readdir(target)).includes(".infrastructure.json.tmp"), false);
  assert.match(order.at(-1), /rename:.*infrastructure\.json$/);
  assert.ok(order.some((item) => item.includes(".infrastructure.json.tmp")));
});

test("publication rejects collisions and unsafe or changed workspace inputs before making a revision visible", async (t) => {
  const stage = await fixture(t);
  const source = join(stage.workspaceDir, "candidate-template", "candidate.py");
  await mkdir(join(stage.workspaceDir, "candidate-template"), { recursive: true });
  await writeFile(source, "safe\n");
  await writeAtomicJson(join(stage.workspaceDir, "infrastructure.json"), manifestFor("different\n"));
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001", rebuildIndex: async () => ({}) }),
    /hash|size|invalid/i,
  );
  assert.deepEqual((await readdir(join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure")).catch(() => [])), []);
  await writeAtomicJson(join(stage.workspaceDir, "infrastructure.json"), manifestFor("safe\n"));
  await chmod(source, 0o700);
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001", rebuildIndex: async () => ({}) }),
    /executable/i,
  );
  await chmod(source, 0o600);
  await writeFile(join(stage.workspaceDir, "unlisted"), "not allowed\n");
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001", rebuildIndex: async () => ({}) }),
    /unlisted|unexpected/i,
  );
});

test("publication accepts only the exact job workspace and cleans an exclusively-created target before manifest publication", async (t) => {
  const stage = await fixture(t);
  const nested = join(stage.rootDir, ".generated", "autoresearch-jobs", "nested", JOB_ID);
  await mkdir(join(nested, "workspace", "candidate-template"), { recursive: true });
  await writeFile(join(nested, "workspace", "candidate-template", "candidate.py"), "safe\n");
  await writeAtomicJson(join(nested, "workspace", "infrastructure.json"), manifestFor("safe\n"));
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: stage.rootDir, stageDir: nested, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /stage|workspace/i,
  );

  await mkdir(join(stage.workspaceDir, "candidate-template"), { recursive: true });
  await writeFile(join(stage.workspaceDir, "candidate-template", "candidate.py"), "safe\n");
  await writeAtomicJson(join(stage.workspaceDir, "infrastructure.json"), manifestFor("safe\n"));
  const fs = await import("node:fs/promises");
  await assert.rejects(
    () => publishInfrastructureRevision({
      rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001",
      fileOps: { mkdir: fs.mkdir, copyFile: async () => { throw new Error("copy failed"); }, rename: fs.rename, rm: fs.rm },
    }),
    /copy failed/,
  );
  await assert.rejects(() => lstat(join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure", "INF-001")), /ENOENT/);
});

test("publication cancellation before the manifest commit removes the partial revision", async (t) => {
  const stage = await fixture(t);
  await readyWorkspace(stage);
  const controller = new AbortController();
  const fs = await import("node:fs/promises");

  await assert.rejects(
    () => publishInfrastructureRevision({
      rootDir: stage.rootDir,
      stageDir: stage.stageDir,
      problemId: PROBLEM_ID,
      expectedRevisionId: "INF-001",
      signal: controller.signal,
      fileOps: {
        mkdir: fs.mkdir,
        copyFile: async (...args) => {
          await fs.copyFile(...args);
          if (!args[1].endsWith(".infrastructure.json.tmp")) controller.abort();
        },
        rename: fs.rename,
        rm: fs.rm,
      },
    }),
    /abort/i,
  );
  await assert.rejects(() => lstat(join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure", "INF-001")), /ENOENT/);
});

test("publication cancellation after the manifest commit preserves the visible revision", async (t) => {
  const stage = await fixture(t);
  await readyWorkspace(stage);
  const controller = new AbortController();
  const fs = await import("node:fs/promises");

  const result = await publishInfrastructureRevision({
    rootDir: stage.rootDir,
    stageDir: stage.stageDir,
    problemId: PROBLEM_ID,
    expectedRevisionId: "INF-001",
    signal: controller.signal,
    fileOps: {
      mkdir: fs.mkdir,
      copyFile: fs.copyFile,
      rename: async (...args) => { await fs.rename(...args); controller.abort(); },
      rm: fs.rm,
    },
  });

  assert.equal(result.status, "published");
  assert.equal((await readLatestReadyInfrastructure({ rootDir: stage.rootDir, problemId: PROBLEM_ID })).id, "INF-001");
});

test("revision readers sort IDs and return only the latest ready manifest", async (t) => {
  const stage = await fixture(t);
  const base = join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure");
  for (const id of ["INF-010", "INF-002"]) {
    const directory = join(base, id);
    await mkdir(directory, { recursive: true });
    await writeAtomicJson(join(directory, "infrastructure.json"), manifestFor("one\n", id));
  }
  await mkdir(join(base, "not-a-revision"));
  assert.deepEqual(await listInfrastructureRevisions({ rootDir: stage.rootDir, problemId: PROBLEM_ID }), ["INF-002", "INF-010"]);
  const latest = await readLatestReadyInfrastructure({ rootDir: stage.rootDir, problemId: PROBLEM_ID });
  assert.equal(latest.id, "INF-010");
  assert.equal(latest.status, "ready");
});

test("publication counts the new manifest against the aggregate revision budget", async (t) => {
  const stage = await fixture(t);
  const { contents } = await readyWorkspace(stage);
  const payloadBytes = Buffer.byteLength(contents);
  const base = join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure", "INF-002");
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "filler"), "");
  await truncate(join(base, "filler"), MAX_REVISION_BYTES - payloadBytes);

  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /512 MiB/,
  );
});

test("publication refuses symlinked destination components before writing outside the checkout", async (t) => {
  const stage = await fixture(t);
  await readyWorkspace(stage);
  const outside = await mkdtemp(join(tmpdir(), "autoresearch-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(stage.rootDir, "problems"));

  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /symlink|outside/i,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("publication rejects symlinks, special files, missing listed files, and existing revision IDs", async (t) => {
  const symlinked = await fixture(t);
  const external = join(symlinked.rootDir, "external.py");
  await writeFile(external, "safe\n");
  await mkdir(join(symlinked.workspaceDir, "candidate-template"), { recursive: true });
  await symlink(external, join(symlinked.workspaceDir, "candidate-template", "candidate.py"));
  await writeAtomicJson(join(symlinked.workspaceDir, "infrastructure.json"), manifestFor("safe\n"));
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: symlinked.rootDir, stageDir: symlinked.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /symlink/i,
  );

  if (process.platform !== "win32") {
    const special = await fixture(t);
    await readyWorkspace(special);
    await execFileAsync("mkfifo", [join(special.workspaceDir, "pipe")]);
    await assert.rejects(
      () => publishInfrastructureRevision({ rootDir: special.rootDir, stageDir: special.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
      /special/i,
    );
  }

  const missing = await fixture(t);
  const { manifest } = await readyWorkspace(missing);
  manifest.files.push({ path: "missing.txt", sha256: digest("missing\n"), size: 8, executable: false });
  await writeAtomicJson(join(missing.workspaceDir, "infrastructure.json"), manifest);
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: missing.rootDir, stageDir: missing.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /missing/i,
  );

  const collision = await fixture(t);
  await readyWorkspace(collision);
  await publishInfrastructureRevision({ rootDir: collision.rootDir, stageDir: collision.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" });
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: collision.rootDir, stageDir: collision.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /exist/i,
  );
});

test("publication rejects per-file size overflow and cleans up manifest copy or rename failures", async (t) => {
  const oversized = await fixture(t);
  const { manifest } = await readyWorkspace(oversized);
  const source = join(oversized.workspaceDir, "candidate-template", "candidate.py");
  await truncate(source, 16 * 1024 * 1024 + 1);
  manifest.files[0].size = 16 * 1024 * 1024 + 1;
  manifest.files[0].sha256 = digest(await readFile(source));
  await writeAtomicJson(join(oversized.workspaceDir, "infrastructure.json"), manifest);
  await assert.rejects(
    () => publishInfrastructureRevision({ rootDir: oversized.rootDir, stageDir: oversized.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001" }),
    /16 MiB/,
  );

  for (const failure of ["manifest-copy", "manifest-rename"]) {
    const stage = await fixture(t);
    await readyWorkspace(stage);
    const fs = await import("node:fs/promises");
    await assert.rejects(
      () => publishInfrastructureRevision({
        rootDir: stage.rootDir, stageDir: stage.stageDir, problemId: PROBLEM_ID, expectedRevisionId: "INF-001",
        fileOps: {
          mkdir: fs.mkdir,
          copyFile: async (...args) => {
            if (failure === "manifest-copy" && args[1].endsWith(".infrastructure.json.tmp")) throw new Error(failure);
            return fs.copyFile(...args);
          },
          rename: async (...args) => {
            if (failure === "manifest-rename") throw new Error(failure);
            return fs.rename(...args);
          },
          rm: fs.rm,
        },
      }),
      new RegExp(failure),
    );
    await assert.rejects(() => lstat(join(stage.rootDir, "problems", PROBLEM_ID, "infrastructure", "INF-001")), /ENOENT/);
  }
});

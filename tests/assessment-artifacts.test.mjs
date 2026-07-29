import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RUN_ID_PATTERN,
  createRunId,
  resolveProblemDir,
  resolveRunDir,
} from "../lib/assessments/paths.mjs";
import { createArtifactStore } from "../lib/assessments/artifact-store.mjs";

test("creates sortable run IDs with fixed timestamp and random suffix", () => {
  const runId = createRunId(new Date("2026-07-28T01:02:03.000Z"), () => Buffer.from("a1b2c3", "hex"));
  assert.equal(runId, "20260728T010203Z-a1b2c3");
  assert.match(runId, RUN_ID_PATTERN);
});

test("rejects traversal in problem and run IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-paths-"));
  await assert.rejects(() => resolveProblemDir(root, "../Prob-001"), /Invalid problem ID/);
  await assert.rejects(() => resolveRunDir(root, "Prob-001", "../x"), /Invalid run ID/);
});

test("rejects a problem directory symlink that escapes the problems root", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "assessment-outside-"));
  await mkdir(join(root, "problems"));
  await symlink(outside, join(root, "problems", "Prob-001"));

  await assert.rejects(() => resolveProblemDir(root, "Prob-001"), /Path escapes expected root/);
});

test("rejects a problems root symlink that escapes the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "assessment-outside-"));
  await symlink(outside, join(root, "problems"));

  await assert.rejects(() => resolveProblemDir(root, "Prob-001"), /Path escapes expected root/);
});

test("rejects generated directories outside the workspace or behind a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-store-"));
  const outside = await mkdtemp(join(tmpdir(), "assessment-outside-"));
  await symlink(outside, join(root, ".generated"));

  const symlinkedStore = createArtifactStore({ rootDir: root });
  await assert.rejects(() => symlinkedStore.createAcceptedRun({ problemId: "Prob-001" }), /Path escapes expected root/);

  const traversalStore = createArtifactStore({ rootDir: root, generatedDir: "../outside" });
  await assert.rejects(() => traversalStore.createAcceptedRun({ problemId: "Prob-001" }), /Path escapes expected root/);

  const absoluteStore = createArtifactStore({ rootDir: root, generatedDir: outside });
  await assert.rejects(() => absoluteStore.createAcceptedRun({ problemId: "Prob-001" }), /Path escapes expected root/);
});

test("publishes completed artifacts atomically under the problem", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-store-"));
  await mkdir(join(root, "problems", "Prob-001"), { recursive: true });
  const store = createArtifactStore({
    rootDir: root,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    randomBytes: () => Buffer.from("a1b2c3", "hex"),
  });
  const run = await store.createAcceptedRun({ problemId: "Prob-001" });
  await store.appendEvent(run, { type: "stage", stage: "running" });
  const summary = {
    runId: "20260728T010203Z-a1b2c3",
    problemId: "Prob-001",
    verdict: "DO_NOW",
    recommendation: "proceed",
    lifecycleMutation: false,
  };
  const terminal = await store.writeTerminalArtifacts(run, {
    status: "completed",
    input: { schemaVersion: 1, problemId: "Prob-001" },
    assessment: { accepted: true },
    summary,
    reportHtml: "<!doctype html><title>Report</title>",
    eventsText: '{"type":"codex-complete"}\n',
    stderr: "",
  });

  assert.equal(terminal.status, "completed");
  const finalDir = join(root, "problems", "Prob-001", "assessments", "20260728T010203Z-a1b2c3");
  assert.equal((await stat(finalDir)).isDirectory(), true);
  const runJson = JSON.parse(await readFile(join(finalDir, "run.json"), "utf8"));
  assert.equal(runJson.status, "completed");
  assert.deepEqual(runJson.summary, summary);
  assert.equal("stagingDir" in runJson, false);
  assert.equal("finalDir" in runJson, false);
  assert.equal(await readFile(join(finalDir, "report.html"), "utf8"), "<!doctype html><title>Report</title>");
  assert.equal(
    await readFile(join(finalDir, "events.jsonl"), "utf8"),
    '{"at":"2026-07-28T01:02:03.000Z","type":"stage","stage":"running"}\n{"type":"codex-complete"}\n',
  );
});

test("read paths do not create problem directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-read-paths-"));
  const store = createArtifactStore({ rootDir: root });

  assert.deepEqual(await store.listRuns("Prob-001"), []);
  await assert.rejects(() => store.readRun("Prob-001", "20260728T010203Z-a1b2c3"), /ENOENT/);
  await assert.rejects(() => stat(join(root, "problems", "Prob-001")), /ENOENT/);
});

test("writes failed runs without assessment or report files", async () => {
  const root = await mkdtemp(join(tmpdir(), "assessment-store-"));
  await mkdir(join(root, "problems", "Prob-001"), { recursive: true });
  const store = createArtifactStore({
    rootDir: root,
    now: () => new Date("2026-07-28T02:03:04.000Z"),
    randomBytes: () => Buffer.from("d4e5f6", "hex"),
  });
  const run = await store.createAcceptedRun({ problemId: "Prob-001" });
  await store.writeTerminalArtifacts(run, {
    status: "failed",
    input: { schemaVersion: 1, problemId: "Prob-001" },
    error: { code: "CODEX_EXIT", message: "Codex exited with status 1." },
    stderr: "diagnostic text",
  });

  const finalDir = join(root, "problems", "Prob-001", "assessments", "20260728T020304Z-d4e5f6");
  await assert.rejects(() => readFile(join(finalDir, "assessment.json"), "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(join(finalDir, "report.html"), "utf8"), /ENOENT/);
  assert.match(await readFile(join(finalDir, "stderr.log"), "utf8"), /diagnostic text/);
});

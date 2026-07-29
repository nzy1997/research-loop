import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAssessmentService } from "../lib/assessments/local-service.mjs";
import { startAssessmentService } from "../scripts/local-assessment-service.mjs";
import { createAssessmentJobManager } from "../lib/assessments/job-manager.mjs";

const tokenHeaders = { "x-local-assessment-token": "secret" };
const runId = "20260728T010203Z-a1b2c3";

async function request(server, path, options = {}) {
  const listener = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  try {
    return await fetch(`http://127.0.0.1:${listener.port}${path}`, options);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("rejects requests missing the capability token", async () => {
  const server = createAssessmentService({ token: "secret", manager: {} });
  const response = await request(server, "/__local/assessments/problems/Prob-001");
  assert.equal(response.status, 401);
});

test("rejects an absent capability token while constructing the service", () => {
  assert.throws(() => createAssessmentService({ manager: {} }), /token/i);
  assert.throws(() => createAssessmentService({ token: "", manager: {} }), /token/i);
});

test("refuses to start on a non-loopback host", async () => {
  await assert.rejects(startAssessmentService({ host: "0.0.0.0" }), /127\.0\.0\.1/);
});

test("the local knowledge adapter forwards a selected page to the trusted resolver CLI", async () => {
  const localServiceModule = await import("../scripts/local-assessment-service.mjs");
  assert.equal(typeof localServiceModule.createKnowledgeResolver, "function");
  const calls = [];
  const resolver = localServiceModule.createKnowledgeResolver("/repo", {
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          query: "Fixture",
          status: "match",
          bundle: {
            topic: "knowledge/a/index.qmd",
            ancestorIndexes: ["knowledge/index.qmd", "knowledge/a/index.qmd"],
            contentPages: ["knowledge/a.qmd"],
            orderedFiles: ["knowledge/index.qmd", "knowledge/a/index.qmd", "knowledge/a.qmd"],
          },
          alternatives: [],
        }),
      };
    },
  });

  const result = await resolver("Fixture", { selectedPage: "knowledge/a.qmd" });

  assert.equal(result.bundle.contentPages[0], "knowledge/a.qmd");
  assert.deepEqual(calls[0].args, [
    "--import", "tsx", "scripts/knowledge.ts", "resolve",
    "--query", "Fixture", "--select-page", "knowledge/a.qmd",
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
});

test("standalone service close shuts down the assessment manager", async () => {
  let shutdowns = 0;
  const service = await startAssessmentService({
    token: "secret",
    manager: {
      shutdown: async () => { shutdowns += 1; },
    },
  });

  await service.close();

  assert.equal(shutdowns, 1);
});

test("starts jobs through the POST endpoint", async () => {
  const calls = [];
  const server = createAssessmentService({
    token: "secret",
    manager: {
      start: async (problemId) => {
        calls.push(problemId);
        return { accepted: true, runId, status: "queued" };
      },
    },
  });
  const response = await request(server, "/__local/assessments/jobs", {
    method: "POST",
    headers: { ...tokenHeaders, "content-type": "application/json" },
    body: JSON.stringify({ problemId: "Prob-001" }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["Prob-001"]);
  assert.equal((await response.json()).runId, runId);
});

test("rejects non-JSON mutation requests before manager calls", async () => {
  const server = createAssessmentService({
    token: "secret",
    manager: { start: async () => assert.fail("manager should not be called") },
  });
  const response = await request(server, "/__local/assessments/jobs", {
    method: "POST",
    headers: { ...tokenHeaders, "content-type": "text/plain" },
    body: JSON.stringify({ problemId: "Prob-001" }),
  });

  assert.equal(response.status, 415);
});

test("rejects cross-origin mutation requests before manager calls", async () => {
  const server = createAssessmentService({
    token: "secret",
    manager: { start: async () => assert.fail("manager should not be called") },
  });
  const response = await request(server, "/__local/assessments/jobs", {
    method: "POST",
    headers: {
      ...tokenHeaders,
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({ problemId: "Prob-001" }),
  });

  assert.equal(response.status, 403);
});

test("rejects traversal IDs before manager calls", async () => {
  const server = createAssessmentService({
    token: "secret",
    manager: { getProblemState: async () => assert.fail("manager should not be called") },
  });
  const response = await request(server, "/__local/assessments/problems/%2e%2e%2fx", { headers: tokenHeaders });
  assert.equal(response.status, 400);
});

test("selection rejects an altered alternative and accepts the recorded alternative", async () => {
  const chosen = { page: "knowledge/topic.qmd", topic: "topic", title: "Topic", matchKind: "title" };
  const runs = [];
  const manager = createAssessmentJobManager({
    rootDir: "/repo",
    repository: {
      getProblem: (id) => id === "Prob-001" ? { id, title: "Fixture", summary: "Summary" } : null,
      readProblemMarkdown: async () => "# Fixture",
    },
    store: {
      async createAcceptedRun({ problemId, parentRunId = null }) {
        const run = { schemaVersion: 1, runId: runs.length ? "20260728T010204Z-d4e5f6" : runId, problemId, parentRunId, status: "queued", stagingDir: "/tmp/run" };
        runs.push(run);
        return run;
      },
      async listRuns(problemId) { return runs.filter((run) => run.problemId === problemId); },
      async writeTerminalArtifacts(run, artifacts) {
        run.status = artifacts.status;
        run.artifacts = artifacts;
        return run;
      },
      async readClarification(problemId, selectedRunId) {
        return runs.find((run) => run.problemId === problemId && run.runId === selectedRunId)?.artifacts?.clarification ?? null;
      },
    },
    codex: {
      preflight: async () => ({ ok: true }),
      run: async ({ selectedAlternative }) => selectedAlternative
        ? { ok: false, code: "CODEX_EXIT", message: "done", stderr: "" }
        : { ok: true, envelope: { outcome: "needs_input", clarification: { alternatives: [chosen] } }, stderr: "" },
    },
  });
  const parent = await manager.start("Prob-001");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const server = createAssessmentService({
    token: "secret",
    manager,
  });
  const rejected = await request(server, `/__local/assessments/jobs/${parent.runId}/selection`, {
    method: "POST",
    headers: { ...tokenHeaders, "content-type": "application/json" },
    body: JSON.stringify({ alternative: { ...chosen, title: "Altered" } }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "INVALID_SELECTION");

  const accepted = await request(createAssessmentService({ token: "secret", manager }), `/__local/assessments/jobs/${parent.runId}/selection`, {
    method: "POST",
    headers: { ...tokenHeaders, "content-type": "application/json" },
    body: JSON.stringify({ alternative: chosen }),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).runId, "20260728T010204Z-d4e5f6");
});

test("serves report and diagnostic log from the requested run only", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "assessment-service-"));
  const runDir = join(rootDir, "problems", "Prob-001", "assessments", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "report.html"), "<h1>Assessment</h1>");
  await writeFile(join(runDir, "stderr.log"), "diagnostic text\n");

  const report = await request(createAssessmentService({ rootDir, token: "secret", manager: {} }), `/__local/assessments/reports/Prob-001/${runId}`, { headers: tokenHeaders });
  assert.equal(report.status, 200);
  assert.match(report.headers.get("content-type"), /^text\/html; charset=utf-8$/);
  assert.equal(await report.text(), "<h1>Assessment</h1>");

  const log = await request(createAssessmentService({ rootDir, token: "secret", manager: {} }), `/__local/assessments/logs/Prob-001/${runId}`, { headers: tokenHeaders });
  assert.equal(log.status, 200);
  assert.match(log.headers.get("content-type"), /^text\/plain; charset=utf-8$/);
  assert.match(log.headers.get("content-disposition"), /^attachment/);
  assert.equal(await log.text(), "diagnostic text\n");
});

test("missing report reads do not create problem directories", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "assessment-service-read-"));
  const response = await request(createAssessmentService({ rootDir, token: "secret", manager: {} }), `/__local/assessments/reports/Prob-001/${runId}`, { headers: tokenHeaders });

  assert.equal(response.status, 404);
  await assert.rejects(() => stat(join(rootDir, "problems", "Prob-001")), /ENOENT/);
});

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  assertContained,
  createRunId,
  resolveExistingProblemDir,
  resolveExistingRunDir,
  resolveProblemDir,
  resolveRunDir,
} from "./paths.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function createArtifactStore({ rootDir, generatedDir = ".generated/assessment-runs", now = () => new Date(), randomBytes } = {}) {
  const workspaceRoot = resolve(rootDir ?? process.cwd());
  const stagingRoot = resolve(workspaceRoot, generatedDir);
  return {
    async createAcceptedRun({ problemId, parentRunId = null }) {
      const safeStagingRoot = await assertContained(workspaceRoot, stagingRoot);
      const problemDir = await resolveProblemDir(workspaceRoot, problemId);
      const runId = createRunId(now(), randomBytes);
      const createdAt = now().toISOString();
      await mkdir(safeStagingRoot, { recursive: true });
      const stagingDir = await assertContained(safeStagingRoot, join(safeStagingRoot, runId));
      const run = { schemaVersion: 1, runId, problemId, parentRunId, status: "queued", createdAt, updatedAt: createdAt };
      await mkdir(problemDir, { recursive: true });
      await mkdir(stagingDir, { recursive: true });
      await writeJson(join(stagingDir, "run.json"), run);
      await writeFile(join(stagingDir, "events.jsonl"), "");
      await writeFile(join(stagingDir, "stderr.log"), "");
      return { ...run, stagingDir };
    },
    async appendEvent(run, event) {
      await writeFile(join(run.stagingDir, "events.jsonl"), `${JSON.stringify({ at: now().toISOString(), ...event })}\n`, { flag: "a" });
    },
    async writeTerminalArtifacts(run, artifacts) {
      const finalRun = {
        schemaVersion: run.schemaVersion,
        runId: run.runId,
        problemId: run.problemId,
        parentRunId: run.parentRunId ?? null,
        status: artifacts.status,
        createdAt: run.createdAt,
        updatedAt: now().toISOString(),
        error: artifacts.error ?? null,
        summary: artifacts.summary ?? null,
      };
      await writeJson(join(run.stagingDir, "run.json"), finalRun);
      await writeJson(join(run.stagingDir, "input.json"), artifacts.input);
      if (artifacts.assessment) await writeJson(join(run.stagingDir, "assessment.json"), artifacts.assessment);
      if (artifacts.clarification) await writeJson(join(run.stagingDir, "clarification.json"), artifacts.clarification);
      if (artifacts.selection) await writeJson(join(run.stagingDir, "selection.json"), artifacts.selection);
      if (artifacts.reportHtml) await writeFile(join(run.stagingDir, "report.html"), artifacts.reportHtml);
      if (artifacts.eventsText) {
        await writeFile(join(run.stagingDir, "events.jsonl"), artifacts.eventsText, { flag: "a" });
      }
      await writeFile(join(run.stagingDir, "stderr.log"), artifacts.stderr ?? "");
      const finalDir = await resolveRunDir(workspaceRoot, run.problemId, run.runId);
      await mkdir(dirname(finalDir), { recursive: true });
      await rename(run.stagingDir, finalDir);
      return { ...finalRun, finalDir };
    },
    async listRuns(problemId) {
      const problemDir = await resolveExistingProblemDir(workspaceRoot, problemId);
      const assessmentsDir = join(problemDir, "assessments");
      let entries = [];
      try {
        entries = await readdir(assessmentsDir, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const runs = [];
      for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
        const text = await readFile(join(assessmentsDir, entry.name, "run.json"), "utf8");
        runs.push(JSON.parse(text));
      }
      return runs;
    },
    async readRun(problemId, runId) {
      const runDir = await resolveExistingRunDir(workspaceRoot, problemId, runId);
      return JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    },
    async readInput(problemId, runId) {
      const runDir = await resolveExistingRunDir(workspaceRoot, problemId, runId);
      return JSON.parse(await readFile(join(runDir, "input.json"), "utf8"));
    },
    async readClarification(problemId, runId) {
      const runDir = await resolveExistingRunDir(workspaceRoot, problemId, runId);
      return JSON.parse(await readFile(join(runDir, "clarification.json"), "utf8"));
    },
    async findRun(runId) {
      const problemsDir = join(workspaceRoot, "problems");
      let problems = [];
      try {
        problems = await readdir(problemsDir, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const problem of problems.filter((entry) => entry.isDirectory())) {
        try {
          const run = await this.readRun(problem.name, runId);
          return run;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return null;
    },
  };
}

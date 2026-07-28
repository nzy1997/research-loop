import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createPreparationStage,
  listInfrastructureRevisions,
  publishInfrastructureRevision,
  writeAtomicJson,
} from "./artifact-store.mjs";
import { runPreparationCodex } from "./codex-preparation.mjs";
import { nextInfrastructureId } from "./ids.mjs";
import { runInfrastructurePreflight } from "./preflight.mjs";
import { validateInfrastructureManifest, validatePreparationEnvelope } from "./preparation-contract.mjs";
import { buildProblemIndex } from "../problems/indexer.mjs";
import { createProblemRepository } from "../problems/repository.mjs";
import { validateProblemManifest } from "../problems/schema.mjs";

const PREPARABLE_STATUSES = new Set(["qualifying", "accepted"]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

async function readValidatedProblem(rootDir, problemId) {
  const index = await buildProblemIndex({ rootDir });
  const repository = createProblemRepository(index);
  const indexed = repository.getProblem(problemId);
  if (!indexed) throw new Error(`Problem is not indexed: ${problemId}`);
  const problemDir = join(rootDir, "problems", problemId);
  const [manifestText, problemMarkdown] = await Promise.all([
    readFile(join(problemDir, "problem.json"), "utf8"),
    readFile(join(problemDir, "problem.md"), "utf8"),
  ]);
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch (error) { throw new Error(`Invalid problem.json for ${problemId}: ${error.message}`); }
  const validation = validateProblemManifest(manifest, { relativePath: `problems/${problemId}/problem.json`, problemMdText: problemMarkdown });
  if (!validation.ok) throw new Error(`Problem validation failed: ${validation.errors.map((item) => `${item.field}: ${item.message}`).join("; ")}`);
  if (manifest.id !== problemId || indexed.id !== problemId) throw new Error(`Problem identity changed while preparing: ${problemId}`);
  if (!PREPARABLE_STATUSES.has(manifest.status)) throw new Error(`Problem status is not eligible for preparation: ${manifest.status}`);
  return { problem: manifest, problemMarkdown };
}

function stageFor(rootDir, jobId) {
  return join(rootDir, ".generated", "autoresearch-jobs", jobId);
}

export function createPreparationWorker({
  rootDir = process.cwd(), privateDataRoot, codexAdapter = runPreparationCodex,
  preflightRunner = runInfrastructurePreflight,
  artifactStore = { createPreparationStage, listInfrastructureRevisions, publishInfrastructureRevision, writeAtomicJson },
  jobStore, rebuildIndex,
} = {}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) throw new TypeError("rootDir is required");
  if (typeof privateDataRoot !== "string" || privateDataRoot.length === 0) throw new TypeError("privateDataRoot is required");
  requiredFunction(codexAdapter, "codexAdapter");
  requiredFunction(preflightRunner, "preflightRunner");
  requiredFunction(rebuildIndex, "rebuildIndex");
  for (const name of ["createPreparationStage", "listInfrastructureRevisions", "publishInfrastructureRevision", "writeAtomicJson"]) requiredFunction(artifactStore?.[name], `artifactStore.${name}`);
  for (const name of ["read", "transition", "appendEvent"]) requiredFunction(jobStore?.[name], `jobStore.${name}`);

  return async function prepare({ jobId, problemId, answers = {} } = {}) {
    let job;
    try {
      job = await jobStore.read(jobId);
      if (job.problemId !== problemId) throw new Error(`Job ${jobId} does not belong to ${problemId}`);
      if (job.state === "needs_input" && !job.parentJobId) return { state: "needs_input" };
      let stage;
      if (job.parentJobId) {
        const parent = await jobStore.read(job.parentJobId);
        if (parent.problemId !== problemId || parent.state !== "needs_input") throw new Error("Preparation child does not retain a resumable parent lineage");
        stage = { stageDir: stageFor(rootDir, parent.jobId), workspaceDir: join(stageFor(rootDir, parent.jobId), "workspace") };
      }
      const { problem, problemMarkdown } = await readValidatedProblem(rootDir, problemId);
      if (!stage) stage = await artifactStore.createPreparationStage({ rootDir, jobId, problemId });

      await jobStore.transition(jobId, "scaffolding");
      await jobStore.transition(jobId, "building_benchmark");
      await jobStore.transition(jobId, "preparing_datasets");
      const previewId = nextInfrastructureId(await artifactStore.listInfrastructureRevisions({ rootDir, problemId }));
      const envelope = validatePreparationEnvelope(await codexAdapter({ stageDir: stage.stageDir, workspaceDir: stage.workspaceDir, problem, problemMarkdown, answers }));
      if (envelope?.outcome === "needs_input") {
        await jobStore.appendEvent(jobId, { code: "needs-input", question: envelope.question });
        await jobStore.transition(jobId, "needs_input");
        return { state: "needs_input", question: envelope.question };
      }
      if (envelope?.outcome !== "prepared" || envelope.manifestPath !== "infrastructure.json") throw new Error("Codex returned an invalid preparation outcome");
      await jobStore.transition(jobId, "preflight");
      let rawManifest;
      try { rawManifest = JSON.parse(await readFile(join(stage.workspaceDir, "infrastructure.json"), "utf8")); } catch (error) { throw new Error(`Prepared infrastructure.json is invalid: ${error.message}`); }
      const manifest = validateInfrastructureManifest(rawManifest, { problemId, infrastructureId: previewId });
      const report = await preflightRunner({ stageDir: stage.workspaceDir, manifest, privateDataRoot });
      await artifactStore.writeAtomicJson(join(stage.stageDir, "preflight-report.json"), report);
      if (report?.status !== "passed") throw new Error("Infrastructure preflight failed");
      const revisionsBeforePublish = await artifactStore.listInfrastructureRevisions({ rootDir, problemId });
      if (revisionsBeforePublish.includes(previewId)) throw new Error(`Infrastructure revision collision for ${previewId}; preparation preview was not republished`);
      const publication = await artifactStore.publishInfrastructureRevision({ rootDir, stageDir: stage.stageDir, problemId, expectedRevisionId: previewId, validateManifest: validateInfrastructureManifest, rebuildIndex });
      if (!publication || !["published", "published-index-stale"].includes(publication.status) || publication.id !== previewId) throw new Error("Infrastructure publication did not return the previewed revision");
      if (publication.status === "published-index-stale") await jobStore.appendEvent(jobId, { code: "ready-index-stale" });
      await jobStore.transition(jobId, "ready");
      return { state: "ready", infrastructureId: previewId };
    } catch (error) {
      if (job) {
        try { await jobStore.transition(jobId, "failed"); } catch { /* preserve the original preparation failure */ }
      }
      throw error;
    }
  };
}

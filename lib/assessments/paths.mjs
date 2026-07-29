import { randomBytes as nodeRandomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { PROBLEM_ID_PATTERN } from "../problems/schema.mjs";

export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{6}$/;

export function createRunId(now = new Date(), randomBytesFn = nodeRandomBytes) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytesFn(3).toString("hex")}`;
}

async function canonicalizePath(path) {
  let existingPath = resolve(path);
  const missingSegments = [];

  for (;;) {
    try {
      return join(await realpath(existingPath), ...missingSegments);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) throw error;
      missingSegments.unshift(basename(existingPath));
      existingPath = parent;
    }
  }
}

export async function assertContained(parent, child) {
  const parentReal = await canonicalizePath(parent);
  const childReal = await canonicalizePath(child);
  if (childReal !== parentReal && !childReal.startsWith(`${parentReal}/`)) {
    throw new Error(`Path escapes expected root: ${child}`);
  }
  return childReal;
}

export async function resolveProblemDir(rootDir, problemId, { ensure = true } = {}) {
  if (!PROBLEM_ID_PATTERN.test(problemId)) throw new Error(`Invalid problem ID: ${problemId}`);
  const workspaceRoot = resolve(rootDir);
  const problemsRoot = await assertContained(workspaceRoot, join(workspaceRoot, "problems"));
  if (ensure) await mkdir(problemsRoot, { recursive: true });
  const problemDir = await assertContained(problemsRoot, join(problemsRoot, problemId));
  if (ensure) await mkdir(problemDir, { recursive: true });
  return problemDir;
}

export async function resolveExistingProblemDir(rootDir, problemId) {
  return resolveProblemDir(rootDir, problemId, { ensure: false });
}

export async function resolveRunDir(rootDir, problemId, runId, { ensureProblem = true } = {}) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  const problemDir = await resolveProblemDir(rootDir, problemId, { ensure: ensureProblem });
  return assertContained(problemDir, join(problemDir, "assessments", runId));
}

export async function resolveExistingRunDir(rootDir, problemId, runId) {
  return resolveRunDir(rootDir, problemId, runId, { ensureProblem: false });
}

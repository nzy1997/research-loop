import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { ASSESSMENT_POLICY_VERSION } from "./policy.mjs";

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function hashFile(path) {
  try {
    return sha256Text(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function buildInputSnapshot({ rootDir, problem, envelope, skillPath, schemaPath, selectedAlternative = null }) {
  const root = resolve(rootDir);
  const problemDir = join(root, "problems", problem.id);
  const resolver = envelope.knowledgeResolution;
  const bundle = [];
  for (const orderedPath of resolver.orderedFiles ?? []) {
    bundle.push({
      path: orderedPath,
      hash: await hashFile(join(root, orderedPath)),
    });
  }
  return {
    schemaVersion: 1,
    policyVersion: ASSESSMENT_POLICY_VERSION,
    problemId: problem.id,
    problemTitle: problem.title,
    problemSummary: problem.summary,
    problemJsonHash: await hashFile(join(problemDir, "problem.json")),
    problemMdHash: await hashFile(join(problemDir, "problem.md")),
    skillPath: relative(root, skillPath),
    skillHash: await hashFile(skillPath),
    schemaPath: relative(root, schemaPath),
    schemaHash: await hashFile(schemaPath),
    resolver: {
      query: resolver.query,
      status: resolver.status,
      topic: resolver.topic,
      orderedFiles: [...(resolver.orderedFiles ?? [])],
      ...(selectedAlternative?.page ? { selectedPage: selectedAlternative.page } : {}),
    },
    bundle,
  };
}

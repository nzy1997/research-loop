import { join } from "node:path";

import { hashFile } from "./input-snapshot.mjs";

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function evaluateAssessmentStaleness({ rootDir, input, resolveKnowledge, currentHashes = null }) {
  const reasons = [];
  const hashes = currentHashes ?? {
    problemJsonHash: await hashFile(join(rootDir, "problems", input.problemId, "problem.json")),
    problemMdHash: await hashFile(join(rootDir, "problems", input.problemId, "problem.md")),
    skillHash: await hashFile(join(rootDir, input.skillPath)),
    schemaHash: await hashFile(join(rootDir, input.schemaPath)),
    bundle: await Promise.all((input.bundle ?? []).map(async (item) => ({
      path: item.path,
      hash: await hashFile(join(rootDir, item.path)),
    }))),
  };
  for (const key of ["problemJsonHash", "problemMdHash", "skillHash", "schemaHash"]) {
    if (hashes[key] !== input[key]) reasons.push(`${key} changed`);
  }
  const resolverNow = await resolveKnowledge(input.resolver.query, input.resolver.selectedPage
    ? { selectedPage: input.resolver.selectedPage }
    : undefined);
  const storedResolver = {
    status: input.resolver.status,
    topic: input.resolver.topic,
    orderedFiles: input.resolver.orderedFiles,
  };
  const currentResolver = {
    status: resolverNow.status,
    topic: resolverNow.status === "match" ? resolverNow.bundle?.topic ?? null : null,
    orderedFiles: resolverNow.status === "match" ? resolverNow.bundle?.orderedFiles ?? [] : [],
  };
  if (!sameJson(storedResolver, currentResolver)) reasons.push("resolver result changed");
  if (!sameJson(input.bundle ?? [], hashes.bundle ?? [])) reasons.push("resolver bundle hash changed");
  return { stale: reasons.length > 0, reasons };
}

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  setupLocalAssessmentFixture,
  teardownLocalAssessmentFixture,
} from "./local-assessment-fixture";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const metadataPath = path.join(repoRoot, ".generated", "local-assessment-e2e-fixture.json");

test("fixture teardown ignores corrupted metadata outside owned problem IDs", async (t) => {
  const sentinel = path.join(repoRoot, "local-assessment-e2e-sentinel");
  t.after(async () => {
    await rm(sentinel, { recursive: true, force: true });
    await teardownLocalAssessmentFixture();
  });

  await setupLocalAssessmentFixture();
  await mkdir(sentinel, { recursive: true });
  await writeFile(path.join(sentinel, "keep.txt"), "do not delete\n");

  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const corruptBackup = path.join(metadata.backupRoot, "corrupt-backup");
  await mkdir(corruptBackup, { recursive: true });
  await writeFile(path.join(corruptBackup, "payload.txt"), "do not restore outside fixtures\n");
  metadata.problemIds = ["../local-assessment-e2e-sentinel", ...metadata.problemIds];
  metadata.backedUpProblems = [
    { problemId: "../local-assessment-e2e-sentinel", backupPath: corruptBackup },
    ...metadata.backedUpProblems,
  ];
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  await teardownLocalAssessmentFixture();

  assert.equal(existsSync(path.join(sentinel, "keep.txt")), true);
  assert.equal(existsSync(metadataPath), false);
});

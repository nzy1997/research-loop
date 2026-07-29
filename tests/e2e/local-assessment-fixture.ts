import { execFile } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const generatedDir = path.join(repoRoot, ".generated");
const metadataPath = path.join(generatedDir, "local-assessment-e2e-fixture.json");
const generatedIndexPath = path.join(generatedDir, "problem-index.json");
const problemsDir = path.join(repoRoot, "problems");

export const LOCAL_ASSESSMENT_COMPLETE_PROBLEM_ID = "Prob-901";
export const LOCAL_ASSESSMENT_AMBIGUOUS_PROBLEM_ID = "Prob-902";

const problemIds = [
  LOCAL_ASSESSMENT_COMPLETE_PROBLEM_ID,
  LOCAL_ASSESSMENT_AMBIGUOUS_PROBLEM_ID,
];
const fixtureProblemIds = new Set(problemIds);

function isContained(parent: string, candidate: string) {
  const relative = path.relative(parent, path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function problemDir(problemId: string) {
  if (!fixtureProblemIds.has(problemId)) {
    throw new Error(`Refusing to operate on non-fixture problem ID ${problemId}.`);
  }
  const dir = path.resolve(problemsDir, problemId);
  if (!isContained(problemsDir, dir)) {
    throw new Error(`Fixture problem path escapes problems/: ${problemId}.`);
  }
  return dir;
}

function completeProblemMarkdown(problemId: string) {
  return [
    ["Background and Gap", `${problemId} is an E2E fixture for a local-only assessment flow.`],
    ["Research Objective", "Assess whether a bounded executable research problem should proceed."],
    ["Publication Threshold", "A report must explain value, fit, scores, and evidence."],
    ["Executable Gate", "The fake Codex executable returns a schema-valid envelope."],
    ["Novelty Evidence", "The fixture cites only trusted knowledge paths or problem text."],
    ["Provenance", "Created by the Playwright local assessment fixture."],
    ["Fresh Evaluation Plan", "Use a fake CLI so the browser flow spends no real Codex quota."],
  ].map(([heading, body]) => `## ${heading}\n${body}`).join("\n\n");
}

async function writeProblemFixture(problemId: string, title: string) {
  const dir = problemDir(problemId);
  await mkdir(path.join(dir, "generation"), { recursive: true });
  await writeFile(path.join(dir, "problem.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: problemId,
    title,
    summary: "Browser fixture for local assessment reports.",
    status: "accepted",
    gate: { type: "fake-codex", readiness: "executable" },
    provenance: { sourceCount: 1 },
    lastActivity: {
      summary: "Fixture prepared for browser assessment.",
      at: "2026-07-28T00:00:00.000Z",
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  }, null, 2)}\n`);
  await writeFile(path.join(dir, "problem.md"), `${completeProblemMarkdown(problemId)}\n`);
  await writeFile(path.join(dir, "generation", "initial-prompt.md"), "Fixture prompt.\n");
  await writeFile(path.join(dir, "generation", "transcript.md"), "Fixture transcript.\n");
  await writeFile(path.join(dir, "generation", "decision.md"), "Fixture decision.\n");
}

async function rebuildProblemIndex() {
  await execFileAsync(
    process.execPath,
    ["scripts/build-problem-index.mjs", "--reserve-id", "Prob-000"],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function writeMetadata(metadata: Record<string, unknown>) {
  await mkdir(generatedDir, { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function readMetadata() {
  if (!existsSync(metadataPath)) return null;
  return JSON.parse(await readFile(metadataPath, "utf8"));
}

function isGeneratedBackupPath(candidate: string) {
  return isContained(generatedDir, candidate);
}

function filesystemErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

async function removeFixtureStaging() {
  const stagingRoot = path.join(generatedDir, "assessment-runs");
  let entries: Dirent[] = [];
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (filesystemErrorCode(error) !== "ENOENT") throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const runDir = path.join(stagingRoot, entry.name);
    try {
      const run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      if (fixtureProblemIds.has(run.problemId)) await rm(runDir, { recursive: true, force: true });
    } catch (error: unknown) {
      if (filesystemErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

export async function setupLocalAssessmentFixture() {
  await teardownLocalAssessmentFixture();

  const metadata = {
    backupRoot: path.join(generatedDir, `local-assessment-e2e-backup-${process.pid}-${Date.now()}`),
    originalIndexText: existsSync(generatedIndexPath) ? await readFile(generatedIndexPath, "utf8") : null,
    problemIds,
    backedUpProblems: [] as { problemId: string; backupPath: string }[],
  };

  try {
    await mkdir(metadata.backupRoot, { recursive: true });
    await writeMetadata(metadata);

    for (const problemId of problemIds) {
      const dir = problemDir(problemId);
      if (existsSync(dir)) {
        const backupPath = path.join(metadata.backupRoot, problemId);
        await rename(dir, backupPath);
        metadata.backedUpProblems.push({ problemId, backupPath });
        await writeMetadata(metadata);
      }
    }

    await writeProblemFixture(LOCAL_ASSESSMENT_COMPLETE_PROBLEM_ID, "Completed assessment browser fixture");
    await writeProblemFixture(LOCAL_ASSESSMENT_AMBIGUOUS_PROBLEM_ID, "Ambiguous resolver browser fixture");
    await rebuildProblemIndex();
  } catch (error) {
    await teardownLocalAssessmentFixture();
    throw error;
  }
}

export async function teardownLocalAssessmentFixture() {
  const metadata = await readMetadata();
  if (!metadata) return;

  await removeFixtureStaging();
  for (const problemId of problemIds) {
    await rm(problemDir(problemId), { recursive: true, force: true });
  }

  const backups = Array.isArray(metadata.backedUpProblems) ? metadata.backedUpProblems : [];
  for (const backup of backups) {
    if (typeof backup.problemId === "string"
      && fixtureProblemIds.has(backup.problemId)
      && typeof backup.backupPath === "string"
      && isGeneratedBackupPath(backup.backupPath)
      && existsSync(backup.backupPath)) {
      await rename(backup.backupPath, problemDir(backup.problemId));
    }
  }

  if (typeof metadata.originalIndexText === "string") {
    await mkdir(path.dirname(generatedIndexPath), { recursive: true });
    await writeFile(generatedIndexPath, metadata.originalIndexText);
  } else {
    await rm(generatedIndexPath, { force: true });
  }

  if (typeof metadata.backupRoot === "string"
    && isGeneratedBackupPath(metadata.backupRoot)
    && path.basename(metadata.backupRoot).startsWith("local-assessment-e2e-backup-")) {
    await rm(metadata.backupRoot, { recursive: true, force: true });
  }
  await rm(metadataPath, { force: true });
}

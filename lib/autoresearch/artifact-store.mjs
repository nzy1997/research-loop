import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { INFRASTRUCTURE_ID_PATTERN, JOB_ID_PATTERN, isProblemId } from "./ids.mjs";
import { assertContained, createAutoresearchPaths } from "./paths.mjs";
import { validateInfrastructureManifest } from "./preparation-contract.mjs";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REVISION_BYTES = 512 * 1024 * 1024;
export const DEFAULT_ARTIFACT_FILE_OPS = { copyFile, mkdir, rename, rm };

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw new Error("Infrastructure publication aborted");
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\\")
    && !isAbsolute(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function inside(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function regularFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return info;
}

async function directory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
}

function rootPath(rootDir) {
  createAutoresearchPaths(rootDir);
  return resolve(rootDir);
}

function stageRoot(rootDir) {
  return join(rootDir, ".generated", "autoresearch-jobs");
}

async function verifyStage(rootDir, stageDir) {
  const expectedRoot = stageRoot(rootDir);
  const stage = resolve(stageDir);
  const expectedStage = join(expectedRoot, basename(stage));
  assertContained(stage, expectedRoot);
  if (!JOB_ID_PATTERN.test(basename(stage))) throw new TypeError("Invalid preparation job ID");
  if (stage !== expectedStage) throw new RangeError("Stage must be the exact job workspace beneath .generated/autoresearch-jobs");
  await directory(stage, "stage");
  await directory(join(stage, "workspace"), "stage workspace");
  return stage;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function collectWorkspaceEntries(workspace, current = workspace, entries = new Map()) {
  const children = await readdir(current, { withFileTypes: true });
  for (const child of children) {
    const path = join(current, child.name);
    const rel = relative(workspace, path).replaceAll("\\", "/");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Workspace contains a symlink: ${rel}`);
    if (info.isDirectory()) {
      await collectWorkspaceEntries(workspace, path, entries);
    } else if (info.isFile()) {
      entries.set(rel, { path, info });
    } else {
      throw new Error(`Workspace contains a special file: ${rel}`);
    }
  }
  return entries;
}

async function totalRevisionBytes(infrastructureRoot) {
  let total = 0;
  let names = [];
  try { names = await readdir(infrastructureRoot); } catch (error) { if (error.code === "ENOENT") return total; throw error; }
  for (const name of names) {
    if (!INFRASTRUCTURE_ID_PATTERN.test(name)) continue;
    const revision = join(infrastructureRoot, name);
    await directory(revision, `revision ${name}`);
    const entries = await collectWorkspaceEntries(revision);
    for (const { info } of entries.values()) total += info.size;
  }
  return total;
}

async function validatePublicationSource({ workspace, manifestPath, problemId, expectedRevisionId, validateManifest }) {
  const manifestInfo = await regularFile(manifestPath, "infrastructure.json");
  if (manifestInfo.size > MAX_FILE_BYTES) throw new RangeError("Infrastructure manifest exceeds 16 MiB");
  let raw;
  try { raw = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) { throw new Error(`infrastructure.json is invalid JSON: ${error.message}`); }
  const manifest = await validateManifest(raw, { problemId, infrastructureId: expectedRevisionId });
  const entries = await collectWorkspaceEntries(workspace);
  const expected = new Set(manifest.files.map((file) => file.path));
  expected.add("infrastructure.json");
  for (const path of entries.keys()) if (!expected.has(path)) throw new Error(`Workspace contains an unlisted file: ${path}`);
  for (const file of manifest.files) {
    if (!safeRelativePath(file.path)) throw new Error(`Manifest contains unsafe file path: ${file.path}`);
    if (file.path === "infrastructure.json" || file.path === ".infrastructure.json.tmp") {
      throw new Error(`Manifest reserves payload path: ${file.path}`);
    }
    const entry = entries.get(file.path);
    if (!entry) throw new Error(`Manifest-listed file is missing: ${file.path}`);
    if (entry.info.size > MAX_FILE_BYTES) throw new RangeError(`Manifest-listed file exceeds 16 MiB: ${file.path}`);
    const modeExecutable = (entry.info.mode & 0o111) !== 0;
    if (modeExecutable !== file.executable) throw new Error(`Executable bit disagrees with manifest: ${file.path}`);
    const contents = await readFile(entry.path);
    if (contents.length !== file.size || sha256(contents) !== file.sha256) throw new Error(`Manifest hash or size disagrees with source: ${file.path}`);
  }
  return {
    manifest,
    manifestBytes: manifestInfo.size,
    files: manifest.files.map((file) => ({ ...file, source: entries.get(file.path).path })),
  };
}

export async function createPreparationStage({ rootDir = process.cwd(), jobId, problemId }) {
  const root = rootPath(rootDir);
  if (!JOB_ID_PATTERN.test(jobId)) throw new TypeError("Invalid preparation job ID");
  if (!isProblemId(problemId)) throw new TypeError("Invalid problem ID");
  const jobs = stageRoot(root);
  await mkdir(jobs, { recursive: true });
  assertContained(jobs, root);
  await directory(jobs, "preparation jobs root");
  const stageDir = join(jobs, jobId);
  await mkdir(stageDir, { recursive: false, mode: 0o700 });
  try {
    await writeFile(join(stageDir, "job.json"), `${JSON.stringify({ jobId, problemId })}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(stageDir, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(stageDir, "stderr.log"), "", { flag: "wx", mode: 0o600 });
    await mkdir(join(stageDir, "workspace"), { mode: 0o700 });
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
  return { stageDir, workspaceDir: join(stageDir, "workspace") };
}

export async function appendEvent({ stageDir, event }) {
  await directory(stageDir, "stage");
  const events = join(stageDir, "events.jsonl");
  await regularFile(events, "events.jsonl");
  await writeFile(events, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
}

export async function writeAtomicJson(path, value) {
  const target = resolve(path);
  await directory(dirname(target), "JSON parent");
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function publishInfrastructureRevision({
  rootDir = process.cwd(), stageDir, problemId, expectedRevisionId, validateManifest = validateInfrastructureManifest,
  fileOps = DEFAULT_ARTIFACT_FILE_OPS, rebuildIndex = async () => undefined, signal,
}) {
  assertNotAborted(signal);
  const root = rootPath(rootDir);
  if (!isProblemId(problemId)) throw new TypeError("Invalid problem ID");
  if (!INFRASTRUCTURE_ID_PATTERN.test(expectedRevisionId)) throw new TypeError("Invalid infrastructure ID");
  const stage = await verifyStage(root, stageDir);
  assertNotAborted(signal);
  const workspace = join(stage, "workspace");
  const staged = await validatePublicationSource({ workspace, manifestPath: join(workspace, "infrastructure.json"), problemId, expectedRevisionId, validateManifest });
  assertNotAborted(signal);
  const infrastructureRoot = join(root, "problems", problemId, "infrastructure");
  assertContained(infrastructureRoot, root);
  let fileBytes = staged.manifestBytes;
  for (const file of staged.files) fileBytes += file.size;
  if (fileBytes + await totalRevisionBytes(infrastructureRoot) > MAX_REVISION_BYTES) throw new RangeError("Infrastructure revisions exceed 512 MiB");
  assertNotAborted(signal);

  await fileOps.mkdir(infrastructureRoot, { recursive: true });
  assertNotAborted(signal);
  assertContained(infrastructureRoot, root);
  await directory(infrastructureRoot, "infrastructure root");
  const target = join(infrastructureRoot, expectedRevisionId);
  const temporaryManifest = join(target, ".infrastructure.json.tmp");
  let targetCreated = false;
  let manifestPublished = false;
  try {
    await fileOps.mkdir(target, { recursive: false, mode: 0o700 });
    targetCreated = true;
    assertNotAborted(signal);
    for (const file of [...staged.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const destination = join(target, file.path);
      if (!inside(target, destination)) throw new Error(`Unsafe publication path: ${file.path}`);
      await fileOps.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      assertNotAborted(signal);
      await fileOps.copyFile(file.source, destination);
      assertNotAborted(signal);
    }
    await fileOps.copyFile(join(workspace, "infrastructure.json"), temporaryManifest);
    assertNotAborted(signal);
    // The manifest rename is the publication commit point. Once it succeeds,
    // finish indexing and mark the job ready even if cancellation arrives.
    await fileOps.rename(temporaryManifest, join(target, "infrastructure.json"));
    manifestPublished = true;
  } catch (error) {
    if (targetCreated && !manifestPublished) await fileOps.rm(target, { recursive: true, force: true });
    throw error;
  }
  const problemPath = relative(root, target).replaceAll("\\", "/");
  try {
    await rebuildIndex(root);
    return { status: "published", id: expectedRevisionId, problemPath };
  } catch (error) {
    return { status: "published-index-stale", id: expectedRevisionId, problemPath, error: error.message };
  }
}

export async function listInfrastructureRevisions({ rootDir = process.cwd(), problemId }) {
  const root = rootPath(rootDir);
  if (!isProblemId(problemId)) throw new TypeError("Invalid problem ID");
  const infrastructureRoot = join(root, "problems", problemId, "infrastructure");
  let entries;
  try { entries = await readdir(infrastructureRoot, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const revisions = [];
  for (const entry of entries) {
    if (!INFRASTRUCTURE_ID_PATTERN.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unsafe infrastructure revision: ${entry.name}`);
    revisions.push(entry.name);
  }
  return revisions.sort();
}

export async function readLatestReadyInfrastructure({ rootDir = process.cwd(), problemId }) {
  const root = rootPath(rootDir);
  const revisions = await listInfrastructureRevisions({ rootDir: root, problemId });
  for (const id of revisions.reverse()) {
    const manifestPath = join(root, "problems", problemId, "infrastructure", id, "infrastructure.json");
    try {
      await regularFile(manifestPath, "infrastructure.json");
      const value = validateInfrastructureManifest(JSON.parse(await readFile(manifestPath, "utf8")), { problemId, infrastructureId: id });
      if (value.status === "ready") return value;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

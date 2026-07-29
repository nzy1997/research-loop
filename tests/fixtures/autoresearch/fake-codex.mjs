#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const JOB_ID = /^ARJ-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const ALLOWED_EXEC_ENV = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "__CF_USER_TEXT_ENCODING"]);
const FIXED_TIME = "2026-07-28T08:00:00.000Z";

function fail(message) {
  process.stderr.write(`fake-codex: ${message}\n`);
  process.exit(64);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExecEnvironment() {
  const unexpected = Object.keys(process.env).filter((key) => !ALLOWED_EXEC_ENV.has(key));
  if (unexpected.length > 0) fail(`unexpected environment keys: ${unexpected.sort().join(", ")}`);
}

async function assertStageCwd(stageDir) {
  if (!JOB_ID.test(path.basename(stageDir))) fail(`cwd is not a preparation job stage: ${stageDir}`);
  if (path.basename(path.dirname(stageDir)) !== "autoresearch-jobs") fail(`cwd is outside autoresearch-jobs: ${stageDir}`);
  const workspace = path.join(stageDir, "workspace");
  const info = await stat(workspace).catch((error) => fail(`workspace is missing: ${error.message}`));
  if (!info.isDirectory()) fail("workspace is not a directory");
  return workspace;
}

function parseExecArgs(args, stageDir) {
  if (args.length !== 10) fail(`unexpected exec argument count: ${args.length}`);
  const [command, sandboxFlag, sandbox, ephemeralFlag, jsonFlag, schemaFlag, schemaPath, outputFlag, outputPath, prompt] = args;
  if (command !== "exec") fail(`unexpected command: ${command}`);
  if (sandboxFlag !== "--sandbox" || sandbox !== "workspace-write") fail("unexpected sandbox arguments");
  if (ephemeralFlag !== "--ephemeral") fail("missing --ephemeral");
  if (jsonFlag !== "--json") fail("missing --json");
  if (schemaFlag !== "--output-schema" || !schemaPath.endsWith("schemas/autoresearch-preparation-output.schema.json")) fail(`unexpected schema path: ${schemaPath}`);
  if (outputFlag !== "--output-last-message") fail("missing --output-last-message");
  if (path.resolve(outputPath) !== path.join(stageDir, ".preparation-result.json")) fail(`unexpected output path: ${outputPath}`);
  if (typeof prompt !== "string" || !prompt.includes("Use the repo-local prepare-autoresearch skill.")) fail("prompt does not look like the preparation prompt");
  return { outputPath, prompt };
}

function preflightSource(datasets) {
  return [
    "import { readFileSync } from 'node:fs';",
    "const check = process.argv.at(-1);",
    `const datasets = ${JSON.stringify(datasets)};`,
    "const baseline = { id: 'fixture-baseline', digest: 'e'.repeat(64), score: 7, components: [3, 4] };",
    "const ordinary = { ok: true, score: 7, components: [3, 4], diagnostics: 'fixture passed' };",
    "let result = ordinary;",
    "if (check === 'hard-code-negative') result = { ok: false, diagnostics: 'fixture rejected hard-coded candidate' };",
    "if (check === 'score-arithmetic') result = { ok: true, score: 7, components: [3, 4] };",
    "if (check === 'baseline-reproduction' || check === 'reproducibility') result = { ok: true, score: 7, components: [3, 4], baseline, datasets };",
    "if (check === 'candidate-api') readFileSync('candidate-template/candidate.py');",
    "process.stdout.write(JSON.stringify(result) + '\\n');",
    "",
  ].join("\n");
}

async function writePreparedWorkspace(workspace) {
  const privateFixture = await readFile(new URL("./fake-private/README.fixture", import.meta.url));
  const candidate = "def solve(value):\n    return value\n";
  const publicDataset = JSON.stringify({ public: true, metric: "score" }) + "\n";
  const datasets = {
    public: sha256(publicDataset),
    development: sha256(privateFixture),
    blind: sha256(privateFixture),
  };
  const checker = preflightSource(datasets);

  await mkdir(path.join(workspace, "candidate-template"), { recursive: true });
  await mkdir(path.join(workspace, "datasets"), { recursive: true });
  await mkdir(path.join(workspace, "checks"), { recursive: true });
  await writeFile(path.join(workspace, "candidate-template", "candidate.py"), candidate);
  await writeFile(path.join(workspace, "datasets", "public.json"), publicDataset);
  await writeFile(path.join(workspace, "checks", "preflight.mjs"), checker);

  const files = [
    ["candidate-template/candidate.py", candidate],
    ["checks/preflight.mjs", checker],
    ["datasets/public.json", publicDataset],
  ].map(([relativePath, contents]) => ({
    path: relativePath,
    sha256: sha256(contents),
    size: Buffer.byteLength(contents),
    executable: false,
  }));

  const manifest = {
    schemaVersion: 1,
    kind: "autoresearch-infrastructure",
    problemId: "Prob-001",
    id: "INF-001",
    status: "ready",
    candidate: { templatePath: "candidate-template/candidate.py", writablePaths: ["candidate.py"] },
    objective: { metricId: "score", label: "Fixture score", direction: "maximize", acceptanceThreshold: 7 },
    commands: {
      publicCheck: [process.execPath, "checks/preflight.mjs"],
      containmentCheck: [process.execPath, "checks/preflight.mjs"],
      evaluateDevelopment: [process.execPath, "checks/preflight.mjs"],
      reproduceBaseline: [process.execPath, "checks/preflight.mjs"],
    },
    datasets: {
      public: { manifestPath: "datasets/public.json", digest: datasets.public },
      development: { manifestPath: "README.fixture", digest: datasets.development },
      blind: { manifestPath: "README.fixture", digest: datasets.blind },
    },
    resources: { attemptTimeoutSeconds: 60, terminationGraceSeconds: 5, memoryMb: 256, network: "denied" },
    files,
    createdAt: FIXED_TIME,
  };
  await writeFile(path.join(workspace, "infrastructure.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write("fake-codex 1.0.0\n");
    return;
  }
  if (args.length === 2 && args[0] === "login" && args[1] === "status") {
    process.stdout.write("Logged in as fake autoresearch fixture\n");
    return;
  }
  if (args[0] !== "exec") fail(`unexpected arguments: ${args.join(" ")}`);

  assertExecEnvironment();
  const stageDir = process.cwd();
  const workspace = await assertStageCwd(stageDir);
  const { outputPath, prompt } = parseExecArgs(args, stageDir);
  const hasMetricAnswer = /"metric"\s*:\s*"score"/.test(prompt);

  process.stdout.write(`${JSON.stringify({ type: "event", stage: hasMetricAnswer ? "prepared" : "needs-input" })}\n`);

  if (!hasMetricAnswer) {
    await writeFile(outputPath, JSON.stringify({
      outcome: "needs_input",
      summary: "The fake benchmark needs the objective metric before it can finish.",
      manifestPath: null,
      question: {
        id: "metric",
        prompt: "Which fixture metric should the benchmark optimize?",
        answerType: "choice",
        choices: ["score", "loss"],
      },
    }));
    return;
  }

  await writePreparedWorkspace(workspace);
  await writeFile(outputPath, JSON.stringify({
    outcome: "prepared",
    summary: "Prepared deterministic fake autoresearch infrastructure.",
    manifestPath: "infrastructure.json",
    question: null,
  }));
}

await main();

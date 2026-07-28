import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PREFLIGHT_CHECK_IDS, runInfrastructurePreflight } from "../lib/autoresearch/preflight.mjs";

const CANARY = "PRIVATE-CANARY-8eafbd8e";
const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, { outcomes = {}, tamper = null, assertRuntimeIsolation = false, evaluatorWrites = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stageDir = join(root, "stage");
  const privateDataRoot = join(root, "private");
  await mkdir(join(stageDir, "candidate-template"), { recursive: true });
  await mkdir(join(stageDir, "datasets"), { recursive: true });
  await mkdir(privateDataRoot, { recursive: true });
  await writeFile(join(stageDir, "candidate-template", "candidate.py"), "def solve(x): return x\n");
  await writeFile(join(stageDir, "datasets", "public.json"), '{"public":true}\n');
  await writeFile(join(privateDataRoot, "development.json"), `{\"development\":\"${CANARY}\"}\n`);
  await writeFile(join(privateDataRoot, "blind.json"), '{"blind":true}\n');
  const command = join(root, "fixture-command.mjs");
  const candidate = await readFile(join(stageDir, "candidate-template", "candidate.py"));
  const publicData = await readFile(join(stageDir, "datasets", "public.json"));
  const development = await readFile(join(privateDataRoot, "development.json"));
  const blind = await readFile(join(privateDataRoot, "blind.json"));
  const datasets = { public: digest(publicData), development: digest(development), blind: digest(blind) };
  await writeFile(command, [
    "const check = process.argv.at(-1);",
    `const outcomes = ${JSON.stringify(outcomes)};`,
    `const datasets = ${JSON.stringify(datasets)};`,
    "const evaluator = new Set(['correctness-negative', 'hard-code-negative', 'baseline-reproduction', 'score-arithmetic', 'reproducibility']).has(check);",
    `const isolated = !${JSON.stringify(assertRuntimeIsolation)} || (evaluator ? typeof process.env.AUTORESEARCH_PRIVATE_ROOT === 'string' && process.env.AUTORESEARCH_PRIVATE_ROOT !== ${JSON.stringify(privateDataRoot)} : !process.env.AUTORESEARCH_PRIVATE_ROOT && !process.env.HOME);`,
    "const baseline = { id: 'baseline-v1', digest: 'e'.repeat(64), score: 7, components: [3, 4] };",
    "const fallback = check === 'hard-code-negative' ? { ok: false } : check === 'baseline-reproduction' ? { ok: true, baseline, datasets } : check === 'reproducibility' ? { ok: true, score: 7, components: [3, 4], baseline, datasets } : check === 'score-arithmetic' ? { ok: true, score: 7, components: [3, 4] } : { ok: true, score: 7, components: [3, 4] };",
    "const result = outcomes[check] ?? fallback;",
    `if (${JSON.stringify(evaluatorWrites)} && evaluator) (await import('node:fs')).writeFileSync(process.env.AUTORESEARCH_PRIVATE_ROOT + '/development.json', 'tampered');`,
    "process.stdout.write(JSON.stringify(isolated ? result : { ok: check === 'hard-code-negative', diagnostics: 'runtime environment was not isolated' }) + '\\n');",
  ].join("\n"));
  await chmod(command, 0o755);
  const manifest = {
    schemaVersion: 1, kind: "autoresearch-infrastructure", problemId: "Prob-007", id: "INF-001", status: "ready",
    candidate: { templatePath: "candidate-template/candidate.py", writablePaths: ["candidate.py"] },
    objective: { metricId: "score", label: "Score", direction: "maximize", acceptanceThreshold: 1 },
    commands: {
      publicCheck: [process.execPath, command], containmentCheck: [process.execPath, command],
      evaluateDevelopment: [process.execPath, command], reproduceBaseline: [process.execPath, command],
    },
    datasets: {
      public: { manifestPath: "datasets/public.json", digest: datasets.public },
      development: { manifestPath: "development.json", digest: datasets.development },
      blind: { manifestPath: "blind.json", digest: datasets.blind },
    },
    resources: { attemptTimeoutSeconds: 60, terminationGraceSeconds: 5, memoryMb: 256, network: "denied" },
    files: [{ path: "candidate-template/candidate.py", sha256: digest(candidate), size: candidate.length, executable: false }],
    createdAt: "2026-07-28T08:00:00.000Z",
  };
  if (tamper === "digest") manifest.files[0].sha256 = "0".repeat(64);
  return { stageDir, privateDataRoot, manifest };
}

function runner(calls) {
  return async (options) => {
    calls.push(options);
    const { runProcess } = await import("../lib/autoresearch/process.mjs");
    return runProcess(options);
  };
}

async function treeText(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const text = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) text.push(...await treeText(path));
    else if (entry.isFile()) text.push(await readFile(path, "utf8"));
  }
  return text.join("\n");
}

test("runs the stable host-owned suite with isolated candidate and evaluator inputs", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const report = await runInfrastructurePreflight({ ...value, processRunner: runner(calls), now: () => FIXED_NOW });

  assert.deepEqual(PREFLIGHT_CHECK_IDS, [
    "manifest-integrity", "clean-environment", "candidate-api", "public-smoke", "correctness-negative", "hard-code-negative", "crash-negative", "timeout-negative", "containment", "private-data-isolation", "baseline-reproduction", "score-arithmetic", "reproducibility",
  ]);
  assert.deepEqual(report.checks.map((check) => check.id), PREFLIGHT_CHECK_IDS);
  assert.equal(report.status, "passed");
  assert.equal(report.startedAt, FIXED_NOW.toISOString());
  assert.equal(report.completedAt, FIXED_NOW.toISOString());
  assert.equal(report.attemptRuntimeUpperBoundSeconds, 65);
  assert.ok(report.checks.every((check) => check.status === "passed" && Number.isFinite(check.durationMs) && Array.isArray(check.diagnostics)));
  assert.ok(calls.every((call) => call.shell === false && call.cwd === value.stageDir && call.timeoutMs === 60_000));
  const candidateCalls = calls.filter((call) => call.privateDataRoot === undefined);
  assert.ok(candidateCalls.length > 0);
  assert.ok(candidateCalls.every((call) => !call.args.includes(value.privateDataRoot) && !Object.values(call.env).includes(value.privateDataRoot)));
  const evaluatorCalls = calls.filter((call) => call.privateDataRoot !== undefined);
  assert.ok(evaluatorCalls.length > 0);
  assert.ok(evaluatorCalls.every((call) => typeof call.privateDataRoot === "string" && call.privateDataRoot !== value.privateDataRoot));
  assert.doesNotMatch(`${JSON.stringify(report)}\n${await treeText(value.stageDir)}`, new RegExp(CANARY));
});

test("default runner mounts the private root only for evaluator commands and keeps candidate environment HOME-free", async (t) => {
  const value = await fixture(t, { assertRuntimeIsolation: true });
  const report = await runInfrastructurePreflight({ ...value, now: () => FIXED_NOW });
  assert.equal(report.status, "passed");
});

test("fails closed on integrity or containment failure and records escaped diagnostics", async (t) => {
  const value = await fixture(t, { tamper: "digest" });
  const calls = [];
  const report = await runInfrastructurePreflight({ ...value, processRunner: runner(calls), now: () => FIXED_NOW });
  assert.equal(report.status, "failed");
  assert.equal(report.checks[0].status, "failed");
  assert.equal(calls.length, 0);

  const containment = await fixture(t, { outcomes: { containment: { ok: false, diagnostics: "<unsafe>\n".repeat(400) } } });
  const containmentReport = await runInfrastructurePreflight({ ...containment, processRunner: runner([]), now: () => FIXED_NOW });
  const check = containmentReport.checks.find((item) => item.id === "containment");
  assert.equal(containmentReport.status, "failed");
  assert.equal(check.status, "failed");
  assert.match(check.diagnostics[0], /&lt;unsafe&gt;/);
  assert.ok(check.diagnostics[0].length <= 1024);
});

test("marks semantic benchmark defects as failed without short-circuiting safe checks", async (t) => {
  for (const [check, outcome] of Object.entries({
    "correctness-negative": { ok: false }, "hard-code-negative": { ok: true }, "baseline-reproduction": { ok: false }, "score-arithmetic": { ok: false },
  })) {
    const value = await fixture(t, { outcomes: { [check]: outcome } });
    const report = await runInfrastructurePreflight({ ...value, processRunner: runner([]), now: () => FIXED_NOW });
    assert.equal(report.status, "failed", check);
    assert.equal(report.checks.find((item) => item.id === check).status, "failed", check);
    assert.equal(report.checks.at(-1).id, "reproducibility");
  }
});

test("independently rejects fabricated score arithmetic and baseline identity drift", async (t) => {
  const score = await fixture(t, { outcomes: { "score-arithmetic": { ok: true, score: 7, components: [2, 2] } } });
  const scoreReport = await runInfrastructurePreflight({ ...score, processRunner: runner([]), now: () => FIXED_NOW });
  assert.equal(scoreReport.checks.find((check) => check.id === "score-arithmetic").status, "failed");

  const baseline = await fixture(t, { outcomes: {
    "baseline-reproduction": [
      { ok: true, baseline: { id: "baseline-v1", digest: "e".repeat(64), score: 7 } },
      { ok: true, baseline: { id: "baseline-v2", digest: "f".repeat(64), score: 7 } },
    ],
  } });
  const counts = new Map();
  const baselineRunner = async (options) => {
    const check = options.args.at(-1);
    const configured = check === "baseline-reproduction" ? [
      { ok: true, baseline: { id: "baseline-v1", digest: "e".repeat(64), score: 7 } },
      { ok: true, baseline: { id: "baseline-v2", digest: "f".repeat(64), score: 7 } },
    ][counts.get(check) ?? 0] : null;
    counts.set(check, (counts.get(check) ?? 0) + 1);
    if (configured) return { stdout: JSON.stringify(configured) };
    return runner([])(options);
  };
  const baselineReport = await runInfrastructurePreflight({ ...baseline, processRunner: baselineRunner, now: () => FIXED_NOW });
  assert.equal(baselineReport.checks.find((check) => check.id === "baseline-reproduction").status, "failed");
});

test("isolates evaluator writes from the operator-owned private root", async (t) => {
  const value = await fixture(t, { evaluatorWrites: true });
  const before = await readFile(join(value.privateDataRoot, "development.json"), "utf8");
  const report = await runInfrastructurePreflight({ ...value, now: () => FIXED_NOW });
  assert.equal(await readFile(join(value.privateDataRoot, "development.json"), "utf8"), before);
  assert.equal(report.status, "failed");
  assert.ok(report.checks.some((check) => check.status === "failed"));
});

test("rejects stable evaluator claims that are not bound to manifest dataset digests", async (t) => {
  const value = await fixture(t, { outcomes: {
    "baseline-reproduction": { ok: true, baseline: { id: "baseline-v1", digest: "e".repeat(64), score: 7, components: [3, 4] }, datasets: { public: "0".repeat(64), development: "0".repeat(64), blind: "0".repeat(64) } },
  } });
  const report = await runInfrastructurePreflight({ ...value, processRunner: runner([]), now: () => FIXED_NOW });
  assert.equal(report.checks.find((check) => check.id === "baseline-reproduction").status, "failed");
});

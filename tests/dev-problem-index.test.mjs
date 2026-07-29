import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ensureProblemWatchDir, main, watchProblemFiles } from "../scripts/dev-problem-index.mjs";
import { buildAutoresearchProxy, buildLocalServiceProxy } from "../vite.config.ts";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for watcher reconciliation.");
}

test("ensures the dev watcher uses problems/ when the repo starts without one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "research-loop-dev-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const watchPath = await ensureProblemWatchDir(root);

  assert.equal(watchPath, join(root, "problems"));
  assert.equal((await stat(watchPath)).isDirectory(), true);
});

test("dev index builds reserve the showcase problem ID", async () => {
  const { runIndexBuild } = await import("../scripts/dev-problem-index.mjs");
  assert.equal(typeof runIndexBuild, "function");

  const calls = [];
  function spawnFn(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  }

  await runIndexBuild("/tmp/research-loop-dev-root", spawnFn);

  assert.deepEqual(calls, [{
    command: process.execPath,
    args: ["scripts/build-problem-index.mjs", "--reserve-id", "Prob-000"],
    options: { cwd: "/tmp/research-loop-dev-root", stdio: "inherit" },
  }]);
});

test("dev wrapper starts assessment by default and omits autoresearch without private root", async () => {
  const calls = [];
  const signals = new EventEmitter();
  const vinext = new EventEmitter();
  vinext.kill = (signal) => { calls.push({ kill: signal }); };
  const spawnFn = (command, args, options) => { calls.push({ command, args, options }); return vinext; };
  await main({
    rootDir: "/tmp/research-loop-dev-root",
    environment: { PATH: "/test/bin" },
    runIndexBuildFn: async (...args) => calls.push({ index: args }),
    watchProblemFilesFn: async () => ({ close() { calls.push("watch-close"); } }),
    startAssessmentServiceFn: async ({ rootDir, token }) => {
      calls.push({ assessment: { rootDir, tokenLength: token.length } });
      return { url: "http://127.0.0.1:39001", close: async () => calls.push("assessment-close") };
    },
    startAutoresearchServiceFn: async () => assert.fail("autoresearch service should not start without AUTORESEARCH_PRIVATE_ROOT"),
    spawnFn,
    processRef: signals,
  });

  assert.equal(calls[0].index[0], "/tmp/research-loop-dev-root");
  assert.equal(calls[0].index[1], spawnFn);
  assert.deepEqual(calls[0].index[2], { outputRootDir: "/tmp/research-loop-dev-root" });
  assert.deepEqual(calls[1], { assessment: { rootDir: "/tmp/research-loop-dev-root", tokenLength: 32 } });
  assert.equal(calls[2].command, "vinext");
  assert.deepEqual(calls[2].args, ["dev"]);
  assert.equal(calls[2].options.cwd, "/tmp/research-loop-dev-root");
  assert.equal(calls[2].options.stdio, "inherit");
  assert.equal(calls[2].options.env.LOCAL_ASSESSMENT_SERVICE_URL, "http://127.0.0.1:39001");
  assert.match(calls[2].options.env.LOCAL_ASSESSMENT_PROXY_TOKEN, /^[a-f0-9]{32}$/);
  assert.equal(calls[2].options.env.PATH, "/test/bin");
  assert.equal(calls[2].options.env.WRANGLER_LOG_PATH, ".wrangler/wrangler.log");
  assert.equal(calls[2].options.env.AUTORESEARCH_SERVICE_ORIGIN, undefined);
  vinext.emit("exit", 0, null);
  await delay(0);
  assert.deepEqual(calls.slice(-2), ["watch-close", "assessment-close"]);
  signals.emit("SIGINT");
});

test("dev supervision starts assessment and autoresearch sidecars when private root is configured", async () => {
  const calls = [];
  const signals = new EventEmitter();
  const vinext = new EventEmitter();
  vinext.kill = (signal) => { calls.push({ kill: signal }); };
  const spawnFn = (command, args, options) => { calls.push({ command, args, options }); return vinext; };

  await main({
    rootDir: "/tmp/research-loop-dev-root",
    environment: {
      AUTORESEARCH_PRIVATE_ROOT: "/private/data",
      AUTORESEARCH_WORKSPACE_ROOT: "/tmp/research-loop-fixture-root",
      AUTORESEARCH_CODEX_PATH: "/fake/codex",
      AUTORESEARCH_DEV_HOST: "localhost",
      AUTORESEARCH_DEV_PORT: "4174",
      PATH: "/test/bin",
    },
    runIndexBuildFn: async (...args) => calls.push({ index: args }),
    watchProblemFilesFn: async ({ rootDir }) => ({ close() { calls.push({ watchClosedFor: rootDir }); } }),
    startAssessmentServiceFn: async ({ rootDir, token }) => {
      calls.push({ assessment: { rootDir, tokenLength: token.length } });
      return { url: "http://127.0.0.1:39001", close: async () => calls.push("assessment-close") };
    },
    startAutoresearchServiceFn: async (options) => {
      calls.push({ autoresearch: options });
      return { origin: "http://127.0.0.1:9123", token: "capability", close: async () => calls.push("autoresearch-close") };
    },
    spawnFn,
    processRef: signals,
  });

  assert.equal(calls[0].index[0], "/tmp/research-loop-fixture-root");
  assert.equal(calls[0].index[1], spawnFn);
  assert.deepEqual(calls[0].index[2], { outputRootDir: "/tmp/research-loop-dev-root" });
  assert.deepEqual(calls[2].autoresearch, {
    rootDir: "/tmp/research-loop-fixture-root",
    privateDataRoot: "/private/data",
    codexPath: "/fake/codex",
    schemaPath: undefined,
    indexOutputRoot: "/tmp/research-loop-dev-root",
  });
  const vinextCall = calls.find((call) => call.command === "vinext");
  assert.deepEqual(vinextCall.args, ["dev", "--host", "localhost", "--port", "4174"]);
  assert.equal(vinextCall.options.env.LOCAL_ASSESSMENT_SERVICE_URL, "http://127.0.0.1:39001");
  assert.equal(vinextCall.options.env.AUTORESEARCH_SERVICE_ORIGIN, "http://127.0.0.1:9123");
  assert.equal(vinextCall.options.env.AUTORESEARCH_CAPABILITY_TOKEN, "capability");
  assert.equal(vinextCall.options.env.AUTORESEARCH_PRIVATE_ROOT, undefined);
  assert.equal(vinextCall.options.env.AUTORESEARCH_WORKSPACE_ROOT, undefined);
  assert.equal(vinextCall.options.env.AUTORESEARCH_CODEX_PATH, undefined);

  signals.emit("SIGINT");
  await delay(0);
  assert.deepEqual(calls.slice(-4), [
    { kill: "SIGINT" },
    { watchClosedFor: "/tmp/research-loop-fixture-root" },
    "assessment-close",
    "autoresearch-close",
  ]);
});

test("autoresearch supervision rejects every non-loopback dev host form before startup", async () => {
  const cases = [
    { environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data", AUTORESEARCH_DEV_HOST: "0.0.0.0" }, vinextDevArgs: [] },
    { environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" }, vinextDevArgs: ["--host", "0.0.0.0"] },
    { environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" }, vinextDevArgs: ["--host=0.0.0.0"] },
    { environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" }, vinextDevArgs: ["--host"] },
    { environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" }, vinextDevArgs: ["--hostname", "::"] },
  ];

  for (const options of cases) {
    let started = false;
    await assert.rejects(() => main({
      rootDir: "/tmp/research-loop-dev-root",
      ...options,
      runIndexBuildFn: async () => { started = true; },
      watchProblemFilesFn: async () => { started = true; return { close() {} }; },
      startAssessmentServiceFn: async () => { started = true; return { url: "http://127.0.0.1", close: async () => {} }; },
      startAutoresearchServiceFn: async () => { started = true; return { origin: "http://127.0.0.1", token: "token", close: async () => {} }; },
      spawnFn: () => { started = true; return new EventEmitter(); },
      processRef: new EventEmitter(),
    }), /loopback/i);
    assert.equal(started, false);
  }
});

test("dev supervision closes assessment when autoresearch startup fails", async () => {
  let spawned = false;
  let assessmentClosed = 0;
  await assert.rejects(() => main({
    rootDir: "/tmp/research-loop-dev-root",
    environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" },
    runIndexBuildFn: async () => {},
    watchProblemFilesFn: async () => ({ close() {} }),
    startAssessmentServiceFn: async () => ({
      url: "http://127.0.0.1:39001",
      close: async () => { assessmentClosed += 1; },
    }),
    startAutoresearchServiceFn: async () => { throw new Error("autoresearch unavailable"); },
    spawnFn() { spawned = true; },
    processRef: new EventEmitter(),
  }), /autoresearch unavailable/);
  assert.equal(assessmentClosed, 1);
  assert.equal(spawned, false);
});

test("dev wrapper forwards vinext dev arguments", async () => {
  const spawnCalls = [];
  const child = new EventEmitter();
  child.kill = () => {};
  function spawnFn(command, args, options) {
    spawnCalls.push({ command, args, options });
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  }

  await main({
    rootDir: "/tmp/research-loop-dev-root",
    environment: {},
    spawnFn,
    runIndexBuildFn: async () => {},
    watchProblemFilesFn: async () => ({ close() {} }),
    startAssessmentServiceFn: async () => ({
      url: "http://127.0.0.1:39001",
      token: "token-123",
      close: async () => {},
    }),
    vinextDevArgs: ["--port", "4174", "--hostname", "127.0.0.1"],
  });

  const vinext = spawnCalls.find((call) => call.command === "vinext");
  assert.deepEqual(vinext.args, ["dev", "--port", "4174", "--hostname", "127.0.0.1"]);
});

test("dev wrapper closes sidecars and watcher when vinext emits an error", async (t) => {
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  const child = new EventEmitter();
  child.kill = () => {};
  let assessmentClosed = 0;
  let autoresearchClosed = 0;
  let watcherClosed = 0;

  await main({
    rootDir: "/tmp/research-loop-dev-root",
    environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" },
    spawnFn: () => child,
    runIndexBuildFn: async () => {},
    watchProblemFilesFn: async () => ({ close() { watcherClosed += 1; } }),
    startAssessmentServiceFn: async () => ({
      url: "http://127.0.0.1:39001",
      close: async () => { assessmentClosed += 1; },
    }),
    startAutoresearchServiceFn: async () => ({
      origin: "http://127.0.0.1:9123",
      token: "capability",
      close: async () => { autoresearchClosed += 1; },
    }),
  });

  child.emit("error", new Error("vinext unavailable"));
  await delay(0);

  assert.equal(assessmentClosed, 1);
  assert.equal(autoresearchClosed, 1);
  assert.equal(watcherClosed, 1);
  assert.equal(process.exitCode, 1);
});

test("dev wrapper closes started sidecars when watcher startup rejects", async () => {
  let spawned = false;
  let assessmentClosed = 0;
  let autoresearchClosed = 0;
  await assert.rejects(() => main({
    rootDir: "/tmp/research-loop-dev-root",
    environment: { AUTORESEARCH_PRIVATE_ROOT: "/private/data" },
    runIndexBuildFn: async () => {},
    startAssessmentServiceFn: async () => ({
      url: "http://127.0.0.1:39001",
      close: async () => { assessmentClosed += 1; },
    }),
    startAutoresearchServiceFn: async () => ({
      origin: "http://127.0.0.1:9123",
      token: "capability",
      close: async () => { autoresearchClosed += 1; },
    }),
    watchProblemFilesFn: async () => { throw new Error("watch unavailable"); },
    spawnFn() { spawned = true; },
    processRef: new EventEmitter(),
  }), /watch unavailable/);
  assert.equal(assessmentClosed, 1);
  assert.equal(autoresearchClosed, 1);
  assert.equal(spawned, false);
});

test("Vite proxies local assessment and autoresearch routes without merging credentials", () => {
  assert.equal(buildAutoresearchProxy({}), undefined);
  assert.deepEqual(buildAutoresearchProxy({ origin: "http://127.0.0.1:9123", token: "capability" }), {
    "/__local/autoresearch": {
      target: "http://127.0.0.1:9123",
      changeOrigin: true,
      headers: { "x-research-loop-capability": "capability" },
    },
  });
  assert.deepEqual(buildLocalServiceProxy({
    assessmentTarget: "http://127.0.0.1:39001",
    assessmentToken: "assessment-token",
    autoresearchOrigin: "http://127.0.0.1:9123",
    autoresearchToken: "autoresearch-token",
  }), {
    "/__local/assessments": {
      target: "http://127.0.0.1:39001",
      changeOrigin: false,
      headers: { "x-local-assessment-token": "assessment-token" },
    },
    "/__local/autoresearch": {
      target: "http://127.0.0.1:9123",
      changeOrigin: true,
      headers: { "x-research-loop-capability": "autoresearch-token" },
    },
  });
});

test("manual service help documents the required private root", async () => {
  const makefile = await readFile(join(process.cwd(), "Makefile"), "utf8");
  assert.match(makefile, /AUTORESEARCH_PRIVATE_ROOT/);
});

test("watches the problems/ tree without recursive repo-wide watchers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "research-loop-dev-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "problems", "Prob-001"), { recursive: true });

  const watched = [];
  const watcher = await watchProblemFiles({
    rootDir: root,
    onChange: () => {},
    watchFn(path, options) {
      watched.push({ path, options });
      return {
        close() {},
        on() {
          return this;
        },
      };
    },
  });
  t.after(() => watcher.close());

  assert.deepEqual(
    watched.map((item) => item.path).sort(),
    [join(root, "problems"), join(root, "problems", "Prob-001")],
  );
  assert.equal(watched[0].path, join(root, "problems"));
  assert.equal(watched.some((item) => item.path === root), false);
  assert.deepEqual(watched.map((item) => item.options), [{ recursive: false }, { recursive: false }]);
});

test("watches research manifests and attempt manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "research-loop-dev-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "problems", "Prob-001", "attempts", "ATT-001"), { recursive: true });
  await mkdir(join(root, "problems", "Prob-001", "infrastructure", "cohorts"), { recursive: true });

  const watches = [];
  let changes = 0;
  const watcher = await watchProblemFiles({
    rootDir: root,
    onChange: () => { changes += 1; },
    watchFn(path, options, callback) {
      watches.push({ path, options, callback });
      return { close() {} };
    },
  });
  t.after(() => watcher.close());

  assert.ok(watches.some((item) => item.path === join(root, "problems", "Prob-001")));
  assert.ok(watches.some((item) => item.path === join(root, "problems", "Prob-001", "attempts")));
  assert.ok(watches.some((item) => item.path === join(root, "problems", "Prob-001", "attempts", "ATT-001")));
  assert.ok(watches.some((item) => item.path === join(root, "problems", "Prob-001", "infrastructure", "cohorts")));

  const attemptWatch = watches.find((item) => item.path === join(root, "problems", "Prob-001", "attempts", "ATT-001"));
  attemptWatch.callback("change", "candidate.py");
  attemptWatch.callback("change", "attempt.json");
  assert.equal(changes, 1);
});

test("registers newly created attempt directories and rebuilds for their manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "research-loop-dev-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptsPath = join(root, "problems", "Prob-001", "attempts");
  const newAttemptPath = join(attemptsPath, "ATT-002");
  await mkdir(attemptsPath, { recursive: true });

  const watches = [];
  let changes = 0;
  const watcher = await watchProblemFiles({
    rootDir: root,
    onChange: () => { changes += 1; },
    watchFn(path, options, callback) {
      const record = { callback, closed: false, options, path };
      watches.push(record);
      return { close() { record.closed = true; } };
    },
  });
  t.after(() => watcher.close());

  await mkdir(newAttemptPath);
  const attemptsWatch = watches.find((item) => item.path === attemptsPath && !item.closed);
  attemptsWatch.callback("rename", "ATT-002");
  await waitFor(() => watches.some((item) => item.path === newAttemptPath && !item.closed));

  changes = 0;
  const newAttemptWatch = watches.find((item) => item.path === newAttemptPath && !item.closed);
  newAttemptWatch.callback("change", "attempt.json");
  assert.equal(changes, 1);
});

test("reconciles problem directories and rebuilds only for index inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "research-loop-dev-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "problems", "Prob-001"), { recursive: true });

  const watches = [];
  let changes = 0;
  const watcher = await watchProblemFiles({
    rootDir: root,
    onChange: () => {
      changes += 1;
    },
    watchFn(path, options, callback) {
      const record = { callback, closed: false, options, path };
      watches.push(record);
      return {
        close() {
          record.closed = true;
        },
      };
    },
  });
  t.after(() => watcher.close());

  const rootWatch = watches.find((item) => item.path === join(root, "problems"));
  const firstProblemWatch = watches.find((item) => item.path === join(root, "problems", "Prob-001"));

  await mkdir(join(root, "problems", "Prob-002"));
  rootWatch.callback("rename", "Prob-002");
  await waitFor(() => watches.some((item) => item.path === join(root, "problems", "Prob-002")));

  await rm(join(root, "problems", "Prob-001"), { recursive: true });
  rootWatch.callback("rename", "Prob-001");
  await waitFor(() => firstProblemWatch.closed);

  await mkdir(join(root, "problems", ".generated"));
  rootWatch.callback("rename", ".generated");
  await delay(10);
  assert.equal(watches.some((item) => item.path === join(root, "problems", ".generated")), false);

  changes = 0;
  const secondProblemWatch = watches.find((item) => item.path === join(root, "problems", "Prob-002"));
  secondProblemWatch.callback("change", "notes.txt");
  secondProblemWatch.callback("change", "problem.json");
  secondProblemWatch.callback("change", "problem.md");

  assert.equal(changes, 2);
});

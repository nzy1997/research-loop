import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ensureProblemWatchDir, main, watchProblemFiles } from "../scripts/dev-problem-index.mjs";
import { buildAutoresearchProxy } from "../vite.config.ts";

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

test("dev supervision starts the service before vinext, scopes its capability, and closes both children", async () => {
  const calls = [];
  const signals = new EventEmitter();
  const serviceChild = { closeCalls: 0, async close() { this.closeCalls += 1; } };
  const vinext = new EventEmitter();
  vinext.kill = (signal) => { calls.push({ kill: signal }); };
  await main({
    rootDir: "/tmp/research-loop-dev-root",
    runIndexBuildFn: async () => calls.push("index"),
    watchProblemFilesFn: async () => ({ close() { calls.push("watch-close"); } }),
    startService: async () => { calls.push("service"); return { origin: "http://127.0.0.1:9123", token: "capability", close: serviceChild.close.bind(serviceChild) }; },
    spawnFn(command, args, options) { calls.push({ command, args, options }); return vinext; },
    processRef: signals,
    environment: { AUTORESEARCH_PRIVATE_DATA_ROOT: "/private/data", PATH: "/test/bin" },
  });
  assert.equal(calls[1], "service");
  assert.deepEqual(calls[2], {
    command: "vinext",
    args: ["dev"],
    options: {
      cwd: "/tmp/research-loop-dev-root",
      env: { AUTORESEARCH_CAPABILITY_TOKEN: "capability", AUTORESEARCH_SERVICE_ORIGIN: "http://127.0.0.1:9123", PATH: "/test/bin", WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
      stdio: "inherit",
    },
  });
  signals.emit("SIGINT");
  await delay(0);
  assert.deepEqual(calls.at(-1), { kill: "SIGINT" });
  assert.equal(serviceChild.closeCalls, 1);
  signals.emit("SIGTERM");
  await delay(0);
  assert.equal(serviceChild.closeCalls, 1);
});

test("dev supervision does not launch vinext when service startup fails", async () => {
  let spawned = false;
  await assert.rejects(() => main({
    rootDir: "/tmp/research-loop-dev-root",
    runIndexBuildFn: async () => {},
    watchProblemFilesFn: async () => ({ close() {} }),
    startService: async () => { throw new Error("service unavailable"); },
    spawnFn() { spawned = true; },
    processRef: new EventEmitter(),
  }), /service unavailable/);
  assert.equal(spawned, false);
});

test("dev supervision closes the service when watcher startup fails", async () => {
  let spawned = false;
  const service = { closes: 0, async close() { this.closes += 1; } };
  await assert.rejects(() => main({
    rootDir: "/tmp/research-loop-dev-root",
    runIndexBuildFn: async () => {},
    startService: async () => ({ origin: "http://127.0.0.1:9123", token: "capability", close: service.close.bind(service) }),
    watchProblemFilesFn: async () => { throw new Error("watch unavailable"); },
    spawnFn() { spawned = true; },
    processRef: new EventEmitter(),
  }), /watch unavailable/);
  assert.equal(service.closes, 1);
  assert.equal(spawned, false);
});

test("Vite proxies only local autoresearch routes and overwrites the browser capability", () => {
  assert.equal(buildAutoresearchProxy({}), undefined);
  assert.deepEqual(buildAutoresearchProxy({ origin: "http://127.0.0.1:9123", token: "capability" }), {
    "/__local/autoresearch": {
      target: "http://127.0.0.1:9123",
      changeOrigin: true,
      headers: { "x-research-loop-capability": "capability" },
    },
  });
});

test("manual service help documents the required private data root", async () => {
  const makefile = await readFile(join(process.cwd(), "Makefile"), "utf8");
  assert.match(makefile, /AUTORESEARCH_PRIVATE_DATA_ROOT/);
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

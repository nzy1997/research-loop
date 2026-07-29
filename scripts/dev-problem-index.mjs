import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startAssessmentService } from "./local-assessment-service.mjs";
import { startService as startLocalAutoresearchService } from "./local-autoresearch-service.mjs";

const ignoredRoots = new Set([".generated", ".git", "node_modules", ".next", ".vinext", "dist", ".wrangler"]);
const RESEARCH_INDEX_FILENAMES = new Set([
  "problem.json",
  "problem.md",
  "research.json",
  "import-manifest.json",
]);
const ATTEMPT_INDEX_FILENAMES = new Set(["attempt.json"]);
const COHORT_INDEX_FILENAMES = new Set(["cohort-001-100.json", "cohort-101-200.json"]);
const LOOPBACK_DEV_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function devHostArguments(args) {
  const hosts = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host" || argument === "--hostname") {
      const value = args[index + 1];
      hosts.push(typeof value === "string" && !value.startsWith("-") ? value : null);
      index += 1;
    } else if (argument.startsWith("--host=") || argument.startsWith("--hostname=")) {
      hosts.push(argument.slice(argument.indexOf("=") + 1));
    }
  }
  return hosts;
}

export function assertAutoresearchDevLoopback({ enabled, configuredHost, args = [] }) {
  if (!enabled) return;
  const hosts = [configuredHost, ...devHostArguments(args)].filter((value) => value !== undefined);
  if (hosts.some((host) => typeof host !== "string" || !LOOPBACK_DEV_HOSTS.has(host))) {
    throw new TypeError("Autoresearch dev server host must be loopback.");
  }
}

export async function ensureProblemWatchDir(rootDir) {
  const problemsPath = join(rootDir, "problems");
  await mkdir(problemsPath, { recursive: true });
  return problemsPath;
}

export async function watchProblemFiles({ rootDir, onChange, watchFn = watch }) {
  const problemsPath = await ensureProblemWatchDir(rootDir);
  const problemWatchers = new Map();
  let closed = false;
  let refresh = Promise.resolve();

  function registerWatcher(watchers, path, filenames, callback = onChange) {
    watchers.push(watchFn(path, { recursive: false }, (_eventType, filename) => {
      const changedName = filename?.toString();
      if (!changedName || filenames.size === 0 || filenames.has(changedName)) callback();
    }));
  }

  async function directoryEntries(path) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function watchProblemDir(name) {
    const problemPath = join(problemsPath, name);
    if (!(await directoryEntries(problemPath))) return;
    const watchers = [];
    watchers.push(watchFn(problemPath, { recursive: false }, (_eventType, filename) => {
      const changedName = filename?.toString();
      if (!changedName || RESEARCH_INDEX_FILENAMES.has(changedName)) onChange();
      if (changedName === "attempts" || changedName === "infrastructure") refreshProblemWatcher(name);
    }));

    const attemptsPath = join(problemPath, "attempts");
    const attemptEntries = await directoryEntries(attemptsPath);
    if (attemptEntries) {
      registerWatcher(watchers, attemptsPath, new Set(), () => {
        refreshProblemWatcher(name);
        onChange();
      });
      for (const entry of attemptEntries) {
        if (entry.isDirectory()) {
          registerWatcher(watchers, join(attemptsPath, entry.name), ATTEMPT_INDEX_FILENAMES);
        }
      }
    }

    const cohortsPath = join(problemPath, "infrastructure", "cohorts");
    const cohortEntries = await directoryEntries(cohortsPath);
    if (cohortEntries) {
      registerWatcher(watchers, cohortsPath, COHORT_INDEX_FILENAMES);
    }

    problemWatchers.set(name, watchers);
  }

  function refreshProblemWatcher(name) {
    refresh = refresh
      .then(async () => {
        const watchers = problemWatchers.get(name);
        if (watchers) {
          for (const watcher of watchers) watcher.close();
          problemWatchers.delete(name);
        }
        if (!closed) await watchProblemDir(name);
      })
      .catch((error) => console.error(error.message));
  }

  async function refreshProblemWatchers() {
    if (closed) return;

    const entries = await readdir(problemsPath, { withFileTypes: true });
    if (closed) return;

    const problemDirs = new Set(
      entries
        .filter((entry) => entry.isDirectory() && !ignoredRoots.has(entry.name))
        .map((entry) => entry.name),
    );

    for (const [name, watchers] of problemWatchers) {
      if (!problemDirs.has(name)) {
        for (const watcher of watchers) watcher.close();
        problemWatchers.delete(name);
      }
    }

    for (const name of problemDirs) {
      if (!problemWatchers.has(name)) await watchProblemDir(name);
    }
  }

  const rootWatcher = watchFn(problemsPath, { recursive: false }, (_eventType, filename) => {
    const changedName = filename?.toString();
    if (changedName && ignoredRoots.has(changedName)) return;

    refresh = refresh
      .then(refreshProblemWatchers)
      .catch((error) => console.error(error.message));
    onChange();
  });

  refresh = refresh.then(refreshProblemWatchers);
  await refresh;

  return {
    close() {
      closed = true;
      rootWatcher.close();
      for (const watchers of problemWatchers.values()) {
        for (const watcher of watchers) watcher.close();
      }
      problemWatchers.clear();
    },
  };
}

export function runIndexBuild(rootDir, spawnFn = spawn, { outputRootDir = rootDir } = {}) {
  return new Promise((resolveBuild, rejectBuild) => {
    const resolvedRootDir = resolve(rootDir);
    const resolvedOutputRootDir = resolve(outputRootDir);
    const args = ["scripts/build-problem-index.mjs", "--reserve-id", "Prob-000"];
    if (resolvedRootDir !== resolvedOutputRootDir) {
      args.splice(
        1,
        0,
        "--root",
        resolvedRootDir,
        "--out",
        join(resolvedOutputRootDir, ".generated", "problem-index.json"),
        "--research-out",
        join(resolvedOutputRootDir, ".generated", "research-index.json"),
      );
    }
    const builder = spawnFn(
      process.execPath,
      args,
      { cwd: resolvedOutputRootDir, stdio: "inherit" },
    );
    builder.on("error", rejectBuild);
    builder.on("exit", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Problem index build exited with status ${code}.`));
    });
  });
}

export async function main({
  rootDir = process.cwd(),
  runIndexBuildFn = runIndexBuild,
  watchProblemFilesFn = watchProblemFiles,
  startAutoresearchServiceFn = startLocalAutoresearchService,
  startAssessmentServiceFn = startAssessmentService,
  spawnFn = spawn,
  processRef = process,
  environment = process.env,
  vinextDevArgs = process.argv.slice(2),
} = {}) {
  const resolvedRootDir = resolve(rootDir);
  const workspaceRootDir = resolve(environment.AUTORESEARCH_WORKSPACE_ROOT ?? resolvedRootDir);
  const privateDataRoot = environment.AUTORESEARCH_PRIVATE_ROOT;
  assertAutoresearchDevLoopback({
    enabled: typeof privateDataRoot === "string" && privateDataRoot.length > 0,
    configuredHost: environment.AUTORESEARCH_DEV_HOST,
    args: vinextDevArgs,
  });

  await runIndexBuildFn(workspaceRootDir, spawnFn, { outputRootDir: resolvedRootDir });

  const assessmentToken = randomBytes(16).toString("hex");
  let timer;
  let watcher;
  let assessmentService;
  let autoresearchService;
  let child;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        watcher?.close();
      } finally {
        clearTimeout(timer);
        const closePromises = [];
        if (assessmentService) closePromises.push(assessmentService.close());
        if (autoresearchService) closePromises.push(autoresearchService.close());
        await Promise.all(closePromises);
      }
    })();
    return cleanupPromise;
  };

  try {
    assessmentService = await startAssessmentServiceFn({
      rootDir: resolvedRootDir,
      token: assessmentToken,
    });

    if (typeof privateDataRoot === "string" && privateDataRoot.length > 0) {
      autoresearchService = await startAutoresearchServiceFn({
        rootDir: workspaceRootDir,
        privateDataRoot,
        codexPath: environment.AUTORESEARCH_CODEX_PATH,
        schemaPath: environment.AUTORESEARCH_SCHEMA_PATH,
        indexOutputRoot: resolvedRootDir,
      });
    }

    watcher = await watchProblemFilesFn({
      rootDir: workspaceRootDir,
      onChange() {
        clearTimeout(timer);
        timer = setTimeout(() => {
          runIndexBuildFn(workspaceRootDir, spawnFn, { outputRootDir: resolvedRootDir }).catch((error) => console.error(error.message));
        }, 150);
      },
    });

    const vinextEnvironment = { ...environment };
    for (const key of [
      "AUTORESEARCH_PRIVATE_ROOT",
      "AUTORESEARCH_WORKSPACE_ROOT",
      "AUTORESEARCH_CODEX_PATH",
      "AUTORESEARCH_SCHEMA_PATH",
      "AUTORESEARCH_INDEX_OUTPUT_ROOT",
      "AUTORESEARCH_DEV_HOST",
      "AUTORESEARCH_DEV_PORT",
    ]) delete vinextEnvironment[key];

    const vinextArgs = ["dev", ...vinextDevArgs];
    const devHost = environment.AUTORESEARCH_DEV_HOST;
    const devPort = environment.AUTORESEARCH_DEV_PORT;
    if (typeof devHost === "string" && devHost.length > 0) vinextArgs.push("--host", devHost);
    if (typeof devPort === "string" && devPort.length > 0) vinextArgs.push("--port", devPort);

    child = spawnFn("vinext", vinextArgs, {
      cwd: resolvedRootDir,
      env: {
        ...vinextEnvironment,
        WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
        LOCAL_ASSESSMENT_SERVICE_URL: assessmentService.url,
        LOCAL_ASSESSMENT_PROXY_TOKEN: assessmentService.token ?? assessmentToken,
        ...(autoresearchService ? {
          AUTORESEARCH_CAPABILITY_TOKEN: autoresearchService.token,
          AUTORESEARCH_SERVICE_ORIGIN: autoresearchService.origin,
        } : {}),
      },
      stdio: "inherit",
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  let stopped = false;
  const stop = (signal) => {
    if (stopped) return;
    stopped = true;
    child.kill(signal);
    cleanup().catch((error) => console.error(error.message));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    processRef.on(signal, () => stop(signal));
  }

  child.on("exit", async (code, signal) => {
    await cleanup();
    processRef.exitCode = code ?? (signal ? 1 : 0);
  });
  child.on("error", async () => {
    await cleanup();
    processRef.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

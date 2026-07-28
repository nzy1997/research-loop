import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function runIndexBuild(rootDir, spawnFn = spawn) {
  return new Promise((resolveBuild, rejectBuild) => {
    const builder = spawnFn(
      process.execPath,
      ["scripts/build-problem-index.mjs", "--reserve-id", "Prob-000"],
      { cwd: rootDir, stdio: "inherit" },
    );
    builder.on("error", rejectBuild);
    builder.on("exit", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Problem index build exited with status ${code}.`));
    });
  });
}

export async function main({ rootDir = process.cwd(), runIndexBuildFn = runIndexBuild, watchProblemFilesFn = watchProblemFiles, startService = startLocalAutoresearchService, spawnFn = spawn, processRef = process, environment = process.env } = {}) {
  const resolvedRootDir = resolve(rootDir);

  await runIndexBuildFn(resolvedRootDir);

  const service = await startService({ rootDir: resolvedRootDir, privateDataRoot: environment.AUTORESEARCH_PRIVATE_DATA_ROOT });
  let serviceClose;
  const closeService = () => {
    serviceClose ??= Promise.resolve(service.close()).catch((error) => console.error(error.message));
    return serviceClose;
  };

  let timer;
  let watcher;
  try {
    watcher = await watchProblemFilesFn({
      rootDir: resolvedRootDir,
      onChange() {
        clearTimeout(timer);
        timer = setTimeout(() => {
          runIndexBuildFn(resolvedRootDir).catch((error) => console.error(error.message));
        }, 150);
      },
    });
  } catch (error) {
    await closeService();
    throw error;
  }

  const { AUTORESEARCH_PRIVATE_DATA_ROOT: _privateDataRoot, ...vinextEnvironment } = environment;
  const child = spawnFn("vinext", ["dev"], {
    cwd: resolvedRootDir,
    env: { ...vinextEnvironment, AUTORESEARCH_CAPABILITY_TOKEN: service.token, AUTORESEARCH_SERVICE_ORIGIN: service.origin, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
    stdio: "inherit",
  });

  let stopped = false;
  const stop = (signal) => {
    if (stopped) return;
    stopped = true;
    closeService();
    child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    processRef.on(signal, () => stop(signal));
  }

  child.on("exit", (code, signal) => {
    watcher.close();
    clearTimeout(timer);
    closeService();
    processRef.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

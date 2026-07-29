import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FAKE_CODEX_BIN = path.join(ROOT, "tests", "fixtures", "fake-codex");

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /local-assessment\.spec\.ts/,
  globalTeardown: "./tests/e2e/local-assessment-teardown.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node --import tsx tests/e2e/local-assessment-dev-server.ts --port ${PORT} --hostname 127.0.0.1`,
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${FAKE_CODEX_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the deployed shape of this repository.
 *
 * They run against the *built* app — `npm run start:test`, the same command the
 * deployment runs — because what they check only exists after a build: the
 * published knowledge site under `/knowledge/`, served by the same Worker that
 * serves the Problem Console at `/`. A dev server would prove neither.
 *
 * The server command builds the browser fixture first. The committed knowledge
 * tree holds only what a user has promoted, which today is one page, so the
 * knowledge tests would have nothing to look at; `npm run build:e2e` renders
 * `tests/fixtures/knowledge/valid` instead and rebuilds the app around it.
 * Chaining it into the server command rather than leaving it to the caller is
 * what makes the served bytes and the asserted bytes the same bytes. The
 * fixture is never committed and never deployed: it lands in the gitignored
 * `public/knowledge`, and `npm test` rebuilds the production tree afterwards.
 *
 * One browser, one platform. Any baseline written under
 * `tests/e2e/*-snapshots/` would be Linux Chromium and nothing else, so the
 * snapshot path carries the platform but not the project name — a second
 * project would silently compare its own rendering against them.
 */

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /knowledge\.spec\.ts/,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build:e2e && npm run start:test",
    url: BASE_URL,
    // Never adopt a server that is already listening: it would be serving some
    // other build, and every assertion here is about what this build serves.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

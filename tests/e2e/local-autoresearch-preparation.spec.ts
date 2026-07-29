import { expect, test } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, ".generated", "autoresearch-e2e", "root");
const PROBLEM_ROOT = path.join(FIXTURE_ROOT, "problems", "Prob-001");

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("local autoresearch preparation reaches ready without mutating problem records or starting attempts", async ({ page }) => {
  const problemJsonPath = path.join(PROBLEM_ROOT, "problem.json");
  const originalProblemJson = await readFile(problemJsonPath, "utf8");

  const initialStatus = page.waitForResponse((response) => (
    response.url().includes("/__local/autoresearch/problems/Prob-001")
    && response.request().method() === "GET"
  ));
  await page.goto("/problems/Prob-001");
  await expect(page.getByRole("heading", { name: "Fixture autoresearch preparation problem" })).toBeVisible();
  await initialStatus;
  await expect(page.getByRole("button", { name: "Prepare autoresearch" })).toBeEnabled();

  const prepareResponse = page.waitForResponse((response) => (
    response.url().includes("/__local/autoresearch/problems/Prob-001/prepare")
    && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "Prepare autoresearch" }).click();
  expect((await prepareResponse).status()).toBe(202);
  await expect(page.getByText(/Preparation queued|Preparing infrastructure/)).toBeVisible();

  await expect(page.getByRole("heading", { name: "Input required" })).toBeVisible({ timeout: 30_000 });
  const metricControl = page.getByLabel("Which fixture metric should the benchmark optimize?");
  await expect(metricControl).toBeVisible();
  await metricControl.selectOption("score");
  await page.getByRole("button", { name: "Provide input" }).click();

  await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("INF-001 passed all preflight checks.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start autoresearch" })).toBeDisabled();

  const infrastructurePath = path.join(PROBLEM_ROOT, "infrastructure", "INF-001", "infrastructure.json");
  await expect.poll(() => exists(infrastructurePath)).toBe(true);
  const infrastructure = JSON.parse(await readFile(infrastructurePath, "utf8"));
  expect(infrastructure).toMatchObject({
    schemaVersion: 1,
    kind: "autoresearch-infrastructure",
    problemId: "Prob-001",
    id: "INF-001",
    status: "ready",
  });

  await expect.poll(() => readFile(problemJsonPath, "utf8")).toBe(originalProblemJson);
  await expect.poll(() => exists(path.join(PROBLEM_ROOT, "attempts"))).toBe(false);
  await expect.poll(() => exists(path.join(PROBLEM_ROOT, "batches"))).toBe(false);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
  await expect(page.getByText("INF-001 passed all preflight checks.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start autoresearch" })).toBeDisabled();
});

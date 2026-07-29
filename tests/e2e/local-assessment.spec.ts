import { expect, test } from "@playwright/test";

import {
  LOCAL_ASSESSMENT_AMBIGUOUS_PROBLEM_ID,
  LOCAL_ASSESSMENT_COMPLETE_PROBLEM_ID,
} from "./local-assessment-fixture";

test("runs local assessment and opens generated report", async ({ context, page }) => {
  await page.goto(`/problems/${LOCAL_ASSESSMENT_COMPLETE_PROBLEM_ID}`);
  await expect(page.getByRole("heading", { name: "No assessment yet" })).toBeVisible();

  await page.getByRole("button", { name: "Run assessment" }).click();
  await expect(
    page.getByRole("heading", { name: /Assessment queued|Assessment running|Assessment complete/ }),
  ).toBeVisible();
  await expect(page.getByText("Recommendation", { exact: true })).toBeVisible({ timeout: 120_000 });

  const reportLink = page.getByRole("link", { name: /Open detailed report/ });
  await expect(reportLink).toBeVisible();
  const reportHref = await reportLink.getAttribute("href");
  expect(reportHref).toMatch(/^\/__local\/assessments\/reports\//);

  const report = await context.newPage();
  await report.goto(reportHref ?? "");
  await expect(report.getByRole("heading", { name: /Research Problem Assessment/ })).toBeVisible();
  await expect(report.getByRole("heading", { name: "Research Value Audit" })).toBeVisible();
  await expect(report.getByText(`Fake Codex completed assessment for ${LOCAL_ASSESSMENT_COMPLETE_PROBLEM_ID}.`)).toBeVisible();
});

test("requires explicit resolver selection for ambiguous knowledge", async ({ page }) => {
  await page.goto(`/problems/${LOCAL_ASSESSMENT_AMBIGUOUS_PROBLEM_ID}`);
  await page.getByRole("button", { name: "Run assessment" }).click();

  await expect(page.getByRole("heading", { name: "Knowledge match needs input" })).toBeVisible({ timeout: 120_000 });
  await page.getByLabel(/knowledge\/solvable\/aklt-chain\/ORACLE\.qmd/).check();
  await page.getByRole("button", { name: "Continue assessment" }).click();

  await expect(page.getByRole("heading", { name: /Assessment complete|Assessment may be stale/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Recommendation", { exact: true })).toBeVisible();
});

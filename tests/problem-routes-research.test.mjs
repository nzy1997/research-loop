import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { execFileSync } from "node:child_process";

import {
  buildAttemptDetailResearchState,
  buildProblemDetailResearchState,
} from "../lib/problems/research-route-data.mjs";

const problem = {
  id: "Prob-001",
  title: "AutoQEC CSS-distance autoresearch record",
  summary: "Imported 200-trial CSS-distance experiment history.",
  status: "solved",
};

const attempt101 = {
  problemId: "Prob-001",
  id: "ATT-101",
  sequence: 101,
  cohort: "cohort-101-200",
  title: "CSS Distance Proposal 101",
  summary: "Imported AutoQEC trial record.",
  stage: "development",
  decision: "rejected",
  gate: { containment: "passed", publicContract: "failed", development: "failed" },
  method: { description: "Proposal contract failure", learnedFrom: null },
  metrics: { runs: 0, verifiedWitnesses: 0, targetHits: 0, timeouts: 0, crashes: 0, invalidClaims: 1, weightedTargetHits: 0, normalizedQuality: 0, runtimeSeconds: null, averageSeconds: null, medianSeconds: null, p95Seconds: null, timingStatus: "not-run", speedup: null },
  provenance: { sourceRepository: "AutoQEC", sourceBranch: "autoresearch/css-distance/run200-proposal-101", sourceCommit: "a".repeat(40), sourceInfrastructureCommit: "12a8f794f68d63f07303df0cc38fa244c1ab1248", sourceCohort: "cohort-101-200", model: null },
  candidate: { status: "not-generated" },
  artifacts: [{ path: "LOG.md", sha256: "b".repeat(64), sourcePath: "LOG.md" }],
};

const record = {
  problemId: "Prob-001",
  manifest: {
    problemId: "Prob-001",
    disclaimer: "Imported experimental record - not reviewed knowledge.",
  },
  attempts: [attempt101],
};

test("problem detail state chooses the real research ledger when a record exists", () => {
  const state = buildProblemDetailResearchState({ problem, researchRecord: record, diagnostics: [] });

  assert.equal(state.kind, "research");
  assert.equal(state.problem.id, "Prob-001");
  assert.equal(state.ledger.rows.length, 1);
  assert.equal(state.ledger.rows[0].id, "ATT-101");
  assert.equal(state.disclaimer, "Imported experimental record - not reviewed knowledge.");
});

test("problem detail state exposes integrity diagnostics instead of a partial ledger", () => {
  const state = buildProblemDetailResearchState({
    problem,
    researchRecord: null,
    diagnostics: [{ relativePath: "problems/Prob-001/attempts/ATT-101/attempt.json", field: "metrics", message: "bad metrics" }],
  });

  assert.equal(state.kind, "research-diagnostics");
  assert.match(state.diagnostics[0].message, /bad metrics/);
});

test("attempt detail state returns dossiers for known attempts and not-found for unknown attempts", () => {
  const found = buildAttemptDetailResearchState({ problem, researchRecord: record, attemptId: "ATT-101" });
  assert.equal(found.kind, "research-attempt");
  assert.equal(found.dossier.id, "ATT-101");
  assert.equal(found.dossier.candidate.message, "Candidate code was not generated.");

  const missing = buildAttemptDetailResearchState({ problem, researchRecord: record, attemptId: "ATT-999" });
  assert.equal(missing.kind, "not-found");
});

test("problem routes place the local preparation panel between headers and research detail", async () => {
  const page = await readFile(new URL("../app/problems/[id]/page.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../app/problems/[id]/autoresearch-panel.tsx", import.meta.url), "utf8");
  const staticPanel = await readFile(new URL("../app/problems/[id]/static-autoresearch-panel.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/problems/[id]/autoresearch-panel.module.css", import.meta.url), "utf8");

  assert.match(page, /import \{ StaticAutoresearchPanel \} from "\.\/static-autoresearch-panel";/);
  assert.match(page, /<\/header>\s*<StaticAutoresearchPanel\s*\/>\s*<p className="example-disclaimer">/);
  assert.doesNotMatch(page, /<AutoresearchPanel[\s\S]*?staticMode=\{true\}/);
  assert.ok(page.indexOf('if (isStaticResearchExampleProblem(problem.id))') < page.indexOf('await import("./autoresearch-panel")'));
  assert.match(page, /<\/header>\s*<AutoresearchPanel[\s\S]*?\/>\s*<p className="example-disclaimer">/);
  assert.match(page, /<p className="detail-summary">\{problem\.summary\}<\/p>\s*<AutoresearchPanel[\s\S]*?\/>\s*<section className="detail-panel"/);
  assert.match(panel, /^"use client";/);
  assert.match(panel, /import styles from "\.\/autoresearch-panel\.module\.css";/);
  assert.match(panel, /AbortController/);
  assert.match(panel, /requestSequence/);
  assert.match(panel, /if \(!localMode\) return undefined;/);
  assert.match(panel, /if \(!localMode \|\| view\.pollAfterMs === null\) return undefined;/);
  assert.match(staticPanel, /Available in local mode/);
  assert.doesNotMatch(staticPanel, /__local\/autoresearch|AUTORESEARCH_/);
  assert.match(panel, /const payload = await response\.json\(\);\s*if \(sequence !== requestSequence\.current \|\| currentController\.signal\.aborted\) return;\s*setServiceState\(payload\);/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /<form/);
  assert.match(css, /var\(--paper\)/);
  assert.match(css, /var\(--surface\)/);
  assert.match(css, /var\(--line\)/);
  assert.match(css, /var\(--green\)/);
  assert.match(css, /var\(--font-geist-mono\)/);
  assert.doesNotMatch(css, /border-radius:\s*(?!0(?:;|\s))/);
  assert.doesNotMatch(css, /box-shadow/);
});

test("preserved dashboard and global layout sources are unchanged from the task base", async () => {
  const preservedBase = "11cc858a30f4424f6ec04490b8df14713c84f0bb";
  for (const path of ["app/globals.css", "app/page.tsx", "app/layout.tsx"]) {
    const current = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const base = execFileSync("git", ["show", `${preservedBase}:${path}`], { encoding: "utf8" });
    assert.equal(current, base, path);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderAssessmentReport } from "../lib/assessments/html-report.mjs";

test("escapes HTML-sensitive model text", () => {
  assert.equal(escapeHtml("<script>alert('x')</script>"), "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
});

test("renders a standalone report with required audit sections and no scripts", () => {
  const html = renderAssessmentReport({
    run: {
      runId: "20260728T010203Z-a1b2c3",
      problemId: "Prob-001",
      createdAt: "2026-07-28T01:02:03.000Z",
      updatedAt: "2026-07-28T01:05:00.000Z",
    },
    input: {
      policyVersion: 1,
      problemId: "Prob-001",
      problemTitle: "Fixture problem",
      problemJsonHash: "a".repeat(64),
      problemMdHash: "b".repeat(64),
      skillHash: "c".repeat(64),
      schemaHash: "d".repeat(64),
      resolver: { query: "Fixture", status: "match", topic: "knowledge/example/index.qmd", orderedFiles: ["knowledge/example/index.qmd"] },
      bundle: [{ path: "knowledge/example/index.qmd", hash: "e".repeat(64) }],
    },
    envelope: {
      language: "en",
      assessment: {
        normalizedProblem: "Fixture <problem>",
        verdict: { label: "REFRAME", provisional: true, possibleLabels: ["REFRAME", "DEFER"] },
        recommendation: "reframe",
        confidence: { level: "low", rationale: "One input is uncertain." },
        dimensions: {
          researchValue: [{
            id: "importance",
            label: "Importance",
            weight: 20,
            score: { min: 3, estimate: 4, max: 5 },
            evidenceState: "supported",
            rationale: "Important.",
            evidenceRefs: ["k1"],
          }],
          autoresearchSuitability: [{
            id: "attempt_runtime",
            label: "Attempt runtime",
            weight: 10,
            score: { min: 2, estimate: 3, max: 4 },
            evidenceState: "inferred",
            rationale: "Runtime may exceed the target.",
            evidenceRefs: [],
          }],
        },
        largestBottleneck: "Runtime uncertainty.",
        recommendedReframe: { kind: "bounded", text: "Use a smaller benchmark." },
        informationGaps: ["Need one measured run time."],
        evidence: [{
          id: "k1",
          kind: "knowledge",
          path: "knowledge/example/index.qmd",
          locator: "section",
          summary: "Trusted basis.",
        }],
      },
    },
    computed: {
      scores: {
        researchValue: { min: 60, estimate: 80, max: 100 },
        autoresearchSuitability: { min: 40, estimate: 60, max: 80 },
        combined: { min: 48, estimate: 68.57, max: 88.89 },
      },
      verdict: { label: "REFRAME" },
    },
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /Research Value Audit/);
  assert.match(html, /Autoresearch Fit Audit/);
  assert.match(html, /Evidence Appendix/);
  assert.match(html, /Fixture &lt;problem&gt;/);
  assert.match(html, /<strong>Research Value<\/strong><br>80 \(60-100\)<\/div>/);
  assert.match(html, /<strong>Autoresearch Suitability<\/strong><br>60 \(40-80\)<\/div>/);
  assert.match(html, /<strong>Combined<\/strong><br>68\.57 \(48-88\.89\)<\/div>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

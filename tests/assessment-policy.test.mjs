import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ASSESSMENT_POLICY_VERSION,
  AUTORESEARCH_DIMENSIONS,
  RESEARCH_VALUE_DIMENSIONS,
  band,
  deriveVerdict,
  harmonicInterval,
  runtimeScore,
  weightedInterval,
} from "../lib/assessments/policy.mjs";

test("assessment policy exposes stable version one and dimension weights", () => {
  assert.equal(ASSESSMENT_POLICY_VERSION, 1);
  assert.deepEqual(RESEARCH_VALUE_DIMENSIONS.map((item) => item.id), [
    "importance",
    "gap_and_novelty",
    "plausibility",
    "learning_from_failure",
    "generality_and_publication",
    "expected_value_relative_to_cost",
  ]);
  assert.deepEqual(AUTORESEARCH_DIMENSIONS.map((item) => item.id), [
    "modifiable_search_object",
    "executable_objective",
    "correctness_and_anti_gaming",
    "incremental_feedback",
    "fresh_evaluation",
    "reproducibility_and_auditability",
    "attempt_runtime",
  ]);
  assert.equal(RESEARCH_VALUE_DIMENSIONS.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(AUTORESEARCH_DIMENSIONS.reduce((sum, item) => sum + item.weight, 0), 100);
});

test("runtime target is soft with five minutes scoring five", () => {
  assert.equal(runtimeScore(5), 5);
  assert.equal(runtimeScore(10), 4);
  assert.equal(runtimeScore(20), 3);
  assert.equal(runtimeScore(160), 0);
  assert.equal(runtimeScore(1), 5);
});

test("weighted and harmonic intervals use host arithmetic", () => {
  const value = weightedInterval([
    { weight: 50, score: { min: 4, estimate: 5, max: 5 } },
    { weight: 50, score: { min: 2, estimate: 3, max: 4 } },
  ]);
  assert.deepEqual(value, { min: 60, estimate: 80, max: 90 });
  assert.deepEqual(harmonicInterval(value, { min: 50, estimate: 60, max: 70 }), {
    min: 54.55,
    estimate: 68.57,
    max: 78.75,
  });
});

test("banding and verdict rules match the design", () => {
  assert.equal(band(70), "strong");
  assert.equal(band(40), "mixed");
  assert.equal(band(39.99), "weak");
  assert.equal(deriveVerdict({ valueScore: 75, fitScore: 72, hasBoundedReframe: false }), "DO_NOW");
  assert.equal(deriveVerdict({ valueScore: 75, fitScore: 55, hasBoundedReframe: true }), "REFRAME");
  assert.equal(deriveVerdict({ valueScore: 75, fitScore: 35, hasBoundedReframe: false }), "NOT_AUTORESEARCH");
  assert.equal(deriveVerdict({ valueScore: 55, fitScore: 80, hasBoundedReframe: true }), "DEFER");
});

test("codex output schema is strict at the envelope boundary", async () => {
  const schema = JSON.parse(await readFile(join(process.cwd(), "schemas/research-problem-assessment.schema.json"), "utf8"));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "outcome",
    "language",
    "knowledgeResolution",
    "assessment",
    "clarification",
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAssessmentFinalMessage,
  summarizeCompletedAssessment,
  validateAssessmentEnvelope,
} from "../lib/assessments/contract.mjs";

function dimension(id, weight, estimate, evidenceState = "supported") {
  return {
    id,
    label: id,
    weight,
    score: { min: estimate, estimate, max: estimate },
    evidenceState,
    rationale: `${id} rationale`,
    evidenceRefs: evidenceState === "unknown" ? [] : ["k1"],
  };
}

function validEnvelope(overrides = {}) {
  return {
    outcome: "assessment",
    language: "en",
    knowledgeResolution: {
      query: "fresh evaluation for a solver problem",
      status: "match",
      topic: "knowledge/example/index.qmd",
      orderedFiles: ["knowledge/index.qmd", "knowledge/example/index.qmd"],
    },
    assessment: {
      schemaVersion: 1,
      normalizedProblem: "Find a fresh, executable benchmark for the solver.",
      verdict: { label: "DO_NOW", provisional: false, possibleLabels: ["DO_NOW"] },
      recommendation: "proceed",
      scores: {
        researchValue: { min: 80, estimate: 80, max: 80 },
        autoresearchSuitability: { min: 80, estimate: 80, max: 80 },
        combined: { min: 80, estimate: 80, max: 80 },
      },
      confidence: { level: "high", rationale: "Every key claim cites trusted knowledge." },
      dimensions: {
        researchValue: [
          dimension("importance", 20, 4),
          dimension("gap_and_novelty", 20, 4),
          dimension("plausibility", 15, 4),
          dimension("learning_from_failure", 15, 4),
          dimension("generality_and_publication", 15, 4),
          dimension("expected_value_relative_to_cost", 15, 4),
        ],
        autoresearchSuitability: [
          dimension("modifiable_search_object", 20, 4),
          dimension("executable_objective", 20, 4),
          dimension("correctness_and_anti_gaming", 15, 4),
          dimension("incremental_feedback", 15, 4),
          dimension("fresh_evaluation", 10, 4),
          dimension("reproducibility_and_auditability", 10, 4),
          dimension("attempt_runtime", 10, 4),
        ],
      },
      largestBottleneck: "The anti-gaming gate needs careful fixture separation.",
      recommendedReframe: { kind: "none", text: "No bounded reframe is needed." },
      informationGaps: [],
      evidence: [{
        id: "k1",
        kind: "knowledge",
        path: "knowledge/example/index.qmd",
        locator: "section: Fresh Evaluation Plan",
        summary: "Trusted page describes the gate.",
      }],
    },
    clarification: null,
    ...overrides,
  };
}

test("accepts a valid assessment and recomputes scores", () => {
  const result = validateAssessmentEnvelope(validEnvelope());
  assert.equal(result.ok, true);
  assert.deepEqual(result.computed.scores.combined, { min: 80, estimate: 80, max: 80 });
  assert.equal(result.computed.verdict.label, "DO_NOW");
});

test("rejects envelopes that contain both assessment and clarification", () => {
  const result = validateAssessmentEnvelope(validEnvelope({
    clarification: { query: "x", reason: "ambiguous", alternatives: [] },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /exactly one/);
});

test("accepts resolver ambiguity only as needs_input", () => {
  const result = validateAssessmentEnvelope({
    outcome: "needs_input",
    language: "en",
    knowledgeResolution: {
      query: "Hamiltonian benchmark",
      status: "ambiguous",
      topic: null,
      orderedFiles: [],
    },
    assessment: null,
    clarification: {
      query: "Hamiltonian benchmark",
      reason: "Resolver returned multiple candidates.",
      alternatives: [
        { page: "knowledge/a/index.qmd", topic: "a", title: "A", matchKind: "title" },
        { page: "knowledge/b/index.qmd", topic: "b", title: "B", matchKind: "title" },
      ],
    },
  });
  assert.equal(result.ok, true);
});

test("keeps no-match assessment dimensions evidence-dependent unknown", () => {
  const envelope = validEnvelope({
    knowledgeResolution: {
      query: "unknown candidate",
      status: "no-match",
      topic: null,
      orderedFiles: [],
    },
  });
  envelope.assessment.dimensions.researchValue[1] = dimension("gap_and_novelty", 20, 2, "unknown");
  envelope.assessment.scores.researchValue = { min: 72, estimate: 76, max: 80 };
  const result = validateAssessmentEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /model arithmetic/);
});

test("rejects missing aggregate score intervals without throwing", () => {
  const envelope = validEnvelope();
  delete envelope.assessment.scores.combined;
  const result = validateAssessmentEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /score intervals are invalid/);
});

test("rejects evidence that labels drafts as trusted knowledge", () => {
  const envelope = validEnvelope();
  envelope.assessment.evidence[0].path = "drafts/unreviewed.qmd";
  const result = validateAssessmentEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /trusted knowledge path/);
});

test("rejects resolver topic and ordered files outside trusted knowledge", () => {
  const envelope = validEnvelope();
  envelope.knowledgeResolution.topic = "literature/external.qmd";
  envelope.knowledgeResolution.orderedFiles = ["knowledge/index.qmd", "drafts/unreviewed.qmd"];
  const result = validateAssessmentEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /trusted knowledge path/);
});

test("requires both envelope branch fields even when one is null", () => {
  const envelope = validEnvelope();
  delete envelope.clarification;
  const result = validateAssessmentEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /assessment and clarification fields/);
});

test("requires possible verdict labels to include the selected verdict", () => {
  const envelope = validEnvelope();
  envelope.assessment.verdict.possibleLabels = ["REFRAME"];
  const result = validateAssessmentEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /verdict is invalid/);
});

test("parses Codex final message as the same strict envelope", () => {
  const result = parseAssessmentFinalMessage(JSON.stringify(validEnvelope()));
  assert.equal(result.ok, true);
});

test("summary exposes advisory verdict fields without lifecycle mutation", () => {
  const validation = validateAssessmentEnvelope(validEnvelope());
  const summary = summarizeCompletedAssessment({
    run: { runId: "20260728T010203Z-a1b2c3", problemId: "Prob-001", createdAt: "2026-07-28T01:02:03.000Z" },
    envelope: validation.value,
    computed: validation.computed,
  });
  assert.equal(summary.runId, "20260728T010203Z-a1b2c3");
  assert.equal(summary.verdict, "DO_NOW");
  assert.equal(summary.recommendation, "proceed");
  assert.equal(summary.lifecycleMutation, false);
});

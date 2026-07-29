export const ASSESSMENT_POLICY_VERSION = 1;

export const RESEARCH_VALUE_DIMENSIONS = Object.freeze([
  { id: "importance", label: "Importance", weight: 20 },
  { id: "gap_and_novelty", label: "Gap and novelty", weight: 20 },
  { id: "plausibility", label: "Plausibility", weight: 15 },
  { id: "learning_from_failure", label: "Learning from failure", weight: 15 },
  { id: "generality_and_publication", label: "Generality and publication potential", weight: 15 },
  { id: "expected_value_relative_to_cost", label: "Expected value relative to cost", weight: 15 },
]);

export const AUTORESEARCH_DIMENSIONS = Object.freeze([
  { id: "modifiable_search_object", label: "Modifiable search object", weight: 20 },
  { id: "executable_objective", label: "Executable objective", weight: 20 },
  { id: "correctness_and_anti_gaming", label: "Correctness and anti-gaming", weight: 15 },
  { id: "incremental_feedback", label: "Incremental feedback", weight: 15 },
  { id: "fresh_evaluation", label: "Fresh evaluation", weight: 10 },
  { id: "reproducibility_and_auditability", label: "Reproducibility and auditability", weight: 10 },
  { id: "attempt_runtime", label: "Attempt runtime", weight: 10 },
]);

export const VERDICT_LABELS = Object.freeze(["DO_NOW", "REFRAME", "NOT_AUTORESEARCH", "DEFER"]);
export const RECOMMENDATIONS = Object.freeze(["proceed", "reframe", "reject", "defer"]);
export const EVIDENCE_STATES = Object.freeze(["supported", "inferred", "unknown"]);
export const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);
export const ASSESSMENT_SCHEMA_PATH_SEGMENTS = Object.freeze(["schemas", "research-problem-assessment.schema.json"]);

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function runtimeScore(minutes) {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.min(5, round2(5 - Math.log2(Math.max(numeric, 5) / 5))));
}

export function weightedInterval(dimensions) {
  const totalWeight = dimensions.reduce((sum, item) => sum + item.weight, 0);
  const score = (key) => round2(dimensions.reduce((sum, item) => sum + item.score[key] * item.weight, 0) / totalWeight / 5 * 100);
  return { min: score("min"), estimate: score("estimate"), max: score("max") };
}

function harmonic(left, right) {
  return left + right === 0 ? 0 : round2((2 * left * right) / (left + right));
}

export function harmonicInterval(value, fit) {
  return {
    min: harmonic(value.min, fit.min),
    estimate: harmonic(value.estimate, fit.estimate),
    max: harmonic(value.max, fit.max),
  };
}

export function band(score) {
  if (score >= 70) return "strong";
  if (score >= 40) return "mixed";
  return "weak";
}

export function deriveVerdict({ valueScore, fitScore, hasBoundedReframe }) {
  const valueBand = band(valueScore);
  const fitBand = band(fitScore);
  if (valueBand === "strong" && fitBand === "strong") return "DO_NOW";
  if (valueBand === "strong" && fitBand !== "strong" && hasBoundedReframe) return "REFRAME";
  if (valueBand === "strong" && fitBand === "weak" && !hasBoundedReframe) return "NOT_AUTORESEARCH";
  return "DEFER";
}

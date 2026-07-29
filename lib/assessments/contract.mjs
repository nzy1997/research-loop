import {
  AUTORESEARCH_DIMENSIONS,
  CONFIDENCE_LEVELS,
  EVIDENCE_STATES,
  RECOMMENDATIONS,
  RESEARCH_VALUE_DIMENSIONS,
  VERDICT_LABELS,
  deriveVerdict,
  harmonicInterval,
  weightedInterval,
} from "./policy.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function intervalOk(interval, max) {
  return isRecord(interval)
    && Number.isFinite(interval.min)
    && Number.isFinite(interval.estimate)
    && Number.isFinite(interval.max)
    && interval.min >= 0
    && interval.estimate >= interval.min
    && interval.max >= interval.estimate
    && interval.max <= max;
}

function sameInterval(left, right) {
  return Math.abs(left.min - right.min) <= 0.01
    && Math.abs(left.estimate - right.estimate) <= 0.01
    && Math.abs(left.max - right.max) <= 0.01;
}

function hasOnlyFields(value, fields) {
  return isRecord(value) && Object.keys(value).every((key) => fields.includes(key));
}

function hasRequiredFields(value, fields) {
  return isRecord(value) && fields.every((field) => Object.hasOwn(value, field));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTrustedKnowledgePath(value) {
  return typeof value === "string"
    && value.startsWith("knowledge/")
    && value.endsWith(".qmd")
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

function validateDimensions(dimensions, expected, errors, evidenceIds) {
  if (!Array.isArray(dimensions) || dimensions.length !== expected.length) {
    errors.push("dimensions must contain the policy dimensions exactly once.");
    return false;
  }

  let valid = true;
  for (let index = 0; index < expected.length; index += 1) {
    const dimension = dimensions[index];
    const policy = expected[index];
    if (!isRecord(dimension) || dimension.id !== policy.id || dimension.weight !== policy.weight) {
      errors.push("dimensions must contain the policy dimensions exactly once.");
      valid = false;
      continue;
    }
    if (!hasOnlyFields(dimension, ["id", "label", "weight", "score", "evidenceState", "rationale", "evidenceRefs"])
      || !nonEmptyString(dimension.label)
      || !nonEmptyString(dimension.rationale)
      || !intervalOk(dimension.score, 5)
      || !EVIDENCE_STATES.includes(dimension.evidenceState)
      || !Array.isArray(dimension.evidenceRefs)
      || !dimension.evidenceRefs.every((id) => nonEmptyString(id) && evidenceIds.has(id))) {
      errors.push(`dimension ${policy.id} is invalid.`);
      valid = false;
    }
    if (dimension.evidenceState === "unknown"
      && intervalOk(dimension.score, 5)
      && dimension.score.min === 0
      && dimension.score.estimate === 0
      && dimension.score.max === 0) {
      errors.push("unknown dimensions must use nonzero intervals when uncertainty remains.");
      valid = false;
    }
  }
  return valid;
}

function validateEvidence(evidence, errors) {
  if (!Array.isArray(evidence)) {
    errors.push("evidence must be an array.");
    return new Set();
  }
  const ids = new Set();
  for (const item of evidence) {
    if (!hasOnlyFields(item, ["id", "kind", "path", "locator", "summary"])
      || !nonEmptyString(item.id)
      || !["knowledge", "problem", "resolver", "unknown"].includes(item.kind)
      || !(item.path === null || typeof item.path === "string")
      || !(item.locator === null || typeof item.locator === "string")
      || typeof item.summary !== "string"
      || ids.has(item.id)) {
      errors.push("evidence entries must be valid and have unique IDs.");
      continue;
    }
    if (item.kind === "knowledge" && !isTrustedKnowledgePath(item.path)) {
      errors.push("knowledge evidence must use a trusted knowledge path.");
      continue;
    }
    ids.add(item.id);
  }
  return ids;
}

function validateAssessmentObject(assessment, resolution, errors) {
  if (!hasOnlyFields(assessment, ["schemaVersion", "normalizedProblem", "verdict", "recommendation", "scores", "confidence", "dimensions", "largestBottleneck", "recommendedReframe", "informationGaps", "evidence"])) {
    errors.push("assessment must be an object with only supported fields.");
    return {};
  }
  if (assessment.schemaVersion !== 1 || !nonEmptyString(assessment.normalizedProblem)) errors.push("assessment schemaVersion and normalizedProblem are invalid.");
  if (!RECOMMENDATIONS.includes(assessment.recommendation)) errors.push("recommendation is invalid.");
  if (!nonEmptyString(assessment.largestBottleneck)) errors.push("largestBottleneck is required.");
  if (!Array.isArray(assessment.informationGaps) || !assessment.informationGaps.every(nonEmptyString)) errors.push("informationGaps must be strings.");

  const evidenceIds = validateEvidence(assessment.evidence, errors);
  const researchDimensions = assessment.dimensions?.researchValue;
  const fitDimensions = assessment.dimensions?.autoresearchSuitability;
  if (!hasOnlyFields(assessment.dimensions, ["researchValue", "autoresearchSuitability"])) errors.push("dimensions must contain researchValue and autoresearchSuitability.");
  const researchValid = validateDimensions(researchDimensions, RESEARCH_VALUE_DIMENSIONS, errors, evidenceIds);
  const fitValid = validateDimensions(fitDimensions, AUTORESEARCH_DIMENSIONS, errors, evidenceIds);

  const scoreIntervalsValid = hasOnlyFields(assessment.scores, ["researchValue", "autoresearchSuitability", "combined"])
    && intervalOk(assessment.scores?.researchValue, 100)
    && intervalOk(assessment.scores?.autoresearchSuitability, 100)
    && intervalOk(assessment.scores?.combined, 100);
  if (!scoreIntervalsValid
  ) {
    errors.push("assessment score intervals are invalid.");
  }

  if (!hasOnlyFields(assessment.confidence, ["level", "rationale"])
    || !CONFIDENCE_LEVELS.includes(assessment.confidence?.level)
    || !nonEmptyString(assessment.confidence?.rationale)) errors.push("confidence is invalid.");
  if (!hasOnlyFields(assessment.recommendedReframe, ["kind", "text"])
    || !["bounded", "none"].includes(assessment.recommendedReframe?.kind)
    || !nonEmptyString(assessment.recommendedReframe?.text)) errors.push("recommendedReframe is invalid.");
  if (!hasOnlyFields(assessment.verdict, ["label", "provisional", "possibleLabels"])
    || !VERDICT_LABELS.includes(assessment.verdict?.label)
    || typeof assessment.verdict?.provisional !== "boolean"
    || !Array.isArray(assessment.verdict?.possibleLabels)
    || assessment.verdict.possibleLabels.length === 0
    || !assessment.verdict.possibleLabels.every((label) => VERDICT_LABELS.includes(label))
    || !assessment.verdict.possibleLabels.includes(assessment.verdict.label)
    || new Set(assessment.verdict.possibleLabels).size !== assessment.verdict.possibleLabels.length) errors.push("verdict is invalid.");

  if (resolution?.status === "no-match" && Array.isArray(assessment.evidence)
    && assessment.evidence.some((item) => item?.kind === "knowledge")) {
    errors.push("no-match assessments must not cite knowledge evidence.");
  }

  if (!researchValid || !fitValid) return {};
  const researchValue = weightedInterval(researchDimensions);
  const autoresearchSuitability = weightedInterval(fitDimensions);
  const combined = harmonicInterval(researchValue, autoresearchSuitability);
  const label = deriveVerdict({
    valueScore: researchValue.estimate,
    fitScore: autoresearchSuitability.estimate,
    hasBoundedReframe: assessment.recommendedReframe?.kind === "bounded",
  });
  if (scoreIntervalsValid && !sameInterval(assessment.scores.researchValue, researchValue)) errors.push("researchValue model arithmetic does not match host arithmetic.");
  if (scoreIntervalsValid && !sameInterval(assessment.scores.autoresearchSuitability, autoresearchSuitability)) errors.push("autoresearchSuitability model arithmetic does not match host arithmetic.");
  if (scoreIntervalsValid && !sameInterval(assessment.scores.combined, combined)) errors.push("combined model arithmetic does not match host arithmetic.");
  if (assessment.verdict?.label !== label) errors.push("verdict label does not match host verdict rule.");

  return { scores: { researchValue, autoresearchSuitability, combined }, verdict: { label } };
}

function validateClarificationObject(clarification, resolution, errors) {
  if (!hasOnlyFields(clarification, ["query", "reason", "alternatives"])
    || !nonEmptyString(clarification.query)
    || !nonEmptyString(clarification.reason)
    || !Array.isArray(clarification.alternatives)
    || clarification.alternatives.length < 2) {
    errors.push("clarification is invalid.");
    return {};
  }
  for (const alternative of clarification.alternatives) {
    if (!hasOnlyFields(alternative, ["page", "topic", "title", "matchKind"])
      || !nonEmptyString(alternative.page)
      || !nonEmptyString(alternative.topic)
      || !nonEmptyString(alternative.title)
      || !nonEmptyString(alternative.matchKind)) {
      errors.push("clarification alternatives are invalid.");
      break;
    }
  }
  if (resolution?.status !== "ambiguous") errors.push("needs_input requires ambiguous knowledge resolution.");
  return {};
}

function validateKnowledgeResolution(resolution, errors) {
  if (!hasOnlyFields(resolution, ["query", "status", "topic", "orderedFiles"])
    || !nonEmptyString(resolution.query)
    || !["match", "no-match", "ambiguous"].includes(resolution.status)
    || !(resolution.topic === null || typeof resolution.topic === "string")
    || !Array.isArray(resolution.orderedFiles)
    || !resolution.orderedFiles.every((file) => nonEmptyString(file))) {
    errors.push("knowledgeResolution is invalid.");
    return;
  }
  if ((resolution.topic !== null && !isTrustedKnowledgePath(resolution.topic))
    || !resolution.orderedFiles.every(isTrustedKnowledgePath)) {
    errors.push("knowledgeResolution paths must use trusted knowledge paths.");
  }
}

export function validateAssessmentEnvelope(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["Envelope must be an object."] };
  const envelopeFields = ["outcome", "language", "knowledgeResolution", "assessment", "clarification"];
  if (!hasOnlyFields(value, envelopeFields)) errors.push("Envelope contains unsupported fields.");
  if (!hasRequiredFields(value, ["assessment", "clarification"])) errors.push("Envelope must contain assessment and clarification fields.");
  if (!["assessment", "needs_input"].includes(value.outcome)) errors.push("outcome must be assessment or needs_input.");
  if (typeof value.language !== "string" || value.language.trim().length < 2) errors.push("language must be a string.");
  validateKnowledgeResolution(value.knowledgeResolution, errors);

  const hasAssessment = value.assessment !== null && value.assessment !== undefined;
  const hasClarification = value.clarification !== null && value.clarification !== undefined;
  if (Number(hasAssessment) + Number(hasClarification) !== 1) {
    errors.push("Envelope must contain exactly one of assessment or clarification.");
  }
  if (value.outcome === "assessment" && !hasAssessment) errors.push("assessment outcome requires assessment.");
  if (value.outcome === "needs_input" && !hasClarification) errors.push("needs_input outcome requires clarification.");
  if (value.outcome === "assessment" && value.knowledgeResolution?.status === "ambiguous") errors.push("ambiguous knowledge resolution requires needs_input.");

  const computed = hasAssessment
    ? validateAssessmentObject(value.assessment, value.knowledgeResolution, errors)
    : validateClarificationObject(value.clarification, value.knowledgeResolution, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value, computed };
}

export function parseAssessmentFinalMessage(text) {
  try {
    return validateAssessmentEnvelope(JSON.parse(text));
  } catch (error) {
    return { ok: false, errors: [`Final message is not valid JSON: ${error.message}`] };
  }
}

export function summarizeCompletedAssessment({ run, envelope, computed }) {
  const assessment = envelope.assessment;
  return {
    runId: run.runId,
    problemId: run.problemId,
    createdAt: run.createdAt,
    verdict: assessment.verdict.label,
    recommendation: assessment.recommendation,
    confidence: assessment.confidence.level,
    scores: computed.scores,
    largestBottleneck: assessment.largestBottleneck,
    provisional: assessment.verdict.provisional,
    reportHref: `/__local/assessments/reports/${run.problemId}/${run.runId}`,
    lifecycleMutation: false,
  };
}

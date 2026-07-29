import assert from "node:assert/strict";
import test from "node:test";

import * as viewModel from "../lib/assessments/view-model.mjs";

const {
  assessmentStatusCopy,
  formatScoreInterval,
  isLocalAssessmentUnavailable,
  latestAssessmentSummary,
} = viewModel;

test("formats score intervals compactly", () => {
  assert.equal(formatScoreInterval({ min: 60, estimate: 72.5, max: 80 }), "72.5 (60-80)");
});

test("provides copy for every panel state", () => {
  assert.equal(assessmentStatusCopy({ kind: "never" }).actionLabel, "Run assessment");
  assert.equal(assessmentStatusCopy({ kind: "queued", queuePosition: 2 }).heading, "Assessment queued");
  assert.equal(assessmentStatusCopy({ kind: "running", elapsedSeconds: 42 }).heading, "Assessment running");
  assert.equal(assessmentStatusCopy({ kind: "needs-input" }).heading, "Knowledge match needs input");
  assert.equal(assessmentStatusCopy({ kind: "completed" }).heading, "Assessment complete");
  assert.equal(assessmentStatusCopy({ kind: "failed" }).actionLabel, "Retry");
  assert.equal(assessmentStatusCopy({ kind: "stale" }).actionLabel, "Run new assessment");
  assert.equal(assessmentStatusCopy({ kind: "unavailable" }).heading, "Local assessment unavailable");
});

test("selects latest completed summary without mutating lifecycle", () => {
  const summary = latestAssessmentSummary({
    runs: [
      { runId: "20260728T010203Z-a1b2c3", status: "failed" },
      { runId: "20260728T010204Z-a1b2c3", status: "completed", summary: { verdict: "DEFER", lifecycleMutation: false } },
    ],
  });
  assert.equal(summary.verdict, "DEFER");
  assert.equal(summary.lifecycleMutation, false);
});

test("a newer failed rerun takes precedence over an older completed summary", () => {
  assert.equal(typeof viewModel.assessmentStateFromProblemResponse, "function");
  const state = viewModel.assessmentStateFromProblemResponse({
    latest: { verdict: "DO_NOW", reportHref: "/older-report" },
    runs: [
      { runId: "20260728T010204Z-a1b2c3", status: "failed", error: { message: "Codex exited." } },
      { runId: "20260728T010203Z-a1b2c3", status: "completed", summary: { verdict: "DO_NOW" } },
    ],
  });

  assert.equal(state.kind, "failed");
  assert.equal(state.reason, "Codex exited.");
  assert.equal(state.latest.verdict, "DO_NOW");
});

test("treats 404 and fetch failure as local-unavailable for static output", () => {
  assert.equal(isLocalAssessmentUnavailable({ status: 404 }), true);
  assert.equal(isLocalAssessmentUnavailable(new TypeError("fetch failed")), true);
});

test("surfaces the local service code and actionable message", async () => {
  assert.equal(typeof viewModel.assessmentServiceFailure, "function");
  const state = await viewModel.assessmentServiceFailure(new Response(JSON.stringify({
    code: "CODEX_PREFLIGHT",
    message: "Run codex login before starting an assessment.",
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  }));

  assert.deepEqual(state, {
    kind: "failed",
    reason: "Run codex login before starting an assessment. (CODEX_PREFLIGHT)",
  });
});

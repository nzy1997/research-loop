import assert from "node:assert/strict";
import test from "node:test";

import { buildPreparationPanelState } from "../lib/autoresearch/view-model.mjs";

const eligibleProblem = { id: "Prob-007", status: "qualifying" };

test("preparation view model exposes the approved actions for every public preparation state", () => {
  const cases = [
    [undefined, "not_prepared", "Prepare autoresearch", false, null],
    ["queued", "queued", "Queued", true, 1_000],
    ["scaffolding", "preparing", "Preparing…", true, 1_000],
    ["building_benchmark", "preparing", "Preparing…", true, 1_000],
    ["preparing_datasets", "preparing", "Preparing…", true, 1_000],
    ["preflight", "preparing", "Preparing…", true, 1_000],
    ["needs_input", "needs_input", "Provide input", true, null],
    ["failed", "failed", "Retry preparation", false, null],
    ["ready", "ready", "Start autoresearch", true, null],
    ["interrupted", "interrupted", "Retry preparation", false, null],
  ];

  for (const [state, kind, label, disabled, pollAfterMs] of cases) {
    const view = buildPreparationPanelState({
      problem: eligibleProblem,
      serviceState: state ? { state, infrastructureId: "INF-003" } : null,
      localMode: true,
    });
    assert.equal(view.kind, kind, state ?? "no job");
    assert.equal(view.primary.label, label, state ?? "no job");
    assert.equal(view.primary.disabled, disabled, state ?? "no job");
    assert.equal(view.pollAfterMs, pollAfterMs, state ?? "no job");
  }
});

test("preparation view model makes only local qualifying and accepted problems eligible", () => {
  for (const status of ["qualifying", "accepted"]) {
    assert.equal(buildPreparationPanelState({ problem: { id: "Prob-007", status }, serviceState: null, localMode: true }).kind, "not_prepared");
  }
  for (const problem of [
    { id: "Prob-000", status: "qualifying" },
    ...["draft", "solving", "solved", "publishing", "published", "rejected", "archived"].map((status) => ({ id: "Prob-007", status })),
  ]) {
    const view = buildPreparationPanelState({ problem, serviceState: { state: "ready", path: "/private/path" }, localMode: true });
    assert.equal(view.kind, "unavailable", `${problem.id}/${problem.status}`);
    assert.equal(view.pollAfterMs, 5_000);
  }
  assert.equal(buildPreparationPanelState({ problem: eligibleProblem, serviceState: null, localMode: false }).kind, "unavailable");
});

test("preparation view model returns only bounded display data", () => {
  const view = buildPreparationPanelState({
    problem: eligibleProblem,
    serviceState: {
      state: "needs_input",
      jobId: "ARJ-20260728T080000Z-deadbeef",
      question: { id: "metric", prompt: "Choose a metric", answerType: "choice", choices: ["score", "loss"] },
      diagnostic: "ready-index-stale",
      secret: "do-not-show",
      path: "/private/path",
      stderr: "do-not-show",
    },
    localMode: true,
  });

  assert.equal(view.eyebrow, "AUTORESEARCH INFRASTRUCTURE");
  assert.deepEqual(view.question, { id: "metric", prompt: "Choose a metric", answerType: "choice", choices: ["score", "loss"] });
  assert.equal(JSON.stringify(view).includes("do-not-show"), false);
  assert.equal(JSON.stringify(view).includes("/private/path"), false);
});

test("ready preparation names its published revision and keeps campaign execution disabled", () => {
  const view = buildPreparationPanelState({
    problem: eligibleProblem,
    serviceState: { state: "ready", infrastructureId: "INF-003" },
    localMode: true,
  });

  assert.deepEqual(view, {
    kind: "ready",
    eyebrow: "AUTORESEARCH INFRASTRUCTURE",
    title: "Ready to start",
    body: "INF-003 passed all preflight checks.",
    primary: { label: "Start autoresearch", action: "start", disabled: true },
    metadata: [{ label: "Revision", value: "INF-003" }],
    pollAfterMs: null,
  });
});

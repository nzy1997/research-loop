const ELIGIBLE_STATUSES = new Set(["qualifying", "accepted"]);
const EXECUTING_STATES = new Set(["scaffolding", "building_benchmark", "preparing_datasets", "preflight"]);
const INFRASTRUCTURE_ID = /^INF-\d+$/;

function eligible(problem, localMode) {
  return localMode === true
    && problem?.id !== "Prob-000"
    && ELIGIBLE_STATUSES.has(problem?.status);
}

function questionFor(serviceState) {
  const question = serviceState?.question;
  if (!question || typeof question !== "object" || Array.isArray(question)) return null;
  if (typeof question.id !== "string" || typeof question.prompt !== "string") return null;
  if (question.answerType === "text") return { id: question.id, prompt: question.prompt, answerType: "text", choices: [] };
  if (question.answerType === "choice" && Array.isArray(question.choices)) {
    return { id: question.id, prompt: question.prompt, answerType: "choice", choices: question.choices.filter((choice) => typeof choice === "string") };
  }
  return null;
}

function state(kind, title, body, primary, metadata = [], pollAfterMs = null, question = null) {
  return {
    kind,
    eyebrow: "AUTORESEARCH INFRASTRUCTURE",
    title,
    body,
    primary,
    metadata,
    pollAfterMs,
    ...(question ? { question } : {}),
  };
}

export function buildPreparationPanelState({ problem, serviceState, localMode }) {
  if (!eligible(problem, localMode)) {
    return state(
      "unavailable",
      "Available in local mode",
      "Autoresearch preparation is available only for qualifying or accepted local problems.",
      { label: "Prepare autoresearch", action: "prepare", disabled: true },
      [],
      5_000,
    );
  }

  const jobState = serviceState?.state;
  if (!jobState) {
    return state(
      "not_prepared",
      "Prepare infrastructure",
      "Prepare the benchmark and data infrastructure before starting autoresearch.",
      { label: "Prepare autoresearch", action: "prepare", disabled: false },
    );
  }
  if (jobState === "queued") {
    return state("queued", "Preparation queued", "A local preparation job is waiting to run.", { label: "Queued", action: "none", disabled: true }, [], 1_000);
  }
  if (EXECUTING_STATES.has(jobState)) {
    const stages = {
      scaffolding: "Scaffolding the campaign workspace.",
      building_benchmark: "Building the benchmark contract.",
      preparing_datasets: "Preparing the dataset contract.",
      preflight: "Running infrastructure preflight checks.",
    };
    return state("preparing", "Preparing infrastructure", stages[jobState], { label: "Preparing…", action: "none", disabled: true }, [{ label: "Stage", value: jobState.replaceAll("_", " ") }], 1_000);
  }
  if (jobState === "needs_input") {
    const question = questionFor(serviceState);
    return state("needs_input", "Input required", question?.prompt ?? "Preparation needs one answer before it can continue.", { label: "Provide input", action: "input", disabled: !question }, [], null, question);
  }
  if (jobState === "failed") {
    return state("failed", "Preparation failed", "The local preparation job did not complete. You can retry it.", { label: "Retry preparation", action: "prepare", disabled: false });
  }
  if (jobState === "ready") {
    const revision = typeof serviceState?.infrastructureId === "string" && INFRASTRUCTURE_ID.test(serviceState.infrastructureId)
      ? serviceState.infrastructureId
      : "Published infrastructure";
    return state("ready", "Ready to start", `${revision} passed all preflight checks.`, { label: "Start autoresearch", action: "start", disabled: true }, [{ label: "Revision", value: revision }]);
  }
  if (jobState === "interrupted") {
    return state("interrupted", "Preparation interrupted", "The local process stopped before preparation completed. You can retry it.", { label: "Retry preparation", action: "prepare", disabled: false });
  }
  return state("unavailable", "Preparation unavailable", "The local preparation status is not available yet.", { label: "Prepare autoresearch", action: "prepare", disabled: true }, [], 5_000);
}

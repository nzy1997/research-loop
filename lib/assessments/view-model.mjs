export function formatScoreInterval(interval) {
  if (!interval) return "—";
  return `${interval.estimate} (${interval.min}-${interval.max})`;
}

export function assessmentStatusCopy(state) {
  switch (state?.kind) {
    case "never":
      return {
        heading: "No assessment yet",
        body: "Run a local Codex assessment for this problem.",
        actionLabel: "Run assessment",
      };
    case "queued":
      return {
        heading: "Assessment queued",
        body: `Queue position ${state.queuePosition}.`,
        actionLabel: null,
      };
    case "running":
      return {
        heading: "Assessment running",
        body: `Elapsed ${state.elapsedSeconds ?? 0}s.`,
        actionLabel: null,
      };
    case "needs-input":
      return {
        heading: "Knowledge match needs input",
        body: "Choose the exact trusted knowledge match to continue.",
        actionLabel: null,
      };
    case "completed":
      return {
        heading: "Assessment complete",
        body: "Recommendation is advisory and does not change lifecycle status.",
        actionLabel: "Rerun",
      };
    case "failed":
      return {
        heading: "Assessment failed",
        body: state.reason ?? "Open diagnostics for details.",
        actionLabel: "Retry",
      };
    case "stale":
      return {
        heading: "Assessment may be stale",
        body: "Inputs changed since this report was generated.",
        actionLabel: "Run new assessment",
      };
    default:
      return {
        heading: "Local assessment unavailable",
        body: "Start the local development server to run assessments.",
        actionLabel: null,
      };
  }
}

export function latestAssessmentSummary(problemState) {
  const runs = [...(problemState?.runs ?? [])];
  runs.sort((a, b) => String(b.runId ?? "").localeCompare(String(a.runId ?? "")));
  return runs.find((run) => run.status === "completed" && run.summary)?.summary ?? null;
}

export function assessmentStateFromProblemResponse(body) {
  const runs = body?.runs ?? [];
  if (body?.activeJob) {
    const status = body.activeJob.status;
    return {
      kind: status === "queued" ? "queued" : status,
      ...body.activeJob,
      runs,
    };
  }
  const latestRun = runs[0];
  if (latestRun?.status === "failed") {
    return {
      kind: "failed",
      reason: latestRun.error?.message ?? "Open diagnostics for details.",
      latest: body?.latest ?? latestAssessmentSummary(body),
      runs,
    };
  }
  if (body?.stale) return { kind: "stale", latest: body.latest, runs };
  if (body?.latest) return { kind: "completed", latest: body.latest, runs };
  const latest = latestAssessmentSummary(body);
  if (latest) return { kind: "completed", latest, runs };
  if (latestRun?.status === "completed") {
    return {
      kind: "completed",
      latest: {
        reportHref: `/__local/assessments/reports/${encodeURIComponent(latestRun.problemId)}/${encodeURIComponent(latestRun.runId)}`,
      },
      runs,
    };
  }
  return { kind: "never", runs };
}

export function isLocalAssessmentUnavailable(errorOrResponse) {
  return errorOrResponse instanceof TypeError || errorOrResponse?.status === 404;
}

export async function assessmentServiceFailure(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Fall back to the HTTP status when the proxy did not return JSON.
  }
  const code = payload?.code ?? payload?.error ?? null;
  const reason = payload?.message
    ? `${payload.message}${code ? ` (${code})` : ""}`
    : `Local service returned ${response.status}${code ? ` (${code})` : ""}.`;
  return { kind: "failed", reason };
}

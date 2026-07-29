"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assessmentStatusCopy,
  assessmentServiceFailure,
  assessmentStateFromProblemResponse,
  formatScoreInterval,
  isLocalAssessmentUnavailable,
  latestAssessmentSummary,
} from "@/lib/assessments/view-model.mjs";

type ClarificationAlternative = {
  page: string;
  topic: string;
  title: string;
  matchKind: string;
};

type ScoreInterval = {
  min: number;
  estimate: number;
  max: number;
};

type AssessmentSummary = {
  verdict?: string;
  recommendation?: string;
  confidence?: string;
  scores?: {
    researchValue?: ScoreInterval;
    autoresearchSuitability?: ScoreInterval;
    combined?: ScoreInterval;
  };
  largestBottleneck?: string;
  reportHref?: string;
};

type AssessmentRun = {
  runId?: string;
  problemId?: string;
  status?: string;
  summary?: AssessmentSummary | null;
  error?: { message?: string } | null;
};

type AssessmentState = {
  kind: string;
  runId?: string;
  reason?: string;
  latest?: AssessmentSummary | null;
  runs?: AssessmentRun[];
  clarification?: {
    query?: string;
    reason?: string;
    alternatives?: ClarificationAlternative[];
  };
  queuePosition?: number;
  elapsedSeconds?: number;
};

type ProblemAssessmentResponse = {
  activeJob?: AssessmentState | null;
  stale?: boolean;
  latest?: AssessmentSummary | null;
  runs?: AssessmentRun[];
};

type Props = { problemId: string };
const EMPTY_ALTERNATIVES: ClarificationAlternative[] = [];
const DEFAULT_SELECTION = { runId: null, index: "0" };

export function AssessmentPanel({ problemId }: Props) {
  const [state, setState] = useState<AssessmentState>({ kind: "unavailable" });
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ runId: string | null; index: string }>(DEFAULT_SELECTION);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/__local/assessments/problems/${encodeURIComponent(problemId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        setState(isLocalAssessmentUnavailable(response)
          ? { kind: "unavailable" }
          : await assessmentServiceFailure(response));
        return;
      }
      setState(assessmentStateFromProblemResponse(await response.json() as ProblemAssessmentResponse) as AssessmentState);
    } catch (error) {
      setState(isLocalAssessmentUnavailable(error) ? { kind: "unavailable" } : {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }, [problemId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!["queued", "running"].includes(state.kind)) return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refresh, state.kind]);

  async function start() {
    setBusy(true);
    try {
      const response = await fetch("/__local/assessments/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problemId }),
      });
      if (response.ok) await refresh();
      else setState(await assessmentServiceFailure(response));
    } catch (error) {
      setState(isLocalAssessmentUnavailable(error) ? { kind: "unavailable" } : {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const alternatives = state.clarification?.alternatives ?? EMPTY_ALTERNATIVES;
  const selectionRunId = state.runId ?? null;
  const selectedAlternativeIndex = selection.runId === selectionRunId ? selection.index : "0";
  const selectedAlternative = useMemo(
    () => alternatives[Number.parseInt(selectedAlternativeIndex, 10)] ?? alternatives[0],
    [alternatives, selectedAlternativeIndex],
  );

  async function submitSelection() {
    if (!state.runId || !selectedAlternative) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/__local/assessments/jobs/${encodeURIComponent(state.runId)}/selection`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ alternative: selectedAlternative }),
        },
      );
      if (response.ok) await refresh();
      else setState(await assessmentServiceFailure(response));
    } catch (error) {
      setState(isLocalAssessmentUnavailable(error) ? { kind: "unavailable" } : {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const copy = assessmentStatusCopy(state);
  const latest = state.latest ?? (latestAssessmentSummary(state) as AssessmentSummary | null);

  return (
    <section className={`assessment-panel assessment-${state.kind}`} aria-labelledby="assessment-heading">
      <div className="assessment-panel-head">
        <div>
          <p className="eyebrow">QUALIFICATION</p>
          <h2 id="assessment-heading">{copy.heading}</h2>
          <p>{copy.body}</p>
        </div>
        {copy.actionLabel && (
          <button className="state-action" type="button" onClick={start} disabled={busy}>
            {busy ? "Starting…" : copy.actionLabel}
          </button>
        )}
      </div>

      {state.kind === "needs-input" && alternatives.length > 0 && (
        <div className="assessment-clarification">
          {state.clarification?.reason && <p>{state.clarification.reason}</p>}
          <fieldset className="assessment-options">
            <legend>Trusted knowledge match</legend>
            {alternatives.map((alternative, index) => (
              <label className="assessment-option" key={`${index}:${alternative.page}:${alternative.matchKind}`}>
                <input
                  type="radio"
                  name={`assessment-alternative-${state.runId}`}
                  value={String(index)}
                  checked={selectedAlternativeIndex === String(index)}
                  onChange={() => setSelection({ runId: selectionRunId, index: String(index) })}
                />
                <span>
                  <strong>{alternative.title}</strong>
                  <small>{alternative.page} · {alternative.topic} · {alternative.matchKind}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <button className="state-action" type="button" onClick={submitSelection} disabled={busy}>
            {busy ? "Submitting…" : "Continue assessment"}
          </button>
        </div>
      )}

      {latest?.verdict && (
        <dl className="assessment-summary-grid">
          <div><dt>Verdict</dt><dd>{latest.verdict}</dd></div>
          <div><dt>Recommendation</dt><dd>{latest.recommendation}</dd></div>
          <div><dt>Confidence</dt><dd>{latest.confidence}</dd></div>
          <div><dt>V</dt><dd>{formatScoreInterval(latest.scores?.researchValue)}</dd></div>
          <div><dt>A</dt><dd>{formatScoreInterval(latest.scores?.autoresearchSuitability)}</dd></div>
          <div><dt>S</dt><dd>{formatScoreInterval(latest.scores?.combined)}</dd></div>
        </dl>
      )}
      {latest?.largestBottleneck && <p className="assessment-bottleneck">{latest.largestBottleneck}</p>}
      {latest?.reportHref && (
        <a className="open-affordance" href={latest.reportHref}>
          Open detailed report <span aria-hidden="true">→</span>
        </a>
      )}
    </section>
  );
}

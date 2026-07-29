"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { buildPreparationPanelState } from "@/lib/autoresearch/view-model.mjs";
import styles from "./autoresearch-panel.module.css";

type PublicQuestion = {
  id: string;
  prompt: string;
  answerType: "text" | "choice";
  choices: string[];
};

type ServiceState = {
  jobId?: string;
  state?: string;
  infrastructureId?: string;
  question?: PublicQuestion;
};

const jobIdPattern = /^ARJ-\d{8}T\d{6}Z-[a-f0-9]{8}$/;

export function AutoresearchPanel({
  problemId,
  initialEligibility,
  sidecarAvailable,
}: {
  problemId: string;
  initialEligibility: boolean;
  sidecarAvailable: boolean;
}) {
  const [serviceState, setServiceState] = useState<ServiceState | null>(null);
  const [answer, setAnswer] = useState("");
  const requestSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const localMode = sidecarAvailable;
  const view = buildPreparationPanelState({
    problem: { id: problemId, status: initialEligibility ? "qualifying" : "draft" },
    serviceState,
    localMode,
  });

  const request = useCallback(async (path: string, options?: RequestInit) => {
    controller.current?.abort();
    const currentController = new AbortController();
    controller.current = currentController;
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(path, { ...options, signal: currentController.signal });
      if (sequence !== requestSequence.current) return;
      if (response.status === 404 && !options) {
        setServiceState(null);
        return;
      }
      if (!response.ok) return;
      const payload = await response.json();
      if (sequence !== requestSequence.current || currentController.signal.aborted) return;
      setServiceState(payload);
    } catch (error) {
      if ((error as Error).name !== "AbortError") return;
    }
  }, []);

  const refresh = useCallback(() => request(`/__local/autoresearch/problems/${problemId}`), [problemId, request]);

  useEffect(() => {
    if (!localMode) return undefined;
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(initialRefresh);
  }, [refresh, localMode]);

  useEffect(() => {
    if (!localMode || view.pollAfterMs === null) return undefined;
    const poll = window.setTimeout(() => void refresh(), view.pollAfterMs);
    return () => window.clearTimeout(poll);
  }, [refresh, localMode, view.pollAfterMs, serviceState?.jobId, serviceState?.state]);

  useEffect(() => () => controller.current?.abort(), []);

  const prepare = () => {
    if (!localMode) return;
    void request(`/__local/autoresearch/problems/${problemId}/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  };

  const submitInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = view.question;
    const jobId = serviceState?.jobId;
    if (!question || !jobId || !jobIdPattern.test(jobId) || !answer.trim()) return;
    void request(`/__local/autoresearch/jobs/${jobId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { [question.id]: answer } }),
    });
  };

  const primary = view.primary.action === "prepare"
    ? <button className={styles.primary} type="button" disabled={view.primary.disabled} onClick={prepare}>{view.primary.label}</button>
    : null;

  return (
    <section className={styles.panel} aria-labelledby={`autoresearch-${problemId}`}>
      <div className={styles.heading}>
        <p className={styles.eyebrow}>{view.eyebrow}</p>
        <h2 id={`autoresearch-${problemId}`}>{view.title}</h2>
      </div>
      <div className={styles.body} aria-live="polite">
        <p>{view.body}</p>
        {view.metadata.length > 0 ? (
          <dl className={styles.metadata}>
            {view.metadata.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
          </dl>
        ) : null}
        {view.kind === "ready" ? <p className={styles.note}>Campaign execution is added in the next implementation phase.</p> : null}
        {view.kind === "needs_input" && view.question ? (
          <form className={styles.form} onSubmit={submitInput}>
            <label htmlFor={`autoresearch-answer-${problemId}`}>{view.question.prompt}</label>
            {view.question.answerType === "choice" ? (
              <select id={`autoresearch-answer-${problemId}`} value={answer} onChange={(event) => setAnswer(event.target.value)} required>
                <option value="">Choose one</option>
                {view.question.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
            ) : <input id={`autoresearch-answer-${problemId}`} value={answer} onChange={(event) => setAnswer(event.target.value)} required />}
            <button className={styles.primary} type="submit" disabled={!answer.trim()}>{view.primary.label}</button>
          </form>
        ) : primary}
        {view.primary.action === "none" ? <button className={styles.primary} type="button" disabled>{view.primary.label}</button> : null}
        {view.primary.action === "start" ? <button className={styles.primary} type="button" disabled>{view.primary.label}</button> : null}
      </div>
    </section>
  );
}

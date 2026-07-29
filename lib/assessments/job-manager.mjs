import { createArtifactStore } from "./artifact-store.mjs";
import { checkCodexPreflight, runCodexAssessment } from "./codex-adapter.mjs";
import { summarizeCompletedAssessment } from "./contract.mjs";
import { renderAssessmentReport } from "./html-report.mjs";
import { buildInputSnapshot } from "./input-snapshot.mjs";
import { evaluateAssessmentStaleness } from "./staleness.mjs";
import { join } from "node:path";

import { ASSESSMENT_SCHEMA_PATH_SEGMENTS } from "./policy.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running", "needs-input"]);
const RESOLUTION_MISMATCH = {
  code: "KNOWLEDGE_RESOLUTION_MISMATCH",
  message: "Codex knowledge resolution does not match the trusted host resolver.",
};

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hostResolutionClaim(result) {
  return {
    query: result.query,
    status: result.status,
    topic: result.status === "match" ? result.bundle?.topic ?? null : null,
    orderedFiles: result.status === "match" ? [...(result.bundle?.orderedFiles ?? [])] : [],
  };
}

function publicAlternative(candidate) {
  return {
    page: candidate.page,
    topic: candidate.topic,
    title: candidate.title,
    matchKind: candidate.matchKind,
  };
}

function resolutionMatches(envelope, trusted) {
  const claim = envelope?.knowledgeResolution;
  if (!claim || !sameJson(claim, hostResolutionClaim(trusted))) return false;
  if (trusted.status !== "ambiguous") return true;
  return envelope.outcome === "needs_input"
    && envelope.clarification?.query === trusted.query
    && sameJson(
      envelope.clarification?.alternatives,
      trusted.alternatives.map(publicAlternative),
    );
}

function defaultCodex() {
  return {
    preflight: checkCodexPreflight,
    run: runCodexAssessment,
  };
}

function defaultSnapshot() {
  return { build: buildInputSnapshot };
}

function defaultReportRenderer() {
  return { render: renderAssessmentReport };
}

function publicRun(run) {
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    problemId: run.problemId,
    parentRunId: run.parentRunId ?? null,
    status: run.status,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    error: run.error ?? null,
    summary: run.summary ?? null,
  };
}

function publicJob(job) {
  if (!job) return null;
  const value = {
    runId: job.runId,
    problemId: job.problemId,
    status: job.status,
    queuePosition: job.queuePosition ?? 0,
  };
  if (job.clarification) value.clarification = job.clarification;
  if (job.selectedRunId) value.selectedRunId = job.selectedRunId;
  if (job.run?.summary) value.summary = job.run.summary;
  if (job.run?.error) value.error = job.run.error;
  return value;
}

export function createAssessmentJobManager({
  rootDir,
  repository,
  now,
  store = createArtifactStore({ rootDir, now }),
  codex = defaultCodex(),
  snapshot = defaultSnapshot(),
  reportRenderer = defaultReportRenderer(),
  resolveKnowledge = null,
  staleness = { evaluate: evaluateAssessmentStaleness },
} = {}) {
  const skillPath = join(rootDir, "skills", "assess-research-problem", "SKILL.md");
  const schemaPath = join(rootDir, ...ASSESSMENT_SCHEMA_PATH_SEGMENTS);
  const queue = [];
  const jobs = new Map();
  const starts = new Map();
  const selections = new Map();
  let active = null;

  async function start(problemId) {
    const existingStart = starts.get(problemId);
    if (existingStart) return existingStart;

    const accepted = startNew(problemId);
    starts.set(problemId, accepted);
    try {
      return await accepted;
    } finally {
      // Keep the acceptance promise through the current turn. This makes two
      // near-simultaneous requests share one formal run even if a fast Codex
      // failure settles before the caller issues its duplicate request.
      setImmediate(() => {
        if (starts.get(problemId) === accepted) starts.delete(problemId);
      });
    }
  }

  async function startNew(problemId) {
    const problem = repository.getProblem(problemId);
    if (!problem) {
      return { accepted: false, code: "UNKNOWN_PROBLEM", message: `Problem ${problemId} was not found.` };
    }
    for (const job of jobs.values()) {
      if (job.problemId === problemId && isActive(job)) {
        return { accepted: true, runId: job.runId, status: job.status };
      }
    }
    const persistedParent = await findPersistedNeedsInput(problemId);
    if (persistedParent) {
      return { accepted: true, runId: persistedParent.runId, status: persistedParent.status };
    }

    const preflight = await codex.preflight({ rootDir, skillPath, schemaPath });
    if (!preflight.ok) return { accepted: false, code: preflight.code, message: preflight.message };

    const run = await store.createAcceptedRun({ problemId });
    const job = { runId: run.runId, problemId, status: "queued", queuePosition: queue.length + 1, run };
    jobs.set(job.runId, job);
    queue.push(job);
    void pump();
    return { accepted: true, runId: job.runId, status: job.status };
  }

  async function pump() {
    if (active || queue.length === 0) return;
    active = queue.shift();
    active.status = "running";
    active.queuePosition = 0;
    try {
      await execute(active);
    } finally {
      active = null;
      void pump();
    }
  }

  async function execute(job) {
    const problem = repository.getProblem(job.problemId);
    let diagnostics = { eventsText: "", stderr: "" };
    try {
      const problemMarkdown = await repository.readProblemMarkdown(job.problemId);
      const trustedResolution = job.selectedAlternative && resolveKnowledge
        ? await resolveKnowledge(job.knowledgeQuery, { selectedPage: job.selectedAlternative.page })
        : null;
      const runningAssessment = codex.run({
        rootDir,
        problem,
        problemMarkdown,
        runDir: job.run.stagingDir,
        schemaPath,
        selectedAlternative: job.selectedAlternative ?? null,
        trustedResolution,
        onChild: (child) => { job.child = child; },
      });
      if (runningAssessment?.child?.kill) job.child = runningAssessment.child;
      const result = await runningAssessment;
      if (result.child?.kill) job.child = result.child;
      diagnostics = {
        eventsText: result.eventsText ?? "",
        stderr: result.stderr ?? "",
      };
      if (!result.ok) {
        await writeTerminal(job, {
          status: "failed",
          input: { schemaVersion: 1, problemId: job.problemId },
          error: { code: result.code, message: result.message },
          ...diagnostics,
        });
        return;
      }
      if (resolveKnowledge) {
        const claim = result.envelope.knowledgeResolution;
        const trusted = trustedResolution ?? await resolveKnowledge(claim?.query);
        if (!resolutionMatches(result.envelope, trusted)) {
          await writeTerminal(job, {
            status: "failed",
            input: { schemaVersion: 1, problemId: job.problemId },
            error: RESOLUTION_MISMATCH,
            ...diagnostics,
          });
          return;
        }
      }
      if (result.envelope.outcome === "needs_input") {
        job.clarification = result.envelope.clarification;
        await writeTerminal(job, {
          status: "needs-input",
          input: { schemaVersion: 1, problemId: job.problemId },
          clarification: result.envelope,
          ...diagnostics,
        });
        return;
      }
      const input = await snapshot.build({
        rootDir,
        problem,
        envelope: result.envelope,
        skillPath,
        schemaPath,
        selectedAlternative: job.selectedAlternative ?? null,
      });
      const reportHtml = reportRenderer.render({ run: job.run, input, envelope: result.envelope, computed: result.computed });
      const summary = summarizeCompletedAssessment({ run: job.run, envelope: result.envelope, computed: result.computed });
      await writeTerminal(job, {
        status: "completed",
        input,
        assessment: { envelope: result.envelope, computed: result.computed },
        summary,
        reportHtml,
        ...diagnostics,
      });
    } catch (error) {
      await writeTerminal(job, {
        status: "failed",
        input: { schemaVersion: 1, problemId: job.problemId },
        error: { code: "ASSESSMENT_ERROR", message: error.message },
        ...diagnostics,
      });
    }
  }

  async function writeTerminal(job, artifacts) {
    job.status = artifacts.status;
    if (job.selectedAlternative) artifacts.selection = job.selectedAlternative;
    job.run = await store.writeTerminalArtifacts(job.run, artifacts);
  }

  function isActive(job) {
    return ACTIVE_STATUSES.has(job.status) && !(job.status === "needs-input" && job.selectedRunId);
  }

  async function findPersistedNeedsInput(problemId) {
    const runs = await store.listRuns(problemId);
    const selectedParents = new Set(runs.map((run) => run.parentRunId).filter(Boolean));
    const run = runs.find((item) => item.status === "needs-input" && !selectedParents.has(item.runId));
    return run ? hydrateNeedsInput(run) : null;
  }

  async function hydrateNeedsInput(run) {
    const existing = jobs.get(run.runId);
    if (existing) return existing;
    const envelope = await store.readClarification(run.problemId, run.runId);
    if (!envelope?.clarification) return null;
    const job = { runId: run.runId, problemId: run.problemId, status: "needs-input", queuePosition: 0, run, clarification: envelope.clarification };
    const selectedRun = (await store.listRuns(run.problemId)).find((item) => item.parentRunId === run.runId);
    if (selectedRun) {
      job.selectedRunId = selectedRun.runId;
      jobs.set(selectedRun.runId, {
        runId: selectedRun.runId,
        problemId: selectedRun.problemId,
        status: selectedRun.status,
        queuePosition: 0,
        run: selectedRun,
      });
    }
    jobs.set(job.runId, job);
    return job;
  }

  async function getProblemState(problemId) {
    const runs = await store.listRuns(problemId);
    let activeJob = [...jobs.values()].find((job) => job.problemId === problemId && isActive(job)) ?? null;
    if (!activeJob) activeJob = await findPersistedNeedsInput(problemId);
    const publicRuns = runs.map(publicRun);
    const latestRun = runs.find((run) => run.status === "completed" && run.summary);
    let stale = false;
    let staleReasons = [];
    if (latestRun?.summary && store.readInput && resolveKnowledge) {
      try {
        const input = await store.readInput(latestRun.problemId, latestRun.runId);
        const result = await staleness.evaluate({ rootDir, input, resolveKnowledge });
        stale = result.stale;
        staleReasons = result.reasons;
      } catch (error) {
        stale = true;
        staleReasons = [`staleness check failed: ${error.message}`];
      }
    }
    return {
      service: "available",
      problemId,
      activeJob: publicJob(activeJob),
      latest: latestRun?.summary ?? null,
      stale,
      staleReasons,
      runs: publicRuns,
    };
  }

  async function select(runId, alternative) {
    const pendingSelection = selections.get(runId);
    if (pendingSelection) return pendingSelection;

    const accepted = selectNew(runId, alternative);
    selections.set(runId, accepted);
    try {
      return await accepted;
    } finally {
      selections.delete(runId);
    }
  }

  async function selectNew(runId, alternative) {
    let parent = jobs.get(runId);
    if (!parent && store.findRun) {
      const run = await store.findRun(runId);
      if (run?.status === "needs-input") parent = await hydrateNeedsInput(run);
    }
    if (!parent || parent.status !== "needs-input") {
      return { accepted: false, code: "INVALID_SELECTION_PARENT", message: "Selection parent is not awaiting input." };
    }
    if (parent.selectedRunId) {
      const child = jobs.get(parent.selectedRunId);
      return { accepted: true, runId: child.runId, status: child.status };
    }
    if (!parent.clarification?.alternatives.some((item) => (
      item.page === alternative?.page
      && item.topic === alternative?.topic
      && item.title === alternative?.title
      && item.matchKind === alternative?.matchKind
    ))) {
      return { accepted: false, code: "INVALID_SELECTION", message: "Selection is not one of the clarification alternatives." };
    }
    const childRun = await store.createAcceptedRun({ problemId: parent.problemId, parentRunId: runId });
    const child = {
      runId: childRun.runId,
      problemId: parent.problemId,
      status: "queued",
      queuePosition: queue.length + 1,
      run: childRun,
      selectedAlternative: alternative,
      knowledgeQuery: parent.clarification.query,
    };
    jobs.set(child.runId, child);
    parent.selectedRunId = child.runId;
    queue.push(child);
    void pump();
    return { accepted: true, runId: child.runId, status: child.status };
  }

  async function shutdown() {
    if (active?.child?.kill) active.child.kill("SIGTERM");
  }

  return { start, select, getProblemState, getJob: (runId) => publicJob(jobs.get(runId) ?? null), shutdown };
}

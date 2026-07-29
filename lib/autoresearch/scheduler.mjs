function publicJob(job) {
  return { jobId: job.jobId, problemId: job.problemId, kind: job.kind, state: job.state };
}

function validJob(job) {
  return job && typeof job.jobId === "string" && job.jobId && typeof job.problemId === "string" && job.problemId && typeof job.kind === "string" && job.kind && typeof job.state === "string" && job.state;
}

export function createScheduler({ concurrency = 2, runJob } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer");
  if (typeof runJob !== "function") throw new TypeError("runJob is required");
  const queued = [];
  const active = new Map();
  const byProblem = new Map();
  let stopping = false;

  function finish(entry, outcome) {
    active.delete(entry.job.jobId);
    if (outcome?.state === "needs_input") byProblem.set(entry.job.problemId, { ...entry.job, state: "needs_input" });
    else if (byProblem.get(entry.job.problemId)?.jobId === entry.job.jobId) byProblem.delete(entry.job.problemId);
    pump();
  }

  function launch(job) {
    const entry = { job, worker: null, terminate: null };
    active.set(job.jobId, entry);
    try {
      const result = runJob(job);
      if (result && typeof result === "object" && "promise" in result) {
        entry.terminate = typeof result.terminate === "function" ? result.terminate : null;
        entry.worker = Promise.resolve(result.promise);
      } else entry.worker = Promise.resolve(result);
    } catch (error) { entry.worker = Promise.reject(error); }
    entry.worker.then((outcome) => finish(entry, outcome), () => finish(entry, { state: "failed" }));
  }

  function pump() {
    while (!stopping && active.size < concurrency && queued.length) launch(queued.shift());
  }

  function enqueue(job) {
    if (!validJob(job)) throw new TypeError("jobId, problemId, kind, and state are required");
    const reserved = byProblem.get(job.problemId);
    if (reserved) return reserved;
    const accepted = { ...job };
    byProblem.set(accepted.problemId, accepted);
    queued.push(accepted);
    pump();
    return accepted;
  }

  function restoreSuspended(job) {
    if (!validJob(job) || job.state !== "needs_input") throw new TypeError("a valid needs_input job is required");
    const reserved = byProblem.get(job.problemId);
    if (reserved) {
      if (reserved.jobId !== job.jobId) throw new RangeError("problem already has a different reserved job");
      return reserved;
    }
    const restored = { ...job };
    byProblem.set(restored.problemId, restored);
    return restored;
  }

  function resumeAfterInput(job) {
    if (!validJob(job)) throw new TypeError("jobId, problemId, kind, and state are required");
    const reserved = byProblem.get(job.problemId);
    if (!reserved || reserved.state !== "needs_input") throw new RangeError("problem has no suspended job to resume");
    if (reserved.jobId !== job.parentJobId) throw new RangeError("resumed job must descend from the reserved job");
    byProblem.set(job.problemId, { ...job });
    queued.push(byProblem.get(job.problemId));
    pump();
    return byProblem.get(job.problemId);
  }

  function snapshot() {
    return {
      concurrency,
      active: [...active.values()].map((entry) => publicJob(entry.job)),
      queued: queued.map((job, index) => ({ jobId: job.jobId, problemId: job.problemId, position: index + 1 })),
    };
  }

  async function shutdown() {
    stopping = true;
    const entries = [...active.values()];
    await Promise.all(entries.map((entry) => Promise.resolve(entry.terminate?.())));
    await Promise.all(entries.map((entry) => entry.worker.catch(() => undefined)));
  }

  return Object.freeze({ enqueue, restoreSuspended, resumeAfterInput, snapshot, shutdown });
}

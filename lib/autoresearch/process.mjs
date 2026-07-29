import { spawn } from "node:child_process";

export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1 * 1024 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

const ENVIRONMENT_ALLOWLIST = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]);

export class ProcessExecutionError extends Error {
  constructor(code, signal, stdout, stderr) {
    super(`Process exited unsuccessfully (code: ${code}, signal: ${signal ?? "none"})`);
    this.name = "ProcessExecutionError";
    this.code = code;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class ProcessOutputLimitError extends Error {
  constructor(stream, limit) {
    super(`${stream} exceeded ${limit} bytes`);
    this.name = "ProcessOutputLimitError";
    this.stream = stream;
    this.limit = limit;
  }
}

export class ProcessTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Process exceeded ${timeoutMs}ms`);
    this.name = "ProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function copyAllowedEnvironment(environment, privateDataRoot) {
  const result = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    if (typeof environment?.[key] === "string") result[key] = environment[key];
  }
  if (typeof privateDataRoot === "string" && privateDataRoot.length > 0) result.AUTORESEARCH_PRIVATE_ROOT = privateDataRoot;
  return result;
}

function stop(child, killFn, signal) {
  try { killFn(child, signal); } catch { /* A process may have already exited. */ }
}

export function runProcess({
  command,
  args,
  cwd,
  env,
  privateDataRoot,
  timeoutMs,
  graceMs = DEFAULT_TERMINATION_GRACE_MS,
  onStdoutLine,
  signal,
  spawnFn = spawn,
  killFn = (child, signal) => child.kill(signal),
}) {
  if (typeof command !== "string" || command.length === 0) throw new TypeError("command must be a non-empty string");
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new TypeError("args must be a string array");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError("graceMs must be non-negative");
  if (privateDataRoot !== undefined && (typeof privateDataRoot !== "string" || privateDataRoot.length === 0)) throw new TypeError("privateDataRoot must be a non-empty string when provided");

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        env: copyAllowedEnvironment(env, privateDataRoot),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lineBuffer = "";
    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    let graceTimer = null;
    let timeoutTimer = null;

    const cleanup = ({ keepGrace = false } = {}) => {
      clearTimeout(timeoutTimer);
      if (!keepGrace && graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener?.("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off?.("error", onError);
      if (!keepGrace) {
        child.off?.("exit", onExit);
        child.off?.("close", onClose);
      }
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error, options) => {
      if (settled) return;
      settled = true;
      cleanup(options);
      reject(error);
    };
    const scheduleForcedKill = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => stop(child, killFn, "SIGKILL"), graceMs);
      graceTimer.unref?.();
    };
    const cancelForcedKill = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      child.off?.("exit", onExit);
      child.off?.("close", onClose);
    };
    const append = (stream, chunk, limit) => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      if ((stream === "stdout" ? stdoutBytes : stderrBytes) > limit) {
        stop(child, killFn, "SIGTERM");
        scheduleForcedKill();
        finishReject(new ProcessOutputLimitError(stream, limit), { keepGrace: true });
        return false;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      return true;
    };
    const onStdout = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (!append("stdout", text, MAX_STDOUT_BYTES)) return;
      if (!onStdoutLine) return;
      lineBuffer += text;
      let lineEnd;
      while ((lineEnd = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, lineEnd).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(lineEnd + 1);
        if (line.length > 0) {
          try { onStdoutLine(line); } catch (error) { finishReject(error); return; }
        }
      }
    };
    const onStderr = (chunk) => append("stderr", Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk), MAX_STDERR_BYTES);
    const onError = (error) => finishReject(error);
    const onAbort = () => {
      if (settled) return;
      clearTimeout(timeoutTimer);
      stop(child, killFn, "SIGTERM");
      scheduleForcedKill();
    };
    const onExit = (code, signal) => {
      if (settled) {
        cancelForcedKill();
        return;
      }
      exitCode = code;
      exitSignal = signal;
    };
    const onClose = (code, signal) => {
      if (settled) {
        cancelForcedKill();
        return;
      }
      const finalCode = exitCode ?? code;
      const finalSignal = exitSignal ?? signal;
      if (finalCode === 0) finishResolve({ stdout, stderr, code: finalCode, signal: finalSignal });
      else finishReject(new ProcessExecutionError(finalCode, finalSignal, stdout, stderr));
    };

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      stop(child, killFn, "SIGTERM");
      graceTimer = setTimeout(() => {
        if (settled) return;
        stop(child, killFn, "SIGKILL");
        finishReject(new ProcessTimeoutError(timeoutMs));
      }, graceMs);
      graceTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

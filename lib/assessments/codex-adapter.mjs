import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseAssessmentFinalMessage } from "./contract.mjs";
import { ASSESSMENT_SCHEMA_PATH_SEGMENTS } from "./policy.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_CODEX_TIMEOUT_MS = 30 * 60 * 1000;

function runPreflightCommand(execFileFn, command, args, options) {
  if (execFileFn.length >= 4) {
    return new Promise((resolve, reject) => {
      execFileFn(command, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  }
  return Promise.resolve(execFileFn(command, args, options));
}

export async function checkCodexPreflight({
  rootDir,
  codexCommand = "codex",
  execFileFn = execFileAsync,
  skillPath = join(rootDir, "skills", "assess-research-problem", "SKILL.md"),
  schemaPath = join(rootDir, ...ASSESSMENT_SCHEMA_PATH_SEGMENTS),
  fileExists = async (path) => access(path).then(() => true, () => false),
}) {
  if (!await fileExists(skillPath)) return { ok: false, code: "MISSING_SKILL", message: "Assessment skill is missing." };
  if (!await fileExists(schemaPath)) return { ok: false, code: "MISSING_SCHEMA", message: "Assessment output schema is missing." };
  try {
    const version = await runPreflightCommand(execFileFn, codexCommand, ["--version"], { cwd: rootDir });
    await runPreflightCommand(execFileFn, codexCommand, ["login", "status"], { cwd: rootDir });
    return { ok: true, version: String(version.stdout ?? version[0] ?? "").trim() };
  } catch (error) {
    return { ok: false, code: "CODEX_PREFLIGHT", message: error.message };
  }
}

export function buildAssessmentPrompt({
  problem,
  problemMarkdown,
  selectedAlternative = null,
  trustedResolution = null,
}) {
  const hasHostSelection = selectedAlternative && trustedResolution?.status === "match";
  const resolverInstruction = hasHostSelection
    ? [
        "The host resolver has already applied the user's explicit selection.",
        "Treat the supplied trusted resolution as final: read every ordered file in order, do not rerun the resolver, and do not return needs_input.",
        "Return the supplied query, status, topic, and orderedFiles exactly in knowledgeResolution.",
      ].join(" ")
    : "If the resolver is ambiguous, return outcome needs_input with every alternative.";
  const selectionText = selectedAlternative
    ? [
        `User selected resolver alternative title: ${selectedAlternative.title}`,
        `Page: ${selectedAlternative.page}`,
        `Topic: ${selectedAlternative.topic}`,
        hasHostSelection
          ? `Trusted knowledge resolution:\n${JSON.stringify({
              query: trustedResolution.query,
              status: trustedResolution.status,
              topic: trustedResolution.bundle.topic,
              orderedFiles: trustedResolution.bundle.orderedFiles,
            }, null, 2)}`
          : "",
      ].filter(Boolean).join("\n")
    : "";
  return [
    "Use the repo-local assess-research-problem skill.",
    "Return only the structured schema response.",
    "Do not modify problem.json, problem.md, knowledge, drafts, literature, or assessments.",
    resolverInstruction,
    selectionText,
    `Problem ID: ${problem.id}`,
    `Problem title: ${problem.title}`,
    `Problem summary: ${problem.summary}`,
    "problem.md:",
    problemMarkdown,
  ].join("\n\n");
}

export function runCodexAssessment({
  rootDir,
  problem,
  problemMarkdown,
  runDir,
  schemaPath,
  codexCommand = "codex",
  spawnFn = spawn,
  timeoutMs = DEFAULT_CODEX_TIMEOUT_MS,
  selectedAlternative = null,
  trustedResolution = null,
  onChild = null,
}) {
  return new Promise((resolve) => {
    const finalMessagePath = join(runDir, "final-message.json");
    const prompt = buildAssessmentPrompt({ problem, problemMarkdown, selectedAlternative, trustedResolution });
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--ephemeral",
      "--json",
      "--output-schema", schemaPath,
      "--output-last-message", finalMessagePath,
      prompt,
    ];
    let child;
    try {
      child = spawnFn(codexCommand, args, { cwd: rootDir, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      onChild?.(child);
    } catch (error) {
      resolve({ ok: false, code: "CODEX_SPAWN", message: error.message, eventsText: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const effectiveTimeoutMs = Math.min(timeoutMs, DEFAULT_CODEX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, effectiveTimeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      finish({ ok: false, code: "CODEX_SPAWN", message: error.message, eventsText: stdout, stderr });
    });
    child.on("exit", (code) => {
      exitCode = code;
    });
    child.on("close", async (code) => {
      if (timedOut) {
        finish({ ok: false, code: "CODEX_TIMEOUT", message: "Codex assessment exceeded 30 minutes.", eventsText: stdout, stderr });
        return;
      }
      const completedCode = exitCode ?? code;
      if (completedCode !== 0) {
        finish({ ok: false, code: "CODEX_EXIT", message: `Codex exited with status ${completedCode}.`, eventsText: stdout, stderr });
        return;
      }
      try {
        const text = await readFile(finalMessagePath, "utf8");
        const parsed = parseAssessmentFinalMessage(text);
        if (!parsed.ok) {
          finish({ ok: false, code: "INVALID_FINAL", message: parsed.errors.join("\n"), eventsText: stdout, stderr });
          return;
        }
        finish({ ok: true, envelope: parsed.value, computed: parsed.computed, eventsText: stdout, stderr });
      } catch (error) {
        finish({ ok: false, code: "MISSING_FINAL", message: error.message, eventsText: stdout, stderr });
      }
    });
  });
}

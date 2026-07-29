import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

import { createAssessmentJobManager } from "../lib/assessments/job-manager.mjs";
import { createAssessmentService } from "../lib/assessments/local-service.mjs";
import { createProblemRepository } from "../lib/problems/repository.mjs";

const execFileAsync = promisify(execFile);

async function createLocalRepository(rootDir) {
  const generatedIndex = JSON.parse(await readFile(join(rootDir, ".generated", "problem-index.json"), "utf8"));
  const repository = createProblemRepository(generatedIndex);
  return {
    ...repository,
    async readProblemMarkdown(problemId) {
      const problem = repository.getProblem(problemId);
      if (!problem) return null;
      return readFile(join(rootDir, "problems", problemId, "problem.md"), "utf8");
    },
  };
}

export function createKnowledgeResolver(rootDir, { execFileFn = execFileAsync } = {}) {
  return async function resolveKnowledge(query, { selectedPage } = {}) {
    const args = ["--import", "tsx", "scripts/knowledge.ts", "resolve", "--query", query];
    if (selectedPage) args.push("--select-page", selectedPage);
    const { stdout } = await execFileFn(
      process.execPath,
      args,
      { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
}

export async function startAssessmentService({
  rootDir = process.cwd(),
  token = process.env.LOCAL_ASSESSMENT_TOKEN ?? randomBytes(16).toString("hex"),
  port = 0,
  host = "127.0.0.1",
  manager = null,
} = {}) {
  if (host !== "127.0.0.1") throw new Error("Local assessment service must bind to 127.0.0.1.");
  const workspaceRoot = resolve(rootDir);
  const assessmentManager = manager ?? createAssessmentJobManager({
    rootDir: workspaceRoot,
    repository: await createLocalRepository(workspaceRoot),
    resolveKnowledge: createKnowledgeResolver(workspaceRoot),
  });
  const server = createAssessmentService({ rootDir: workspaceRoot, token, manager: assessmentManager });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  return {
    server,
    url,
    close: async () => {
      await assessmentManager.shutdown?.();
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.LOCAL_ASSESSMENT_TOKEN ?? randomBytes(16).toString("hex");
  const service = await startAssessmentService({ token });
  console.log(JSON.stringify({ url: service.url, token }));
}

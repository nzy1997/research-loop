import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedIndexUrl = new URL("../.generated/problem-index.json", import.meta.url);
const generatedIndex = JSON.parse(
  await readFile(generatedIndexUrl, "utf8"),
);
const fixedPublicationTargetPattern = new RegExp(["publication", "target"].join("\\s+"), "i");

const completeProblemMd = [
  "Background and Gap",
  "Research Objective",
  "Publication Threshold",
  "Executable Gate",
  "Novelty Evidence",
  "Provenance",
  "Fresh Evaluation Plan",
].map((heading) => `## ${heading}\nConcrete fixture content.`).join("\n\n");

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function buildCurrentIndex() {
  await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url)), "build"],
    {
      cwd: workspaceRoot,
      env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function writeFixtureProblem(root, manifest) {
  const problemDir = join(root, "problems", manifest.id);
  await mkdir(join(problemDir, "generation"), { recursive: true });
  await writeFile(join(problemDir, "problem.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(problemDir, "problem.md"), completeProblemMd);
  await writeFile(join(problemDir, "generation", "initial-prompt.md"), "Fixture prompt.");
  await writeFile(join(problemDir, "generation", "transcript.md"), "Fixture transcript.");
  await writeFile(join(problemDir, "generation", "decision.md"), "Fixture decision.");
}

async function renderFilesystemFixture({ manifests, damagedIds = [] }, pathname = "/?fixture=filesystem") {
  const originalIndexText = await readFile(generatedIndexUrl, "utf8");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "research-loop-render-"));
  await mkdir(join(fixtureRoot, "problems"), { recursive: true });
  for (const manifest of manifests) {
    await writeFixtureProblem(fixtureRoot, manifest);
  }
  for (const id of damagedIds) {
    const damagedDir = join(fixtureRoot, "problems", id);
    await mkdir(damagedDir, { recursive: true });
    await writeFile(join(damagedDir, "problem.json"), "{ broken json");
  }

  try {
    await execFileAsync(
      process.execPath,
      [
        "scripts/build-problem-index.mjs",
        "--root",
        fixtureRoot,
        "--out",
        fileURLToPath(generatedIndexUrl),
      ],
      {
        cwd: workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    await buildCurrentIndex();
    const response = await render(pathname);
    const html = await response.text();
    return new Response(html, { status: response.status, headers: response.headers });
  } finally {
    await writeFile(generatedIndexUrl, originalIndexText);
    await buildCurrentIndex();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const externalBinding = {
  kind: "git-path",
  repository: "https://github.com/example/research-problems",
  revision: "0123456789abcdef0123456789abcdef01234567",
  path: "problems/Prob-017",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const acceptedFixture = {
  schemaVersion: 1,
  id: "Prob-017",
  title: "Fresh Hamiltonian gate",
  summary: "Interval arithmetic on held-out instances.",
  status: "accepted",
  gate: { type: "interval-arithmetic", readiness: "executable" },
  provenance: { sourceCount: 12 },
  lastActivity: {
    summary: "Accepted after novelty review",
    at: "2026-07-27T10:30:00.000Z",
  },
  createdAt: "2026-07-27T09:00:00.000Z",
  updatedAt: "2026-07-27T11:45:00.000Z",
  sourceBinding: externalBinding,
};

test("server-renders the problem console shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Research Loop/);
  assert.match(html, /Problem Console/);
  assert.match(html, /<a class="topbar-link" href="\/knowledge\/">Knowledge <span aria-hidden="true">→<\/span><\/a>/);
  assert.match(html, />\+ Add problem<\/a>/);
  assert.doesNotMatch(html, /CSS code-distance algorithm search/);
  assert.doesNotMatch(html, /href="\/problems\/Prob-000"/);
  assert.match(html, />\+ Add first problem<\/a>/);
  assert.match(html, /Cannot open Codex\?/);
  assert.match(html, /codex:\/\/threads\/new/);
  assert.match(html, /Accepted/);
  assert.match(html, /Solved/);
  assert.match(html, /Published/);
  for (const [label, key] of [
    ["Accepted", "accepted"],
    ["Solved", "solved"],
    ["Published", "published"],
  ]) {
    assert.match(
      html,
      new RegExp(`<dt>${label}</dt><dd>${generatedIndex.summary[key]}</dd>`),
    );
  }
  assert.doesNotMatch(html, fixedPublicationTargetPattern);
  assert.doesNotMatch(html, /\/\s*5\b/);
  assert.doesNotMatch(html, /[\u3400-\u9FFF]/u);
  assert.match(
    html,
    /<th scope="col">Problem<\/th><th scope="col">Status<\/th><th scope="col">Executable gate<\/th><th scope="col">Provenance<\/th><th scope="col">Recent activity<\/th><th scope="col">Updated<\/th><th scope="col">Open<\/th>/,
  );
  assert.doesNotMatch(html, /Turn open literature into/);
  assert.doesNotMatch(html, /Reset demo/);
  assert.doesNotMatch(html, /localStorage/);
});

test("ordinary local build excludes and reserves the showcase problem", () => {
  assert.deepEqual(generatedIndex.problems.map((problem) => problem.id), []);
  assert.equal(generatedIndex.nextProblemId, "Prob-001");
  assert.deepEqual(generatedIndex.diagnostics, []);
  assert.deepEqual(generatedIndex.summary, {
    total: 0,
    accepted: 0,
    solved: 0,
    published: 0,
    rejected: 0,
    archived: 0,
  });
});

test("homepage table links do not rely on absolute row overlays", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(css, /\.problem-row-link::after\s*\{/);
  assert.doesNotMatch(css, /\.problem-table-row\s*\{[^}]*position:\s*relative[^}]*\}/s);
});

test("server-renders populated desktop and narrow problem rows", async () => {
  const response = await renderFilesystemFixture({
    manifests: [acceptedFixture],
    damagedIds: ["Prob-018"],
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<tr class="problem-table-row"><th scope="row"><a class="problem-row-link" href="\/problems\/Prob-017">/);
  assert.match(html, /<td><a class="open-affordance" href="\/problems\/Prob-017">Open <span aria-hidden="true">→<\/span><\/a><\/td>/);
  assert.match(html, /<a class="problem-list-item" href="\/problems\/Prob-017" aria-label="Open Prob-017: Fresh Hamiltonian gate">/);
  assert.match(html, /Fresh Hamiltonian gate/);
  assert.match(html, /Interval arithmetic on held-out instances\./);
  assert.match(html, /interval-arithmetic/);
  assert.match(html, /12 sources/);
  assert.match(html, /Accepted after novelty review/);
  assert.match(html, /2026-07-27 11:45:00 UTC/);
  assert.match(html, /1 index errors/);
  assert.match(html, /problems\/Prob-018\/problem\.json/);
  assert.match(html, /Invalid JSON/);
});

test("server-renders a clear action when default-hidden records are the only results", async () => {
  const response = await renderFilesystemFixture({
    manifests: [{
      ...acceptedFixture,
      id: "Prob-020",
      title: "Rejected fixture",
      status: "rejected",
      gate: { type: "python", readiness: "specified" },
      rejection: { kind: "human", reason: "Novelty failed." },
    }],
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /No matching problems/);
  assert.match(html, /<button class="state-action" type="button">Clear all filters<\/button>/);
  assert.doesNotMatch(html, /<span class="problem-id">Prob-020<\/span>/);
});

test("returns a stable detail route response for unknown problem IDs", async () => {
  const response = await render("/problems/Prob-999");
  assert.equal(response.status, 404);
});

test("ordinary local build returns 404 for every showcase route", async () => {
  for (const pathname of [
    "/problems/Prob-000",
    "/problems/Prob-000/attempts/ATT-001",
    "/problems/Prob-000/attempts/ATT-005",
    "/problems/Prob-000/attempts/ATT-999",
  ]) {
    const response = await render(pathname);
    assert.equal(response.status, 404, pathname);
  }
});

test("returns 404 for attempt routes on non-example problems", async () => {
  const response = await renderFilesystemFixture(
    { manifests: [acceptedFixture] },
    "/problems/Prob-017/attempts/ATT-001?fixture=filesystem",
  );
  assert.equal(response.status, 404);
});

test("server-renders the generic problem detail shell for non-example problems", async () => {
  const response = await renderFilesystemFixture(
    { manifests: [acceptedFixture] },
    "/problems/Prob-017?fixture=filesystem",
  );
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<p class="eyebrow">Prob-017<\/p>/);
  assert.match(html, /<h1>Fresh Hamiltonian gate<\/h1>/);
  assert.match(html, /<p class="detail-summary">Interval arithmetic on held-out instances\.<\/p>/);
  assert.match(html, /The detailed problem workspace will be designed next; this page currently locks the route, identity, and return path\./);
  assert.match(html, /<h2 id="authoritative-source-heading">Authoritative source<\/h2>/);
  assert.match(html, /This console record is not the authoritative definition\./);
  assert.match(html, /<a href="https:\/\/github\.com\/example\/research-problems" target="_blank" rel="noreferrer">https:\/\/github\.com\/example\/research-problems<\/a>/);
  assert.match(html, /0123456789abcdef0123456789abcdef01234567/);
  assert.match(html, /problems\/Prob-017/);
  assert.match(html, /sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(html, /Sync source|Edit source|Run source/);
  assert.doesNotMatch(html, /[\u3400-\u9FFF]/u);
  assert.match(html, /<a href="\/" class="back-link">← Back to problems<\/a>/);
});

import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "out");
const generatedIndex = JSON.parse(
  await readFile(join(root, ".generated/problem-index.json"), "utf8"),
);

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

test("pages build indexes only the public showcase root", () => {
  assert.deepEqual(generatedIndex.problems.map((problem) => problem.id), ["Prob-000"]);
  assert.equal(generatedIndex.summary.total, 1);
  assert.equal(generatedIndex.problems[0].title, "CSS code-distance algorithm search");
});

test("pages showcase writes static route files", async () => {
  for (const routeFile of [
    "index.html",
    "knowledge/index.html",
    "knowledge/research-loop.css",
    "knowledge/search.json",
    "problems/Prob-000/index.html",
    "problems/Prob-000/attempts/ATT-001/index.html",
    "problems/Prob-000/attempts/ATT-002/index.html",
    "problems/Prob-000/attempts/ATT-003/index.html",
    "problems/Prob-000/attempts/ATT-004/index.html",
    "problems/Prob-000/attempts/ATT-005/index.html",
    ".nojekyll",
  ]) {
    assert.equal(await fileExists(join(out, routeFile)), true, `${routeFile} should exist`);
  }
});

test("pages showcase rewrites links for the repository base path", async () => {
  const html = await readFile(join(out, "problems/Prob-000/index.html"), "utf8");
  assert.match(html, /Example data - synthetic results for interface demonstration only\./);
  assert.match(html, /href="\/research-loop\/problems\/Prob-000\/attempts\/ATT-001\/"/);
  assert.match(html, /href="\/research-loop\/problems\/Prob-000\/attempts\/ATT-005\/"/);
  assert.match(html, /href="\/research-loop\/assets\//);
  assert.doesNotMatch(html, /href="\/research-loop\/problems\/Prob-000\/attempts\/ATT-\d{3}"/);
  assert.doesNotMatch(html, /href="\/problems\/Prob-000\/attempts\//);
  assert.doesNotMatch(html, /<script\b/i);
});

test("pages showcase links to the bundled knowledge site under the repository base path", async () => {
  const homepage = await readFile(join(out, "index.html"), "utf8");
  assert.match(homepage, /<a class="topbar-link" href="\/research-loop\/knowledge\/">Knowledge <span aria-hidden="true">→<\/span><\/a>/);
  assert.doesNotMatch(homepage, /href="\/knowledge\/"/);

  const knowledge = await readFile(join(out, "knowledge", "index.html"), "utf8");
  assert.match(knowledge, /Research Loop Knowledge/);
  assert.match(knowledge, /href="(?:\.\/)?research-loop\.css"/);
  assert.match(
    knowledge,
    /class="rl-home-link" href="\/research-loop\/" aria-label="Back to Research Loop home"/,
  );
  assert.doesNotMatch(
    knowledge,
    /class="rl-home-link" href="\/" aria-label="Back to Research Loop home"/,
  );
  assert.doesNotMatch(knowledge, /\b(?:href|src)="\/knowledge\//);
  assert.doesNotMatch(knowledge, /url\(\/knowledge\//);

  const theory = await readFile(join(out, "knowledge", "categories", "theory", "index.html"), "utf8");
  assert.match(theory, /href="\.\.\/\.\.\/research-loop\.css"/);
  assert.doesNotMatch(theory, /\b(?:href|src)="\/knowledge\//);

  const stylesheet = await readFile(join(out, "knowledge", "research-loop.css"), "utf8");
  assert.match(stylesheet, /--rl-green:\s*#174c3b;/);
});

test("pages showcase preserves local controls as disabled visual affordances", async () => {
  const html = await readFile(join(out, "index.html"), "utf8");

  assert.match(html, /<section class="console-toolbar" aria-label="Problem filters">/);
  assert.match(html, /Search problems/);
  assert.match(html, /Lifecycle status/);
  assert.match(html, /<span class="primary-action static-disabled" aria-disabled="true">\+ Add problem<\/span>/);
  assert.doesNotMatch(html, /<a class="primary-action" href=/);
  assert.doesNotMatch(html, /codex:\/\//i);
});

test("pages showcase copies client assets", async () => {
  const assets = await stat(join(out, "assets"));
  assert.equal(assets.isDirectory(), true);
});

test("pages showcase artifact contains no local agent launcher content", async () => {
  const files = await collectFiles(out);
  const scriptFilesOutsideKnowledgeSite = files.filter((file) => {
    const artifactPath = relative(out, file);
    return artifactPath.endsWith(".js") && !artifactPath.startsWith("knowledge/");
  });
  assert.deepEqual(scriptFilesOutsideKnowledgeSite, []);

  const textFiles = files.filter((file) => /\.(?:css|html|js|json|svg|txt)$/.test(file));
  for (const file of textFiles) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /codex:\/\//i, file);
    assert.doesNotMatch(text, /\/Users\/nzy\//, file);
    assert.doesNotMatch(text, /localhost:3000/, file);
    assert.doesNotMatch(text, /Cannot open Codex/, file);
    assert.doesNotMatch(text, /<a class="primary-action" href=/, file);
    assert.doesNotMatch(text, /\b(?:href|src|data-rsc-css-href)="\/assets\//, file);
    assert.doesNotMatch(text, /url\(\/assets\//, file);
    assert.doesNotMatch(text, /\b(?:href|src)="\/knowledge\//, file);
    assert.doesNotMatch(text, /url\(\/knowledge\//, file);
  }
});

test("pages showcase contains only the noninteractive local-mode preparation notice", async () => {
  const files = await collectFiles(out);
  const blockedText = [
    "/__local/autoresearch",
    "AUTORESEARCH_CAPABILITY_TOKEN",
    "AUTORESEARCH_PRIVATE_ROOT",
    "infrastructure.json",
    "preflight-report.json",
    "events.jsonl",
    "stderr.log",
  ];

  for (const file of files.filter((path) => /\.(?:css|html|js|json|svg|txt)$/.test(path))) {
    const text = await readFile(file, "utf8");
    for (const marker of blockedText) {
      assert.equal(text.includes(marker), false, `${relative(out, file)} exposes ${marker}`);
    }
  }

  const problem = await readFile(join(out, "problems", "Prob-000", "index.html"), "utf8");
  assert.match(problem, /Available in local mode/);
  assert.doesNotMatch(problem, /Autoresearch preparation is available only for qualifying or accepted local problems\./);
  assert.doesNotMatch(problem, /Prepare autoresearch/);
});

test("pages showcase copies only the Prob-000 problem source", () => {
  assert.deepEqual(generatedIndex.problems.map((problem) => problem.id), ["Prob-000"]);
});

test("pages showcase excludes imported AutoQEC problem data", async () => {
  const files = await collectFiles(out);
  const artifactPaths = files.map((file) => relative(out, file));

  assert.equal(artifactPaths.some((path) => path.includes("Prob-001")), false);

  for (const file of files.filter((file) => /\.(?:html|json|txt|css|js)$/.test(file))) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /AutoQEC CSS-distance autoresearch record/);
    assert.doesNotMatch(text, /candidate\.py/);
    assert.doesNotMatch(text, /b6a0e03c05a653b4e85160a703c0be4eef06b619/);
    assert.doesNotMatch(text, /\/Users\/nzy\/AutoQEC/);
  }
});

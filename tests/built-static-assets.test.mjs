/**
 * What the build actually packages, and what the built app actually serves.
 *
 * `npm run build` renders the knowledge site into `public/knowledge` and then
 * lets the app build copy `public/` into the Worker's asset directory. Three
 * things about that hand-off have to hold, and none of them is visible from the
 * source tree:
 *
 * - the deployment metadata still names this project and still asks for no
 *   database and no bucket. The knowledge system is a static site plus a
 *   Worker; a `d1` or `r2` appearing in `hosting.json` would mean something
 *   started provisioning storage nobody asked for;
 * - the packaged assets are the published knowledge site and nothing else. The
 *   site builder audits its own output before publishing it, but that audit
 *   cannot see what a later copy step adds, so the same forbidden names are
 *   checked again here — on the real `dist/` tree, after the copy;
 * - the nested directory routes resolve. Quarto publishes every page as
 *   `<directory>/index.html` and links its stylesheets relatively, so
 *   `/knowledge/categories/theory/` has to serve that file *at that URL*. The
 *   last test proves it over real HTTP against the built app, because the layer
 *   that decides this is the asset binding and a hand-written `ASSETS.fetch`
 *   stub would only prove what the stub was written to believe.
 *
 * Requires a completed `npm run build`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const distDir = path.join(repoRoot, "dist");
const clientDir = path.join(distDir, "client");
const publishedSite = path.join(repoRoot, "public", "knowledge");

/** The exact project this build deploys to. */
const PROJECT_ID = "appgprj_6a66e89526a88191a9e969c6f441086c";

/** The three generated category views the knowledge site always publishes. */
const CATEGORIES = ["codes", "experiment", "theory"];

/**
 * Path segments no built file may carry.
 *
 * These mirror the site builder's own refusal list: untrusted drafts, the
 * external literature tree, the local-only downloads and extracted figures
 * under it, the bibliography, and the imported-card rendering that draft
 * previews write. A `.qmd` anywhere would mean a source page was copied instead
 * of rendered.
 */
const FORBIDDEN_SEGMENTS = [
  "drafts",
  "literature",
  ".raw",
  ".figures",
  "rendered.md",
  "ref.bib",
  "infrastructure.json",
  "preflight-report.json",
  "events.jsonl",
  "stderr.log",
];

/** Every file under `root`, as POSIX paths relative to it. */
async function filesUnder(root) {
  const files = [];
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await walk(root, "");
  return files.sort();
}

test("the build exists before its package is inspected", async () => {
  assert.ok(
    existsSync(distDir),
    "dist/ is missing; run `npm run build` before the rendered tests",
  );
  assert.ok((await stat(path.join(distDir, "server", "index.js"))).isFile());
  assert.ok((await stat(clientDir)).isDirectory());
});

test("hosting metadata names this project and provisions no storage", async () => {
  const file = path.join(distDir, ".openai", "hosting.json");
  assert.ok(existsSync(file), `${file} is missing`);

  const hosting = JSON.parse(await readFile(file, "utf8"));
  assert.equal(hosting.project_id, PROJECT_ID);
  assert.equal(hosting.d1, null);
  assert.equal(hosting.r2, null);
});

test("the packaged assets contain the published knowledge site", async () => {
  assert.ok(existsSync(path.join(clientDir, "knowledge", "index.html")));
  for (const category of CATEGORIES) {
    assert.ok(
      existsSync(path.join(clientDir, "knowledge", "categories", category, "index.html")),
      `knowledge/categories/${category}/index.html is packaged`,
    );
  }

  // The search index and the site libraries are what make the search UI and the
  // stylesheets work once deployed; they are nested assets, so they are the
  // ones a broken copy step loses first.
  assert.ok(existsSync(path.join(clientDir, "knowledge", "search.json")));
  const theme = path.join(clientDir, "knowledge", "research-loop.css");
  assert.ok(existsSync(theme), "the Research Loop stylesheet is packaged");
  assert.match(await readFile(theme, "utf8"), /--rl-green:\s*#174c3b;/);
  const siteLibs = await filesUnder(path.join(clientDir, "knowledge", "site_libs"));
  assert.ok(siteLibs.some((file) => file.endsWith(".css")), "a stylesheet is packaged");
  assert.ok(siteLibs.some((file) => file.endsWith(".js")), "a script is packaged");

  // The packaged copy is the published site, whole and unmodified.
  assert.deepEqual(
    await filesUnder(path.join(clientDir, "knowledge")),
    await filesUnder(publishedSite),
  );
});

test("the asset binding is pointed at the packaged client tree", async () => {
  const wrangler = JSON.parse(
    await readFile(path.join(distDir, "server", "wrangler.json"), "utf8"),
  );
  assert.equal(wrangler.assets?.directory, "../client");

  const ignored = (await readFile(path.join(clientDir, ".assetsignore"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.deepEqual(ignored, ["wrangler.json", ".dev.vars"]);
});

test("the package carries no source page and nothing from the untrusted trees", async () => {
  const built = [
    ...(await filesUnder(distDir)).map((file) => `dist/${file}`),
    ...(await filesUnder(publishedSite)).map((file) => `public/knowledge/${file}`),
  ];
  assert.ok(built.length > 0);

  const offenders = built.filter((file) =>
    file
      .split("/")
      .some(
        (segment) => segment.endsWith(".qmd") || FORBIDDEN_SEGMENTS.includes(segment),
      ),
  );
  assert.deepEqual(offenders, [], `the build packaged files it may not publish:\n${offenders.join("\n")}`);

  // The same names as substrings, so a flattened or renamed copy is caught too.
  for (const needle of ["literature/.raw", "literature/.figures", "rendered.md", ".qmd"]) {
    assert.deepEqual(
      built.filter((file) => file.includes(needle)),
      [],
      `no built path may contain "${needle}"`,
    );
  }
});

/**
 * A port of its own: the browser tests own 4173, and `npm test` may run the
 * suites back to back.
 */
const PORT = 4174;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Starts the built app, runs `probe`, and takes the server down again. */
async function withBuiltApp(probe) {
  const server = spawn(
    path.join(repoRoot, "node_modules", ".bin", "vinext"),
    ["start", "--host", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the whole tree goes down with it: `vinext
      // start` runs workerd as a child, and killing only the parent would leave
      // the port bound for the next run.
      detached: true,
      env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
    },
  );
  let log = "";
  let closed = false;
  const closedPromise = new Promise((resolve) => {
    server.once("close", () => {
      closed = true;
      resolve();
    });
  });
  server.stdout.on("data", (chunk) => (log += chunk));
  server.stderr.on("data", (chunk) => (log += chunk));

  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (server.exitCode !== null) {
        throw new Error(`the built app exited with code ${server.exitCode}:\n${log}`);
      }
      try {
        await fetch(`${ORIGIN}/`, { redirect: "manual" });
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`the built app did not accept connections:\n${log}`);
        }
        await delay(250);
      }
    }
    return await probe();
  } finally {
    if (!closed) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
    await closedPromise;
  }
}

/**
 * One request, following redirects by hand.
 *
 * `redirect: "follow"` would hide exactly what this test is about — whether a
 * directory URL reaches its page, and whether it does so without bouncing
 * between a trailing-slash and a no-trailing-slash form forever.
 */
async function get(pathname, method = "GET") {
  const hops = [];
  let target = pathname;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(`${ORIGIN}${target}`, { method, redirect: "manual" });
    const location = response.headers.get("location");
    if (location === null || response.status < 300 || response.status >= 400) {
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: await response.text(),
        hops,
        finalPath: target,
      };
    }
    hops.push({ from: target, status: response.status, to: location });
    target = new URL(location, `${ORIGIN}${target}`).pathname;
  }
  throw new Error(`redirect loop from ${pathname}: ${JSON.stringify(hops)}`);
}

test("the built app serves the dashboard and every nested knowledge route", async () => {
  await withBuiltApp(async () => {
    const dashboard = await get("/");
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.contentType, /^text\/html\b/i);
    assert.match(dashboard.body, /Research Loop/);

    const index = await get("/knowledge/");
    assert.equal(index.status, 200, `/knowledge/ returned ${index.status}`);
    assert.match(index.contentType, /^text\/html\b/i);
    assert.match(index.body, /Research Loop Knowledge/);
    assert.match(index.body, /class="rl-home-link" href="\/" aria-label="Back to Research Loop home"/);

    for (const category of CATEGORIES) {
      const view = await get(`/knowledge/categories/${category}/`);
      assert.equal(
        view.status,
        200,
        `/knowledge/categories/${category}/ returned ${view.status}`,
      );
      assert.match(view.contentType, /^text\/html\b/i);
      assert.match(view.body, new RegExp(category, "i"));
    }
    assert.match((await get("/knowledge/categories/theory/")).body, /Theory/);

    // Nested non-HTML assets are served by path, and the search index is what
    // the site's search box reads.
    const search = await get("/knowledge/search.json");
    assert.equal(search.status, 200);
    assert.match(search.contentType, /^application\/json\b/i);

    const stylesheet = await get("/knowledge/site_libs/quarto-html/tippy.css");
    assert.equal(stylesheet.status, 200);

    // The bare prefix is canonicalized rather than 404ing, and lands on the
    // trailing-slash form the relative links in the rendered pages need.
    const bare = await get("/knowledge");
    assert.equal(bare.status, 200);
    assert.equal(bare.finalPath, "/knowledge/");
    assert.match(bare.body, /Research Loop Knowledge/);

    // A HEAD is answered like the GET it previews.
    const head = await get("/knowledge/", "HEAD");
    assert.equal(head.status, 200);
    assert.match(head.contentType, /^text\/html\b/i);

    // The knowledge site is static; nothing under it accepts a write.
    const posted = await fetch(`${ORIGIN}/knowledge/`, { method: "POST", redirect: "manual" });
    assert.equal(posted.status, 405);
    assert.match(posted.headers.get("allow") ?? "", /GET/);
    assert.match(posted.headers.get("allow") ?? "", /HEAD/);

    // A directory with no page in it stays a 404 rather than becoming a loop.
    const empty = await get("/knowledge/site_libs/");
    assert.equal(empty.status, 404);
    assert.doesNotMatch(empty.body, /<html/i);

    // Nothing outside the published site is reachable through the fallback.
    for (const missing of [
      "/knowledge/../literature/ref.bib",
      "/literature/",
      "/drafts/",
      "/knowledge/index.qmd",
    ]) {
      const response = await get(missing);
      assert.equal(response.status, 404, `${missing} returned ${response.status}`);
      assert.doesNotMatch(response.body, /@article|BEGIN|fixture2026/i);
    }
  });
});

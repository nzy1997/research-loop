# Research Loop

A shared human-and-agent research workspace. A local Problem Console runs at
`/`, a Quarto site of reviewed research knowledge is published at `/knowledge/`,
and both are packaged into one deployable artifact by the existing vinext build.

- `/` — the Problem Console. It reads `problems/<id>/` through the generated
  index at `.generated/problem-index.json` and presents problems, attempts, and
  the Codex hand-off for authoring a new problem.
- `/knowledge/` — a static Quarto website rendered from `knowledge/**/*.qmd`
  into the gitignored `public/knowledge/`, with code execution disabled.

## Prerequisites

- Node.js `22.23.1` (pinned in `.node-version`; the package `engines` floor is
  `>=22.13.0`)
- Quarto `1.9.38` on `PATH`, for rendering and previewing the knowledge site

```bash
make dev
```

The command installs the locked dependencies when needed, then starts the local
site. This starter does not use `wrangler.jsonc`.

## Local Problem Console

Problems live in `problems/<id>/` and are indexed into
`.generated/problem-index.json` before dev, lint, build, and test commands. The
generated index is ignored by Git; `problem.json`, `problem.md`, and
`generation/` records are the durable audit trail.

Only `problems/` is indexed by local development and ordinary production
builds. The synthetic public example lives separately under
`examples/showcase/problems/` as `Prob-000` and is not available from local
routes; ordinary local problem allocation starts at `Prob-001`.

Run locally:

```bash
npm run dev
```

`npm run dev` builds the index once, watches `problems/` for changes to
`problem.json` and `problem.md`, and rebuilds the index as it serves.

### External authoritative bindings

An optional `sourceBinding` in `problem.json` can point a local console record
to an immutable problem definition maintained elsewhere. It records authority;
it does not import, synchronize, or execute the external source.

```json
{
  "sourceBinding": {
    "kind": "git-path",
    "repository": "https://github.com/owner/repository",
    "revision": "0123456789abcdef0123456789abcdef01234567",
    "path": "problems/Prob-017",
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

The binding requires an HTTPS repository URL, a lowercase 40- or 64-character
commit ID, a normalized repository-relative POSIX path, and a lowercase SHA-256
digest. The detail route displays these fields read-only and explicitly marks
the local record as non-authoritative.

When another trusted process retrieves the external descriptor, compare it
without mutating the local manifest:

```js
import { verifySourceBinding } from "./lib/problems/source-binding.mjs";

const result = verifySourceBinding(declaredBinding, observedDescriptor);
// result.ok is false and names repository/revision/path/digest fields on drift.
```

To create a problem, click `+ Add problem` on the homepage. Codex opens a new
task with the issue #133 context prefilled; send it, answer one question at a
time, and only allow file writes after reviewing the proposed manifest,
Markdown, generation record, and rubric decision.

`npm run pages:build` snapshots the static `Prob-000` example — the homepage,
the problem page, its five attempt pages, and the bundled knowledge site — into
`out/` for GitHub Pages at `https://nzy1997.github.io/research-loop/`. The
dashboard links to the knowledge copy at `/research-loop/knowledge/` inside
that artifact. The console snapshot is script-free static HTML; it is a
showcase of the example, not a deployment of the local console.

## The trust boundary

Three trees, three different levels of trust. The separation is physical, so
nothing can quietly promote itself.

| Tree | Status | What it means |
|---|---|---|
| `knowledge/` | trusted | The only content authority. A page is here because a human reviewed it and merged it. It is the only thing published at `/knowledge/`. |
| `drafts/` | untrusted | Imported cards, pasted notes, agent output. No required categories, hierarchy, catalog, or frontmatter. Never published; never an answer source. |
| `literature/` | external | Papers and their pinned arXiv sources — evidence to check a claim against, not a conclusion this project has drawn. Never published. |

Agents answer research questions by resolving against `knowledge/` and reading
the whole returned bundle; a question the trusted tree does not cover gets an
explicit "no match" rather than a quiet fallback to the other two trees. See
`AGENTS.md` for the rules and `docs/skills.md` for the skills that implement
them.

`problems/` is a fourth tree with its own role: it is the record of what is
being worked on, not a source of reviewed answers. The resolver never reads it.

## Knowledge pages

Every page is a `.qmd` file with a small, strictly allowlisted frontmatter:
`title`, `description`, `categories`, and `aliases`. Nothing else is accepted —
the allowlist is what keeps a page from turning a render into code execution.

- **Three categories.** A content page declares exactly one of `theory`,
  `experiment`, or `codes`. A topic's `index.qmd` declares none.
- **The reading map is curated, not derived.** Each `index.qmd` carries a
  `## Reading map` section listing the pages that belong to that topic, in the
  order a reader should meet them. That list defines ownership, the site's
  sidebar order, and the resolver's ordering. A page no reading map lists is an
  orphan, and validation fails.
- **`## Related topics` is a cross-reference.** It may point anywhere in the
  tree and changes no ownership.

`make knowledge-check` enforces all of it: allowlists, categories, orphans,
duplicate parents, broken links, cycles, path escapes, and citation keys that
are not in `literature/ref.bib`.

## Commands

```bash
make help
```

| Command | What it does |
|---|---|
| `make dev` | Install locked dependencies when needed, then serve the Problem Console locally with the problem index watched |
| `make build` | Regenerate the problem index, validate and render `knowledge/` into `public/knowledge/`, then build the deployable app |
| `make test` | Lint, both unit suites, the Pages showcase, rendered-output tests, and browser tests |
| `make pages-build` | Snapshot the static `Prob-000` example and bundled knowledge site into `out/` for GitHub Pages |
| `make knowledge-check` | Validate the trusted knowledge tree |
| `make knowledge-resolve QUERY="triangular TFIM"` | Print the reading bundle for one research question, as JSON |
| `make knowledge-preview` | Serve the trusted knowledge site locally |
| `make draft-preview FILE=drafts/note.md` | Render exactly one untrusted draft note locally |
| `make literature-index` | Regenerate every `literature/<method>/INDEX.md` from `ref.bib` |
| `make literature-fetch KEY=citekey` | Fetch one reference's version-pinned arXiv source |
| `make literature-sync` | Fetch the pinned source of every arXiv reference |
| `make migration-verify` | Re-check the imported harness cards against their manifest |

Equivalent package scripts exist underneath (`npm run knowledge:check`, and so
on), but documentation and skills use the Make targets, so there is one stable
name for each workflow.

`make knowledge-resolve` prints one JSON document and exits 0 for `match`,
`ambiguous`, and `no-match` alike — a status is an answer, not a failure. The
argument-taking targets refuse an empty variable with a one-line usage message
and exit 2.

The package scripts that have no Make target:

- `npm run lint`: regenerate the problem index, then run ESLint
- `npm run test:unit`: the TypeScript knowledge, literature, drafts, migration,
  and agent suites
- `npm run test:unit:problems`: the problem-console `.mjs` suites — schema,
  indexer, repository, presentation, view state, dev watcher, Codex launch, and
  the static example content
- `npm run test:pages`: `pages:build` followed by the Pages showcase assertions
- `npm run test:rendered`: assertions against the built HTML and static assets
- `npm run test:e2e`: Playwright, against the built site
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Included shape

- site code lives under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Deployment

`.openai/hosting.json` pins the existing Sites project
`appgprj_6a66e89526a88191a9e969c6f441086c`. That exact project is reused: it is
never reformatted, replaced, or re-created. Deployment may remain blocked while
that project is not visible to the current account; local completion — build,
tests, and rendered output — is valid on its own, and the artifact is ready for
whenever access returns.

The GitHub Pages showcase is a separate, static destination: `.github/workflows/pages.yml`
publishes the `out/` snapshot produced by `npm run pages:build`.

## Not in this phase

- No autonomous solver backend, queue, or agent that runs unattended.
- No D1 or R2 data model. The bindings in `.openai/hosting.json` stay `null`,
  `db/schema.ts` is intentionally empty, and `examples/d1/` plus
  `drizzle.config.ts` remain an unused optional surface.
- No published draft or literature source: `drafts/`, `literature/`, and the
  local `.raw/` and `.figures/` trees never reach the deployed artifact.
- No embeddings, no `.knowledge` compatibility tree, and no generated Markdown
  mirror of the knowledge pages.

## Hosting platform notes

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Learn More

- [Quarto Documentation](https://quarto.org/docs/guide/)
- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)

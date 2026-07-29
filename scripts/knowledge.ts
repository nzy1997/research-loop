#!/usr/bin/env -S node --import tsx
/**
 * CLI for the trusted knowledge tree.
 *
 *   knowledge.ts check
 *   knowledge.ts resolve --query <text> [--select-page <knowledge/...qmd>]
 *   knowledge.ts build
 *   knowledge.ts preview
 *
 * `check` validates `knowledge/` against `literature/ref.bib` and exits 1 with
 * every diagnostic when anything is wrong. `resolve` prints one JSON document —
 * the reading bundle an agent must read, or the alternatives it must choose
 * between — and exits 0 for `match`, `ambiguous`, and `no-match` alike: those
 * are answers, not failures. `build` renders the validated tree and replaces
 * `public/knowledge`; `preview` serves the same projection without publishing
 * anything. Only an invocation the CLI cannot honour, an invalid tree, and a
 * failed render exit 1.
 *
 * There are deliberately no path or output overrides. The trusted tree of this
 * repository is the only thing this command may read, and `public/knowledge` is
 * the only thing it may replace, so neither an agent nor a script can be talked
 * into rendering a directory someone else prepared or into writing the result
 * somewhere it would be served from unchecked.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  KnowledgeValidationError,
  buildKnowledgeSite,
  previewKnowledgeSite,
  resolveKnowledge,
  validateKnowledge,
} from "../lib/knowledge/index.js";

const USAGE = [
  "usage:",
  "  knowledge.ts check",
  "  knowledge.ts resolve --query <text> [--select-page <knowledge/...qmd>]",
  "  knowledge.ts build",
  "  knowledge.ts preview",
].join("\n");

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

class UsageError extends Error {}

/** The options of a `resolve` invocation, or a usage error explaining why not. */
function resolveOptionsOf(args: readonly string[]): { query: string; selectedPage?: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        query: { type: "string" },
        "select-page": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.query === undefined) {
    throw new UsageError("resolve requires --query <text>");
  }
  return { query: values.query, selectedPage: values["select-page"] };
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case "check": {
      if (rest.length > 0) {
        throw new UsageError("check takes no arguments");
      }
      const report = await validateKnowledge({ repoRoot: REPO_ROOT });
      if (!report.ok) {
        // The error's message is the whole report, so `check` and `resolve`
        // describe an invalid tree in exactly the same words.
        throw new KnowledgeValidationError(report);
      }
      console.log("knowledge: the trusted tree is valid");
      return;
    }
    case "resolve": {
      const { query, selectedPage } = resolveOptionsOf(rest);
      const result = await resolveKnowledge(query, { repoRoot: REPO_ROOT, selectedPage });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "build": {
      if (rest.length > 0) {
        throw new UsageError("build takes no arguments");
      }
      const { outputDir, renderedFiles } = await buildKnowledgeSite({ repoRoot: REPO_ROOT });
      console.log(
        `knowledge: published ${renderedFiles} file${renderedFiles === 1 ? "" : "s"} to ${path.relative(REPO_ROOT, outputDir)}`,
      );
      return;
    }
    case "preview": {
      if (rest.length > 0) {
        throw new UsageError("preview takes no arguments");
      }
      // Returns when Quarto exits; the workspace it served is removed then.
      await previewKnowledgeSite({ repoRoot: REPO_ROOT });
      return;
    }
    case undefined:
      throw new UsageError("a subcommand is required");
    default:
      throw new UsageError(`unknown subcommand "${command}"`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    error instanceof UsageError ? `knowledge: ${message}\n${USAGE}` : `knowledge: ${message}`,
  );
  process.exitCode = 1;
}

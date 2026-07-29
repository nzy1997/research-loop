import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export function buildAutoresearchProxy({ origin, token }: { origin?: string; token?: string }) {
  if (!origin || !token) return undefined;
  return {
    "/__local/autoresearch": {
      target: origin,
      changeOrigin: true,
      headers: { "x-research-loop-capability": token },
    },
  };
}

export function buildLocalServiceProxy({
  assessmentTarget,
  assessmentToken,
  autoresearchOrigin,
  autoresearchToken,
}: {
  assessmentTarget?: string;
  assessmentToken?: string;
  autoresearchOrigin?: string;
  autoresearchToken?: string;
}) {
  const autoresearch = buildAutoresearchProxy({ origin: autoresearchOrigin, token: autoresearchToken }) ?? {};
  const proxy = {
    ...(assessmentTarget && assessmentToken
      ? {
          "/__local/assessments": {
            target: assessmentTarget,
            changeOrigin: false,
            headers: { "x-local-assessment-token": assessmentToken },
          },
        }
      : {}),
    ...autoresearch,
  };
  return Object.keys(proxy).length > 0 ? proxy : undefined;
}

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const localAssessmentTarget = process.env.LOCAL_ASSESSMENT_SERVICE_URL;
  const localAssessmentToken = process.env.LOCAL_ASSESSMENT_PROXY_TOKEN;
  const proxy = buildLocalServiceProxy({
    assessmentTarget: localAssessmentTarget,
    assessmentToken: localAssessmentToken,
    autoresearchOrigin: process.env.AUTORESEARCH_SERVICE_ORIGIN,
    autoresearchToken: process.env.AUTORESEARCH_CAPABILITY_TOKEN,
  });
  const server = {
    ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    ...(proxy ? { proxy } : {}),
  };

  return {
    server: Object.keys(server).length ? server : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { ModelRegistry } from "./models.js";
import {
  runAgy,
  defaultDeps,
  execWithClosedStdin,
  type RunnerDeps,
  type RunResult,
} from "./runner.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import {
  RunTracker,
  formatTokensShort,
  readSessionTokens,
  summarizeLabel,
  type DashboardSnapshot,
  type RunRecord,
} from "./telemetry.js";
import { TOOLS, type ToolDef } from "./tools.js";

export const PANEL_URI = "ui://gemini/panel.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

const GEMINI_SPARKLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none">' +
  "<defs>" +
  '<linearGradient id="g" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0%" stop-color="#4285F4"/>' +
  '<stop offset="45%" stop-color="#9B72CB"/>' +
  '<stop offset="80%" stop-color="#D96570"/>' +
  '<stop offset="100%" stop-color="#F4B400"/>' +
  "</linearGradient>" +
  "</defs>" +
  '<path d="M14 1.5C14.6 8.4 19.6 13.4 26.5 14C19.6 14.6 14.6 19.6 14 26.5C13.4 19.6 8.4 14.6 1.5 14C8.4 13.4 13.4 8.4 14 1.5Z" fill="url(#g)"/>' +
  "</svg>";

export const GEMINI_ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(GEMINI_SPARKLE_SVG).toString("base64")}`;

const PANEL_META = {
  ui: { resourceUri: PANEL_URI },
  "ui/resourceUri": PANEL_URI,
};

const PANEL_SIDE_META = {
  ui: { resourceUri: PANEL_URI },
  "ui/resourceUri": PANEL_URI,
  "com.google.antigravity/ui": {
    entrypoints: [{ type: "aux_pane", title: "Gemini" }],
  },
};

const APP_ONLY_META = {
  ui: { visibility: ["app"] },
};

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface HandlerExtra {
  signal?: AbortSignal;
}

async function loadPanelHtml(): Promise<string> {
  const overridePath = process.env.AGY_BRIDGE_PANEL_HTML;
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = overridePath || path.join(distDir, "panel.html");
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return "<!doctype html><html><body><p>Panel bundle missing. Run npm run build.</p></body></html>";
  }
}

function formatFooter(
  run: RunRecord | undefined,
  snapshot: DashboardSnapshot,
  note?: string,
): string {
  const meta: string[] = [`model: ${run?.model ?? "agy default"}`];
  if (run) meta.push(`time: ${(run.elapsedMs / 1000).toFixed(1)}s`);
  if (run?.tokens) {
    meta.push(
      `ctx: ${formatTokensShort(run.tokens.contextTokens)} (cache ${Math.round(run.tokens.cacheHitPct)}%)`,
    );
    meta.push(`out: ${formatTokensShort(run.tokens.totalOutputTokens)}`);
  }
  const q5 = snapshot.quota.buckets.find((b) => b.window === "5h");
  const qw = snapshot.quota.buckets.find((b) => b.window === "weekly");
  if (q5 || qw) {
    const qParts: string[] = [];
    if (q5) qParts.push(`5h ${q5.remainingPct.toFixed(0)}%`);
    if (qw) qParts.push(`wk ${qw.remainingPct.toFixed(0)}%`);
    meta.push(`agy: ${qParts.join("/")}`);
  }
  if (note) meta.push(`note: ${note}`);
  if (run?.failover?.length) meta.push(`failover: ${run.failover.join("; ")}`);
  if (run?.sessionId) meta.push(`session: ${run.sessionId} (use follow_up to continue)`);
  return `[gemini] ${meta.join(" | ")}`;
}

function formatError(msg: string, cfg: Config): ToolResponse {
  let text = msg;
  if (cfg.onFailure === "strict") {
    text +=
      "\n\n[gemini strict mode] Delegation failed. Do NOT perform this work yourself " +
      "in the main context — report the failure to the user and let them decide how to proceed.";
  }
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
  cooldowns: CooldownRegistry = new CooldownRegistry(),
  tracker: RunTracker = new RunTracker(undefined, undefined, false),
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    let runId: string | undefined;
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      const conversationId = args.session_id as string | undefined;
      const background = args.background === true;
      const prompt = tool.buildPrompt(args, cwd);

      const explicitTimeout =
        typeof args.timeout_sec === "number" &&
        Number.isInteger(args.timeout_sec) &&
        args.timeout_sec >= 0
          ? args.timeout_sec
          : undefined;
      const timeoutSec =
        explicitTimeout !== undefined
          ? explicitTimeout
          : background
            ? 0
            : (cfg.perToolTimeouts[tool.name] ??
              (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec));

      const resolution = conversationId
        ? { models: [undefined], note: undefined }
        : await registry.resolveChain({
            explicit: args.model as string | undefined,
            chain: tool.chain,
            defaultModel: cfg.defaultModel,
          });

      const initialModel = resolution.models[0] ?? (conversationId ? "follow_up" : "agy default");
      const rec = await tracker.startRun({
        tool: tool.name,
        model: initialModel,
        cwd,
        label: summarizeLabel(tool.name, args),
        sessionId: conversationId,
      });
      runId = rec.id;

      const execute = async (
        signal?: AbortSignal,
      ): Promise<{ output: string; run?: RunRecord }> => {
        const attempts: string[] = [];
        let result: RunResult | undefined;
        let used: string | undefined;

        for (const model of resolution.models) {
          if (model && cooldowns.cooling(model)) {
            attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
            continue;
          }
          if (model) tracker.updateRunModel(rec.id, model);
          try {
            result = await runAgy(
              { prompt, cwd, model, conversationId, timeoutSec, signal },
              cfg,
              deps,
            );
            used = model;
            break;
          } catch (err) {
            if (err instanceof QuotaError && model) {
              cooldowns.set(model, err.resetSeconds);
              attempts.push(
                `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
              );
              continue;
            }
            throw err;
          }
        }

        if (!result) {
          throw new Error(
            `All candidate models are quota-exhausted or cooling down:\n` +
              `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
              `Retry after the quota resets, or pass an explicit \`model\`.`,
          );
        }

        const finalSessionId = result.sessionId ?? conversationId;
        const tokens = finalSessionId ? await readSessionTokens(finalSessionId) : undefined;
        const finished = await tracker.finishRun(rec.id, {
          status: "done",
          model: used ?? tokens?.model ?? "agy default",
          sessionId: finalSessionId,
          output: result.output,
          truncated: result.truncated,
          failover: attempts,
          tokens,
        });
        return { output: result.output, run: finished };
      };

      if (background) {
        const bgController = new AbortController();
        tracker.registerController(rec.id, bgController);
        void execute(bgController.signal).catch(async (err) => {
          const msg = (err as Error).message;
          const cancelled = /cancelled/i.test(msg);
          await tracker.finishRun(rec.id, {
            status: cancelled ? "cancelled" : "error",
            error: msg,
          });
        });

        const snapshot = await tracker.getSnapshot(cooldowns);
        const limitLabel = timeoutSec === 0 ? "no time limit" : `timeout ${timeoutSec}s`;
        return {
          content: [
            {
              type: "text",
              text:
                `Started Gemini background task.\n` +
                `- run_id: ${rec.id}\n` +
                `- model: ${initialModel} (${limitLabel})\n` +
                `- tool: ${tool.name}\n` +
                `Call \`gemini_wait({ run_id: "${rec.id}" })\` to collect the completed report without hitting MCP tool timeouts.`,
            },
          ],
          structuredContent: {
            activeRunId: rec.id,
            ...snapshot,
          },
        };
      }

      const { output, run: finished } = await execute(extra?.signal);
      const snapshot = await tracker.getSnapshot(cooldowns);

      return {
        content: [
          {
            type: "text",
            text: `${output}\n\n---\n${formatFooter(finished, snapshot, resolution.note)}`,
          },
        ],
        structuredContent: {
          activeRunId: rec.id,
          ...snapshot,
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      const cancelled = /cancelled/i.test(msg);
      if (runId) {
        await tracker.finishRun(runId, {
          status: cancelled ? "cancelled" : "error",
          error: msg,
        });
      }
      return formatError(msg, cfg);
    }
  };
}

export function createWaitHandler(
  cfg: Config,
  cooldowns: CooldownRegistry,
  tracker: RunTracker,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    const runId = String(args.run_id ?? "");
    const rawWait = args.wait_sec;
    const waitSec =
      typeof rawWait === "number" && Number.isInteger(rawWait) && rawWait >= 0
        ? Math.min(rawWait, 600)
        : 120;

    const run = await tracker.waitForRun(runId, waitSec * 1000, extra?.signal);
    const snapshot = await tracker.getSnapshot(cooldowns);

    if (!run) {
      return {
        content: [{ type: "text", text: `No Gemini run found for run_id "${runId}".` }],
        structuredContent: { ...snapshot },
        isError: true,
      };
    }

    if (run.status === "running") {
      const elapsedSec = (Math.max(0, Date.now() - run.startedAt) / 1000).toFixed(1);
      return {
        content: [
          {
            type: "text",
            text:
              `Gemini task ${run.id} (${run.model}, ${run.tool}) is still running (${elapsedSec}s elapsed).\n` +
              `Call \`gemini_wait({ run_id: "${run.id}" })\` again to keep waiting, or check \`gemini_status\`.`,
          },
        ],
        structuredContent: {
          activeRunId: run.id,
          ...snapshot,
        },
      };
    }

    if (run.status === "done") {
      const { output } = tracker.getFullOutput(run.id);
      return {
        content: [
          {
            type: "text",
            text: `${output ?? ""}\n\n---\n${formatFooter(run, snapshot)}`,
          },
        ],
        structuredContent: {
          activeRunId: run.id,
          ...snapshot,
        },
      };
    }

    return formatError(run.error ?? `Gemini run ${run.id} ended with status ${run.status}.`, cfg);
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();
  const tracker = new RunTracker();

  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  const serverInfo = {
    name: "gemini",
    title: "Gemini",
    version,
    icons: [{ src: GEMINI_ICON_DATA_URI, mimeType: "image/svg+xml", sizes: ["any"] }],
  } as ConstructorParameters<typeof McpServer>[0];
  const server = new McpServer(serverInfo);

  server.registerResource(
    "gemini_panel",
    PANEL_URI,
    {
      title: "Gemini",
      description:
        "Compact live monitor for Gemini subagent runs, context usage, and Antigravity quota.",
      mimeType: MCP_APP_MIME,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: MCP_APP_MIME,
          text: await loadPanelHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        _meta: PANEL_META,
      },
      createToolHandler(tool, cfg, registry, defaultDeps, cooldowns, tracker),
    );
  }

  server.registerTool(
    "gemini_wait",
    {
      title: "Wait for Gemini Background Run",
      description:
        "Wait for a background Gemini task (started with background=true) to finish and return its full report. " +
        "Waits up to wait_sec (default 120s) without hitting MCP timeouts; if still running, call again.",
      inputSchema: {
        run_id: z.string().describe("The run_id returned when starting the background task."),
        wait_sec: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe(
            "Max seconds to wait before returning current status (default 120, 0 = instant check).",
          ),
      },
      _meta: PANEL_META,
    },
    createWaitHandler(cfg, cooldowns, tracker),
  );

  server.registerTool(
    "gemini_status",
    {
      title: "Gemini Subagents & Quota Panel",
      description:
        "Open or refresh the compact Gemini Subagents & Antigravity quota monitor panel " +
        "(shows active/recent Gemini runs, runtime, context tokens, cache hit rate, and Antigravity 5h/weekly quota).",
      inputSchema: {},
      _meta: PANEL_SIDE_META,
    },
    async () => {
      const snapshot = await tracker.getSnapshot(cooldowns);
      const qLines = snapshot.quota.buckets.map(
        (b) =>
          `- Antigravity ${b.window}: ${b.remainingPct.toFixed(1)}% remaining` +
          (b.resetText ? ` (resets in ${b.resetText})` : ""),
      );
      const rLines = snapshot.runs.slice(0, 6).map((r) => {
        const tok = r.tokens ? ` | ctx ${formatTokensShort(r.tokens.contextTokens)}` : "";
        return `- [${r.status}] (${r.id}) ${r.model} (${r.tool}) ${(r.elapsedMs / 1000).toFixed(1)}s${tok}: ${r.label}`;
      });
      const summary = [
        `Gemini Subagents: ${snapshot.activeCount} running / ${snapshot.runs.length} recent`,
        ...(qLines.length ? qLines : ["- Antigravity quota: unavailable locally"]),
        ...(rLines.length ? ["Recent runs:", ...rLines] : []),
      ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { ...snapshot },
      };
    },
  );

  server.registerTool(
    "_agy_panel_state",
    {
      description: "Internal app-only state polling endpoint for the Gemini UI panel.",
      inputSchema: {},
      _meta: APP_ONLY_META,
    },
    async () => {
      const snapshot = await tracker.getSnapshot(cooldowns);
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { ...snapshot },
      };
    },
  );

  server.registerTool(
    "_agy_get_run_output",
    {
      description: "Internal app-only endpoint returning full output for a selected Gemini run.",
      inputSchema: { run_id: z.string() },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      const id = String(args.run_id ?? "");
      const { output } = tracker.getFullOutput(id);
      return {
        content: [{ type: "text", text: output ?? "" }],
        structuredContent: { run_id: id, output: output ?? "" },
      };
    },
  );

  server.registerTool(
    "_agy_cancel_run",
    {
      description: "Internal app-only endpoint to cancel a running background Gemini task.",
      inputSchema: { run_id: z.string() },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      const id = String(args.run_id ?? "");
      const cancelled = tracker.cancelRun(id);
      const snapshot = await tracker.getSnapshot(cooldowns);
      return {
        content: [{ type: "text", text: cancelled ? "cancelled" : "not running" }],
        structuredContent: { cancelled, ...snapshot },
      };
    },
  );

  return server;
}

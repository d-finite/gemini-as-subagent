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
import { RunTracker, formatTokensShort, readSessionTokens, summarizeLabel } from "./telemetry.js";
import { TOOLS, type ToolDef } from "./tools.js";

export const PANEL_URI = "ui://agy-bridge/panel.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

const PANEL_META = {
  ui: { resourceUri: PANEL_URI },
  "ui/resourceUri": PANEL_URI,
};

const PANEL_SIDE_META = {
  ui: { resourceUri: PANEL_URI },
  "ui/resourceUri": PANEL_URI,
  "com.google.antigravity/ui": {
    entrypoints: [{ type: "aux_pane", title: "Gemini Subagents" }],
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
      const prompt = tool.buildPrompt(args, cwd);
      const timeoutSec =
        cfg.perToolTimeouts[tool.name] ?? (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec);

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

      const attempts: string[] = [];
      let result: RunResult | undefined;
      let used: string | undefined;

      for (const model of resolution.models) {
        if (model && cooldowns.cooling(model)) {
          attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
          continue;
        }
        if (model) tracker.updateRunModel(runId, model);
        try {
          result = await runAgy(
            { prompt, cwd, model, conversationId, timeoutSec, signal: extra?.signal },
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
      const finished = await tracker.finishRun(runId, {
        status: "done",
        model: used ?? tokens?.model ?? "agy default",
        sessionId: finalSessionId,
        output: result.output,
        truncated: result.truncated,
        failover: attempts,
        tokens,
      });

      const snapshot = await tracker.getSnapshot(cooldowns);

      const elapsedSec = finished ? `${(finished.elapsedMs / 1000).toFixed(1)}s` : undefined;
      const meta: string[] = [`model: ${used ?? tokens?.model ?? "agy default"}`];
      if (elapsedSec) meta.push(`time: ${elapsedSec}`);
      if (tokens) {
        meta.push(
          `ctx: ${formatTokensShort(tokens.contextTokens)} (cache ${Math.round(tokens.cacheHitPct)}%)`,
        );
        meta.push(`out: ${formatTokensShort(tokens.totalOutputTokens)}`);
      }
      const q5 = snapshot.quota.buckets.find((b) => b.window === "5h");
      const qw = snapshot.quota.buckets.find((b) => b.window === "weekly");
      if (q5 || qw) {
        const qParts: string[] = [];
        if (q5) qParts.push(`5h ${q5.remainingPct.toFixed(0)}%`);
        if (qw) qParts.push(`wk ${qw.remainingPct.toFixed(0)}%`);
        meta.push(`agy: ${qParts.join("/")}`);
      }
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      if (attempts.length) meta.push(`failover: ${attempts.join("; ")}`);
      if (finalSessionId) meta.push(`session: ${finalSessionId} (use follow_up to continue)`);

      return {
        content: [
          { type: "text", text: `${result.output}\n\n---\n[agy-bridge] ${meta.join(" | ")}` },
        ],
        structuredContent: {
          activeRunId: runId,
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
      let text = msg;
      if (cfg.onFailure === "strict") {
        text +=
          "\n\n[agy-bridge strict mode] Delegation failed. Do NOT perform this work yourself " +
          "in the main context — report the failure to the user and let them decide how to proceed.";
      }
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
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
  const server = new McpServer({ name: "agy-bridge", version });

  server.registerResource(
    "gemini_subagents_panel",
    PANEL_URI,
    {
      title: "Gemini Subagents & Antigravity Quota",
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
        return `- [${r.status}] ${r.model} (${r.tool}) ${(r.elapsedMs / 1000).toFixed(1)}s${tok}: ${r.label}`;
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
      description: "Internal app-only state polling endpoint for the Gemini Subagents UI panel.",
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

  return server;
}

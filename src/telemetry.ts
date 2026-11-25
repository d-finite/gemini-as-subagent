import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formatDuration, type CooldownRegistry } from "./quota.js";

export interface QuotaBucket {
  id: string;
  window: "5h" | "weekly";
  remainingPct: number;
  resetTimeMs: number | null;
  resetInSec: number | null;
  resetText: string | null;
  observedTokens?: number;
  observedRequests?: number;
  observedCost?: number;
  sampledAtMs: number | null;
}

export interface CooldownEntry {
  model: string;
  remainingSec: number;
  remainingText: string;
}

export interface QuotaSnapshot {
  buckets: QuotaBucket[];
  cooldowns: CooldownEntry[];
  sourceAvailable: boolean;
  sampledAtMs: number | null;
}

export interface TokenMetrics {
  contextTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheHitPct: number;
  totalOutputTokens: number;
  turns: number;
  model?: string;
}

export type RunStatus = "running" | "done" | "error" | "cancelled";
export type NeonTier = "medium" | "high" | "xhigh" | "other";

export interface RunRecord {
  id: string;
  tool: string;
  model: string;
  tier: NeonTier;
  status: RunStatus;
  cwd: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  elapsedMs: number;
  sessionId?: string;
  outputChars?: number;
  truncated?: boolean;
  error?: string;
  tokens?: TokenMetrics;
  outputPreview?: string;
  failover?: string[];
}

export interface DashboardSnapshot {
  nowMs: number;
  activeCount: number;
  runs: RunRecord[];
  quota: QuotaSnapshot;
}

export const DEFAULT_QUOTA_PATH = path.join(
  homedir(),
  ".gemini",
  "antigravity",
  "plugin_data",
  "agy-powertools",
  "quota-samples.json",
);

export const DEFAULT_STATE_PATH = path.join(
  homedir(),
  ".gemini",
  "antigravity",
  "plugin_data",
  "agy-bridge-custom",
  "runs.json",
);

const MAX_RETAINED_RUNS = 24;
const PREVIEW_CHARS = 500;

export function inferNeonTier(model: string): NeonTier {
  const m = model.toLowerCase();
  if (m.includes("xhigh")) return "xhigh";
  if (m.includes("high")) return "high";
  if (m.includes("medium")) return "medium";
  return "other";
}

export function shortModelLabel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("neon")) {
    if (m.includes("xhigh")) return "Neon XHigh";
    if (m.includes("high")) return "Neon High";
    if (m.includes("medium")) return "Neon Med";
    if (m.includes("low")) return "Neon Low";
    return "Neon";
  }
  if (m.includes("flash")) return "Flash";
  if (m.includes("hydrogen")) return "Hydrogen";
  return model.length > 22 ? `${model.slice(0, 20)}…` : model;
}

export function summarizeLabel(tool: string, args: Record<string, unknown>): string {
  const raw =
    (typeof args.question === "string" && args.question) ||
    (typeof args.query === "string" && args.query) ||
    (typeof args.focus === "string" && args.focus) ||
    (typeof args.prompt === "string" && args.prompt) ||
    (Array.isArray(args.files) && args.files.length
      ? args.files.map((f) => path.basename(String(f))).join(", ")
      : "") ||
    (typeof args.content === "string" && args.content) ||
    tool;
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > 88 ? `${clean.slice(0, 86)}…` : clean;
}

export function formatCompactReset(sec: number | null): string | null {
  if (sec === null || sec <= 0) return null;
  if (sec >= 86400) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  return formatDuration(sec);
}

interface RawQuotaCheckpoint {
  atMs?: number;
  fraction?: number;
  observedCost?: number;
  observedTokens?: number;
  observedRequests?: number;
}

interface RawQuotaEntry {
  id?: string;
  resetTimeMs?: number;
  active?: boolean;
  lastAt?: number;
  checkpoints?: RawQuotaCheckpoint[];
}

export async function readAntigravityQuota(
  cooldowns?: CooldownRegistry,
  quotaPath: string = DEFAULT_QUOTA_PATH,
  nowMs: number = Date.now(),
): Promise<QuotaSnapshot> {
  const activeCooldowns: CooldownEntry[] = cooldowns ? cooldowns.listActive() : [];
  try {
    const raw = await readFile(quotaPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { buckets: [], cooldowns: activeCooldowns, sourceAvailable: false, sampledAtMs: null };
    }

    const buckets: QuotaBucket[] = [];
    let latestSample: number | null = null;

    for (const item of parsed as RawQuotaEntry[]) {
      const id = String(item.id ?? "");
      if (!id || item.active === false) continue;
      const lower = id.toLowerCase();
      if (!lower.includes("gemini")) continue;
      const window: "5h" | "weekly" = lower.includes("weekly") ? "weekly" : "5h";
      const cps = Array.isArray(item.checkpoints) ? item.checkpoints : [];
      const lastCp = cps.length > 0 ? cps[cps.length - 1] : undefined;
      if (!lastCp || typeof lastCp.fraction !== "number") continue;

      const sampledAtMs =
        typeof lastCp.atMs === "number"
          ? lastCp.atMs
          : typeof item.lastAt === "number"
            ? item.lastAt
            : null;
      if (sampledAtMs !== null && (latestSample === null || sampledAtMs > latestSample)) {
        latestSample = sampledAtMs;
      }

      const resetTimeMs = typeof item.resetTimeMs === "number" ? item.resetTimeMs : null;
      const resetInSec =
        resetTimeMs !== null ? Math.max(0, Math.floor((resetTimeMs - nowMs) / 1000)) : null;

      buckets.push({
        id,
        window,
        remainingPct: Math.max(0, Math.min(100, Math.round(lastCp.fraction * 1000) / 10)),
        resetTimeMs,
        resetInSec,
        resetText: formatCompactReset(resetInSec),
        observedTokens:
          typeof lastCp.observedTokens === "number" ? lastCp.observedTokens : undefined,
        observedRequests:
          typeof lastCp.observedRequests === "number" ? lastCp.observedRequests : undefined,
        observedCost: typeof lastCp.observedCost === "number" ? lastCp.observedCost : undefined,
        sampledAtMs,
      });
    }

    // Order 5h before weekly
    buckets.sort((a, b) => (a.window === b.window ? 0 : a.window === "5h" ? -1 : 1));
    return {
      buckets,
      cooldowns: activeCooldowns,
      sourceAvailable: buckets.length > 0,
      sampledAtMs: latestSample,
    };
  } catch {
    return { buckets: [], cooldowns: activeCooldowns, sourceAvailable: false, sampledAtMs: null };
  }
}

export async function readSessionTokens(
  sessionId: string,
  brainRoots: string[] = [
    path.join(homedir(), ".gemini", "antigravity-cli", "brain"),
    path.join(homedir(), ".gemini", "antigravity", "brain"),
  ],
): Promise<TokenMetrics | undefined> {
  if (!sessionId || /[/\\]/.test(sessionId)) return undefined;

  let raw = "";
  for (const root of brainRoots) {
    const tpath = path.join(root, sessionId, ".system_generated", "logs", "transcript.jsonl");
    try {
      raw = await readFile(tpath, "utf8");
      if (raw) break;
    } catch {
      // try next root
    }
  }
  if (!raw) return undefined;

  let latestInput = 0;
  let latestCache = 0;
  let totalOutput = 0;
  let turns = 0;
  let model: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.includes('"PLANNER_RESPONSE"')) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        input_tokens?: number;
        cache_read_tokens?: number;
        output_tokens?: number;
        model?: string;
      };
      if (obj.type !== "PLANNER_RESPONSE") continue;
      turns += 1;
      const inp = typeof obj.input_tokens === "number" ? obj.input_tokens : 0;
      const cache = typeof obj.cache_read_tokens === "number" ? obj.cache_read_tokens : 0;
      const out = typeof obj.output_tokens === "number" ? obj.output_tokens : 0;
      if (inp + cache > 0) {
        latestInput = inp;
        latestCache = cache;
      }
      totalOutput += out;
      if (typeof obj.model === "string" && obj.model) model = obj.model;
    } catch {
      // ignore malformed line
    }
  }

  if (turns === 0) return undefined;
  const contextTokens = latestInput + latestCache;
  const cacheHitPct = contextTokens > 0 ? Math.round((latestCache / contextTokens) * 1000) / 10 : 0;

  return {
    contextTokens,
    inputTokens: latestInput,
    cacheReadTokens: latestCache,
    cacheHitPct,
    totalOutputTokens: totalOutput,
    turns,
    model,
  };
}

export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export class RunTracker {
  private runs: RunRecord[] = [];
  private fullOutputs = new Map<string, string>();
  private loaded = false;

  constructor(
    private statePath: string = DEFAULT_STATE_PATH,
    private quotaPath: string = DEFAULT_QUOTA_PATH,
    private persist: boolean = true,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.persist) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        // Any run persisted as "running" from a dead process is stale -> mark error
        this.runs = (parsed as RunRecord[])
          .slice(0, MAX_RETAINED_RUNS)
          .map((r) =>
            r.status === "running"
              ? { ...r, status: "error", error: r.error ?? "interrupted (previous server exited)" }
              : r,
          );
      }
    } catch {
      // fresh state
    }
  }

  private async save(): Promise<void> {
    if (!this.persist) return;
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(
        this.statePath,
        JSON.stringify(this.runs.slice(0, MAX_RETAINED_RUNS)),
        "utf8",
      );
    } catch {
      // best effort
    }
  }

  async startRun(opts: {
    tool: string;
    model: string;
    cwd: string;
    label: string;
    sessionId?: string;
  }): Promise<RunRecord> {
    await this.ensureLoaded();
    const rec: RunRecord = {
      id: randomUUID().slice(0, 8),
      tool: opts.tool,
      model: opts.model,
      tier: inferNeonTier(opts.model),
      status: "running",
      cwd: opts.cwd,
      label: opts.label,
      startedAt: Date.now(),
      elapsedMs: 0,
      sessionId: opts.sessionId,
    };
    this.runs.unshift(rec);
    if (this.runs.length > MAX_RETAINED_RUNS) {
      const removed = this.runs.splice(MAX_RETAINED_RUNS);
      for (const r of removed) this.fullOutputs.delete(r.id);
    }
    void this.save();
    return rec;
  }

  updateRunModel(id: string, model: string): void {
    const rec = this.runs.find((r) => r.id === id);
    if (!rec) return;
    rec.model = model;
    rec.tier = inferNeonTier(model);
  }

  async finishRun(
    id: string,
    update: {
      status: Exclude<RunStatus, "running">;
      model?: string;
      sessionId?: string;
      output?: string;
      truncated?: boolean;
      error?: string;
      failover?: string[];
      tokens?: TokenMetrics;
    },
  ): Promise<RunRecord | undefined> {
    await this.ensureLoaded();
    const rec = this.runs.find((r) => r.id === id);
    if (!rec) return undefined;
    const now = Date.now();
    rec.status = update.status;
    rec.finishedAt = now;
    rec.elapsedMs = Math.max(0, now - rec.startedAt);
    if (update.model) {
      rec.model = update.model;
      rec.tier = inferNeonTier(update.model);
    }
    if (update.sessionId) rec.sessionId = update.sessionId;
    if (update.output !== undefined) {
      rec.outputChars = update.output.length;
      rec.outputPreview =
        update.output.length > PREVIEW_CHARS
          ? `${update.output.slice(0, PREVIEW_CHARS)}…`
          : update.output;
      this.fullOutputs.set(id, update.output);
    }
    if (update.truncated !== undefined) rec.truncated = update.truncated;
    if (update.error !== undefined) rec.error = update.error;
    if (update.failover?.length) rec.failover = update.failover;
    if (update.tokens) rec.tokens = update.tokens;
    void this.save();
    return rec;
  }

  getFullOutput(id: string): { run?: RunRecord; output?: string } {
    const run = this.runs.find((r) => r.id === id);
    return { run, output: this.fullOutputs.get(id) ?? run?.outputPreview };
  }

  async getSnapshot(cooldowns?: CooldownRegistry): Promise<DashboardSnapshot> {
    await this.ensureLoaded();
    const nowMs = Date.now();
    const quota = await readAntigravityQuota(cooldowns, this.quotaPath, nowMs);
    const runs = this.runs.map((r) => ({
      ...r,
      elapsedMs: r.status === "running" ? Math.max(0, nowMs - r.startedAt) : r.elapsedMs,
    }));
    const activeCount = runs.filter((r) => r.status === "running").length;
    return { nowMs, activeCount, runs, quota };
  }
}

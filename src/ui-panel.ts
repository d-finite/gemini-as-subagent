import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiDisplayMode,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

interface QuotaBucket {
  id: string;
  window: "5h" | "weekly";
  remainingPct: number;
  resetTimeMs: number | null;
  resetInSec: number | null;
  resetText: string | null;
  observedTokens?: number;
  observedRequests?: number;
  sampledAtMs: number | null;
}

interface CooldownEntry {
  model: string;
  remainingSec: number;
  remainingText: string;
}

interface QuotaSnapshot {
  buckets: QuotaBucket[];
  cooldowns: CooldownEntry[];
  sourceAvailable: boolean;
  sampledAtMs: number | null;
}

interface TokenMetrics {
  contextTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheHitPct: number;
  totalOutputTokens: number;
  turns: number;
  model?: string;
}

interface RunRecord {
  id: string;
  tool: string;
  model: string;
  tier: "medium" | "high" | "xhigh" | "other";
  status: "running" | "done" | "error" | "cancelled";
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

interface DashboardSnapshot {
  nowMs: number;
  activeCount: number;
  runs: RunRecord[];
  quota: QuotaSnapshot;
  activeRunId?: string;
}

const app = new App({ name: "gemini-panel", version: "1.0.0" });

const GEMINI_STAR_SVG = `<svg class="gem-star" viewBox="0 0 28 28" fill="none" aria-hidden="true"><defs><linearGradient id="gemGrad" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4285F4"/><stop offset="45%" stop-color="#9B72CB"/><stop offset="80%" stop-color="#D96570"/><stop offset="100%" stop-color="#F4B400"/></linearGradient></defs><path d="M14 1.5C14.6 8.4 19.6 13.4 26.5 14C19.6 14.6 14.6 19.6 14 26.5C13.4 19.6 8.4 14.6 1.5 14C8.4 13.4 13.4 8.4 14 1.5Z" fill="url(#gemGrad)"/></svg>`;

let state: DashboardSnapshot | null = null;
let expandedId: string | null = null;
const fullOutputs = new Map<string, string>();
const loadingOutputs = new Set<string>();
let currentDisplayMode: string = "inline";
let availableModes: string[] = [];
let pollTimer: number | null = null;
let lastPollAt = 0;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${s < 10 ? "0" : ""}${s}s`;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtAgo(ts: number | null): string {
  if (!ts) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ago`;
}

function shortModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("neon")) {
    if (m.includes("xhigh")) return "Neon XHigh";
    if (m.includes("high")) return "Neon High";
    if (m.includes("medium")) return "Neon Med";
    if (m.includes("low")) return "Neon Low";
    return "Neon";
  }
  if (m.includes("flash")) return "Flash";
  return model.length > 18 ? `${model.slice(0, 17)}…` : model;
}

function shortTool(tool: string): string {
  switch (tool) {
    case "analyze_files":
      return "analyze";
    case "deep_search":
      return "search";
    case "web_lookup":
      return "web";
    case "adversarial_review":
      return "review";
    case "follow_up":
      return "follow";
    default:
      return tool;
  }
}

function barTone(pct: number): string {
  if (pct >= 40) return "ok";
  if (pct >= 15) return "warn";
  return "low";
}

function renderQuota(q: QuotaSnapshot): string {
  if (!q.sourceAvailable && q.cooldowns.length === 0) {
    return `<div class="quota-empty">Antigravity 额度未采样（打开 Antigravity Powertools 后自动同步）</div>`;
  }
  const cards = q.buckets
    .map((b) => {
      const label = b.window === "5h" ? "5h 窗口" : "周额度";
      const tone = barTone(b.remainingPct);
      const reset = b.resetText ? `重置 ${esc(b.resetText)}` : "";
      return `
        <div class="q-item">
          <div class="q-head">
            <span class="q-label">${label}</span>
            <span class="q-pct tone-${tone}">${b.remainingPct.toFixed(1)}%</span>
          </div>
          <div class="q-track"><div class="q-fill tone-${tone}" style="width:${Math.max(2, Math.min(100, b.remainingPct))}%"></div></div>
          <div class="q-sub">${reset}${b.observedRequests ? ` · ${b.observedRequests} req` : ""}</div>
        </div>
      `;
    })
    .join("");

  const cooldownHtml = q.cooldowns.length
    ? `<div class="cooldowns">${q.cooldowns
        .map(
          (c) =>
            `<span class="cd-pill">429 ${esc(shortModel(c.model))} (${esc(c.remainingText)})</span>`,
        )
        .join("")}</div>`
    : "";

  const fresh = q.sampledAtMs ? `<span class="q-fresh">同步 ${fmtAgo(q.sampledAtMs)}</span>` : "";

  return `
    <div class="quota-box">
      <div class="q-grid">${cards}</div>
      ${cooldownHtml}
      ${fresh ? `<div class="q-foot"><span>Antigravity 实时额度</span>${fresh}</div>` : ""}
    </div>
  `;
}

function renderRuns(runs: RunRecord[]): string {
  if (!runs.length) {
    return `<div class="empty">暂无 Gemini 子任务记录。Claude 调用 gemini MCP 后会在此实时显示耗时、上下文与输出。</div>`;
  }
  const now = Date.now();
  return `<div class="run-list">${runs
    .map((r) => {
      const elapsed = r.status === "running" ? Math.max(0, now - r.startedAt) : r.elapsedMs;
      const isOpen = expandedId === r.id;
      const tokBits: string[] = [];
      if (r.tokens) {
        tokBits.push(
          `ctx ${fmtTok(r.tokens.contextTokens)}${r.tokens.cacheHitPct > 0 ? ` (${Math.round(r.tokens.cacheHitPct)}% cache)` : ""}`,
        );
        tokBits.push(`out ${fmtTok(r.tokens.totalOutputTokens)}`);
        if (r.tokens.turns > 1) tokBits.push(`${r.tokens.turns}t`);
      } else if (r.outputChars) {
        tokBits.push(`${fmtTok(r.outputChars)} chars`);
      }
      const metaRight = [
        `<span class="t-elapsed" data-run-id="${esc(r.id)}">${fmtElapsed(elapsed)}</span>`,
        ...tokBits.map((b) => `<span>${esc(b)}</span>`),
      ].join(`<span class="sep">·</span>`);

      let detailHtml = "";
      if (isOpen) {
        const bodyText = fullOutputs.has(r.id)
          ? fullOutputs.get(r.id)!
          : loadingOutputs.has(r.id)
            ? "加载完整输出中…"
            : (r.outputPreview ?? r.error ?? "(无输出)");
        const cwdShort = r.cwd.replace(/^\/Users\/[^/]+/, "~");
        detailHtml = `
          <div class="detail">
            <div class="detail-meta">
              <span><strong>Model:</strong> ${esc(r.model)}</span>
              ${r.sessionId ? `<span><strong>Session:</strong> <code>${esc(r.sessionId.slice(0, 12))}</code></span>` : ""}
              <span><strong>CWD:</strong> <code>${esc(cwdShort)}</code></span>
              ${r.failover?.length ? `<span class="fail-note">Failover: ${esc(r.failover.join("; "))}</span>` : ""}
            </div>
            <pre class="detail-out">${esc(bodyText)}</pre>
          </div>
        `;
      }

      return `
        <div class="run-card status-${r.status}${isOpen ? " is-open" : ""}" data-toggle="${esc(r.id)}">
          <div class="run-top">
            <span class="dot dot-${r.status}"></span>
            <span class="pill tier-${r.tier}">${esc(shortModel(r.model))}</span>
            <span class="tool-tag">${esc(shortTool(r.tool))}</span>
            <span class="run-label" title="${esc(r.label)}">${esc(r.label)}</span>
          </div>
          <div class="run-meta">${metaRight}</div>
          ${detailHtml}
        </div>
      `;
    })
    .join("")}</div>`;
}

function render(): void {
  const root = document.getElementById("app");
  if (!root) return;

  const active = state?.activeCount ?? 0;
  const preferredExpanded = availableModes.find((m) => m !== "inline");
  const canToggleMode = Boolean(preferredExpanded);
  const nextMode = currentDisplayMode !== "inline" ? "inline" : (preferredExpanded ?? "fullscreen");
  const modeLabel =
    currentDisplayMode !== "inline" ? "收起" : preferredExpanded === "pip" ? "浮窗" : "展开";

  root.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="tb-left">
          <span class="star-wrap ${active > 0 ? "is-active" : ""}">${GEMINI_STAR_SVG}</span>
          <span class="tb-title">Gemini</span>
          ${active > 0 ? `<span class="active-badge">${active} 运行中</span>` : `<span class="idle-badge">${state?.runs.length ?? 0} 条记录</span>`}
        </div>
        <div class="tb-right">
          ${canToggleMode ? `<button class="btn" id="btn-mode" data-mode="${nextMode}">${modeLabel}</button>` : ""}
          <button class="btn" id="btn-refresh" title="刷新状态">↻</button>
        </div>
      </div>
      ${state ? renderQuota(state.quota) : `<div class="quota-empty">连接中…</div>`}
      ${state ? renderRuns(state.runs) : ""}
    </div>
  `;

  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    void refreshState();
  });
  document.getElementById("btn-mode")?.addEventListener("click", async (e) => {
    const mode = (e.currentTarget as HTMLButtonElement).dataset.mode as McpUiDisplayMode;
    try {
      const res = await app.requestDisplayMode({ mode });
      if (res?.mode) {
        currentDisplayMode = res.mode;
        render();
      }
    } catch {
      // host does not support switching
    }
  });

  root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".detail-out")) return;
      const id = el.dataset.toggle!;
      expandedId = expandedId === id ? null : id;
      render();
      if (expandedId && !fullOutputs.has(expandedId) && !loadingOutputs.has(expandedId)) {
        void loadFullOutput(expandedId);
      }
    });
  });
}

async function loadFullOutput(id: string): Promise<void> {
  loadingOutputs.add(id);
  render();
  try {
    const res = await app.callServerTool({
      name: "_agy_get_run_output",
      arguments: { run_id: id },
    });
    const sc = (res as { structuredContent?: { output?: string } })?.structuredContent;
    if (typeof sc?.output === "string") {
      fullOutputs.set(id, sc.output);
    }
  } catch {
    // keep preview
  } finally {
    loadingOutputs.delete(id);
    render();
  }
}

async function refreshState(): Promise<void> {
  lastPollAt = Date.now();
  try {
    const res = await app.callServerTool({ name: "_agy_panel_state", arguments: {} });
    const sc = (res as { structuredContent?: DashboardSnapshot })?.structuredContent;
    if (sc && Array.isArray(sc.runs)) {
      state = sc;
      render();
      schedulePoll();
    }
  } catch {
    // transient
  }
}

function schedulePoll(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  const interval = (state?.activeCount ?? 0) > 0 ? 2000 : 15000;
  pollTimer = window.setTimeout(() => {
    void refreshState();
  }, interval);
}

// Smooth local timer tick for running tasks
window.setInterval(() => {
  if (!state || state.activeCount === 0) return;
  const now = Date.now();
  for (const r of state.runs) {
    if (r.status !== "running") continue;
    const el = document.querySelector<HTMLElement>(`.t-elapsed[data-run-id="${r.id}"]`);
    if (el) el.textContent = fmtElapsed(Math.max(0, now - r.startedAt));
  }
  if (now - lastPollAt > 2500) {
    void refreshState();
  }
}, 250);

function applyContext(ctx: ReturnType<App["getHostContext"]>): void {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.dataset.theme = ctx.theme;
  }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.displayMode) currentDisplayMode = ctx.displayMode;
  if (Array.isArray(ctx.availableDisplayModes)) availableModes = ctx.availableDisplayModes;
}

app.ontoolinput = () => {
  void refreshState();
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: DashboardSnapshot })?.structuredContent;
  if (sc && Array.isArray(sc.runs)) {
    state = sc;
    if (sc.activeRunId && !expandedId) {
      // keep compact by default; user can click to expand
    }
    render();
    schedulePoll();
  } else {
    void refreshState();
  }
};

app.onhostcontextchanged = (ctx) => {
  applyContext(ctx as ReturnType<App["getHostContext"]>);
  render();
};

async function boot(): Promise<void> {
  render();
  await app.connect();
  applyContext(app.getHostContext());
  render();
  await refreshState();
}

void boot();

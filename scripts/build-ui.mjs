import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CSS = `
:root {
  --bg: var(--color-background-primary, #ffffff);
  --bg2: var(--color-background-secondary, #f6f7f9);
  --fg: var(--color-text-primary, #171717);
  --fg2: var(--color-text-secondary, #6b7280);
  --bd: var(--color-border-primary, rgba(0, 0, 0, 0.1));
  --ok: #10b981;
  --warn: #f59e0b;
  --low: #ef4444;
  --accent: #4f46e5;
  --font: var(--font-sans, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif);
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
html[data-theme="dark"] {
  --bg: var(--color-background-primary, #171717);
  --bg2: var(--color-background-secondary, #222326);
  --fg: var(--color-text-primary, #ececec);
  --fg2: var(--color-text-secondary, #9ca3af);
  --bd: var(--color-border-primary, rgba(255, 255, 255, 0.11));
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 12px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
.shell { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 7px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tb-left, .tb-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.star-wrap { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.gem-star { width: 15px; height: 15px; display: block; }
.star-wrap.is-active .gem-star { animation: gemSpin 2.6s ease-in-out infinite; filter: drop-shadow(0 0 4px rgba(155,114,203,0.55)); }
@keyframes gemSpin { 0%, 100% { transform: scale(1) rotate(0deg); } 50% { transform: scale(1.12) rotate(18deg); } }
.tb-title { font-weight: 600; font-size: 12.5px; letter-spacing: -0.01em; }
.active-badge { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: rgba(16,185,129,0.14); color: var(--ok); font-weight: 600; }
.idle-badge { font-size: 10.5px; color: var(--fg2); }
.btn {
  background: var(--bg2); color: var(--fg); border: 1px solid var(--bd);
  border-radius: 5px; padding: 2px 7px; font-size: 11px; cursor: pointer;
  font-family: inherit; line-height: 1.4;
}
.btn:hover { border-color: var(--fg2); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.dot-running { background: var(--ok); box-shadow: 0 0 0 0 rgba(16,185,129,0.55); animation: pulse 1.4s infinite; }
.dot-done { background: #10b981; opacity: 0.75; }
.dot-error { background: var(--low); }
.dot-cancelled { background: var(--fg2); opacity: 0.6; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); } 70% { box-shadow: 0 0 0 5px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }

.quota-box { background: var(--bg2); border: 1px solid var(--bd); border-radius: 7px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.q-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 14px; }
.q-item { display: flex; flex-direction: column; gap: 3px; }
.q-head { display: flex; justify-content: space-between; align-items: baseline; }
.q-label { font-size: 11px; color: var(--fg2); font-weight: 500; }
.q-pct { font-family: var(--mono); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.q-track { height: 4px; border-radius: 999px; background: var(--bd); overflow: hidden; }
.q-fill { height: 100%; border-radius: 999px; transition: width 240ms ease; }
.tone-ok { color: var(--ok); }
.q-fill.tone-ok { background: var(--ok); }
.tone-warn { color: var(--warn); }
.q-fill.tone-warn { background: var(--warn); }
.tone-low { color: var(--low); }
.q-fill.tone-low { background: var(--low); }
.q-sub { font-size: 10px; color: var(--fg2); font-family: var(--mono); }
.q-foot { display: flex; justify-content: space-between; font-size: 10px; color: var(--fg2); border-top: 1px solid var(--bd); padding-top: 4px; }
.quota-empty { background: var(--bg2); border: 1px dashed var(--bd); border-radius: 7px; padding: 6px 9px; font-size: 11px; color: var(--fg2); }
.cooldowns { display: flex; flex-wrap: wrap; gap: 4px; }
.cd-pill { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(239,68,68,0.13); color: var(--low); font-family: var(--mono); }

.run-list { display: flex; flex-direction: column; gap: 5px; }
.run-card {
  border: 1px solid var(--bd); border-radius: 7px; padding: 6px 8px;
  background: var(--bg); cursor: pointer; transition: border-color 120ms ease;
}
.run-card:hover { border-color: var(--fg2); }
.run-card.status-running { border-color: rgba(16,185,129,0.45); background: var(--bg2); }
.run-top { display: flex; align-items: center; gap: 5px; min-width: 0; }
.pill {
  font-size: 10px; font-weight: 600; padding: 0.5px 5px; border-radius: 4px;
  white-space: nowrap; flex-shrink: 0;
}
.tier-medium { background: rgba(100,116,139,0.14); color: var(--fg2); }
.tier-high { background: rgba(79,70,229,0.14); color: #6366f1; }
.tier-xhigh { background: rgba(168,85,247,0.16); color: #a855f7; }
.tier-other { background: var(--bg2); color: var(--fg2); }
.tool-tag { font-size: 10px; color: var(--fg2); font-family: var(--mono); flex-shrink: 0; }
.run-label { font-size: 11.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.run-meta {
  margin-top: 3px; padding-left: 12px; font-size: 10.5px; color: var(--fg2);
  font-family: var(--mono); font-variant-numeric: tabular-nums;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
}
.sep { opacity: 0.45; }
.detail { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--bd); display: flex; flex-direction: column; gap: 5px; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 10.5px; color: var(--fg2); }
.detail-meta code { font-family: var(--mono); font-size: 10px; color: var(--fg); }
.fail-note { color: var(--warn); }
.detail-out {
  background: var(--bg2); border: 1px solid var(--bd); border-radius: 5px;
  padding: 6px 8px; font-family: var(--mono); font-size: 10.5px; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto;
  cursor: text;
}
.empty { padding: 10px; text-align: center; color: var(--fg2); font-size: 11px; border: 1px dashed var(--bd); border-radius: 7px; }
`;

async function main() {
  const result = await build({
    entryPoints: [path.resolve("src/ui-panel.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: ["es2020"],
    minify: true,
    platform: "browser",
  });
  const js = result.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Gemini</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='2' y1='2' x2='26' y2='26' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0%25' stop-color='%234285F4'/%3E%3Cstop offset='45%25' stop-color='%239B72CB'/%3E%3Cstop offset='80%25' stop-color='%23D96570'/%3E%3Cstop offset='100%25' stop-color='%23F4B400'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M14 1.5C14.6 8.4 19.6 13.4 26.5 14C19.6 14.6 14.6 19.6 14 26.5C13.4 19.6 8.4 14.6 1.5 14C8.4 13.4 13.4 8.4 14 1.5Z' fill='url(%23g)'/%3E%3C/svg%3E" />
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`;

  await mkdir(path.resolve("dist"), { recursive: true });
  await writeFile(path.resolve("dist/panel.html"), html, "utf8");
  console.log(`Built dist/panel.html (${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KiB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

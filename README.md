# gemini-as-subagent

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

An MCP server and compact [MCP App](https://github.com/modelcontextprotocol/ext-apps) dashboard that lets **Claude Code** (and other MCP hosts such as Codex, Cursor, VS Code, or OpenCode) use **Gemini** via the [Antigravity CLI (`agy`)](https://antigravity.google/docs/cli-getting-started) as an on-demand subagent and collaborative reviewer.

> Forked from [`sshahzaiib/agy-bridge`](https://github.com/sshahzaiib/agy-bridge) and extended with Gemini 4 Neon 3-tier routing, real session token/cache telemetry, Antigravity quota tracking, and a self-contained compact MCP App UI panel.

---

## Why Use This

- **Protect your main model's context & quota**: Offload bulky file/log/trajectory reading and repository archaeology to Gemini (`gemini-4-neon-medium`), returning a detailed plain-language intelligence report without flooding your primary context window.
- **Independent second opinion**: Delegate proposal/prompt/code reviews and pre-decision discussions to Gemini (`gemini-4-neon-high`, or `gemini-4-neon-xhigh` for rare deep evaluations).
- **One-shot vs. multi-turn control**: Start a clean temporary session for one-off investigations or unanchored blind reviews, or pass `session_id` to `follow_up` for multi-turn debate.
- **Compact live status panel (MCP App)**: View active/recent Gemini subagent runs, elapsed time, real context tokens, cache hit rate, expandable outputs, and Antigravity 5h/weekly quota bars right inside your MCP client.
- **Battle-tested subprocess handling**: Inherits upstream `agy-bridge`'s closed-stdin handling, POSIX/Windows process-tree cancellation, and 429 quota-exhaustion detection with cooldown failover.

---

## Architecture

```text
Host (Claude Code / Codex / Cursor / ...)
  └─ MCP (stdio) ──▶ gemini-as-subagent
                       ├─ agy CLI (-p --model ...) ──▶ Gemini 4 Neon (Med / High / XHigh)
                       ├─ Read-only telemetry      ──▶ ~/.gemini/antigravity-cli/brain/*/transcript.jsonl
                       ├─ Optional quota reader    ──▶ ~/.gemini/antigravity/plugin_data/agy-powertools/quota-samples.json
                       └─ MCP App UI               ──▶ ui://gemini/panel.html (self-contained HTML)
```

---

## Requirements

- **Node.js 18+**
- **Antigravity CLI (`agy`)** installed and authenticated (`agy models` should list your available models)
- Any **MCP-compatible host** (e.g., Claude Code Desktop / CLI)
- _(Optional)_ [`agy-powertools`](https://github.com/WhiteBr1ck/agy-powertools) running in Antigravity Desktop if you want live 5h / weekly Antigravity quota bars inside the panel (gracefully degrades if absent)

---

## Installation

### 1. Clone and Build

```bash
git clone https://github.com/d-finite/gemini-as-subagent.git
cd gemini-as-subagent
npm install --legacy-peer-deps
npm run build
```

### 2. Register in Claude Code (User Scope)

Use absolute paths for `node` and `agy` so GUI apps (like Claude Desktop on macOS) never hit a restricted `PATH`:

```bash
NODE_BIN=$(which node)
AGY_BIN=$(which agy)

claude mcp add-json -s user gemini \
  "{\"command\":\"${NODE_BIN}\",\"args\":[\"$(pwd)/dist/index.js\"],\"env\":{\"AGY_PATH\":\"${AGY_BIN}\",\"AGY_MAX_OUTPUT_CHARS\":\"50000\"},\"timeout\":600000}"
```

Verify the connection:

```bash
claude mcp list
```

> **Timeout note**: Setting `"timeout": 600000` (10 minutes) prevents Claude Code from timing out before long file/trajectory analyses finish. If your client ignores per-server timeouts, set `MCP_TOOL_TIMEOUT=600000`.

### 3. Other MCP Clients (Codex / Cursor / OpenCode / etc.)

Point any stdio MCP client to `node /path/to/gemini-as-subagent/dist/index.js` with `AGY_PATH` set to your `agy` binary.

---

## Tools & Default Neon Routing

| Tool                 | Purpose                                                         | Default Model Chain                                       |
| :------------------- | :-------------------------------------------------------------- | :-------------------------------------------------------- |
| `analyze_files`      | Heavy file, log, or trajectory reading (>200 lines or >3 files) | `Gemini * Neon (Medium)` → `Neon (High)` → `Flash (High)` |
| `deep_search`        | Repo-wide grep and `git log`/`diff`/`blame` archaeology         | `Gemini * Neon (Medium)` → `Neon (High)` → `Flash (High)` |
| `web_lookup`         | Current docs, API references, external web lookup               | `Gemini * Neon (Medium)` → `Neon (High)` → `Flash (High)` |
| `adversarial_review` | Plan/proposal/prompt/code review & decision critique            | `Gemini * Neon (High)` → `Neon (XHigh)` → `Neon (Medium)` |
| `delegate`           | General collaborative research, report drafting, or discussion  | `Gemini * Neon (High)` → `Neon (XHigh)` → `Neon (Medium)` |
| `follow_up`          | Continue an existing temporary Gemini session by `session_id`   | Inherits prior session                                    |
| `gemini_status`      | Open or refresh the compact MCP App status & quota panel        | —                                                         |

Every tool accepts an optional `model` override (any ID or display name from `agy models`, e.g. `gemini-4-neon-xhigh`) and `cwd`.

Every delegation response includes a compact telemetry footer:

```text
---
[gemini] model: Gemini 4 Neon (High) | time: 18.4s | ctx: 12.1k (cache 78%) | out: 640 | agy: 5h 61%/wk 68% | session: <id> (use follow_up to continue)
```

---

## Recommended Collaboration Rules (`~/.claude/CLAUDE.md`)

To encourage healthy, disciplined delegation without wasting Gemini quota on trivial edits, add a concise section to your global `~/.claude/CLAUDE.md`:

- **Use `gemini` MCP actively for**:
  - High-volume reading (long docs, trajectory files, large logs, repo archaeology) → `gemini-4-neon-medium`
  - Proposal/prompt/code reviews, detailed reports, and pre-decision discussions → `gemini-4-neon-high`
  - Rare high-stakes deep evaluations → explicitly pass `model: "gemini-4-neon-xhigh"`
- **Keep local in Claude**:
  - Small single-file edits, quick local greps, or routine steps where Claude already has full context.
- **Fresh session vs. `follow_up`**:
  - Default to a fresh temporary session for one-off investigations and unanchored blind reviews; use `follow_up(session_id)` when debating a specific disagreement across multiple turns.

---

## Environment Variables

| Variable               | Default                 | Description                                                        |
| :--------------------- | :---------------------- | :----------------------------------------------------------------- |
| `AGY_PATH`             | `agy`                   | Path to the `agy` CLI binary                                       |
| `AGY_TIMEOUT`          | per-tool (`120`–`600`s) | Global `--print-timeout` override (seconds)                        |
| `AGY_TIMEOUT_<TOOL>`   | unset                   | Per-tool timeout override, e.g. `AGY_TIMEOUT_DEEP_SEARCH=300`      |
| `AGY_MAX_OUTPUT_CHARS` | `50000`                 | Output truncation cap (characters)                                 |
| `AGY_DEFAULT_MODEL`    | unset                   | Fallback model if no chain entry matches                           |
| `AGY_SKIP_PERMISSIONS` | `true`                  | Pass `--dangerously-skip-permissions` to `agy`                     |
| `AGY_SANDBOX`          | `false`                 | Pass `--sandbox` to `agy`                                          |
| `AGY_ON_FAILURE`       | `fallback`              | Set `strict` to instruct the host not to absorb failed delegations |

---

## Development

```bash
npm run format     # prettier
npm run typecheck  # tsc --noEmit
npm run build      # tsup + self-contained dist/panel.html
npm test           # vitest unit tests
```

---

## Credits & License

- Built on top of [`sshahzaiib/agy-bridge`](https://github.com/sshahzaiib/agy-bridge)
- License: [MIT](./LICENSE)

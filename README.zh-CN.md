# gemini-as-subagent

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

一个基于 **MCP** 与紧凑型 **[MCP App](https://github.com/modelcontextprotocol/ext-apps)** 面板的桥接服务，让 **Claude Code**（以及 Codex、Cursor、VS Code、OpenCode 等任意支持 MCP 的客户端）能够通过 [Antigravity CLI (`agy`)](https://antigravity.google/docs/cli-getting-started) 按需调用 **Gemini** 作为独立临时子代理（Subagent）和跨模型合作者。

> 本项目 Fork 自 [`sshahzaiib/agy-bridge`](https://github.com/sshahzaiib/agy-bridge)，在其稳定的子进程管理、进程树清理和 429 额度熔断基础上，新增了 **Gemini 4 Neon 三档路由**、**真实上下文 Token / 缓存命中率遥测**、**Antigravity 5h / 周额度读取**，以及**自包含的紧凑型 MCP App 监控面板**。

---

## 核心特性

- **替主模型省上下文与额度**：将冗长文档、大批量轨迹（trajectories）文件、海量运行日志和仓库考古交给 `gemini-4-neon-medium`，只把“说人话、保留原始证据与 `file:line`”的精细报告传回主模型。
- **独立跨模型合作与审校**：将方案/Proposal/Prompt 审校和重大未授权决策前的讨论交给 `gemini-4-neon-high`（极少数高难度深度评估可显式切 `gemini-4-neon-xhigh`）。
- **一次性会话 vs 多轮辩论自由切换**：常规情报收集和防观点漂移的独立盲审直接新开临时会话；需要针对具体分歧深入辩论时，用 `follow_up(session_id)` 续聊同一会话。
- **紧凑型实时状态面板（MCP App）**：在对话中直接渲染带 Gemini 彩色星标的紧凑卡片，实时查看运行中/历史 Gemini 子任务耗时、真实 `ctx` Token、缓存命中率、展开查看完整输出，以及 Antigravity 5h 窗口与周额度进度条。
- **工业级子进程防坑**：自动关闭 stdin 防止 `agy -p` 假死、支持取消时整棵进程树清理、通过日志实时捕获 `RESOURCE_EXHAUSTED (429)` 并自动冷却切换备用档位。

---

## 架构概览

```text
宿主客户端（Claude Code / Codex / Cursor / ...）
  └─ MCP (stdio) ──▶ gemini-as-subagent
                       ├─ agy CLI (-p --model ...) ──▶ Gemini 4 Neon (Med / High / XHigh)
                       ├─ 只读会话遥测             ──▶ ~/.gemini/antigravity-cli/brain/*/transcript.jsonl
                       ├─ 可选额度读取             ──▶ ~/.gemini/antigravity/plugin_data/agy-powertools/quota-samples.json
                       └─ MCP App 紧凑面板         ──▶ ui://gemini/panel.html（单文件自包含 HTML）
```

---

## 环境要求

- **Node.js 18+**
- 本机已安装并登录 **Antigravity CLI (`agy`)**（执行 `agy models` 可列出可用模型）
- 任意支持 **MCP** 的客户端（如 Claude Code 桌面端 / CLI）
- _（可选）_ 如需在面板中显示 Antigravity 5h / 周额度进度条，需在 Antigravity 桌面端启用 [`agy-powertools`](https://github.com/WhiteBr1ck/agy-powertools)；未安装时额度栏会优雅降级，不影响其他全部功能。

---

## 安装与配置

### 1. 克隆并构建

```bash
git clone https://github.com/d-finite/gemini-as-subagent.git
cd gemini-as-subagent
npm install --legacy-peer-deps
npm run build
```

### 2. 注册到 Claude Code（用户级全局生效）

建议使用 `node` 和 `agy` 的绝对路径，避免 macOS 桌面端（Claude App）因 `PATH` 受限找不到命令：

```bash
NODE_BIN=$(which node)
AGY_BIN=$(which agy)

claude mcp add-json -s user gemini \
  "{\"command\":\"${NODE_BIN}\",\"args\":[\"$(pwd)/dist/index.js\"],\"env\":{\"AGY_PATH\":\"${AGY_BIN}\",\"AGY_MAX_OUTPUT_CHARS\":\"50000\"},\"timeout\":600000}"
```

检查连通状态：

```bash
claude mcp list
```

> **关于超时**：`"timeout": 600000`（10 分钟）可避免长文件或轨迹分析在返回前触发客户端默认超时；若宿主不支持单服务超时配置，可设置全局环境变量 `MCP_TOOL_TIMEOUT=600000`。

### 3. 其他 MCP 客户端（Codex / Cursor / OpenCode 等）

在对应客户端的 stdio MCP 配置中启动 `node /path/to/gemini-as-subagent/dist/index.js`，并通过 `AGY_PATH` 指定 `agy` 路径即可复用。

---

## 工具列表与 Neon 三档路由

| 工具                 | 适用场景                                           | 默认路由链                                                | 同步默认超时                     |
| :------------------- | :------------------------------------------------- | :-------------------------------------------------------- | :------------------------------- |
| `analyze_files`      | 大文件、日志、批量轨迹阅读（>200 行或 >3 个文件）  | `Gemini * Neon (Medium)` → `Neon (High)` → `Flash (High)` | 15 分钟（`900s`）                |
| `deep_search`        | 全仓检索与 `git log`/`diff`/`blame` 历史考古       | `Gemini * Neon (Medium)` → `Neon (High)` → `Flash (High)` | 10 分钟（`600s`）                |
| `web_lookup`         | 查阅最新官方文档、API 参考与外部资料               | `Gemini * Neon (Medium)` → `Neon (High)` → `Flash (High)` | 10 分钟（`600s`）                |
| `adversarial_review` | Proposal / Prompt / 代码对抗审校与决策挑刺         | `Gemini * Neon (High)` → `Neon (XHigh)` → `Neon (Medium)` | 15 分钟（`900s`）                |
| `delegate`           | 通用合作调研、精细报告撰写或方案讨论               | `Gemini * Neon (High)` → `Neon (XHigh)` → `Neon (Medium)` | 30 分钟（`1800s`）               |
| `follow_up`          | 传入 `session_id` 续聊上一次 Gemini 临时会话       | 继承原会话                                                | 15 分钟（`900s`）                |
| `gemini_wait`        | 等待 `background: true` 后台任务完成并收回完整报告 | —                                                         | 最多等 `wait_sec`（默认 `120s`） |
| `gemini_status`      | 唤出或刷新紧凑型 MCP App 状态与额度面板            | —                                                         | —                                |

所有委托工具均支持可选参数 `model`、`cwd`、`timeout_sec`（传 `0` 表示无时间上限，直到完成）以及 `background: true`（后台异步运行、默认无时间上限、秒返 `run_id`，彻底避免长调研撞上同步 MCP 超时墙）。

每次调用返回末尾都会附带一行紧凑状态脚注：

```text
---
[gemini] model: Gemini 4 Neon (High) | time: 18.4s | ctx: 12.1k (cache 78%) | out: 640 | agy: 5h 61%/wk 68% | session: <id> (use follow_up to continue)
```

---

## 推荐搭配的全局分工规则（`~/.claude/CLAUDE.md`）

建议在 `~/.claude/CLAUDE.md` 中写明精准分工，让主模型积极合作但不滥用 Gemini 额度：

- **积极派给 `gemini` MCP**：
  - 量大管饱的原始阅读（长文档、轨迹文件、海量日志、全仓考古）→ `gemini-4-neon-medium`；
  - 重要方案/Prompt 审校、精细调研报告、未获明确授权的重大决策前讨论 → `gemini-4-neon-high`；
  - 极少数高难度独立深度评估 → 显式指定 `model: "gemini-4-neon-xhigh"`。
- **克制边界（由主模型直接处理）**：
  - 简单的单文件微调、几秒能看清的小范围检索或已有完整上下文的局部修改，不发起额外的 Gemini 调用。
- **新开会话 vs `follow_up`**：
  - 一次性调研和需要防观点锚定漂移的盲审默认新开干净会话；仅针对具体分歧多轮辩论时使用 `follow_up(session_id)`。

---

## 环境变量配置

| 变量                   | 默认值                   | 说明                                                     |
| :--------------------- | :----------------------- | :------------------------------------------------------- |
| `AGY_PATH`             | `agy`                    | `agy` 可执行文件路径                                     |
| `AGY_TIMEOUT`          | 按工具（`120`–`600` 秒） | 全局 `--print-timeout` 覆盖值（秒）                      |
| `AGY_TIMEOUT_<TOOL>`   | 未设置                   | 单工具超时覆盖，如 `AGY_TIMEOUT_DEEP_SEARCH=300`         |
| `AGY_MAX_OUTPUT_CHARS` | `50000`                  | 输出最大字符上限                                         |
| `AGY_DEFAULT_MODEL`    | 未设置                   | 路由链全部不可用时的兜底模型                             |
| `AGY_SKIP_PERMISSIONS` | `true`                   | 是否向 `agy` 传入 `--dangerously-skip-permissions`       |
| `AGY_SANDBOX`          | `false`                  | 是否向 `agy` 传入 `--sandbox`                            |
| `AGY_ON_FAILURE`       | `fallback`               | 设为 `strict` 时，调用失败会提示主模型不要自行接管该任务 |

---

## 本地开发与测试

```bash
npm run format     # prettier 代码格式化
npm run typecheck  # tsc --noEmit 类型检查
npm run build      # tsup + 打包单文件 dist/panel.html
npm test           # vitest 单元测试
```

---

## 致谢与协议

- 基于 [`sshahzaiib/agy-bridge`](https://github.com/sshahzaiib/agy-bridge) 二次开发
- 开源协议：[MIT](./LICENSE)

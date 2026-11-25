import { describe, it, expect } from "vitest";
import { createToolHandler, createWaitHandler } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import { RunTracker } from "../src/telemetry.js";
import type { Config } from "../src/config.js";
import type { ChildHandle, RunnerDeps } from "../src/runner.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

const LISTING =
  "gemini-4-neon-medium\tGemini 4 Neon (Medium)\n" +
  "gemini-4-neon-high\tGemini 4 Neon (High)\n" +
  "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n" +
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";

const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

interface Run {
  args: string[];
}

/**
 * Fake runner deps: `quotaModels` lists models whose runs hit a 429 in the log;
 * everything else answers normally. Records every spawn's args.
 */
function fakeDeps(quotaModels: string[] = []) {
  const runs: Run[] = [];
  let currentQuota = false;

  const deps: RunnerDeps = {
    spawnChild: (_file, args) => {
      runs.push({ args });
      const i = args.indexOf("--model");
      currentQuota = i !== -1 && quotaModels.includes(args[i + 1]);
      const quota = currentQuota;
      const child: ChildHandle = {
        stdout: () => (quota ? "" : "the answer"),
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    },
    readLog: async () => (currentQuota ? LOG_429 : ""),
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-1" }),
    makeLogPath: () => "/tmp/agy-bridge-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, runs, modelOf: (r: Run) => r.args[r.args.indexOf("--model") + 1] };
}

function handlerFor(
  name: string,
  f: ReturnType<typeof fakeDeps>,
  overrides: Partial<Config> = {},
  cooldowns = new CooldownRegistry(),
) {
  return createToolHandler(
    TOOLS.find((t) => t.name === name)!,
    { ...cfg, ...overrides },
    new ModelRegistry(async () => LISTING),
    f.deps,
    cooldowns,
  );
}

describe("createToolHandler", () => {
  it("runs delegate with Neon High by default and appends model + session footer", async () => {
    const f = fakeDeps();
    const res = await handlerFor("delegate", f)({ prompt: "do x" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("the answer");
    expect(text).toContain("Gemini 4 Neon (High)");
    expect(text).toContain("sess-1");
    expect(f.runs[0].args).toContain("--model");
    expect(res.structuredContent).toBeDefined();
  });

  it("routes analyze_files to Neon Medium by default", async () => {
    const f = fakeDeps();
    await handlerFor("analyze_files", f)({ files: ["a.log"], question: "summarize" });
    expect(f.modelOf(f.runs[0])).toBe("Gemini 4 Neon (Medium)");
  });

  it("routes adversarial_review to Neon High by default and allows xhigh override", async () => {
    const f = fakeDeps();
    await handlerFor("adversarial_review", f)({ content: "plan" });
    expect(f.modelOf(f.runs[0])).toBe("Gemini 4 Neon (High)");
    await handlerFor(
      "adversarial_review",
      f,
    )({
      content: "deep plan",
      model: "gemini-4-neon-xhigh",
    });
    expect(f.modelOf(f.runs[1])).toBe("Gemini 4 Neon (XHigh)");
  });

  it("follow_up passes --conversation and no --model", async () => {
    const f = fakeDeps();
    await handlerFor("follow_up", f)({ session_id: "abc", question: "more?" });
    expect(f.runs[0].args).toContain("--conversation");
    expect(f.runs[0].args).toContain("abc");
    expect(f.runs[0].args).not.toContain("--model");
  });

  it("uses the per-tool timeout for --print-timeout", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f)({ query: "docs" });
    const args = f.runs[0].args;
    const tool = TOOLS.find((t) => t.name === "web_lookup")!;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe(`${tool.timeoutSec}s`);
  });

  it("explicit AGY_TIMEOUT overrides per-tool timeouts", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f, { timeoutSec: 900, timeoutExplicit: true })({ query: "q" });
    const args = f.runs[0].args;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("900s");
  });

  it("per-tool AGY_TIMEOUT_<TOOL> overrides only that tool", async () => {
    const f = fakeDeps();
    const cfg = { perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
    // a tool without an override keeps its default
    await handlerFor("web_lookup", f, cfg)({ query: "q" });
    const tool = TOOLS.find((t) => t.name === "web_lookup")!;
    expect(f.runs[1].args[f.runs[1].args.indexOf("--print-timeout") + 1]).toBe(
      `${tool.timeoutSec}s`,
    );
  });

  it("per-tool override wins over explicit global AGY_TIMEOUT", async () => {
    const f = fakeDeps();
    const cfg = { timeoutSec: 900, timeoutExplicit: true, perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
  });

  it("fails over to the next chain model on quota exhaustion", async () => {
    const f = fakeDeps(["Gemini 4 Neon (Medium)"]);
    const res = await handlerFor("web_lookup", f)({ query: "docs" });
    const text = (res.content[0] as { text: string }).text;
    expect(res.isError).toBeUndefined();
    expect(f.runs).toHaveLength(2);
    expect(f.modelOf(f.runs[0])).toBe("Gemini 4 Neon (Medium)");
    expect(f.modelOf(f.runs[1])).toBe("Gemini 4 Neon (High)");
    expect(text).toContain("the answer");
    expect(text).toContain("model: Gemini 4 Neon (High)");
    expect(text).toMatch(/failover.*Gemini 4 Neon \(Medium\).*quota/i);
  });

  it("skips cooled-down models on subsequent calls without spawning them", async () => {
    const f = fakeDeps(["Gemini 4 Neon (Medium)"]);
    const cooldowns = new CooldownRegistry();
    const handler = handlerFor("web_lookup", f, {}, cooldowns);
    await handler({ query: "first" });
    expect(f.runs).toHaveLength(2);
    await handler({ query: "second" });
    expect(f.runs).toHaveLength(3);
    expect(f.modelOf(f.runs[2])).toBe("Gemini 4 Neon (High)");
  });

  it("errors with reset times when every chain model is quota-exhausted", async () => {
    const f = fakeDeps([
      "Gemini 4 Neon (Medium)",
      "Gemini 4 Neon (High)",
      "Gemini 3.8 Flash (High)",
    ]);
    const res = await handlerFor("web_lookup", f)({ query: "docs" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/quota/i);
    expect(text).toContain("Gemini 4 Neon (Medium)");
    expect(text).toContain("Gemini 4 Neon (High)");
    expect(text).toContain("4h24m");
  });

  it("returns isError content on failure instead of throwing", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new Error("kaboom");
    };
    const res = await handlerFor("delegate", f)({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).not.toContain("Do NOT perform this work yourself");
  });

  it("strict mode appends do-not-fallback instruction to errors", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new Error("kaboom");
    };
    const res = await handlerFor("delegate", f, { onFailure: "strict" })({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).toContain("Do NOT perform this work yourself");
  });

  it("forwards the MCP abort signal to the runner", async () => {
    const f = fakeDeps();
    const ac = new AbortController();
    ac.abort();
    const res = await handlerFor("delegate", f)({ prompt: "x" }, { signal: ac.signal });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/cancelled/i);
  });

  it("supports per-call timeout_sec=0 (no time limit)", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f)({ query: "big research", timeout_sec: 0 });
    const args = f.runs[0].args;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("0s");
  });

  it("runs in background mode with unlimited timeout and collects output via gemini_wait", async () => {
    let finishChild!: () => void;
    const runs: Run[] = [];
    const deps: RunnerDeps = {
      spawnChild: (_file, args) => {
        runs.push({ args });
        return {
          stdout: () => "deep research report",
          stderr: () => "",
          wait: () =>
            new Promise((resolve) => {
              finishChild = () => resolve({ code: 0 });
            }),
          kill: () => {},
        };
      },
      readLog: async () => "",
      removeLog: async () => {},
      readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-bg" }),
      makeLogPath: () => "/tmp/agy-bridge-bg.log",
      pollMs: 5,
      graceMs: 20,
      killGraceMs: 5,
    };
    const cooldowns = new CooldownRegistry();
    const tracker = new RunTracker(undefined, "/nonexistent/quota.json", false);
    const delegateHandler = createToolHandler(
      TOOLS.find((t) => t.name === "delegate")!,
      cfg,
      new ModelRegistry(async () => LISTING),
      deps,
      cooldowns,
      tracker,
    );
    const waitHandler = createWaitHandler(cfg, cooldowns, tracker);

    const startRes = await delegateHandler({ prompt: "huge survey", background: true });
    expect(startRes.isError).toBeUndefined();
    const runId = (startRes.structuredContent as { activeRunId: string }).activeRunId;
    expect(runs[0].args[runs[0].args.indexOf("--print-timeout") + 1]).toBe("0s");

    // Instant check while still running returns running status cleanly
    const midRes = await waitHandler({ run_id: runId, wait_sec: 0 });
    expect(midRes.isError).toBeUndefined();
    expect((midRes.content[0] as { text: string }).text).toMatch(/still running/i);

    // Finish background job and collect complete output
    const waitPromise = waitHandler({ run_id: runId, wait_sec: 5 });
    finishChild();
    const doneRes = await waitPromise;
    expect(doneRes.isError).toBeUndefined();
    const doneText = (doneRes.content[0] as { text: string }).text;
    expect(doneText).toContain("deep research report");
    expect(doneText).toContain("sess-bg");
  });
});

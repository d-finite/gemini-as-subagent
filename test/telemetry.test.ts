import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CooldownRegistry } from "../src/quota.js";
import { RunTracker, readAntigravityQuota, readSessionTokens } from "../src/telemetry.js";

describe("telemetry", () => {
  it("parses Antigravity quota-samples.json and merges active cooldowns", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agy-quota-test-"));
    try {
      const qpath = path.join(dir, "quota-samples.json");
      const now = 1_795_606_000_000;
      await writeFile(
        qpath,
        JSON.stringify([
          {
            id: "u@example.com::gemini-weekly",
            resetTimeMs: now + 3 * 86400_000,
            active: true,
            lastAt: now - 10_000,
            checkpoints: [{ atMs: now - 10_000, fraction: 0.6834, observedRequests: 172 }],
          },
          {
            id: "u@example.com::gemini-5h",
            resetTimeMs: now + 3600_000,
            active: true,
            lastAt: now - 5_000,
            checkpoints: [{ atMs: now - 5_000, fraction: 0.619, observedRequests: 44 }],
          },
        ]),
      );
      const cooldowns = new CooldownRegistry(() => now);
      cooldowns.set("Gemini 4 Neon (High)", 300);

      const snap = await readAntigravityQuota(cooldowns, qpath, now);
      expect(snap.sourceAvailable).toBe(true);
      expect(snap.buckets.map((b) => b.window)).toEqual(["5h", "weekly"]);
      expect(snap.buckets[0].remainingPct).toBe(61.9);
      expect(snap.buckets[1].remainingPct).toBe(68.3);
      expect(snap.cooldowns).toHaveLength(1);
      expect(snap.cooldowns[0].model).toBe("Gemini 4 Neon (High)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts context tokens and cache hit rate from agy transcript.jsonl", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agy-brain-test-"));
    try {
      const sid = "sess-abc-123";
      const logDir = path.join(dir, sid, ".system_generated", "logs");
      await mkdir(logDir, { recursive: true });
      await writeFile(
        path.join(logDir, "transcript.jsonl"),
        [
          JSON.stringify({ type: "USER_INPUT", content: "hi" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            model: "gemini-4-neon-high",
            input_tokens: 2000,
            cache_read_tokens: 8000,
            output_tokens: 500,
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            model: "gemini-4-neon-high",
            input_tokens: 3000,
            cache_read_tokens: 17000,
            output_tokens: 700,
          }),
        ].join("\n"),
      );

      const tok = await readSessionTokens(sid, [dir]);
      expect(tok).toBeDefined();
      expect(tok!.contextTokens).toBe(20_000);
      expect(tok!.cacheHitPct).toBe(85);
      expect(tok!.totalOutputTokens).toBe(1200);
      expect(tok!.turns).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tracks run lifecycle and output retrieval", async () => {
    const tracker = new RunTracker(undefined, "/nonexistent/quota.json", false);
    const rec = await tracker.startRun({
      tool: "adversarial_review",
      model: "Gemini 4 Neon (High)",
      cwd: "/repo",
      label: "review proposal",
    });
    expect(rec.status).toBe("running");
    expect(rec.tier).toBe("high");

    await tracker.finishRun(rec.id, {
      status: "done",
      output: "detailed review output",
      sessionId: "s-1",
    });
    const snap = await tracker.getSnapshot();
    expect(snap.activeCount).toBe(0);
    expect(snap.runs[0].status).toBe("done");
    expect(tracker.getFullOutput(rec.id).output).toBe("detailed review output");
  });
});

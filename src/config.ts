export interface Config {
  agyPath: string;
  timeoutSec: number;
  /** True when AGY_TIMEOUT was set explicitly; overrides per-tool timeouts. */
  timeoutExplicit: boolean;
  /**
   * Per-tool timeout overrides from AGY_TIMEOUT_<TOOL_NAME> env vars
   * (e.g. AGY_TIMEOUT_DEEP_SEARCH), keyed by lowercased tool name.
   * Takes precedence over the global AGY_TIMEOUT and the tool's default.
   */
  perToolTimeouts: Record<string, number>;
  maxOutputChars: number;
  defaultModel: string | undefined;
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function loadPerToolTimeouts(env: Record<string, string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    const n = nonNegativeInt(raw);
    if (n !== undefined) out[tool] = n;
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsedTimeout = nonNegativeInt(env.AGY_TIMEOUT);
  return {
    agyPath: env.AGY_PATH || "agy",
    timeoutSec: parsedTimeout !== undefined ? parsedTimeout : 1200,
    timeoutExplicit: parsedTimeout !== undefined,
    perToolTimeouts: loadPerToolTimeouts(env),
    maxOutputChars: positiveInt(env.AGY_MAX_OUTPUT_CHARS, 50_000),
    defaultModel: env.AGY_DEFAULT_MODEL || undefined,
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false",
    sandbox: env.AGY_SANDBOX === "true",
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",
  };
}

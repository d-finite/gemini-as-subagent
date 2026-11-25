import path from "node:path";
import { z } from "zod";

const OUTPUT_RULES =
  "Answer directly in clear, natural human language with no preamble or filler. " +
  "Be thorough and preserve key details, concrete evidence, and exact file:line citations — " +
  "do NOT over-compress or drop important nuances.";

export function resolveFiles(files: string[], cwd: string): string[] {
  return files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)));
}

const commonShape = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to the working directory / project root. Defaults to the server's cwd.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Optional model override from `agy models` (e.g. "gemini-4-neon-medium", ' +
        '"gemini-4-neon-high", "gemini-4-neon-xhigh"). Omit to use the Neon 3-tier default.',
    ),
};

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  /** Default --print-timeout for this tool, in seconds. AGY_TIMEOUT overrides. */
  timeoutSec: number;
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

// Neon-only preference chains (no Hydrogen; Flash only if every Neon tier is unavailable/exhausted).
const NEON_MEDIUM_CHAIN = [
  "Gemini * Neon (Medium)",
  "Gemini * Neon (High)",
  "Gemini * Flash (High)",
];
const NEON_HIGH_CHAIN = [
  "Gemini * Neon (High)",
  "Gemini * Neon (XHigh)",
  "Gemini * Neon (Medium)",
  "Gemini * Flash (High)",
];

export const TOOLS: ToolDef[] = [
  {
    name: "analyze_files",
    description:
      "Delegate heavy file/log/trajectory reading to Gemini (default: Gemini 4 Neon Medium). " +
      "USE THIS for long documents, multiple trajectory files, large logs (>200 lines or >3 files) " +
      "so raw bulk never pollutes Claude's main context — Gemini returns a detailed, plain-language intelligence report.",
    schema: {
      files: z
        .array(z.string())
        .min(1)
        .describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...commonShape,
    },
    chain: NEON_MEDIUM_CHAIN,
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = resolveFiles(args.files as string[], cwd);
      return (
        `Read and analyze these files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
        `Question: ${args.question}\n\n${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "deep_search",
    description:
      "Delegate repository archaeology and broad search to Gemini (default: Gemini 4 Neon Medium): " +
      "git log/diff/blame spelunking, wide repo greps, 'when/why did X change'. " +
      "Skip for trivial local grep; use when broad scanning would bloat Claude's context.",
    schema: {
      query: z
        .string()
        .describe("What to find, e.g. 'when was the auth middleware refactored and why'."),
      ...commonShape,
    },
    chain: NEON_MEDIUM_CHAIN,
    timeoutSec: 180,
    buildPrompt(args) {
      return (
        `Search this repository to answer the following. Use git log, git diff, git blame, ` +
        `and grep as needed.\n\nQuery: ${args.query}\n\n` +
        `Report findings with commit hashes where relevant. ${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "web_lookup",
    description:
      "Delegate web/documentation research to Gemini (default: Gemini 4 Neon Medium): " +
      "library docs, API references, error messages, current versions.",
    schema: {
      query: z.string().describe("What to look up on the web."),
      ...commonShape,
    },
    chain: NEON_MEDIUM_CHAIN,
    timeoutSec: 120,
    buildPrompt(args) {
      return `Look up on the web: ${args.query}\n\nInclude source URLs for key claims. ${OUTPUT_RULES}`;
    },
  },
  {
    name: "adversarial_review",
    description:
      "Get an independent second opinion & adversarial review from Gemini (default: Gemini 4 Neon High; " +
      "pass model='gemini-4-neon-xhigh' only for rare high-stakes deep evaluations). " +
      "USE THIS before major unapproved decisions, after workflow/prompt/proposal changes, or for pre-merge code review.",
    schema: {
      content: z
        .string()
        .optional()
        .describe("Inline content to review (plan, proposal, diff, decision dilemma)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'edge cases', 'tradeoffs'."),
      ...commonShape,
    },
    chain: NEON_HIGH_CHAIN,
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = args.files as string[] | undefined;
      const content = args.content as string | undefined;
      if (!content && !files?.length) {
        throw new Error("adversarial_review requires either `content` or `files`.");
      }
      const subject = content
        ? `Review the following:\n\n${content}`
        : `Read and review these files:\n${resolveFiles(files!, cwd)
            .map((f) => `- ${f}`)
            .join("\n")}`;
      const focus = args.focus ? `\nFocus especially on: ${args.focus}.` : "";
      return (
        `You are an independent collaborative reviewer. Find real flaws: bugs, edge cases, ` +
        `unstated assumptions, missing dimensions, and concrete alternatives.${focus}\n\n${subject}\n\n` +
        `Rank findings by severity (critical/major/minor) and justify each clearly. ` +
        `Do not pad with praise or restate the input. ${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "follow_up",
    description:
      "Continue a previous Gemini temporary session by session_id (returned by every other tool). " +
      "USE THIS for multi-turn discussion with Gemini on a review or investigation without resending context.",
    schema: {
      session_id: z.string().describe("The session id returned by a previous agy-bridge call."),
      question: z.string().describe("The follow-up question or discussion point."),
      ...commonShape,
    },
    chain: [],
    timeoutSec: 300,
    buildPrompt(args) {
      return args.question as string;
    },
  },
  {
    name: "delegate",
    description:
      "Delegate a focused collaborative research, report-drafting, or decision-discussion task to Gemini " +
      "(default: Gemini 4 Neon High; pass model='gemini-4-neon-medium' for high-volume reading, " +
      "or 'gemini-4-neon-xhigh' for rare deep evaluation). agy has full tool access in cwd.",
    schema: {
      prompt: z.string().describe("The complete task prompt for Gemini."),
      ...commonShape,
    },
    chain: NEON_HIGH_CHAIN,
    timeoutSec: 600,
    buildPrompt(args) {
      return args.prompt as string;
    },
  },
];

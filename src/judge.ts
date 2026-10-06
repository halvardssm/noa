import type { ChatFn } from "./router.ts";

/** The tiers a request can be routed to. */
export type Tier = "local1" | "local2" | "local3" | "cloud";

/** The local tiers in escalation order. */
export const LOCAL_TIERS: readonly Tier[] = ["local1", "local2", "local3"];

export function isTier(value: string): value is Tier {
  return (LOCAL_TIERS as readonly string[]).includes(value) || value === "cloud";
}

/** The judge's routing decision. */
export interface Judgment {
  readonly tier: Tier;
  readonly reason: string;
  /** The user's intent, rewritten to be clearer and more complete. */
  readonly improvedPrompt: string;
}

const JUDGE_SYSTEM = `You are the router of a local AI CLI. Classify the user's request and rewrite it.

Tiers (difficulty; each maps to a model the user configured):
- local1: trivial questions, chat, simple lookups, basic arithmetic, formatting.
- local2: moderate tasks: summarizing, explaining, simple code questions.
- local3: demanding but self-contained tasks: multi-step reasoning, code generation and review.
- cloud: heavy reasoning, long or complex code generation, frontier tasks, anything needing broad world knowledge.

Respond with ONLY a JSON object:
{"tier": "local1" | "local2" | "local3" | "cloud", "reason": "one short sentence", "improved_prompt": "the user's intent, rewritten to be clearer and more complete"}

The improved_prompt must preserve the user's intent exactly; never add tasks they did not ask for. If the user asks for an ACTION — to run a command, read a file, list a directory, or fetch a URL — the improved_prompt must request that exact action to be performed, not a description or explanation of it. Preserve exact text the user wants repeated or echoed (e.g. "reply with exactly ...") verbatim.`;

/** Options for {@linkcode judge}. */
export interface JudgeOptions {
  readonly chat: ChatFn;
  readonly system?: string;
}

/**
 * The 3B judges the request: outputs `{tier, reason, improved_prompt}`.
 * On unparseable output it falls back to answering on the 3B with the raw
 * question — the cheapest safe default.
 */
export async function judge(
  question: string,
  options: JudgeOptions,
): Promise<Judgment> {
  const answer = await options.chat(
    [
      { role: "system", content: options.system ?? JUDGE_SYSTEM },
      { role: "user", content: question },
    ],
    { json: true },
  );
  const parsed = extractJson(answer.content);
  if (parsed === null || typeof parsed !== "object") return fallback(question);
  const record = parsed as Record<string, unknown>;
  const tier = typeof record.tier === "string" ? normalizeTier(record.tier) : null;
  const improved = typeof record.improved_prompt === "string" &&
      record.improved_prompt.trim() !== ""
    ? record.improved_prompt
    : question;
  if (tier === null) return fallback(question);
  return {
    tier,
    reason: typeof record.reason === "string" ? record.reason : "",
    improvedPrompt: improved,
  };
}

function fallback(question: string): Judgment {
  return {
    tier: "local1",
    reason: "fallback: judge output was unparseable",
    improvedPrompt: question,
  };
}

function normalizeTier(tier: string): Tier | null {
  if (tier === "mistral" || tier === "claude") return "cloud";
  // Old, model-size-derived names are still accepted as tier aliases.
  if (tier === "local3b") return "local1";
  if (tier === "local8b") return "local2";
  if (tier === "local14b") return "local3";
  return isTier(tier) ? tier : null;
}

/**
 * Extracts a JSON object from model output, tolerating code fences and
 * surrounding prose. Returns `null` when no object is found.
 */
export function extractJson(text: string): unknown {
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const inner = tryParse(text.slice(start, end + 1));
  return inner === undefined ? null : inner;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

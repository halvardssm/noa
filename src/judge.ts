import type { ChatFn } from "./router.ts";
import { dateContextLine } from "./context.ts";

/** A tier name; positional (`local1`..`localN`) or `cloud`. */
export type Tier = string;

/** One local tier as the judge sees it: a name and what its model is for. */
export interface TierInfo {
  readonly name: string;
  readonly description?: string;
}

/** The judge's routing decision. */
export interface Judgment {
  readonly tier: Tier;
  readonly reason: string;
  /** The user's intent, rewritten to be clearer and more complete. */
  readonly improvedPrompt: string;
}

/** The fixed description of the cloud tier. */
const CLOUD_DESCRIPTION =
  "heavy reasoning, long or complex code generation, frontier tasks, anything needing broad world knowledge.";

/** Builds the judge system prompt from the user's tier list. */
export function judgeSystemPrompt(tiers: readonly TierInfo[]): string {
  const lines = tiers.map((tier, index) =>
    `- ${tier.name}: ${tier.description ?? `local tier ${index + 1}`}`
  );
  lines.push(`- cloud: ${CLOUD_DESCRIPTION}`);
  const names = [...tiers.map((tier) => tier.name), "cloud"].join(" | ");
  return `You are the router of a local AI CLI. Classify the user's request and rewrite it.

Tiers (in escalation order; each maps to a model the user configured):
${lines.join("\n")}

Respond with ONLY a JSON object where "tier" is the string "${names.split(" | ")[0]}" — exactly one of these tier names, never a list:
{"tier": "${names}", "reason": "one short sentence", "improved_prompt": "the user's intent, rewritten to be clearer and more complete"}

The improved_prompt must preserve the user's intent exactly; never add tasks they did not ask for. If the user asks for an ACTION — to run a command, read a file, list a directory, or fetch a URL — the improved_prompt must request that exact action to be performed, not a description or explanation of it. Preserve exact text the user wants repeated or echoed (e.g. "reply with exactly ...") verbatim.`;
}

/** Options for {@linkcode judge}. */
export interface JudgeOptions {
  readonly chat: ChatFn;
  /** The configured local tiers, in escalation order. */
  readonly tiers: readonly TierInfo[];
  readonly system?: string;
}

/**
 * The smallest configured model judges the request: outputs
 * `{tier, reason, improved_prompt}`. On unparseable output it falls back to
 * the first tier with the raw question — the cheapest safe default.
 */
export async function judge(
  question: string,
  options: JudgeOptions,
): Promise<Judgment> {
  const fallbackTier = options.tiers[0]?.name ?? "cloud";
  const answer = await options.chat(
    [
      {
        role: "system",
        content: `${options.system ?? judgeSystemPrompt(options.tiers)}\n${dateContextLine()}`,
      },
      { role: "user", content: question },
    ],
    { json: true },
  );
  const parsed = extractJson(answer.content);
  if (parsed === null || typeof parsed !== "object") {
    return fallback(question, fallbackTier);
  }
  const record = parsed as Record<string, unknown>;
  // Small models sometimes emit the tier as a one-element list.
  const tierRaw = Array.isArray(record.tier) &&
      record.tier.length === 1 && typeof record.tier[0] === "string"
    ? record.tier[0]
    : record.tier;
  const tier = typeof tierRaw === "string"
    ? normalizeTier(tierRaw, options.tiers)
    : null;
  const improved = typeof record.improved_prompt === "string" &&
      record.improved_prompt.trim() !== ""
    ? record.improved_prompt
    : question;
  if (tier === null) return fallback(question, fallbackTier);
  return {
    tier,
    reason: typeof record.reason === "string" ? record.reason : "",
    improvedPrompt: improved,
  };
}

function fallback(question: string, tier: string): Judgment {
  return {
    tier,
    reason: "fallback: judge output was unparseable",
    improvedPrompt: question,
  };
}

function normalizeTier(
  tier: string,
  tiers: readonly TierInfo[],
): Tier | null {
  if (tier === "mistral" || tier === "claude") return "cloud";
  // Legacy, model-size-derived names map onto the first three positions.
  const legacy: Record<string, number> = {
    local3b: 0,
    local8b: 1,
    local14b: 2,
  };
  const legacyIndex = legacy[tier];
  if (legacyIndex !== undefined) {
    return tiers[legacyIndex]?.name ?? null;
  }
  return tiers.some((t) => t.name === tier) ? tier : null;
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

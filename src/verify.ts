import type { ChatFn } from "./router.ts";
import { extractJson } from "./judge.ts";

/** The conservative verdict of the cheap verification pass. */
export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

const VERIFY_SYSTEM = `You verify that an answer is acceptable for a question.

Be conservative: answer PASS unless the answer is CLEARLY deficient — wrong, incomplete for what was asked, or off-question. Uncertainty passes. A shorter or differently-worded answer than you would give still passes.

Respond with ONLY a JSON object: {"verdict": "PASS" | "FAIL", "reason": "one short sentence"}`;

/** Options for {@linkcode verify}. */
export interface VerifyOptions {
  readonly chat: ChatFn;
  readonly system?: string;
}

/**
 * The cheap PASS/FAIL pass over a local answer. Biased conservative:
 * uncertainty passes, only a clear deficiency fails.
 */
export async function verify(
  question: string,
  answer: string,
  options: VerifyOptions,
): Promise<Verdict> {
  const result = await options.chat(
    [
      { role: "system", content: options.system ?? VERIFY_SYSTEM },
      {
        role: "user",
        content: `Question: ${question}\n\nAnswer:\n${answer}`,
      },
    ],
    { json: true },
  );
  const parsed = extractJson(result.content);
  if (parsed === null || typeof parsed !== "object") {
    return { pass: true, reason: "verify output unparseable; passing" };
  }
  const verdict = (parsed as Record<string, unknown>).verdict;
  if (verdict === "FAIL") {
    return {
      pass: false,
      reason: typeof (parsed as Record<string, unknown>).reason === "string"
        ? (parsed as Record<string, string>).reason
        : "failed verification",
    };
  }
  return { pass: true, reason: "passed" };
}

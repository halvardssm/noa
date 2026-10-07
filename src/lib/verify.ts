import type { ChatFn } from "./router.ts";
import { extractJson } from "./judge.ts";

/** The conservative verdict of the cheap verification pass. */
export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

const VERIFY_SYSTEM = `You verify that an answer is acceptable for a question.

Be conservative: answer PASS unless the answer is CLEARLY deficient — wrong in a way you can check, incomplete for what was asked, or off-question. The answer satisfies the question when it contains the requested information; differences in wording, format, style, or brevity are not deficiencies. If the user asked to run a command and the answer shows that command's output, that passes. Uncertainty passes.

A FAIL: the answer asks the user for something the agent could have obtained itself — a directory path, a file path, a permission, or a "please provide" of any kind — instead of answering. An answer about the answer ("I cannot list files without knowing the directory") instead of the answer, when the question is concrete, is a FAIL. A pure refusal that leaves a concrete question unanswered is a FAIL.

You have no access to the current date, time, or live machine state, and your training data may be outdated: NEVER reject an answer because a date or other live value does not match what you believe — judge only whether the answer provides the requested kind of information.

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

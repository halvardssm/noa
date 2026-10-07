/**
 * Terminal interaction helpers. In normal use they wrap Deno's built-in
 * `confirm`/`prompt` dialogs. When the test-only `NOA_TEST=1` env var is
 * set, answers are instead consumed from `NOA_TEST_CONFIRM` and
 * `NOA_TEST_TEXT` — comma- and pipe-separated, in call order — so the
 * test suite drives interactive code through the environment without
 * any injected functions. An exhausted queue declines confirms and
 * returns empty text.
 */

/** True when the test suite is driving noa via `NOA_TEST=1`. */
export function isTestMode(): boolean {
  return Deno.env.get("NOA_TEST") === "1";
}

/** Pops the next scripted answer from an env var ("" when exhausted). */
function nextScripted(name: string, separator: string): string {
  const raw = Deno.env.get(name) ?? "";
  const [first, ...rest] = raw.split(separator);
  Deno.env.set(name, rest.join(separator));
  return first?.trim() ?? "";
}

/**
 * Asks a yes/no question on the terminal and returns the answer.
 * The user must type `y` or `yes` (case-insensitive) to confirm;
 * anything else — including an empty line or EOF — declines.
 *
 * @example
 * ```ts
 * import { confirm } from "./terminal.ts";
 *
 * if (confirm("Continue?")) {
 *   console.log("confirmed");
 * }
 * // Continue? [y/N] y
 * // confirmed
 * ```
 */
export function confirm(message: string): boolean {
  if (isTestMode()) {
    return ["y", "yes"].includes(
      nextScripted("NOA_TEST_CONFIRM", ",").toLowerCase(),
    );
  }
  return globalThis.confirm(message);
}

/**
 * Asks a free-text question on the terminal and returns the answer,
 * or null on EOF. Test mode pops from `NOA_TEST_TEXT` (never null).
 *
 * @example
 * ```ts
 * import { askText } from "./terminal.ts";
 *
 * const name = askText("What is your name?");
 * ```
 */
export function askText(message: string): string | null {
  if (isTestMode()) return nextScripted("NOA_TEST_TEXT", "|");
  return globalThis.prompt(message);
}

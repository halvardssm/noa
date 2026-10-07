/**
 * Terminal interaction helpers. In normal use they wrap Deno's built-in
 * `confirm` dialog and the `@std/cli` select prompt. When the test-only
 * `NOA_TEST=1` env var is set, answers are instead consumed from
 * `NOA_TEST_CONFIRM` (comma-separated) and `NOA_TEST_SELECT`
 * (comma-separated indices) — in call order — so the test suite drives
 * interactive code through the environment without any injected
 * functions. An exhausted confirm queue declines; an exhausted or
 * invalid select queue picks the first option.
 */
import { promptSelect } from "@std/cli/unstable-prompt-select";

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
 * Shows a selection menu on the terminal and returns the index of the
 * chosen option, or null when there is no answer (EOF or a
 * non-interactive terminal). In test mode the index is popped from
 * `NOA_TEST_SELECT`; an exhausted or out-of-range queue selects the
 * first option.
 *
 * @example
 * ```ts
 * import { askSelect } from "./terminal.ts";
 *
 * const choice = askSelect("Model setup:", ["default", "empty"]);
 * if (choice === null) Deno.exit(1);
 * ```
 */
export function askSelect(
  message: string,
  values: readonly string[],
): number | null {
  if (isTestMode()) {
    const raw = nextScripted("NOA_TEST_SELECT", ",");
    const index = /^\d+$/.test(raw) ? Number(raw) : 0;
    return index < values.length ? index : 0;
  }
  const chosen = promptSelect(message, [...values]);
  if (chosen === null) return null;
  const index = values.indexOf(chosen);
  return index >= 0 ? index : null;
}

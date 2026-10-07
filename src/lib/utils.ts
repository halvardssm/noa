import {
  type PromptEntryWithValue,
  promptSelect,
  type PromptSelectOptions,
} from "@std/cli/unstable-prompt-select";
import { Spinner } from "@std/cli/unstable-spinner";

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

/** True when the test suite is driving noa via `NOA_TEST=1`. */
export function isTestMode(): boolean {
  return Deno.env.get("NOA_TEST") === "1";
}

/**
 * Whether interactive prompts can be asked: a terminal, or the test
 * suite's hardcoded dialogs. Non-interactive callers skip prompts and
 * print the remedy instead.
 */
export function isInteractive(): boolean {
  return isTestMode() || Deno.stdin.isTerminal();
}

/**
 * A yes/no question. Under `NOA_TEST=1` the answer is hardcoded to
 * `true` — no test values are passed through the environment.
 */
export function confirm(message: string): boolean {
  if (isTestMode()) return true;
  return globalThis.confirm(message);
}

/**
 * A selection menu. Under `NOA_TEST=1` the first option is chosen
 * (hardcoded) — no test values are passed through the environment.
 * Returns undefined when there is no answer (EOF or non-interactive).
 */
export function askSelect<T>(
  message: string,
  values: readonly PromptEntryWithValue<T>[],
  options?: PromptSelectOptions,
): T | undefined {
  if (isTestMode()) return values[0]?.value;
  const chosen = promptSelect(
    message,
    values as unknown as Parameters<typeof promptSelect<T>>[1],
    options,
  ) as PromptEntryWithValue<T> | null;
  return chosen === null ? undefined : chosen.value;
}

/** Whether `path` is `root` itself or inside one of its folders. */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Shows a spinner on stderr while `task` runs. Skipped under `NOA_TEST=1`
 * and when stderr is not a terminal, so pipes and tests stay clean.
 */
export async function withSpinner<T>(
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  if (isTestMode() || !Deno.stderr.isTerminal()) return await task();
  const spinner = new Spinner({ message, output: Deno.stderr });
  spinner.start();
  try {
    return await task();
  } finally {
    spinner.stop();
  }
}

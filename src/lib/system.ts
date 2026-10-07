import { isTestMode } from "./utils.ts";

/**
 * Total system RAM in bytes. Under `NOA_TEST=1` a hardcoded 16 GiB is
 * returned instead of probing the machine.
 */
export function systemTotalMemory(): number | undefined {
  if (isTestMode()) {
    return 16 * 2 ** 30;
  }
  try {
    return Deno.systemMemoryInfo().total;
  } catch {
    return undefined;
  }
}

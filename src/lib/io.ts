import { createApp } from "./orchestrator.ts";
import type { NoaConfig } from "./config.ts";
import { textEncoder } from "./utils.ts";

/**
 * Reads one visible line from stdin (the terminal echoes as the user
 * types). Returns null on EOF.
 */
export async function readLine(): Promise<string | null> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1);
  let line = "";
  while (true) {
    const read = await Deno.stdin.read(buffer);
    if (read === null) return line.trim() === "" ? null : line.trim();
    if (buffer[0] === 10) break;
    line += decoder.decode(buffer);
  }
  return line.trim();
}

/**
 * An interactive session: one question per line, each routed through the
 * cascade independently; `exit`/`quit` or Ctrl-D ends it. Answers go to
 * stdout, routing logs and the prompt to stderr. Per-question errors are
 * reported and the session continues.
 */
export async function runRepl(
  config: NoaConfig,
  flags: {
    model?: string;
    provider?: string;
    allowTools?: string;
    allowPaths?: string;
    noVerify?: boolean;
    debug?: boolean;
  },
): Promise<number> {
  const app = await createApp({
    fileValues: config,
    allowToolsFlag: flags.allowTools,
    allowPathsFlag: flags.allowPaths,
    model: flags.model,
    provider: flags.provider,
    noVerify: flags.noVerify,
  });

  console.info("noa repl — one question per line; exit or Ctrl-D to quit");

  const prompt = textEncoder.encode("> ");

  while (true) {
    Deno.stderr.writeSync(prompt);
    const line = await readLine();
    if (line === null) break;
    if (line === "") continue;
    if (/^(\/?)?(exit|quit)$/i.test(line)) break;
    try {
      console.log(await app.ask(line));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  return 0;
}

export function exitWithError(message: string, exitCode: number = 1): never {
  console.error(message);
  Deno.exit(exitCode);
}

export function exitWithMessage(message: string): never {
  console.info(message);
  Deno.exit(0);
}

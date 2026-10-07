import type { Options } from "@stdx/cli/command";
import { ensureConfigFile, NoaConfig, SUGGESTED_TOOLS } from "../lib/config.ts";
import { ensureDaemon } from "../lib/ollama.ts";
import {
  configureLogging,
  parseLogLevel,
  type LogLevel,
} from "../lib/log.ts";
import { exitWithError } from "../lib/io.ts";

/**
 * The `--start-daemon` flag, declared on every command: ensure the
 * Ollama daemon right after the config file is ensured — starting it in
 * the background when it is not running (idempotent; exit code 2 when
 * ollama is not installed; warns and exits when the desktop app is
 * installed instead). Interactive `noa init` asks before starting the
 * daemon when the flag is not passed.
 */
export const startDaemonOption = {
  startDaemon: {
    type: "boolean",
    description:
      "ensure the Ollama daemon is running before the command runs, starting it in the background when it is not (idempotent; exit code 2 when ollama is not installed; warns to start the desktop app and exits when it is installed instead)",
  },
} as const satisfies Options;

/**
 * The `--log-level` flag, declared on every command: LogTape's level
 * for the run.
 */
export const logLevelOption = {
  logLevel: {
    type: "string",
    description:
      "log verbosity: fatal | error | warning | info | debug | trace (default: info)",
  },
} as const satisfies Options;

/**
 * Configures logging from the flags, before anything logs: the level
 * defaults to `info`, and `--log-level` overrides it.
 */
export async function prepareLogging(
  flags: { logLevel?: string },
): Promise<void> {
  let level: LogLevel = "info";
  if (flags.logLevel !== undefined) {
    try {
      level = parseLogLevel(flags.logLevel);
    } catch (error) {
      exitWithError(error instanceof Error ? error.message : String(error), 2);
    }
  }
  await configureLogging(level);
}

/** Options shared by the single-shot question and the repl. */
export const questionOptions = {
  model: {
    type: "string",
    description:
      "force one model (skips routing, verification, and escalation): an Ollama tag — e.g. ministral-3:3b | ministral-3:8b | ministral-3:14b — or a localN tier; for cloud models, pass --provider",
  },
  provider: {
    type: "string",
    description:
      "cloud provider for --model: mistral | anthropic (uses the provider's default model when --model is unset)",
  },
  allowTools: {
    type: "string",
    description:
      `tool allowlist for this session, comma-separated (example: ${SUGGESTED_TOOLS})`,
  },
  allowPaths: {
    type: "string",
    description: "allowed paths for this session (replaces defaults)",
  },
  noVerify: {
    type: "boolean",
    description: "skip the verification pass",
  },
} as const satisfies Options;

/**
 * Preparation shared by every command: ensures the config file, then —
 * with `--start-daemon` — the Ollama daemon, right after it. Returns
 * the loaded config to continue with, or the command's exit code when
 * preparation failed (`2` when ollama is not installed, `1` otherwise).
 */
export async function prepareCommand(
  flags: { startDaemon?: boolean; logLevel?: string },
): Promise<NoaConfig> {
  await prepareLogging(flags);

  const config = await ensureConfigFile();

  await ensureDaemon(flags.startDaemon);

  return config;
}

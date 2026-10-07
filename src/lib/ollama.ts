import { join } from "@std/path";
import { configDir } from "./config.ts";
import { poll } from "@std/async/poll";
import { Spinner } from "@std/cli/unstable-spinner";
import { exitWithError } from "./io.ts";
import { Ollama } from "ollama";
import { isTestMode } from "./utils.ts";
import { getLogger } from "./log.ts";

/**
 * A client for the local daemon. Constructed per call: ollama-js
 * captures `fetch` when the client is built, so a memoized client
 * would freeze whatever `fetch` was ambient at the first call.
 */
export function getOllama(): Ollama {
  return new Ollama({
    host: Deno.env.get("OLLAMA_HOST") ?? OLLAMA_BASE_URL,
  });
}

const logger = getLogger(["noa", "ollama"]);

/** Where the Ollama daemon listens. */
export const OLLAMA_BASE_URL = "http://localhost:11434";

/** Resolves the daemon base URL: `$OLLAMA_HOST` or the default. */
export function ollamaBaseUrl(): string {
  const host = Deno.env.get("OLLAMA_HOST");
  if (host === undefined || host === "") return OLLAMA_BASE_URL;
  const stripped = host.replace(/\/$/, "");
  return /^https?:\/\//.test(stripped) ? stripped : `http://${stripped}`;
}

/** Whether the Ollama daemon answers at `baseUrl`. */
export async function ollamaIsUp(): Promise<boolean> {
  const ollama = getOllama();

  try {
    await ollama.version();
    return true;
  } catch {
    return false;
  }
}

/** Where an `ollama serve` started by noa logs to. */
export function daemonLogPath(): string {
  return join(configDir(), "ollama-daemon.log");
}

/** Where the Ollama desktop app lives, per OS (empty when it never does). */
function appPaths(): readonly string[] {
  switch (Deno.build.os) {
    case "darwin":
      return ["/Applications/Ollama.app"];
    default:
      return [];
  }
}

/**
 * How ollama is installed: the desktop app (macOS) or the `ollama`
 * executable on PATH. Never spawns anything. Under `NOA_TEST=1` only
 * the PATH scan counts, so tests control the result even on a machine
 * with the app installed.
 */
export function ollamaInstallType(): "app" | "missing" | "binary" {
  if (!isTestMode()) {
    for (const path of appPaths()) {
      try {
        if (Deno.statSync(path).isDirectory) return "app";
      } catch {
        // Keep looking.
      }
    }
  }

  const name = Deno.build.os === "windows" ? "ollama.exe" : "ollama";
  const separator = Deno.build.os === "windows" ? ";" : ":";

  for (const dir of (Deno.env.get("PATH") ?? "").split(separator)) {
    if (dir === "") continue;
    try {
      if (Deno.statSync(join(dir, name)).isFile) return "binary";
    } catch {
      // Keep scanning PATH.
    }
  }
  return "missing";
}

/** Single-quotes a path for a POSIX shell command. */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Polls the daemon until it answers, or about 10 seconds pass.
 * `poll` is aborted by a timeout signal, so the deadline is not
 * hand-rolled.
 */
async function pollUntilUp(): Promise<boolean> {
  try {
    await poll(() => ollamaIsUp(), (up) => up, {
      interval: 250,
      signal: AbortSignal.timeout(10_000),
    });
    return true;
  } catch {
    // The timeout signal aborted the poll.
    return false;
  }
}

/**
 * Starts the daemon in the background as a detached `ollama serve`
 * (rule 6: only at an explicit user action — the `--start-daemon` flag
 * or the interactive confirm in `noa init`; the model can never cause
 * it). The output is redirected to the config dir via a shell —
 * `Deno.Command` cannot hand a file to a child, and the child must
 * outlive noa. The memory cap is injected into the child environment
 * so it applies from the first start. While polling, a loader
 * (Spinner from @std/cli) is shown; when the daemon never answers or
 * the start fails, an error is printed and noa exits with code 1.
 * Under `NOA_TEST=1` nothing is spawned or rendered — the poll still
 * runs so a scripted stub can bring the daemon up, and failures
 * return false instead of exiting.
 */
async function startDaemon(): Promise<boolean> {
  if (isTestMode()) return await pollUntilUp();

  const logPath = daemonLogPath();

  const spinner = new Spinner({ message: "starting \`ollama serve\`" });
  spinner.start();

  try {
    const child = new Deno.Command("/bin/sh", {
      args: [
        "-c",
        `exec ollama serve >> ${shellQuote(logPath)} 2>&1`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: {
        OLLAMA_MAX_LOADED_MODELS: "2",
        OLLAMA_KEEP_ALIVE: "5m",
      },
    }).spawn();
    child.status.catch(() => {});
  } catch (error) {
    spinner.stop();

    console.error(
      `could not start \`ollama serve\`: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    Deno.exit(1);
  }

  if (await pollUntilUp()) {
    spinner.stop();

    logger.info("Ollama is up");

    return true;
  }

  spinner.stop();

  console.error(
    `Ollama did not start within 10s — check the log at ${logPath}`,
  );

  Deno.exit(1);
}

/**
 * Makes sure the Ollama daemon is running. Idempotent: an answering
 * daemon is a no-op. When it is down, how ollama is installed decides:
 * the desktop app means a warning — noa never launches the app, the
 * user must start it; a binary on PATH means noa starts `ollama serve`
 * and polls until it answers (about 20s); nothing installed means
 * nothing is attempted.
 */
export async function ensureDaemon(
  canStartDaemon: boolean = false,
): Promise<void> {
  if (await ollamaIsUp()) {
    logger.info("Ollama is up");
    return;
  }

  if (!canStartDaemon) {
    exitWithError(
      "Ollama is not running, please provide the flag --start-daemon or start ollama yourself",
    );
  }

  if (Deno.build.os === "windows") {
    exitWithError(
      "starting the daemon is not supported on Windows — run `ollama serve` yourself",
    );
  }

  const installType = ollamaInstallType();

  if (installType === "app") {
    exitWithError(
      "the Ollama desktop app is installed but not running — start the app, then rerun noa",
    );
  }

  if (installType === "missing") {
    exitWithError(
      "Ollama is not installed — brew install ollama, then rerun noa",
      2,
    );
  }

  await startDaemon();
}

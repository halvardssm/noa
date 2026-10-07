import { defineCommand, runCommand, UsageError } from "@stdx/cli";
import { promptSecret } from "@std/cli/prompt-secret";
import {
  configPath,
  ensureConfig,
  isSecretKey,
  legacyEnvPath,
  loadConfig,
  maskValue,
  setConfigValue,
  SUGGESTED_TOOLS,
  unsetConfigValue,
} from "./config.ts";
import { createApp } from "./app.ts";
import { runSetup, type SetupInteract } from "./setup.ts";

const VERSION = "0.1.0";

/**
 * Reads one visible line from stdin (the terminal echoes as the user
 * types). Returns null on EOF.
 */
async function readLine(): Promise<string | null> {
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

/** Terminal-backed setup interaction. */
const terminalInteract: SetupInteract = {
  confirm: async (message) => {
    const answer = await promptSecret(`${message} [y/N]`) ?? "";
    return /^(y|yes)$/i.test(answer.trim());
  },
  secret: async (message) => promptSecret(message),
  text: async (message) => {
    console.error(message);
    return await readLine() ?? "";
  },
};

const setup = defineCommand({
  name: "setup",
  description: "Interactive first-time setup (models, memory cap)",
  async run(context) {
    if (!Deno.stdin.isTerminal()) {
      throw new UsageError(
        "noa setup is interactive — run it in a terminal (or pull models directly: ollama pull ministral-3:3b)",
      );
    }
    const code = await runSetup({
      env: Deno.env,
      interact: terminalInteract,
      out: (line) => context.stdout(line),
    });
    return code;
  },
});

const configSet = defineCommand({
  name: "set",
  description: "Write a setting to ~/.config/noa/.env",
  args: [
    { name: "key", required: true, description: "the setting name" },
    { name: "value", description: "the value (prompted hidden when omitted)" },
  ],
  async run(context) {
    const key = context.args.key;
    let value = context.args.value;
    if (value === undefined) {
      if (!Deno.stdin.isTerminal()) {
        throw new UsageError(
          `pass the value: noa config set ${key} <value> (or run it in a terminal to be prompted)`,
        );
      }
      value = await promptSecret(`Value for ${key}:`) ?? "";
    }
    await setConfigValue(configPath(Deno.env), key, value);
    context.stderr(`set ${key}`);
  },
});

const configGet = defineCommand({
  name: "get",
  description: "Print a setting (secrets masked unless --show)",
  options: { show: { type: "boolean", description: "reveal secrets" } },
  args: [{ name: "key", required: true }],
  async run(context) {
    const config = await loadConfig(configPath(Deno.env));
    const key = context.args.key;
    const value = config[key];
    if (typeof value !== "string") {
      context.stderr(`${key} is not set`);
      return 1;
    }
    context.stdout(maskValue(key, value, context.flags.show));
  },
});

const configList = defineCommand({
  name: "list",
  description: "List all settings (values masked)",
  options: { show: { type: "boolean", description: "reveal secrets" } },
  async run(context) {
    const config = await loadConfig(configPath(Deno.env));
    for (const [key, value] of Object.entries(config)) {
      if (Array.isArray(value)) {
        context.stdout(`${key}=${JSON.stringify(value)}`);
        continue;
      }
      context.stdout(
        `${key}=${maskValue(key, String(value), context.flags.show)}`,
      );
    }
  },
});

const configUnset = defineCommand({
  name: "unset",
  description: "Remove a setting",
  args: [{ name: "key", required: true }],
  async run(context) {
    const removed = await unsetConfigValue(
      configPath(Deno.env),
      context.args.key,
    );
    context.stderr(
      removed ? `unset ${context.args.key}` : `${context.args.key} was not set`,
    );
  },
});

const config = defineCommand({
  name: "config",
  description: "Manage settings in ~/.config/noa/config.json",
  commands: [configSet, configGet, configList, configUnset],
});

/** Options shared by the single-shot question and the repl. */
const questionOptions = {
  model: {
    type: "string" as const,
    description:
      "force one model (skips routing, verification, and escalation): an Ollama tag — e.g. ministral-3:3b | ministral-3:8b | ministral-3:14b — or a localN tier; for cloud models, pass --provider",
  },
  provider: {
    type: "string" as const,
    description:
      "cloud provider for --model: mistral | anthropic (uses the provider's default model when --model is unset)",
  },
  allowTools: {
    type: "string" as const,
    description:
      `tool allowlist for this session, comma-separated (example: ${SUGGESTED_TOOLS})`,
  },
  allowPaths: {
    type: "string" as const,
    description: "allowed paths for this session (replaces defaults)",
  },
  noVerify: { type: "boolean" as const, description: "skip the verification pass" },
  debug: {
    type: "boolean" as const,
    description:
      "log routing decisions, tool runs, verification, and hints to stderr",
  },
};

/**
 * An interactive session: one question per line, each routed through the
 * cascade independently; `exit`/`quit` or Ctrl-D ends it. Answers go to
 * stdout, routing logs and the prompt to stderr. Per-question errors are
 * reported and the session continues.
 */
async function runRepl(
  flags: {
    model?: string;
    provider?: string;
    allowTools?: string;
    allowPaths?: string;
    noVerify?: boolean;
    debug?: boolean;
  },
  stderrLine: (message: string) => void,
  stdout: (line: string) => void,
): Promise<number> {
  await ensureConfig(configPath(Deno.env), legacyEnvPath(Deno.env));
  const config = await loadConfig(configPath(Deno.env));
  const debugLog = flags.debug === true ? stderrLine : () => {};
  const app = await createApp({
    env: Deno.env,
    fileValues: config,
    allowToolsFlag: flags.allowTools,
    allowPathsFlag: flags.allowPaths,
    model: flags.model,
    provider: flags.provider,
    noVerify: flags.noVerify,
    approveRm: interactiveRmApproval,
    onLog: debugLog,
  });
  stderrLine("noa repl — one question per line; exit or Ctrl-D to quit");
  const prompt = new TextEncoder().encode("> ");
  while (true) {
    Deno.stderr.writeSync(prompt);
    const line = await readLine();
    if (line === null) break;
    if (line === "") continue;
    if (/^(\/?)?(exit|quit)$/i.test(line)) break;
    try {
      stdout(await app.ask(line));
    } catch (error) {
      stderrLine(error instanceof Error ? error.message : String(error));
    }
  }
  return 0;
}

const repl = defineCommand({
  name: "repl",
  description: "Interactive session: one question per line",
  options: questionOptions,
  async run(context) {
    return await runRepl(
      context.flags,
      (message) => context.stderr(message),
      (line) => context.stdout(line),
    );
  },
});

const root = defineCommand({
  name: "noa",
  version: VERSION,
  description:
    "Local-first AI CLI: the smallest sufficient model answers. Bare `noa` starts an interactive session.",
  options: {
    prompt: {
      type: "string",
      alias: "p",
      description: "your question — routed through the model cascade",
    },
    ...questionOptions,
  },
  commands: [config, setup, repl],
  async run(context) {
    const stderrLine = (message: string) => context.stderr(message);
    const question = (context.flags.prompt ?? "").trim();
    if (question === "") {
      return await runRepl(
        context.flags,
        stderrLine,
        (line) => context.stdout(line),
      );
    }
    await ensureConfig(configPath(Deno.env), legacyEnvPath(Deno.env));
    const config = await loadConfig(configPath(Deno.env));
    const app = await createApp({
      env: Deno.env,
      fileValues: config,
      allowToolsFlag: context.flags.allowTools,
      allowPathsFlag: context.flags.allowPaths,
      model: context.flags.model,
      provider: context.flags.provider,
      noVerify: context.flags.noVerify,
      approveRm: interactiveRmApproval,
      onLog: context.flags.debug === true ? stderrLine : () => {},
    });
    const answer = await app.ask(question);
    context.stdout(answer);
  },
});

/**
 * Interactive `rm` approval (security rule 4): the exact command must be
 * retyped; anything else — including "y" — rejects. Non-interactive stdin
 * can never approve.
 */
async function interactiveRmApproval(
  command: string,
  args: readonly string[],
): Promise<boolean> {
  if (!Deno.stdin.isTerminal()) return false;
  const full = [command, ...args].join(" ");
  const typed = await promptSecret(`To approve, retype exactly: ${full}`) ?? "";
  return typed.trim() === full;
}

if (import.meta.main) {
  try {
    Deno.exit(await runCommand(root, Deno.args));
  } catch (error) {
    // Anything thrown out of a command: a clear message, never a stack trace.
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );
    Deno.exit(1);
  }
}

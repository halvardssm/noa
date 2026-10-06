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

/** Reads one visible line from stdin (the terminal echoes as the user types). */
async function readLine(): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1);
  let line = "";
  while (true) {
    const read = await Deno.stdin.read(buffer);
    if (read === null) break;
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
    return await readLine();
  },
};

const setup = defineCommand({
  name: "setup",
  description: "Interactive first-time setup (models, memory cap, API keys)",
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
    const removed = await unsetConfigValue(configPath(Deno.env), context.args.key);
    context.stderr(
      removed ? `unset ${context.args.key}` : `${context.args.key} was not set`,
    );
  },
});

const config = defineCommand({
  name: "config",
  description: "Manage settings in ~/.config/noa/.env",
  commands: [configSet, configGet, configList, configUnset],
});

const root = defineCommand({
  name: "noa",
  version: VERSION,
  description:
    "Local-first AI CLI: the smallest sufficient model answers. (Also: noa setup, noa config ...)",
  options: {
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
        `tool allowlist for this invocation, comma-separated (example: ${SUGGESTED_TOOLS})`,
    },
    allowPaths: {
      type: "string",
      description: "allowed paths for this invocation (replaces defaults)",
    },
    noVerify: { type: "boolean", description: "skip the verification pass" },
    tools: { type: "boolean", description: "list permitted tools and exit" },
  },
  args: [{ name: "question", variadic: true, description: "your question" }],
  helpOnEmpty: true,
  async run(context) {
    const stderrLine = (message: string) => context.stderr(message);
    await ensureConfig(configPath(Deno.env), legacyEnvPath(Deno.env));
    const config = await loadConfig(configPath(Deno.env));

    if (context.flags.tools) {
      const app = await createApp({
        env: Deno.env,
        fileValues: config,
        allowToolsFlag: context.flags.allowTools,
        onLog: () => {},
      });
      if (app.allowTools.length === 0) {
        context.stderr(
          `no tools are allowed — pass --allow-tools or set NOA_TOOLS (example: --allow-tools ${SUGGESTED_TOOLS})`,
        );
        return;
      }
      context.stdout(app.allowTools.join("\n"));
      return;
    }

    const question = (context.args.question ?? []).join(" ").trim();
    if (question === "") {
      throw new UsageError("pass a question: noa <question>");
    }

    const app = await createApp({
      env: Deno.env,
      fileValues: config,
      allowToolsFlag: context.flags.allowTools,
      allowPathsFlag: context.flags.allowPaths,
      model: context.flags.model,
      provider: context.flags.provider,
      noVerify: context.flags.noVerify,
      approveRm: interactiveRmApproval,
      onLog: stderrLine,
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
    // The root command takes the question as variadic args, so `config`
    // is dispatched by hand before the root sees it.
    const args = Deno.args;
    const code = args[0] === "config"
      ? await runCommand(config, args.slice(1))
      : args[0] === "setup"
      ? await runCommand(setup, args.slice(1))
      : await runCommand(root, args);
    Deno.exit(code);
  } catch (error) {
    // Anything thrown out of a command: a clear message, never a stack trace.
    Deno.stderr.writeSync(
      new TextEncoder().encode(`${error instanceof Error ? error.message : String(error)}\n`),
    );
    Deno.exit(1);
  }
}

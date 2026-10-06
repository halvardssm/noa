import { defineCommand, runCommand, UsageError } from "@stdx/cli";
import { promptSecret } from "@std/cli/prompt-secret";
import {
  configEnvPath,
  isSecretKey,
  loadEnvFile,
  maskValue,
  setEnvValue,
  SUGGESTED_TOOLS,
  unsetEnvValue,
} from "./config.ts";
import { createApp } from "./app.ts";

const VERSION = "0.1.0";

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
    await setEnvValue(configEnvPath(Deno.env), key, value);
    context.stderr(`set ${key}`);
  },
});

const configGet = defineCommand({
  name: "get",
  description: "Print a setting (secrets masked unless --show)",
  options: { show: { type: "boolean", description: "reveal secrets" } },
  args: [{ name: "key", required: true }],
  async run(context) {
    const values = await loadEnvFile(configEnvPath(Deno.env));
    const key = context.args.key;
    if (!(key in values)) {
      context.stderr(`${key} is not set`);
      return 1;
    }
    context.stdout(maskValue(key, values[key], context.flags.show));
  },
});

const configList = defineCommand({
  name: "list",
  description: "List all settings (values masked)",
  options: { show: { type: "boolean", description: "reveal secrets" } },
  async run(context) {
    const values = await loadEnvFile(configEnvPath(Deno.env));
    for (const [key, value] of Object.entries(values)) {
      context.stdout(`${key}=${maskValue(key, value, context.flags.show)}`);
    }
  },
});

const configUnset = defineCommand({
  name: "unset",
  description: "Remove a setting",
  args: [{ name: "key", required: true }],
  async run(context) {
    const removed = await unsetEnvValue(configEnvPath(Deno.env), context.args.key);
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
  description: "Local-first AI CLI: the smallest sufficient model answers.",
  options: {
    model: {
      type: "string",
      description: "force a tier: local3b | local8b | local14b | mistral",
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
    const values = await loadEnvFile(configEnvPath(Deno.env));

    if (context.flags.tools) {
      const app = await createApp({
        env: Deno.env,
        fileValues: values,
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
      fileValues: values,
      allowToolsFlag: context.flags.allowTools,
      allowPathsFlag: context.flags.allowPaths,
      model: context.flags.model,
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

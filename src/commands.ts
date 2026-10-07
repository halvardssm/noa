import { defineCommand, UsageError } from "@stdx/cli/command";
import denoConfig from "../deno.json" with { type: "json" };
import { promptSecret } from "@std/cli/prompt-secret";
import { createApp } from "./app.ts";
import {
  configPath,
  ensureConfig,
  legacyEnvPath,
  loadConfig,
  maskValue,
  setConfigValue,
  SUGGESTED_TOOLS,
  unsetConfigValue,
} from "./config.ts";
import { runRepl } from "./lib/io.ts";
import { runInit } from "./init.ts";

const init = defineCommand({
  name: "init",
  description:
    "Interactive first-time init: pick the model cascade (default or empty) and the memory cap",
  options: {
    empty: {
      type: "boolean",
      description:
        "write an empty models list without any model prompts — fill config.json yourself",
    },
  },
  async run(context) {
    if (!Deno.stdin.isTerminal()) {
      throw new UsageError(
        "noa init is interactive — run it in a terminal (or pull models directly: ollama pull ministral-3:3b)",
      );
    }
    return await runInit({ empty: context.flags.empty === true });
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
    await setConfigValue(configPath(), key, value);
    context.stderr(`set ${key}`);
  },
});

const configGet = defineCommand({
  name: "get",
  description: "Print a setting (secrets masked unless --show)",
  options: { show: { type: "boolean", description: "reveal secrets" } },
  args: [{ name: "key", required: true }],
  async run(context) {
    const config = await loadConfig(configPath());
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
    const config = await loadConfig(configPath());
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
      configPath(),
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
  noVerify: {
    type: "boolean" as const,
    description: "skip the verification pass",
  },
  debug: {
    type: "boolean" as const,
    description:
      "log routing decisions, tool runs, verification, and hints to stderr",
  },
};

const repl = defineCommand({
  name: "repl",
  description: "Interactive session: one question per line",
  options: questionOptions,
  async run(context) {
    return await runRepl(context.flags);
  },
});

export const rootCommand = defineCommand({
  name: "noa",
  version: denoConfig.version,
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
  commands: [config, init, repl],
  async run(context) {
    const question = (context.flags.prompt ?? "").trim();
    if (question === "") {
      return await runRepl(context.flags);
    }
    await ensureConfig(configPath(), legacyEnvPath());
    const config = await loadConfig(configPath());
    const app = await createApp({
      fileValues: config,
      allowToolsFlag: context.flags.allowTools,
      allowPathsFlag: context.flags.allowPaths,
      model: context.flags.model,
      provider: context.flags.provider,
      noVerify: context.flags.noVerify,
      debug: context.flags.debug === true,
    });
    const answer = await app.ask(question);
    console.log(answer);
  },
});

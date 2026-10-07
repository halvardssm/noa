import { defineCommand } from "@stdx/cli/command";
import denoConfig from "../../deno.json" with { type: "json" };
import { createApp } from "../lib/orchestrator.ts";
import { runRepl } from "../lib/io.ts";
import {
  logLevelOption,
  prepareCommand,
  questionOptions,
  startDaemonOption,
} from "./_shared.ts";
import { initCommand } from "./init.ts";
import { replCommand } from "./repl.ts";
import { syncCommand } from "./sync.ts";

export const rootCommand = defineCommand({
  name: "noa",
  version: denoConfig.version,
  description:
    "Local-first AI CLI: the smallest sufficient model answers. Bare `noa` starts an interactive session.",
  options: {
    ...questionOptions,
    ...startDaemonOption,
    ...logLevelOption,
    prompt: {
      type: "string",
      alias: "p",
      description: "your prompt — routed through the model cascade",
    },
  },
  commands: [initCommand, replCommand, syncCommand],
  async run(context) {
    const config = await prepareCommand(context.flags);
    if (typeof config === "number") return config;

    const prompt = (context.flags.prompt ?? "").trim();

    if (prompt === "") {
      return await runRepl(config, context.flags);
    }

    const app = await createApp({
      fileValues: config,
      allowToolsFlag: context.flags.allowTools,
      allowPathsFlag: context.flags.allowPaths,
      model: context.flags.model,
      provider: context.flags.provider,
      noVerify: context.flags.noVerify,
    });

    const output = await app.ask(prompt);

    console.info(output);
  },
});

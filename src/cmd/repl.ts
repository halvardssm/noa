import { defineCommand } from "@stdx/cli/command";
import { runRepl } from "../lib/io.ts";
import {
  logLevelOption,
  prepareCommand,
  questionOptions,
  startDaemonOption,
} from "./_shared.ts";

export const replCommand = defineCommand({
  name: "repl",
  description: "Interactive session: one question per line",
  options: { ...questionOptions, ...startDaemonOption, ...logLevelOption },
  async run(context) {
    const config = await prepareCommand(context.flags);
    if (typeof config === "number") return config;
    return await runRepl(config, context.flags);
  },
});

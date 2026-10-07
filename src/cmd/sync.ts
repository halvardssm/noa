import { defineCommand } from "@stdx/cli/command";
import {
  logLevelOption,
  prepareLogging,
  startDaemonOption,
} from "./_shared.ts";
import { getConfigFile } from "../lib/config.ts";
import { ensureDaemon } from "../lib/ollama.ts";
import { pullModel, pullModels } from "../lib/models.ts";

export const syncCommand = defineCommand({
  name: "sync",
  description:
    "Reads the config file and downloads the ollama models. No guards in place for free storage space or RAM requirements",
  options: { ...logLevelOption, ...startDaemonOption },
  async run(context) {
    await prepareLogging(context.flags);

    await ensureDaemon(context.flags.startDaemon);

    const configFile = await getConfigFile();

    const models = configFile.rules
      .filter((r) => r.provider === "ollama")
      .map((r) => r.model);

    await pullModels(models);
  },
});

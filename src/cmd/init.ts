import { defineCommand } from "@stdx/cli/command";
import { logLevelOption, prepareLogging, startDaemonOption } from "./_shared.ts";
import { ensureDaemon } from "../lib/ollama.ts";
import {
  configFilePath,
  defaultConfig,
  loadConfigFile,
  writeConfigFile,
} from "../lib/config.ts";
import { exitWithError, exitWithMessage } from "../lib/io.ts";
import { getLogger } from "../lib/log.ts";

const logger = getLogger(["noa", "init"]);
import { systemTotalMemory } from "../lib/system.ts";
import { pullModels } from "../lib/models.ts";
import { defaultModelsFor } from "../lib/data.ts";
import { askSelect, confirm, isInteractive } from "../lib/utils.ts";

export const initCommand = defineCommand({
  name: "init",
  description:
    "Interactive first-time init: pick the model cascade (default or empty) and the memory cap",
  options: {
    ...startDaemonOption,
    ...logLevelOption,
    empty: {
      type: "boolean",
      description:
        "write an empty models list without any model prompts — fill config.json yourself",
    },
  },
  async run(context) {
    await prepareLogging(context.flags);

    await ensureDaemon(context.flags.startDaemon);

    return await runInit({ flags: context.flags });
  },
});

/** Options of {@linkcode runInit}. */
export interface InitOptions {
  flags: {
    empty: boolean;
    startDaemon: boolean;
  };
}

export async function runInit({ flags }: InitOptions): Promise<void> {
  if (!isInteractive()) {
    exitWithError(
      "the model menu needs a terminal — run noa init in a terminal, or pass --empty to write an empty models list",
    );
  }

  const path = configFilePath();

  const configFile = await loadConfigFile(path).catch(() => undefined);

  if (configFile) {
    const res = confirm(
      `config file already exists at ${path}, do you want to override it?`,
    );

    if (!res) {
      exitWithMessage("skipping init");
    }
  }

  if (flags.empty) {
    // No pulls and no daemon needed: just write the empty list.
    await writeEmptyConfigFileAndExit(path);
  }

  await ensureDaemon(flags.startDaemon);

  const choice = askSelect(
    "Select your setup:",
    [
      {
        value: 0,
        label:
          "Default cascade (ministral-3: 3b, 8b, 14b — with a systems check)",
      },
      { value: 1, label: "Empty models list (fill config.json yourself)" },
    ],
    { clear: true },
  );

  if (choice === 1) {
    await writeEmptyConfigFileAndExit(path);
  } else if (choice === 0) {
    // The confirm above (when a file exists) says "override": write the
    // default cascade, replacing whatever was there.
    await writeConfigFile(path, defaultConfig());
    logger.info(`config file written to ${path}`);
  } else {
    exitWithError("no selection — rerun noa init");
  }

  const totalMemory = systemTotalMemory();

  if (!totalMemory) {
    const choice = confirm(
      "Could not determine system memory, do you still want to download all the default models?",
    );

    if (!choice) {
      exitWithMessage(
        `adjust your config file at ${path} and download the models using 'noa sync'`,
      );
    }
  }

  // `systemTotalMemory` returns bytes; the systems check compares GB.
  // Unknown memory with a confirmed download means: offer everything.
  const totalGb = totalMemory === undefined ? Infinity : totalMemory / 2 ** 30;
  const filteredModels = defaultModelsFor(totalGb).map((m) => m.model);

  await pullModels(filteredModels);
}

async function writeEmptyConfigFileAndExit(path: string): Promise<never> {
  await writeConfigFile(path, { rules: [] });
  exitWithMessage(`wrote empty config file to ${path}`);
}

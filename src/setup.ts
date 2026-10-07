import { ollamaBaseUrl, ollamaIsUp } from "./ollama.ts";
import {
  configPath,
  DEFAULT_MODELS,
  ModelEntry,
  writeModels,
} from "./config.ts";
import { askText, confirm, isTestMode } from "./terminal.ts";

/** A default-cascade model and how much RAM it needs to be comfortable. */
interface DefaultModelSpec {
  readonly entry: ModelEntry;
  /** Total system RAM this model should run in, in GiB. */
  readonly minRamGb: number;
  readonly sizeGb: string;
}

/** The default cascade with the RAM heuristics the systems check uses. */
const DEFAULT_MODEL_SPECS: readonly DefaultModelSpec[] = [
  {
    entry: DEFAULT_MODELS[0],
    minRamGb: 6,
    sizeGb: "3.0GB",
  },
  {
    entry: DEFAULT_MODELS[1],
    minRamGb: 12,
    sizeGb: "6.0GB",
  },
  {
    entry: DEFAULT_MODELS[2],
    minRamGb: 24,
    sizeGb: "9.1GB",
  },
];

/** Which default models a system with `totalGb` of RAM can handle. */
export function defaultModelsFor(totalGb: number): readonly DefaultModelSpec[] {
  return DEFAULT_MODEL_SPECS.filter((spec) => totalGb >= spec.minRamGb);
}

async function pullModel(model: string, baseUrl: string): Promise<void> {
  console.log(`pulling ${model} (this can take a while)...`);
  const response = await fetch(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`Ollama pull ${model}: HTTP ${response.status}`);
  }
  console.log(`pulled ${model}`);
}

/**
 * Interactive first-time setup. Every step is behind an explicit yes/no or
 * a typed answer: daemon check, model setup (default with a systems check,
 * or a custom ordered list with per-model descriptions), shell-profile env
 * persistence for the memory cap. Setup talks to the Ollama daemon over
 * HTTP only — noa never spawns anything (rule 6). Under `NOA_TEST=1` the
 * prompts come from `NOA_TEST_CONFIRM`/`NOA_TEST_TEXT` and the systems
 * check reads `NOA_TEST_RAM_GB`.
 */
export async function runSetup(): Promise<number> {
  const baseUrl = ollamaBaseUrl();

  if (!await ollamaIsUp(baseUrl)) {
    console.log(
      "Ollama is not running — install it (brew install ollama) and start it with `ollama serve`, then rerun noa setup",
    );
    return 1;
  }
  console.log(`Ollama is up at ${baseUrl}`);

  const models = confirm("Use the default model setup (ministral-3 cascade)?")
    ? await defaultSetup()
    : await customSetup();
  if (models === null) return 1;

  await writeModels(configPath(), models);

  const home = Deno.env.get("HOME");
  if (home !== undefined) {
    const profile = profilePathFor(Deno.env.get("SHELL"), home);
    const message =
      `Persist the memory cap in ${profile} (export OLLAMA_MAX_LOADED_MODELS=2, OLLAMA_KEEP_ALIVE=5m)? Restart Ollama afterwards for it to apply.`;
    if (confirm(message)) {
      let text = "";
      try {
        text = await Deno.readTextFile(profile);
      } catch {
        // Missing profile: create it.
      }
      try {
        await Deno.writeTextFile(
          profile,
          appendEnvExports(text, OLLAMA_ENV_EXPORTS),
        );
        console.log(`wrote the memory cap to ${profile}`);
      } catch {
        console.log(
          `cannot write ${profile} — add these lines yourself:`,
        );
        for (const [name, value] of Object.entries(OLLAMA_ENV_EXPORTS)) {
          console.log(`  export ${name}=${value}`);
        }
      }
    }
  }

  // API keys are never stored: they are read from the environment at
  // request time and attached directly to the provider request.
  console.log(
    "cloud API keys come from your shell environment — export MISTRAL_API_KEY and/or ANTHROPIC_API_KEY to enable cloud tiers",
  );

  console.log("setup complete — try: noa what is 2+2");
  return 0;
}

/** The default setup: systems check, then only the models it can handle. */
async function defaultSetup(): Promise<ModelEntry[] | null> {
  const memory = memoryInfo();
  const totalGb = memory === null ? null : memory.total / 2 ** 30;
  if (totalGb === null) {
    console.log("could not read system memory — offering every default model");
  } else {
    console.log(`systems check: ${Math.round(totalGb)} GB of RAM`);
  }

  const candidates = totalGb === null
    ? DEFAULT_MODEL_SPECS
    : defaultModelsFor(totalGb);
  const skipped = DEFAULT_MODEL_SPECS.filter((spec) =>
    !candidates.includes(spec)
  );
  if (candidates.length > 0) {
    console.log(
      `the models this system can handle: ${
        candidates.map((s) => `${s.entry.model} (${s.sizeGb})`).join(", ")
      }`,
    );
  }
  if (skipped.length > 0) {
    console.log(
      `skipping (needs more RAM): ${
        skipped.map((s) => `${s.entry.model} (>=${s.minRamGb} GB)`).join(", ")
      }`,
    );
  }

  if (candidates.length === 0) {
    console.log("this system cannot comfortably run any default model");
    return [];
  }

  // One confirmation for the whole set; the user already chose the default
  // cascade. Declining only skips the downloads — the cascade is still
  // configured, and already-pulled models just verify quickly.
  if (!confirm(`Download all of them? (already-pulled models verify quickly)`)) {
    console.log(
      "skipped downloads — the default cascade is configured; pull later with `ollama pull <model>`",
    );
    return candidates.map((spec) => spec.entry);
  }
  for (const spec of candidates) {
    try {
      await pullModel(spec.entry.model, ollamaBaseUrl());
    } catch (error) {
      console.log(
        `could not pull ${spec.entry.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
  return candidates.map((spec) => spec.entry);
}

/** The custom setup: an ordered list, then a description per model. */
async function customSetup(): Promise<ModelEntry[] | null> {
  const list = askText(
    "Models for noa to download and use, smallest to largest, comma-separated:",
  ) ?? "";
  const tags = list.split(",").map((tag) => tag.trim()).filter((tag) =>
    tag !== ""
  );
  if (tags.length === 0) {
    console.log("no models given — skipping model setup");
    return [];
  }
  if (tags.length !== new Set(tags).size) {
    console.log("the model list contains duplicates — skipping model setup");
    return null;
  }

  const models: ModelEntry[] = [];
  for (const tag of tags) {
    const description = askText(
      `What is ${tag} for? (one short line for routing; empty to skip):`,
    ) ?? "";
    models.push({
      model: tag,
      ...(description !== "" ? { description } : {}),
    });
  }

  if (!confirm(`Download ${models.length} model(s) (${tags.join(", ")})?`)) {
    console.log("skipping model downloads");
    return models;
  }
  for (const model of models) {
    try {
      await pullModel(model.model, ollamaBaseUrl());
    } catch (error) {
      console.log(
        `could not pull ${model.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
  return models;
}

/**
 * Total system RAM. Under `NOA_TEST=1` the systems check reads
 * `NOA_TEST_RAM_GB` instead of probing the machine.
 */
function memoryInfo(): { total: number } | null {
  if (isTestMode()) {
    const scripted = Deno.env.get("NOA_TEST_RAM_GB");
    if (scripted !== undefined && scripted !== "") {
      return { total: Number(scripted) * 2 ** 30 };
    }
  }
  try {
    return Deno.systemMemoryInfo();
  } catch {
    return null;
  }
}

/** The shell-profile export block for the memory cap. */
export const OLLAMA_ENV_EXPORTS: Readonly<Record<string, string>> = {
  OLLAMA_MAX_LOADED_MODELS: "2",
  OLLAMA_KEEP_ALIVE: "5m",
};

/** Maps a shell binary path to the rc file setup appends to. */
export function profilePathFor(
  shell: string | undefined,
  home: string,
): string {
  const base = shell?.split("/").pop() ?? "";
  if (base.includes("zsh")) return `${home}/.zshrc`;
  if (base.includes("bash")) return `${home}/.bashrc`;
  return `${home}/.profile`;
}

/** Appends the given `export NAME=value` lines unless already present. */
export function appendEnvExports(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  let result = text;
  for (const [name, value] of Object.entries(values)) {
    const line = `export ${name}=${value}`;
    if (new RegExp(`^\\s*export\\s+${name}=`, "m").test(result)) continue;
    result = result === "" ? line : `${result.replace(/\n*$/, "\n")}${line}\n`;
  }
  return result;
}

import { ollamaBaseUrl, ollamaIsUp } from "./ollama.ts";
import {
  configPath,
  DEFAULT_MODELS,
  ModelEntry,
  writeModels,
} from "./config.ts";
import type { FetchFn } from "./http.ts";

/** Interactive pieces of setup, injectable for tests; all synchronous. */
export interface SetupInteract {
  /** A yes/no question; `false` skips the step. */
  confirm(message: string): boolean;
  /** Visible free-text input, e.g. model lists and descriptions. */
  text(message: string): string | null;
}

/** Everything setup needs, injected for tests. */
export interface SetupOptions {
  /** Process environment reader. */
  readonly env: { get(name: string): string | undefined };
  /** Path of the config file. */
  readonly configPath?: string;
  readonly interact: SetupInteract;
  readonly fetchFn?: FetchFn;
  readonly out: (line: string) => void;
  readonly baseUrl?: string;
  /** System memory probe; defaults to Deno.systemMemoryInfo. */
  readonly memoryInfo?: () => { total: number } | null;
}

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

async function pullModel(
  model: string,
  fetchFn: FetchFn,
  baseUrl: string,
  out: (line: string) => void,
): Promise<void> {
  out(`pulling ${model} (this can take a while)...`);
  const response = await fetchFn(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`Ollama pull ${model}: HTTP ${response.status}`);
  }
  out(`pulled ${model}`);
}

/**
 * Interactive first-time setup. Every step is behind an explicit yes/no or
 * a typed answer: daemon check, model setup (default with a systems check,
 * or a custom ordered list with per-model descriptions), shell-profile env
 * persistence for the memory cap, and API keys when the config file does
 * not exist yet. Setup talks to the Ollama daemon over HTTP only — noa
 * never spawns anything (rule 6).
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const out = options.out;
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? ollamaBaseUrl();

  if (!await ollamaIsUp(baseUrl, fetchFn)) {
    out(
      "Ollama is not running — install it (brew install ollama) and start it with `ollama serve`, then rerun noa setup",
    );
    return 1;
  }
  out(`Ollama is up at ${baseUrl}`);

  const useDefault = options.interact.confirm(
    "Use the default model setup (ministral-3 cascade)?",
  );
  const models = useDefault
    ? await defaultSetup(options)
    : await customSetup(options);
  if (models === null) return 1;

  const path = options.configPath ?? configPath(options.env);

  // Whether the user already had a config decides if we prompt for keys —
  // and must be checked before writeModels creates the file.
  let configExisted = true;
  try {
    await Deno.stat(path);
  } catch {
    configExisted = false;
  }

  await writeModels(path, models);

  const home = options.env.get("HOME");
  if (home !== undefined) {
    const profile = profilePathFor(options.env.get("SHELL"), home);
    const message =
      `Persist the memory cap in ${profile} (export OLLAMA_MAX_LOADED_MODELS=2, OLLAMA_KEEP_ALIVE=5m)? Restart Ollama afterwards for it to apply.`;
    if (options.interact.confirm(message)) {
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
        out(`wrote the memory cap to ${profile}`);
      } catch {
        out(
          `cannot write ${profile} — this binary's permission flags exclude it; add these lines yourself:`,
        );
        for (const [name, value] of Object.entries(OLLAMA_ENV_EXPORTS)) {
          out(`  export ${name}=${value}`);
        }
      }
    }
  }

  // API keys are never stored: they are read from the environment at
  // request time and attached directly to the provider request.
  out(
    "cloud API keys come from your shell environment — export MISTRAL_API_KEY and/or ANTHROPIC_API_KEY to enable cloud tiers",
  );

  out("setup complete — try: noa what is 2+2");
  return 0;
}

/** The default setup: systems check, then only the models it can handle. */
async function defaultSetup(
  options: SetupOptions,
): Promise<ModelEntry[] | null> {
  const out = options.out;
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? ollamaBaseUrl();
  const memory = (options.memoryInfo ?? memoryInfo)();
  const totalGb = memory === null ? null : memory.total / 2 ** 30;
  if (totalGb === null) {
    out("could not read system memory — offering every default model");
  } else {
    out(`systems check: ${Math.round(totalGb)} GB of RAM`);
  }

  const candidates = totalGb === null
    ? DEFAULT_MODEL_SPECS
    : defaultModelsFor(totalGb);
  const skipped = DEFAULT_MODEL_SPECS.filter((spec) =>
    !candidates.includes(spec)
  );
  if (candidates.length > 0) {
    out(
      `the models this system can handle: ${
        candidates.map((s) => `${s.entry.model} (${s.sizeGb})`).join(", ")
      }`,
    );
  }
  if (skipped.length > 0) {
    out(
      `skipping (needs more RAM): ${
        skipped.map((s) => `${s.entry.model} (>=${s.minRamGb} GB)`).join(", ")
      }`,
    );
  }

  if (candidates.length === 0) {
    out("this system cannot comfortably run any default model");
    return [];
  }

  // One confirmation for the whole set; the user already chose the default
  // cascade. Declining only skips the downloads — the cascade is still
  // configured, and already-pulled models just verify quickly.
  const confirmed = options.interact.confirm(
    `Download all of them? (already-pulled models verify quickly)`,
  );
  if (!confirmed) {
    out(
      "skipped downloads — the default cascade is configured; pull later with `ollama pull <model>`",
    );
    return candidates.map((spec) => spec.entry);
  }
  for (const spec of candidates) {
    try {
      await pullModel(spec.entry.model, fetchFn, baseUrl, out);
    } catch (error) {
      out(
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
async function customSetup(
  options: SetupOptions,
): Promise<ModelEntry[] | null> {
  const out = options.out;
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? ollamaBaseUrl();

  const list = options.interact.text(
    "Models for noa to download and use, smallest to largest, comma-separated:",
  ) ?? "";
  const tags = list.split(",").map((tag) => tag.trim()).filter((tag) =>
    tag !== ""
  );
  if (tags.length === 0) {
    out("no models given — skipping model setup");
    return [];
  }
  if (tags.length !== new Set(tags).size) {
    out("the model list contains duplicates — skipping model setup");
    return null;
  }

  const models: ModelEntry[] = [];
  for (const tag of tags) {
    const description = options.interact.text(
      `What is ${tag} for? (one short line for routing; empty to skip):`,
    ) ?? "";
    models.push({
      model: tag,
      ...(description !== "" ? { description } : {}),
    });
  }

  const confirmed = options.interact.confirm(
    `Download ${models.length} model(s) (${tags.join(", ")})?`,
  );
  if (!confirmed) {
    out("skipping model downloads");
    return models;
  }
  for (const model of models) {
    try {
      await pullModel(model.model, fetchFn, baseUrl, out);
    } catch (error) {
      out(
        `could not pull ${model.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
  return models;
}

function memoryInfo(): { total: number } | null {
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

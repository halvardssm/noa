import { ollamaBaseUrl, ollamaIsUp } from "./ollama.ts";
import { configEnvPath, loadEnvFile, setEnvValue } from "./config.ts";
import type { FetchFn } from "./http.ts";

/** Interactive pieces of setup, injectable for tests. */
export interface SetupInteract {
  /** A yes/no question; `false` skips the step. */
  confirm(message: string): Promise<boolean>;
  /** Hidden input, e.g. for API keys. */
  secret(message: string): Promise<string | null>;
}

/** Everything setup needs, injected for tests. */
export interface SetupOptions {
  /** Process environment reader. */
  readonly env: { get(name: string): string | undefined };
  /** Path of the config `.env` file. */
  readonly configPath?: string;
  readonly interact: SetupInteract;
  readonly fetchFn?: FetchFn;
  readonly out: (line: string) => void;
  readonly baseUrl?: string;
}

/** The models setup offers, smallest first. */
const MODELS: readonly { name: string; size: string; default: boolean }[] = [
  { name: "ministral-3:3b", size: "3.0GB", default: true },
  { name: "ministral-3:8b", size: "6.0GB", default: false },
  { name: "ministral-3:14b", size: "9.1GB", default: false },
];

/** The shell-profile export block for the memory cap. */
export const OLLAMA_ENV_EXPORTS: Readonly<Record<string, string>> = {
  OLLAMA_MAX_LOADED_MODELS: "2",
  OLLAMA_KEEP_ALIVE: "5m",
};

/** Maps a shell binary path to the rc file setup appends to. */
export function profilePathFor(shell: string | undefined, home: string): string {
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
 * Interactive first-time setup. Every step is behind an explicit yes/no:
 * daemon check, model pulls, shell-profile env persistence for the memory
 * cap, and API keys when the config file does not exist yet. Setup talks to
 * the Ollama daemon over HTTP only — noa never spawns anything (rule 6).
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const out = options.out;
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? ollamaBaseUrl();

  if (!await ollamaIsUp(baseUrl, fetchFn)) {
    out("Ollama is not running — install it (brew install ollama) and start it with `ollama serve`, then rerun noa setup");
    return 1;
  }
  out(`Ollama is up at ${baseUrl}`);

  for (const model of MODELS) {
    const ask = model.default
      ? `Pull ${model.name} (${model.size}) — the always-warm default?`
      : `Also pull ${model.name} (${model.size}) for bigger local tiers?`;
    if (!await options.interact.confirm(ask)) {
      out(`skipped ${model.name}`);
      continue;
    }
    try {
      await pullModel(model.name, fetchFn, baseUrl, out);
    } catch (error) {
      out(`could not pull ${model.name}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const home = options.env.get("HOME");
  if (home !== undefined) {
    const profile = profilePathFor(options.env.get("SHELL"), home);
    const message =
      `Persist the memory cap in ${profile} (export OLLAMA_MAX_LOADED_MODELS=2, OLLAMA_KEEP_ALIVE=5m)? Restart Ollama afterwards for it to apply.`;
    if (await options.interact.confirm(message)) {
      let text = "";
      try {
        text = await Deno.readTextFile(profile);
      } catch {
        // Missing profile: create it.
      }
      await Deno.writeTextFile(
        profile,
        appendEnvExports(text, OLLAMA_ENV_EXPORTS),
      );
      out(`wrote the memory cap to ${profile}`);
    }
  }

  const configPath = options.configPath ?? configEnvPath(options.env);
  let existing: Record<string, string> = {};
  try {
    existing = await loadEnvFile(configPath);
  } catch {
    // treat as missing
  }
  let configExisted = true;
  try {
    await Deno.stat(configPath);
  } catch {
    configExisted = false;
  }
  if (!configExisted) {
    out("configuring API keys (stored in " + configPath + ", chmod 600)");
    for (const [key, label] of [
      ["MISTRAL_API_KEY", "Mistral"],
      ["ANTHROPIC_API_KEY", "Anthropic"],
    ] as const) {
      const value = await options.interact.secret(`${label} API key (empty to skip):`);
      if (value !== null && value !== "") {
        await setEnvValue(configPath, key, value);
        out(`set ${key}`);
      }
    }
  } else {
    out(`config already exists at ${configPath} — leaving keys untouched`);
  }

  out("setup complete — try: noa what is 2+2");
  return 0;
}

import { z } from "zod/mini";
import { homeDir } from "@stdx/fs";
import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { DEFAULT_MODEL_DATA } from "./data.ts";
/**
 * The tool allowlist example, shown in the CLI help so the user can set it
 * themselves (security rule 3: no allowlist is granted by default).
 */
export const SUGGESTED_TOOLS = "ls,cat,head,tail,wc,grep,find,jq,curl,date";

/** One entry of the user-defined local model cascade. */
export const ModelEntry = z.object({
  /** A complexity between 1 and 100 */
  complexity: z.int().check(z.minimum(1), z.maximum(100)),
  /** The model tag: an Ollama tag, or a cloud model name with `provider`. */
  model: z.string(),
  /** What this model is for; the judge reads it to route. Optional. */
  description: z.optional(z.string()),
  /** Which provider serves this model; unset (or "ollama") means Ollama. */
  provider: z._default(
    z.optional(z.literal(["ollama", "mistral", "anthropic"])),
    "ollama",
  ),
});

export type ModelEntry = z.infer<typeof ModelEntry>;

/** Schema of the ordered model cascade. */
export const NoaConfig = z.object({
  rules: z.array(ModelEntry),
});

/** The validated config file contents. */
export type NoaConfig = z.infer<typeof NoaConfig>;

/** The built-in default cascade: the ministral-3 family. */
export function defaultModels(): ModelEntry[] {
  return DEFAULT_MODEL_DATA.map((m) => ({
    complexity: m.complexity,
    provider: m.provider,
    model: m.model,
    description: m.description,
  }));
}

/** The default config: the default cascade as its `rules`. */
export function defaultConfig(): NoaConfig {
  return {
    rules: defaultModels(),
  };
}

/** The directory holding noa config: `NOA_HOME` or `~/.config/noa`. */
export function configDir(): string {
  const override = Deno.env.get("NOA_HOME");
  if (override !== undefined && override !== "") return override;
  const home = homeDir();
  return join(home, ".config", "noa");
}

/** The path of the JSON config file. */
export function configFilePath(): string {
  return join(configDir(), "config.json");
}

/** Reads the JSON config file, returning the default config when it does not exist. */
export async function loadConfigFile(path: string): Promise<NoaConfig> {
  try {
    return NoaConfig.parse(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return defaultConfig();
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

export async function getConfigFile(): Promise<NoaConfig> {
  const path = configFilePath();
  return await loadConfigFile(path);
}

/** Writes the config file, creating parent directories as needed. */
export async function writeConfigFile(
  path: string,
  config: NoaConfig,
): Promise<void> {
  ensureDir(dirname(path));

  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    create: true,
  });
}

/**
 * Ensures the config file is present
 */
export async function ensureConfigFile(): Promise<NoaConfig> {
  const path = configFilePath();
  try {
    return await loadConfigFile(path);
  } catch {
    const config = defaultConfig();
    await writeConfigFile(path, config);
    return config;
  }
}

/**
 * Sources for a list setting, most specific first. Each level fully
 * replaces the one below (security rules 1 and 3):
 * CLI flag > config file value > built-in default.
 */
export interface ListSources {
  /** Raw comma-separated value from the CLI flag, if given. */
  readonly flag?: string;
  /** Raw value from the config file, if set. */
  readonly file?: string;
  /** Built-in defaults, used when nothing above is present. */
  readonly defaults: readonly string[];
}

/** Resolves a list setting by precedence, trimming and deduplicating. */
export function resolveList(sources: ListSources): string[] {
  const raw = sources.flag ?? sources.file ?? sources.defaults.join(",");
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    list.push(trimmed);
  }
  return list;
}

/** Reads a flat string setting from an untyped config record. */
export function stringSetting(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Whether a setting name looks like a secret (`*_KEY`, `*_TOKEN`, `*_SECRET`). */
export function isSecretKey(key: string): boolean {
  return /(KEY|TOKEN|SECRET)$/i.test(key);
}

/** Masks a value in output unless explicitly shown (security rule 8). */
export function maskValue(value: string, show: boolean): string {
  if (show) return value;
  return "********";
}

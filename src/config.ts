import { parse } from "@std/dotenv";
import { z } from "zod";

/**
 * The tool allowlist example, shown in the CLI help so the user can set it
 * themselves (security rule 3: no allowlist is granted by default).
 */
export const SUGGESTED_TOOLS = "ls,cat,head,tail,wc,grep,find,jq,curl,date";

/** One entry of the user-defined local model cascade. */
export interface ModelEntry {
  /** The model tag: an Ollama tag, or a cloud model name with `provider`. */
  readonly model: string;
  /** What this model is for; the judge reads it to route. Optional. */
  readonly description?: string;
  /** Which provider serves this model; unset (or "ollama") means Ollama. */
  readonly provider?: "ollama" | "mistral" | "anthropic";
}

/** Schema of one cascade entry: a bare model tag, or model + metadata. */
const modelEntrySchema: z.ZodType<ModelEntry> = z.union([
  z.string().min(1).transform((model) => ({ model })),
  z.object({
    model: z.string().min(1),
    description: z.string().min(1).optional(),
    provider: z.enum(["ollama", "mistral", "anthropic"]).optional(),
  }),
]);

/** Schema of the ordered model cascade. */
export const modelsSchema = z.array(modelEntrySchema);

/** Schema of the whole config file: flat string settings plus `models`. */
export const configSchema = z.record(
  z.string(),
  z.union([z.string(), modelsSchema]),
);

/** The validated config file contents. */
export type NoaConfig = z.infer<typeof configSchema>;

/** The built-in default cascade: the ministral-3 family. */
export const DEFAULT_MODELS: readonly ModelEntry[] = [
  {
    model: "ministral-3:3b",
    description:
      "trivial questions, chat, simple lookups, basic arithmetic, formatting.",
  },
  {
    model: "ministral-3:8b",
    description: "moderate tasks: summarizing, explaining, simple code questions.",
  },
  {
    model: "ministral-3:14b",
    description:
      "demanding but self-contained tasks: multi-step reasoning, code generation and review.",
  },
];

/**
 * The built-in default allowed path (security rule 1): the current
 * directory — the narrowest scope that is still useful.
 */
export function defaultAllowPaths(cwd?: string): string[] {
  return [cwd ?? Deno.cwd()];
}

/** Whether `path` is `home` itself or inside one of its folders. */
export function isUnderHome(path: string, home: string): boolean {
  return path === home || path.startsWith(`${home}/`);
}

/** The directory holding noa config: `NOA_HOME` or `~/.config/noa`. */
export function configHome(env: { get(name: string): string | undefined }): string {
  const override = env.get("NOA_HOME");
  if (override !== undefined && override !== "") return override;
  const home = env.get("HOME");
  if (home === undefined) {
    throw new Error("HOME is not set; cannot resolve the config directory");
  }
  return `${home}/.config/noa`;
}

/** The path of the JSON config file. */
export function configPath(env: { get(name: string): string | undefined }): string {
  return `${configHome(env)}/config.json`;
}

/** The path of the legacy `.env` config file (migrated on first load). */
export function legacyEnvPath(env: { get(name: string): string | undefined }): string {
  return `${configHome(env)}/.env`;
}

/** Reads the JSON config file, returning `{}` when it does not exist. */
export async function loadConfig(path: string): Promise<NoaConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`${path} is not a valid noa config — ${issues}`);
  }
  return result.data;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(path: string, config: NoaConfig): Promise<void> {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`refusing to write an invalid config — ${issues}`);
  }
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
  // Tighten, never loosen: a world-readable config file is a bug.
  try {
    const stat = await Deno.stat(path);
    if (stat.mode !== null && (stat.mode & 0o777) !== 0o600) {
      await Deno.chmod(path, 0o600);
    }
  } catch {
    // The file exists (we just wrote it); ignore races on stat.
  }
}

/**
 * Migrates a legacy `.env` config into the JSON config file, once: when
 * the JSON config does not exist yet but the `.env` file does, its values
 * are copied verbatim. The `.env` file is left untouched.
 */
export async function ensureConfig(
  path: string,
  legacyPath: string,
): Promise<boolean> {
  if (await exists(path) || !(await exists(legacyPath))) return false;
  const values = parse(await Deno.readTextFile(legacyPath)) as Record<
    string,
    string
  >;
  const config: NoaConfig = {};
  for (const [key, value] of Object.entries(values)) {
    // Secrets are never stored; they are read from the environment.
    if (isSecretKey(key)) continue;
    config[key] = value;
  }
  await writeConfig(path, config);
  return true;
}

function validKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Writes a single string setting to the JSON config file (security rule 8).
 * Creates the file (and parent directories) with mode 600 when missing,
 * updates only the named key, and preserves all unrelated entries.
 */
export async function setConfigValue(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  if (key === "models") {
    throw new TypeError(
      "models are a list — edit config.json directly or rerun `noa setup`",
    );
  }
  if (isSecretKey(key)) {
    throw new TypeError(
      `secrets are not stored — export ${key} in your shell instead`,
    );
  }
  if (!validKey(key)) {
    throw new TypeError(`invalid setting name: ${JSON.stringify(key)}`);
  }
  const config = await loadConfig(path);
  config[key] = value;
  await writeConfig(path, config);
}

/**
 * Removes a single setting from the JSON config file.
 * Returns whether the key was present.
 */
export async function unsetConfigValue(
  path: string,
  key: string,
): Promise<boolean> {
  if (!validKey(key)) {
    throw new TypeError(`invalid setting name: ${JSON.stringify(key)}`);
  }
  const config = await loadConfig(path);
  if (!(key in config)) return false;
  delete config[key];
  await writeConfig(path, config);
  return true;
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

/**
 * Resolves the local model cascade from the config's `models` array:
 * ordered smallest to largest; the position is the escalation tier.
 * An absent or invalid `models` key falls back to the built-in defaults;
 * an explicit empty array is a deliberate cloud-only override.
 */
export function resolveModels(
  config: Record<string, unknown>,
): ModelEntry[] {
  if (!("models" in config)) return [...DEFAULT_MODELS];
  const result = modelsSchema.safeParse(config["models"]);
  if (!result.success) return [...DEFAULT_MODELS];
  return result.data.map((entry) => ({
    model: entry.model,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.provider !== undefined && entry.provider !== "ollama"
      ? { provider: entry.provider }
      : {}),
  }));
}

/**
 * Writes the model cascade into the config file (setup flow). Preserves all
 * other settings; validated by the schema before writing.
 */
export async function writeModels(
  path: string,
  models: readonly ModelEntry[],
): Promise<void> {
  const config = await loadConfig(path);
  config["models"] = [...models];
  await writeConfig(path, config);
}

/** Whether a setting name looks like a secret (`*_KEY`, `*_TOKEN`, `*_SECRET`). */
export function isSecretKey(key: string): boolean {
  return /(KEY|TOKEN|SECRET)$/i.test(key);
}

/** Masks a value in output unless explicitly shown (security rule 8). */
export function maskValue(key: string, value: string, show: boolean): string {
  if (show || !isSecretKey(key)) return value;
  return "********";
}

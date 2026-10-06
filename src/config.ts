import { parse } from "@std/dotenv";

/** The built-in default tool allowlist (security rule 3). */
export const DEFAULT_ALLOW_TOOLS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "find",
  "jq",
  "curl",
];

/** The built-in default allowed paths (security rule 1): `~/dev`. */
export function defaultAllowPaths(): string[] {
  const home = Deno.env.get("HOME");
  if (home === undefined) {
    throw new Error("HOME is not set; cannot resolve the default workspace");
  }
  return [`${home}/dev`];
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

/** The path of the config `.env` file. */
export function configEnvPath(env: { get(name: string): string | undefined }): string {
  return `${configHome(env)}/.env`;
}

/**
 * Sources for a list setting, most specific first. Each level fully
 * replaces the one below (security rules 1 and 3):
 * CLI flag > process env var > config file value > built-in default.
 */
export interface ListSources {
  /** Raw comma-separated value from the CLI flag, if given. */
  readonly flag?: string;
  /** Raw value from the process environment, if set. */
  readonly env?: string;
  /** Raw value from the config file, if set. */
  readonly file?: string;
  /** Built-in defaults, used when nothing above is present. */
  readonly defaults: readonly string[];
}

/** Resolves a list setting by precedence, trimming and deduplicating. */
export function resolveList(sources: ListSources): string[] {
  const raw = sources.flag ?? sources.env ?? sources.file ??
    sources.defaults.join(",");
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

/** Reads the config `.env` file, returning `{}` when it does not exist. */
export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const text = await Deno.readTextFile(path);
    return parse(text) as Record<string, string>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Formats a value for the file: quoted only when it needs it to round-trip. */
export function formatValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/(["\\])/g, "\\$1")}"`;
  }
  return value;
}

function keyLine(key: string, eatNewline = false): RegExp {
  const base = `^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=.*`;
  return new RegExp(eatNewline ? `${base}(?:\\n|$)` : base, "m");
}

async function ensureTight(path: string, existed: boolean): Promise<void> {
  if (existed) {
    // Tighten, never loosen: a world-readable config file is a bug.
    try {
      const stat = await Deno.stat(path);
      if (stat.mode !== null && (stat.mode & 0o777) !== 0o600) {
        await Deno.chmod(path, 0o600);
      }
    } catch {
      // The file exists (we just wrote it); ignore races on stat.
    }
  } else {
    await Deno.chmod(path, 0o600);
  }
}

/**
 * Writes a single setting to the config file (security rule 8).
 * Creates the file (and parent directories) with mode 600 when missing,
 * updates only the named key, and preserves all unrelated entries.
 */
export async function setEnvValue(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  if (!validKey(key)) {
    throw new TypeError(`invalid setting name: ${JSON.stringify(key)}`);
  }
  let existed = true;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    existed = false;
    const dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
    await Deno.mkdir(dir, { recursive: true });
    text = "";
  }

  const line = `${key}=${formatValue(value)}\n`;
  if (keyLine(key).test(text)) {
    text = text.replace(keyLine(key), line.trimEnd());
  } else {
    text = text === "" ? line : text.replace(/(?<!\n)$/, "\n") + line;
  }
  await Deno.writeTextFile(path, text);
  await ensureTight(path, existed);
}

/**
 * Removes a single setting from the config file.
 * Returns whether the key was present.
 */
export async function unsetEnvValue(
  path: string,
  key: string,
): Promise<boolean> {
  if (!validKey(key)) {
    throw new TypeError(`invalid setting name: ${JSON.stringify(key)}`);
  }
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  if (!keyLine(key, true).test(text)) return false;
  const stripped = text.replace(keyLine(key, true), "");
  await Deno.writeTextFile(path, stripped);
  return true;
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

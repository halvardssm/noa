/**
 * The execution gate (security rules 1–3). noa implements no tools of its own:
 * the model can only request a run of an allowlisted command, and every
 * request passes through here — allowlist check, argument path screening,
 * curl method screening, and a log of every decision.
 */
import { confirm, isInteractive, isWithin } from "./utils.ts";
import { getLogger } from "./log.ts";

/** Rejection reason, safe to show the model and the user. */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

/** Settings of a gate, already resolved by precedence (see config.ts). */
export interface GateSettings {
  /** Resolved allowlist: bare command names or absolute paths. */
  readonly allowTools: readonly string[];
  /** Resolved allowed paths (may contain `~` or relative segments). */
  readonly allowPaths: readonly string[];
  /** Working directory for resolving relative arguments; defaults to cwd. */
  readonly cwd?: string;
}

/** The result of a run command. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A gate validating and running allowlisted commands. */
export interface Gate {
  /** Runs `command` with `args` after all checks pass. */
  run(command: string, args: readonly string[]): Promise<RunResult>;
  /** The effective allowlist. */
  readonly tools: readonly string[];
  /** The effective allowed paths. */
  readonly paths: readonly string[];
}

/** Expands a leading `~` or `~/` with `home`; other values pass through. */
export function expandTilde(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return `${home}/${value.slice(2)}`;
  return value;
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/** Normalizes a path lexically (`..`, `.`) without touching the filesystem. */
export function normalizeLexical(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

function absoluteFrom(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  return `${cwd}/${path}`;
}

const CURL_BODY_FLAGS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "-F",
  "--form",
  "--form-string",
  "-T",
  "--upload-file",
  "--json",
]);

/**
 * Screens curl arguments (security rule 2). Returns the offending argument
 * when the invocation would define a method other than GET, a body, or an
 * upload; `null` when the invocation is GET-only.
 */
export function screenCurlArgs(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-X" || arg === "--request") {
      const method = args[i + 1] ?? "";
      if (!/^get$/i.test(method)) return `${arg} ${method || "(none)"}`;
      i++;
      continue;
    }
    if (CURL_BODY_FLAGS.has(arg)) return arg;
    if (/^-X./i.test(arg) && !/^-XGET$/i.test(arg)) return arg;
    if (/^-[dFT]/.test(arg) && arg.length > 2) return arg;
  }
  return null;
}

const logger = getLogger(["noa", "gate"]);

/** Creates a gate. Throws `GateError` on invalid allowlist entries. */
export async function createGate(settings: GateSettings): Promise<Gate> {
  const home = Deno.env.get("HOME") ?? "";
  const cwd = settings.cwd ?? Deno.cwd();
  const log = (message: string) => logger.debug(message);

  // Real roots: the allowed paths as they exist on disk. A path that does
  // not exist can contain no files, so only existing roots gate real paths.
  const realRoots: string[] = [];
  const lexicalRoots: string[] = [];
  const configuredRoots: string[] = [];
  for (const p of settings.allowPaths) {
    const absolute = absoluteFrom(expandTilde(p, home), cwd);
    configuredRoots.push(normalizeLexical(absolute));
    const rp = await realPathOrNull(absolute);
    if (rp === null) lexicalRoots.push(normalizeLexical(absolute));
    else realRoots.push(rp);
  }

  for (const entry of settings.allowTools) {
    if (!entry.includes("/")) continue;
    const absolute = absoluteFrom(expandTilde(entry, home), cwd);
    const rp = await realPathOrNull(absolute);
    const inside = (rp !== null && realRoots.some((r) => isWithin(rp, r))) ||
      lexicalRoots.some((r) => isWithin(normalizeLexical(absolute), r)) ||
      realRoots.some((r) => isWithin(normalizeLexical(absolute), r));
    if (inside) {
      throw new GateError(
        `allowlist entry "${entry}" resolves inside the writable workspace`,
      );
    }
  }
  const allowSet = new Set(settings.allowTools.map((t) => t.split("/").pop()!));

  async function screenArgs(
    command: string,
    args: readonly string[],
  ): Promise<void> {
    for (const arg of args) {
      const absolute = absoluteFrom(expandTilde(arg, home), cwd);
      const rp = await realPathOrNull(absolute);
      if (rp === null) continue; // not an existing path: not screened (best effort)
      if (realRoots.some((r) => isWithin(rp, r))) continue;
      const lexical = normalizeLexical(absolute);
      const lookedInside = configuredRoots.some((r) => isWithin(lexical, r)) ||
        realRoots.some((r) => isWithin(lexical, r)) ||
        lexicalRoots.some((r) => isWithin(lexical, r));
      log(
        `rejected: ${command} ${args.join(" ")} (outside the allowed paths)`,
      );
      throw new GateError(
        lookedInside
          ? `"${arg}" resolves (symlink or .. traversal) outside the allowed paths`
          : `"${arg}" names a path outside the allowed paths`,
      );
    }
  }

  return {
    tools: settings.allowTools,
    paths: settings.allowPaths,
    async run(command: string, args: readonly string[]): Promise<RunResult> {
      const base = command.split("/").pop()!;
      if (!allowSet.has(base)) {
        log(`rejected: ${command} ${args.join(" ")} (not in the allowlist)`);
        throw new GateError(
          `"${base}" is not in the allowlist — no tools are configured; tell the user to pass --allow-tools <cmds>`,
        );
      }
      if (base === "curl") {
        const offender = screenCurlArgs(args);
        if (offender !== null) {
          log(`rejected: curl ${args.join(" ")} (GET-only, saw ${offender})`);
          throw new GateError(
            `curl is GET-only: "${offender}" defines a method, body, or upload`,
          );
        }
      }
      await screenArgs(command, args);
      if (base === "rm") {
        // Rule 4: rm needs interactive approval for every single run —
        // and approval never overrides the screening above. A
        // non-interactive session can never approve.
        const approved = confirm(
          `Do you permit the agent to use 'rm' for the command '${base} ${
            args.join(" ")
          }'?`,
        ) && isInteractive();
        if (!approved) {
          log(`rejected: ${command} ${args.join(" ")} (rm not approved)`);
          throw new GateError(
            `"rm" requires interactive approval — not approved`,
          );
        }
      }
      log(`run: ${command} ${args.join(" ")}`);
      // There is no shell: expand `~` ourselves, exactly as screened.
      const childArgs = args.map((a) => expandTilde(a, home));
      const proc = new Deno.Command(command, {
        args: [...childArgs],
        cwd: settings.cwd,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await proc.output();
      return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      };
    },
  };
}

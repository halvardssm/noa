import {
  defaultAllowPaths,
  isUnderHome,
  resolveList,
  stringSetting,
  SUGGESTED_TOOLS,
} from "./config.ts";
import { ollamaChat } from "./ollama.ts";
import { anthropicProvider, mistralProvider } from "./cloud.ts";
import { LOCAL_TIERS, type Tier } from "./judge.ts";
import { createGate, type Gate } from "./tools.ts";
import { cascade, type CascadeDeps, type ChatFn } from "./router.ts";
import type { FetchFn } from "./http.ts";
import type { ChatMessage, ToolSpec } from "./ollama.ts";

/** The local tiers and their user-configured models. */
export interface LocalTiers {
  /** Configured tiers in escalation order (disabled tiers are absent). */
  readonly order: readonly Tier[];
  /** Tier -> Ollama model name. */
  readonly models: Readonly<Record<string, string>>;
}

/** The built-in default model per tier. */
const DEFAULT_TIER_MODELS: Readonly<Record<string, string>> = {
  local1: "ministral-3:3b",
  local2: "ministral-3:8b",
  local3: "ministral-3:14b",
};

/**
 * Resolves the local tiers from `NOA_MODEL_LOCAL1/2/3` (env wins over the
 * config file; `none` disables the tier). Defaults to the ministral-3
 * family, so a fresh install behaves like the original spec.
 */
export function resolveLocalTiers(
  env: { get(name: string): string | undefined },
  fileValues: Record<string, unknown>,
): LocalTiers {
  const models: Record<string, string> = {};
  const order: Tier[] = [];
  for (const tier of LOCAL_TIERS) {
    const setting = `NOA_MODEL_${tier.toUpperCase()}`;
    const raw = env.get(setting) ?? stringSetting(fileValues, setting) ??
      DEFAULT_TIER_MODELS[tier];
    if (raw === "" || raw === "none") continue;
    models[tier] = raw;
    order.push(tier);
  }
  return { order, models };
}

/** Options for {@linkcode createApp}. */
export interface AppOptions {
  /** Process environment reader. */
  readonly env: { get(name: string): string | undefined };
  /** Values from the config `.env` file. */
  readonly fileValues: Record<string, unknown>;
  /** `--allow-tools` flag. */
  readonly allowToolsFlag?: string;
  /** `--allow-paths` flag. */
  readonly allowPathsFlag?: string;
  /** `--model` flag: local3b | local8b | local14b | mistral | claude. */
  readonly model?: string;
  /** `--no-verify`. */
  readonly noVerify?: boolean;
  /** Working directory; the default allowed path. Defaults to cwd. */
  readonly cwd?: string;
  /** Log sink (stderr in the CLI). */
  readonly onLog: (message: string) => void;
  /** Interactive `rm` approval; absent means `rm` is always rejected. */
  readonly approveRm?: (
    command: string,
    args: readonly string[],
  ) => Promise<boolean>;
  /** Fetch implementation for the model providers. */
  readonly fetchFn?: FetchFn;
}

/** A wired application: resolved settings plus the cascade entry point. */
export interface App {
  /** The effective tool allowlist. */
  readonly allowTools: readonly string[];
  /** The effective allowed paths. */
  readonly allowPaths: readonly string[];
  /** The execution gate. */
  readonly gate: Gate;
  /** Runs the cascade for a question and returns the answer. */
  ask(question: string): Promise<string>;
}

/** Assembles settings, gate, providers, and the cascade. */
export async function createApp(options: AppOptions): Promise<App> {
  const cwd = options.cwd ?? Deno.cwd();
  const allowTools = resolveList({
    flag: options.allowToolsFlag,
    env: options.env.get("NOA_TOOLS"),
    file: stringSetting(options.fileValues, "NOA_TOOLS"),
    defaults: [],
  });
  const pathsConfigured = options.allowPathsFlag !== undefined ||
    options.env.get("NOA_ALLOW_PATHS") !== undefined ||
    stringSetting(options.fileValues, "NOA_ALLOW_PATHS") !== undefined;
  const allowPaths = resolveList({
    flag: options.allowPathsFlag,
    env: options.env.get("NOA_ALLOW_PATHS"),
    file: stringSetting(options.fileValues, "NOA_ALLOW_PATHS"),
    defaults: defaultAllowPaths(cwd),
  });

  if (allowTools.length === 0) {
    options.onLog(
      `no tools are allowed — pass --allow-tools or set NOA_TOOLS (example: --allow-tools ${SUGGESTED_TOOLS})`,
    );
  }
  if (!pathsConfigured) {
    const home = options.env.get("HOME");
    if (home !== undefined && !isUnderHome(cwd, home)) {
      options.onLog(
        `allowing the current directory ${cwd}, which is outside your home — set NOA_ALLOW_PATHS or pass --allow-paths to choose deliberately`,
      );
    }
  }

  const gate = await createGate({
    allowTools,
    allowPaths,
    homeDir: options.env.get("HOME"),
    cwd: options.cwd,
    log: options.onLog,
    approveRm: options.approveRm,
  });

  const localTiers = resolveLocalTiers(options.env, options.fileValues);
  const firstModel = localTiers.order.length > 0
    ? localTiers.models[localTiers.order[0]]
    : undefined;

  const chatFor = (purpose: string): ChatFn =>
    (messages: readonly ChatMessage[], chatOptions?: {
      json?: boolean;
      tools?: readonly ToolSpec[];
    }) => {
      // `judge` and `verify` run on the smallest configured model; tier
      // purposes resolve to that tier's user-configured model.
      const model = purpose === "judge" || purpose === "verify"
        ? firstModel
        : localTiers.models[purpose];
      if (model === undefined) {
        throw new Error(
          `no model configured for "${purpose}" — set NOA_MODEL_LOCAL1`,
        );
      }
      return ollamaChat({
        model,
        messages,
        json: chatOptions?.json,
        tools: chatOptions?.tools,
        fetchFn: options.fetchFn,
      });
    };

  const apiKey = (name: string): string =>
    options.env.get(name) ?? stringSetting(options.fileValues, name) ?? "";

  /** Cloud providers in the user's preferred order (NOA_CLOUD). */
  const cloudOrder = (options.env.get("NOA_CLOUD") ??
    stringSetting(options.fileValues, "NOA_CLOUD") ?? "mistral,claude")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const clouds = [];
  for (const name of cloudOrder) {
    if (name === "mistral" && apiKey("MISTRAL_API_KEY") !== "") {
      clouds.push(
        mistralProvider({
          apiKey: apiKey("MISTRAL_API_KEY"),
          model: options.env.get("NOA_MISTRAL_MODEL") ??
            stringSetting(options.fileValues, "NOA_MISTRAL_MODEL"),
          fetchFn: options.fetchFn,
        }),
      );
    } else if (name === "claude" && apiKey("ANTHROPIC_API_KEY") !== "") {
      clouds.push(
        anthropicProvider({
          apiKey: apiKey("ANTHROPIC_API_KEY"),
          model: options.env.get("NOA_ANTHROPIC_MODEL") ??
            stringSetting(options.fileValues, "NOA_ANTHROPIC_MODEL"),
          fetchFn: options.fetchFn,
        }),
      );
    }
  }

  const deps: CascadeDeps = {
    chatFor,
    localTiers: localTiers.order,
    gate,
    clouds,
    forcedTier: forcedTierOf(options.model, options.onLog),
    noVerify: options.noVerify,
    onLog: options.onLog,
  };

  return {
    allowTools,
    allowPaths,
    gate,
    ask: (question: string) => cascade(question, deps),
  };
}

/** Maps `--model` to a forced tier; warns about unsupported choices. */
function forcedTierOf(
  model: string | undefined,
  onLog: (message: string) => void,
): CascadeDeps["forcedTier"] {
  if (model === undefined) return undefined;
  // Old, model-size-derived names still work as aliases.
  const aliases: Record<string, CascadeDeps["forcedTier"]> = {
    local1: "local1",
    local2: "local2",
    local3: "local3",
    local3b: "local1",
    local8b: "local2",
    local14b: "local3",
    mistral: "mistral",
    claude: "claude",
  };
  const tier = aliases[model];
  if (tier !== undefined) return tier;
  onLog(`model "${model}" is not supported yet — routing to cloud instead`);
  return "mistral";
}

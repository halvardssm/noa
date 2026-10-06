import {
  defaultAllowPaths,
  isUnderHome,
  resolveList,
  resolveModels,
  stringSetting,
  SUGGESTED_TOOLS,
  type ModelEntry,
} from "./config.ts";
import { ollamaChat } from "./ollama.ts";
import { anthropicProvider, mistralProvider } from "./cloud.ts";
import type { Tier } from "./judge.ts";
import { createGate, type Gate } from "./tools.ts";
import { cascade, type CascadeDeps, type ChatFn, type ForcedTarget } from "./router.ts";
import type { FetchFn } from "./http.ts";
import type { ChatMessage, ToolSpec } from "./ollama.ts";

/** The local tiers and their user-configured models. */
export interface LocalTiers {
  /** Tier names in escalation order: `local1`..`localN`. */
  readonly order: readonly Tier[];
  /** Tier -> Ollama model name. */
  readonly models: Readonly<Record<string, string>>;
  /** Tier -> the user's description of what the model is for. */
  readonly descriptions: Readonly<Record<string, string>>;
}

/**
 * Maps the user's ordered model list onto positional tiers: position is
 * the escalation order, the first entry is the always-warm judge/verifier.
 */
export function resolveLocalTiers(
  models: readonly ModelEntry[],
): LocalTiers {
  const order: Tier[] = models.map((_, index) => `local${index + 1}`);
  const modelMap: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  models.forEach((entry, index) => {
    modelMap[order[index]] = entry.model;
    if (entry.description !== undefined) descriptions[order[index]] = entry.description;
  });
  return { order, models: modelMap, descriptions };
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

  const localTiers = resolveLocalTiers(resolveModels(options.fileValues));
  const firstModel = localTiers.order.length > 0
    ? localTiers.models[localTiers.order[0]]
    : undefined;

  const chatFor = (purpose: string): ChatFn =>
    (messages: readonly ChatMessage[], chatOptions?: {
      json?: boolean;
      tools?: readonly ToolSpec[];
    }) => {
      // `judge` and `verify` run on the first (smallest) configured model;
      // tier purposes resolve to that tier's user-configured model.
      const model = purpose === "judge" || purpose === "verify"
        ? firstModel
        : localTiers.models[purpose];
      if (model === undefined) {
        throw new Error(
          `no model configured for "${purpose}" — add models to config.json`,
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

  const chatForModel = (model: string): ChatFn =>
    (messages: readonly ChatMessage[], chatOptions?: {
      json?: boolean;
      tools?: readonly ToolSpec[];
    }) =>
      ollamaChat({
        model,
        messages,
        json: chatOptions?.json,
        tools: chatOptions?.tools,
        fetchFn: options.fetchFn,
      });

  const mistralModel = options.env.get("NOA_MISTRAL_MODEL") ??
    stringSetting(options.fileValues, "NOA_MISTRAL_MODEL") ??
    "mistral-large-latest";
  const anthropicModel = options.env.get("NOA_ANTHROPIC_MODEL") ??
    stringSetting(options.fileValues, "NOA_ANTHROPIC_MODEL") ??
    "claude-sonnet-4-5";

  const deps: CascadeDeps = {
    chatFor,
    chatForModel,
    localTiers: localTiers.order,
    tierDescriptions: localTiers.descriptions,
    gate,
    clouds,
    forced: forcedTargetOf(options.model, mistralModel, anthropicModel),
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

/**
 * Maps `--model` to a forced target: a cloud provider name or model tag, a
 * positional tier (`localN`, with legacy aliases), or any Ollama model tag.
 * Forced targets bypass the judge, verification, and the cascade.
 */
export function forcedTargetOf(
  model: string | undefined,
  mistralModel: string,
  anthropicModel: string,
): ForcedTarget | undefined {
  if (model === undefined) return undefined;
  // Old, model-size-derived names still work as aliases onto positions.
  const aliases: Record<string, string> = {
    local3b: "local1",
    local8b: "local2",
    local14b: "local3",
  };
  const tier = aliases[model] ?? model;
  if (/^local\d+$/.test(tier)) return { kind: "tier", tier };
  if (model === "mistral" || model === mistralModel) {
    return { kind: "cloud", provider: "mistral" };
  }
  if (model === "claude" || model === anthropicModel) {
    return { kind: "cloud", provider: "claude" };
  }
  return { kind: "model", model };
}

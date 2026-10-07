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
import { anthropicProvider, hasKey, mistralProvider, type CloudProvider } from "./cloud.ts";
import type { Tier } from "./judge.ts";
import type { TierTarget } from "./router.ts";
import { createGate, type Gate } from "./tools.ts";
import { cascade, type CascadeDeps, type ChatFn, type ForcedTarget } from "./router.ts";
import type { FetchFn } from "./http.ts";
import type { ChatMessage, ToolSpec } from "./ollama.ts";

/** The tiers of the user's cascade and their models. */
export interface LocalTiers {
  /** Tier names in escalation order: `local1`..`localN`. */
  readonly order: readonly Tier[];
  /** Tier -> the user's description of what the model is for. */
  readonly descriptions: Readonly<Record<string, string>>;
  /** Tier -> provider and model (unset provider means Ollama). */
  readonly targets: Readonly<Record<string, TierTarget>>;
}

/**
 * Maps the user's ordered model list onto positional tiers: position is
 * the escalation order, the first Ollama entry is the judge/verifier.
 * A `provider` on an entry routes that tier to a cloud model.
 */
export function resolveLocalTiers(
  models: readonly ModelEntry[],
): LocalTiers {
  const order: Tier[] = models.map((_, index) => `local${index + 1}`);
  const descriptions: Record<string, string> = {};
  const targets: Record<string, TierTarget> = {};
  models.forEach((entry, index) => {
    const tier = order[index];
    if (entry.description !== undefined) descriptions[tier] = entry.description;
    targets[tier] = {
      provider: entry.provider ?? "ollama",
      model: entry.model,
    };
  });
  return { order, descriptions, targets };
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
  /** `--model` flag: an Ollama tag or a `localN` tier (Ollama-only without --provider). */
  readonly model?: string;
  /** `--provider` flag: the cloud provider for `--model` (mistral | anthropic). */
  readonly provider?: string;
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
    file: stringSetting(options.fileValues, "NOA_TOOLS"),
    defaults: [],
  });
  const pathsConfigured = options.allowPathsFlag !== undefined ||
    stringSetting(options.fileValues, "NOA_ALLOW_PATHS") !== undefined;
  const allowPaths = resolveList({
    flag: options.allowPathsFlag,
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
  const firstOllama = localTiers.order.find((tier) =>
    localTiers.targets[tier].provider === "ollama"
  );
  const judgeModel = firstOllama !== undefined
    ? localTiers.targets[firstOllama].model
    : undefined;

  const chatFor = (purpose: string): ChatFn =>
    (messages: readonly ChatMessage[], chatOptions?: {
      json?: boolean;
      tools?: readonly ToolSpec[];
    }) => {
      // `judge` and `verify` run on the first Ollama model in the cascade;
      // tier purposes resolve to that tier's Ollama model.
      const model = purpose === "judge" || purpose === "verify"
        ? judgeModel
        : localTiers.targets[purpose]?.provider === "ollama"
        ? localTiers.targets[purpose].model
        : undefined;
      if (model === undefined) {
        throw new Error(
          `no ollama model configured for "${purpose}" — add models to config.json`,
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

  // Secrets are never stored: providers read their keys from the
  // environment at request time and attach them directly to the request.
  const readSecret = (name: string): string | undefined =>
    options.env.get(name);

  // Warn about legacy keys that are still sitting in the config file.
  for (const key of ["MISTRAL_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (stringSetting(options.fileValues, key) !== undefined) {
      options.onLog(
        `${key} in config.json is ignored — export it in your shell instead`,
      );
    }
  }

  /** Cloud providers in the user's preferred order (NOA_CLOUD). */
  const cloudOrder = (stringSetting(options.fileValues, "NOA_CLOUD") ??
    "mistral,anthropic")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const clouds: CloudProvider[] = [];
  for (const name of cloudOrder) {
    if (name === "mistral" && hasKey(readSecret, "MISTRAL_API_KEY")) {
      clouds.push(
        mistralProvider({
          model: stringSetting(options.fileValues, "NOA_MISTRAL_MODEL"),
          fetchFn: options.fetchFn,
          readSecret,
        }),
      );
    } else if (name === "anthropic" && hasKey(readSecret, "ANTHROPIC_API_KEY")) {
      clouds.push(
        anthropicProvider({
          model: stringSetting(options.fileValues, "NOA_ANTHROPIC_MODEL"),
          fetchFn: options.fetchFn,
          readSecret,
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

  const mistralModel =
    stringSetting(options.fileValues, "NOA_MISTRAL_MODEL") ??
    "mistral-large-latest";
  const anthropicModel =
    stringSetting(options.fileValues, "NOA_ANTHROPIC_MODEL") ??
    "claude-sonnet-4-5";

  const deps: CascadeDeps = {
    chatFor,
    chatForModel,
    localTiers: localTiers.order,
    tierDescriptions: localTiers.descriptions,
    tierTargets: localTiers.targets,
    gate,
    clouds,
    forced: forcedTargetOf(
      options.model,
      options.provider,
      mistralModel,
      anthropicModel,
    ),
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
 * Maps `--model`/`--provider` to a forced target. Without `--provider`,
 * `--model` is always an Ollama tag (or a `localN` tier, with legacy
 * aliases); with `--provider`, the model belongs to that cloud provider
 * (the provider's default model when `--model` is unset). Forced targets
 * bypass the judge, verification, and the cascade.
 */
export function forcedTargetOf(
  model: string | undefined,
  provider: string | undefined,
  mistralModel: string,
  anthropicModel: string,
): ForcedTarget | undefined {
  if (provider !== undefined) {
    if (provider !== "mistral" && provider !== "anthropic") {
      throw new Error(
        `unknown provider "${provider}" — use mistral or claude`,
      );
    }
    const defaultModel = provider === "mistral"
      ? mistralModel
      : anthropicModel;
    return {
      kind: "cloud",
      provider,
      model: model !== undefined && model !== "" ? model : defaultModel,
    };
  }
  if (model === undefined) return undefined;
  // Old, model-size-derived names still work as aliases onto positions.
  const aliases: Record<string, string> = {
    local3b: "local1",
    local8b: "local2",
    local14b: "local3",
  };
  const tier = aliases[model] ?? model;
  if (/^local\d+$/.test(tier)) return { kind: "tier", tier };
  return { kind: "model", model };
}

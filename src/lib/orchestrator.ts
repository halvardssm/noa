import { type NoaConfig, resolveList, SUGGESTED_TOOLS } from "./config.ts";
import {
  type ChatMessage,
  ollamaChat,
  type ToolSpec,
} from "./providers/ollama.ts";
import {
  anthropicProvider,
  type CloudProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MISTRAL_MODEL,
  hasKey,
  mistralProvider,
} from "./providers/cloud.ts";
import { createGate, type Gate } from "./tools.ts";
import {
  cascade,
  type CascadeDeps,
  type ChatFn,
  type ForcedTarget,
} from "./router.ts";
import { resolveTiers, type Tiers } from "./tiers.ts";
import { getLogger } from "./log.ts";
import { isWithin } from "./utils.ts";

/** The cloud providers, in the order the cascade falls back to them. */
const CLOUD_ORDER = ["mistral", "anthropic"] as const;

const logger = getLogger(["noa", "orchestrator"]);

/** Options for {@linkcode createApp}. */
export interface AppOptions {
  /** The config file's values; its `rules` are the model cascade. */
  readonly fileValues: NoaConfig;
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

/** Chats with one Ollama model — the shared transport of every local call. */
function chatWith(model: string): ChatFn {
  return (
    messages: readonly ChatMessage[],
    chatOptions?: { json?: boolean; tools?: readonly ToolSpec[] },
  ) =>
    ollamaChat({
      model,
      messages,
      json: chatOptions?.json,
      tools: chatOptions?.tools,
    });
}

/** Resolves the effective security settings: allowlist and allowed paths. */
function resolveSecurity(
  options: AppOptions,
  cwd: string,
): { allowTools: string[]; allowPaths: string[] } {
  // Deno-style permissions: a bare `--allow-tools` (parsed as "") is
  // the wildcard — every command; a value is an exact allowlist.
  const allowTools = options.allowToolsFlag === undefined
    ? []
    : options.allowToolsFlag === ""
    ? ["*"]
    : resolveList({ flag: options.allowToolsFlag, defaults: [] });
  const allowPaths = resolveList({
    flag: options.allowPathsFlag,
    defaults: [cwd],
  });

  if (allowTools.length === 0) {
    logger.debug(
      `no tools are allowed — pass --allow-tools (example: --allow-tools ${SUGGESTED_TOOLS})`,
    );
  }
  // The default path (the current directory) is only a fallback: warn
  // when it is outside the home so the default is never accidental.
  if (options.allowPathsFlag === undefined) {
    const home = Deno.env.get("HOME");
    if (home !== undefined && !isWithin(cwd, home)) {
      logger.debug(
        `allowing the current directory ${cwd}, which is outside your home — pass --allow-paths to choose deliberately`,
      );
    }
  }
  return { allowTools, allowPaths };
}

/**
 * Builds the chat function the cascade uses per purpose: `judge` and
 * `verify` run on the first Ollama model of the cascade, a tier purpose
 * on that tier's Ollama model.
 */
function chatForTiers(tiers: Tiers): (purpose: string) => ChatFn {
  const judgeModel = tiers.order.find((tier) =>
    tiers.targets[tier].provider === "ollama"
  );
  const judge = judgeModel === undefined
    ? undefined
    : tiers.targets[judgeModel].model;

  return (purpose: string): ChatFn => {
    const model = purpose === "judge" || purpose === "verify"
      ? judge
      : tiers.targets[purpose]?.provider === "ollama"
      ? tiers.targets[purpose].model
      : undefined;
    if (model === undefined) {
      throw new Error(
        `no ollama model configured for "${purpose}" — add rules to config.json`,
      );
    }
    return chatWith(model);
  };
}

/**
 * The cloud providers with a configured key, in cascade order. Keys are
 * read from the environment (never the config file — rule 8).
 */
function resolveClouds(): CloudProvider[] {
  const clouds: CloudProvider[] = [];
  for (const name of CLOUD_ORDER) {
    if (name === "mistral" && hasKey("MISTRAL_API_KEY")) {
      clouds.push(mistralProvider({}));
    } else if (name === "anthropic" && hasKey("ANTHROPIC_API_KEY")) {
      clouds.push(anthropicProvider({}));
    }
  }
  return clouds;
}

/** Assembles settings, gate, providers, and the cascade. */
export async function createApp(options: AppOptions): Promise<App> {
  const cwd = options.cwd ?? Deno.cwd();
  const { allowTools, allowPaths } = resolveSecurity(options, cwd);

  const gate = await createGate({
    allowTools,
    allowPaths,
    cwd: options.cwd,
  });

  const tiers = resolveTiers(options.fileValues.rules);
  const deps: CascadeDeps = {
    chatFor: chatForTiers(tiers),
    chatForModel: chatWith,
    localTiers: tiers.order,
    tierDescriptions: tiers.descriptions,
    tierTargets: tiers.targets,
    gate,
    clouds: resolveClouds(),
    forced: forcedTargetOf(
      options.model,
      options.provider,
      DEFAULT_MISTRAL_MODEL,
      DEFAULT_ANTHROPIC_MODEL,
    ),
    noVerify: options.noVerify,
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
 * `--model` is always an Ollama tag (or a `localN` tier); with
 * `--provider`, the model belongs to that cloud provider (the
 * provider's default model when `--model` is unset). Forced targets
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
    const defaultModel = provider === "mistral" ? mistralModel : anthropicModel;
    return {
      kind: "cloud",
      provider,
      model: model !== undefined && model !== "" ? model : defaultModel,
    };
  }
  if (model === undefined) return undefined;
  if (/^local\d+$/.test(model)) return { kind: "tier", tier: model };
  return { kind: "model", model };
}

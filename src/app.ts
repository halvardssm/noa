import { DEFAULT_ALLOW_TOOLS, defaultAllowPaths, resolveList } from "./config.ts";
import { ollamaChat } from "./ollama.ts";
import { mistralProvider } from "./cloud.ts";
import { createGate, type Gate } from "./tools.ts";
import { cascade, type CascadeDeps, type ChatFn } from "./router.ts";
import type { FetchFn } from "./http.ts";
import type { ChatMessage, ToolSpec } from "./ollama.ts";

/** The Ollama model behind each local tier. */
export const TIER_MODELS: Readonly<Record<string, string>> = {
  local3b: "ministral-3:3b",
  local8b: "ministral-3:8b",
  local14b: "ministral-3:14b",
};

/** Options for {@linkcode createApp}. */
export interface AppOptions {
  /** Process environment reader. */
  readonly env: { get(name: string): string | undefined };
  /** Values from the config `.env` file. */
  readonly fileValues: Record<string, string>;
  /** `--allow-tools` flag. */
  readonly allowToolsFlag?: string;
  /** `--allow-paths` flag. */
  readonly allowPathsFlag?: string;
  /** `--model` flag: local3b | local8b | local14b | mistral | claude. */
  readonly model?: string;
  /** `--no-verify`. */
  readonly noVerify?: boolean;
  /** Log sink (stderr in the CLI). */
  readonly onLog: (message: string) => void;
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
  const allowTools = resolveList({
    flag: options.allowToolsFlag,
    env: options.env.get("NOA_TOOLS"),
    file: options.fileValues["NOA_TOOLS"],
    defaults: DEFAULT_ALLOW_TOOLS,
  });
  const allowPaths = resolveList({
    flag: options.allowPathsFlag,
    env: options.env.get("NOA_ALLOW_PATHS"),
    file: options.fileValues["NOA_ALLOW_PATHS"],
    defaults: defaultAllowPaths(),
  });

  const gate = await createGate({
    allowTools,
    allowPaths,
    homeDir: options.env.get("HOME"),
    log: options.onLog,
  });

  const chatFor = (purpose: string): ChatFn =>
    (messages: readonly ChatMessage[], chatOptions?: {
      json?: boolean;
      tools?: readonly ToolSpec[];
    }) =>
      ollamaChat({
        model: TIER_MODELS[purpose] ?? TIER_MODELS.local3b,
        messages,
        json: chatOptions?.json,
        tools: chatOptions?.tools,
        fetchFn: options.fetchFn,
      });

  const apiKey = options.env.get("MISTRAL_API_KEY") ??
    options.fileValues["MISTRAL_API_KEY"] ?? "";
  const cloud = apiKey === ""
    ? undefined
    : mistralProvider({
      apiKey,
      fetchFn: options.fetchFn,
    });

  const deps: CascadeDeps = {
    chatFor,
    gate,
    cloud,
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
  if (model === "local3b" || model === "local8b" || model === "local14b") {
    return model;
  }
  if (model === "mistral") return "mistral";
  onLog(`model "${model}" is not supported yet — routing to mistral instead`);
  return "mistral";
}

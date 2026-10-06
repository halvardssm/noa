import type { FetchFn } from "./http.ts";

/**
 * A cloud provider (the cascade's final tier). Adding a provider is a
 * one-file job: implement this interface and register it.
 */
export interface CloudProvider {
  readonly name: string;
  /** The .env setting that must exist for this provider to be configured. */
  readonly keySetting: string;
  /** Answers the prompt; `model` overrides the provider's default. */
  chat(prompt: string, model?: string): Promise<string>;
}

/** Error carrying a user-facing remedy, without a stack trace. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Configuration of the Mistral provider. */
export interface MistralConfig {
  readonly apiKey: string;
  /** Model name; defaults to `mistral-large-latest`. */
  readonly model?: string;
  readonly fetchFn?: FetchFn;
}

/** Settings for a single Mistral Chat Completions call. */
export interface MistralOptions extends MistralConfig {
  /** The (improved) prompt to send. */
  readonly prompt: string;
}

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

/** Calls the Mistral Chat Completions API. */
export async function mistralChat(options: MistralOptions): Promise<string> {
  if (options.apiKey === "") {
    throw new ProviderError(
      "MISTRAL_API_KEY is not set — run `noa config set MISTRAL_API_KEY`",
    );
  }
  const fetchFn = options.fetchFn ?? fetch;
  const body = {
    model: options.model ?? "mistral-large-latest",
    messages: [{ role: "user", content: options.prompt }],
  };
  let response;
  try {
    response = await fetchFn(MISTRAL_URL, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderError(
      "could not reach api.mistral.ai — check your network connection",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(
      "Mistral rejected the key — run `noa config set MISTRAL_API_KEY`",
    );
  }
  if (!response.ok) {
    throw new ProviderError(`Mistral API: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new ProviderError("Mistral API returned no answer");
  }
  return content;
}

/** A `CloudProvider` backed by Mistral Chat Completions. */
export function mistralProvider(config: MistralConfig): CloudProvider {
  return {
    name: "mistral",
    keySetting: "MISTRAL_API_KEY",
    chat: (prompt, model) => mistralChat({ ...config, prompt, model }),
  };
}

/** Configuration of the Anthropic provider. */
export interface AnthropicConfig {
  readonly apiKey: string;
  /** Model name; defaults to `claude-sonnet-4-5`. */
  readonly model?: string;
  readonly fetchFn?: FetchFn;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Calls the Anthropic Messages API. */
export async function anthropicChat(
  options: { prompt: string } & AnthropicConfig,
): Promise<string> {
  if (options.apiKey === "") {
    throw new ProviderError(
      "ANTHROPIC_API_KEY is not set — run `noa config set ANTHROPIC_API_KEY`",
    );
  }
  const fetchFn = options.fetchFn ?? fetch;
  const body = {
    model: options.model ?? "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: options.prompt }],
  };
  let response;
  try {
    response = await fetchFn(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderError(
      "could not reach api.anthropic.com — check your network connection",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(
      "Anthropic rejected the key — run `noa config set ANTHROPIC_API_KEY`",
    );
  }
  if (!response.ok) {
    throw new ProviderError(`Anthropic API: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    content?: { type?: string; text?: string }[];
  };
  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (text === undefined) {
    throw new ProviderError("Anthropic API returned no answer");
  }
  return text;
}

/** A `CloudProvider` backed by the Anthropic Messages API. */
export function anthropicProvider(config: AnthropicConfig): CloudProvider {
  return {
    name: "anthropic",
    keySetting: "ANTHROPIC_API_KEY",
    chat: (prompt, model) => anthropicChat({ ...config, prompt, model }),
  };
}

import type { FetchFn } from "./http.ts";

/**
 * A cloud provider (the cascade's final tier). Adding a provider is a
 * one-file job: implement this interface and register it.
 */
export interface CloudProvider {
  readonly name: string;
  /** Answers the improved prompt. */
  chat(prompt: string): Promise<string>;
}

/** Error carrying a user-facing remedy, without a stack trace. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Settings for the Mistral Chat Completions provider. */
export interface MistralOptions {
  /** The (improved) prompt to send. */
  readonly prompt: string;
  readonly apiKey: string;
  /** Model name; defaults to `mistral-large-latest`. */
  readonly model?: string;
  readonly fetchFn?: FetchFn;
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
export function mistralProvider(options: MistralOptions): CloudProvider {
  return {
    name: "mistral",
    chat: (prompt) => mistralChat({ ...options, prompt }),
  };
}

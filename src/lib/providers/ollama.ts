/** A chat message in the shape both Ollama and the cloud providers use. */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Tool-call bookkeeping for Ollama's agent loop, opaque to callers. */
  readonly toolCalls?: unknown;
  /** Name of the tool that produced a `tool` message. */
  readonly toolName?: string;
}

/** A function tool offered to a local model. */
export interface ToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Record<string, unknown>;
      readonly required: readonly string[];
    };
  };
}

/** A tool call the model requested. */
export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** The parsed answer of a chat request. */
export interface ChatAnswer {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

/** Where the Ollama daemon listens. */
export const OLLAMA_BASE_URL = "http://localhost:11434";

/** Resolves the daemon base URL: `$OLLAMA_HOST` or the default. */
export function ollamaBaseUrl(): string {
  const host = Deno.env.get("OLLAMA_HOST");
  if (host === undefined || host === "") return OLLAMA_BASE_URL;
  const stripped = host.replace(/\/$/, "");
  return /^https?:\/\//.test(stripped) ? stripped : `http://${stripped}`;
}

interface OllamaChatOptions {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  /** Ask Ollama to constrain the output to JSON. */
  readonly json?: boolean;
  /** Context window; defaults to 8192 to cap memory (spec: pinned 8k). */
  readonly numCtx?: number;
  /** Idle time before Ollama unloads the model; defaults to 5m (spec). */
  readonly keepAlive?: string;
  readonly baseUrl?: string;
}

interface OllamaMessage {
  role?: string;
  content?: string;
  tool_calls?: {
    function?: { name?: string; arguments?: unknown };
  }[];
}

/** Maps a ChatMessage to Ollama's wire format (tool_calls, tool_name). */
function toWire(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCalls !== undefined) wire.tool_calls = message.toolCalls;
  if (message.toolName !== undefined) wire.tool_name = message.toolName;
  return wire;
}

/**
 * Talks to the local Ollama daemon over HTTP (rule 6: noa never spawns it).
 * Throws with a clear hint when the daemon is down.
 */
export async function ollamaChat(
  options: OllamaChatOptions,
): Promise<ChatAnswer> {
  const baseUrl = options.baseUrl ?? ollamaBaseUrl();
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages.map(toWire),
    stream: false,
  };
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools;
  }
  if (options.json) body.format = "json";
  body.options = { num_ctx: options.numCtx ?? 8192 };
  body.keep_alive = options.keepAlive ?? "5m";

  const request = () =>
    fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let response;
  try {
    response = await request();
  } catch {
    throw new Error(
      `Ollama is not running at ${baseUrl} — start it with \`ollama serve\``,
    );
  }
  if (!response.ok) {
    const hint = response.status === 404
      ? ` — is the model pulled? run \`ollama pull ${options.model}\``
      : "";
    throw new Error(`Ollama ${options.model}: HTTP ${response.status}${hint}`);
  }
  const payload = response.json() as Promise<{
    message?: OllamaMessage;
  }>;
  const message = (await payload).message ?? {};
  const toolCalls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    if (call.function?.name === undefined) continue;
    const args = call.function.arguments;
    toolCalls.push({
      name: call.function.name,
      args: (typeof args === "object" && args !== null ? args : {}) as Record<
        string,
        unknown
      >,
    });
  }
  return { content: message.content ?? "", toolCalls };
}

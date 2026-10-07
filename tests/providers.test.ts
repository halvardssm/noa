import { assert, assertEquals, assertRejects } from "@std/assert";
import { ollamaChat, ollamaIsUp } from "../src/ollama.ts";
import { anthropicChat, mistralChat } from "../src/cloud.ts";
import type { FetchFn, ResponseLike } from "../src/http.ts";

function jsonResponse(body: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

Deno.test("ollama: sends the expected chat request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return jsonResponse({
      message: { role: "assistant", content: "4" },
    });
  };
  const answer = await ollamaChat({
    model: "ministral-3:3b",
    messages: [{ role: "user", content: "what is 2+2" }],
    json: true,
    fetchFn,
  });
  assertEquals(answer.content, "4");
  assertEquals(answer.toolCalls, []);
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(calls[0].url, "http://localhost:11434/api/chat");
  assertEquals(body.model, "ministral-3:3b");
  assertEquals(body.format, "json");
  assertEquals(body.stream, false);
  assertEquals(body.messages, [{ role: "user", content: "what is 2+2" }]);
});

Deno.test("ollama: passes tools and parses tool calls", async () => {
  const tools = [{
    type: "function" as const,
    function: {
      name: "run",
      description: "run a command",
      parameters: {
        type: "object" as const,
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
      },
    },
  }];
  const fetchFn: FetchFn = async () =>
    jsonResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          function: {
            name: "run",
            arguments: { command: "ls", args: ["-la"] },
          },
        }],
      },
    });
  const answer = await ollamaChat({
    model: "ministral-3:3b",
    messages: [{ role: "user", content: "list files" }],
    tools,
    fetchFn,
  });
  assertEquals(answer.toolCalls, [{
    name: "run",
    args: { command: "ls", args: ["-la"] },
  }]);
});

Deno.test("ollama: connection refused gives a clear daemon hint", async () => {
  const fetchFn: FetchFn = () => Promise.reject(new TypeError("connect refused"));
  await assertRejects(
    () =>
      ollamaChat({
        model: "ministral-3:3b",
        messages: [{ role: "user", content: "hi" }],
        fetchFn,
      }),
    Error,
    "Ollama is not running",
  );
});

Deno.test("ollama: HTTP errors carry the status", async () => {
  const fetchFn: FetchFn = async () => jsonResponse({ error: "boom" }, 500);
  await assertRejects(
    () =>
      ollamaChat({
        model: "ministral-3:3b",
        messages: [{ role: "user", content: "hi" }],
        fetchFn,
      }),
    Error,
    "500",
  );
});

Deno.test("ollamaIsUp: true on a listening daemon, false when down", async () => {
  const up: FetchFn = async () => jsonResponse({ models: [] });
  const down: FetchFn = () => Promise.reject(new TypeError("refused"));
  assertEquals(await ollamaIsUp("http://localhost:11434", up), true);
  assertEquals(await ollamaIsUp("http://localhost:11434", down), false);
});

Deno.test("mistral: sends the chat completion request with auth", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "cloud answer" } }],
    });
  };
  const answer = await mistralChat({
    prompt: "improved prompt",
    readSecret: () => "sk-test",
    fetchFn,
  });
  assertEquals(answer, "cloud answer");
  assertEquals(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
  const headers = new Headers(calls[0].init.headers);
  assertEquals(headers.get("authorization"), "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.model, "mistral-large-latest");
  assertEquals(body.messages[0].role, "system");
  assert(body.messages[0].content.includes("Today's date"));
  assertEquals(body.messages[1], { role: "user", content: "improved prompt" });
});

Deno.test("mistral: model is configurable", async () => {
  const fetchFn: FetchFn = async () =>
    jsonResponse({ choices: [{ message: { content: "x" } }] });
  await mistralChat({ prompt: "p", readSecret: () => "k", model: "mistral-small-latest", fetchFn });
});

Deno.test("mistral: missing key fails before any request", async () => {
  let called = false;
  const fetchFn: FetchFn = async () => {
    called = true;
    return jsonResponse({});
  };
  const error = await assertRejects(
    () => mistralChat({ prompt: "p", readSecret: () => undefined, fetchFn }),
    Error,
  );
  assert(error.message.includes("MISTRAL_API_KEY"));
  assert(error.message.includes("export it in your shell"));
  assert(!called);
});

Deno.test("mistral: auth errors name the key setting", async () => {
  const fetchFn: FetchFn = async () => jsonResponse({ message: "bad key" }, 401);
  await assertRejects(
    () => mistralChat({ prompt: "p", readSecret: () => "wrong", fetchFn }),
    Error,
    "MISTRAL_API_KEY",
  );
});

Deno.test("anthropic: sends the messages request with the right headers", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return jsonResponse({ content: [{ type: "text", text: "claude answer" }] });
  };
  const answer = await anthropicChat({
    prompt: "improved prompt",
    readSecret: () => "sk-ant-test",
    fetchFn,
  });
  assertEquals(answer, "claude answer");
  assertEquals(calls[0].url, "https://api.anthropic.com/v1/messages");
  const headers = new Headers(calls[0].init.headers);
  assertEquals(headers.get("x-api-key"), "sk-ant-test");
  assertEquals(headers.get("anthropic-version"), "2023-06-01");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.model, "claude-sonnet-4-5");
  assertEquals(body.messages[0].role, "system");
  assert(body.messages[0].content.includes("Today's date"));
  assertEquals(body.messages[1], { role: "user", content: "improved prompt" });
});

Deno.test("anthropic: missing key fails before any request", async () => {
  let called = false;
  const fetchFn: FetchFn = async () => {
    called = true;
    return jsonResponse({});
  };
  await assertRejects(
    () => anthropicChat({ prompt: "p", readSecret: () => undefined, fetchFn }),
    Error,
    "ANTHROPIC_API_KEY",
  );
  assert(!called);
});

Deno.test("anthropic: auth errors name the key setting", async () => {
  const fetchFn: FetchFn = async () => jsonResponse({ message: "bad" }, 401);
  await assertRejects(
    () => anthropicChat({ prompt: "p", readSecret: () => "wrong", fetchFn }),
    Error,
    "ANTHROPIC_API_KEY",
  );
});

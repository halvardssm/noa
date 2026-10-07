import { assert, assertEquals, assertRejects } from "@std/assert";
import { ollamaChat } from "../src/lib/providers/ollama-old.ts";
import { ollamaIsUp } from "../src/lib/ollama.ts";
import { anthropicChat, mistralChat } from "../src/lib/providers/cloud.ts";
import { type FetchStub, jsonResponse, withEnv, withFetch } from "./helpers.ts";

Deno.test("ollama: sends the expected chat request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub: FetchStub = (url, init) => {
    calls.push({ url: String(url), init: init! });
    return jsonResponse({
      message: { role: "assistant", content: "4" },
    });
  };
  await withFetch(stub, async () => {
    const answer = await ollamaChat({
      model: "ministral-3:3b",
      messages: [{ role: "user", content: "what is 2+2" }],
      json: true,
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
  await withFetch(
    () =>
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
      }),
    async () => {
      const answer = await ollamaChat({
        model: "ministral-3:3b",
        messages: [{ role: "user", content: "list files" }],
        tools,
      });
      assertEquals(answer.toolCalls, [{
        name: "run",
        args: { command: "ls", args: ["-la"] },
      }]);
    },
  );
});

Deno.test("ollama: connection refused gives a clear daemon hint", async () => {
  await withFetch(
    () => Promise.reject(new TypeError("connect refused")),
    async () => {
      await assertRejects(
        () =>
          ollamaChat({
            model: "ministral-3:3b",
            messages: [{ role: "user", content: "hi" }],
          }),
        Error,
        "Ollama is not running",
      );
    },
  );
});

Deno.test("ollama: HTTP errors carry the status", async () => {
  await withFetch(
    () => jsonResponse({ error: "boom" }, 500),
    async () => {
      await assertRejects(
        () =>
          ollamaChat({
            model: "ministral-3:3b",
            messages: [{ role: "user", content: "hi" }],
          }),
        Error,
        "500",
      );
    },
  );
});

Deno.test("ollamaIsUp: true on a listening daemon, false when down", async () => {
  await withFetch(() => jsonResponse({ version: "0.12.0" }), async () => {
    assertEquals(await ollamaIsUp(), true);
  });
  await withFetch(
    () => Promise.reject(new TypeError("refused")),
    async () => {
      assertEquals(await ollamaIsUp(), false);
    },
  );
});

Deno.test("mistral: sends the chat completion request with auth", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub: FetchStub = (url, init) => {
    calls.push({ url: String(url), init: init! });
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "cloud answer" } }],
    });
  };
  await withEnv(
    { MISTRAL_API_KEY: "sk-test" },
    () =>
      withFetch(stub, async () => {
        const answer = await mistralChat({ prompt: "improved prompt" });
        assertEquals(answer, "cloud answer");
        assertEquals(
          calls[0].url,
          "https://api.mistral.ai/v1/chat/completions",
        );
        const headers = new Headers(calls[0].init.headers);
        assertEquals(headers.get("authorization"), "Bearer sk-test");
        const body = JSON.parse(calls[0].init.body as string);
        assertEquals(body.model, "mistral-large-latest");
        assertEquals(body.messages, [{
          role: "user",
          content: "improved prompt",
        }]);
      }),
  );
});

Deno.test("mistral: model is configurable", async () => {
  await withEnv({ MISTRAL_API_KEY: "k" }, () =>
    withFetch(
      () => jsonResponse({ choices: [{ message: { content: "x" } }] }),
      async () => {
        await mistralChat({ prompt: "p", model: "mistral-small-latest" });
      },
    ));
});

Deno.test("mistral: missing key fails before any request", async () => {
  let called = false;
  const stub: FetchStub = () => {
    called = true;
    return jsonResponse({});
  };
  await withEnv(
    { MISTRAL_API_KEY: undefined },
    () =>
      withFetch(stub, async () => {
        const error = await assertRejects(
          () => mistralChat({ prompt: "p" }),
          Error,
        );
        assert(error.message.includes("MISTRAL_API_KEY"));
        assert(error.message.includes("export it in your shell"));
        assert(!called);
      }),
  );
});

Deno.test("mistral: auth errors name the key setting", async () => {
  await withEnv(
    { MISTRAL_API_KEY: "wrong" },
    () =>
      withFetch(
        () => jsonResponse({ message: "bad key" }, 401),
        async () => {
          await assertRejects(
            () => mistralChat({ prompt: "p" }),
            Error,
            "MISTRAL_API_KEY",
          );
        },
      ),
  );
});

Deno.test("anthropic: sends the messages request with the right headers", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub: FetchStub = (url, init) => {
    calls.push({ url: String(url), init: init! });
    return jsonResponse({ content: [{ type: "text", text: "claude answer" }] });
  };
  await withEnv(
    { ANTHROPIC_API_KEY: "sk-ant-test" },
    () =>
      withFetch(stub, async () => {
        const answer = await anthropicChat({ prompt: "improved prompt" });
        assertEquals(answer, "claude answer");
        assertEquals(calls[0].url, "https://api.anthropic.com/v1/messages");
        const headers = new Headers(calls[0].init.headers);
        assertEquals(headers.get("x-api-key"), "sk-ant-test");
        assertEquals(headers.get("anthropic-version"), "2023-06-01");
        const body = JSON.parse(calls[0].init.body as string);
        assertEquals(body.model, "claude-sonnet-4-5");
        assertEquals(body.messages, [{
          role: "user",
          content: "improved prompt",
        }]);
      }),
  );
});

Deno.test("anthropic: missing key fails before any request", async () => {
  let called = false;
  const stub: FetchStub = () => {
    called = true;
    return jsonResponse({});
  };
  await withEnv(
    { ANTHROPIC_API_KEY: undefined },
    () =>
      withFetch(stub, async () => {
        await assertRejects(
          () => anthropicChat({ prompt: "p" }),
          Error,
          "ANTHROPIC_API_KEY",
        );
        assert(!called);
      }),
  );
});

Deno.test("anthropic: auth errors name the key setting", async () => {
  await withEnv(
    { ANTHROPIC_API_KEY: "wrong" },
    () =>
      withFetch(() => jsonResponse({ message: "bad" }, 401), async () => {
        await assertRejects(
          () => anthropicChat({ prompt: "p" }),
          Error,
          "ANTHROPIC_API_KEY",
        );
      }),
  );
});

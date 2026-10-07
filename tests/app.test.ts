import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../src/app.ts";
import { jsonResponse, withEnv, withErrors, withFetch, type FetchStub } from "./helpers.ts";

function ollamaBody(content: string) {
  return jsonResponse({ message: { role: "assistant", content } });
}

const JUDGE_3B = JSON.stringify({
  tier: "local1",
  reason: "trivial",
  improved_prompt: "improved",
});
const VERIFY_PASS = JSON.stringify({ verdict: "PASS", reason: "ok" });

Deno.test("app: resolves allowlist and paths by precedence", async () => {
  const app = await createApp({
    fileValues: { NOA_TOOLS: "git", NOA_ALLOW_PATHS: "~/dev,~/work" },
    allowToolsFlag: "jq,rg",
  });
  assertEquals(app.allowTools, ["jq", "rg"]);
  assertEquals(app.allowPaths, ["~/dev", "~/work"]);
});

Deno.test("app: no configured tools means no tools, with a hint", async () => {
  await withErrors(async (logged) => {
    const app = await createApp({ fileValues: {}, debug: true });
    assertEquals(app.allowTools, []);
    assert(
      logged.some((m) => m.includes("--allow-tools") && m.includes("ls,cat")),
    );
  });
});

Deno.test("app: default allowed path is the current directory", async () => {
  const app = await createApp({
    fileValues: {},
    cwd: "/somewhere/inside/project",
  });
  assertEquals(app.allowPaths, ["/somewhere/inside/project"]);
});

Deno.test("app: warns when the default path is outside home, not when configured", async () => {
  await withErrors(async (logged) => {
    await createApp({ fileValues: {}, cwd: "/srv/project", debug: true });
    assert(logged.some((m) => m.includes("outside your home")));

    // An explicit choice (flag or config) never warns.
    logged.length = 0;
    await createApp({
      fileValues: {},
      allowPathsFlag: "/srv/project",
      cwd: "/srv/project",
      debug: true,
    });
    assert(!logged.some((m) => m.includes("outside your home")));

    await createApp({
      fileValues: { NOA_ALLOW_PATHS: "/srv/project" },
      cwd: "/srv/project",
      debug: true,
    });
    assert(!logged.some((m) => m.includes("outside your home")));

    // Inside home: no warning either.
    const home = Deno.env.get("HOME") ?? "/root";
    await createApp({
      fileValues: {},
      cwd: `${home}/dev`,
      debug: true,
    });
    assert(!logged.some((m) => m.includes("outside your home")));
  });
});

Deno.test("app: falls back to defaults for missing settings", async () => {
  const app = await createApp({ fileValues: {}, cwd: "/work/project" });
  assertEquals(app.allowTools, []);
  assertEquals(app.allowPaths, ["/work/project"]);
});

Deno.test("app: ask routes through the local cascade end to end", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(body.model);
    const user = body.messages?.[body.messages.length - 1]?.content ?? "";
    if (body.format === "json" && user.startsWith("Question:")) {
      return ollamaBody(VERIFY_PASS);
    }
    if (body.format === "json") return ollamaBody(JUDGE_3B);
    return ollamaBody("4");
  };
  await withFetch(stub, async () => {
    const app = await createApp({ fileValues: {} });
    const answer = await app.ask("what is 2+2");
    assertEquals(answer, "4");
    assert(seen.includes("ministral-3:3b"));
  });
});

Deno.test("app: forced mistral without a key gives the export remedy", async () => {
  await withEnv({ MISTRAL_API_KEY: undefined }, async () => {
    const app = await createApp({ fileValues: {}, provider: "mistral" });
    const error = await assertRejects(() => app.ask("hard task"), Error);
    assert(error.message.includes("export MISTRAL_API_KEY"));
  });
});

Deno.test("app: keys stored in the config file are ignored with a warning", async () => {
  await withErrors(async (logged) => {
    const app = await createApp({
      fileValues: { MISTRAL_API_KEY: "legacy-stored-key" },
      debug: true,
    });
    assert(
      logged.some((l) => l.includes("MISTRAL_API_KEY in config.json is ignored")),
    );
    assertEquals(app.allowTools, []);
  });
});

Deno.test("app: forced mistral receives the raw question (no upgrade steps)", async () => {
  const prompts: string[] = [];
  const stub: FetchStub = async (url, init) => {
    if (String(url).includes("mistral.ai")) {
      prompts.push(
        JSON.parse((init as RequestInit).body as string).messages[0].content,
      );
      return jsonResponse({ choices: [{ message: { content: "cloud answer" } }] });
    }
    const body = JSON.parse((init as RequestInit).body as string);
    if (body.format === "json" && body.messages.length === 2) {
      return ollamaBody(JUDGE_3B);
    }
    if (body.format === "json") return ollamaBody(VERIFY_PASS);
    return ollamaBody("local answer");
  };
  await withEnv({ MISTRAL_API_KEY: "sk-test" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({
        fileValues: {},
        provider: "mistral",
      });
      const answer = await app.ask("hard task");
      assertEquals(answer, "cloud answer");
      assertEquals(prompts, ["hard task"]);
    })
  );
});

Deno.test("app: custom local models are used per tier", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(body.model);
    const user = body.messages?.[body.messages.length - 1]?.content ?? "";
    if (body.format === "json" && user.startsWith("Question:")) {
      return ollamaBody(VERIFY_PASS);
    }
    if (body.format === "json") {
      return ollamaBody(
        JSON.stringify({ tier: "local2", reason: "x", improved_prompt: "p" }),
      );
    }
    return ollamaBody("custom answer");
  };
  await withFetch(stub, async () => {
    const app = await createApp({
      fileValues: {
        models: [
          { model: "qwen3:4b", description: "chat" },
          { model: "llama3.1:8b", description: "code" },
        ],
      },
    });
    const answer = await app.ask("moderate question");
    assertEquals(answer, "custom answer");
    assert(seen.includes("qwen3:4b"), "judge runs on the first configured model");
    assert(seen.includes("llama3.1:8b"), "the judged tier uses the user's model");
  });
});

Deno.test("app: a single-model cascade works", async () => {
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    const user = body.messages?.[body.messages.length - 1]?.content ?? "";
    if (body.format === "json" && user.startsWith("Question:")) {
      return ollamaBody(VERIFY_PASS);
    }
    if (body.format === "json") {
      return ollamaBody(
        JSON.stringify({ tier: "local1", reason: "x", improved_prompt: "p" }),
      );
    }
    return ollamaBody("only answer");
  };
  await withFetch(stub, async () => {
    const app = await createApp({
      fileValues: { models: [{ model: "qwen3:4b", description: "everything" }] },
    });
    const answer = await app.ask("any question");
    assertEquals(answer, "only answer");
  });
});

Deno.test("app: with an explicit empty models list, the raw question goes to cloud", async () => {
  const prompts: string[] = [];
  const stub: FetchStub = async (url, init) => {
    if (String(url).includes("mistral.ai")) {
      prompts.push(
        JSON.parse((init as RequestInit).body as string).messages[0].content,
      );
      return jsonResponse({ choices: [{ message: { content: "cloud" } }] });
    }
    throw new Error("no ollama call expected");
  };
  await withEnv({ MISTRAL_API_KEY: "sk" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({ fileValues: { models: [] } });
      const answer = await app.ask("the raw question");
      assertEquals(answer, "cloud");
      assertEquals(prompts, ["the raw question"]);
    })
  );
});

Deno.test("app: forcing an unconfigured tier names the config", async () => {
  const app = await createApp({
    fileValues: { models: [{ model: "qwen3:4b" }] },
    model: "local2",
  });
  const error = await assertRejects(() => app.ask("q"), Error);
  assert(error.message.includes("local2"));
  assert(error.message.includes("config.json"));
});

Deno.test("app: local tier aliases from --model still resolve", async () => {
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    if (body.format === "json") {
      return ollamaBody(
        JSON.stringify({ tier: "local1", reason: "x", improved_prompt: "p" }),
      );
    }
    return ollamaBody("aliased answer");
  };
  await withFetch(stub, async () => {
    const app = await createApp({ fileValues: {}, model: "local8b" });
    const answer = await app.ask("q");
    assertEquals(answer, "aliased answer");
  });
});

Deno.test("app: cloud order follows NOA_CLOUD with only configured providers", async () => {
  const prompts: string[] = [];
  const stub: FetchStub = async (url, init) => {
    if (String(url).includes("anthropic.com")) {
      prompts.push(
        JSON.parse((init as RequestInit).body as string).messages[0].content,
      );
      return jsonResponse({ content: [{ type: "text", text: "anthropic" }] });
    }
    if (String(url).includes("mistral.ai")) {
      prompts.push(
        JSON.parse((init as RequestInit).body as string).messages[0].content,
      );
      return jsonResponse({ choices: [{ message: { content: "mistral" } }] });
    }
    const body = JSON.parse((init as RequestInit).body as string);
    if (body.format === "json" && body.messages.length === 2) {
      return ollamaBody(JUDGE_3B);
    }
    if (body.format === "json") return ollamaBody(VERIFY_PASS);
    return ollamaBody("local answer");
  };
  // Only anthropic is configured; mistral in the order is skipped.
  await withEnv({ ANTHROPIC_API_KEY: "sk-ant" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({
        fileValues: { NOA_CLOUD: "mistral,anthropic" },
        provider: "anthropic",
      });
      const answer = await app.ask("hard task");
      assertEquals(answer, "anthropic");
      assertEquals(prompts, ["hard task"]);
    })
  );
});

Deno.test("app: --model with an Ollama tag uses that model directly", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(body.model);
    return ollamaBody("direct model answer");
  };
  await withFetch(stub, async () => {
    const app = await createApp({ fileValues: {}, model: "qwen3:4b" });
    const answer = await app.ask("the raw question");
    assertEquals(answer, "direct model answer");
    assertEquals(seen, ["qwen3:4b"]);
  });
});

Deno.test("app: forcedTargetOf maps ollama tags, tiers, and provider pairs", async () => {
  const { forcedTargetOf } = await import("../src/app.ts");
  const M = "mistral-large-latest";
  const C = "claude-sonnet-4-5";
  // Without --provider, --model is always Ollama.
  assertEquals(forcedTargetOf("ministral-3:8b", undefined, M, C), {
    kind: "model",
    model: "ministral-3:8b",
  });
  assertEquals(forcedTargetOf("mistral-large-latest", undefined, M, C), {
    kind: "model",
    model: "mistral-large-latest",
  });
  assertEquals(forcedTargetOf("local2", undefined, M, C), { kind: "tier", tier: "local2" });
  assertEquals(forcedTargetOf("local8b", undefined, M, C), { kind: "tier", tier: "local2" });
  assertEquals(forcedTargetOf(undefined, undefined, M, C), undefined);
  // With --provider, the model belongs to that cloud provider.
  assertEquals(forcedTargetOf("mistral-small-latest", "mistral", M, C), {
    kind: "cloud",
    provider: "mistral",
    model: "mistral-small-latest",
  });
  assertEquals(forcedTargetOf(undefined, "anthropic", M, C), {
    kind: "cloud",
    provider: "anthropic",
    model: C,
  });
  assertEquals(forcedTargetOf(undefined, "mistral", M, C), {
    kind: "cloud",
    provider: "mistral",
    model: M,
  });
  let error: unknown;
  try {
    forcedTargetOf("x", "openai", M, C);
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error && error.message.includes("unknown provider"));
});

Deno.test("app: a cloud model inside the models cascade is served by its provider", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (url, init) => {
    const u = String(url);
    if (u.includes("mistral.ai")) {
      seen.push(
        "cloud:" + JSON.parse((init as RequestInit).body as string).model,
      );
      return jsonResponse({ choices: [{ message: { content: "cloud tier" } }] });
    }
    const body = JSON.parse((init as RequestInit).body as string);
    const user = body.messages?.[body.messages.length - 1]?.content ?? "";
    if (body.format === "json" && user.startsWith("Question:")) {
      return ollamaBody(VERIFY_PASS);
    }
    if (body.format === "json") {
      return ollamaBody(
        JSON.stringify({ tier: "local2", reason: "x", improved_prompt: "improved" }),
      );
    }
    return ollamaBody("local tier");
  };
  await withEnv({ MISTRAL_API_KEY: "sk" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({
        fileValues: {
          models: [
            { model: "ministral-3:3b", description: "easy" },
            { model: "mistral-small-latest", provider: "mistral", description: "hard" },
          ],
        },
      });
      const answer = await app.ask("hard task");
      assertEquals(answer, "cloud tier");
      assert(seen.includes("cloud:mistral-small-latest"));
    })
  );
});

Deno.test("app: --provider forces the cloud provider for the model", async () => {
  const seen: { url: string; model: string }[] = [];
  const stub: FetchStub = async (url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push({ url: String(url), model: body.model });
    return jsonResponse({ choices: [{ message: { content: "forced cloud" } }] });
  };
  await withEnv({ MISTRAL_API_KEY: "sk" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({
        fileValues: {},
        model: "mistral-small-latest",
        provider: "mistral",
      });
      const answer = await app.ask("the raw question");
      assertEquals(answer, "forced cloud");
      assertEquals(seen[0].url.includes("mistral.ai"), true);
      assertEquals(seen[0].model, "mistral-small-latest");
    })
  );
});

Deno.test("app: an unknown provider is rejected", async () => {
  await assertRejects(
    () =>
      createApp({
        fileValues: {},
        model: "mistral-small-latest",
        provider: "openai",
      }),
    Error,
    "unknown provider",
  );
});

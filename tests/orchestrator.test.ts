import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../src/lib/orchestrator.ts";
import {
  type FetchStub,
  jsonResponse,
  withEnv,
  withFetch,
  withLogRecords,
} from "./helpers.ts";

function ollamaBody(content: string) {
  return jsonResponse({ message: { role: "assistant", content } });
}

const JUDGE_1 = JSON.stringify({
  tier: "local1",
  reason: "trivial",
  improved_prompt: "improved",
});
const VERIFY_PASS = JSON.stringify({ verdict: "PASS", reason: "ok" });

/** One Ollama rule for the config. */
function rule(model: string, complexity: number, description?: string) {
  return {
    complexity,
    provider: "ollama" as const,
    model,
    ...(description !== undefined ? { description } : {}),
  };
}

Deno.test("app: no configured tools means no tools, with a hint", async () => {
  await withLogRecords(async (records) => {
    const app = await createApp({ fileValues: { rules: [] } });
    assertEquals(app.allowTools, []);
    const logged = records.map((r) => r.message.join(""));
    assert(
      logged.some((m) => m.includes("--allow-tools") && m.includes("ls,cat")),
    );
  });
});

Deno.test("app: resolves allowlist and paths from the flags", async () => {
  const app = await createApp({
    fileValues: { rules: [] },
    allowToolsFlag: "jq,rg",
    allowPathsFlag: "~/dev,~/work",
  });
  assertEquals(app.allowTools, ["jq", "rg"]);
  assertEquals(app.allowPaths, ["~/dev", "~/work"]);
});

Deno.test("app: default allowed path is the current directory", async () => {
  const app = await createApp({
    fileValues: { rules: [] },
    cwd: "/somewhere/inside/project",
  });
  assertEquals(app.allowPaths, ["/somewhere/inside/project"]);
});

Deno.test("app: warns when the default path is outside home, not when configured", async () => {
  await withLogRecords(async (records) => {
    const logged = () => records.map((r) => r.message.join(""));
    await createApp({ fileValues: { rules: [] }, cwd: "/srv/project" });
    assert(logged().some((m) => m.includes("outside your home")));

    // An explicit choice never warns.
    records.length = 0;
    await createApp({
      fileValues: { rules: [] },
      allowPathsFlag: "/srv/project",
      cwd: "/srv/project",
    });
    assert(!logged().some((m) => m.includes("outside your home")));

    // Inside home: no warning either.
    records.length = 0;
    const home = Deno.env.get("HOME") ?? "/root";
    await createApp({ fileValues: { rules: [] }, cwd: `${home}/dev` });
    assert(!logged().some((m) => m.includes("outside your home")));
  });
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
    if (body.format === "json") return ollamaBody(JUDGE_1);
    return ollamaBody("4");
  };
  await withFetch(stub, async () => {
    const app = await createApp({
      fileValues: {
        rules: [rule("ministral-3:3b", 1), rule("ministral-3:8b", 2)],
      },
    });
    const answer = await app.ask("what is 2+2");
    assertEquals(answer, "4");
    assert(seen.includes("ministral-3:3b"));
  });
});

Deno.test("app: forced mistral without a key gives the export remedy", async () => {
  await withEnv({ MISTRAL_API_KEY: undefined }, async () => {
    const app = await createApp({
      fileValues: { rules: [] },
      provider: "mistral",
    });
    const error = await assertRejects(() => app.ask("hard task"), Error);
    assert(error.message.includes("export MISTRAL_API_KEY"));
  });
});

Deno.test("app: custom local rules are used per tier", async () => {
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
        rules: [
          rule("qwen3:4b", 1, "chat"),
          rule("llama3.1:8b", 2, "code"),
        ],
      },
    });
    const answer = await app.ask("moderate question");
    assertEquals(answer, "custom answer");
    assert(seen.includes("qwen3:4b"), "judge runs on the first rule");
    assert(
      seen.includes("llama3.1:8b"),
      "the judged tier uses the user's model",
    );
  });
});

Deno.test("app: rules are ordered by complexity, not file order", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(body.model);
    if (body.format === "json") {
      return ollamaBody(
        JSON.stringify({ tier: "local1", reason: "x", improved_prompt: "p" }),
      );
    }
    return ollamaBody("smallest answered");
  };
  await withFetch(stub, async () => {
    const app = await createApp({
      fileValues: {
        // Written big-to-small; complexity 1 must become local1.
        rules: [rule("big:14b", 3), rule("small:3b", 1)],
      },
    });
    const answer = await app.ask("q");
    assertEquals(answer, "smallest answered");
    assert(seen.includes("small:3b"));
  });
});

Deno.test("app: a single-rule cascade works", async () => {
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
      fileValues: { rules: [rule("qwen3:4b", 1, "everything")] },
    });
    const answer = await app.ask("any question");
    assertEquals(answer, "only answer");
  });
});

Deno.test("app: with empty rules, the raw question goes to cloud", async () => {
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
      const app = await createApp({ fileValues: { rules: [] } });
      const answer = await app.ask("the raw question");
      assertEquals(answer, "cloud");
      assertEquals(prompts, ["the raw question"]);
    }));
});

Deno.test("app: forcing an unconfigured tier names the config", async () => {
  const app = await createApp({
    fileValues: { rules: [rule("qwen3:4b", 1)] },
    model: "local2",
  });
  const error = await assertRejects(() => app.ask("q"), Error);
  assert(error.message.includes("local2"));
  assert(error.message.includes("rules list"));
});

Deno.test("app: --model with an Ollama tag uses that model directly", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(body.model);
    return ollamaBody("direct model answer");
  };
  await withFetch(stub, async () => {
    const app = await createApp({
      fileValues: { rules: [] },
      model: "qwen3:4b",
    });
    const answer = await app.ask("the raw question");
    assertEquals(answer, "direct model answer");
    assertEquals(seen, ["qwen3:4b"]);
  });
});

Deno.test("app: only the configured cloud providers are offered, in order", async () => {
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
      return ollamaBody(JUDGE_1);
    }
    if (body.format === "json") return ollamaBody(VERIFY_PASS);
    return ollamaBody("local answer");
  };
  // Only anthropic is configured; mistral in the order is skipped.
  await withEnv(
    { ANTHROPIC_API_KEY: "sk-ant" },
    () =>
      withFetch(stub, async () => {
        const app = await createApp({
          fileValues: { rules: [rule("m:3b", 1)] },
          provider: "anthropic",
        });
        const answer = await app.ask("hard task");
        assertEquals(answer, "anthropic");
        assertEquals(prompts, ["hard task"]);
      }),
  );
});

Deno.test("app: a cloud model inside the rules is served by its provider", async () => {
  const seen: string[] = [];
  const stub: FetchStub = async (url, init) => {
    const u = String(url);
    if (u.includes("mistral.ai")) {
      seen.push(
        "cloud:" + JSON.parse((init as RequestInit).body as string).model,
      );
      return jsonResponse({
        choices: [{ message: { content: "cloud tier" } }],
      });
    }
    const body = JSON.parse((init as RequestInit).body as string);
    const user = body.messages?.[body.messages.length - 1]?.content ?? "";
    if (body.format === "json" && user.startsWith("Question:")) {
      return ollamaBody(VERIFY_PASS);
    }
    if (body.format === "json") {
      return ollamaBody(
        JSON.stringify({
          tier: "local2",
          reason: "x",
          improved_prompt: "improved",
        }),
      );
    }
    return ollamaBody("local tier");
  };
  await withEnv({ MISTRAL_API_KEY: "sk" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({
        fileValues: {
          rules: [
            rule("ministral-3:3b", 1, "easy"),
            {
              complexity: 2,
              provider: "mistral",
              model: "mistral-small-latest",
              description: "hard",
            },
          ],
        },
      });
      const answer = await app.ask("hard task");
      assertEquals(answer, "cloud tier");
      assert(seen.includes("cloud:mistral-small-latest"));
    }));
});

Deno.test("app: --provider forces the cloud provider for the model", async () => {
  const seen: { url: string; model: string }[] = [];
  const stub: FetchStub = async (url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push({ url: String(url), model: body.model });
    return jsonResponse({
      choices: [{ message: { content: "forced cloud" } }],
    });
  };
  await withEnv({ MISTRAL_API_KEY: "sk" }, () =>
    withFetch(stub, async () => {
      const app = await createApp({
        fileValues: { rules: [] },
        model: "mistral-small-latest",
        provider: "mistral",
      });
      const answer = await app.ask("the raw question");
      assertEquals(answer, "forced cloud");
      assertEquals(seen[0].url.includes("mistral.ai"), true);
      assertEquals(seen[0].model, "mistral-small-latest");
    }));
});

Deno.test("app: an unknown provider is rejected", async () => {
  await assertRejects(
    () =>
      createApp({
        fileValues: { rules: [] },
        model: "mistral-small-latest",
        provider: "openai",
      }),
    Error,
    "unknown provider",
  );
});

import { assert, assertEquals, assertRejects } from "@std/assert";
import { extractJson, judge } from "../src/lib/judge.ts";
import { verify } from "../src/lib/verify.ts";
import { cascade } from "../src/lib/router.ts";
import type { ChatAnswer, ChatMessage } from "../src/lib/providers/ollama.ts";
import type { ChatFn } from "../src/lib/router.ts";
import type { Tier } from "../src/lib/judge.ts";
import { withLogRecords } from "./helpers.ts";

function chatReturning(text: string): ChatFn {
  return () => Promise.resolve({ content: text, toolCalls: [] });
}

function judgmentJson(
  tier: string,
  improved: string,
): string {
  return JSON.stringify({
    tier,
    reason: "test",
    improved_prompt: improved,
  });
}

Deno.test("extractJson: pulls JSON out of fenced or prose output", () => {
  assertEquals(extractJson('{"a":1}'), { a: 1 });
  assertEquals(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assertEquals(extractJson('Sure! Here: {"a":1} hope it helps'), { a: 1 });
  assertEquals(extractJson("no json here"), null);
});

const JUDGE_TIERS = [
  { name: "local1", description: "easy things" },
  { name: "local2", description: "moderate things" },
  { name: "local3", description: "hard things" },
];

Deno.test("judge: parses tier, reason, and improved prompt", async () => {
  const chat = chatReturning(
    judgmentJson("local2", "Explain this code in depth with examples"),
  );
  const j = await judge("explain this code", { chat, tiers: JUDGE_TIERS });
  assertEquals(j.tier, "local2");
  assertEquals(j.reason, "test");
  assertEquals(j.improvedPrompt, "Explain this code in depth with examples");
});

Deno.test("judge: the system prompt lists the user's tiers and descriptions", async () => {
  const seen: string[] = [];
  const chat: ChatFn = (messages) => {
    seen.push(messages[0].content);
    return Promise.resolve({
      content: judgmentJson("local1", "p"),
      toolCalls: [],
    });
  };
  await judge("q", {
    chat,
    tiers: [
      { name: "local1", description: "trivia and chat" },
      { name: "local2", description: "code review" },
    ],
  });
  const prompt = seen[0];
  assert(prompt.includes("- local1: trivia and chat"));
  assert(prompt.includes("- local2: code review"));
  assert(prompt.includes("- cloud:"));
  assert(prompt.includes('"tier": "local1 | local2 | cloud"'));
  assert(prompt.includes("never a list"));
});

Deno.test("judge: unknown tier names fall back; provider names mean cloud", async () => {
  const chat = chatReturning(judgmentJson("local8b", "p"));
  const j = await judge("q", { chat, tiers: JUDGE_TIERS });
  assertEquals(j.tier, "local1");
  const cloudName = chatReturning(judgmentJson("mistral", "p"));
  assertEquals(
    (await judge("q", { chat: cloudName, tiers: JUDGE_TIERS })).tier,
    "cloud",
  );
});

Deno.test("judge: unknown tiers fall back, unparseable falls back", async () => {
  const unknown = chatReturning(judgmentJson("local9", "p"));
  assertEquals(
    (await judge("q", { chat: unknown, tiers: JUDGE_TIERS })).tier,
    "local1",
  );
  const chat = chatReturning("I cannot do JSON, sorry");
  const j = await judge("what is 2+2", { chat, tiers: JUDGE_TIERS });
  assertEquals(j.tier, "local1");
  assertEquals(j.improvedPrompt, "what is 2+2");
  assert(j.reason.includes("fallback"));
});

Deno.test("verify: PASS on a matching answer", async () => {
  const chat = chatReturning(JSON.stringify({ verdict: "PASS", reason: "ok" }));
  const v = await verify("what is 2+2", "4", { chat });
  assertEquals(v.pass, true);
});

Deno.test("verify: FAIL names the deficiency", async () => {
  const chat = chatReturning(
    JSON.stringify({ verdict: "FAIL", reason: "wrong" }),
  );
  const v = await verify("what is 2+2", "5", { chat });
  assertEquals(v.pass, false);
  assertEquals(v.reason, "wrong");
});

Deno.test("verify: unparseable verdict passes (conservative bias)", async () => {
  const chat = chatReturning("looks fine to me");
  const v = await verify("q", "a", { chat });
  assertEquals(v.pass, true);
});

interface Fixture {
  chats: Record<string, ChatFn>;
  logs: string[];
  gateCalls: { command: string; args: string[] }[];
}

function fixture(
  scripts: Record<string, string[]>,
  opts: { gateResult?: string } = {},
): {
  fx: Fixture;
  deps: Parameters<typeof cascade>[1];
  run: (
    question: string,
    deps: Parameters<typeof cascade>[1],
  ) => Promise<string>;
} {
  const fx: Fixture = { chats: {}, logs: [], gateCalls: [] };
  for (const [tier, replies] of Object.entries(scripts)) {
    let i = 0;
    fx.chats[tier] = () => {
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      if (reply.startsWith("TOOL")) {
        const [, command, ...args] = reply.split(" ");
        return Promise.resolve({
          content: "",
          toolCalls: [{ name: "run_command", args: { command, args } }],
        });
      }
      return Promise.resolve({ content: reply, toolCalls: [] });
    };
  }
  const localTiers = Object.keys(scripts)
    .filter((k) => /^local\d$/.test(k))
    .sort() as Tier[];
  const deps = {
    localTiers,
    chatFor: (tier: string) =>
      fx.chats[tier] ?? (() => {
        throw new Error(`no chat for ${tier}`);
      }),
    gate: {
      run: (command: string, args: string[]) => {
        fx.gateCalls.push({ command, args });
        return Promise.resolve({
          code: 0,
          stdout: opts.gateResult ?? "",
          stderr: "",
        });
      },
    },
  };
  /** Runs the cascade with its log records captured into `fx.logs`. */
  const run = async (
    question: string,
    d: Parameters<typeof cascade>[1],
  ): Promise<string> =>
    await withLogRecords(async (records) => {
      const answer = await cascade(question, d);
      fx.logs.push(...records.map((r) => r.message.join("")));
      return answer;
    });
  return { fx, deps, run };
}

Deno.test("cascade: easy question answered on 3b and passes verification", async () => {
  const { fx, deps, run } = fixture({
    local1: ["4"],
    judge: [judgmentJson("local1", "what is 2+2?")],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const answer = await run("what is 2+2", deps);
  assertEquals(answer, "4");
  assert(fx.logs.some((l) => l.includes("local1")));
});

Deno.test("cascade: a tier repeating the same tool call escalates", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["TOOL ls -lh", "TOOL ls -lh"],
    local2: ["recovered answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const answer = await run("q", deps);
  assertEquals(answer, "recovered answer");
  assert(fx.logs.some((l) => l.includes("repeated the same tool call")));
});

Deno.test("cascade: failed verification escalates to the next local tier", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["bad answer"],
    local2: ["good answer"],
    verify: [
      JSON.stringify({ verdict: "FAIL", reason: "incomplete" }),
      JSON.stringify({ verdict: "PASS", reason: "ok" }),
    ],
  });
  const answer = await run("q", deps);
  assertEquals(answer, "good answer");
  assert(fx.logs.some((l) => l.includes("escalating")));
});

Deno.test("cascade: cloud receives the improved prompt, never the raw one", async () => {
  const prompts: string[] = [];
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local3", "improved hard prompt")],
    local3: ["still bad"],
    local2: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "nope" })],
  });
  const answer = await run("raw question", {
    ...deps,
    clouds: [{
      name: "mistral",
      keySetting: "MISTRAL_API_KEY",
      chat: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve("cloud answer");
      },
    }],
  });
  assertEquals(answer, "cloud answer");
  assertEquals(prompts, ["improved hard prompt"]);
  assert(fx.logs.some((l) => l.includes("mistral")));
});

Deno.test("cascade: a failing cloud provider falls through to the next", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local3", "improved")],
    local3: ["bad"],
    local2: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "nope" })],
  });
  const answer = await run("q", {
    ...deps,
    clouds: [
      {
        name: "mistral",
        keySetting: "MISTRAL_API_KEY",
        chat: () => Promise.reject(new Error("Mistral API: HTTP 429")),
      },
      {
        name: "anthropic",
        keySetting: "ANTHROPIC_API_KEY",
        chat: () => Promise.resolve("claude answer"),
      },
    ],
  });
  assertEquals(answer, "claude answer");
  assert(fx.logs.some((l) => l.includes("mistral failed")));
  assert(fx.logs.some((l) => l.includes("anthropic")));
});

Deno.test("cascade: forced anthropic without configuration names its key", async () => {
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const error = await assertRejects(
    () =>
      run("q", { ...deps, forced: { kind: "cloud", provider: "anthropic" } }),
    Error,
  );
  assert(error.message.includes("anthropic is not configured"));
  assert(error.message.includes("ANTHROPIC_API_KEY"));
});

Deno.test("cascade: all cloud providers failing reports every failure", async () => {
  const { deps } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "nope" })],
  });
  const error = await assertRejects(
    () =>
      cascade("q", {
        ...deps,
        clouds: [
          {
            name: "mistral",
            keySetting: "MISTRAL_API_KEY",
            chat: () => Promise.reject(new Error("HTTP 429")),
          },
          {
            name: "anthropic",
            keySetting: "ANTHROPIC_API_KEY",
            chat: () => Promise.reject(new Error("HTTP 500")),
          },
        ],
      }),
    Error,
  );
  assert(error.message.includes("mistral: HTTP 429"));
  assert(error.message.includes("anthropic: HTTP 500"));
});

Deno.test("cascade: no cloud provider gives a clear message, not a crash", async () => {
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["bad"],
    local2: ["bad"],
    local3: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "no" })],
  });
  const error = await assertRejects(() => run("q", deps), Error);
  assert(error.message.includes("MISTRAL_API_KEY"));
  assert(error.message.includes("no local model"));
});

Deno.test("cascade: forced tier skips verification", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local2: ["forced answer"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "should not run" })],
  });
  const answer = await run("q", {
    ...deps,
    forced: { kind: "tier", tier: "local2" },
  });
  assertEquals(answer, "forced answer");
  assert(!fx.logs.some((l) => l.includes("verdict")));
});

Deno.test("cascade: the model can run tools in the agent loop", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "list the files")],
    local1: [
      "TOOL ls -la .",
      "The directory contains app.ts (see the tool output above).",
    ],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  }, { gateResult: "app.ts" });
  const answer = await run("list my files", deps);
  assertEquals(
    answer,
    "The directory contains app.ts (see the tool output above).",
  );
  assertEquals(fx.gateCalls, [{ command: "ls", args: ["-la", "."] }]);
});

Deno.test("cascade: tool errors are reported back to the model, not thrown", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: [
      "TOOL rm -rf /",
      "I could not run that command (it was rejected by the gate), so I cannot comply.",
    ],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  }, { gateResult: "app.ts" });
  const deps2 = {
    ...deps,
    gate: {
      run: (_c: string, _a: string[]) => {
        throw new Error('"rm" is not in the allowlist');
      },
    },
  };
  const answer = await run("delete everything", deps2);
  assert(answer.includes("rejected by the gate"));
  assert(fx.gateCalls.length === 0);
});

Deno.test("cascade: a failing tier escalates instead of crashing", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: [], // replaced below: throws
    local2: ["good answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const deps2 = {
    ...deps,
    chatFor: (purpose: string) => {
      if (purpose === "local1") {
        return () => {
          throw new Error(
            "Ollama ministral-3:3b: HTTP 404 — is the model pulled? run `ollama pull ministral-3:3b`",
          );
        };
      }
      return (deps.chatFor as (p: string) => ChatFn)(purpose);
    },
  };
  const answer = await run("q", deps2);
  assertEquals(answer, "good answer");
  assert(
    fx.logs.some((l) =>
      l.includes("local1 failed") && l.includes("escalating")
    ),
  );
});

Deno.test("cascade: a daemon-down error is fatal, not skippable", async () => {
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["never"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const deps2 = {
    ...deps,
    chatFor: (purpose: string) => {
      if (purpose === "local1") {
        return () => {
          throw new Error(
            "Ollama is not running at http://localhost:11434 — start it with `ollama serve`",
          );
        };
      }
      return (deps.chatFor as (p: string) => ChatFn)(purpose);
    },
  };
  const error = await assertRejects(() => run("q", deps2), Error);
  assert(error.message.includes("Ollama is not running"));
});

Deno.test("cascade: --no-verify returns the first answer", async () => {
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["first answer"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "never consulted" })],
  });
  const answer = await run("q", { ...deps, noVerify: true });
  assertEquals(answer, "first answer");
});

Deno.test("cascade: verify consults the question and the answer", async () => {
  const seen: ChatMessage[][] = [];
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const chatFor = (tier: string) =>
    tier === "verify"
      ? (messages: readonly ChatMessage[]) => {
        seen.push([...messages]);
        return Promise.resolve({ content: "", toolCalls: [] } as ChatAnswer);
      }
      : (deps.chatFor as (t: string) => ChatFn)(tier);
  await run("the question", { ...deps, chatFor });
  const verifyMessages = seen[0].map((m) => m.content).join(" ");
  assert(verifyMessages.includes("the question"));
  assert(verifyMessages.includes("answer"));
});

Deno.test("cascade: a failing judge falls back to the raw question", async () => {
  const { fx, deps, run } = fixture({
    judge: [],
    local2: ["judge is down answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const deps2 = {
    ...deps,
    localTiers: ["local2", "local3"] as const,
    chatFor: (purpose: string) => {
      if (purpose === "judge") {
        return () => {
          throw new Error(
            "Ollama ministral-3:8b: HTTP 404 — is the model pulled? run `ollama pull ministral-3:8b`",
          );
        };
      }
      return (deps.chatFor as (p: string) => ChatFn)(purpose);
    },
  };
  const answer = await run("raw question", deps2);
  assertEquals(answer, "judge is down answer");
  assert(
    fx.logs.some((l) =>
      l.includes("judge failed") && l.includes("raw question")
    ),
  );
});

Deno.test("cascade: a forced model tag answers directly, bypassing judge and verify", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["should not run"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "should not run" })],
  });
  const answer = await run("the raw question", {
    ...deps,
    chatForModel: (model) => () =>
      Promise.resolve({
        content: `${model} answers`,
        toolCalls: [],
      }),
    forced: { kind: "model", model: "qwen3:4b" },
  });
  assertEquals(answer, "qwen3:4b answers");
  assert(fx.logs.some((l) => l.includes("forced: qwen3:4b")));
  assert(!fx.logs.some((l) => l.includes("judge:")));
  assert(!fx.logs.some((l) => l.includes("verify")));
});

Deno.test("cascade: a forced cloud model receives the raw question", async () => {
  const prompts: string[] = [];
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["never"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const answer = await run("the raw question", {
    ...deps,
    clouds: [{
      name: "mistral",
      keySetting: "MISTRAL_API_KEY",
      chat: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve("cloud answer");
      },
    }],
    forced: { kind: "cloud", provider: "mistral" },
  });
  assertEquals(answer, "cloud answer");
  assertEquals(prompts, ["the raw question"]);
});

Deno.test("cascade: a forced tier still validates configuration", async () => {
  const { deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const error = await assertRejects(
    () => run("q", { ...deps, forced: { kind: "tier", tier: "local2" } }),
    Error,
  );
  assert(error.message.includes("local2 is not configured"));
});

Deno.test("cascade: a forced model with no answer errors clearly", async () => {
  const { deps } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  await assertRejects(
    () =>
      cascade("q", {
        ...deps,
        chatForModel: () => () =>
          Promise.resolve({ content: "", toolCalls: [] }),
        forced: { kind: "model", model: "qwen3:4b" },
      }),
    Error,
    "produced no answer",
  );
});

Deno.test("cascade: a cloud tier with a missing provider escalates", async () => {
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local2: ["ollama tier answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const answer = await run("q", {
    ...deps,
    localTiers: ["local1", "local2", "local3"],
    tierTargets: {
      local1: { provider: "mistral", model: "mistral-small-latest" },
      local2: { provider: "ollama", model: "x" },
      local3: { provider: "ollama", model: "y" },
    },
    clouds: [],
  });
  assertEquals(answer, "ollama tier answer");
  assert(
    fx.logs.some((l) =>
      l.includes("local1 (mistral-small-latest) needs mistral")
    ),
  );
});

Deno.test("cascade: cloud tiers in the list are served by their provider", async () => {
  const calls: string[] = [];
  const { fx, deps, run } = fixture({
    judge: [judgmentJson("local1", "improved")],
    local1: ["local fails verification"],
    verify: [
      JSON.stringify({ verdict: "FAIL", reason: "nope" }),
      JSON.stringify({ verdict: "PASS", reason: "ok" }),
    ],
  });
  const answer = await run("q", {
    ...deps,
    localTiers: ["local1", "local2"],
    tierTargets: {
      local1: { provider: "ollama", model: "x" },
      local2: { provider: "mistral", model: "mistral-small-latest" },
    },
    clouds: [{
      name: "mistral",
      keySetting: "MISTRAL_API_KEY",
      chat: (prompt, model) => {
        calls.push(`${prompt}/${model ?? "default"}`);
        return Promise.resolve("cloud tier answer");
      },
    }],
  });
  assertEquals(answer, "cloud tier answer");
  assertEquals(calls, ["improved/mistral-small-latest"]);
  assert(fx.logs.some((l) => l.includes("mistral-small-latest via mistral")));
  // No implicit trailing cloud: the user's list ends at the cloud model.
  assert(!fx.logs.some((l) => l.includes("cloud: mistral (answer is final")));
});

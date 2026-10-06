import { assert, assertEquals, assertRejects } from "@std/assert";
import { extractJson, judge } from "../src/judge.ts";
import { verify } from "../src/verify.ts";
import { cascade } from "../src/router.ts";
import type { ChatAnswer, ChatMessage } from "../src/ollama.ts";
import type { ChatFn } from "../src/router.ts";

function chatReturning(text: string): ChatFn {
  return async () => ({ content: text, toolCalls: [] });
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
  assertEquals(extractJson("```json\n{\"a\":1}\n```"), { a: 1 });
  assertEquals(extractJson("Sure! Here: {\"a\":1} hope it helps"), { a: 1 });
  assertEquals(extractJson("no json here"), null);
});

Deno.test("judge: parses tier, reason, and improved prompt", async () => {
  const chat = chatReturning(
    judgmentJson("local8b", "Explain this code in depth with examples"),
  );
  const j = await judge("explain this code", { chat });
  assertEquals(j.tier, "local8b");
  assertEquals(j.reason, "test");
  assertEquals(j.improvedPrompt, "Explain this code in depth with examples");
});

Deno.test("judge: unparseable output falls back to the raw question on 3b", async () => {
  const chat = chatReturning("I cannot do JSON, sorry");
  const j = await judge("what is 2+2", { chat });
  assertEquals(j.tier, "local3b");
  assertEquals(j.improvedPrompt, "what is 2+2");
  assert(j.reason.includes("fallback"));
});

Deno.test("verify: PASS on a matching answer", async () => {
  const chat = chatReturning(JSON.stringify({ verdict: "PASS", reason: "ok" }));
  const v = await verify("what is 2+2", "4", { chat });
  assertEquals(v.pass, true);
});

Deno.test("verify: FAIL names the deficiency", async () => {
  const chat = chatReturning(JSON.stringify({ verdict: "FAIL", reason: "wrong" }));
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
): { fx: Fixture; deps: Parameters<typeof cascade>[1] } {
  const fx: Fixture = { chats: {}, logs: [], gateCalls: [] };
  for (const [tier, replies] of Object.entries(scripts)) {
    let i = 0;
    fx.chats[tier] = async () => {
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      if (reply.startsWith("TOOL")) {
        const [, command, ...args] = reply.split(" ");
        return {
          content: "",
          toolCalls: [{ name: "run_command", args: { command, args } }],
        };
      }
      return { content: reply, toolCalls: [] };
    };
  }
  const deps = {
    chatFor: (tier: string) => fx.chats[tier] ?? (() => {
      throw new Error(`no chat for ${tier}`);
    }),
    gate: {
      run: async (command: string, args: string[]) => {
        fx.gateCalls.push({ command, args });
        return {
          code: 0,
          stdout: opts.gateResult ?? "",
          stderr: "",
        };
      },
    },
    onLog: (msg: string) => fx.logs.push(msg),
  };
  return { fx, deps };
}

Deno.test("cascade: easy question answered on 3b and passes verification", async () => {
  const { fx, deps } = fixture({
    local3b: ["4"],
    judge: [judgmentJson("local3b", "what is 2+2?")],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const answer = await cascade("what is 2+2", deps);
  assertEquals(answer, "4");
  assert(fx.logs.some((l) => l.includes("local3b")));
});

Deno.test("cascade: failed verification escalates to the next local tier", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["bad answer"],
    local8b: ["good answer"],
    verify: [
      JSON.stringify({ verdict: "FAIL", reason: "incomplete" }),
      JSON.stringify({ verdict: "PASS", reason: "ok" }),
    ],
  });
  const answer = await cascade("q", deps);
  assertEquals(answer, "good answer");
  assert(fx.logs.some((l) => l.includes("escalating")));
});

Deno.test("cascade: cloud receives the improved prompt, never the raw one", async () => {
  const prompts: string[] = [];
  const { fx, deps } = fixture({
    judge: [judgmentJson("local14b", "improved hard prompt")],
    local14b: ["still bad"],
    local8b: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "nope" })],
  });
  const answer = await cascade("raw question", {
    ...deps,
    clouds: [{
      name: "mistral",
      keySetting: "MISTRAL_API_KEY",
      chat: async (prompt) => {
        prompts.push(prompt);
        return "cloud answer";
      },
    }],
  });
  assertEquals(answer, "cloud answer");
  assertEquals(prompts, ["improved hard prompt"]);
  assert(fx.logs.some((l) => l.includes("mistral")));
});

Deno.test("cascade: a failing cloud provider falls through to the next", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local14b", "improved")],
    local14b: ["bad"],
    local8b: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "nope" })],
  });
  const answer = await cascade("q", {
    ...deps,
    clouds: [
      {
        name: "mistral",
        keySetting: "MISTRAL_API_KEY",
        chat: () => Promise.reject(new Error("Mistral API: HTTP 429")),
      },
      {
        name: "claude",
        keySetting: "ANTHROPIC_API_KEY",
        chat: () => Promise.resolve("claude answer"),
      },
    ],
  });
  assertEquals(answer, "claude answer");
  assert(fx.logs.some((l) => l.includes("mistral failed")));
  assert(fx.logs.some((l) => l.includes("claude")));
});

Deno.test("cascade: forced claude without configuration names its key", async () => {
  const { deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const error = await assertRejects(
    () => cascade("q", { ...deps, forcedTier: "claude" }),
    Error,
  );
  assert(error.message.includes("claude is not configured"));
  assert(error.message.includes("ANTHROPIC_API_KEY"));
});

Deno.test("cascade: all cloud providers failing reports every failure", async () => {
  const { deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["bad"],
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
            name: "claude",
            keySetting: "ANTHROPIC_API_KEY",
            chat: () => Promise.reject(new Error("HTTP 500")),
          },
        ],
      }),
    Error,
  );
  assert(error.message.includes("mistral: HTTP 429"));
  assert(error.message.includes("claude: HTTP 500"));
});

Deno.test("cascade: no cloud provider gives a clear message, not a crash", async () => {
  const { deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["bad"],
    local8b: ["bad"],
    local14b: ["bad"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "no" })],
  });
  const error = await assertRejects(() => cascade("q", deps), Error);
  assert(error.message.includes("MISTRAL_API_KEY"));
  assert(error.message.includes("no local model"));
});

Deno.test("cascade: forced tier skips verification", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local8b: ["forced answer"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "should not run" })],
  });
  const answer = await cascade("q", { ...deps, forcedTier: "local8b" });
  assertEquals(answer, "forced answer");
  assert(!fx.logs.some((l) => l.includes("verdict")));
});

Deno.test("cascade: the model can run tools in the agent loop", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local3b", "list the files")],
    local3b: [
      "TOOL ls -la .",
      "The directory contains app.ts (see the tool output above).",
    ],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  }, { gateResult: "app.ts" });
  const answer = await cascade("list my files", deps);
  assertEquals(answer, "The directory contains app.ts (see the tool output above).");
  assertEquals(fx.gateCalls, [{ command: "ls", args: ["-la", "."] }]);
});

Deno.test("cascade: tool errors are reported back to the model, not thrown", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: [
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
  const answer = await cascade("delete everything", deps2);
  assert(answer.includes("rejected by the gate"));
  assert(fx.gateCalls.length === 0);
});

Deno.test("cascade: a failing tier escalates instead of crashing", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: [], // replaced below: throws
    local8b: ["good answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const deps2 = {
    ...deps,
    chatFor: (purpose: string) => {
      if (purpose === "local3b") {
        return () => {
          throw new Error(
            "Ollama ministral-3:3b: HTTP 404 — is the model pulled? run `ollama pull ministral-3:3b`",
          );
        };
      }
      return (deps.chatFor as (p: string) => ChatFn)(purpose);
    },
  };
  const answer = await cascade("q", deps2);
  assertEquals(answer, "good answer");
  assert(fx.logs.some((l) => l.includes("local3b failed") && l.includes("escalating")));
});

Deno.test("cascade: a daemon-down error is fatal, not skippable", async () => {
  const { deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["never"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const deps2 = {
    ...deps,
    chatFor: (purpose: string) => {
      if (purpose === "local3b") {
        return () => {
          throw new Error(
            "Ollama is not running at http://localhost:11434 — start it with `ollama serve`",
          );
        };
      }
      return (deps.chatFor as (p: string) => ChatFn)(purpose);
    },
  };
  const error = await assertRejects(() => cascade("q", deps2), Error);
  assert(error.message.includes("Ollama is not running"));
});

Deno.test("cascade: --no-verify returns the first answer", async () => {
  const { fx, deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["first answer"],
    verify: [JSON.stringify({ verdict: "FAIL", reason: "never consulted" })],
  });
  const answer = await cascade("q", { ...deps, noVerify: true });
  assertEquals(answer, "first answer");
});

Deno.test("cascade: verify consults the question and the answer", async () => {
  const seen: ChatMessage[][] = [];
  const { deps } = fixture({
    judge: [judgmentJson("local3b", "improved")],
    local3b: ["answer"],
    verify: [JSON.stringify({ verdict: "PASS", reason: "ok" })],
  });
  const chatFor = (tier: string) =>
    tier === "verify"
      ? async (messages: readonly ChatMessage[]) => {
        seen.push([...messages]);
        return { content: "", toolCalls: [] } as ChatAnswer;
      }
      : (deps.chatFor as (t: string) => ChatFn)(tier);
  await cascade("the question", { ...deps, chatFor });
  const verifyMessages = seen[0].map((m) => m.content).join(" ");
  assert(verifyMessages.includes("the question"));
  assert(verifyMessages.includes("answer"));
});

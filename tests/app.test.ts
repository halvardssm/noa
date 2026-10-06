import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../src/app.ts";
import type { FetchFn, ResponseLike } from "../src/http.ts";

function jsonResponse(body: unknown, status = 200): ResponseLike {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function ollamaBody(content: string): ResponseLike {
  return jsonResponse({ message: { role: "assistant", content } });
}

const JUDGE_3B = JSON.stringify({
  tier: "local3b",
  reason: "trivial",
  improved_prompt: "improved",
});
const VERIFY_PASS = JSON.stringify({ verdict: "PASS", reason: "ok" });

function envWith(overrides: Record<string, string>) {
  const env = new Map<string, string>([
    ["HOME", Deno.env.get("HOME") ?? "/root"],
    ...Object.entries(overrides),
  ]);
  return { get: (name: string) => env.get(name) };
}

Deno.test("app: resolves allowlist and paths by precedence", async () => {
  const app = await createApp({
    env: envWith({ NOA_TOOLS: "rg,fd" }),
    fileValues: { NOA_TOOLS: "git", NOA_ALLOW_PATHS: "~/dev,~/work" },
    allowToolsFlag: "jq,rg",
    onLog: () => {},
  });
  assertEquals(app.allowTools, ["jq", "rg"]);
  assertEquals(app.allowPaths, ["~/dev", "~/work"]);
});

Deno.test("app: no configured tools means no tools, with a hint", async () => {
  const logs: string[] = [];
  const app = await createApp({
    env: envWith({}),
    fileValues: {},
    onLog: (m) => logs.push(m),
  });
  assertEquals(app.allowTools, []);
  assert(logs.some((m) => m.includes("--allow-tools") && m.includes("ls,cat")));
});

Deno.test("app: default allowed path is the current directory", async () => {
  const app = await createApp({
    env: envWith({}),
    fileValues: {},
    onLog: () => {},
    cwd: "/somewhere/inside/project",
  });
  assertEquals(app.allowPaths, ["/somewhere/inside/project"]);
});

Deno.test("app: warns when the default path is outside home, not when configured", async () => {
  const warned: string[] = [];
  const app = await createApp({
    env: envWith({}),
    fileValues: {},
    onLog: (m) => warned.push(m),
    cwd: "/srv/project",
  });
  assert(warned.some((m) => m.includes("outside your home")));

  // An explicit choice (flag, env, or config) never warns.
  const quiet: string[] = [];
  await createApp({
    env: envWith({}),
    fileValues: {},
    allowPathsFlag: "/srv/project",
    onLog: (m) => quiet.push(m),
    cwd: "/srv/project",
  });
  assert(!quiet.some((m) => m.includes("outside your home")));

  await createApp({
    env: envWith({ NOA_ALLOW_PATHS: "/srv/project" }),
    fileValues: {},
    onLog: (m) => quiet.push(m),
    cwd: "/srv/project",
  });
  assert(!quiet.some((m) => m.includes("outside your home")));

  // Inside home: no warning either.
  const home = Deno.env.get("HOME") ?? "/root";
  await createApp({
    env: envWith({}),
    fileValues: {},
    onLog: (m) => quiet.push(m),
    cwd: `${home}/dev`,
  });
  assert(!quiet.some((m) => m.includes("outside your home")));
});

Deno.test("app: falls back to defaults for missing settings", async () => {
  const app = await createApp({
    env: envWith({}),
    fileValues: {},
    onLog: () => {},
    cwd: "/work/project",
  });
  assertEquals(app.allowTools, []);
  assertEquals(app.allowPaths, ["/work/project"]);
});

Deno.test("app: ask routes through the local cascade end to end", async () => {
  const seen: string[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(body.model);
    const user = body.messages?.[body.messages.length - 1]?.content ?? "";
    if (body.format === "json" && user.startsWith("Question:")) {
      return ollamaBody(VERIFY_PASS);
    }
    if (body.format === "json") return ollamaBody(JUDGE_3B);
    return ollamaBody("4");
  };
  const app = await createApp({
    env: envWith({}),
    fileValues: {},
    onLog: () => {},
    fetchFn,
  });
  const answer = await app.ask("what is 2+2");
  assertEquals(answer, "4");
  assert(seen.includes("ministral-3:3b"));
});

Deno.test("app: forced mistral without a key gives the config remedy", async () => {
  const app = await createApp({
    env: envWith({}),
    fileValues: {},
    model: "mistral",
    onLog: () => {},
  });
  const error = await assertRejects(() => app.ask("hard task"), Error);
  assert(error.message.includes("noa config set MISTRAL_API_KEY"));
});

Deno.test("app: mistral configured receives the improved prompt", async () => {
  const prompts: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    if (String(url).includes("mistral.ai")) {
      prompts.push(JSON.parse((init as RequestInit).body as string).messages[0].content);
      return jsonResponse({ choices: [{ message: { content: "cloud answer" } }] });
    }
    const body = JSON.parse((init as RequestInit).body as string);
    if (body.format === "json" && body.messages.length === 2) return ollamaBody(JUDGE_3B);
    if (body.format === "json") return ollamaBody(VERIFY_PASS);
    return ollamaBody("local answer");
  };
  const app = await createApp({
    env: envWith({ MISTRAL_API_KEY: "sk-test" }),
    fileValues: {},
    model: "mistral",
    onLog: () => {},
    fetchFn,
  });
  const answer = await app.ask("hard task");
  assertEquals(answer, "cloud answer");
  assertEquals(prompts, ["improved"]);
});

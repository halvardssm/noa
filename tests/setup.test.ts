import { assert, assertEquals } from "@std/assert";
import {
  appendEnvExports,
  defaultModelsFor,
  profilePathFor,
  runSetup,
  type SetupInteract,
} from "../src/setup.ts";
import type { FetchFn, ResponseLike } from "../src/http.ts";
import { loadConfig } from "../src/config.ts";

function ok(body: unknown = {}): ResponseLike {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

Deno.test("profilePathFor: maps the shell to its rc file", () => {
  assertEquals(profilePathFor("/bin/zsh", "/home/u"), "/home/u/.zshrc");
  assertEquals(profilePathFor("/usr/local/bin/bash", "/home/u"), "/home/u/.bashrc");
  assertEquals(profilePathFor("/usr/bin/fish", "/home/u"), "/home/u/.profile");
  assertEquals(profilePathFor(undefined, "/home/u"), "/home/u/.profile");
});

Deno.test("appendEnvExports: appends only missing exports", () => {
  const appended = appendEnvExports("", {
    OLLAMA_MAX_LOADED_MODELS: "2",
    OLLAMA_KEEP_ALIVE: "5m",
  });
  assert(appended.includes("export OLLAMA_MAX_LOADED_MODELS=2"));
  assert(appended.includes("export OLLAMA_KEEP_ALIVE=5m"));

  const twice = appendEnvExports("export OLLAMA_MAX_LOADED_MODELS=2\n", {
    OLLAMA_MAX_LOADED_MODELS: "2",
    OLLAMA_KEEP_ALIVE: "5m",
  });
  assertEquals(
    twice.match(/OLLAMA_MAX_LOADED_MODELS/g)?.length,
    1,
    "already-present export must not be duplicated",
  );
});

Deno.test("defaultModelsFor: the systems check filters by RAM", () => {
  assertEquals(defaultModelsFor(4).map((s) => s.entry.model), []);
  assertEquals(defaultModelsFor(8).map((s) => s.entry.model), ["ministral-3:3b"]);
  assertEquals(defaultModelsFor(16).map((s) => s.entry.model), [
    "ministral-3:3b",
    "ministral-3:8b",
  ]);
  assertEquals(defaultModelsFor(64).map((s) => s.entry.model), [
    "ministral-3:3b",
    "ministral-3:8b",
    "ministral-3:14b",
  ]);
});

interface Scripted {
  confirms?: boolean[];
  secrets?: string[];
  texts?: string[];
}
function fakeInteract(script: Scripted = {}): SetupInteract & {
  confirms: string[];
  secrets: string[];
  texts: string[];
} {
  const confirms: string[] = [];
  const secrets: string[] = [];
  const texts: string[] = [];
  let ci = 0;
  let si = 0;
  let ti = 0;
  return {
    confirms,
    secrets,
    texts,
    confirm: (message) => {
      confirms.push(message);
      return Promise.resolve(script.confirms?.[ci++] ?? false);
    },
    secret: (message) => {
      secrets.push(message);
      return Promise.resolve(script.secrets?.[si++] ?? null);
    },
    text: (message) => {
      texts.push(message);
      return Promise.resolve(script.texts?.[ti++] ?? "");
    },
  };
}

function ollamaFetch(pulled: string[]): { fetchFn: FetchFn } {
  return {
    fetchFn: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) return ok({ models: [] });
      if (u.endsWith("/api/pull")) {
        pulled.push(JSON.parse((init as RequestInit).body as string).model);
        return ok({ status: "success" });
      }
      throw new Error(`unexpected url ${u}`);
    },
  };
}

async function withDirs(
  fn: (home: string, cfg: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "noa-setup-home-" });
  const cfg = await Deno.makeTempDir({ prefix: "noa-setup-cfg-" });
  try {
    await fn(home, `${cfg}/config.json`);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cfg, { recursive: true });
  }
}

function envWith(home: string): { get(name: string): string | undefined } {
  return {
    get: (name) =>
      name === "HOME" ? home : name === "SHELL" ? "/bin/zsh" : undefined,
  };
}

Deno.test("setup: default path pulls what the systems check allows", async () => {
  await withDirs(async (home, config) => {
    const pulled: string[] = [];
    const interact = fakeInteract({
      confirms: [true, true, true, true, true],
      secrets: [],
    });
    const lines: string[] = [];
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact,
      memoryInfo: () => ({ total: 32 * 2 ** 30 }),
      out: (line) => lines.push(line),
      ...ollamaFetch(pulled),
    });
    assertEquals(result, 0);
    assert(lines.some((l) => l.includes("GB of RAM")));
    assert(lines.some((l) => l.includes("downloading the models this system can handle")));
    assert(lines.some((l) => l.includes("ministral-3:14b")));
    assertEquals(pulled, ["ministral-3:3b", "ministral-3:8b", "ministral-3:14b"]);
    const saved = await loadConfig(config);
    assertEquals((saved.models as { model: string }[]).length, 3);
  });
});

Deno.test("setup: default path on a small system skips big models with a note", async () => {
  await withDirs(async (home, config) => {
    const pulled: string[] = [];
    const lines: string[] = [];
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact: fakeInteract({ confirms: [true, true] }),
      memoryInfo: () => ({ total: 8 * 2 ** 30 }),
      out: (line) => lines.push(line),
      ...ollamaFetch(pulled),
    });
    assertEquals(result, 0);
    assertEquals(pulled, ["ministral-3:3b"]);
    assert(lines.some((l) => l.includes("skipping (needs more RAM)")));
    assert(lines.some((l) => l.includes("ministral-3:8b")));
    const saved = await loadConfig(config);
    assertEquals(saved.models, [
      {
        model: "ministral-3:3b",
        description:
          "trivial questions, chat, simple lookups, basic arithmetic, formatting.",
      },
    ]);
  });
});

Deno.test("setup: custom path asks for an ordered list and descriptions", async () => {
  await withDirs(async (home, config) => {
    const pulled: string[] = [];
    const interact = fakeInteract({
      confirms: [false, true],
      texts: ["qwen3:4b, llama3.1:8b", "chat and trivia", "code questions"],
      secrets: [],
    });
    const lines: string[] = [];
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact,
      memoryInfo: () => ({ total: 64 * 2 ** 30 }),
      out: (line) => lines.push(line),
      ...ollamaFetch(pulled),
    });
    assertEquals(result, 0);
    assertEquals(pulled, ["qwen3:4b", "llama3.1:8b"]);
    assert(interact.texts.some((t) => t.includes("smallest to largest")));
    assert(interact.texts.some((t) => t.includes("qwen3:4b")));
    assert(interact.texts.some((t) => t.includes("llama3.1:8b")));
    const saved = await loadConfig(config);
    assertEquals(saved.models, [
      { model: "qwen3:4b", description: "chat and trivia" },
      { model: "llama3.1:8b", description: "code questions" },
    ]);
    // The memory-cap profile was declined (confirms ran out of trues).
    assert(!await exists(`${home}/.zshrc`));
  });
});

Deno.test("setup: prompts for keys only when the config does not exist", async () => {
  await withDirs(async (home, config) => {
    const interact = fakeInteract({
      confirms: [true, false],
      secrets: ["sk-mistral", "sk-ant"],
    });
    const pulled: string[] = [];
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact,
      memoryInfo: () => ({ total: 32 * 2 ** 30 }),
      out: () => {},
      ...ollamaFetch(pulled),
    });
    assertEquals(result, 0);
    assert(interact.secrets.some((s) => s.includes("Mistral")));
    assert(interact.secrets.some((s) => s.includes("Anthropic")));
    const saved = await loadConfig(config);
    assertEquals(saved.MISTRAL_API_KEY, "sk-mistral");
    assertEquals(saved.ANTHROPIC_API_KEY, "sk-ant");
  });
});

Deno.test("setup: leaves keys untouched when the config exists", async () => {
  await withDirs(async (home, config) => {
    await Deno.writeTextFile(
      config,
      '{"MISTRAL_API_KEY": "existing", "models": []}',
    );
    const interact = fakeInteract({ confirms: [true, false] });
    const pulled: string[] = [];
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact,
      memoryInfo: () => ({ total: 32 * 2 ** 30 }),
      out: () => {},
      ...ollamaFetch(pulled),
    });
    assertEquals(result, 0);
    assertEquals(interact.secrets.length, 0);
    const saved = await loadConfig(config);
    assertEquals(saved.MISTRAL_API_KEY, "existing");
    assertEquals(saved.models, []);
  });
});

Deno.test("setup: a daemon that is down reports instructions", async () => {
  await withDirs(async (home, config) => {
    const lines: string[] = [];
    const fetchFn: FetchFn = () => Promise.reject(new TypeError("refused"));
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact: fakeInteract(),
      fetchFn,
      out: (line) => lines.push(line),
    });
    assertEquals(result, 1);
    assert(lines.some((l) => l.includes("ollama serve") || l.includes("Ollama is not running")));
  });
});

Deno.test("setup: an empty custom list skips model setup cleanly", async () => {
  await withDirs(async (home, config) => {
    const pulled: string[] = [];
    const result = await runSetup({
      env: envWith(home),
      configPath: config,
      interact: fakeInteract({ confirms: [false], texts: ["  "] }),
      memoryInfo: () => ({ total: 32 * 2 ** 30 }),
      out: () => {},
      ...ollamaFetch(pulled),
    });
    assertEquals(result, 0);
    assertEquals(pulled, []);
    const saved = await loadConfig(config);
    assertEquals(saved.models, []);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

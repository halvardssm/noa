import { assert, assertEquals } from "@std/assert";
import {
  appendEnvExports,
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

  const existing = "export OLLAMA_MAX_LOADED_MODELS=2\n";
  const twice = appendEnvExports(existing, {
    OLLAMA_MAX_LOADED_MODELS: "2",
    OLLAMA_KEEP_ALIVE: "5m",
  });
  assertEquals(
    twice.match(/OLLAMA_MAX_LOADED_MODELS/g)?.length,
    1,
    "already-present export must not be duplicated",
  );
});

function fakeInteract(
  answers: { confirm?: boolean[]; secrets?: string[] },
): SetupInteract & { confirms: string[]; secrets: string[] } {
  const confirms: string[] = [];
  const secrets: string[] = [];
  let ci = 0;
  let si = 0;
  return {
    confirms,
    secrets,
    confirm: (message) => {
      confirms.push(message);
      return Promise.resolve(answers.confirm?.[ci++] ?? false);
    },
    secret: (message) => {
      secrets.push(message);
      return Promise.resolve(answers.secrets?.[si++] ?? null);
    },
  };
}

Deno.test("setup: full happy path — models pulled, keys prompted, profile written", async () => {
  const home = await Deno.makeTempDir({ prefix: "noa-setup-home-" });
  const cfg = await Deno.makeTempDir({ prefix: "noa-setup-cfg-" });
  const pulled: string[] = [];
  try {
    const interact = fakeInteract({ confirm: [true, false, false, true], secrets: ["sk-mistral", "sk-ant"] });
    const fetchFn: FetchFn = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) return ok({ models: [] });
      if (u.endsWith("/api/pull")) {
        pulled.push(JSON.parse((init as RequestInit).body as string).model);
        return ok({ status: "success" });
      }
      throw new Error(`unexpected url ${u}`);
    };
    const result = await runSetup({
      env: {
        get: (name: string) =>
          name === "HOME" ? home : name === "SHELL" ? "/bin/zsh" : undefined,
      },
      configPath: `${cfg}/config.json`,
      interact,
      fetchFn,
      out: () => {},
    });
    assertEquals(result, 0);
    // 3b pulled; 8b/14b were declined (confirm ran out of trues).
    assertEquals(pulled, ["ministral-3:3b"]);
    // Keys prompted only because .env did not exist.
    assert(interact.secrets.some((s) => s.includes("Mistral")));
    assert(interact.secrets.some((s) => s.includes("Anthropic")));
    const values = await loadConfig(`${cfg}/config.json`);
    assertEquals(values.MISTRAL_API_KEY, "sk-mistral");
    assertEquals(values.ANTHROPIC_API_KEY, "sk-ant");
    const profile = await Deno.readTextFile(`${home}/.zshrc`);
    assert(profile.includes("export OLLAMA_MAX_LOADED_MODELS=2"));
    assert(profile.includes("export OLLAMA_KEEP_ALIVE=5m"));
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cfg, { recursive: true });
  }
});

Deno.test("setup: does not prompt for keys when .env already exists", async () => {
  const home = await Deno.makeTempDir({ prefix: "noa-setup-home-" });
  const cfg = await Deno.makeTempDir({ prefix: "noa-setup-cfg-" });
  try {
    await Deno.writeTextFile(
      `${cfg}/config.json`,
      '{"MISTRAL_API_KEY": "existing"}',
    );
    const interact = fakeInteract({ confirm: [true] });
    const fetchFn: FetchFn = async (url) => {
      if (String(url).endsWith("/api/tags")) return ok({ models: [] });
      if (String(url).endsWith("/api/pull")) return ok({ status: "success" });
      throw new Error("unexpected");
    };
    const result = await runSetup({
      env: { get: (name) => name === "HOME" ? home : undefined },
      configPath: `${cfg}/config.json`,
      interact,
      fetchFn,
      out: () => {},
    });
    assertEquals(result, 0);
    assertEquals(interact.secrets.length, 0);
    // Existing entries preserved.
    const values = await loadConfig(`${cfg}/config.json`);
    assertEquals(values.MISTRAL_API_KEY, "existing");
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cfg, { recursive: true });
  }
});

Deno.test("setup: a daemon that is down reports instructions instead of hanging", async () => {
  const home = await Deno.makeTempDir({ prefix: "noa-setup-home-" });
  const cfg = await Deno.makeTempDir({ prefix: "noa-setup-cfg-" });
  try {
    const lines: string[] = [];
    const fetchFn: FetchFn = () => Promise.reject(new TypeError("refused"));
    const result = await runSetup({
      env: { get: (name) => name === "HOME" ? home : undefined },
      configPath: `${cfg}/config.json`,
      interact: fakeInteract({}),
      fetchFn,
      out: (line) => lines.push(line),
    });
    assertEquals(result, 1);
    assert(lines.some((l) => l.includes("ollama serve") || l.includes("Ollama is not running")));
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cfg, { recursive: true });
  }
});

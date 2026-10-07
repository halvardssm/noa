import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  DEFAULT_MODELS,
  defaultAllowPaths,
  ensureConfig,
  isSecretKey,
  isUnderHome,
  loadConfig,
  maskValue,
  resolveList,
  resolveModels,
  setConfigValue,
  SUGGESTED_TOOLS,
  unsetConfigValue,
} from "../src/config.ts";

Deno.test("resolveList: flag wins over file and defaults", () => {
  const list = resolveList({
    flag: "~/work/src",
    file: "~/dev,~/work",
    defaults: ["~/dev"],
  });
  assertEquals(list, ["~/work/src"]);
});

Deno.test("resolveList: file wins over defaults when env is absent", () => {
  const list = resolveList({
    file: "~/dev,~/work",
    defaults: ["~/dev"],
  });
  assertEquals(list, ["~/dev", "~/work"]);
});

Deno.test("resolveList: falls back to defaults", () => {
  assertEquals(resolveList({ defaults: ["x"] }), ["x"]);
  assertEquals(resolveList({ defaults: [] }), []);
});

Deno.test("resolveList: trims entries, drops empties, dedupes", () => {
  const list = resolveList({ flag: " git , rg , ,git, ", defaults: [] });
  assertEquals(list, ["git", "rg"]);
});

Deno.test("SUGGESTED_TOOLS: is the example shown in the CLI help", () => {
  assertEquals(SUGGESTED_TOOLS, "ls,cat,head,tail,wc,grep,find,jq,curl");
});

Deno.test("defaultAllowPaths: is the current directory", () => {
  assertEquals(defaultAllowPaths(), [Deno.cwd()]);
  assertEquals(defaultAllowPaths("/tmp/somewhere"), ["/tmp/somewhere"]);
});

Deno.test("isUnderHome: true only inside home or home itself", () => {
  assertEquals(isUnderHome("/home/u", "/home/u"), true);
  assertEquals(isUnderHome("/home/u/dev/x", "/home/u"), true);
  assertEquals(isUnderHome("/home/university", "/home/u"), false);
  assertEquals(isUnderHome("/tmp", "/home/u"), false);
});

Deno.test("setConfigValue: creates the file with mode 600 and parent dirs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/nested/noa/config.json`;
    await setConfigValue(path, "ZODIAC", "leo");
    const stat = await Deno.stat(path);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);
    assertEquals(await loadConfig(path), { ZODIAC: "leo" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setConfigValue: updates only the named key, preserving others", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    await setConfigValue(path, "ZODIAC", "leo-1");
    await setConfigValue(path, "NOA_TOOLS", "git,rg");
    await setConfigValue(path, "ZODIAC", "leo-2");
    assertEquals(await loadConfig(path), {
      ZODIAC: "leo-2",
      NOA_TOOLS: "git,rg",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setConfigValue: tightens loose permissions and rejects models/invalid keys", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    await Deno.writeTextFile(path, "{}\n");
    await Deno.chmod(path, 0o644);
    await setConfigValue(path, "A", "1");
    const stat = await Deno.stat(path);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);
    await assertRejects(() => setConfigValue(path, "models", "x"), TypeError);
    await assertRejects(() => setConfigValue(path, "BAD KEY", "x"), TypeError);
    // Secrets are never stored.
    await assertRejects(
      () => setConfigValue(path, "MISTRAL_API_KEY", "sk"),
      TypeError,
      "secrets are not stored",
    );
    await assertRejects(
      () => setConfigValue(path, "MY_TOKEN", "t"),
      TypeError,
      "secrets are not stored",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unsetConfigValue: removes only the named key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    await setConfigValue(path, "A", "1");
    await setConfigValue(path, "B", "2");
    assertEquals(await unsetConfigValue(path, "A"), true);
    assertEquals(await loadConfig(path), { B: "2" });
    assertEquals(await unsetConfigValue(path, "A"), false);
    assertEquals(await loadConfig(path), { B: "2" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureConfig: migrates a legacy .env once, leaving it untouched", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    const legacy = `${dir}/.env`;
    await Deno.writeTextFile(legacy, "ZODIAC=leo\nMISTRAL_API_KEY=sk-1\n");
    assertEquals(await ensureConfig(path, legacy), true);
    // Secrets never migrate into the config file.
    assertEquals(await loadConfig(path), { ZODIAC: "leo" });
    // Second run: config exists, no changes.
    await setConfigValue(path, "EXTRA", "1");
    assertEquals(await ensureConfig(path, legacy), false);
    assertEquals(await loadConfig(path), {
      ZODIAC: "leo",
      EXTRA: "1",
    });
    assertEquals(await Deno.readTextFile(legacy), "ZODIAC=leo\nMISTRAL_API_KEY=sk-1\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureConfig: does nothing when neither file exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await ensureConfig(`${dir}/config.json`, `${dir}/.env`), false);
    assertEquals(await Deno.stat(`${dir}/config.json`).then(() => true, () => false), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveModels: absent or invalid models fall back to defaults; empty is cloud-only", () => {
  assertEquals(resolveModels({}), [...DEFAULT_MODELS]);
  assertEquals(resolveModels({ models: "not-a-list" }), [...DEFAULT_MODELS]);
  assertEquals(resolveModels({ models: [42] }), [...DEFAULT_MODELS]);
  // An explicit empty list is a deliberate cloud-only override.
  assertEquals(resolveModels({ models: [] }), []);
});

Deno.test("resolveModels: accepts an ordered list of models with descriptions and providers", () => {
  const models = resolveModels({
    models: [
      { model: "qwen3:4b", description: "chat and trivia" },
      { model: "mistral-small-latest", provider: "mistral", description: "hard" },
      "llama3.1:70b",
    ],
  });
  assertEquals(models, [
    { model: "qwen3:4b", description: "chat and trivia" },
    { model: "mistral-small-latest", provider: "mistral", description: "hard" },
    { model: "llama3.1:70b" },
  ]);
  // Unset provider means Ollama; unknown providers fail validation at load.
  assertEquals(resolveModels({ models: [{ model: "x", provider: "ollama" }] }), [{
    model: "x",
  }]);
});

Deno.test("resolveModels: defaults when models is invalid (validation happens at load)", () => {
  assertEquals(resolveModels({ models: [42] }), [...DEFAULT_MODELS]);
});

Deno.test("loadConfig: rejects values and models that fail the schema", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    await Deno.writeTextFile(path, '{"ANSWER": 42}');
    await assertRejects(
      () => loadConfig(path),
      Error,
      "not a valid noa config",
    );
    await Deno.writeTextFile(path, '{"models": [{"description": "no model"}]}');
    await assertRejects(() => loadConfig(path), Error, "models");
    await Deno.writeTextFile(path, '{"models": ["ok", {"model": ""}]}');
    await assertRejects(() => loadConfig(path), Error, "models");
    await Deno.writeTextFile(path, '{"models": [{"model": "x", "provider": "openai"}]}');
    await assertRejects(() => loadConfig(path), Error, "not a valid noa config");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("maskValue: masks secrets fully unless show is passed", () => {
  assertEquals(maskValue("MISTRAL_API_KEY", "abc123", false), "********");
  assertEquals(maskValue("MISTRAL_API_KEY", "abc123", true), "abc123");
  assertEquals(maskValue("NOA_TOOLS", "git,rg", false), "git,rg");
  assertEquals(isSecretKey("MY_TOKEN"), true);
  assertEquals(isSecretKey("NOA_TOOLS"), false);
});

Deno.test("loadConfig: returns empty for a missing file, errors on invalid JSON", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadConfig(`${dir}/missing.json`), {});
    await Deno.writeTextFile(`${dir}/broken.json`, "{not json");
    await assertRejects(() => loadConfig(`${dir}/broken.json`), Error, "not valid JSON");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

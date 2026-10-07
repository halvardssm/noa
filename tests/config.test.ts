import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  configDir,
  configFilePath,
  defaultModels,
  ensureConfigFile,
  getConfigFile,
  isSecretKey,
  loadConfigFile,
  maskValue,
  resolveList,
  SUGGESTED_TOOLS,
  writeConfigFile,
} from "../src/lib/config.ts";
import { withEnv, withNoaHome } from "./helpers.ts";

Deno.test("SUGGESTED_TOOLS: is the example shown in the CLI help", () => {
  assertEquals(SUGGESTED_TOOLS, "ls,cat,head,tail,wc,grep,find,jq,curl,date");
});

Deno.test("defaultModels: the ministral-3 cascade with complexity and provider", () => {
  const models = defaultModels();
  assertEquals(models.length, 3);
  assertEquals(models[0], {
    complexity: 1,
    provider: "ollama",
    model: "ministral-3:3b",
    description:
      "trivial questions, chat, simple lookups, basic arithmetic, formatting.",
  });
});

Deno.test("configDir: NOA_HOME overrides, HOME is the fallback", async () => {
  await withNoaHome({}, async (dir) => {
    assertEquals(configDir(), dir);
    assertEquals(configFilePath(), `${dir}/config.json`);
  });
  await withEnv({ NOA_HOME: undefined }, async () => {
    assert(configDir().endsWith("/noa"));
  });
});

Deno.test("resolveList: flag wins over file and defaults", () => {
  assertEquals(
    resolveList({ flag: "~/work/src", file: "~/dev", defaults: ["x"] }),
    ["~/work/src"],
  );
  assertEquals(resolveList({ file: " git , rg ,,git ", defaults: ["x"] }), [
    "git",
    "rg",
  ]);
  assertEquals(resolveList({ defaults: ["x"] }), ["x"]);
  assertEquals(resolveList({ defaults: [] }), []);
});

Deno.test("isSecretKey and maskValue: secrets never print unmasked", () => {
  assertEquals(isSecretKey("MISTRAL_API_KEY"), true);
  assertEquals(isSecretKey("MY_TOKEN"), true);
  assertEquals(isSecretKey("NOA_TOOLS"), false);
  assertEquals(maskValue("abc123", false), "********");
  assertEquals(maskValue("abc123", true), "abc123");
});

Deno.test("loadConfigFile: missing file means the default config", async () => {
  await withNoaHome({}, async (dir) => {
    const config = await loadConfigFile(`${dir}/config.json`);
    assertEquals(config.rules.length, 3);
    assertEquals(config.rules[0].model, "ministral-3:3b");
  });
});

Deno.test("loadConfigFile: invalid JSON has a clear message", async () => {
  await withNoaHome({}, async (dir) => {
    await Deno.writeTextFile(`${dir}/config.json`, "{not json");
    await assertRejects(
      () => loadConfigFile(`${dir}/config.json`),
      Error,
      "not valid JSON",
    );
  });
});

Deno.test("loadConfigFile: schema violations are rejected", async () => {
  await withNoaHome({}, async (dir) => {
    await Deno.writeTextFile(`${dir}/config.json`, '{"rules": [42]}');
    await assertRejects(() => loadConfigFile(`${dir}/config.json`));
  });
});

Deno.test("writeConfigFile + getConfigFile round-trip", async () => {
  await withNoaHome({}, async (dir) => {
    await writeConfigFile(`${dir}/config.json`, {
      rules: [{ complexity: 1, provider: "ollama", model: "qwen3:4b" }],
    });
    const loaded = await getConfigFile();
    assertEquals(loaded.rules, [
      { complexity: 1, provider: "ollama", model: "qwen3:4b" },
    ]);
  });
});

Deno.test("ensureConfigFile: creates the default once, preserves after", async () => {
  await withNoaHome({}, async (dir) => {
    const created = await ensureConfigFile();
    assertEquals(created.rules.length, 3);
    await Deno.writeTextFile(
      `${dir}/config.json`,
      '{"rules": [{"complexity": 1, "provider": "ollama", "model": "x"}]}',
    );
    const existing = await ensureConfigFile();
    assertEquals(existing.rules, [
      { complexity: 1, provider: "ollama", model: "x" },
    ]);
  });
});

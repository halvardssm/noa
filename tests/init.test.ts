import { assertEquals } from "@std/assert";
import { runInit } from "../src/cmd/init.ts";
import { defaultModelsFor } from "../src/lib/data.ts";
import { loadConfigFile } from "../src/lib/config.ts";
import {
  type FetchStub,
  jsonResponse,
  ndjsonResponse,
  withEnv,
  withFetch,
  withNoaHome,
} from "./helpers.ts";

/**
 * A fake daemon: answers liveness checks and records streamed pulls
 * (ollama-js reads the pull as an NDJSON stream).
 */
function ollamaDaemon(pulled: string[]): FetchStub {
  return (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return jsonResponse({ version: "0.12.0" });
    if (u.endsWith("/api/pull")) {
      // ollama-js sends {name, stream} to /api/pull.
      const body = JSON.parse((init as RequestInit).body as string);
      pulled.push(body.name);
      return ndjsonResponse([{ status: "success" }]);
    }
    throw new Error(`unexpected url ${u}`);
  };
}

/** The NOA_TEST seam: hardcoded dialogs and a hardcoded 16 GiB machine. */
function testEnv(): Record<string, string> {
  return { NOA_TEST: "1" };
}

Deno.test("defaultModelsFor: the systems check filters by RAM", () => {
  assertEquals(defaultModelsFor(4).map((s) => s.model), []);
  assertEquals(defaultModelsFor(8).map((s) => s.model), ["ministral-3:3b"]);
  // The hardcoded test machine has 16 GiB: the two smallest models.
  assertEquals(defaultModelsFor(16).map((s) => s.model), [
    "ministral-3:3b",
    "ministral-3:8b",
  ]);
  assertEquals(defaultModelsFor(64).map((s) => s.model), [
    "ministral-3:3b",
    "ministral-3:8b",
    "ministral-3:14b",
  ]);
});

Deno.test("init: default cascade on the hardcoded 16 GiB test machine", async () => {
  await withNoaHome({}, async (dir) => {
    const pulled: string[] = [];
    await withEnv(
      testEnv(),
      () =>
        withFetch(ollamaDaemon(pulled), async () => {
          await runInit({ flags: { empty: false, startDaemon: false } });
        }),
    );
    // The menu is hardcoded to the first option (default cascade) and
    // the confirm approves the download; 16 GiB admits 3b and 8b.
    assertEquals(pulled, ["ministral-3:3b", "ministral-3:8b"]);
    const saved = await loadConfigFile(`${dir}/config.json`);
    assertEquals(saved.rules.length, 3);
    assertEquals(saved.rules[0].model, "ministral-3:3b");
  });
});

Deno.test("init: a confirmed override replaces the existing config", async () => {
  await withNoaHome({}, async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.json`,
      '{"rules": [{"complexity": 1, "provider": "ollama", "model": "qwen3:4b"}]}',
    );
    const pulled: string[] = [];
    await withEnv(
      testEnv(),
      () =>
        withFetch(ollamaDaemon(pulled), async () => {
          // The hardcoded confirm approves the override; the menu's
          // default choice rewrites the file with the default cascade.
          await runInit({ flags: { empty: false, startDaemon: false } });
        }),
    );
    const saved = await loadConfigFile(`${dir}/config.json`);
    assertEquals(saved.rules.length, 3);
    assertEquals(saved.rules[0].model, "ministral-3:3b");
    // The default-cascade download still runs for the 16 GiB machine.
    assertEquals(pulled, ["ministral-3:3b", "ministral-3:8b"]);
  });
});

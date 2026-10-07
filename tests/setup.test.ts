import { assert, assertEquals } from "@std/assert";
import {
  appendEnvExports,
  defaultModelsFor,
  profilePathFor,
  runSetup,
} from "../src/setup.ts";
import { loadConfig } from "../src/config.ts";
import {
  jsonResponse,
  withEnv,
  withFetch,
  withLogs,
  withNoaHome,
  type FetchStub,
} from "./helpers.ts";

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

/** A fake Ollama daemon that records pulls. */
function ollamaDaemon(pulled: string[]): FetchStub {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return jsonResponse({ models: [] });
    if (u.endsWith("/api/pull")) {
      pulled.push(JSON.parse((init as RequestInit).body as string).model);
      return jsonResponse({ status: "success" });
    }
    throw new Error(`unexpected url ${u}`);
  };
}

/** Everything the NOA_TEST seam scripts, in one env block. */
function testEnv(script: {
  confirms?: string;
  texts?: string;
  ramGb?: number;
}): Record<string, string> {
  return {
    NOA_TEST: "1",
    NOA_TEST_CONFIRM: script.confirms ?? "",
    NOA_TEST_TEXT: script.texts ?? "",
    ...(script.ramGb !== undefined ? { NOA_TEST_RAM_GB: String(script.ramGb) } : {}),
    SHELL: "/bin/zsh",
  };
}

Deno.test("setup: default path pulls what the systems check allows", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(testEnv({ confirms: "y,y,y", ramGb: 32 }), () =>
      withFetch(ollamaDaemon(pulled), () =>
        withLogs(async (lines) => {
          assertEquals(await runSetup(), 0);
          assert(lines.some((l) => l.includes("GB of RAM")));
          assert(lines.some((l) => l.includes("the models this system can handle")));
          assert(lines.some((l) => l.includes("ministral-3:14b")));
          // Three confirms consumed: default setup, download set, memory cap.
          assertEquals(Deno.env.get("NOA_TEST_CONFIRM"), "");
        })
      )
    );
    assertEquals(pulled, ["ministral-3:3b", "ministral-3:8b", "ministral-3:14b"]);
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals((saved.models as { model: string }[]).length, 3);
  });
});

Deno.test("setup: default path on a small system skips big models with a note", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(testEnv({ confirms: "y,y", ramGb: 8 }), () =>
      withFetch(ollamaDaemon(pulled), () =>
        withLogs(async (lines) => {
          assertEquals(await runSetup(), 0);
          assert(lines.some((l) => l.includes("skipping (needs more RAM)")));
          assert(lines.some((l) => l.includes("ministral-3:8b")));
        })
      )
    );
    assertEquals(pulled, ["ministral-3:3b"]);
    const saved = await loadConfig(`${dir}/config.json`);
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
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(
      testEnv({
        confirms: "n,y",
        texts: "qwen3:4b, llama3.1:8b|chat and trivia|code questions",
        ramGb: 64,
      }),
      () =>
        withFetch(ollamaDaemon(pulled), async () => {
          assertEquals(await runSetup(), 0);
        }),
    );
    assertEquals(pulled, ["qwen3:4b", "llama3.1:8b"]);
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals(saved.models, [
      { model: "qwen3:4b", description: "chat and trivia" },
      { model: "llama3.1:8b", description: "code questions" },
    ]);
    // The memory-cap profile was declined (confirms ran out of y's).
    assert(!await exists(`${dir}/.zshrc`));
  });
});

Deno.test("setup: an exhausted confirm queue declines (the memory cap)", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await withEnv(testEnv({ confirms: "y,y", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), async () => {
        assertEquals(await runSetup(), 0);
      })
    );
    assert(!await exists(`${dir}/.zshrc`));
  });
});

Deno.test("setup: a confirmed memory cap is written to the shell profile", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await withEnv(testEnv({ confirms: "y,y,y", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), async () => {
        assertEquals(await runSetup(), 0);
      })
    );
    const profile = await Deno.readTextFile(`${dir}/.zshrc`);
    assert(profile.includes("export OLLAMA_MAX_LOADED_MODELS=2"));
    assert(profile.includes("export OLLAMA_KEEP_ALIVE=5m"));
  });
});

Deno.test("setup: never stores keys, prints the environment hint", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await withEnv(testEnv({ confirms: "y,n", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), () =>
        withLogs(async (lines) => {
          assertEquals(await runSetup(), 0);
          assert(lines.some((l) => l.includes("export MISTRAL_API_KEY")));
        })
      )
    );
    const saved = await Deno.readTextFile(`${dir}/config.json`);
    assert(!saved.includes("API_KEY"));
  });
});

Deno.test("setup: keeps unrelated settings when the config already exists", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await Deno.writeTextFile(`${dir}/config.json`, '{"ZODIAC": "leo", "models": []}');
    await withEnv(testEnv({ confirms: "y,n", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), async () => {
        assertEquals(await runSetup(), 0);
      })
    );
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals(saved.ZODIAC, "leo");
    // Declining downloads still configures the default cascade.
    assertEquals((saved.models as { model: string }[]).length, 3);
  });
});

Deno.test("setup: a daemon that is down reports instructions", async () => {
  await withNoaHome({ home: true }, async () => {
    await withEnv(testEnv({}), () =>
      withFetch(() => Promise.reject(new TypeError("refused")), () =>
        withLogs(async (lines) => {
          assertEquals(await runSetup(), 1);
          assert(
            lines.some((l) =>
              l.includes("ollama serve") || l.includes("Ollama is not running")
            ),
          );
        })
      )
    );
  });
});

Deno.test("setup: an empty custom list skips model setup cleanly", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(testEnv({ confirms: "n", texts: "  ", ramGb: 32 }), () =>
      withFetch(ollamaDaemon(pulled), async () => {
        assertEquals(await runSetup(), 0);
      })
    );
    assertEquals(pulled, []);
    const saved = await loadConfig(`${dir}/config.json`);
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

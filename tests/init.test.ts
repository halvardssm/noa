import { assert, assertEquals } from "@std/assert";
import {
  appendEnvExports,
  defaultModelsFor,
  profilePathFor,
  runInit,
} from "../src/init.ts";
import { loadConfig } from "../src/config.ts";
import {
  jsonResponse,
  ndjsonResponse,
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

/** A fake Ollama daemon that records pulls and streams progress events. */
function ollamaDaemon(pulled: string[]): FetchStub {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return jsonResponse({ models: [] });
    if (u.endsWith("/api/pull")) {
      pulled.push(JSON.parse((init as RequestInit).body as string).model);
      return ndjsonResponse([
        { status: "pulling manifest" },
        { status: "downloading", digest: "sha256:x", total: 1000, completed: 500 },
        { status: "verifying sha256 digest" },
        { status: "success" },
      ]);
    }
    throw new Error(`unexpected url ${u}`);
  };
}

/** A daemon whose pulls fail mid-stream with an Ollama error event. */
function failingPullDaemon(pulled: string[]): FetchStub {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return jsonResponse({ models: [] });
    if (u.endsWith("/api/pull")) {
      pulled.push(JSON.parse((init as RequestInit).body as string).model);
      return ndjsonResponse([{ error: "some manifest problem" }]);
    }
    throw new Error(`unexpected url ${u}`);
  };
}

/** Everything the NOA_TEST seam scripts, in one env block. */
function testEnv(script: {
  confirms?: string;
  select?: string;
  ramGb?: number;
}): Record<string, string> {
  return {
    NOA_TEST: "1",
    NOA_TEST_CONFIRM: script.confirms ?? "",
    NOA_TEST_SELECT: script.select ?? "",
    ...(script.ramGb !== undefined ? { NOA_TEST_RAM_GB: String(script.ramGb) } : {}),
    SHELL: "/bin/zsh",
  };
}

Deno.test("init: default path pulls what the systems check allows", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(testEnv({ select: "0", confirms: "y,y", ramGb: 32 }), () =>
      withFetch(ollamaDaemon(pulled), () =>
        withLogs(async (lines) => {
          assertEquals(await runInit(), 0);
          assert(lines.some((l) => l.includes("GB of RAM")));
          assert(lines.some((l) => l.includes("the models this system can handle")));
          assert(lines.some((l) => l.includes("ministral-3:14b")));
          // The select and both confirms were consumed.
          assertEquals(Deno.env.get("NOA_TEST_SELECT"), "");
          assertEquals(Deno.env.get("NOA_TEST_CONFIRM"), "");
        })
      )
    );
    assertEquals(pulled, ["ministral-3:3b", "ministral-3:8b", "ministral-3:14b"]);
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals((saved.models as { model: string }[]).length, 3);
  });
});

Deno.test("init: default path on a small system skips big models with a note", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(testEnv({ select: "0", confirms: "y,y", ramGb: 8 }), () =>
      withFetch(ollamaDaemon(pulled), () =>
        withLogs(async (lines) => {
          assertEquals(await runInit(), 0);
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

Deno.test("init: empty models via the selector", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    const pulled: string[] = [];
    await withEnv(testEnv({ select: "1", ramGb: 32 }), () =>
      withFetch(ollamaDaemon(pulled), () =>
        withLogs(async (lines) => {
          assertEquals(await runInit(), 0);
          assert(
            lines.some((l) => l.includes("writing an empty models list")),
          );
        })
      )
    );
    assertEquals(pulled, []);
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals(saved.models, []);
  });
});

Deno.test("init: --empty writes an empty list without any selection or daemon", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    // No daemon: --empty never talks to Ollama.
    await withEnv(
      testEnv({}),
      () =>
        withFetch(
          () => {
            throw new Error("no fetch expected with --empty");
          },
          async () => {
            assertEquals(await runInit({ empty: true }), 0);
            // The selector was never consulted.
            assertEquals(Deno.env.get("NOA_TEST_SELECT"), "");
          },
        ),
    );
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals(saved.models, []);
  });
});

Deno.test("init: an exhausted confirm queue declines (the memory cap)", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await withEnv(testEnv({ select: "0", confirms: "y", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), async () => {
        assertEquals(await runInit(), 0);
      })
    );
    assert(!await exists(`${dir}/.zshrc`));
  });
});

Deno.test("init: a confirmed memory cap is written to the shell profile", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await withEnv(testEnv({ select: "0", confirms: "y,y", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), async () => {
        assertEquals(await runInit(), 0);
      })
    );
    const profile = await Deno.readTextFile(`${dir}/.zshrc`);
    assert(profile.includes("export OLLAMA_MAX_LOADED_MODELS=2"));
    assert(profile.includes("export OLLAMA_KEEP_ALIVE=5m"));
  });
});

Deno.test("init: never stores keys, prints the environment hint", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await withEnv(testEnv({ select: "0", confirms: "n", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), () =>
        withLogs(async (lines) => {
          assertEquals(await runInit(), 0);
          assert(lines.some((l) => l.includes("export MISTRAL_API_KEY")));
        })
      )
    );
    const saved = await Deno.readTextFile(`${dir}/config.json`);
    assert(!saved.includes("API_KEY"));
  });
});

Deno.test("init: keeps unrelated settings when the config already exists", async () => {
  await withNoaHome({ home: true }, async (dir) => {
    await Deno.writeTextFile(`${dir}/config.json`, '{"ZODIAC": "leo", "models": []}');
    await withEnv(testEnv({ select: "0", confirms: "n", ramGb: 32 }), () =>
      withFetch(ollamaDaemon([]), async () => {
        assertEquals(await runInit(), 0);
      })
    );
    const saved = await loadConfig(`${dir}/config.json`);
    assertEquals(saved.ZODIAC, "leo");
    // Declining downloads still configures the default cascade.
    assertEquals((saved.models as { model: string }[]).length, 3);
  });
});

Deno.test("init: a daemon that is down reports instructions", async () => {
  await withNoaHome({ home: true }, async () => {
    await withEnv(testEnv({}), () =>
      withFetch(() => Promise.reject(new TypeError("refused")), () =>
        withLogs(async (lines) => {
          assertEquals(await runInit(), 1);
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

Deno.test("init: a pull that fails mid-stream aborts with the error", async () => {
  await withNoaHome({ home: true }, async () => {
    const pulled: string[] = [];
    await withEnv(testEnv({ select: "0", confirms: "y", ramGb: 32 }), () =>
      withFetch(failingPullDaemon(pulled), () =>
        withLogs(async (lines) => {
          assertEquals(await runInit(), 1);
          assert(lines.some((l) => l.includes("could not pull ministral-3:3b")));
        })
      )
    );
    assertEquals(pulled, ["ministral-3:3b"]);
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

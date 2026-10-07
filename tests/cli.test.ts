import { assert, assertEquals } from "@std/assert";

/** CLI tests: run the real entry point as a subprocess. */
async function runCli(
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("deno", {
    args: ["run", "-A", "cli.ts", ...args],
    cwd: Deno.cwd(),
    env: {
      ...Deno.env.toObject(),
      NOA_HOME: env.NOA_HOME ?? (await Deno.makeTempDir({ prefix: "noa-cli-" })),
      ...env,
    },
    stdin: input === undefined ? "inherit" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  if (input !== undefined) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    writer.releaseLock();
    await process.stdin.close();
  }
  const output = await process.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function withHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "noa-cli-" });
  try {
    await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("cli: config set/get/list/unset round-trip; secrets are refused", async () => {
  await withHome(async (home) => {
    const set = await runCli(["config", "set", "ZODIAC", "leo"], { NOA_HOME: home });
    assertEquals(set.code, 0);
    const stat = await Deno.stat(`${home}/config.json`);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);

    const get = await runCli(["config", "get", "ZODIAC"], { NOA_HOME: home });
    assertEquals(get.stdout.trim(), "leo");

    const listed = await runCli(["config", "list"], { NOA_HOME: home });
    assertEquals(listed.stdout.trim(), "ZODIAC=leo");

    const unset = await runCli(["config", "unset", "ZODIAC"], { NOA_HOME: home });
    assertEquals(unset.code, 0);
    const gone = await runCli(["config", "get", "ZODIAC"], { NOA_HOME: home });
    assertEquals(gone.code, 1);
    assert(gone.stderr.includes("not set"));

    // Secrets are never stored.
    const secret = await runCli(
      ["config", "set", "MISTRAL_API_KEY", "sk-secret"],
      { NOA_HOME: home },
    );
    assert(secret.code !== 0);
    assert(secret.stderr.includes("secrets are not stored"));
    const stored = await Deno.readTextFile(`${home}/config.json`);
    assert(!stored.includes("sk-secret"));
  });
});

Deno.test("cli: config set preserves unrelated entries", async () => {
  await withHome(async (home) => {
    await Deno.mkdir(home, { recursive: true });
    await Deno.writeTextFile(`${home}/config.json`, '{"ZODIAC": "leo"}');
    await runCli(["config", "set", "NOA_TOOLS", "git,rg"], { NOA_HOME: home });
    const text = await Deno.readTextFile(`${home}/config.json`);
    const parsed = JSON.parse(text);
    assertEquals(parsed, { ZODIAC: "leo", NOA_TOOLS: "git,rg" });
    const listed = await runCli(["config", "list"], { NOA_HOME: home });
    assert(listed.stdout.includes("ZODIAC=leo"));
    assert(listed.stdout.includes("NOA_TOOLS=git,rg"));
  });
});

Deno.test("cli: a question without ollama fails with a clear message", async () => {
  await withHome(async (home) => {
    const result = await runCli(["--prompt", "what is 2+2"], {
      NOA_HOME: home,
      OLLAMA_HOST: "http://localhost:1", // nothing listens here
    });
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assert(result.stderr.includes("Ollama is not running"));
  });
});

Deno.test("cli: setup refuses non-interactive stdin with instructions", async () => {
  const result = await runCli(["setup"]);
  assert(result.code !== 0);
  assert(result.stderr.includes("interactive"));
  assert(result.stderr.includes("ollama pull"));
});

Deno.test("cli: --tools is rejected as an unknown flag", async () => {
  await withHome(async (home) => {
    const result = await runCli(["--tools"], { NOA_HOME: home });
    assert(result.code !== 0);
    assert(result.stderr.includes("--tools"));
  });
});

Deno.test("cli: a bare question without --prompt is a usage error", async () => {
  await withHome(async (home) => {
    const result = await runCli(["what is 2+2"], { NOA_HOME: home });
    assert(result.code !== 0);
    assert(result.stderr.includes("Unknown command"));
  });
});

Deno.test("cli: help lists the subcommands and the prompt flag", async () => {
  const result = await runCli(["--help"]);
  assert(result.code === 0);
  assert(result.stdout.includes("config"));
  assert(result.stdout.includes("setup"));
  assert(result.stdout.includes("--prompt"));
});

Deno.test("cli: bare noa starts the repl; exit ends it", async () => {
  const result = await runCli([], {}, "exit\n");
  assertEquals(result.code, 0);
  assert(result.stderr.includes("noa repl"));
});

Deno.test("cli: noa repl handles questions and EOF, surviving errors", async () => {
  await withHome(async (home) => {
    const result = await runCli(
      ["repl"],
      { NOA_HOME: home, OLLAMA_HOST: "http://localhost:1" },
      "what is 2+2\n",
    );
    // The question fails (dead daemon) but the session survives until EOF.
    assertEquals(result.code, 0);
    assert(result.stderr.includes("Ollama is not running"));
    assert(result.stderr.includes("noa repl"));
    assertEquals(result.stdout, "");
  });
});

Deno.test("cli: noa repl quits on exit/quit", async () => {
  const quit = await runCli(["repl"], {}, "quit\n");
  assertEquals(quit.code, 0);
  const slashExit = await runCli(["repl"], {}, "/exit\n");
  assertEquals(slashExit.code, 0);
});

Deno.test("cli: routing logs only appear with --debug", async () => {
  await withHome(async (home) => {
    // A legacy key in the config produces a log-channel warning; without
    // --debug it is suppressed, with --debug it is shown. The dead daemon
    // produces a real error on stderr either way.
    await Deno.mkdir(home, { recursive: true });
    await Deno.writeTextFile(
      `${home}/config.json`,
      '{"MISTRAL_API_KEY": "legacy", "ZODIAC": "leo"}',
    );
    const quiet = await runCli(
      ["--prompt", "hi"],
      { NOA_HOME: home, OLLAMA_HOST: "http://localhost:1" },
    );
    assert(quiet.stderr.includes("Ollama is not running"));
    assert(!quiet.stderr.includes("is ignored"), "logs suppressed without --debug");

    const loud = await runCli(
      ["--prompt", "hi", "--debug"],
      { NOA_HOME: home, OLLAMA_HOST: "http://localhost:1" },
    );
    assert(loud.stderr.includes("Ollama is not running"));
    assert(loud.stderr.includes("is ignored"), "logs shown with --debug");
  });
});

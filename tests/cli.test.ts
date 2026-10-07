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
      NOA_HOME: env.NOA_HOME ??
        (await Deno.makeTempDir({ prefix: "noa-cli-" })),
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

Deno.test("cli: bare init without a terminal and a dead daemon exits with instructions", async () => {
  const result = await runCli(["init"], { OLLAMA_HOST: "http://localhost:1" });
  assert(result.code !== 0);
  assert(result.stderr.includes("Ollama is not running"));
  assert(result.stderr.includes("--start-daemon"));
});

Deno.test("cli: init --empty still requires a reachable daemon", async () => {
  await withHome(async (home) => {
    const result = await runCli(["init", "--empty"], {
      NOA_HOME: home,
      OLLAMA_HOST: "http://localhost:1",
    });
    assertEquals(result.code, 1);
    assert(result.stderr.includes("Ollama is not running"));
  });
});

Deno.test("cli: init help documents both flags", async () => {
  const result = await runCli(["init", "--help"]);
  assert(result.code === 0);
  assert(result.stdout.includes("--empty"));
  assert(result.stdout.includes("--start-daemon"));
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
  assert(result.stdout.includes("init"));
  assert(result.stdout.includes("repl"));
  assert(result.stdout.includes("sync"));
  assert(result.stdout.includes("--prompt"));
});

Deno.test("cli: noa repl with a dead daemon exits with instructions", async () => {
  await withHome(async (home) => {
    const result = await runCli(
      ["repl"],
      { NOA_HOME: home, OLLAMA_HOST: "http://localhost:1" },
      "what is 2+2\n",
    );
    assertEquals(result.code, 1);
    assert(result.stderr.includes("Ollama is not running"));
  });
});

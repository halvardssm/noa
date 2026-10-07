import { assert, assertEquals, assertRejects } from "@std/assert";
import { createGate, expandTilde, screenCurlArgs } from "../src/lib/tools.ts";
import { withEnv, withLogRecords } from "./helpers.ts";

async function tempWorkspace(): Promise<
  { dir: string; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "noa-gate-" });
  return {
    dir,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

Deno.test("gate: runs an allowlisted command and captures output", async () => {
  const ws = await tempWorkspace();
  try {
    await withLogRecords(async (records) => {
      const gate = await createGate({
        allowTools: ["echo", "cat"],
        allowPaths: [ws.dir],
      });
      const result = await gate.run("echo", ["hello"]);
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), "hello");
      const logged = records.map((r) => r.message.join(""));
      assert(logged.some((l) => l.includes("echo")));
    });
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: rejects a command outside the allowlist", async () => {
  const ws = await tempWorkspace();
  try {
    const gate = await createGate({
      allowTools: ["ls"],
      allowPaths: [ws.dir],
    });
    await assertRejects(
      () => gate.run("rm", ["x"]),
      Error,
      "not in the allowlist",
    );
    await assertRejects(
      () => gate.run("git", ["status"]),
      Error,
      "not in the allowlist",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: reads a file inside the allowed paths", async () => {
  const ws = await tempWorkspace();
  try {
    await Deno.writeTextFile(`${ws.dir}/note.txt`, "inside\n");
    const gate = await createGate({
      allowTools: ["cat"],
      allowPaths: [ws.dir],
    });
    const result = await gate.run("cat", [`${ws.dir}/note.txt`]);
    assertEquals(result.stdout, "inside\n");
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: rejects an argument that names an existing path outside the allowed paths", async () => {
  const ws = await tempWorkspace();
  const outside = await Deno.makeTempFile({ prefix: "noa-secret-" });
  try {
    const gate = await createGate({
      allowTools: ["cat"],
      allowPaths: [ws.dir],
    });
    await assertRejects(
      () => gate.run("cat", [outside]),
      Error,
      "outside the allowed paths",
    );
  } finally {
    await ws.cleanup();
    await Deno.remove(outside);
  }
});

Deno.test("gate: rejects traversal (~/dev/../secret style)", async () => {
  const ws = await tempWorkspace();
  const outside = await Deno.makeTempFile({ prefix: "noa-secret-" });
  try {
    await Deno.writeTextFile(`${ws.dir}/inside.txt`, "x");
    const gate = await createGate({
      allowTools: ["cat"],
      allowPaths: [ws.dir],
    });
    await assertRejects(
      () => gate.run("cat", [`${ws.dir}/../${outside.split("/").pop()}`]),
      Error,
      "outside the allowed paths",
    );
  } finally {
    await ws.cleanup();
    await Deno.remove(outside);
  }
});

Deno.test("gate: rejects a symlink inside the workspace pointing outside", async () => {
  const ws = await tempWorkspace();
  const outside = await Deno.makeTempFile({ prefix: "noa-secret-" });
  try {
    await Deno.symlink(outside, `${ws.dir}/leak`);
    const gate = await createGate({
      allowTools: ["cat"],
      allowPaths: [ws.dir],
    });
    await assertRejects(
      () => gate.run("cat", [`${ws.dir}/leak`]),
      Error,
      "symlink",
    );
  } finally {
    await ws.cleanup();
    await Deno.remove(outside);
  }
});

Deno.test("gate: accepts relative paths that resolve inside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await Deno.writeTextFile(`${ws.dir}/note.txt`, "rel\n");
    const gate = await createGate({
      allowTools: ["cat"],
      allowPaths: [ws.dir],
      cwd: ws.dir,
    });
    const result = await gate.run("cat", ["note.txt"]);
    assertEquals(result.stdout, "rel\n");
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: rejects a custom allowlist entry resolved inside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    const bin = `${ws.dir}/evil.sh`;
    await Deno.writeTextFile(bin, "#!/bin/sh\n");
    await Deno.chmod(bin, 0o755);
    await assertRejects(
      () =>
        createGate({
          allowTools: ["ls", bin],
          allowPaths: [ws.dir],
        }),
      Error,
      "inside the writable workspace",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: rejects a tilde argument outside the workspace", async () => {
  const ws = await tempWorkspace();
  const home = await Deno.makeTempDir({ prefix: "noa-home-" });
  try {
    await Deno.writeTextFile(`${home}/.ssh-id_rsa`, "SECRET");
    await withEnv({ HOME: home }, async () => {
      const gate = await createGate({
        allowTools: ["cat"],
        allowPaths: [ws.dir],
      });
      await assertRejects(
        () => gate.run("cat", ["~/.ssh-id_rsa"]),
        Error,
        "outside the allowed paths",
      );
    });
  } finally {
    await ws.cleanup();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("gate: logs rejections", async () => {
  const ws = await tempWorkspace();
  try {
    await withLogRecords(async (records) => {
      const gate = await createGate({
        allowTools: ["cat"],
        allowPaths: [ws.dir],
      });
      await assertRejects(() => gate.run("rm", ["-rf", "/"]));
      const logged = records.map((r) => r.message.join(""));
      assert(logged.some((l) => l.includes("rejected") && l.includes("rm")));
    });
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: reports the command's exit code and stderr", async () => {
  const ws = await tempWorkspace();
  try {
    const gate = await createGate({
      allowTools: ["cat"],
      allowPaths: [ws.dir],
    });
    const result = await gate.run("cat", [
      `${ws.dir}/missing-but-not-a-real-path.txt`,
    ]);
    assert(result.code !== 0);
    assert(result.stderr.length > 0);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("screenCurlArgs: rejects method, body, and upload arguments", () => {
  assertEquals(screenCurlArgs(["https://example.com"]), null);
  assertEquals(screenCurlArgs(["-X", "GET", "https://example.com"]), null);
  assertEquals(screenCurlArgs(["--request", "get", "https://x.test"]), null);
  assertEquals(screenCurlArgs(["-X", "POST", "https://x.test"]), "-X POST");
  assertEquals(
    screenCurlArgs(["--request", "PUT", "https://x.test"]),
    "--request PUT",
  );
  assertEquals(screenCurlArgs(["-d", "a=b", "https://x.test"]), "-d");
  assertEquals(screenCurlArgs(["--data", "a=b", "https://x.test"]), "--data");
  assertEquals(
    screenCurlArgs(["--data-raw", "x", "https://x.test"]),
    "--data-raw",
  );
  assertEquals(
    screenCurlArgs(["--data-urlencode", "x", "https://x.test"]),
    "--data-urlencode",
  );
  assertEquals(screenCurlArgs(["-T", "file", "https://x.test"]), "-T");
  assertEquals(
    screenCurlArgs(["--upload-file", "f", "https://x.test"]),
    "--upload-file",
  );
  assertEquals(screenCurlArgs(["-F", "a=b", "https://x.test"]), "-F");
  assertEquals(screenCurlArgs(["--form", "a=b", "https://x.test"]), "--form");
  assertEquals(screenCurlArgs(["-dpayload", "https://x.test"]), "-dpayload");
  assertEquals(screenCurlArgs(["-XPOST", "https://x.test"]), "-XPOST");
});

Deno.test("gate: rejects curl invocations with body arguments", async () => {
  const ws = await tempWorkspace();
  try {
    const gate = await createGate({
      allowTools: ["curl"],
      allowPaths: [ws.dir],
    });
    await assertRejects(
      () => gate.run("curl", ["-d", "x=1", "https://example.com"]),
      Error,
      "GET-only",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: expands ~ in arguments for the child (no shell)", async () => {
  const home = await Deno.makeTempDir({ prefix: "noa-home-" });
  try {
    await Deno.writeTextFile(`${home}/note.txt`, "tilde\n");
    await withEnv({ HOME: home }, async () => {
      const gate = await createGate({
        allowTools: ["cat"],
        allowPaths: [home],
      });
      const result = await gate.run("cat", ["~/note.txt"]);
      assertEquals(result.stdout, "tilde\n");
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("gate: rm requires approval even when allowlisted — a declined confirm rejects", async () => {
  const ws = await tempWorkspace();
  try {
    await Deno.writeTextFile(`${ws.dir}/notes.txt`, "x");
    // Without NOA_TEST the global confirm dialog answers itself false
    // on a non-interactive stdin, so approval is always declined.
    const gate = await createGate({
      allowTools: ["rm"],
      allowPaths: [ws.dir],
    });
    await assertRejects(
      () => gate.run("rm", [`${ws.dir}/notes.txt`]),
      Error,
      "not approved",
    );
    assert(await exists(`${ws.dir}/notes.txt`), "the file is untouched");
  } finally {
    await ws.cleanup();
  }
});

Deno.test("gate: rm with approval runs and stays screened", async () => {
  const ws = await tempWorkspace();
  const outside = await Deno.makeTempFile({ prefix: "noa-outside-" });
  try {
    await Deno.writeTextFile(`${ws.dir}/notes.txt`, "x");
    await withEnv({ NOA_TEST: "1" }, async () => {
      const gate = await createGate({
        allowTools: ["rm"],
        allowPaths: [ws.dir],
      });
      // Approved for a file inside the allowed paths.
      const result = await gate.run("rm", [`${ws.dir}/notes.txt`]);
      assertEquals(result.code, 0);
      // Approval can never override path screening: this is rejected
      // before any approval prompt.
      await assertRejects(
        () => gate.run("rm", [outside]),
        Error,
        "outside the allowed paths",
      );
    });
  } finally {
    await ws.cleanup();
    await Deno.remove(outside);
  }
});

Deno.test("gate: rm without a terminal is always rejected", async () => {
  const ws = await tempWorkspace();
  try {
    {
      const gate = await createGate({
        allowTools: ["rm"],
        allowPaths: [ws.dir],
      });
      await assertRejects(
        () => gate.run("rm", [`${ws.dir}/notes.txt`]),
        Error,
        "not approved",
      );
    }
  } finally {
    await ws.cleanup();
  }
});

Deno.test("expandTilde: expands ~ and ~/x with the given home", () => {
  assertEquals(expandTilde("~", "/home/u"), "/home/u");
  assertEquals(expandTilde("~/dev/x", "/home/u"), "/home/u/dev/x");
  assertEquals(expandTilde("relative", "/home/u"), "relative");
  assertEquals(expandTilde("/abs/path", "/home/u"), "/abs/path");
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

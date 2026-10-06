import { assertEquals, assertRejects } from "@std/assert";
import {
  defaultAllowPaths,
  formatValue,
  isSecretKey,
  isUnderHome,
  loadEnvFile,
  maskValue,
  resolveList,
  setEnvValue,
  SUGGESTED_TOOLS,
  unsetEnvValue,
} from "../src/config.ts";

Deno.test("resolveList: falls back to defaults", () => {
  assertEquals(resolveList({ defaults: ["x"] }), ["x"]);
});

Deno.test("resolveList: an empty default yields no entries", () => {
  assertEquals(resolveList({ defaults: [] }), []);
});

Deno.test("SUGGESTED_TOOLS: is the example shown in the CLI help", () => {
  assertEquals(
    SUGGESTED_TOOLS,
    "ls,cat,head,tail,wc,grep,find,jq,curl",
  );
});

Deno.test("resolveList: flag wins over env, file, and defaults", () => {
  const list = resolveList({
    flag: "~/work/src",
    env: "~/work",
    file: "~/dev,~/work",
    defaults: ["~/dev"],
  });
  assertEquals(list, ["~/work/src"]);
});

Deno.test("resolveList: env wins over file when flag is absent", () => {
  const list = resolveList({
    env: "~/work",
    file: "~/dev,~/work",
    defaults: ["~/dev"],
  });
  assertEquals(list, ["~/work"]);
});

Deno.test("resolveList: file wins over defaults when env is absent", () => {
  const list = resolveList({
    file: "~/dev,~/work",
    defaults: ["~/dev"],
  });
  assertEquals(list, ["~/dev", "~/work"]);
});

Deno.test("resolveList: trims entries, drops empties, dedupes", () => {
  const list = resolveList({ flag: " git , rg , ,git, ", defaults: [] });
  assertEquals(list, ["git", "rg"]);
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

Deno.test("setEnvValue: creates file with mode 600 and parent dirs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/nested/noa/.env`;
    await setEnvValue(path, "MISTRAL_API_KEY", "abc123");
    const stat = await Deno.stat(path);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);
    const text = await Deno.readTextFile(path);
    assertEquals(text, "MISTRAL_API_KEY=abc123\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setEnvValue: updates only the named key, preserving order and comments", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    const original = "# my keys\nANTHROPIC_API_KEY=sk-ant-1\nZODIAC=leo\n";
    await Deno.writeTextFile(path, original);
    await setEnvValue(path, "ANTHROPIC_API_KEY", "sk-ant-2");
    assertEquals(
      await Deno.readTextFile(path),
      "# my keys\nANTHROPIC_API_KEY=sk-ant-2\nZODIAC=leo\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setEnvValue: appends a new key without touching existing entries", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    await Deno.writeTextFile(path, "ANTHROPIC_API_KEY=sk-ant-1\n");
    await setEnvValue(path, "NOA_TOOLS", "git,rg");
    assertEquals(
      await Deno.readTextFile(path),
      "ANTHROPIC_API_KEY=sk-ant-1\nNOA_TOOLS=git,rg\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setEnvValue: quotes values with spaces so they round-trip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    await setEnvValue(path, "NOA_GREETING", "hello world");
    assertEquals(await loadEnvFile(path), { NOA_GREETING: "hello world" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setEnvValue: tightens loose permissions on an existing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    await Deno.writeTextFile(path, "A=1\n");
    await Deno.chmod(path, 0o644);
    await setEnvValue(path, "B", "2");
    const stat = await Deno.stat(path);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setEnvValue: rejects invalid keys", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    await assertRejects(() => setEnvValue(path, "BAD KEY", "x"), TypeError);
    await assertRejects(() => setEnvValue(path, "EVIL\nINJECTED", "x"), TypeError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unsetEnvValue: removes only the named key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    await Deno.writeTextFile(path, "A=1\nB=2\n");
    assertEquals(await unsetEnvValue(path, "A"), true);
    assertEquals(await Deno.readTextFile(path), "B=2\n");
    assertEquals(await unsetEnvValue(path, "A"), false);
    assertEquals(await Deno.readTextFile(path), "B=2\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("maskValue: masks secrets fully unless show is passed", () => {
  assertEquals(maskValue("MISTRAL_API_KEY", "abc123", false), "********");
  assertEquals(maskValue("MISTRAL_API_KEY", "abc123", true), "abc123");
  assertEquals(maskValue("MY_TOKEN", "t", false), "********");
  assertEquals(maskValue("DB_SECRET", "s", false), "********");
  assertEquals(maskValue("NOA_TOOLS", "git,rg", false), "git,rg");
});

Deno.test("isSecretKey: recognizes KEY, TOKEN, SECRET suffixes", () => {
  assertEquals(isSecretKey("MISTRAL_API_KEY"), true);
  assertEquals(isSecretKey("MY_TOKEN"), true);
  assertEquals(isSecretKey("DB_SECRET"), true);
  assertEquals(isSecretKey("NOA_TOOLS"), false);
});

Deno.test("formatValue: quotes only when needed", () => {
  assertEquals(formatValue("git,rg"), "git,rg");
  assertEquals(formatValue("hello world"), '"hello world"');
  assertEquals(formatValue('say "hi"'), '"say \\"hi\\""');
});

Deno.test("loadEnvFile: returns empty record for a missing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadEnvFile(`${dir}/.env`), {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Build script for `deno task compile` (security rule 5): compiles noa with
 * strict permission flags baked from the current environment —
 * NOA_TOOLS -> --allow-run, NOA_ALLOW_PATHS -> --allow-read/--allow-write.
 * With NOA_TOOLS unset the binary cannot spawn anything at runtime.
 */

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

const env = Deno.env;
const home = env.get("HOME");
if (home === undefined) {
  console.error("HOME is not set");
  Deno.exit(1);
}
const configDir = env.get("NOA_HOME") ?? `${home}/.config/noa`;
const paths = (env.get("NOA_ALLOW_PATHS") ?? Deno.cwd())
  .split(",")
  .map((p) => expandTilde(p.trim(), home))
  .filter((p) => p !== "");

const tools = env.get("NOA_TOOLS") ?? "";
const args = [
  "compile",
  "--allow-net",
  "--allow-sys=systemMemoryInfo",
  "--allow-env=NOA_HOME,HOME,MISTRAL_API_KEY,ANTHROPIC_API_KEY,OLLAMA_HOST",
  `--allow-read=${[...paths, configDir].join(",")}`,
  `--allow-write=${[...paths, configDir].join(",")}`,
  ...(tools === "" ? [] : [`--allow-run=${tools}`]),
  "--output",
  "compiled/noa",
  "src/main.ts",
];

console.error(`compile: deno ${args.join(" ")}`);
const command = new Deno.Command("deno", {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
Deno.exit((await command.output()).code);

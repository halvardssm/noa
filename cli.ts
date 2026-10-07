import { runCommand } from "@stdx/cli";
import { rootCommand } from "./src/cmd/mod.ts";

if (import.meta.main) {
  Deno.exit(await runCommand(rootCommand, Deno.args));
}

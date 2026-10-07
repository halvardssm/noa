import { runCommand } from "@stdx/cli";
import { rootCommand } from "./src/commands.ts";

if (import.meta.main) {
  Deno.exit(await runCommand(rootCommand, Deno.args));
}

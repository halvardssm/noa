/**
 * Runs one gate invocation as a child process for tools.test.ts. The
 * real (non-NOA_TEST) confirm path is only safely reachable with stdin
 * closed — in-process, whatever stdin the test runner provides (a TTY
 * makes confirm interactive, an open pipe makes it block) leaks into
 * the dialog.
 */
import { createGate } from "../src/lib/tools.ts";

const [allowTools, allowPaths, command, ...args] = Deno.args;
const gate = await createGate({
  allowTools: allowTools.split(","),
  allowPaths: [allowPaths],
});
try {
  const result = await gate.run(command, args);
  console.log(`ok ${result.code}`);
} catch (error) {
  console.log(
    `error ${error instanceof Error ? error.message : String(error)}`,
  );
}

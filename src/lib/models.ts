import { getOllama } from "./ollama.ts";
const logger = getLogger(["noa", "models"]);
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { exitWithError } from "./io.ts";
import { isTestMode } from "./utils.ts";
import { getLogger } from "./log.ts";

/**
 * Pulls a model from the Ollama library through the local daemon
 * (rule 6: noa never spawns it). The pull is streamed, and each
 * download event drives a live progress bar on stderr; when the
 * daemon rejects the pull, ollama-js throws with its own message.
 * Under `NOA_TEST=1` no bar is rendered — the events are just
 * consumed.
 */
export async function pullModel(
  model: string,
): Promise<void> {
  logger.info(`pulling model '${model}'...`);

  const ollama = getOllama();

  let progress: ProgressBar | null = null;

  try {
    const stream = await ollama.pull({ model, stream: true });

    // Download events carry `total`/`completed` per layer; the
    // manifest/verify steps carry neither, so the bar is created
    // lazily on the first event that has a size.

    for await (const event of stream) {
      if (isTestMode()) continue;
      if (typeof event.total !== "number" || event.total <= 0) continue;
      const completed = typeof event.completed === "number"
        ? event.completed
        : 0;
      if (progress === null) {
        progress = new ProgressBar({ max: event.total, value: completed });
        continue;
      }
      if (event.total > progress.max) progress.max = event.total;
      progress.value = completed;
    }
  } catch (error) {
    if (progress !== null) {
      await progress.stop();
      progress = null;
    }

    logger.error(
      `failed to pull model '${model}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    throw error;
  } finally {
    if (progress !== null) {
      await progress.stop();
      progress = null;
    }
  }

  logger.info(`completed pulling model '${model}'`);
}

/**
 * Pulls the models one at a time: concurrent pulls race the daemon's
 * per-blob downloaders (and each other's progress bars), and an
 * interrupted race leaves the daemon's partial-blob state broken.
 */
export async function pullModels(models: string[]) {
  let failed = 0;
  for (const model of models) {
    try {
      await pullModel(model);
    } catch {
      failed++;
    }
  }

  if (failed) {
    exitWithError(`failed to pull ${failed} models. Try again...`);
  }
}

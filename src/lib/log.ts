import {
  configure,
  getConsoleSink,
  getLogger,
  isLogLevel,
} from "@logtape/logtape";

/** The levels `--log-level` accepts, least to most verbose. */
export const LOG_LEVELS = [
  "fatal",
  "error",
  "warning",
  "info",
  "debug",
  "trace",
] as const;

/** A `--log-level` value. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Parses and validates a `--log-level` value; throws on garbage. */
export function parseLogLevel(value: string): LogLevel {
  const level = value.trim().toLowerCase();
  if (!isLogLevel(level)) {
    throw new Error(
      `unknown log level "${value}" — use one of ${LOG_LEVELS.join(" | ")}`,
    );
  }
  return level as LogLevel;
}

/**
 * Configures LogTape once per process with the console sink, filtered
 * at `level`: `debug`/`info` records go to stdout, `warning` and
 * above to stderr. The `--log-level` flag of the running command
 * decides the level; `--debug` is the shorthand for `debug`.
 * LogTape's own meta logger is silenced.
 */
export async function configureLogging(level: LogLevel): Promise<void> {
  await configure({
    sinks: { console: getConsoleSink() },
    loggers: [
      { category: ["noa"], sinks: ["console"], lowestLevel: level },
      // LogTape's diagnostics are not noa's user's business.
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
}

export { getLogger };

import { configure, dispose, type LogRecord } from "@logtape/logtape";

/**
 * Shared test scaffolding. Production code reads ambient state directly
 * (`fetch`, `Deno.env`, `console`), so tests drive it with global stubs and
 * env vars — never with injected functions. `NOA_TEST=1` switches the
 * interactive helpers to hardcoded answers (confirm approves, menus pick
 * the first option) and the systems check to a hardcoded 16 GiB; see
 * src/lib/utils.ts and src/lib/system.ts.
 */

/** The part of `Response` noa's code paths use. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Present for streaming endpoints (Ollama's streamed pulls). */
  body?: ReadableStream<Uint8Array>;
}

/** A fetch stub: the piece of `fetch` noa's providers call. */
export type FetchStub = (
  url: string,
  init?: RequestInit,
) => Promise<ResponseLike>;

export function jsonResponse(body: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** A streaming response carrying the given NDJSON events. */
export function ndjsonResponse(
  events: unknown[],
  status = 200,
): ResponseLike {
  const encoder = new TextEncoder();
  const text = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(events[events.length - 1]),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
  };
}

/**
 * Configures LogTape with a capturing sink (trace level) for the
 * duration of `fn`, then disposes. `records` receives every record
 * noa logs; `record.message.join("")` is the formatted message.
 */
export async function withLogRecords<T>(
  fn: (records: LogRecord[]) => Promise<T>,
): Promise<T> {
  const records: LogRecord[] = [];
  await configure({
    // Tests reconfigure per case; `reset` replaces the previous setup.
    reset: true,
    sinks: { test: (record) => records.push(record) },
    loggers: [
      { category: [], sinks: ["test"], lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  try {
    return await fn(records);
  } finally {
    await dispose();
  }
}

/** Sets `env` for the duration of `fn`, restoring (or deleting) after. */
export async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.keys(env).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** Stubs `globalThis.fetch` for the duration of `fn`. */
export async function withFetch(
  stub: FetchStub,
  fn: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** Captures `console.log` lines for the duration of `fn`. */
export async function withLogs<T>(
  fn: (lines: string[]) => Promise<T>,
): Promise<T> {
  const real = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return await fn(lines);
  } finally {
    console.log = real;
  }
}

/** Captures `console.error` lines for the duration of `fn`. */
export async function withErrors<T>(
  fn: (lines: string[]) => Promise<T>,
): Promise<T> {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return await fn(lines);
  } finally {
    console.error = real;
  }
}

/** Runs `fn` with a fresh `NOA_HOME` (and optionally `HOME`) temp dir. */
export async function withNoaHome(
  options: { home?: boolean } = {},
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "noa-test-" });
  const env: Record<string, string | undefined> = { NOA_HOME: dir };
  if (options.home) env.HOME = dir;
  try {
    await withEnv(env, () => fn(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Shared test scaffolding. Production code reads ambient state directly
 * (`fetch`, `Deno.env`, `console`), so tests drive it with global stubs and
 * env vars — never with injected functions. `NOA_TEST=1` additionally
 * scripts terminal prompts (`NOA_TEST_CONFIRM`/`NOA_TEST_TEXT`) and the
 * systems check (`NOA_TEST_RAM_GB`); see src/terminal.ts.
 */

/** The part of `Response` the providers use. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
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

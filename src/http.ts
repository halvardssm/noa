/** A fetch-like function, injectable for tests. */
export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<ResponseLike>;

/** The part of `Response` the providers use. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

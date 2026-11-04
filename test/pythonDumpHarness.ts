/**
 * The replay harness the recorded Python CLI dump tests share
 * (`test/cli/commands/pythonDumps.test.ts`, `workspaceDumps.test.ts`):
 * each case is a server response the Python CLI was run against, with
 * what it printed; these helpers answer the TS CLI with the same bytes and
 * collect what it prints the way a terminal shows it.
 */

/** `METHOD /path` (no query) → the status and the exact body the fake server sent. */
export type RecordedRoutes = Record<string, { status: number; raw: string }>;

/** One Python CLI run, recorded: its arguments, the server's replies, and what it printed. */
export interface RecordedCase {
  name: string;
  argv: string[];
  routes: RecordedRoutes;
  code: number;
  stdout: string;
  stderr: string;
}

/** A request the CLI sent. */
export interface SentRequest {
  method: string;
  /** The path and query. */
  path: string;
  body: string | null;
}

/**
 * A fetch answering each `METHOD /path` with its recorded bytes (no body
 * for a 204), and `{"detail":"Not Found"}` with 404 otherwise. Each
 * request is appended to `sent`, when given, in the order sent.
 */
export function recordedFetch(routes: RecordedRoutes, sent?: SentRequest[]): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    sent?.push({ method, path: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : null });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response('{"detail":"Not Found"}', { status: 404 });
    return new Response(route.status === 204 ? null : route.raw, { status: route.status });
  };
}

/** The lines the CLI wrote, as a terminal shows them: each one ended by a newline. */
export function terminalText(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

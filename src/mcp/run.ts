import type { Readable } from "node:stream";
import { parseArgs } from "../cli/parseArgs.js";
import { ProxyAuth } from "./auth.js";
import { safeError } from "./errors.js";
import { readStdioLines } from "./lines.js";
import { isMessage, isRequest, McpTransport, rpcError } from "./transport.js";
import type { RpcMessage } from "./transport.js";
import { SDK_VERSION } from "../version.js";

export interface ProxyIo {
  input: Readable;
  output: (line: string) => void;
  error: (line: string) => void;
  signal: AbortSignal;
}

const HELP = `Usage: kagura-memory-mcp [options]

Connect a stdio MCP host to Kagura Cloud using an OAuth profile.
  --profile NAME       Stored profile (default: credentials file default)
  --server URL         MCP endpoint (default: profile endpoint or Kagura Cloud)
  --credentials PATH   Credentials file (default: ~/.kagura/credentials.json)
  --no-login           Fail instead of starting browser login
  --no-browser         Print the verification URL without opening a browser
  --login-timeout SEC   Maximum login wait (default: 300)
  --help               Show this help
  --version            Show version
`;

export async function runProxy(argv: string[], io: ProxyIo): Promise<number> {
  const parsed = parseArgs(
    argv,
    {
      flags: [
        { name: "profile", type: "value" },
        { name: "server", type: "value" },
        { name: "credentials", type: "value" },
        { name: "no-login" },
        { name: "no-browser" },
        { name: "login-timeout", type: "value" },
        { name: "help" },
        { name: "version" },
      ],
    },
    { stopAtPositional: true },
  );
  if (
    parsed.rest.length ||
    parsed.unknown.length ||
    parsed.noValue.length ||
    parsed.missingValue.length ||
    [parsed.values.profile, parsed.values.server, parsed.values.credentials].some(
      (value) => value?.trim() === "",
    )
  ) {
    io.error(`Invalid proxy arguments.\n${HELP}`);
    return 2;
  }
  const { values, flags } = parsed;
  if (flags.has("help")) {
    io.output(HELP);
    return 0;
  }
  if (flags.has("version")) {
    io.output(`kagura-memory-mcp ${SDK_VERSION}\n`);
    return 0;
  }
  if (io.signal.aborted) return 0;
  const loginTimeout = Number(values["login-timeout"] ?? 300);
  if (
    !Number.isFinite(loginTimeout) ||
    loginTimeout <= 0 ||
    loginTimeout > 3600
  ) {
    io.error(
      "--login-timeout must be between 0 and 3600 seconds (exclusive of 0).\n",
    );
    return 2;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (io.signal.aborted) abort();
  else io.signal.addEventListener("abort", abort, { once: true });
  const log = (line: string): void => io.error(`kagura-memory-mcp: ${line}\n`);
  let transport: McpTransport;
  try {
    const auth = new ProxyAuth({
      profile: values.profile,
      server: values.server,
      credentialsPath: values.credentials,
      login: !flags.has("no-login"),
      openBrowser: !flags.has("no-browser"),
      loginTimeoutMs: loginTimeout * 1000,
      signal: controller.signal,
      log,
    });
    transport = new McpTransport({
      url: auth.mcpUrl,
      auth,
      signal: controller.signal,
    });
  } catch (error) {
    log(safeError(error));
    io.signal.removeEventListener("abort", abort);
    return 1;
  }
  const lines = readStdioLines(io.input, controller.signal);
  const pending = new Set<Promise<void>>();
  let barrier = Promise.resolve();
  const emit = (message: RpcMessage): void => {
    if (!controller.signal.aborted) io.output(`${JSON.stringify(message)}\n`);
  };
  try {
    for await (const line of lines) {
      if (controller.signal.aborted) break;
      if (line === null) {
        emit(rpcError(null, "Message exceeded 16 MiB.", -32600));
        continue;
      }
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        emit(rpcError(null, "Parse error", -32700));
        continue;
      }
      if (!isMessage(message)) {
        emit(rpcError(null, "Invalid request", -32600));
        continue;
      }
      const rpc = message;
      if (pending.size >= 128 && isRequest(rpc)) {
        emit(
          rpcError(
            rpc.id,
            "Too many pending requests. Retry after an earlier request finishes.",
          ),
        );
        continue;
      }
      // Keep stdin open for cancellation and replies to server requests during SSE.
      const before = barrier;
      const task = (async () => {
        try {
          if (
            typeof rpc.method === "string" &&
            rpc.method !== "notifications/cancelled"
          )
            await before;
          await transport.forward(rpc, emit);
        } catch (error) {
          if (isRequest(rpc)) emit(rpcError(rpc.id, safeError(error)));
          else log(safeError(error));
        }
      })();
      if (
        rpc.method === "initialize" ||
        rpc.method === "notifications/initialized"
      )
        barrier = task;
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    io.signal.removeEventListener("abort", abort);
  }
  return 0;
}

import type { Readable } from "node:stream";
import { parseArgs } from "../cli/parseArgs.js";
import { excMessage } from "../errors.js";
import {
  mcpUrlToolView,
  mcpUrlWithQuery,
  normalizeGuardrails,
  normalizeToolProfile,
  parseMcpUrl,
  readAddToolsFlag,
  type McpUrlQuery,
} from "../http.js";
import { normalizeUuid, pyStrip } from "../pyCompat.js";
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
  /** Where `KAGURA_MCP_SESSION_ID` is read; `process.env` when absent. */
  env?: Record<string, string | undefined>;
  /** The HTTP client for the upstream and OAuth requests; global `fetch` when absent. */
  fetch?: typeof fetch;
}

const HELP = `Usage: kagura-memory-mcp [options]

Connect a stdio MCP host to Kagura Cloud using an OAuth profile.
  --profile NAME       Stored profile (default: credentials file default)
  --server URL         MCP endpoint (default: profile endpoint or Kagura Cloud)
  --credentials PATH   Credentials file (default: ~/.kagura/credentials.json)
  --no-login           Fail instead of starting browser login
  --no-browser         Print the verification URL without opening a browser
  --login-timeout SEC   Maximum login wait (default: 300)
  --guardrails off|CONTEXT_ID
                       Set ?guardrails= on the endpoint (server v0.74.0+); off
                       also removes the guardrails block of get_context_info
  --tool-profile NAME  Set ?profile= (server v0.73.0+): core, which a bare
                       endpoint lists since v0.93.0, full (every tool), or
                       google / microsoft (v0.158.0+: core without
                       describe_tools and guide)
  --add-tools NAME[,NAME...]
                       Set ?add_tools= (server v0.129.0+): tools listed on top
                       of the profile, e.g. explore; may repeat, at most 100
  --context CONTEXT_ID Set ?context= (server v0.114.0+): the default context
                       for tools called without context_id
  --session-id NAME    Send Kagura-Session-Id on every upstream request (server
                       v0.114.0+; default: $KAGURA_MCP_SESSION_ID): 1-128
                       letters, digits, '.', '_' or '-'
  --help               Show this help
  --version            Show version

The query options replace any value already in the endpoint's query; a
?tools= allowlist there wins over --tool-profile and --add-tools. A profile
is a view, not an authorization boundary: tools/call reaches unlisted tools,
except that google and microsoft refuse describe_tools and guide
(unknown_tool), which --add-tools cannot bring back.
`;

/** Names the session when `--session-id` is not given (Python's `SESSION_ENV`). */
export const SESSION_ENV = "KAGURA_MCP_SESSION_ID";
/**
 * memory-cloud's session id rule (`api/correlation.py`): it silently drops
 * any other value instead of failing the request, so the proxy refuses it.
 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SESSION_ID_RULE = "use 1-128 letters, digits, '.', '_' or '-' (memory-cloud drops any other value)";

/** A flag value the proxy refuses: exit 2, before anything starts. */
class ProxyUsageError extends Error {}

/** What the upstream URL query and session flags resolve to. */
interface Upstream {
  query: McpUrlQuery;
  sessionId: string | undefined;
}

function invalid(flag: string, reason: string): ProxyUsageError {
  return new ProxyUsageError(`Invalid value for --${flag}: ${reason}`);
}

/** `value` validated by `normalize`, its error worded for `--flag`. */
function checked<T>(flag: string, value: string | undefined, normalize: (value: string) => T): T | undefined {
  if (value === undefined) return undefined;
  try {
    return normalize(value);
  } catch (e) {
    throw invalid(flag, excMessage(e));
  }
}

function sessionId(value: string): string {
  const id = pyStrip(value);
  if (!SESSION_ID_RE.test(id)) throw new Error(SESSION_ID_RULE);
  return id;
}

/**
 * The upstream URL query (`--guardrails`, `--tool-profile`, `--add-tools`,
 * `--context`) and the session id (`--session-id`, else
 * {@link SESSION_ENV}), validated as Python's `kagura-mcp` validates them
 * (python-sdk#258, #300). An invalid flag stops the proxy; an invalid
 * variable may come from the ambient environment, so it is ignored with a
 * warning rather than taking every Kagura tool down with it.
 *
 * @throws ProxyUsageError for an invalid flag value.
 */
function upstreamOptions(
  values: Record<string, string | undefined>,
  addToolsRaw: readonly string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): Upstream {
  const guardrails = checked("guardrails", values.guardrails, normalizeGuardrails);
  const profile = checked("tool-profile", values["tool-profile"], normalizeToolProfile);
  // Each value, then over 100 names across repeated --add-tools, as the CLI checks them.
  const added = readAddToolsFlag(addToolsRaw);
  if ("problem" in added) throw invalid("add-tools", added.problem);
  const context = checked("context", values.context, (v) => normalizeUuid(pyStrip(v), "context"));
  let session = checked("session-id", values["session-id"], sessionId);
  const fromEnv = pyStrip(env[SESSION_ENV] ?? "");
  if (session === undefined && fromEnv) {
    try {
      session = sessionId(fromEnv);
    } catch (e) {
      log(`warning: ignoring ${SESSION_ENV}: ${excMessage(e)}`);
    }
  }
  return {
    query: { guardrails, profile, addTools: added.names.length > 0 ? added.names : undefined, context },
    sessionId: session,
  };
}

/**
 * The upstream URL: `base` (`--server`, else the profile's endpoint) with
 * the query flags set by the one composer, `mcpUrlWithQuery`, at run time
 * — never stored, so the profile's URL is shared unchanged with the other
 * clients. A `?tools=` allowlist already there wins over the tool view
 * flags, which gets a warning, as in Python's `kagura-mcp`. The URL is
 * split once, for that check and the composer alike.
 */
function upstreamUrl(base: string, query: McpUrlQuery, log: (line: string) => void): string {
  const url = parseMcpUrl(base);
  const viewFlags = [
    ...(query.profile !== undefined ? ["--tool-profile"] : []),
    ...(query.addTools !== undefined && query.addTools.length > 0 ? ["--add-tools"] : []),
  ];
  if (viewFlags.length > 0 && mcpUrlToolView(url).tools !== null) {
    log(
      "warning: the upstream URL has a ?tools= allowlist, which the server applies instead of " +
        `${viewFlags.join(" and ")}.`,
    );
  }
  return mcpUrlWithQuery(url, query);
}

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
        { name: "guardrails", type: "value" },
        { name: "tool-profile", type: "value" },
        { name: "add-tools", type: "multiple" },
        { name: "context", type: "value" },
        { name: "session-id", type: "value" },
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
  const log = (line: string): void => io.error(`kagura-memory-mcp: ${line}\n`);
  let upstream: Upstream;
  try {
    upstream = upstreamOptions(values, parsed.many["add-tools"] ?? [], io.env ?? process.env, log);
  } catch (error) {
    if (!(error instanceof ProxyUsageError)) throw error;
    io.error(`${error.message}\n`);
    return 2;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (io.signal.aborted) abort();
  else io.signal.addEventListener("abort", abort, { once: true });
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
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    transport = new McpTransport({
      url: upstreamUrl(auth.mcpUrl, upstream.query, log),
      auth,
      signal: controller.signal,
      ...(upstream.sessionId !== undefined ? { sessionId: upstream.sessionId } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
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

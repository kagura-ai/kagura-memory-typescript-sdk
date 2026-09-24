import { ProxyError } from "./errors.js";
import { SDK_VERSION } from "../version.js";

export type RpcMessage = Record<string, unknown> & { jsonrpc: "2.0" };
export type Emit = (message: RpcMessage) => void;

export function isMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  const hasId = "id" in message;
  if (
    hasId &&
    message.id !== null &&
    typeof message.id !== "string" &&
    !(typeof message.id === "number" && Number.isFinite(message.id))
  )
    return false;

  const hasResult = "result" in message;
  const hasError = "error" in message;
  if ("method" in message) {
    return (
      typeof message.method === "string" &&
      !hasResult &&
      !hasError &&
      (!("params" in message) ||
        (message.params !== null && typeof message.params === "object"))
    );
  }
  if (!hasId || hasResult === hasError) return false;
  if (hasResult) return true;
  const error = message.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const fields = error as Record<string, unknown>;
  return Number.isInteger(fields.code) && typeof fields.message === "string";
}

export function isRequest(message: RpcMessage): boolean {
  return typeof message.method === "string" && "id" in message;
}

function isInitializedNotification(message: RpcMessage): boolean {
  return message.method === "notifications/initialized" && !isRequest(message);
}

export function rpcError(
  id: unknown,
  message: string,
  code = -32000,
): RpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export interface TransportOptions {
  url: string;
  auth: { getAuthHeader(): Promise<string>; forceRefresh(): Promise<void> };
  signal: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// The SSE field prefix is framing, not part of the JSON-RPC payload.
const MAX_SSE_LINE_BYTES = MAX_MESSAGE_BYTES + Buffer.byteLength("data: ");

/** Stream JSON or SSE, including server requests before the final response. */
async function readMessages(
  response: Response,
  emit: (message: RpcMessage) => boolean,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const sse =
    response.headers.get("content-type")?.split(";")[0]?.trim() ===
    "text/event-stream";
  const decoder = new TextDecoder();
  let buffer = "";
  let eventData: string[] = [];
  let eventBytes = 0;
  const parse = (text: string): boolean => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ProxyError("Upstream returned invalid JSON.");
    }
    if (!isMessage(value))
      throw new ProxyError("Upstream returned an invalid JSON-RPC message.");
    return emit(value);
  };
  const line = (text: string): boolean => {
    if (Buffer.byteLength(text) > MAX_SSE_LINE_BYTES)
      throw new ProxyError("Upstream SSE line exceeded 16 MiB plus framing.");
    if (text === "") {
      const complete = eventData.length > 0 && parse(eventData.join("\n"));
      eventData = [];
      eventBytes = 0;
      return complete;
    } else if (text.startsWith("data:")) {
      const data = text.slice(5).replace(/^ /, "");
      // Joining data fields inserts a newline, including between empty fields.
      eventBytes += Buffer.byteLength(data) + (eventData.length > 0 ? 1 : 0);
      if (eventBytes > MAX_MESSAGE_BYTES)
        throw new ProxyError("Upstream message exceeded 16 MiB.");
      eventData.push(data);
    }
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (sse) {
        let newline: number;
        while ((newline = buffer.search(/[\r\n]/)) >= 0) {
          // CR, LF and CRLF are all SSE line endings. Wait for a possible
          // split CRLF pair rather than treating it as two blank lines.
          if (
            !done &&
            buffer[newline] === "\r" &&
            newline === buffer.length - 1
          )
            break;
          const width =
            buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
          if (line(buffer.slice(0, newline))) return;
          buffer = buffer.slice(newline + width);
        }
        // Drain complete lines/events before bounding the unfinished line.
        // A network chunk can contain many separately valid messages. A
        // pending CR belongs to a possibly split CRLF, not the field value.
        const pendingTerminator = buffer.endsWith("\r") ? 1 : 0;
        if (Buffer.byteLength(buffer) - pendingTerminator > MAX_SSE_LINE_BYTES)
          throw new ProxyError("Upstream SSE line exceeded 16 MiB plus framing.");
      } else if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES)
        throw new ProxyError("Upstream message exceeded 16 MiB.");
      if (done) break;
    }
    if (sse) {
      // Incomplete SSE events at EOF are deliberately discarded.
      if (buffer) line(buffer.replace(/\r$/, ""));
    } else if (buffer.trim()) parse(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A transport bridge: Cloud owns capabilities and all tool schemas. */
export class McpTransport {
  private session?: string;
  private protocol?: string;
  private initialize?: RpcMessage;
  private recovery?: Promise<void>;

  constructor(private readonly options: TransportOptions) {}

  async forward(message: RpcMessage, emit: Emit): Promise<void> {
    // A response to a server request must be able to finish an SSE stream
    // that recovery is itself waiting on. Cancellation must also flow.
    if (
      this.recovery &&
      typeof message.method === "string" &&
      message.method !== "notifications/cancelled"
    ) {
      await this.recovery;
      if (isInitializedNotification(message)) return;
    }
    if (message.method === "initialize") {
      this.session = undefined;
      this.protocol = undefined;
    }
    const session = this.session;
    await this.send(message, emit, session, true);
  }

  private async recover(oldSession: string, emit: Emit): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.session !== oldSession) return;
    if (!this.initialize)
      throw new ProxyError(
        "Session expired. Restart the extension to initialize again.",
      );
    const initialize = this.initialize;
    this.session = undefined;
    this.protocol = undefined;
    this.recovery = (async () => {
      let initialized = false;
      await this.send(
        initialize,
        (reply) => {
          if (reply.id === initialize.id && "result" in reply)
            initialized = true;
          else if (typeof reply.method === "string") emit(reply);
        },
        undefined,
        false,
      );
      if (!initialized)
        throw new ProxyError("Upstream session reinitialization failed.");
      await this.send(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        () => {},
        this.session,
        false,
      );
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  private async send(
    message: RpcMessage,
    emit: Emit,
    session: string | undefined,
    recover: boolean,
  ): Promise<void> {
    const options = this.options;
    // Login has its own longer deadline. Start the HTTP deadline afterwards.
    let authorization = await options.auth.getAuthHeader();
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, options.timeoutMs ?? 60_000);
      let response: Response | undefined;
      let initialized = false;
      try {
        response = await (options.fetch ?? fetch)(options.url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "User-Agent": `kagura-memory-mcp/${SDK_VERSION}`,
            Authorization: authorization,
            ...(session ? { "Mcp-Session-Id": session } : {}),
            ...(this.protocol ? { "MCP-Protocol-Version": this.protocol } : {}),
          },
          body: JSON.stringify(message),
        });
        if (response.status === 401) {
          await response.body?.cancel();
          if (attempt === 1)
            throw new ProxyError(
              "Authentication rejected. Restart the extension or sign in again with kagura-memory auth login.",
            );
          // Release this HTTP deadline while a refresh may require browser consent.
          clearTimeout(timer);
          await options.auth.forceRefresh();
          authorization = await options.auth.getAuthHeader();
          continue;
        }
        // Host responses belong to the server request's original session.
        // Replaying them would cross sessions (or wait on their own SSE
        // recovery stream); their 404 is terminal.
        if (
          response.status === 404 &&
          session &&
          recover &&
          typeof message.method === "string"
        ) {
          await response.body?.cancel();
          clearTimeout(timer);
          await this.recover(session, emit);
          // Recovery already completed the new session's handshake.
          if (isInitializedNotification(message)) return;
          return this.send(message, emit, this.session, false);
        }
        if (!isRequest(message)) {
          await response.body?.cancel();
          if (!response.ok)
            throw new ProxyError(`Upstream HTTP ${response.status}.`);
          return;
        }
        if (message.method === "initialize" && response.ok) {
          // The response headers arrive before an SSE body. Server requests
          // in that body already belong to this session.
          this.session = response.headers.get("mcp-session-id") || undefined;
        }
        let replied = false;
        await readMessages(response, (reply) => {
          if (
            reply.id === message.id &&
            ("result" in reply || "error" in reply)
          ) {
            replied = true;
            if (
              message.method === "initialize" &&
              "result" in reply &&
              response!.ok
            ) {
              const result = reply.result as Record<string, unknown> | null;
              if (typeof result?.protocolVersion === "string")
                this.protocol = result.protocolVersion;
              this.session =
                response!.headers.get("mcp-session-id") || undefined;
              this.initialize = message;
              initialized = true;
            }
          }
          emit(reply);
          return replied;
        });
        if (!replied)
          throw new ProxyError(
            `Upstream HTTP ${response.status} did not return a response for this request.`,
          );
        return;
      } catch (error) {
        if (controller.signal.aborted)
          throw new ProxyError("Kagura request timed out or was cancelled.");
        throw error;
      } finally {
        if (message.method === "initialize" && !initialized) {
          this.session = undefined;
          this.protocol = undefined;
        }
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        await response?.body?.cancel().catch(() => {});
      }
    }
  }
}

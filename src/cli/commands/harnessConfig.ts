/**
 * Text helpers for `setup`: MCP URL query edits, the blocks printed for a
 * user to paste, and read-only scans for an existing entry.
 *
 * None of this parses TOML, YAML or JSON5, and none of it rewrites those
 * files. The package takes no runtime dependencies, so a harness config is
 * changed only by the harness's own CLI, or by the user from a printed
 * block. The scans look for the entry's key and nothing else, to decide
 * whether `--force` is needed; they err toward "exists", because a false
 * positive costs a `--force` while a false negative lets a harness CLI
 * replace an entry nobody asked it to touch.
 */

import * as net from "node:net";

/**
 * The variable Codex and OpenClaw entries read the key from unless
 * `--api-key-env` names another — Python's `DEFAULT_KEY_ENV`.
 */
export const KEY_ENV_VAR = "KAGURA_API_KEY";

/**
 * `url` as a URL parser reads it — Python's `normalize_url`
 * (python-sdk#279), shared with the HTTPS check in `http.ts`. The harness
 * setups check this form and write it, so an entry never carries padding
 * or a control character its harness might keep.
 */
export { normalizeUrl } from "../../http.js";

/**
 * Python's `urlsplit` checks of a bracketed host (`_check_bracketed_netloc`):
 * only the host may be bracketed, nothing but a port may follow it, and
 * what is inside is an IPv6 address or an `IPvFuture` literal.
 */
function bracketedNetlocOk(netloc: string): boolean {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostAndPort.indexOf("[");
  let host: string;
  if (open !== -1) {
    if (open > 0) return false;
    const inner = hostAndPort.slice(1);
    const close = inner.indexOf("]");
    host = close === -1 ? inner : inner.slice(0, close);
    const port = close === -1 ? "" : inner.slice(close + 1);
    if (port && !port.startsWith(":")) return false;
  } else {
    const colon = hostAndPort.indexOf(":");
    host = colon === -1 ? hostAndPort : hostAndPort.slice(0, colon);
  }
  if (host.startsWith("v")) return /^v[a-fA-F0-9]+\.[^\n]+$/.test(host);
  return net.isIPv6(host);
}

/**
 * Python's `_checknetloc`: a non-ASCII host whose NFKC form spells one of
 * `/?#@:` (U+2100 `℀` is `a/c`) would read as another URL once a client
 * normalizes it.
 */
function nfkcNetlocOk(netloc: string): boolean {
  if (!/[^\x00-\x7f]/.test(netloc)) return true;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalized = n.normalize("NFKC");
  return n === normalized || !/[/?#@:]/.test(normalized);
}

/**
 * Whether `url` is an http(s) URL with a host, as Python's `urlsplit` reads
 * it: the check `setup` puts on the MCP URL after the HTTPS one
 * (python-sdk#279). The URL follows `--url` on a harness argv, where
 * `--help` would read as an option, and anything without a host would be
 * saved as an entry no client can reach. An unbalanced or malformed IPv6
 * bracket fails, as `urlsplit` raises for it.
 *
 * Expects a {@link normalizeUrl}-ed URL, as Python's check gets one.
 */
export function isHttpUrl(url: string): boolean {
  const match = /^https?:\/\/([^/?#]*)/i.exec(url);
  if (match === null) return false;
  const netloc = match[1]!;
  if (netloc === "") return false;
  const open = netloc.includes("[");
  if (open !== netloc.includes("]")) return false;
  if (open && !bracketedNetlocOk(netloc)) return false;
  return nfkcNetlocOk(netloc);
}

interface SplitUrl {
  base: string;
  params: string[];
  fragment: string;
}

/**
 * Split a URL by hand rather than through `URL`: `searchParams` re-encodes
 * every parameter on the way out (`tools=a,b` becomes `tools=a%2Cb`), and
 * the other parameters are meant to be kept as written.
 */
function splitUrl(url: string): SplitUrl {
  const hash = url.indexOf("#");
  const fragment = hash === -1 ? "" : url.slice(hash);
  const rest = hash === -1 ? url : url.slice(0, hash);
  const q = rest.indexOf("?");
  return {
    base: q === -1 ? rest : rest.slice(0, q),
    params: q === -1 ? [] : rest.slice(q + 1).split("&").filter((p) => p !== ""),
    fragment,
  };
}

/**
 * A parameter's name, decoded: the server (`parse_qsl`) and Python's
 * `_query_without` both compare names that way, so `guard%72ails` is
 * `guardrails`.
 */
function paramName(param: string): string {
  const eq = param.indexOf("=");
  return unquotePlus(eq === -1 ? param : param.slice(0, eq));
}

/**
 * The decoded value of the first `key` in the URL's query — the one the
 * server reads — or undefined. Names compare decoded.
 */
export function queryParam(url: string, key: string): string | undefined {
  const param = splitUrl(url).params.find((p) => paramName(p) === key);
  if (param === undefined) return undefined;
  const eq = param.indexOf("=");
  if (eq === -1) return "";
  return unquotePlus(param.slice(eq + 1));
}

/**
 * A split URL put back together with a new query, as Python's
 * `urlunsplit(urlsplit(url)._replace(query=…))` rebuilds it: the scheme
 * lower-cased (`HTTP://` is written `http://`), no `?` for an empty query
 * and no `#` for an empty fragment. The rest stays as written.
 */
function joinUrl(base: string, params: string[], fragment: string): string {
  const scheme = base.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, (s) => s.toLowerCase());
  return `${scheme}${params.length > 0 ? `?${params.join("&")}` : ""}${fragment.length > 1 ? fragment : ""}`;
}

/** A name or value as Python's `unquote_plus` reads it; left raw if malformed. */
function unquotePlus(text: string): string {
  const raw = text.replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A value as Python's `urlencode` writes it (`quote_plus`): `+` for a
 * space, and `!'()*`, which `encodeURIComponent` leaves bare, escaped.
 */
function quotePlus(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * The MCP URL with memory-cloud's `guardrails` / `profile` parameters set
 * — the port of Python's `mcp_url_with_query`, so both CLIs write the same
 * entry for the same flags.
 *
 * A key being set loses every earlier value of it (the server reads only
 * the first it finds) and goes at the end, `guardrails` before `profile`.
 * Every other parameter is kept as written; an unset key is left alone,
 * and with nothing to set the URL comes back as written. A URL it rewrites
 * is rebuilt as Python's is ({@link joinUrl}).
 */
export function mcpUrlWithQuery(
  url: string,
  updates: { guardrails?: string | undefined; profile?: string | undefined },
): string {
  const set = (["guardrails", "profile"] as const).filter((key) => updates[key] !== undefined);
  if (set.length === 0) return url;
  const { base, params, fragment } = splitUrl(url);
  const kept = params.filter((param) => !(set as readonly string[]).includes(paramName(param)));
  const added = set.map((key) => `${key}=${quotePlus(updates[key]!)}`);
  return joinUrl(base, [...kept, ...added], fragment);
}

/**
 * Drop `key` from the URL's query, every occurrence, keeping the other
 * parameters as written and leaving no bare `?` behind — Python's
 * `mcp_url_without_query_param`. Names compare decoded; a URL without the
 * key comes back as written, and one it rewrites is rebuilt as Python's is
 * ({@link joinUrl}).
 */
export function withoutQueryParam(url: string, key: string): string {
  const { base, params, fragment } = splitUrl(url);
  const kept = params.filter((param) => paramName(param) !== key);
  if (kept.length === params.length) return url;
  return joinUrl(base, kept, fragment);
}

/** The URL with its query and fragment dropped. */
export function withoutQuery(url: string): string {
  return splitUrl(url).base;
}

/**
 * The URL for the Claude plugin's `server_url` setting.
 *
 * The plugin's hooks call the server themselves, so the entry's tool
 * profile and guardrails context mean nothing there. `guardrails=off` is
 * the one parameter kept: it is what stops the server from also sending
 * a digest of the memories the hooks already deliver.
 */
export function pluginServerUrl(url: string): string {
  const base = withoutQuery(url);
  return queryParam(url, "guardrails")?.trim().toLowerCase() === "off" ? `${base}?guardrails=off` : base;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The name as a bare, double-quoted or single-quoted key. */
function keyPattern(name: string): string {
  const n = escapeRegExp(name);
  return `(?:${n}|"${n}"|'${n}')`;
}

/**
 * Whether Codex's `config.toml` text already defines `mcp_servers.<name>`.
 *
 * Covers the spellings TOML allows for it: a `[mcp_servers.<name>]` header
 * or a sub-table of it, a root-level dotted key, a key inside
 * `[mcp_servers]`, and an inline table.
 */
export function tomlHasServer(text: string, name: string): boolean {
  const key = keyPattern(name);
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${key}\\s*[\\].]`);
  const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${key}\\s*[.=]`);
  const inline = new RegExp(`^\\s*mcp_servers\\s*=.*[{,]\\s*${key}\\s*=`);
  const inTable = new RegExp(`^\\s*${key}\\s*[.=]`);
  let table = "";
  for (const line of text.split(/\r?\n/)) {
    if (header.test(line)) return true;
    const opened = /^\s*\[\[?([^\]]*)\]/.exec(line);
    if (opened !== null) {
      table = opened[1]!.replace(/\s+/g, "");
      continue;
    }
    if (table === "" && (dotted.test(line) || inline.test(line))) return true;
    if (table === "mcp_servers" && inTable.test(line)) return true;
  }
  return false;
}

/**
 * Whether Hermes's `config.yaml` text has `<name>` under the top-level
 * `mcp_servers` mapping, in block or flow style.
 */
/**
 * The top-level `mcp_servers:` key line, and what follows its colon. A BOM
 * before it and a quoted key are both valid YAML, and missing either would
 * print a second top-level key that silently replaces the first.
 */
const YAML_SERVERS_KEY = /^\uFEFF?(["']?)mcp_servers\1\s*:(.*)$/;

export function yamlHasServer(text: string, name: string): boolean {
  const key = keyPattern(name);
  const child = new RegExp(`^\\s+${key}\\s*:`);
  const flow = new RegExp(`[{,]\\s*${key}\\s*:`);
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    // Blank and comment lines neither open nor close a block.
    if (/^\s*(#|$)/.test(line)) continue;
    const top = YAML_SERVERS_KEY.exec(line);
    if (top !== null) {
      if (flow.test(top[2]!)) return true;
      inBlock = true;
      continue;
    }
    if (!/^\s/.test(line)) {
      inBlock = false;
      continue;
    }
    if (inBlock && child.test(line)) return true;
  }
  return false;
}

/**
 * How Hermes's `config.yaml` text indents the entries under its top-level
 * `mcp_servers` key: null when it has no such key, and two spaces when the
 * key has no block entries to copy the indent from.
 *
 * A file with the key needs the entry alone, placed under it: a second
 * top-level `mcp_servers:` key would replace the first (YAML keeps the
 * last), and every server under it with it.
 */
export function yamlServersIndent(text: string): string | null {
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    // Blank and comment lines neither open nor close a block.
    if (/^\s*(#|$)/.test(line)) continue;
    if (!found) {
      found = YAML_SERVERS_KEY.test(line);
      continue;
    }
    return /^(\s+)\S/.exec(line)?.[1] ?? "  ";
  }
  return found ? "  " : null;
}

/**
 * Whether Hermes's top-level `mcp_servers` value is written inline — flow
 * style (`{…}`) or a scalar such as `null` — rather than as a block
 * mapping. An entry printed for placing under the key cannot go there
 * until the value is rewritten as a block.
 */
export function yamlServersInline(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const top = YAML_SERVERS_KEY.exec(line);
    if (top !== null) {
      return !/^\s*(#|$)/.test(top[2]!);
    }
  }
  return false;
}

/**
 * Whether OpenClaw's `openclaw.json` text has `mcp.servers.<name>`.
 *
 * Plain JSON (which is valid JSON5) is read exactly. Anything else — real
 * JSON5, with comments and unquoted keys — is not parsed; any key of that
 * name counts as the entry.
 */
export function json5HasServer(text: string, name: string): boolean {
  if (!text.trim()) return false;
  try {
    const parsed = JSON.parse(text) as { mcp?: { servers?: unknown } } | null;
    const servers = parsed?.mcp?.servers;
    return typeof servers === "object" && servers !== null && Object.hasOwn(servers, name);
  } catch {
    return new RegExp(`(?:^|[\\s{,])${keyPattern(name)}\\s*:`, "m").test(text);
  }
}

/**
 * The `[mcp_servers.<name>]` table for Codex: exactly `url` and
 * `bearer_token_env_var`, naming `keyEnv`.
 *
 * Not `bearer_token` — Codex rejects an inline token on an HTTP server and
 * the whole file then fails to load — and not `http_headers`, which would
 * put the key in the file. A JSON string literal is a valid TOML basic
 * string, escapes included.
 */
export function codexTomlBlock(name: string, url: string, keyEnv: string = KEY_ENV_VAR): string {
  return [
    `[mcp_servers.${name}]`,
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(keyEnv)}`,
  ].join("\n");
}

/**
 * The variable Hermes reads an entry's key from — the name `hermes mcp add`
 * derives from the server name, so the entry matches one Hermes would write.
 *
 * Hermes also strips the underscores a leading or trailing `-` or `_`
 * leaves (`kagura_` gives `MCP_KAGURA_API_KEY`), so this does too.
 */
export function hermesEnvVar(name: string): string {
  const suffix = name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return `MCP_${suffix}_API_KEY`;
}

/**
 * The `mcp_servers.<name>` block for Hermes's `config.yaml`: the whole
 * mapping, or with `entryIndent` (see `yamlServersIndent`) the `<name>`
 * entry alone, indented to go under an `mcp_servers:` key already there.
 */
export function hermesYamlBlock(name: string, url: string, envVar: string, entryIndent?: string): string {
  // JSON string literals are valid YAML double-quoted scalars.
  const entry = [
    `${name}:`,
    `  url: ${JSON.stringify(url)}`,
    "  headers:",
    `    Authorization: ${JSON.stringify(`Bearer \${${envVar}}`)}`,
  ];
  return entryIndent === undefined
    ? ["mcp_servers:", ...entry.map((line) => `  ${line}`)].join("\n")
    : entry.map((line) => `${entryIndent}${line}`).join("\n");
}

/**
 * The OpenClaw entry.
 *
 * `transport` is explicit because OpenClaw otherwise assumes `sse`. The
 * header is a `${keyEnv}` reference: `mcp.servers.*.headers` does not take
 * OpenClaw's secret references, and a literal key is what
 * `openclaw mcp doctor` warns about.
 */
export function openclawEntry(url: string, keyEnv: string = KEY_ENV_VAR): Record<string, unknown> {
  return {
    url,
    transport: "streamable-http",
    headers: { Authorization: `Bearer \${${keyEnv}}` },
  };
}

/** The entry nested at `mcp.servers.<name>`; JSON, which JSON5 accepts. */
export function openclawBlock(name: string, url: string, keyEnv: string = KEY_ENV_VAR): string {
  return JSON.stringify({ mcp: { servers: { [name]: openclawEntry(url, keyEnv) } } }, null, 2);
}

/**
 * The `[mcp_servers.<name>]` table of an `--oauth` entry: `url` alone.
 * With no bearer named, Codex's `auth` defaults to OAuth — Python's
 * `_Codex.block` for `entry.oauth`.
 */
export function codexTomlOauthBlock(name: string, url: string): string {
  return [`[mcp_servers.${name}]`, `url = ${JSON.stringify(url)}`].join("\n");
}

/**
 * The Hermes `mcp_servers.<name>` block of an `--oauth` entry: `url` and
 * `auth: oauth`, no headers — whole, or with `entryIndent` the entry alone
 * (see {@link hermesYamlBlock}).
 */
export function hermesYamlOauthBlock(name: string, url: string, entryIndent?: string): string {
  const entry = [`${name}:`, `  url: ${JSON.stringify(url)}`, "  auth: oauth"];
  return entryIndent === undefined
    ? ["mcp_servers:", ...entry.map((line) => `  ${line}`)].join("\n")
    : entry.map((line) => `${entryIndent}${line}`).join("\n");
}

/**
 * The OpenClaw `--oauth` entry: `auth: "oauth"` and no headers, which
 * OpenClaw ignores with OAuth — Python's `_OpenClaw.server` for `entry.oauth`.
 */
export function openclawOauthEntry(url: string): Record<string, unknown> {
  return { url, transport: "streamable-http", auth: "oauth" };
}

/** {@link openclawOauthEntry} nested at `mcp.servers.<name>`. */
export function openclawOauthBlock(name: string, url: string): string {
  return JSON.stringify({ mcp: { servers: { [name]: openclawOauthEntry(url) } } }, null, 2);
}

/** POSIX-quote one argument, leaving plain words bare. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An argv as a line a user could paste into a POSIX shell. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

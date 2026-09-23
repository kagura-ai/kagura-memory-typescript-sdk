/**
 * Text helpers for `setup`: MCP URL query edits, the line-based `.env`
 * files Hermes and OpenClaw read, the blocks printed for a user to paste,
 * and read-only scans for an existing entry.
 *
 * None of this parses TOML, YAML or JSON5, and none of it rewrites those
 * files. The package takes no runtime dependencies, so a harness config is
 * changed only by the harness's own CLI, or by the user from a printed
 * block. The scans look for the entry's key and nothing else, to decide
 * whether `--force` is needed; they err toward "exists", because a false
 * positive costs a `--force` while a false negative lets a harness CLI
 * replace an entry nobody asked it to touch.
 */

import { CliError } from "../parse.js";

/** The variable Codex and OpenClaw entries read the key from. */
export const KEY_ENV_VAR = "KAGURA_API_KEY";

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

function paramName(param: string): string {
  const eq = param.indexOf("=");
  return eq === -1 ? param : param.slice(0, eq);
}

/** The decoded value of `key` in the URL's query, or undefined. */
export function queryParam(url: string, key: string): string | undefined {
  const param = splitUrl(url).params.find((p) => paramName(p) === key);
  if (param === undefined) return undefined;
  const eq = param.indexOf("=");
  if (eq === -1) return "";
  return unquotePlus(param.slice(eq + 1));
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
 * Every other parameter is kept as written; an unset key is left alone.
 */
export function mcpUrlWithQuery(
  url: string,
  updates: { guardrails?: string | undefined; profile?: string | undefined },
): string {
  const set = (["guardrails", "profile"] as const).filter((key) => updates[key] !== undefined);
  if (set.length === 0) return url;
  const { base, params, fragment } = splitUrl(url);
  const kept = params.filter((param) => !(set as readonly string[]).includes(unquotePlus(paramName(param))));
  const added = set.map((key) => `${key}=${quotePlus(updates[key]!)}`);
  return `${base}?${[...kept, ...added].join("&")}${fragment}`;
}

/**
 * Drop `key` from the URL's query, every occurrence, keeping the other
 * parameters as written and leaving no bare `?` behind.
 */
export function withoutQueryParam(url: string, key: string): string {
  const { base, params, fragment } = splitUrl(url);
  const kept = params.filter((param) => paramName(param) !== key);
  return `${base}${kept.length > 0 ? `?${kept.join("&")}` : ""}${fragment}`;
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

/**
 * Set `name=value` in the text of a `.env` file.
 *
 * The first existing line for `name` is replaced in place (keeping an
 * `export` prefix) and any later ones are removed, so the new value is the
 * only one whichever occurrence a loader honours. Other lines, comments
 * and the file's line endings are left as they were.
 *
 * @throws CliError when the value holds a line break: written raw, it
 *   would end the line and start a second, attacker-shaped one.
 */
export function upsertEnvLine(text: string, name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new CliError(`refusing to write ${name}: the value contains a line break`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const matcher = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const lines = text === "" ? [] : text.split(/\r?\n/);
  // A final newline leaves one empty element; it is put back by the join.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: string[] = [];
  let placed = false;
  for (const line of lines) {
    const match = matcher.exec(line);
    if (match === null) out.push(line);
    else if (!placed) {
      out.push(`${match[1] ?? ""}${name}=${value}`);
      placed = true;
    }
  }
  if (!placed) out.push(`${name}=${value}`);
  return `${out.join(eol)}${eol}`;
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
 * `bearer_token_env_var`.
 *
 * Not `bearer_token` — Codex rejects an inline token on an HTTP server and
 * the whole file then fails to load — and not `http_headers`, which would
 * put the key in the file. A JSON string literal is a valid TOML basic
 * string, escapes included.
 */
export function codexTomlBlock(name: string, url: string): string {
  return [
    `[mcp_servers.${name}]`,
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(KEY_ENV_VAR)}`,
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
 * header is a `${VAR}` reference: `mcp.servers.*.headers` does not take
 * OpenClaw's secret references, and a literal key is what
 * `openclaw mcp doctor` warns about.
 */
export function openclawEntry(url: string): Record<string, unknown> {
  return {
    url,
    transport: "streamable-http",
    headers: { Authorization: `Bearer \${${KEY_ENV_VAR}}` },
  };
}

/** The entry nested at `mcp.servers.<name>`; JSON, which JSON5 accepts. */
export function openclawBlock(name: string, url: string): string {
  return JSON.stringify({ mcp: { servers: { [name]: openclawEntry(url) } } }, null, 2);
}

/** POSIX-quote one argument, leaving plain words bare. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An argv as a line a user could paste into a POSIX shell. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * `kagura-memory doctor` — diagnose setup, auth, MCP and connectivity.
 *
 * Structure is a port of `doctor.py`: a flat list of checks, each tagged
 * with a section and a status, rendered one per line as `STATUS message`,
 * or as JSON with `--json`. Exit is 1 if any check failed; warnings never
 * affect it.
 *
 * Two of Python's sections have no counterpart here and are reported as
 * such rather than faked: `llm` and `security` inspect litellm and the
 * provider API keys used by `KaguraAgent`, which this SDK does not ship.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  defaultCredentialsPath,
  isExpired,
  loadCredentialsFile,
  profileNamed,
} from "../../auth/credentials.js";
import type { ResolvedAuth } from "../../auth/types.js";
import { MIN_SERVER_VERSION, warnBelowMinimum, type KaguraClientOptions } from "../../client.js";
import { isEnvFallbackConfig, jsonErrorWhere, type KaguraConfig } from "../../config.js";
import { excMessage, KaguraAuthError, KaguraConnectionError, KaguraResponseError } from "../../errors.js";
import { normalizeUrl, validateHttpsUrl } from "../../http.js";
import type { ServerInfo } from "../../models.js";
import { readModel, SERVER_INFO } from "../../pyModels.js";
import { pyRepr } from "../../python.js";
import { meetsMinimum, requireVersion } from "../../versionCheck.js";
import { rejectExtraArgs, type Command, type CommandDeps } from "../command.js";
import { formatJson } from "../output.js";
import type { FlagSpec } from "../parseArgs.js";
import type { CliDeps } from "../run.js";
import { shellQuote } from "./harnessConfig.js";
import {
  classifyMcpEntry,
  claudeJsonLabel,
  findClaudeEntries,
  holdsCredential,
  realProjectPath,
  unsetHeaderVars,
  type ClaudeScope,
} from "./setup.js";

type Status = "pass" | "warn" | "fail" | "info";

interface DoctorCheck {
  section: string;
  status: Status;
  message: string;
  details?: Record<string, unknown>;
}

/** The SDK's minimum as a triple, for `meetsMinimum`. */
const MIN_SERVER_VERSION_TRIPLE = requireVersion(MIN_SERVER_VERSION, "MIN_SERVER_VERSION");

/** Python's `_STATUS_ORDER`; a section takes its worst check's status. */
const STATUS_ORDER: Record<Status, number> = { fail: 3, warn: 2, pass: 1, info: 0 };

const PROFILE: FlagSpec = { name: "profile", type: "value", help: "OAuth profile to inspect" };
const JSON_FLAG: FlagSpec = { name: "json", type: "switch", help: "Emit machine-readable JSON" };

function checkAuth(deps: CommandDeps, profile: string | undefined): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const credsPath = defaultCredentialsPath();
  const envKey = process.env.KAGURA_API_KEY;
  const envKeySet = envKey !== undefined && envKey.trim() !== "";
  // Python's `profile or os.getenv("KAGURA_PROFILE") or None`: an empty
  // --profile falls back like an absent one.
  const envProfile = process.env.KAGURA_PROFILE || undefined;
  const selected = profile || envProfile;

  if (!fs.existsSync(credsPath)) {
    checks.push({
      section: "auth",
      status: "warn",
      message: `no credentials file at ${credsPath}; run: kagura-memory auth login`,
    });
  } else {
    let file;
    try {
      file = loadCredentialsFile(credsPath);
    } catch (e) {
      checks.push({
        section: "auth",
        status: "fail",
        message: `credentials file is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      });
      file = undefined;
    }
    if (file !== undefined) {
      const names = Object.keys(file.profiles);
      if (names.length === 0) {
        checks.push({ section: "auth", status: "warn", message: "credentials file has no profiles" });
      } else {
        const target = selected ?? file.defaultProfile;
        const creds = profileNamed(file, target);
        if (creds === undefined) {
          // Python resolves KAGURA_API_KEY before any profile, so a missing
          // one is no failure then.
          if (!envKeySet) {
            checks.push({
              section: "auth",
              status: "fail",
              message: `no profile named '${target}'; available: ${names.sort().join(", ")}`,
            });
          }
        } else if (!isExpired(creds)) {
          checks.push({
            section: "auth",
            status: "pass",
            message: `profile '${target}' is active until ${creds.expiresAt.toISOString()}`,
            details: { workspace: creds.workspaceName || creds.workspaceId || null },
          });
        } else if (creds.refreshToken) {
          checks.push({
            section: "auth",
            status: "warn",
            message: `profile '${target}' has expired but can refresh`,
          });
        } else {
          checks.push({
            section: "auth",
            status: "fail",
            message: `profile '${target}' has expired and has no refresh token; run: kagura-memory auth login`,
          });
        }
        if (names.length > 1 && selected === undefined) {
          // The SDK warns about this at construction time too; saying it
          // here is what makes "why did it write to the wrong workspace"
          // answerable before the fact.
          checks.push({
            section: "auth",
            status: "warn",
            message: `${names.length} profiles configured and none selected; the default '${file.defaultProfile}' is implicit`,
          });
        }
      }
    }
  }

  if (envKeySet) {
    // The env var beats every OAuth profile, which surprises people who
    // just ran `auth login` and still reach the wrong workspace.
    checks.push({
      section: "auth",
      status: "warn",
      message: "KAGURA_API_KEY is set and takes precedence over any OAuth profile",
    });
  }

  const config = safeConfig(deps);
  if (typeof config?.api_key === "string" && config.api_key.trim()) {
    checks.push({
      section: "auth",
      status: "info",
      message: ".kagura.json carries an api_key (used only when no env key and no profile resolve)",
    });
  }
  return checks;
}

function safeConfig(deps: CommandDeps): Record<string, unknown> | null {
  try {
    return deps.loadConfig() as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * How to replace a legacy `type: "url"` entry, by the scope it is in —
 * Python's `_LEGACY_TYPE_FIX`. Setup writes project and user scope; a
 * local one must go first, or the re-run's shadow check refuses to write
 * under it.
 */
const LEGACY_TYPE_FIX: Record<ClaudeScope, string> = {
  project: "re-run `kagura-memory setup claude`",
  user: "re-run `kagura-memory setup claude --scope user`",
  local:
    "remove it (`claude mcp remove --scope local kagura-memory`), then re-run " +
    "`kagura-memory setup claude`",
};

/**
 * How to replace an entry outside project scope that holds the key, by
 * the scope it is in: setup writes a user-scope one that sends
 * ${KAGURA_MCP_API_KEY}, and writes no local-scope one.
 */
const CREDENTIAL_FIX: Record<Exclude<ClaudeScope, "project">, string> = {
  user:
    "re-run `kagura-memory setup claude --scope user` with KAGURA_MCP_API_KEY exported to replace it " +
    "with one that sends ${KAGURA_MCP_API_KEY}",
  local:
    "remove it (`claude mcp remove --scope local kagura-memory`), then re-run " +
    "`kagura-memory setup claude`",
};

/**
 * The `mcp` section: the file's `mcp_url`, `.mcp.json` and the entry
 * Claude Code uses. `warned` is the resolved MCP URL `checkServer` has
 * already warned about as Python's `_check_https` does (a warning, the
 * check skipped), or `null`: a verdict here on that same URL would fail
 * it for one cause, exit 1 where Python 0.42.0 exits 0.
 */
function checkMcp(deps: CliDeps, warned: string | null): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const config = safeConfig(deps);
  // A config built from the environment (no `.kagura.json`) carries
  // `KAGURA_MCP_URL` or the default, not a URL any file configured; that
  // is the resolved URL, `checkServer`'s to report.
  const envBuilt = config !== null && isEnvFallbackConfig(config as unknown as KaguraConfig);
  const url = !envBuilt && typeof config?.mcp_url === "string" ? config.mcp_url : "";
  if (envBuilt && process.env.KAGURA_MCP_URL) {
    // Named by checkServer's warning when insecure; nothing to add here.
  } else if (url) {
    // A plaintext MCP URL means the bearer token crosses the wire in the
    // clear; localhost is the one place that is a deliberate dev choice.
    // The clients' own check decides, so doctor fails exactly the plain
    // HTTP they refuse and passes HTTPS in any case (`HTTPS://`); a URL
    // that is not http(s) at all still fails.
    let refused = false;
    try {
      validateHttpsUrl(url);
    } catch {
      refused = true;
    }
    if (!refused && /^https?:/i.test(normalizeUrl(url))) {
      checks.push({ section: "mcp", status: "pass", message: `mcp_url is ${url}` });
    } else if (url === warned) {
      // The credential resolved from this file, so its URL is the one
      // checkServer warned about: Python's single WARN, exit 0. A file
      // URL that another source shadows (KAGURA_API_KEY, an OAuth
      // profile) is not reported there and still fails here, as `setup
      // claude` refuses it.
    } else {
      checks.push({
        section: "mcp",
        status: "fail",
        message: `mcp_url is not HTTPS: ${url} — credentials would be sent in the clear`,
      });
    }
  } else {
    checks.push({ section: "mcp", status: "info", message: "no mcp_url configured; the default is used" });
  }

  const cwd = process.cwd();
  const mcpJson = path.join(cwd, ".mcp.json");
  const hasMcpJson = fs.existsSync(mcpJson);
  if (hasMcpJson) {
    let text: string | null = null;
    try {
      text = fs.readFileSync(mcpJson, "utf-8");
    } catch (e) {
      checks.push({
        section: "mcp",
        status: "fail",
        message: `.mcp.json cannot be read: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (text !== null) {
      try {
        JSON.parse(text);
      } catch (e) {
        // Python reads such a file as empty; Claude Code cannot load it
        // either, which is worth more than a missing entry. Where, never
        // what: the file can hold the key (see jsonErrorWhere).
        const where = jsonErrorWhere(e, text);
        checks.push({
          section: "mcp",
          status: "fail",
          message: `.mcp.json is not valid JSON${where ? ` (${where})` : ""}`,
        });
      }
    }
  }

  // Python's _check_mcp: the entry Claude Code uses (the strongest scope)
  // first, then every one it hides.
  const entries = findClaudeEntries(cwd);
  const used = entries[0];
  if (used === undefined) {
    checks.push(
      hasMcpJson
        ? { section: "mcp", status: "warn", message: "No usable kagura-memory entry found in .mcp.json" }
        : {
            section: "mcp",
            status: "info",
            message: `No kagura-memory MCP entry found (.mcp.json, ${claudeJsonLabel()})`,
          },
    );
    return checks;
  }
  // A fresh copy for each check: one object shared by two of them is not
  // a cycle, but it is still one object.
  const details = () => ({ scope: used.scope, source: used.source });
  const mode = classifyMcpEntry(used.config);
  if (mode === "absent") {
    checks.push({
      section: "mcp",
      status: "warn",
      message: `No usable kagura-memory entry found in ${used.source} (${used.scope} scope)`,
      details: details(),
    });
  } else {
    // Python warns about a static-token entry and points at `setup claude
    // --profile`, whose stdio proxy this package does not ship; here that
    // entry is the one `setup claude` writes at project scope, so it
    // passes. One elsewhere that holds the key gets the warning below.
    checks.push({
      section: "mcp",
      status: "pass",
      message: `MCP Mode: ${mode} (${used.scope} scope, ${used.source})`,
      details: details(),
    });
  }
  if (used.scope !== "project" && holdsCredential(used.config)) {
    // The key is stored in ~/.claude.json — as `setup claude --scope user`
    // wrote it before 0.11.0 — where the entry could send
    // ${KAGURA_MCP_API_KEY} instead.
    checks.push({
      section: "mcp",
      status: "warn",
      message:
        `The kagura-memory entry (${used.scope} scope, ${used.source}) holds an API key in that file; ` +
        CREDENTIAL_FIX[used.scope],
      details: details(),
    });
  }
  if (used.config.type === "url") {
    let fix = LEGACY_TYPE_FIX[used.scope];
    const mcpJsonDir = path.dirname(used.path);
    if (used.scope === "project" && mcpJsonDir !== realProjectPath(cwd)) {
      // A parent directory's .mcp.json: a re-run here would write a closer file.
      fix = `re-run \`kagura-memory setup claude --project-dir ${shellQuote(mcpJsonDir)}\``;
    }
    checks.push({
      section: "mcp",
      status: "warn",
      message:
        `The kagura-memory entry has type "url", which Claude Code does not accept; ` +
        `${fix} to write it as "http"`,
      details: details(),
    });
  }
  for (const name of unsetHeaderVars(used.config)) {
    // e.g. setup's user-scope entry, which sends ${KAGURA_MCP_API_KEY}.
    // Claude Code would send the reference as literal text.
    checks.push({
      section: "mcp",
      status: "warn",
      message:
        `The kagura-memory entry sends \${${name}} in a header, but ${name} is not set here: ` +
        "set it in the environment that starts Claude Code, or the server rejects the request",
      details: { ...details(), env: name },
    });
  }
  for (const hidden of entries.slice(1)) {
    checks.push({
      section: "mcp",
      status: "warn",
      message:
        `kagura-memory is also defined in ${hidden.scope} scope (${hidden.source}), ` +
        `but Claude Code uses the ${used.scope}-scope entry here`,
      details: { scope: hidden.scope, source: hidden.source },
    });
  }
  // A stdio entry is Python's (this bin writes none), and a missing proxy
  // is exactly what breaks it at launch. Python's pair of checks; its
  // "skipped" info line for every other entry is left out, as it would
  // follow every entry this bin writes and says nothing to act on.
  if (mode === "stdio") {
    checks.push(
      deps.which("kagura-mcp") !== null
        ? { section: "mcp", status: "pass", message: "kagura-mcp found on PATH" }
        : { section: "mcp", status: "fail", message: "kagura-mcp not found on PATH" },
    );
  }
  return checks;
}

async function checkExtras(): Promise<DoctorCheck[]> {
  try {
    await import("age-encryption");
    return [
      { section: "extras", status: "pass", message: "age-encryption is installed; `secret` commands are available" },
    ];
  } catch {
    return [
      {
        section: "extras",
        status: "info",
        message:
          "age-encryption is not installed; `secret` commands need it (npm install age-encryption)",
      },
    ];
  }
}

function checkKeyCustody(): DoctorCheck[] {
  const inline = process.env.KAGURA_AGE_IDENTITY?.trim();
  const file = process.env.KAGURA_AGE_IDENTITY_FILE?.trim();
  if (!inline && !file) {
    return [
      {
        section: "security",
        status: "info",
        message:
          "no age identity configured (KAGURA_AGE_IDENTITY / KAGURA_AGE_IDENTITY_FILE); secret decryption is unavailable",
      },
    ];
  }
  if (inline) {
    // The value lives in the process environment, which is visible to
    // anything that can read /proc or run `ps e` as the same user.
    return [
      {
        section: "security",
        status: "warn",
        message: "KAGURA_AGE_IDENTITY holds the private key in the environment; a file is safer",
      },
    ];
  }
  const checks: DoctorCheck[] = [];
  try {
    const stat = fs.statSync(file!);
    // Mode bits are meaningless on Windows, so only report where they are.
    if (os.platform() !== "win32" && (stat.mode & 0o077) !== 0) {
      checks.push({
        section: "security",
        status: "fail",
        message: `${file} is readable by others (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`,
      });
    } else {
      checks.push({ section: "security", status: "pass", message: `age identity file present: ${file}` });
    }
  } catch {
    checks.push({ section: "security", status: "fail", message: `KAGURA_AGE_IDENTITY_FILE is unreadable: ${file}` });
  }
  return checks;
}

/** Python's message for an OAuth bearer the REST info route refuses. */
const OAUTH_VERSION_UNVERIFIED =
  "Could not verify server version over REST with an OAuth profile " +
  "(expected: REST validates API keys, not OAuth bearers; the MCP connection is unaffected).";

/** Python's pair for a credential that does not resolve: the auth failure, then the skipped check. */
function authUnresolved(e: KaguraAuthError): DoctorCheck[] {
  return [
    { section: "auth", status: "fail", message: `Authentication could not be resolved: ${excMessage(e)}` },
    { section: "server", status: "info", message: "Server connectivity check skipped because auth resolution failed" },
  ];
}

/**
 * Python's `_check_server`: `Server reachable`, then `Version: …` as
 * pass, fail or info by the shared `meetsMinimum` against the SDK's
 * {@link MIN_SERVER_VERSION} (python-sdk #280). The advisory on stderr is
 * `checkServerVersion`'s, from the same comparison, so the two cannot
 * disagree.
 *
 * The credential is resolved first, as Python's `run_doctor` resolves it
 * for a bare client: `KAGURA_API_KEY`, then the OAuth profile (`--profile`,
 * `KAGURA_PROFILE` or the default), then `.kagura.json`. A credential that
 * does not resolve fails the auth section, as Python's `_check_auth`
 * reports it, and skips this check, as Python's doctor has no client to
 * check with. A resolved MCP URL that is not HTTPS is Python's
 * `_check_https` warning, and the check is skipped rather than sending the
 * credential in the clear.
 *
 * The body is read as Python's `get_server_info` reads it, through its
 * `ServerInfo` model, and one the model refuses is unreachable, as
 * Python's `KaguraConnectionError` for it is.
 *
 * A failure other than an auth or connection error (a body that is no
 * JSON, a 429) fails the check with its message, where Python's doctor
 * stops with a traceback.
 */
async function checkServer(deps: CommandDeps, profile: string | undefined): Promise<DoctorCheck[]> {
  // Python's run_doctor resolves as a bare client does (api_key=None,
  // mcp_url=None): KAGURA_API_KEY, then the OAuth profile (--profile,
  // KAGURA_PROFILE or the default), then .kagura.json. Forcing the config
  // file's key and URL checked a server the SDK does not use (#69).
  //
  // The config is loaded first, as Python's `run_doctor` calls
  // `load_config()` before anything else: a `.kagura.json` that does not
  // parse fails this check with the message naming it (Python stops with
  // that message). Substituting an empty config would resolve it as "No
  // credentials found", whose advice is to create the file that exists.
  let config: KaguraConfig;
  try {
    config = deps.loadConfig();
  } catch (e) {
    return [{ section: "server", status: "fail", message: excMessage(e) }];
  }
  let resolved: ResolvedAuth;
  try {
    resolved = deps.resolveAuth({ apiKey: null, mcpUrl: null, profile: profile ?? null, config });
  } catch (e) {
    if (e instanceof KaguraAuthError) return authUnresolved(e);
    return [{ section: "server", status: "fail", message: excMessage(e) }];
  }

  // Python's _check_https: a plaintext URL is a warning, and the server is
  // not contacted with the credential in the clear.
  try {
    validateHttpsUrl(resolved.mcpUrl, "MCP URL");
  } catch (e) {
    return [
      { section: "mcp", status: "warn", message: excMessage(e), details: { mcp_url: resolved.mcpUrl } },
      { section: "server", status: "info", message: "Server connectivity check skipped because the MCP URL is insecure" },
    ];
  }

  const clientOptions: KaguraClientOptions = profile !== undefined ? { profile } : {};

  // Construction is inside the try because it validates the URL and can
  // throw — and a check whose job is to *report* a bad URL must not be the
  // thing that dies on one.
  let client;
  try {
    client = deps.makeClient(clientOptions);
  } catch (e) {
    if (e instanceof KaguraAuthError) return authUnresolved(e);
    return [{ section: "server", status: "fail", message: excMessage(e) }];
  }
  let info: unknown;
  try {
    info = await client.getServerInfo();
  } catch (e) {
    if (e instanceof KaguraAuthError) {
      return [
        resolved.kind === "oauth"
          ? { section: "server", status: "info", message: OAUTH_VERSION_UNVERIFIED }
          : { section: "server", status: "fail", message: excMessage(e) },
      ];
    }
    if (e instanceof KaguraConnectionError) {
      return [{ section: "server", status: "fail", message: `Server unreachable: ${excMessage(e)}` }];
    }
    return [{ section: "server", status: "fail", message: excMessage(e) }];
  } finally {
    await client.close();
  }

  try {
    readModel(info, SERVER_INFO, "KaguraClient.get_server_info");
  } catch (e) {
    if (!(e instanceof KaguraResponseError)) throw e;
    return [
      { section: "server", status: "fail", message: `Server unreachable: Invalid response format: ${e.message}` },
    ];
  }
  const version: unknown = (info as ServerInfo).version;
  warnBelowMinimum(version);

  const checks: DoctorCheck[] = [{ section: "server", status: "pass", message: "Server reachable" }];
  const shown = typeof version === "string" ? version : pyRepr(version);
  const meets = meetsMinimum(version, MIN_SERVER_VERSION_TRIPLE);
  if (meets === null) {
    checks.push({ section: "server", status: "info", message: `Version: ${shown}`, details: { version } });
  } else if (!meets) {
    checks.push({
      section: "server",
      status: "fail",
      message: `Version: ${shown} is below minimum ${MIN_SERVER_VERSION}`,
      details: { version, minimum: MIN_SERVER_VERSION },
    });
  } else {
    checks.push({ section: "server", status: "pass", message: `Version: ${shown}`, details: { version } });
  }
  return checks;
}

export const DOCTOR: Command = {
  summary: "Diagnose common setup, auth, MCP, and connectivity issues.",
  spec: { flags: [PROFILE, JSON_FLAG] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    // The server check resolves the credential; a failure to is reported
    // with the auth checks, where Python's `_check_auth` reports it.
    const server = await checkServer(deps, args.values.profile);
    // The only `mcp` check the server check makes is the insecure-URL
    // warning; checkMcp must not fail that URL a second time.
    const warned = server.find((c) => c.section === "mcp")?.details?.mcp_url;
    const checks: DoctorCheck[] = [
      ...checkAuth(deps, args.values.profile),
      ...server.filter((c) => c.section === "auth"),
      ...checkMcp(deps as CliDeps, typeof warned === "string" ? warned : null),
      ...(await checkExtras()),
      ...checkKeyCustody(),
      {
        section: "llm",
        status: "info",
        message: "this SDK ships no LLM layer; `ingest` lives in the Python package",
      },
      ...server.filter((c) => c.section !== "auth"),
    ];

    // Section status is the worst of its checks.
    const sections: Record<string, Status> = {};
    for (const check of checks) {
      const current = sections[check.section];
      if (current === undefined || STATUS_ORDER[check.status] > STATUS_ORDER[current]) {
        sections[check.section] = check.status;
      }
    }
    const exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;

    if (args.flags.has("json")) {
      // Python's to_dict() also spreads each section as a TOP-LEVEL key.
      // It reads like a bug, but a script written against the Python CLI
      // reads those keys, so the shape is reproduced rather than tidied.
      // Every check carries `details`, `{}` when it has none, as there.
      const rendered = checks.map(({ section, status, message, details }) => ({
        section,
        status,
        message,
        details: details ?? {},
      }));
      deps.write(formatJson({ sections, checks: rendered, exit_code: exitCode, ...sections }));
    } else {
      for (const check of checks) {
        deps.write(`${check.status.toUpperCase()} ${check.message}`);
      }
    }
    return exitCode;
  },
};

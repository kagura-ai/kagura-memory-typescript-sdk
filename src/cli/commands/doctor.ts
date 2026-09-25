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
import { MIN_SERVER_VERSION, type KaguraClientOptions } from "../../client.js";
import { jsonErrorWhere, type KaguraConfig } from "../../config.js";
import { excMessage, KaguraAuthError, KaguraConnectionError } from "../../errors.js";
import { normalizeUrl, validateHttpsUrl } from "../../http.js";
import type { ServerInfo } from "../../models.js";
import { pyRepr } from "../../python.js";
import { meetsMinimum, requireVersion } from "../../versionCheck.js";
import { rejectExtraArgs, type Command, type CommandDeps } from "../command.js";
import { formatJson } from "../output.js";
import type { FlagSpec } from "../parseArgs.js";
import type { CliDeps } from "../run.js";
import { mcpOptions } from "../runClientCommand.js";
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
        const target = profile ?? file.defaultProfile;
        const creds = profileNamed(file, target);
        if (creds === undefined) {
          checks.push({
            section: "auth",
            status: "fail",
            message: `no profile named '${target}'; available: ${names.sort().join(", ")}`,
          });
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
        if (names.length > 1 && profile === undefined) {
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

  const envKey = process.env.KAGURA_API_KEY;
  if (envKey !== undefined && envKey.trim()) {
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

function checkMcp(deps: CliDeps): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const config = safeConfig(deps);
  const url = typeof config?.mcp_url === "string" ? config.mcp_url : "";
  if (url) {
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

/** Whether `options` resolve to an OAuth profile, as the client built from them does. */
function resolvesToOAuth(deps: CommandDeps, options: KaguraClientOptions): boolean {
  try {
    return (
      deps.resolveAuth({
        apiKey: options.apiKey ?? null,
        mcpUrl: options.mcpUrl ?? null,
        profile: options.profile ?? null,
      }).kind === "oauth"
    );
  } catch {
    return false;
  }
}

/**
 * Python's `_check_server`: `Server reachable`, then `Version: …` as
 * pass, fail or info by the shared `meetsMinimum` against the SDK's
 * {@link MIN_SERVER_VERSION} (python-sdk #280). `checkServerVersion`
 * makes the same comparison, so its advisory on stderr and this verdict
 * cannot disagree.
 *
 * A failure other than an auth or connection error (a body that is no
 * JSON, a 429) fails the check with its message, where Python's doctor
 * stops with a traceback.
 */
async function checkServer(deps: CommandDeps, profile: string | undefined): Promise<DoctorCheck[]> {
  // With --profile, Python resolves that profile with no key forced over
  // it (`KAGURA_API_KEY` still first), so the check reaches the profile's
  // own server rather than the default's.
  const clientOptions: KaguraClientOptions =
    profile !== undefined ? { profile } : mcpOptions((safeConfig(deps) ?? {}) as KaguraConfig);

  // Construction is inside the try because it validates the URL and can
  // throw — and a check whose job is to *report* a bad URL must not be the
  // thing that dies on one.
  let client;
  try {
    client = deps.makeClient(clientOptions);
  } catch (e) {
    return [{ section: "server", status: "fail", message: excMessage(e) }];
  }
  let info: ServerInfo;
  try {
    info = await client.checkServerVersion();
  } catch (e) {
    if (e instanceof KaguraAuthError) {
      return [
        resolvesToOAuth(deps, clientOptions)
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

  const checks: DoctorCheck[] = [{ section: "server", status: "pass", message: "Server reachable" }];
  const version: unknown = info.version;
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
    const checks: DoctorCheck[] = [
      ...checkAuth(deps, args.values.profile),
      ...checkMcp(deps as CliDeps),
      ...(await checkExtras()),
      ...checkKeyCustody(),
      {
        section: "llm",
        status: "info",
        message: "this SDK ships no LLM layer; `ingest` lives in the Python package",
      },
      ...(await checkServer(deps, args.values.profile)),
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

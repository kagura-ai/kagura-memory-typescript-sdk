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

import { defaultCredentialsPath, loadCredentialsFile, isExpired } from "../../auth/credentials.js";
import type { KaguraConfig } from "../../config.js";
import { rejectExtraArgs, type Command, type CommandDeps } from "../command.js";
import { formatJson } from "../output.js";
import type { FlagSpec } from "../parseArgs.js";
import { mcpOptions } from "../runClientCommand.js";

type Status = "pass" | "warn" | "fail" | "info";

interface DoctorCheck {
  section: string;
  status: Status;
  message: string;
  details?: Record<string, unknown>;
}

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
        const creds = file.profiles[target];
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

function checkMcp(deps: CommandDeps): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const config = safeConfig(deps);
  const url = typeof config?.mcp_url === "string" ? config.mcp_url : "";
  if (url) {
    // A plaintext MCP URL means the bearer token crosses the wire in the
    // clear; localhost is the one place that is a deliberate dev choice.
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
    if (url.startsWith("https://") || isLocal) {
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

  const mcpJson = path.join(process.cwd(), ".mcp.json");
  if (!fs.existsSync(mcpJson)) {
    checks.push({ section: "mcp", status: "info", message: "no .mcp.json in this directory" });
    return checks;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpJson, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    const entry = parsed.mcpServers?.["kagura-memory"];
    if (entry === undefined) {
      checks.push({
        section: "mcp",
        status: "warn",
        message: ".mcp.json has no 'kagura-memory' server; run: kagura-memory setup claude",
      });
    } else {
      checks.push({ section: "mcp", status: "pass", message: ".mcp.json configures kagura-memory" });
    }
  } catch (e) {
    checks.push({
      section: "mcp",
      status: "fail",
      message: `.mcp.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
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

async function checkServer(deps: CommandDeps): Promise<DoctorCheck[]> {
  const clientOptions = mcpOptions((safeConfig(deps) ?? {}) as KaguraConfig);

  // Construction is inside the try because it validates the URL and can
  // throw — and a check whose job is to *report* a bad URL must not be the
  // thing that dies on one.
  let client;
  try {
    client = deps.makeClient(clientOptions);
  } catch (e) {
    return [
      {
        section: "server",
        status: "fail",
        message: `cannot build a client: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  try {
    const info = await client.getServerInfo();
    return [
      {
        section: "server",
        status: "pass",
        message: `server reachable (version ${info.version ?? "unknown"})`,
        details: info as unknown as Record<string, unknown>,
      },
    ];
  } catch (e) {
    return [
      {
        section: "server",
        status: "fail",
        message: `cannot reach the server: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  } finally {
    await client.close();
  }
}

export const DOCTOR: Command = {
  summary: "Diagnose common setup, auth, MCP, and connectivity issues.",
  spec: { flags: [PROFILE, JSON_FLAG] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const checks: DoctorCheck[] = [
      ...checkAuth(deps, args.values.profile),
      ...checkMcp(deps),
      ...(await checkExtras()),
      ...checkKeyCustody(),
      {
        section: "llm",
        status: "info",
        message: "this SDK ships no LLM layer; `process` and `ingest` live in the Python package",
      },
      ...(await checkServer(deps)),
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
      deps.write(formatJson({ sections, checks, exit_code: exitCode, ...sections }));
    } else {
      for (const check of checks) {
        deps.write(`${check.status.toUpperCase()} ${check.message}`);
      }
    }
    return exitCode;
  },
};

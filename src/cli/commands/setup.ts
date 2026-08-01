/**
 * `kagura-memory setup claude` — wire Claude Code to Kagura Memory.
 *
 * Writes `.kagura.json` and `.mcp.json` in the project directory, merging
 * with whatever is already there, and makes sure both are gitignored.
 *
 * Python has a second, OAuth path that writes a *stdio* `.mcp.json`
 * launching its `kagura-mcp` proxy so no API key is ever written to disk.
 * That proxy is a Python console script with no counterpart in this
 * package, so `--profile` reports that rather than writing a config that
 * would name a binary the user does not have.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { formatJson } from "../output.js";
import { CliError, CliUsageError } from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { resolveConfig } from "../runClientCommand.js";

const API_KEY: FlagSpec = { name: "api-key", type: "value", help: "Kagura API key (skip prompt)" };
const MCP_URL: FlagSpec = { name: "mcp-url", type: "value", metavar: "URL", help: "MCP URL" };
const CONTEXT_ID: FlagSpec = { name: "context-id", short: "c", type: "value", help: "Context ID" };
const PROFILE: FlagSpec = { name: "profile", type: "value", help: "OAuth profile name" };
const PROJECT_DIR: FlagSpec = {
  name: "project-dir",
  type: "value",
  metavar: "DIR",
  help: "Project directory",
  defaultLabel: ".",
};

/** Parse a JSON file, treating "absent" and "empty" as `{}`. */
function readJsonSafe(target: string): Record<string, unknown> {
  if (!fs.existsSync(target)) return {};
  let text: string;
  try {
    text = fs.readFileSync(target, "utf-8");
  } catch (e) {
    throw new CliError(`cannot read ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    // Overwriting a file we could not understand would discard whatever
    // the operator had configured there.
    throw new CliError(
      `refusing to rewrite ${target}: it is not a JSON object (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function writeJson(target: string, data: Record<string, unknown>): void {
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Ensure `.gitignore` lists the files that now hold credentials.
 *
 * `.kagura.json` and the static-token `.mcp.json` both carry the API key;
 * committing either publishes it.
 */
function protectSecrets(projectDir: string, files: string[]): string[] {
  const target = path.join(projectDir, ".gitignore");
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = files.filter((f) => !lines.has(f) && !lines.has(`/${f}`));
  if (missing.length === 0) return [];
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(
    target,
    `${prefix}\n# Kagura Memory — these carry credentials\n${missing.join("\n")}\n`,
    "utf-8",
  );
  return missing;
}

const claude: Command = {
  summary: "Set up Kagura Memory integration for Claude Code.",
  spec: {
    flags: [
      API_KEY,
      MCP_URL,
      CONTEXT_ID,
      PROFILE,
      PROJECT_DIR,
      { name: "non-interactive", short: "y", type: "switch", help: "No prompts; use flags/defaults" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const apiKey = args.values["api-key"];
    const profile = args.values.profile;

    if (profile !== undefined && apiKey !== undefined) {
      throw new CliUsageError(
        "--profile (OAuth) and --api-key (static token) are mutually exclusive; pick one.",
      );
    }
    if (profile !== undefined) {
      // Writing the stdio form would name `kagura-mcp`, a Python console
      // script this package does not install — the config would look right
      // and fail at launch.
      throw new CliError(
        "the OAuth (--profile) setup writes an .mcp.json that launches the `kagura-mcp` stdio\n" +
          "  proxy, which ships with the Python package, not this one.\n" +
          "  Use `pip install kagura-memory && kagura setup claude --profile " +
          `${profile}\`, or set up the static-token form here with --api-key.`,
      );
    }

    const projectDir = path.resolve(args.values["project-dir"] ?? ".");
    if (!fs.existsSync(projectDir)) {
      throw new CliUsageError(`Invalid value for '--project-dir': ${projectDir} does not exist.`);
    }

    // Fall back to whatever is already configured, so re-running with no
    // flags refreshes the files rather than blanking them.
    const { config } = resolveConfig(deps, undefined, false);
    const resolvedKey = apiKey ?? (typeof config.api_key === "string" ? config.api_key : "");
    const resolvedUrl =
      args.values["mcp-url"] ??
      (typeof config.mcp_url === "string" && config.mcp_url
        ? config.mcp_url
        : "https://memory.kagura-ai.com/mcp");
    const contextId = args.values["context-id"] ?? config.context_id ?? "";

    if (!resolvedKey) {
      throw new CliError(
        "no API key: pass --api-key, or set one in .kagura.json.\n" +
          "  For OAuth instead, run: kagura-memory auth login",
      );
    }

    const kaguraPath = path.join(projectDir, ".kagura.json");
    const kagura = readJsonSafe(kaguraPath);
    kagura.api_key = resolvedKey;
    kagura.mcp_url = resolvedUrl;
    if (contextId) kagura.context_id = contextId;
    writeJson(kaguraPath, kagura);

    const mcpPath = path.join(projectDir, ".mcp.json");
    const mcp = readJsonSafe(mcpPath);
    const servers = (mcp.mcpServers as Record<string, unknown> | undefined) ?? {};
    // The entry is replaced wholesale rather than merged: a stale header
    // from a previous key would keep authenticating as the old identity.
    servers["kagura-memory"] = {
      type: "url",
      url: resolvedUrl,
      headers: { Authorization: `Bearer ${resolvedKey}` },
    };
    mcp.mcpServers = servers;
    writeJson(mcpPath, mcp);

    const ignored = protectSecrets(projectDir, [".kagura.json", ".mcp.json"]);

    deps.write(
      formatJson({
        status: "success",
        project_dir: projectDir,
        wrote: [kaguraPath, mcpPath],
        gitignore_added: ignored,
        // Never echo the key itself back.
        mcp_url: resolvedUrl,
        context_id: contextId || null,
      }),
    );
    return 0;
  },
};

export const SETUP_GROUP: CommandGroup = {
  summary: "Set up Kagura integrations for AI coding tools.",
  commands: { claude },
};

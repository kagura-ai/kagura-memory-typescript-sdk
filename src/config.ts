/** Configuration loading for the Kagura Memory SDK (port of config.py). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shape of `.kagura.json` — the config file format is shared with the
 * Python SDK/CLI, so keys stay snake_case on disk. Additional keys are
 * preserved.
 */
export interface KaguraConfig {
  api_key?: string;
  mcp_url?: string;
  model?: string;
  context_id?: string | null;
  llm_api_key?: string;
  workspace_id?: string;
  [key: string]: unknown;
}

export interface LoadConfigOptions {
  /** Directory searched for `./.kagura.json` (default: process.cwd()). */
  cwd?: string;
  /** Home directory searched for `~/.kagura.json` (default: os.homedir()). */
  home?: string;
  /** Environment source (default: process.env). */
  env?: Record<string, string | undefined>;
}

function readConfigFile(filePath: string, label: string): KaguraConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read ${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as KaguraConfig;
  } catch (e) {
    throw new Error(
      `Invalid JSON or encoding in ${label} (expected UTF-8): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Load configuration from `.kagura.json` or environment variables.
 *
 * Search order:
 * 1. `./.kagura.json` (current directory)
 * 2. `~/.kagura.json` (home directory)
 * 3. Environment variables (KAGURA_API_KEY, KAGURA_MCP_URL, KAGURA_MODEL)
 */
export function loadConfig(options: LoadConfigOptions = {}): KaguraConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;

  const localConfig = path.join(cwd, ".kagura.json");
  if (fs.existsSync(localConfig)) {
    return readConfigFile(localConfig, ".kagura.json");
  }

  const homeConfig = path.join(home, ".kagura.json");
  if (fs.existsSync(homeConfig)) {
    return readConfigFile(homeConfig, "~/.kagura.json");
  }

  return {
    api_key: env.KAGURA_API_KEY ?? "",
    mcp_url: env.KAGURA_MCP_URL ?? "https://memory.kagura-ai.com/mcp",
    model: env.KAGURA_MODEL ?? "gpt-5.4-nano",
    context_id: env.KAGURA_CONTEXT_ID ?? null,
  };
}

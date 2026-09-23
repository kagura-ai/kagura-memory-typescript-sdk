/**
 * Finding and running another CLI — the harness CLIs that `setup` applies
 * its entries with (`claude`, `codex`, `openclaw`).
 *
 * These are the production implementations. Commands reach them only
 * through `CliDeps.which` / `CliDeps.execFile`, next to `openBrowser`, so
 * the `setup` tests never read the real PATH or start a process.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { constants } from "node:os";
import * as path from "node:path";

type SpawnLike = typeof spawn;

export interface ExecOptions {
  /**
   * The directory to run in; the current one when unset. `claude plugin
   * list` answers for the project it runs in, so `setup` runs it in the
   * project it is setting up.
   */
  cwd?: string;
  /**
   * How long the program may run before it is killed; EXEC_TIMEOUT_MS when
   * unset. `setup claude` gives `claude` Python's 30 s.
   */
  timeoutMs?: number;
}

export interface ExecResult {
  /** Exit code; 127 when the program could not be started, 128+n for signal n. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Extensions tried on Windows, in order.
 *
 * `.cmd` and `.bat` are left out on purpose: Node refuses to spawn them
 * without a shell, and a shell would re-parse the argv — which for
 * `claude mcp add-json` carries the API key inside JSON full of quotes. A
 * harness installed only as a `.cmd` shim is treated as absent, and
 * `setup` prints the block for the user to apply instead.
 */
const WINDOWS_EXTENSIONS = [".exe", ".com"];

/**
 * Long enough for a CLI's cold start; short enough that a wedged one does
 * not hang `setup` forever.
 */
const EXEC_TIMEOUT_MS = 60_000;

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    // Windows has no execute bit; the extension is what makes it runnable.
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find `name` on PATH.
 *
 * @returns the absolute path of the first match, or null when there is none.
 */
export function which(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  // process.env is case-insensitive on Windows; a plain object is not.
  const searchPath = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32" ? WINDOWS_EXTENSIONS : [""];
  for (const dir of searchPath.split(platform === "win32" ? ";" : ":")) {
    // An empty or relative entry resolves against the current directory,
    // and running a harness CLI out of wherever `setup` happened to be
    // started is not a lookup anyone asked for.
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * Run a program to completion and capture its output.
 *
 * Never rejects: a program that cannot start resolves to code 127, the
 * shell's "command not found", so a caller has one failure path to handle.
 */
export function execFile(
  file: string,
  argv: readonly string[],
  options: ExecOptions = {},
  spawnImpl: SpawnLike = spawn,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (code: number, failure = ""): void => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: `${Buffer.concat(stderr).toString("utf-8")}${failure}`,
      });
    };

    let child;
    try {
      // No shell, so argv reaches the program verbatim and nothing in it —
      // a URL's `&`, the JSON `claude mcp add-json` takes — is re-parsed.
      // stdin is closed: a CLI that unexpectedly prompts reads EOF rather
      // than waiting for an answer this port never gives.
      child = spawnImpl(file, [...argv], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        timeout: options.timeoutMs ?? EXEC_TIMEOUT_MS,
      });
    } catch (e) {
      settle(127, e instanceof Error ? e.message : String(e));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (e) => settle(127, e.message));
    // 128+n for a signal, as in `secret exec`: "it died" stays
    // distinguishable from "it exited 0".
    child.on("close", (code, signal) =>
      settle(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))),
    );
  });
}

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
   * How long the program may run before it is killed, with SIGKILL as
   * Python's `subprocess.run(timeout=…)` kills it, and every process it
   * started with it; EXEC_TIMEOUT_MS when unset. `setup claude` gives
   * `claude` Python's 30 s, and `setup codex` and `setup openclaw` give
   * their CLIs Python's 120 s.
   */
  timeoutMs?: number;
}

export interface ExecResult {
  /** Exit code; 127 when the program could not be started, 128+n for signal n. */
  code: number;
  stdout: string;
  stderr: string;
  /**
   * Set, to true, when the program was killed for running past its
   * timeout: that run failed, whatever it would have reported. `code` is
   * then 128+SIGKILL, and the output is what it printed until then.
   */
  timedOut?: true;
}

/**
 * Extensions tried on Windows, in order.
 *
 * `.cmd` and `.bat` are left out on purpose: Node refuses to spawn them
 * without a shell, and a shell would re-parse the argv — the JSON full of
 * quotes that `claude mcp add-json` and `openclaw mcp set` take, and its
 * `${KAGURA_MCP_API_KEY}` / `${KAGURA_API_KEY}` reference, which the
 * harness must receive exactly as written. A harness installed only as a
 * `.cmd` shim is treated as absent, and `setup` prints the block for the
 * user to apply instead.
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

/** `process.kill`'s shape; injected so a test never signals a real process. */
type KillLike = (pid: number, signal: NodeJS.Signals) => unknown;

/** Signals that end this process while a child runs, so they end the child's group too. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Run a program to completion and capture its output.
 *
 * Never rejects: a program that cannot start resolves to code 127, the
 * shell's "command not found", so a caller has one failure path to handle.
 *
 * The timeout bounds the whole run. On POSIX the program leads its own
 * process group, and the timeout sends SIGKILL to that group, so a
 * launcher-style CLI — the npm `codex`, which spawns the native binary with
 * our pipes as its stdio — dies together with what it started. The run is
 * settled there and then, its pipes destroyed, rather than on 'close',
 * which a process holding the pipes that the kill missed would put off
 * indefinitely. Windows has no process groups here: only the program itself
 * is killed, and the run is settled all the same.
 */
export function execFile(
  file: string,
  argv: readonly string[],
  options: ExecOptions = {},
  spawnImpl: SpawnLike = spawn,
  killImpl: KillLike = process.kill,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // Its own process group, so one kill reaches everything it starts.
    const group = platform !== "win32";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let child: ReturnType<SpawnLike> | undefined;

    const killAll = (): void => {
      if (child === undefined) return;
      try {
        if (group && child.pid !== undefined) killImpl(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    // A detached group no longer gets the terminal's Ctrl-C, so a signal
    // that ends this process ends the group first, then this process as
    // it would have without the handler.
    const onSignal = (signal: NodeJS.Signals): void => {
      killAll();
      unlisten();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    const unlisten = (): void => {
      if (group) for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, onSignal);
    };
    const settle = (code: number, failure = "", timedOut = false): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unlisten();
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: `${Buffer.concat(stderr).toString("utf-8")}${failure}`,
        ...(timedOut ? { timedOut: true as const } : {}),
      });
    };

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
        detached: group,
      });
    } catch (e) {
      settle(127, e instanceof Error ? e.message : String(e));
      return;
    }
    const running = child;
    running.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    running.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    running.on("error", (e) => settle(127, e.message));
    // 128+n for a signal, as in `secret exec`: "it died" stays
    // distinguishable from "it exited 0".
    running.on("close", (code, signal) =>
      settle(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))),
    );
    if (group) for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
    timer = setTimeout(() => {
      // Not SIGTERM, which a CLI can catch and then exit as it likes, or
      // ignore and so hang `setup` past the timeout. Whatever it would have
      // reported, the run failed: it timed out.
      killAll();
      running.stdout?.destroy();
      running.stderr?.destroy();
      settle(128 + constants.signals.SIGKILL, "", true);
    }, options.timeoutMs ?? EXEC_TIMEOUT_MS);
  });
}

/**
 * Run a program attached to this terminal, for a harness CLI that signs in
 * or prompts: `codex mcp add` of an `--oauth` entry starts Codex's browser
 * sign-in, and `hermes mcp add` probes and asks. Python runs these with
 * `subprocess.run([exe, *args])`: inherited stdio, no timeout (a sign-in
 * takes as long as the user does). Here the program's stdout goes to this
 * process's stderr, so `setup`'s stdout stays one JSON document.
 *
 * Never rejects: 127 when the program cannot start, 128+n for signal n.
 */
export function execAttached(
  file: string,
  argv: readonly string[],
  spawnImpl: SpawnLike = spawn,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let child: ReturnType<SpawnLike>;
    try {
      // No shell: argv reaches the program verbatim.
      child = spawnImpl(file, [...argv], { stdio: ["inherit", 2, "inherit"], shell: false });
    } catch {
      settle(127);
      return;
    }
    child.on("error", () => settle(127));
    child.on("close", (code, signal) =>
      settle(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))),
    );
  });
}

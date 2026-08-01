/**
 * `kagura-memory` bin — the thin shim around {@link runCli}.
 *
 * Everything testable lives in `cli/run.ts` behind injected dependencies;
 * this file holds only what needs a real terminal, a real browser, and a
 * real process exit.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { readFileSync } from "node:fs";
import * as readline from "node:readline/promises";

import { login } from "./auth/login.js";
import { refresh } from "./auth/refresh.js";
import { openBrowser } from "./cli/openBrowser.js";
import { runCli } from "./cli/run.js";
import { KaguraClient } from "./client.js";
import { loadConfig } from "./config.js";
import { FilesClient } from "./filesClient.js";
import { ResourceClient } from "./resourceClient.js";
import { SecretClient } from "./secrets/client.js";

async function confirm(question: string): Promise<boolean> {
  // A non-interactive stdin (CI, a pipe) must not hang waiting for input
  // that will never arrive; treat it as a decline and let --yes be the
  // explicit opt-in.
  if (!process.stdin.isTTY) {
    process.stderr.write("Refusing to prompt on a non-interactive stdin. Re-run with --yes.\n");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const code = await runCli(process.argv.slice(2), {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  writeError: (line) => {
    process.stderr.write(`${line}\n`);
  },
  confirm,
  openBrowser,
  login,
  refresh,
  loadConfig,
  makeClient: (options) => new KaguraClient(options),
  makeFilesClient: (options) => new FilesClient(options),
  makeResourceClient: (options) => new ResourceClient(options),
  makeSecretClient: (options) => new SecretClient(options),
  isTty: () => Boolean(process.stdout.isTTY),
  readStdin: () => {
    // A terminal stdin would block forever waiting for input that is not
    // coming; treat it as "nothing piped in".
    if (process.stdin.isTTY) return null;
    try {
      return readFileSync(0, "utf-8");
    } catch {
      return null;
    }
  },
  spawnChild: (command, argv, extraEnv, unset) =>
    new Promise((resolve) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
      // Remove before spawning, not after: the child inherits a snapshot.
      for (const name of unset) delete childEnv[name];
      const child = spawn(command, argv, { stdio: "inherit", env: childEnv });
      child.on("error", (e) => {
        process.stderr.write(`Error: cannot run ${command}: ${e.message}
`);
        resolve(127);
      });
      // A child killed by a signal has no numeric code; 128+n is the shell
      // convention and keeps "it died" distinguishable from "it exited 0".
      child.on("close", (code, signal) =>
        resolve(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))),
      );
    }),
});

process.exitCode = code;

/**
 * `kagura-memory` bin — the thin shim around {@link runCli}.
 *
 * Everything testable lives in `cli/run.ts` behind injected dependencies;
 * this file holds only what needs a real terminal, a real browser, and a
 * real process exit.
 */

import * as readline from "node:readline/promises";

import { login } from "./auth/login.js";
import { refresh } from "./auth/refresh.js";
import { openBrowser } from "./cli/openBrowser.js";
import { runCli } from "./cli/run.js";

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
  write: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
  confirm,
  openBrowser,
  login,
  refresh,
});

process.exitCode = code;

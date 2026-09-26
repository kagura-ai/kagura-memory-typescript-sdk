/**
 * `kagura-memory guardrails …` — a context's tool guardrails (memory-cloud
 * v0.74.0+), the port of the Python CLI's `guardrails` group.
 *
 * The two commands reach the server differently, as in Python:
 *
 *   - `load` calls the MCP `load_guardrails` tool and prints the set as
 *     Python's `GuardrailSet.model_dump` prints it: the model's keys in
 *     its order, defaults filled in, fields the model does not name
 *     dropped, and a set missing a required field (a truncation flag
 *     above all) refused rather than printed as complete;
 *   - `digest` calls the REST digest route (`MemoryClient`), prints the
 *     text as is, or with `--out` splices the export block into a file
 *     through the same module `setup … --agents-md` uses.
 */

import * as fs from "node:fs";

import { excMessage } from "../../errors.js";
import {
  GuardrailBlockError,
  writeGuardrailBlock,
  type GuardrailBlockStatus,
} from "../../guardrailExport.js";
import { parseGuardrailSet } from "../../memoryClient.js";
import { pyStrip } from "../../pyCompat.js";
import type { GuardrailDigest, GuardrailDigestTarget, GuardrailSet } from "../../models.js";
import { rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { resolveCliAuth } from "../credentialSource.js";
import { cliErrorMessage, formatJsonLine } from "../output.js";
import { CliError, CliUsageError, parseChoice, parseRanged, pyRepr } from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { pathlibString } from "../pathlib.js";
import { resolveConfig, runClientCommand } from "../runClientCommand.js";

/** The operation `KaguraResponseError` names, as the Python SDK's MCP call does. */
const LOAD_OPERATION = "load_guardrails";

/**
 * The MCP `load_guardrails` result as the Python CLI prints it:
 * `parse_response(GuardrailSet, …).model_dump(mode="json")`.
 *
 * Read by the SDK's one `GuardrailSet` reader, the one
 * `MemoryClient.loadGuardrails` uses, so the bin and the SDK accept and
 * refuse the same sets: fifteen keys in the model's order, each item's
 * eleven, the MCP context block's `context_display_name`,
 * `context_is_private` and `context_is_locked` dropped, as the model does
 * not name them, and an unreadable `tool_trigger` `null`.
 *
 * @throws KaguraResponseError (`load_guardrails: unexpected server response
 *   for GuardrailSet (…)`) for a set missing a required field or holding
 *   one of the wrong type — never a partial set, and never one whose
 *   truncation flags are absent.
 */
export function projectGuardrailSet(data: unknown): GuardrailSet {
  return parseGuardrailSet(data, LOAD_OPERATION);
}

const CAP: FlagSpec = {
  name: "cap",
  type: "value",
  metavar: "INTEGER",
  help: "Max tool-triggered memories (1-1000, server default 50)",
};

const load: Command = {
  summary: "Load the full guardrail set (pinned + tool-triggered lanes) as JSON.",
  args: "[CONTEXT_ID]",
  description:
    "  CONTEXT_ID defaults to context_id in .kagura.json. Check pinned_truncated /\n" +
    "  tool_triggered_truncated before trusting the set as complete.\n\n" +
    "  Examples:\n" +
    "    kagura-memory guardrails load\n" +
    "    kagura-memory guardrails load CTX_UUID --cap 200",
  spec: { flags: [CAP] },
  run: async (deps, args) => {
    // Click converts every option before it looks for extra arguments.
    const rawCap = args.values.cap;
    const cap =
      rawCap === undefined
        ? undefined
        : parseRanged(CAP, rawCap, { min: 1, max: 1000, rangeLabel: "1<=x<=1000", integer: true });
    rejectExtraArgs(args, 1);
    // The context goes to the tool as given, as Python sends it: the
    // server, not the CLI, refuses one that is not a UUID.
    return runClientCommand(deps, args.positionals[0], async (client, contextId) =>
      projectGuardrailSet(
        await client.loadGuardrails({ contextId, ...(cap !== undefined ? { cap } : {}) }),
      ),
    );
  },
};

const TARGETS: readonly GuardrailDigestTarget[] = ["export", "instructions"];

const TARGET: FlagSpec = {
  name: "target",
  type: "value",
  metavar: "[export|instructions]",
  defaultLabel: "export",
  help: "export: the AGENTS.md block; instructions: the MCP server instructions preview",
};
const OUT: FlagSpec = {
  name: "out",
  type: "value",
  metavar: "FILE",
  help: "Write the export block into FILE (e.g. AGENTS.md) instead of printing it",
};

/**
 * Refuse an `--out` path as the Python CLI does while the options are
 * read: first as `click.Path(dir_okay=False)` does (an existing directory,
 * or an existing file this user cannot read; a path that does not exist
 * passes, and nothing is created here), then as `_nonblank_path_option`
 * does (src/kagura_memory/cli.py, python-sdk #285): an empty or
 * whitespace-only path is no file name. That check reads the path as
 * `pathlib` names it, the form the write goes to: `'./ '`, `' /'` and
 * `' /.'` are all the file `' '`, and `''` is `.`.
 */
function checkOutPath(raw: string): void {
  const invalid = (problem: string) => new CliUsageError(`Invalid value for '--out': ${problem}`);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(raw);
  } catch {
    stat = undefined;
  }
  if (stat !== undefined) {
    if (stat.isDirectory()) throw invalid(`File ${pyRepr(raw)} is a directory.`);
    try {
      fs.accessSync(raw, fs.constants.R_OK);
    } catch {
      throw invalid(`File ${pyRepr(raw)} is not readable.`);
    }
  }
  const shown = pathlibString(raw);
  if (shown === "." || !pyStrip(shown)) throw invalid("the path is blank; name a file");
}

const digest: Command = {
  summary: "Render the tool guardrails for clients without tool hooks.",
  args: "[CONTEXT_ID]",
  description:
    "  Prints the digest (REST, API key or OAuth profile). With --out, splices the\n" +
    "  export block into FILE between its marker lines: an earlier block is\n" +
    "  replaced in place, an unchanged set rewrites nothing, and an empty set\n" +
    "  removes an earlier block. CONTEXT_ID defaults to context_id in .kagura.json.\n\n" +
    "  The block is workspace memory, not repository content: point --out at an\n" +
    "  untracked file, or keep a tracked one out of commits (git update-index\n" +
    "  --skip-worktree AGENTS.md) — in a public repository a committed block\n" +
    "  publishes the guardrail summaries.\n\n" +
    "  --target instructions previews a bare MCP URL (the full tool view). For a\n" +
    "  URL with ?profile= or ?tools=, repeat them with --profile / --tools: they\n" +
    "  decide which tool the truncation note names.\n\n" +
    "  Examples:\n" +
    "    kagura-memory guardrails digest CTX_UUID\n" +
    "    kagura-memory guardrails digest CTX_UUID --out AGENTS.md\n" +
    "    kagura-memory guardrails digest CTX_UUID --target instructions --profile core",
  spec: {
    flags: [
      TARGET,
      OUT,
      {
        name: "profile",
        type: "value",
        help: "With --target instructions: the MCP URL's ?profile= value (full | core)",
      },
      { name: "tools", type: "value", help: "With --target instructions: the MCP URL's ?tools= allowlist" },
    ],
  },
  run: async (deps, args) => {
    // Option conversions first, in declaration order, then extra
    // arguments, then the combination checks: click's order.
    const rawTarget = args.values.target;
    const target = rawTarget === undefined ? "export" : parseChoice(TARGET, rawTarget, TARGETS);
    const rawOut = args.values.out;
    if (rawOut !== undefined) checkOutPath(rawOut);
    rejectExtraArgs(args, 1);
    const { profile, tools } = args.values;
    if (rawOut !== undefined && target !== "export") {
      throw new CliUsageError("--out writes the export block; drop --target instructions");
    }
    if ((profile !== undefined || tools !== undefined) && target !== "instructions") {
      throw new CliUsageError(
        "--profile / --tools shape the instructions preview; add --target instructions",
      );
    }

    const { config, contextId } = resolveConfig(deps, args.positionals[0]);
    const client = deps.makeMemoryClient(resolveCliAuth(deps, config));
    let result: GuardrailDigest;
    try {
      // A context that is not a UUID is refused here, after the credential,
      // in the Python SDK's words.
      result = await client.getGuardrailDigest(contextId, {
        target,
        ...(profile !== undefined ? { profile } : {}),
        ...(tools !== undefined ? { tools } : {}),
      });
    } catch (e) {
      throw new CliError(cliErrorMessage(e));
    } finally {
      await client.close();
    }

    if (rawOut === undefined) {
      const { text } = result;
      // `click.echo(text, nl=bool(text) and not text.endswith("\n"))`: the
      // export block already ends in a newline, the instructions preview
      // does not and gets one, and an empty text prints nothing at all.
      if (!text) deps.writeError(`No tool guardrails in context ${contextId}.`);
      else deps.write(text.endsWith("\n") ? text.slice(0, -1) : text);
      return 0;
    }

    // The path pathlib made of the argument: the one written and printed.
    const outPath = pathlibString(rawOut);
    let status: GuardrailBlockStatus;
    try {
      status = writeGuardrailBlock(outPath, result.text);
    } catch (e) {
      // A malformed block or file, or one that is not UTF-8: Python's
      // ValueError, reported with the file named. An I/O failure keeps
      // its own text.
      if (e instanceof GuardrailBlockError) {
        throw new CliError(`${outPath}: ${excMessage(e)}; left unchanged`);
      }
      throw new CliError(cliErrorMessage(e));
    }
    deps.write(
      formatJsonLine(
        { path: outPath, status, tool_triggered_version: result.tool_triggered_version },
        { ensureAscii: false },
      ),
    );
    return 0;
  },
};

export const GUARDRAILS_GROUP: CommandGroup = {
  summary: "Inspect a context's tool guardrails (server v0.74.0+).",
  commands: { load, digest },
};

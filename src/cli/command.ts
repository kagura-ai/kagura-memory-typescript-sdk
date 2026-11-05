/**
 * The command registry shape and the small helpers every command needs.
 *
 * A command is data plus one `run` function, so `run.ts` can dispatch and
 * render help generically instead of carrying a switch with 61 arms.
 */

import { CliUsageError, missingParam, parseChoice, type ChoiceOptions } from "./parse.js";
import type { FlagSpec, ParseSpec, ParsedArgs } from "./parseArgs.js";
import type { ClientCommandContext } from "./runClientCommand.js";
import { formatParagraphs, formatTable, formatUsage, HELP_WIDTH } from "./clickHelp.js";

export interface CommandDeps extends ClientCommandContext {
  /** Ask a yes/no question; resolves true to proceed. */
  confirm: (question: string) => Promise<boolean>;
}

export interface Command {
  /** One line, shown in the parent listing. */
  summary: string;
  /** Positional display, e.g. `QUERY` or `CONTEXT_ID MEMORY_ID`. */
  args?: string;
  /** Extra paragraphs for `--help`, after the option list. */
  description?: string;
  spec: ParseSpec;
  /**
   * Stop option parsing at the first positional and pass the remainder
   * through verbatim — click's `ignore_unknown_options` +
   * `allow_interspersed_args=False`. `secret exec` needs it so the child's
   * own flags reach the child instead of being rejected as ours.
   */
  passthrough?: boolean;
  /**
   * Keep options the spec does not declare as positionals, whole, instead
   * of refusing them — click's `ignore_unknown_options` alone, with
   * options still read wherever they appear. `measure record` needs it so
   * a negative VALUE such as `-3.5` needs no `--`. See
   * `ParseOptions.ignoreUnknownOptions`.
   */
  ignoreUnknownOptions?: boolean;
  run: (deps: CommandDeps, args: ParsedArgs) => Promise<number>;
}

export interface CommandGroup {
  summary: string;
  /** Extra paragraphs for the group's `--help`, after the summary. */
  description?: string;
  /** Nestable: `resource tokens list` is a group inside a group. */
  commands: Record<string, Command | CommandGroup>;
}

export function isGroup(entry: Command | CommandGroup): entry is CommandGroup {
  return "commands" in entry;
}

/**
 * Read a required option, or raise click's message for its absence.
 *
 * Exit 2 rather than 1: the invocation was wrong, nothing was attempted.
 */
export function requireOption(args: ParsedArgs, flag: FlagSpec): string {
  const value = args.values[flag.name];
  if (value === undefined) {
    throw missingParam(flag);
  }
  return value;
}

/**
 * Read a required `click.Choice` option, or raise click's message for its
 * absence, which lists the choices (`Missing option '--role'. Choose
 * from:` and one per line), or for a value that is none of them.
 */
export function requireChoice<T extends string>(
  args: ParsedArgs,
  flag: FlagSpec,
  choices: readonly T[],
  options: ChoiceOptions = {},
): T {
  const value = args.values[flag.name];
  if (value === undefined) {
    throw missingParam(flag, choices, options);
  }
  return parseChoice(flag, value, choices, options);
}

/** Read a required positional, or raise click's `Missing argument` message. */
export function requireArg(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw missingParam(name);
  }
  return value;
}

/**
 * Reject positionals a command does not take.
 *
 * Click errors on these; ignoring them would silently discard a
 * mistyped-flag-turned-positional such as `--tags foo bar`, where `bar`
 * was meant to be part of the tag list.
 */
export function rejectExtraArgs(args: ParsedArgs, allowed = 0): void {
  const extra = args.positionals.slice(allowed);
  if (extra.length > 0) {
    throw new CliUsageError(`Got unexpected extra argument${extra.length > 1 ? "s" : ""} (${extra.join(" ")})`);
  }
}

/**
 * An `Examples:` block for a command's `description`, one example per
 * line — what the Python CLI's `\b` + `Examples:` docstring blocks render
 * from 0.41.1 (python-sdk #285; before, click rewrapped them into one
 * run-on line). A line is a command after `kagura-memory `, or, when it
 * starts with a space, a continuation written as given
 * (`"  --source-uri …"`).
 */
export function examples(...lines: string[]): string {
  return ["  Examples:", ...lines.map((l) => `    ${l.startsWith(" ") ? l : `kagura-memory ${l}`}`)].join("\n");
}

/** `-c, --context-id TEXT` — how click lays out an option's forms. */
function renderFlag(flag: FlagSpec): string {
  // A short-only option must not advertise a long form the parser will
  // reject; `-k` is declared without one in Python.
  const forms =
    flag.shortOnly === true
      ? `-${flag.short}`
      : flag.short === undefined
        ? `--${flag.name}`
        : `-${flag.short}, --${flag.name}`;
  if (flag.type !== "value" && flag.type !== "multiple" && flag.type !== "optional") return forms;
  // Click shows an optional value's metavar as declared, brackets and all
  // (`--agents-md [PATH]`), and `TEXT` when none is.
  const metavar = flag.range ? `${flag.range.integer ? "INTEGER" : "FLOAT"} RANGE` : flag.metavar ?? "TEXT";
  return `${forms} ${metavar}`;
}

/** Render `--help` for one command from its own declaration. */
export function renderHelp(path: string, command: Command): string {
  const lines = [formatUsage(path, `[OPTIONS]${command.args ? ` ${command.args}` : ""}`), ""];
  if (command.summary) lines.push(formatParagraphs(command.summary), "");
  if (command.description) lines.push(formatParagraphs(command.description), "");
  lines.push("Options:", renderOptions(command.spec.flags));
  return lines.join("\n");
}

function renderOptions(flags: readonly FlagSpec[]): string {
  const rows: [string, string][] = flags.filter(f => f.hidden !== true).map(flag => {
    const annotations = [
      ...(flag.defaultLabel === undefined ? [] : [`default: ${flag.defaultLabel}`]),
      ...(flag.range === undefined ? [] : [flag.range.rangeLabel]),
      ...(flag.required === true ? ["required"] : []),
    ];
    const suffix = annotations.length === 0 ? "" : `  [${annotations.join("; ")}]`;
    return [renderFlag(flag), `${flag.help ?? ""}${suffix}`];
  });
  rows.push(["--help", "Show this message and exit."]);
  return formatTable(rows);
}

/** Click's default short help: first sentence, shortened at word boundaries. */
function shortHelp(text: string, limit: number): string {
  const words = text.split("\n\n")[0]!.trim().replace(/^\x08\s*/, "").split(/\s+/);
  let used = 0;
  for (let i = 0; i < words.length; i++) {
    used += [...words[i]!].length + (i > 0 ? 1 : 0);
    if (used > limit || (used === limit && i < words.length - 1 && !words[i]!.endsWith("."))) {
      let end = i;
      while (end > 0 && [...words.slice(0, end).join(" ")].length + 3 > limit) end--;
      return words.slice(0, end).join(" ") + "...";
    }
    if (words[i]!.endsWith(".")) return words.slice(0, i + 1).join(" ");
  }
  return words.join(" ");
}

/**
 * Render the listing for a group (or the root), click-style: the summary,
 * the group's `description` paragraphs when it has any, then the commands.
 */
export function renderGroupHelp(
  path: string,
  summary: string,
  entries: Record<string, Command | CommandGroup>,
  description?: string,
  flags: readonly FlagSpec[] = [],
): string {
  const names = Object.keys(entries).sort();
  const limit = HELP_WIDTH - 6 - Math.max(0, ...names.map(n => [...n].length));
  const lines = [formatUsage(path, "[OPTIONS] COMMAND [ARGS]..."), "", formatParagraphs(summary), ""];
  if (description) lines.push(formatParagraphs(description), "");
  lines.push("Options:", renderOptions(flags), "", "Commands:");
  lines.push(formatTable(names.map(name => [name, shortHelp(entries[name]!.summary, limit)])));
  return lines.join("\n");
}

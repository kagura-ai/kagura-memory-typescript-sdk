/**
 * The command registry shape and the small helpers every command needs.
 *
 * A command is data plus one `run` function, so `run.ts` can dispatch and
 * render help generically instead of carrying a switch with 61 arms.
 */

import { CliUsageError, flagLabel } from "./parse.js";
import type { FlagSpec, ParseSpec, ParsedArgs } from "./parseArgs.js";
import type { ClientCommandContext } from "./runClientCommand.js";

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
  run: (deps: CommandDeps, args: ParsedArgs) => Promise<number>;
}

export interface CommandGroup {
  summary: string;
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
    throw new CliUsageError(`Missing option ${flagLabel(flag)}.`);
  }
  return value;
}

/** Read a required positional, or raise click's `Missing argument` message. */
export function requireArg(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw new CliUsageError(`Missing argument '${name}'.`);
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

const INDENT = "  ";

/** `-c, --context-id TEXT` — how click lays out an option's forms. */
function renderFlag(flag: FlagSpec): string {
  // A short-only option must not advertise a long form the parser will
  // reject; `-k` is declared without one in Python.
  const forms =
    flag.shortOnly === true
      ? `-${flag.short}`
      : flag.short === undefined
        ? `    --${flag.name}`
        : `-${flag.short}, --${flag.name}`;
  if (flag.type !== "value") return forms;
  return `${forms} ${flag.metavar ?? "TEXT"}`;
}

/** Render `--help` for one command from its own declaration. */
export function renderHelp(path: string, command: Command): string {
  const lines = [`Usage: ${path} [OPTIONS]${command.args ? ` ${command.args}` : ""}`, ""];
  if (command.summary) lines.push(`  ${command.summary}`, "");
  if (command.description) lines.push(command.description, "");

  const rendered = command.spec.flags.map((f) => [renderFlag(f), f] as const);
  const width = Math.max(24, ...rendered.map(([text]) => text.length + 2));

  lines.push("Options:");
  for (const [text, flag] of rendered) {
    const suffix = flag.defaultLabel === undefined ? "" : `  [default: ${flag.defaultLabel}]`;
    const help = `${flag.help ?? ""}${suffix}`;
    lines.push(`${INDENT}${text.padEnd(width)}${help}`.trimEnd());
  }
  lines.push(`${INDENT}${"--help".padEnd(width)}Show this message and exit.`);
  return lines.join("\n");
}

/** Render the listing for a group (or the root), click-style. */
export function renderGroupHelp(
  path: string,
  summary: string,
  entries: Record<string, Command | CommandGroup>,
): string {
  const names = Object.keys(entries).sort();
  const width = Math.max(10, ...names.map((n) => n.length + 2));
  const lines = [`Usage: ${path} [OPTIONS] COMMAND [ARGS]...`, "", `  ${summary}`, "", "Commands:"];
  for (const name of names) {
    lines.push(`${INDENT}${name.padEnd(width)}${entries[name]!.summary}`);
  }
  return lines.join("\n");
}

/**
 * `-v/--verbose` and `--progress` on `files upload` and `resource import`
 * — the port of `_resolve_progress_logger` in the Python CLI's `cli.py`
 * and of the two renderers of its `VerboseLogger` (`logger.py`).
 *
 * Everything goes to stderr, one line per event, so stdout stays the
 * result JSON whatever the flags say:
 *
 *   json  {"v": 1, "ts": "…Z", "stage": "reserve", "kind": "action", "msg": "Reserving upload", …}
 *   rich  → Reserving upload report.pdf (1234 bytes)
 *
 * `json` is the Python CLI's NDJSON byte for byte, `ts` aside. `rich` is
 * the text Rich writes to a stderr that is not a terminal, and nothing
 * else: no colour even on a terminal, no wrapping at its width, and no
 * markup, so `report[bold].pdf` prints as written (Rich reads it as
 * markup, and a `[/x]` in an error message makes it raise instead).
 */

import { formatJsonLine } from "./output.js";
import { parseChoice } from "./parse.js";
import type { FlagSpec, ParsedArgs } from "./parseArgs.js";
import {
  PROGRESS_SCHEMA_VERSION,
  type ProgressCallback,
  type ProgressEvent,
} from "../progress.js";
import { pyStr } from "../python.js";

export const PROGRESS_CHOICES = ["rich", "json", "none"] as const;
export type ProgressFormat = (typeof PROGRESS_CHOICES)[number];

/** Declared last on both commands, as in Python, so `--help` lists them last. */
export const VERBOSE_FLAG: FlagSpec = {
  name: "verbose",
  short: "v",
  type: "count",
  help: "Increase verbosity (repeatable: -v, -vv, -vvv).",
};

export const PROGRESS_FLAG: FlagSpec = {
  name: "progress",
  type: "value",
  metavar: "[rich|json|none]",
  help:
    "Progress output format. Default: rich if -v given, none otherwise. " +
    "Use json for AI agents / scripts.",
};

/**
 * `--progress`, converted as click converts it: a `Choice` declared
 * `case_sensitive=False`, so `JSON` reads `json`. An empty value is not
 * "unset": `--progress=` is refused like any other non-choice.
 *
 * Call it with the command's other option conversions, before its
 * arguments: click converts every option first, so `files upload
 * missing.txt --progress bad` reports `--progress`, not the path.
 */
export function parseProgress(args: ParsedArgs): ProgressFormat | undefined {
  const raw = args.values[PROGRESS_FLAG.name];
  return raw === undefined
    ? undefined
    : parseChoice(PROGRESS_FLAG, raw, PROGRESS_CHOICES, { caseInsensitive: true });
}

/** How progress is shown: a renderer, and for `rich` the `-v` level it filters by. */
export interface ProgressMode {
  format: "rich" | "json";
  level: number;
}

/**
 * The Python SDK's #108 precedence rule, cell for cell: an explicit
 * `--progress` wins; `none` is silent even with `-v`; omitted, `-v` means
 * `rich` and no `-v` means silent. The level is `-v`'s count, at least 1
 * once anything is shown; `json` ignores it and emits every kind.
 *
 * @returns `null` for silent.
 */
export function progressMode(
  verbose: number,
  progress: ProgressFormat | undefined,
): ProgressMode | null {
  if (progress === "none") return null;
  if (progress !== undefined) return { format: progress, level: Math.max(1, verbose) };
  return verbose >= 1 ? { format: "rich", level: verbose } : null;
}

/**
 * The callback that renders progress for `-v` and `--progress`, or
 * `undefined` for silent — which is what the SDK takes as "no events".
 *
 * @param now Injectable so a test can pin `ts`.
 */
export function resolveProgress(
  verbose: number,
  progress: ProgressFormat | undefined,
  writeError: (line: string) => void,
  now: () => Date = () => new Date(),
): ProgressCallback | undefined {
  const mode = progressMode(verbose, progress);
  if (mode === null) return undefined;
  return (event) => {
    const line = mode.format === "json" ? ndjsonLine(event, now()) : textLine(event, mode.level);
    if (line === null) return;
    try {
      writeError(line);
    } catch {
      // A closed stderr must not fail the upload it was reporting on.
    }
  };
}

/**
 * Python's `_emit_json`: `v`, `ts`, `stage`, `kind`, then `msg` and
 * `detail` only when non-empty, on one line with `json.dumps`'s `", "` and
 * `": "` separators and non-ASCII written as is. `ts` is UTC to the
 * millisecond with a `Z`, which is exactly `toISOString()`.
 */
export function ndjsonLine(event: ProgressEvent, at: Date): string {
  const line: Record<string, unknown> = {
    v: PROGRESS_SCHEMA_VERSION,
    ts: at.toISOString(),
    stage: event.stage || "unknown",
    kind: event.kind,
  };
  if (event.msg) line.msg = event.msg;
  if (event.detail !== undefined && Object.keys(event.detail).length > 0) line.detail = event.detail;
  return formatJsonLine(line, { ensureAscii: false });
}

/**
 * The line Rich prints for an event on a non-terminal stderr, or `null`
 * when `level` filters it out. Errors always show. `detail` and `debug`
 * are one line each here, where Rich draws the debug payload in a panel;
 * neither command emits them.
 */
export function textLine(event: ProgressEvent, level: number): string | null {
  const msg = event.msg ?? "";
  switch (event.kind) {
    case "action": {
      if (level < 1) return null;
      const desc = event.detail?.desc;
      return desc ? `→ ${msg} ${pyStr(desc)}` : `→ ${msg}`;
    }
    case "detail":
      return level < 2 ? null : `  • ${msg}: ${pyStr(event.detail?.value)}`;
    case "debug": {
      if (level < 3) return null;
      const data = formatJsonLine(event.detail?.data ?? null, { ensureAscii: false });
      return `  ${msg}: ${data}`;
    }
    case "success":
      return level < 1 ? null : `✓ ${msg}`;
    case "warning":
      return level < 1 ? null : `⚠ ${msg}`;
    case "error":
      return `✗ ${msg}`;
    default:
      return null;
  }
}

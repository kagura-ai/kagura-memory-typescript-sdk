/**
 * `-v` / `--progress` resolution and rendering — `_resolve_progress_logger`
 * and `VerboseLogger` in the Python SDK. The resolution table is the one
 * `tests/test_logger_progress.py` pins; the NDJSON lines are the ones its
 * `_emit_json` writes, and the text lines what Rich prints to a stderr that
 * is not a terminal.
 */

import { describe, expect, it } from "vitest";

import {
  ndjsonLine,
  parseProgress,
  PROGRESS_FLAG,
  progressMode,
  resolveProgress,
  textLine,
  VERBOSE_FLAG,
  type ProgressFormat,
} from "../../src/cli/progress.js";
import { CliUsageError } from "../../src/cli/parse.js";
import { parseArgs } from "../../src/cli/parseArgs.js";
import type { ProgressEvent } from "../../src/progress.js";

const AT = new Date("2026-09-24T15:28:39.129Z");

describe("progressMode: the #108 precedence table", () => {
  it.each<[number, ProgressFormat | undefined, ReturnType<typeof progressMode>]>([
    [0, undefined, null],
    [1, undefined, { format: "rich", level: 1 }],
    [2, undefined, { format: "rich", level: 2 }],
    [0, "rich", { format: "rich", level: 1 }],
    [2, "rich", { format: "rich", level: 2 }],
    [0, "json", { format: "json", level: 1 }],
    [2, "json", { format: "json", level: 2 }],
    [1, "none", null],
  ])("-v x%i with --progress %s", (verbose, progress, mode) => {
    expect(progressMode(verbose, progress)).toEqual(mode);
  });

  it("is silent with --progress none even at -vvv", () => {
    expect(resolveProgress(3, "none", () => {})).toBeUndefined();
  });
});

describe("parseProgress: click.Choice(case_sensitive=False)", () => {
  const spec = { flags: [VERBOSE_FLAG, PROGRESS_FLAG] };
  const parse = (argv: string[]) => parseProgress(parseArgs(argv, spec));

  it("reads each choice, in any case, as the declared spelling", () => {
    expect(parse(["--progress", "json"])).toBe("json");
    expect(parse(["--progress", "JSON"])).toBe("json");
    expect(parse(["--progress=Rich"])).toBe("rich");
    expect(parse(["--progress", "none"])).toBe("none");
    expect(parse([])).toBeUndefined();
  });

  it("takes the last occurrence", () => {
    expect(parse(["--progress", "rich", "--progress", "json"])).toBe("json");
  });

  it.each([
    ["auto", "Invalid value for '--progress': 'auto' is not one of 'rich', 'json', 'none'."],
    // An empty value is a value, not "unset".
    ["", "Invalid value for '--progress': '' is not one of 'rich', 'json', 'none'."],
    // The release notes of python-sdk v0.16.0 advertised this one.
    ["ndjson", "Invalid value for '--progress': 'ndjson' is not one of 'rich', 'json', 'none'."],
  ])("refuses %j (exit 2)", (value, message) => {
    expect(() => parse([`--progress=${value}`])).toThrow(CliUsageError);
    expect(() => parse([`--progress=${value}`])).toThrow(message);
  });

  it("counts -v as click's count=True does", () => {
    const parsed = parseArgs(["-vv", "--verbose", "-v"], spec);
    expect(parsed.counts.verbose).toBe(4);
  });
});

describe("ndjsonLine: _emit_json", () => {
  it.each<[ProgressEvent, string]>([
    [
      { stage: "reserve", kind: "action", msg: "Reserving upload", detail: { desc: "日本語.pdf (5 bytes)" } },
      '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "reserve", "kind": "action", "msg": "Reserving upload", "detail": {"desc": "日本語.pdf (5 bytes)"}}',
    ],
    [
      { stage: "upload", kind: "action", msg: "Uploading to object store" },
      '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "upload", "kind": "action", "msg": "Uploading to object store"}',
    ],
    [
      {
        stage: "complete",
        kind: "success",
        msg: "Dedup hit — existing file returned",
        detail: { file_id: "abc", deduped: true },
      },
      '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "complete", "kind": "success", "msg": "Dedup hit — existing file returned", "detail": {"file_id": "abc", "deduped": true}}',
    ],
    [
      {
        stage: "complete",
        kind: "error",
        msg: 'Upload failed: x\ty"z',
        detail: { reserved_file_id: null, uploaded: false, confirm_started: false, confirmed: false },
      },
      '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "complete", "kind": "error", "msg": "Upload failed: x\\ty\\"z", "detail": {"reserved_file_id": null, "uploaded": false, "confirm_started": false, "confirmed": false}}',
    ],
    // No stage reads "unknown"; an empty msg and an empty detail are left out.
    [{ stage: "", kind: "action" }, '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "unknown", "kind": "action"}'],
    [
      { stage: "", kind: "success", msg: "ok", detail: {} },
      '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "unknown", "kind": "success", "msg": "ok"}',
    ],
    [
      { stage: "s", kind: "error", msg: "" },
      '{"v": 1, "ts": "2026-09-24T15:28:39.129Z", "stage": "s", "kind": "error"}',
    ],
  ])("writes %j as Python does", (event, line) => {
    expect(ndjsonLine(event, AT)).toBe(line);
  });

  it("keeps a multi-line message on one line", () => {
    const line = ndjsonLine({ stage: "complete", kind: "error", msg: "HTTP 403 — x\n  api_key source: env" }, AT);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).msg).toBe("HTTP 403 — x\n  api_key source: env");
  });
});

describe("textLine: Rich on a non-terminal stderr", () => {
  it.each<[ProgressEvent, number, string | null]>([
    [{ stage: "reserve", kind: "action", msg: "Reserving upload", detail: { desc: "a.pdf (3 bytes)" } }, 1, "→ Reserving upload a.pdf (3 bytes)"],
    [{ stage: "upload", kind: "action", msg: "Uploading to object store" }, 1, "→ Uploading to object store"],
    [{ stage: "complete", kind: "success", msg: "Upload complete", detail: { file_id: "x" } }, 1, "✓ Upload complete"],
    [{ stage: "s", kind: "warning", msg: "careful" }, 1, "⚠ careful"],
    [{ stage: "complete", kind: "error", msg: "Upload failed: boom" }, 1, "✗ Upload failed: boom"],
    // An error shows at any level.
    [{ stage: "complete", kind: "error", msg: "boom" }, 0, "✗ boom"],
    [{ stage: "s", kind: "action", msg: "a" }, 0, null],
    // Details from -vv, debug payloads from -vvv; one line each.
    [{ stage: "s", kind: "detail", msg: "key", detail: { value: 3 } }, 1, null],
    [{ stage: "s", kind: "detail", msg: "key", detail: { value: 3 } }, 2, "  • key: 3"],
    [{ stage: "s", kind: "detail", msg: "key", detail: { value: null } }, 2, "  • key: None"],
    [{ stage: "s", kind: "debug", msg: "payload", detail: { data: { a: 1 } } }, 2, null],
    [{ stage: "s", kind: "debug", msg: "payload", detail: { data: { a: 1 } } }, 3, '  payload: {"a": 1}'],
    // Verbatim: Rich would read `[bold]` as markup and print `report.pdf`.
    [{ stage: "reserve", kind: "action", msg: "Reserving upload", detail: { desc: "report[bold].pdf (1 bytes)" } }, 1, "→ Reserving upload report[bold].pdf (1 bytes)"],
    [{ stage: "complete", kind: "error", msg: "Upload failed: see [/api/v1/files]" }, 1, "✗ Upload failed: see [/api/v1/files]"],
  ])("renders %j at level %i", (event, level, line) => {
    expect(textLine(event, level)).toBe(line);
  });
});

describe("resolveProgress", () => {
  it("renders NDJSON with a fresh ts per event", () => {
    const lines: string[] = [];
    let tick = 0;
    const sink = resolveProgress(0, "json", (l) => void lines.push(l), () => new Date(AT.getTime() + tick++));
    sink!({ stage: "a", kind: "action" });
    sink!({ stage: "b", kind: "success" });
    expect(lines.map((l) => JSON.parse(l).ts)).toEqual([
      "2026-09-24T15:28:39.129Z",
      "2026-09-24T15:28:39.130Z",
    ]);
  });

  it("emits every kind as JSON whatever the level, as consumers filter", () => {
    const lines: string[] = [];
    const sink = resolveProgress(0, "json", (l) => void lines.push(l), () => AT);
    sink!({ stage: "s", kind: "detail", msg: "k", detail: { value: 1 } });
    sink!({ stage: "s", kind: "debug", msg: "d", detail: { data: 1 } });
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["detail", "debug"]);
  });

  it("filters text by the -v level", () => {
    const lines: string[] = [];
    const sink = resolveProgress(1, undefined, (l) => void lines.push(l));
    sink!({ stage: "s", kind: "detail", msg: "k", detail: { value: 1 } });
    sink!({ stage: "s", kind: "action", msg: "go" });
    expect(lines).toEqual(["→ go"]);
  });

  it("never throws, even when stderr does", () => {
    const sink = resolveProgress(1, "rich", () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    expect(() => sink!({ stage: "s", kind: "error", msg: "x" })).not.toThrow();
  });
});

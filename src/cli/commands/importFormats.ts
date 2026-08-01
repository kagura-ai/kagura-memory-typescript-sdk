/**
 * Record readers for `kagura-memory resource import`.
 *
 * Python leans on `csv.DictReader`; there is no such thing in Node and
 * this package takes no runtime dependencies, so the CSV reader is
 * hand-written to RFC 4180: quoted fields, `""` as an escaped quote, and
 * embedded commas and newlines inside quotes. A naive `line.split(",")`
 * silently corrupts any row containing a quoted comma, which is most real
 * exports.
 */

import { CliUsageError, quote } from "../parse.js";

export type ImportFormat = "auto" | "csv" | "json" | "jsonl";

/** Split CSV text into rows of raw fields. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // `""` inside a quoted field is one literal quote.
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      endField();
      started = true;
      continue;
    }
    if (ch === "\r") {
      // Normalize CRLF; a bare CR is treated as a line break too.
      if (text[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
    started = true;
  }
  // A trailing newline must not produce a phantom empty row, but a final
  // row without one must not be dropped.
  if (started || field !== "" || row.length > 0) endRow();
  return rows;
}

/** CSV text to objects, keyed by the header row — `csv.DictReader`. */
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (header === undefined || header.length === 0) return [];
  return rows.map((cells) => {
    const record: Record<string, unknown> = {};
    header.forEach((name, i) => {
      // DictReader leaves missing trailing cells as None; an empty string
      // is closer to what the server stores and avoids a null payload key.
      record[name] = cells[i] ?? "";
    });
    return record;
  });
}

/** One JSON object per line, blank lines skipped. */
export function parseJsonl(text: string, label: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new CliUsageError(
        `Invalid JSON on line ${index + 1} of ${label}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    out.push(asRecord(parsed, `line ${index + 1} of ${label}`));
  });
  return out;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError(`Expected a JSON object at ${where}.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Guess the format from the content.
 *
 * Content rather than filename, because `--file -` (stdin, the default)
 * has no name to go on.
 */
export function detectFormat(text: string): Exclude<ImportFormat, "auto"> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("{")) {
    // One object is JSON; several newline-separated objects are JSONL.
    const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
    return firstLine.trimEnd().endsWith("}") && /\n\s*\{/.test(trimmed) ? "jsonl" : "json";
  }
  return "csv";
}

/** Read `--file` content into records, honouring `--format`. */
export function parseRecords(
  text: string,
  format: ImportFormat,
  label: string,
): Record<string, unknown>[] {
  const resolved = format === "auto" ? detectFormat(text) : format;
  if (resolved === "csv") return parseCsv(text);
  if (resolved === "jsonl") return parseJsonl(text, label);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliUsageError(
      `Invalid JSON in ${quote(label)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (Array.isArray(parsed)) return parsed.map((row, i) => asRecord(row, `index ${i} of ${label}`));
  // A single object is one record, not an error — the same courtesy
  // DictReader-style importers usually extend.
  return [asRecord(parsed, label)];
}

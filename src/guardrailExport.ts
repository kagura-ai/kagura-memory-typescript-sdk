/**
 * The guardrail export block in an always-loaded file such as `AGENTS.md`
 * (port of `_guardrail_export.py`).
 *
 * `guardrails digest --out` and `setup codex|hermes|openclaw --agents-md`
 * both put memory-cloud's export block (`GET /api/v1/memory/guardrails/
 * digest`) into a file through here, so the two can never disagree about
 * what they replace. The marker rules are the server's Codex cloud recipe
 * (memory-cloud docs/mcp-clients.md), which the Python CLI follows too, so
 * a file written by any of the three is maintained by the others.
 *
 * @internal Not exported from the package entry point; the Python module
 * is private as well.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { pyStrip } from "./pyCompat.js";

/** Start of the begin marker line; the rest of that line names the context and version. */
export const GUARDRAIL_BEGIN_PREFIX = "<!-- kagura-memory:guardrails begin";
/** The end marker line, exactly. */
export const GUARDRAIL_END_MARKER = "<!-- kagura-memory:guardrails end -->";

/** What {@link writeGuardrailBlock} did to the file. */
export type GuardrailBlockStatus = "written" | "unchanged" | "removed";

/**
 * A refusal to touch the file: the fetched block or the file's own block
 * is malformed, or the file is not UTF-8.
 *
 * Python raises `ValueError` for exactly these, and its CLI reports them as
 * `<path>: <message>; left unchanged`, unlike an I/O error, which keeps its
 * own text. The separate class lets a caller make the same distinction.
 */
export class GuardrailBlockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuardrailBlockError";
  }
}

/**
 * Indexes of the begin and end marker lines in `lines`.
 *
 * Line-based on purpose. Python's patterns are `re.M` anchors, which
 * break lines at `\n` only; JavaScript's `m` flag also breaks at `\r`,
 * `\u2028` and `\u2029`, so the same regexes would find markers Python
 * does not (a lone `\r` survives the CRLF normalization below).
 */
function markerLines(lines: readonly string[]): { begins: number[]; ends: number[] } {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith(GUARDRAIL_BEGIN_PREFIX)) begins.push(i);
    else if (line === GUARDRAIL_END_MARKER) ends.push(i);
  });
  return { begins, ends };
}

/** Character offset of line `index` in the text `lines` was split from. */
function lineOffset(lines: readonly string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i]!.length + 1;
  return offset;
}

/** True when `text` has a guardrail begin marker line (a complete block or not). */
export function hasGuardrailBlock(text: string): boolean {
  return markerLines(text.split("\n")).begins.length > 0;
}

/**
 * Return `text` with the guardrail export `block` put in place.
 *
 * The block replaces an earlier one in place, or is appended after a
 * blank line. An empty `block` (the context has no tool guardrails)
 * removes an earlier block and the blank line before it, and never creates
 * one: a file never keeps a guardrail the server no longer serves.
 *
 * @throws GuardrailBlockError when the fetched block does not have exactly
 *   one begin line followed by one end line, or when `text` holds more than
 *   one block or a broken one (unterminated, or its end before its begin),
 *   which is fixed by hand rather than guessed at.
 */
export function spliceGuardrailBlock(text: string, block: string): string {
  const fetched = pyStrip(block);
  if (fetched) {
    const { begins, ends } = markerLines(fetched.split("\n"));
    if (begins.length !== 1 || ends.length !== 1) {
      throw new GuardrailBlockError(
        "fetched block does not have exactly one begin and one end marker line",
      );
    }
    // Python counts the markers but not their order, so it would write a
    // block its next run refuses as broken. The server never sends one;
    // refuse it here rather than write a file that locks itself.
    if (ends[0]! < begins[0]!) {
      throw new GuardrailBlockError("fetched block has its end marker line before its begin one");
    }
  }

  const lines = text.split("\n");
  const { begins, ends } = markerLines(lines);
  // Python's span is the first begin line through the nearest end line
  // after it; the count checks below leave it relevant only for one pair.
  const endAfter = begins.length > 0 ? ends.find((i) => i > begins[0]!) : undefined;
  if (
    begins.length > 1 ||
    begins.length !== ends.length ||
    (begins.length > 0 && endAfter === undefined)
  ) {
    throw new GuardrailBlockError(
      "the file has more than one guardrail block, or a broken one; fix it by hand",
    );
  }

  if (endAfter !== undefined) {
    let start = lineOffset(lines, begins[0]!);
    // The span takes the end line's newline too, when there is one.
    const newline = endAfter < lines.length - 1 ? 1 : 0;
    const end = lineOffset(lines, endAfter) + GUARDRAIL_END_MARKER.length + newline;
    if (!fetched) {
      // Drop the blank line that separated the block from the text above.
      // A lone newline ends the line above (the block may sit right under
      // the user's own heading), so it stays.
      if (text.slice(0, start).endsWith("\n\n")) start -= 1;
      return text.slice(0, start) + text.slice(end);
    }
    return `${text.slice(0, start)}${fetched}\n${text.slice(end)}`;
  }
  if (!fetched) return text;
  if (!text) return `${fetched}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${fetched}\n`;
}

/**
 * Python's non-strict `os.path.realpath`: every symlink resolved, and a
 * path that does not exist is still answered.
 *
 * Node's `realpathSync` throws on a missing file, and following a
 * dangling link matters here: `AGENTS.md -> CLAUDE.md` with no
 * `CLAUDE.md` yet must create `CLAUDE.md` and keep the link. Components
 * are walked in order so `..` applies to where a link actually led, as
 * Python's walk does; a link loop stops resolving where it loops.
 *
 * `p` is for tests: `path.win32` checks the Windows path rules on any OS.
 */
export function realPath(input: string, p: path.PlatformPath = path): string {
  const seen = new Map<string, string | null>();
  const splitter = p.sep === "\\" ? /[\\/]/ : "/";

  function join(base: string, rest: string): { resolved: string; ok: boolean } {
    let current = base;
    let remaining = rest;
    // A rooted path starts over from its root: `/` or `C:\`, and for a
    // Windows drive-relative `C:AGENTS.md` that drive's working directory,
    // as Python's abspath reads it. Joined under `base`, `C:AGENTS.md`
    // would be one name with a colon: an NTFS alternate data stream.
    const root = p.parse(remaining).root;
    if (root) {
      current = p.resolve(root);
      remaining = remaining.slice(root.length);
    }
    const names = remaining.split(splitter);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (!name || name === ".") continue;
      if (name === "..") {
        current = p.dirname(current);
        continue;
      }
      const next = p.join(current, name);
      let isLink = false;
      try {
        isLink = fs.lstatSync(next).isSymbolicLink();
      } catch {
        // Missing: keep the name as written, as Python does.
      }
      if (!isLink) {
        current = next;
        continue;
      }
      if (seen.has(next)) {
        const known = seen.get(next);
        if (known !== null && known !== undefined) {
          current = known;
          continue;
        }
        return { resolved: p.join(next, ...names.slice(i + 1)), ok: false };
      }
      seen.set(next, null);
      let target: string;
      try {
        target = fs.readlinkSync(next);
      } catch {
        current = next;
        continue;
      }
      const inner = join(current, target);
      if (!inner.ok) {
        return { resolved: p.join(inner.resolved, ...names.slice(i + 1)), ok: false };
      }
      seen.set(next, inner.resolved);
      current = inner.resolved;
    }
    return { resolved: current, ok: true };
  }

  return join(process.cwd(), input).resolved;
}

/** `Path.exists()`: false for a missing path, re-throwing any other stat failure. */
function pathExists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EBADF") {
      return false;
    }
    throw e;
  }
}

/**
 * Strict UTF-8, with a BOM kept as `\ufeff` — Python's `bytes.decode("utf-8")`.
 *
 * The default `TextDecoder` drops a BOM and `Buffer.toString` replaces bad
 * bytes silently; either would rewrite a file this module only meant to
 * splice. The BOM stays in the text, so a file starting with one directly
 * before the begin marker reads as broken, as it does in Python: the two
 * CLIs agree about every file.
 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    throw new GuardrailBlockError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/** `tempfile.mkstemp`'s name alphabet, for the same `.<name>.XXXXXXXX` temp names. */
const TEMP_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";

/** Create `<dir>/<prefix><8 random chars>` exclusively at 0600, like `mkstemp`. */
function createTempFile(dir: string, prefix: string): { fd: number; tmp: string } {
  for (let attempt = 0; ; attempt++) {
    const random = crypto.randomBytes(8);
    const suffix = Array.from(random, (b) => TEMP_CHARS[b % TEMP_CHARS.length]).join("");
    const tmp = path.join(dir, `${prefix}${suffix}`);
    try {
      return { fd: fs.openSync(tmp, "wx", 0o600), tmp };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw e;
    }
  }
}

/**
 * Replace `target` with `data` atomically, keeping its permission bits.
 *
 * The temp file sits next to the target so the rename stays on one
 * filesystem, and it is removed again on any failure: a failed write
 * leaves the original untouched and no `.AGENTS.md.*` file behind.
 */
function replaceAtomically(target: string, data: string): void {
  const { fd, tmp } = createTempFile(path.dirname(target), `.${path.basename(target)}.`);
  let open = true;
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.closeSync(fd);
    open = false;
    fs.chmodSync(tmp, fs.statSync(target).mode & 0o7777);
    fs.renameSync(tmp, target);
  } catch (e) {
    if (open) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed; the unlink below is what matters.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Gone already, or never renamed away: nothing left to clean.
    }
    throw e;
  }
}

/**
 * Splice `block` into the file at `filePath` and report what happened.
 *
 * `"unchanged"` when the file already carries this block: the begin marker
 * embeds `tool_triggered_version`, so an unchanged guardrail set rewrites
 * nothing (the mtime stays, and a missing file is not created for an empty
 * set). `"removed"` when an empty digest dropped an earlier block, else
 * `"written"`.
 *
 * A symlink (`AGENTS.md -> CLAUDE.md`) is followed, so the link survives,
 * and an existing file is replaced atomically with its mode kept. A new
 * file is created with the default mode; its parent directory must exist.
 *
 * Line endings are the file's own, on every platform: a file with any CRLF
 * is written back with CRLF, anything else (and a new file) with LF, so a
 * write changes the block and not every line of the file.
 *
 * @throws GuardrailBlockError for a malformed block or file, or one that is
 *   not UTF-8; Node's own error for an I/O failure.
 */
export function writeGuardrailBlock(filePath: string, block: string): GuardrailBlockStatus {
  const target = realPath(filePath);
  const exists = pathExists(target);
  const raw = exists ? decodeUtf8(fs.readFileSync(target)) : "";
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = raw.split("\r\n").join("\n");
  const next = spliceGuardrailBlock(text, block);
  if (next === text) return "unchanged";
  const data = newline === "\n" ? next : next.split("\n").join(newline);
  if (exists) replaceAtomically(target, data);
  else fs.writeFileSync(target, data, "utf8");
  return pyStrip(block) ? "written" : "removed";
}

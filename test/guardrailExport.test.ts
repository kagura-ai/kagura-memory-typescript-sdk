/**
 * The AGENTS.md guardrail export splice (`src/guardrailExport.ts`).
 *
 * The splice vectors and the file tests are ported from the Python SDK's
 * tests/test_guardrails.py (the "AGENTS.md block splice" section and the
 * `guardrails digest --out` file tests), so both CLIs are held to the same
 * cases; the rest pin what the port has to do differently in JavaScript.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GuardrailBlockError,
  hasGuardrailBlock,
  realPath,
  spliceGuardrailBlock,
  writeGuardrailBlock,
} from "../src/guardrailExport.js";

// Python monkeypatches os.replace to fail; ESM namespaces are read-only, so
// the rename is swapped at module level instead, failing only on request.
const failRename = vi.hoisted(() => ({ message: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (failRename.message !== null) throw new Error(failRename.message);
      actual.renameSync(from, to);
    },
  };
});

const CTX = "11111111-2222-3333-4444-555555555555";
const VERSION = "3f9c1a7b2d4e6f80";
const END = "<!-- kagura-memory:guardrails end -->";
const EXPORT_BLOCK =
  `<!-- kagura-memory:guardrails begin context=${CTX} tool_triggered_version=${VERSION} -->\n` +
  "- (bbbbbbbb) gh pr merge --delete-branch closes the child PR\n" +
  `${END}\n`;
const NEW_BLOCK = EXPORT_BLOCK.replace(VERSION, "0123456789abcdef").replace(
  "closes the child PR",
  "closes the stacked child PR",
);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-export-"));
  failRename.message = null;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("spliceGuardrailBlock", () => {
  it("appends to a file without a block", () => {
    const text = "# Project\n\nRules.\n";
    expect(spliceGuardrailBlock(text, EXPORT_BLOCK)).toBe(text + "\n" + EXPORT_BLOCK);
  });

  it("adds a missing trailing newline before the block", () => {
    expect(spliceGuardrailBlock("# P", EXPORT_BLOCK)).toBe("# P\n\n" + EXPORT_BLOCK);
  });

  it("writes only the block into an empty file", () => {
    expect(spliceGuardrailBlock("", EXPORT_BLOCK)).toBe(EXPORT_BLOCK);
  });

  it("replaces an existing block in place", () => {
    const text = "# Project\n\n" + EXPORT_BLOCK + "\n## After\n";
    expect(spliceGuardrailBlock(text, NEW_BLOCK)).toBe("# Project\n\n" + NEW_BLOCK + "\n## After\n");
  });

  it("is the identity for the same block", () => {
    const text = "# Project\n\n" + EXPORT_BLOCK;
    expect(spliceGuardrailBlock(text, EXPORT_BLOCK)).toBe(text);
  });

  it("removes the block and the blank line before it for an empty digest", () => {
    expect(spliceGuardrailBlock("# Project\n\n" + EXPORT_BLOCK, "")).toBe("# Project\n");
  });

  it.each([
    ["under-heading", "## Guardrails\n", "## Next section\nbody\n"],
    ["under-heading-at-eof", "## Guardrails\n", ""],
    ["file-start", "", "# Project\n"],
    ["blank-lines-around", "# P\n\n", "\n## After\n"],
  ])("keeps the line above intact on removal (%s)", (_id, before, after) => {
    // Only a blank line separating the block goes with it; the newline
    // ending the line above (e.g. the user's own heading) stays.
    const expected = (before.endsWith("\n\n") ? before.slice(0, -1) : before) + after;
    expect(spliceGuardrailBlock(before + EXPORT_BLOCK + after, "")).toBe(expected);
  });

  it("removes a block with no trailing newline at the end of the file", () => {
    expect(spliceGuardrailBlock("# P\n\n" + EXPORT_BLOCK.slice(0, -1), "")).toBe("# P\n");
  });

  it("is the identity for an empty digest and no block", () => {
    expect(spliceGuardrailBlock("# Project\n", "")).toBe("# Project\n");
  });

  it("treats a whitespace-only digest as empty", () => {
    expect(spliceGuardrailBlock("# Project\n\n" + EXPORT_BLOCK, " \n\t\n")).toBe("# Project\n");
  });

  it.each([
    ["no-markers", "- (x) no markers\n"],
    ["two-blocks", EXPORT_BLOCK + EXPORT_BLOCK],
    ["no-end", EXPORT_BLOCK.replace(`${END}\n`, "")],
    // Python 0.41.1 refuses it too (python-sdk #285).
    ["end-before-begin", `${END}\n- (x) y\n<!-- kagura-memory:guardrails begin x -->\n`],
  ])("rejects a malformed fetched block (%s)", (_id, block) => {
    expect(() => spliceGuardrailBlock("# Project\n", block)).toThrow(GuardrailBlockError);
    // Recorded from the Python SDK 0.42.0's splice_guardrail_block: one message for every case.
    expect(() => spliceGuardrailBlock("# Project\n", block)).toThrow(
      new GuardrailBlockError(
        "fetched block does not have exactly one begin and one end marker line, in that order",
      ),
    );
  });

  it.each([
    ["two-blocks", "# P\n\n" + EXPORT_BLOCK + "\n" + EXPORT_BLOCK],
    ["unterminated", "# P\n\n" + EXPORT_BLOCK.replace(`${END}\n`, "")],
    ["end-before-begin", `${END}\n# P\n<!-- kagura-memory:guardrails begin x -->\n`],
    ["end-only", `# P\n${END}\n`],
  ])("refuses an ambiguous file (%s)", (_id, text) => {
    expect(() => spliceGuardrailBlock(text, NEW_BLOCK)).toThrow(
      new GuardrailBlockError(
        "the file has more than one guardrail block, or a broken one; fix it by hand",
      ),
    );
  });

  it("breaks lines at \\n only, as Python's re.M does", () => {
    // JavaScript's m flag would also break at \r and \u2028 and find a
    // marker line in each of these; Python finds none.
    for (const sep of ["\r", "\u2028", "\u2029"]) {
      const text = `# P${sep}<!-- kagura-memory:guardrails begin x -->\n`;
      expect(hasGuardrailBlock(text)).toBe(false);
      expect(spliceGuardrailBlock(text, "")).toBe(text);
    }
    // An end line with a stray \r is not the end marker either.
    const stray = `# P\n${EXPORT_BLOCK.replace(END, `${END}\r`)}`;
    expect(() => spliceGuardrailBlock(stray, NEW_BLOCK)).toThrow(/by hand/);
  });
});

describe("hasGuardrailBlock", () => {
  it("finds a begin line anywhere, complete block or not", () => {
    expect(hasGuardrailBlock("# P\n\n" + EXPORT_BLOCK)).toBe(true);
    expect(hasGuardrailBlock("<!-- kagura-memory:guardrails begin\n")).toBe(true);
    expect(hasGuardrailBlock("# P\n" + END + "\n")).toBe(false);
    expect(hasGuardrailBlock("# P <!-- kagura-memory:guardrails begin -->\n")).toBe(false);
  });
});

describe("writeGuardrailBlock", () => {
  it("keeps CRLF line endings, and recognizes the CRLF file as up to date", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "# Title\r\n\r\nLine one\r\nLine two\r\n");

    expect(writeGuardrailBlock(out, EXPORT_BLOCK)).toBe("written");
    expect(fs.readFileSync(out, "utf8")).toBe(
      "# Title\r\n\r\nLine one\r\nLine two\r\n\r\n" + EXPORT_BLOCK.replace(/\n/g, "\r\n"),
    );
    expect(writeGuardrailBlock(out, EXPORT_BLOCK)).toBe("unchanged");
    // ...and a removal keeps CRLF too.
    expect(writeGuardrailBlock(out, "")).toBe("removed");
    expect(fs.readFileSync(out, "utf8")).toBe("# Title\r\n\r\nLine one\r\nLine two\r\n");
  });

  it("keeps LF line endings, and writes a new file with LF", () => {
    const existing = path.join(dir, "AGENTS.md");
    fs.writeFileSync(existing, "# Title\n");
    expect(writeGuardrailBlock(existing, EXPORT_BLOCK)).toBe("written");
    expect(fs.readFileSync(existing, "utf8")).toBe("# Title\n\n" + EXPORT_BLOCK);

    const created = path.join(dir, "NEW.md");
    expect(writeGuardrailBlock(created, EXPORT_BLOCK)).toBe("written");
    expect(fs.readFileSync(created, "utf8")).toBe(EXPORT_BLOCK);
  });

  it("rewrites nothing for an unchanged set", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "# Project\n");
    expect(writeGuardrailBlock(out, EXPORT_BLOCK)).toBe("written");
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(out, past, past);

    expect(writeGuardrailBlock(out, EXPORT_BLOCK)).toBe("unchanged");
    expect(fs.statSync(out).mtimeMs).toBe(past.getTime());
  });

  it("replaces a changed set in place", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "# Project\n\n" + EXPORT_BLOCK + "\n## After\n");
    expect(writeGuardrailBlock(out, NEW_BLOCK)).toBe("written");
    expect(fs.readFileSync(out, "utf8")).toBe("# Project\n\n" + NEW_BLOCK + "\n## After\n");
  });

  it("removes a block for an empty set, keeping the heading above it", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "## Guardrails\n" + EXPORT_BLOCK + "## Next section\nbody\n");
    expect(writeGuardrailBlock(out, "")).toBe("removed");
    expect(fs.readFileSync(out, "utf8")).toBe("## Guardrails\n## Next section\nbody\n");
  });

  it("never creates a file for an empty set", () => {
    const out = path.join(dir, "AGENTS.md");
    expect(writeGuardrailBlock(out, "")).toBe("unchanged");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("leaves an ambiguous file untouched", () => {
    const out = path.join(dir, "AGENTS.md");
    const original = "# P\n\n" + EXPORT_BLOCK + "\n" + EXPORT_BLOCK;
    fs.writeFileSync(out, original);
    expect(() => writeGuardrailBlock(out, NEW_BLOCK)).toThrow(/by hand/);
    expect(fs.readFileSync(out, "utf8")).toBe(original);
  });

  it("keeps the file and cleans the temp file up when the replace fails", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "# Project\n");
    failRename.message = "disk full";

    expect(() => writeGuardrailBlock(out, EXPORT_BLOCK)).toThrow("disk full");
    expect(fs.readFileSync(out, "utf8")).toBe("# Project\n");
    expect(fs.readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("refuses a file that is not UTF-8, as a block error, and leaves it alone", () => {
    const out = path.join(dir, "bad.md");
    fs.writeFileSync(out, Buffer.from([0xff, 0x0a]));
    expect(() => writeGuardrailBlock(out, EXPORT_BLOCK)).toThrow(GuardrailBlockError);
    expect(fs.readFileSync(out)).toEqual(Buffer.from([0xff, 0x0a]));
  });

  it("keeps a BOM, which Python's decode keeps too", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "\ufeff# Project\n");
    expect(writeGuardrailBlock(out, EXPORT_BLOCK)).toBe("written");
    expect(fs.readFileSync(out, "utf8")).toBe("\ufeff# Project\n\n" + EXPORT_BLOCK);
  });

  it("reads a BOM right before the begin marker as a broken block, as Python does", () => {
    const out = path.join(dir, "AGENTS.md");
    fs.writeFileSync(out, "\ufeff" + EXPORT_BLOCK);
    expect(() => writeGuardrailBlock(out, NEW_BLOCK)).toThrow(/by hand/);
  });

  it("never creates a missing parent directory", () => {
    const out = path.join(dir, "missing", "AGENTS.md");
    expect(() => writeGuardrailBlock(out, EXPORT_BLOCK)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(fs.existsSync(path.join(dir, "missing"))).toBe(false);
  });

  it("fails with Node's own error on a directory", () => {
    expect(() => writeGuardrailBlock(dir, EXPORT_BLOCK)).toThrow(
      expect.objectContaining({ code: "EISDIR" }),
    );
  });

  it.skipIf(process.platform === "win32")("follows a symlink, keeping the link and the mode", () => {
    const real = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(real, "# Project\n");
    fs.chmodSync(real, 0o640);
    const link = path.join(dir, "AGENTS.md");
    fs.symlinkSync("CLAUDE.md", link);

    expect(writeGuardrailBlock(link, EXPORT_BLOCK)).toBe("written");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("# Project\n\n" + EXPORT_BLOCK);
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("creates the target of a dangling symlink", () => {
    const link = path.join(dir, "AGENTS.md");
    fs.symlinkSync("CLAUDE.md", link);

    expect(writeGuardrailBlock(link, EXPORT_BLOCK)).toBe("written");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe(EXPORT_BLOCK);
  });

  it.skipIf(process.platform === "win32")(
    "applies `..` to where a symlink led, as Python's realpath does",
    () => {
      fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
      fs.symlinkSync(path.join("a", "b"), path.join(dir, "link"));

      // Built by hand: path.join would already fold `link/..` away.
      writeGuardrailBlock([dir, "link", "..", "X.md"].join(path.sep), EXPORT_BLOCK);
      // Not dir/X.md, which a lexical normalize would pick.
      expect(fs.existsSync(path.join(dir, "a", "X.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "X.md"))).toBe(false);
    },
  );

  it.runIf(process.platform === "win32")(
    "writes a drive-relative path (`C:X.md`) into that drive's working directory",
    () => {
      const drive = path.parse(dir).root.slice(0, 2);
      expect(drive).toMatch(/^[A-Za-z]:$/);
      const before = process.cwd();
      process.chdir(dir);
      try {
        // Checked before the write, so the test never writes outside `dir`.
        expect(path.resolve(`${drive}X.md`)).toBe(path.join(dir, "X.md"));
        expect(writeGuardrailBlock(`${drive}X.md`, EXPORT_BLOCK)).toBe("written");
      } finally {
        process.chdir(before);
      }
      // Not a file `C` carrying an `X.md` alternate data stream.
      expect(fs.readdirSync(dir)).toEqual(["X.md"]);
      expect(fs.readFileSync(path.join(dir, "X.md"), "utf8")).toBe(EXPORT_BLOCK);
    },
  );

  it.skipIf(process.platform === "win32")("fails on a symlink loop without hanging", () => {
    fs.symlinkSync("loop2", path.join(dir, "loop1"));
    fs.symlinkSync("loop1", path.join(dir, "loop2"));
    expect(() => writeGuardrailBlock(path.join(dir, "loop1"), EXPORT_BLOCK)).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
  });
});

describe("realPath", () => {
  // Windows path rules on every OS, so the Linux legs of CI catch what the
  // Windows job alone would otherwise have to.
  it.each(["C:X.md", "c:X.md", "C:sub\\X.md", "C:sub/..\\X.md", "C:"])(
    "reads the drive-relative %j against that drive's working directory",
    (input) => {
      // Python's ntpath.realpath makes the path absolute first. Joined
      // under the cwd instead, `C:X.md` would be one component with a
      // colon: the NTFS alternate data stream `X.md` of a file named `C`.
      expect(realPath(input, path.win32)).toBe(path.win32.resolve(input));
    },
  );

  it("keeps an absolute Windows path on its own drive", () => {
    expect(realPath("D:\\proj\\X.md", path.win32)).toBe("D:\\proj\\X.md");
    expect(realPath("D:/proj/X.md", path.win32)).toBe("D:\\proj\\X.md");
  });

  it("reads a relative path against the cwd, and an absolute one from its root", () => {
    expect(realPath("X.md")).toBe(path.join(fs.realpathSync(process.cwd()), "X.md"));
    expect(realPath(path.join(dir, "X.md"))).toBe(path.join(fs.realpathSync(dir), "X.md"));
  });
});

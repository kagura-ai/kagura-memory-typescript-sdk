import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdioLines } from "../../src/mcp/lines.js";

async function collect(chunks: Buffer[]): Promise<(string | null)[]> {
  const lines: (string | null)[] = [];
  for await (const line of readStdioLines(Readable.from(chunks), new AbortController().signal)) {
    lines.push(line);
  }
  return lines;
}

describe("bounded stdio lines", () => {
  it.each(["\n", "\r\n", "\r"])("preserves split UTF-8 and %j delimiters, including EOF", async (delimiter) => {
    const bytes = Buffer.from(`日本語${delimiter}second${delimiter}${delimiter}tail`);
    expect(await collect(Array.from(bytes, (byte) => Buffer.from([byte])))).toEqual([
      "日本語", "second", "", "tail",
    ]);
  });

  it("splits multiple lines within one chunk", async () => {
    expect(await collect([Buffer.from("first\nsecond\r\nthird\rfourth")])).toEqual([
      "first", "second", "third", "fourth",
    ]);
  });

  it.each([0, 1])("enforces the byte boundary with a split UTF-8 character (%i extra byte)", async (extra) => {
    const limit = 16 * 1024 * 1024;
    const bytes = Buffer.concat([Buffer.alloc(limit - 3 + extra, 0x61), Buffer.from("日")]);
    const lines = await collect([
      bytes.subarray(0, bytes.length - 1), bytes.subarray(bytes.length - 1),
      Buffer.from("\r"), Buffer.from("\nnext\n"),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("next");
    if (extra) expect(lines[0]).toBeNull();
    else {
      expect(Buffer.byteLength(lines[0]!)).toBe(limit);
      expect(lines[0]!.endsWith("日")).toBe(true);
    }
  });
});

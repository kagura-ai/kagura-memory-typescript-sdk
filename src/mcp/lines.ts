import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Yield bounded UTF-8 lines, or null once when a line exceeds the limit. */
export async function* readStdioLines(
  input: Readable,
  signal: AbortSignal,
): AsyncGenerator<string | null> {
  if (signal.aborted) return;
  const close = (): void => { input.destroy(); };
  signal.addEventListener("abort", close, { once: true });
  let decoder = new StringDecoder("utf8");
  let text = "";
  let size = 0;
  let discarding = false;
  let skipLF = false;
  const append = (bytes: Buffer): boolean => {
    if (discarding) return false;
    if (size + bytes.length > MAX_LINE_BYTES) {
      // Release the partial line immediately and discard through its delimiter.
      // Do not retain an unbounded line or interpret its tail as a new message.
      text = "";
      size = 0;
      decoder = new StringDecoder("utf8");
      discarding = true;
      return true;
    }
    size += bytes.length;
    text += decoder.write(bytes);
    return false;
  };
  try {
    for await (const chunk of input) {
      if (signal.aborted) return;
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) continue;
      let start = skipLF && bytes[0] === 10 ? 1 : 0;
      skipLF = false;
      for (let end = start; end < bytes.length; end++) {
        if (bytes[end] !== 10 && bytes[end] !== 13) continue;
        if (append(bytes.subarray(start, end))) yield null;
        if (!discarding) yield text + decoder.end();
        text = "";
        size = 0;
        discarding = false;
        decoder = new StringDecoder("utf8");
        // Treat CRLF as one delimiter, even when split across input chunks.
        if (bytes[end] === 13) {
          if (bytes[end + 1] === 10) end++;
          else if (end + 1 === bytes.length) skipLF = true;
        }
        start = end + 1;
      }
      if (append(bytes.subarray(start))) yield null;
    }
    if (!discarding && size > 0) yield text + decoder.end();
  } catch (error) {
    // Destroying stdin wakes an idle read when the host cancels the proxy.
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", close);
  }
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runProxy } from "../../src/mcp/run.js";

const state = vi.hoisted(() => ({
  messages: [] as Record<string, unknown>[],
  release: [] as (() => void)[],
}));
vi.mock("../../src/mcp/transport.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/mcp/transport.js")>();
  return {
    ...original,
    McpTransport: class {
      async forward(message: Record<string, unknown>) {
        state.messages.push(message);
        if (message.method === "tools/call")
          await new Promise<void>((resolve) => state.release.push(resolve));
      }
    },
  };
});

it("accepts cancellations and server replies even when all request slots are occupied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kagura-proxy-scheduling-"));
  const input = new PassThrough();
  const output: string[] = [];
  const done = runProxy(
    ["--credentials", join(dir, "credentials.json"), "--no-login"],
    {
      input,
      output: (line) => {
        output.push(line);
      },
      error: () => {},
      signal: new AbortController().signal,
    },
  );
  try {
    for (let id = 0; id < 129; id++)
      input.write(
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call" }) + "\n",
      );
    input.write(
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":0}}\n',
    );
    input.write('{"jsonrpc":"2.0","id":"server","result":{}}\n');
    await expect.poll(() => state.messages.length).toBe(130);
    expect(
      state.messages.some((m) => m.method === "notifications/cancelled"),
    ).toBe(true);
    expect(state.messages.some((m) => m.id === "server")).toBe(true);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!).id).toBe(128);
  } finally {
    for (const release of state.release) release();
    input.end();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProxy } from "../../src/mcp/run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kagura-proxy-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io() {
  const input = new PassThrough();
  const output: string[] = [];
  const errors: string[] = [];
  const controller = new AbortController();
  return {
    input,
    output,
    errors,
    controller,
    deps: {
      input,
      output: (line: string) => {
        output.push(line);
      },
      error: (line: string) => {
        errors.push(line);
      },
      signal: controller.signal,
    },
  };
}

describe("stdio runner", () => {
  it("prints help/version without loading a profile", async () => {
    for (const flag of ["--help", "--version"]) {
      const s = io();
      expect(await runProxy([flag], s.deps)).toBe(0);
      expect(s.output.join("")).toContain("kagura-memory-mcp");
      expect(s.errors).toEqual([]);
    }
  });

  it("rejects invalid arguments and deadlines on stderr", async () => {
    for (const args of [
      ["--wat"],
      ["--server"],
      ["--server", "--no-login"],
      ["--no-login=false"],
      ["--help=anything"],
      ["unexpected"],
      [""],
      ["--", "--help"],
      ["--login-timeout", "NaN"],
      ["--login-timeout", "0"],
      ["--login-timeout", "3601"],
    ]) {
      const s = io();
      expect(await runProxy(args, s.deps)).toBe(2);
      expect(s.output).toEqual([]);
      expect(s.errors.length).toBeGreaterThan(0);
    }
  });

  it("emits protocol errors for invalid input, preserves request IDs, and stays silent for notifications", async () => {
    const s = io();
    const done = runProxy(
      ["--credentials", join(dir, "credentials.json"), "--no-login"],
      s.deps,
    );
    s.input.write(
      '\n{bad json\n[]\n{"jsonrpc":"2.0","id":0,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    await expect.poll(() => s.output.length).toBe(3);
    s.input.end();
    expect(await done).toBe(0);
    expect(s.output.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      },
      {
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: -32000,
          message: expect.stringContaining("Login required"),
        },
      },
    ]);
  });

  it("shuts down when signalled while stdin is idle", async () => {
    const s = io();
    const done = runProxy(
      ["--credentials", join(dir, "credentials.json"), "--no-login"],
      s.deps,
    );
    s.controller.abort();
    expect(await done).toBe(0);
  });

  it("rejects malformed envelopes with -32600 without forwarding them", async () => {
    const s = io();
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not forward"));
    const malformed = [
      { jsonrpc: "2.0", result: {} },
      { jsonrpc: "2.0", error: { code: -32000, message: "failure" } },
      { jsonrpc: "2.0", id: 1, method: "tools/call", result: {} },
      { jsonrpc: "2.0", method: "ping", error: { code: -32000, message: "failure" } },
      { jsonrpc: "2.0", id: 2, result: {}, error: { code: -32000, message: "failure" } },
      { jsonrpc: "2.0", id: 3, method: "ping", params: null },
    ];
    const done = runProxy(
      ["--credentials", join(dir, "credentials.json"), "--no-login"],
      s.deps,
    );
    try {
      for (const message of malformed) s.input.write(JSON.stringify(message) + "\n");
      await expect.poll(() => s.output.length).toBe(malformed.length);
      expect(s.output.map((line) => JSON.parse(line))).toEqual(
        malformed.map(() => ({
          jsonrpc: "2.0", id: null,
          error: { code: -32600, message: "Invalid request" },
        })),
      );
      expect(s.errors).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      s.input.end();
      await done;
      fetcher.mockRestore();
    }
  });

  it("returns immediately when already aborted before startup", async () => {
    const s = io();
    s.controller.abort();
    expect(await runProxy([], s.deps)).toBe(0);
  });
});

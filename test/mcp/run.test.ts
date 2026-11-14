import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStateCache } from "../../src/auth/credentials.js";
import { runProxy, SESSION_ENV } from "../../src/mcp/run.js";

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

  it.each(["profile", "server", "credentials"])(
    "rejects explicitly empty --%s values before starting the proxy",
    async (name) => {
      for (const args of [
        [`--${name}=`, "--help"], [`--${name}`, "", "--help"],
        [`--${name}=  `, "--help"], [`--${name}`, " \t", "--help"],
      ]) {
        const s = io();
        expect(await runProxy(args, s.deps)).toBe(2);
        expect(s.output).toEqual([]);
        expect(s.errors.join("")).toContain("Invalid proxy arguments");
      }
    },
  );

  it("rejects an oversized unterminated line before EOF and resumes at the next delimiter", async () => {
    const s = io();
    const done = runProxy(
      ["--credentials", join(dir, "credentials.json"), "--no-login"],
      s.deps,
    );
    try {
      // No newline or EOF: readline's accumulated-line guard never fires here.
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i < 17; i++) {
        s.input.write(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await expect.poll(() => s.output.length).toBe(1);
      expect(JSON.parse(s.output[0]!)).toEqual({
        jsonrpc: "2.0", id: null,
        error: { code: -32600, message: "Message exceeded 16 MiB." },
      });
      // Even an otherwise-valid suffix of the bad line must not be processed.
      s.input.write('{"jsonrpc":"2.0","id":"discarded","method":"ping"}\r');
      s.input.write('\n{"jsonrpc":"2.0","id":"next","method":"ping"}\n');
      await expect.poll(() => s.output.length).toBe(2);
      expect(JSON.parse(s.output[1]!)).toMatchObject({
        id: "next", error: { message: expect.stringContaining("Login required") },
      });
    } finally {
      s.input.end();
      await done;
    }
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

describe("upstream URL query and session id flags (#83)", () => {
  const U = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
  const SERVER = "https://example.test/mcp";

  beforeEach(() => resetStateCache());
  afterEach(() => resetStateCache());

  /** A credentials file with an unexpired profile for SERVER, so no OAuth request is made. */
  function credentials(): string {
    const file = join(dir, "credentials.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        default_profile: "desktop",
        profiles: {
          desktop: {
            server: "https://example.test",
            mcp_url: SERVER,
            client_id: "c",
            access_token: "at",
            refresh_token: "rt",
            token_type: "Bearer",
            expires_at: "2099-01-01T00:00:00Z",
            scope: "memory:read",
            workspace_id: "w",
            issued_at: "2026-01-01T00:00:00Z",
          },
        },
      }),
      { mode: 0o600 },
    );
    return file;
  }

  /** Run the proxy over an initialize and a tools/list; every upstream request's URL and headers. */
  async function proxied(args: string[], env: Record<string, string | undefined> = {}) {
    const s = io();
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      const { id } = JSON.parse(String(init?.body)) as { id: unknown };
      return Response.json({ jsonrpc: "2.0", id, result: {} }, { headers: { "mcp-session-id": "mcp-1" } });
    }) as unknown as typeof fetch;
    const done = runProxy(["--credentials", credentials(), "--no-login", ...args], {
      ...s.deps,
      env,
      fetch: fetcher,
    });
    s.input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
    s.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await expect.poll(() => s.output.length).toBe(2);
    s.input.end();
    expect(await done).toBe(0);
    return { requests, errors: s.errors };
  }

  it("leaves the profile's URL as it is and sends no session header without the flags", async () => {
    const { requests, errors } = await proxied([]);
    expect(requests.map((r) => r.url)).toEqual([SERVER, SERVER]);
    expect(requests.every((r) => !("Kagura-Session-Id" in r.headers))).toBe(true);
    expect(errors).toEqual([]);
  });

  it("sets the query on the upstream URL as Python's mcp_url_with_query writes it", async () => {
    const { requests } = await proxied([
      "--guardrails", "OFF",
      "--tool-profile", " core ",
      "--add-tools", "explore",
      "--add-tools", "list_edges, explore",
      "--context", `{${U.toUpperCase()}}`,
    ]);
    // Python 0.44.0: mcp_url_with_query(url, guardrails="off", tool_profile="core",
    // add_tools=["explore,list_edges"], context=U)
    const url = `${SERVER}?guardrails=off&profile=core&add_tools=explore,list_edges&context=${U}`;
    expect(requests.map((r) => r.url)).toEqual([url, url]);
  });

  it("replaces a value already in --server's query and keeps the rest", async () => {
    const { requests, errors } = await proxied([
      "--server", `${SERVER}?context=old&keep=1`,
      "--context", U,
    ]);
    expect(requests[0]!.url).toBe(`${SERVER}?keep=1&context=${U}`);
    expect(errors).toEqual([]);
  });

  it("warns that a ?tools= allowlist on the URL wins over --tool-profile and --add-tools", async () => {
    const { requests, errors } = await proxied([
      "--server", `${SERVER}?tools=recall`,
      "--tool-profile", "full",
      "--add-tools", "explore",
    ]);
    expect(requests[0]!.url).toBe(`${SERVER}?tools=recall&profile=full&add_tools=explore`);
    expect(errors).toEqual([
      "kagura-memory-mcp: warning: the upstream URL has a ?tools= allowlist, which the server applies " +
        "instead of --tool-profile and --add-tools.\n",
    ]);
  });

  it("sends --session-id as Kagura-Session-Id on every upstream request", async () => {
    const { requests } = await proxied(["--session-id", " run-1 "]);
    expect(requests.map((r) => r.headers["Kagura-Session-Id"])).toEqual(["run-1", "run-1"]);
    expect(requests.map((r) => r.url)).toEqual([SERVER, SERVER]);
  });

  it(`defaults --session-id to $${SESSION_ENV}, which the flag overrides`, async () => {
    const env = await proxied([], { [SESSION_ENV]: "conv.7_a-b" });
    expect(env.requests.map((r) => r.headers["Kagura-Session-Id"])).toEqual(["conv.7_a-b", "conv.7_a-b"]);
    const flag = await proxied(["--session-id", "flag"], { [SESSION_ENV]: "conv.7_a-b" });
    expect(flag.requests.map((r) => r.headers["Kagura-Session-Id"])).toEqual(["flag", "flag"]);
    const blank = await proxied([], { [SESSION_ENV]: "  " });
    expect(blank.requests.every((r) => !("Kagura-Session-Id" in r.headers))).toBe(true);
  });

  it.each(["has space", "run\r\nX-Injected: 1", "run\nX-Injected: 1", "x".repeat(129), "café"])(
    `ignores an invalid $${SESSION_ENV} %j with a warning that never shows it, sending no header`,
    async (value) => {
      const { requests, errors } = await proxied([], { [SESSION_ENV]: value });
      expect(requests).toHaveLength(2);
      for (const r of requests) {
        expect(Object.keys(r.headers).filter((k) => /session-id|injected/i.test(k))).toEqual(
          r.headers["Mcp-Session-Id"] !== undefined ? ["Mcp-Session-Id"] : [],
        );
      }
      expect(errors).toEqual([
        `kagura-memory-mcp: warning: ignoring ${SESSION_ENV}: use 1-128 letters, digits, '.', '_' or '-' ` +
          "(memory-cloud drops any other value)\n",
      ]);
    },
  );

  it("takes a session id of exactly 128 characters, trimmed as Python trims it", async () => {
    const id = "a".repeat(128);
    const { requests } = await proxied([], { [SESSION_ENV]: `\t${id}\n` });
    expect(requests.map((r) => r.headers["Kagura-Session-Id"])).toEqual([id, id]);
  });

  it.each([
    [["--context", "nope"], "Invalid value for --context: context must be a UUID, got 'nope'"],
    [["--context="], "Invalid value for --context: context must be a UUID, got ''"],
    [["--guardrails", "on"], "Invalid value for --guardrails: guardrails must be 'off' or a context UUID, got 'on'"],
    [["--tool-profile="], "Invalid value for --tool-profile: tool_profile must not be empty"],
    [["--tool-profile=-x"], "Invalid value for --tool-profile: tool_profile cannot start with '-': '-x'"],
    // Trimmed, then checked: Python 0.44.0's kagura-mcp says
    // `argument --tool-profile: tool_profile must not be empty` / `… '-x'`.
    [["--tool-profile=  "], "Invalid value for --tool-profile: tool_profile must not be empty"],
    [["--tool-profile= -x "], "Invalid value for --tool-profile: tool_profile cannot start with '-': '-x'"],
    [["--add-tools", " , "], "Invalid value for --add-tools: must name at least one tool"],
    [["--add-tools", "a", "--add-tools="], "Invalid value for --add-tools: must name at least one tool"],
    [["--add-tools=-x"], "Invalid value for --add-tools: add_tools names cannot start with '-': '-x'"],
    [
      ["--add-tools", Array.from({ length: 60 }, (_, i) => `a${i}`).join(","), "--add-tools", Array.from({ length: 41 }, (_, i) => `b${i}`).join(",")],
      "Invalid value for --add-tools: add_tools accepts at most 100 tool names, got 101",
    ],
    [["--session-id", "a b"], "Invalid value for --session-id: use 1-128 letters, digits, '.', '_' or '-' (memory-cloud drops any other value)"],
    [["--session-id", "x".repeat(129)], "Invalid value for --session-id: use 1-128 letters, digits, '.', '_' or '-' (memory-cloud drops any other value)"],
    [["--session-id="], "Invalid value for --session-id: use 1-128 letters, digits, '.', '_' or '-' (memory-cloud drops any other value)"],
    // A CR/LF would split the header: refused, and not echoed back.
    [["--session-id", "a\r\nX-Injected: 1"], "Invalid value for --session-id: use 1-128 letters, digits, '.', '_' or '-' (memory-cloud drops any other value)"],
  ])("refuses %j with exit 2 before starting", async (args, message) => {
    const s = io();
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(
      await runProxy(["--credentials", join(dir, "credentials.json"), "--no-login", ...args], { ...s.deps, fetch: fetcher }),
    ).toBe(2);
    expect(s.errors).toEqual([`${message}\n`]);
    expect(s.output).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("documents the new flags in --help", async () => {
    const s = io();
    expect(await runProxy(["--help"], s.deps)).toBe(0);
    const help = s.output.join("");
    for (const flag of ["--guardrails off|CONTEXT_ID", "--tool-profile NAME", "--add-tools NAME[,NAME...]", "--context CONTEXT_ID", "--session-id NAME"]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain(`$${SESSION_ENV}`);
    // memory-cloud v0.158.0's google / microsoft views (#150).
    expect(help).toContain("google / microsoft (v0.158.0+: core without\n                       describe_tools and guide)");
    expect(help).toContain("except that google and microsoft refuse describe_tools and guide\n(unknown_tool)");
  });
});

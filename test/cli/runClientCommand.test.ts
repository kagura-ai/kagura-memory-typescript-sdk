import { describe, expect, it } from "vitest";

import type { KaguraClient } from "../../src/client.js";
import type { KaguraConfig } from "../../src/config.js";
import { runClientCommand, type ClientCommandContext } from "../../src/cli/runClientCommand.js";
import { KaguraError } from "../../src/errors.js";
import { CliUsageError } from "../../src/cli/parse.js";
import { FakeServer, makeClient } from "../fakeServer.js";

interface Harness {
  ctx: ClientCommandContext;
  out: string[];
  err: string[];
  server: FakeServer;
  clientOptions: Record<string, unknown>[];
  closed: number;
}

function harness(config: KaguraConfig = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  const clientOptions: Record<string, unknown>[] = [];
  const h = { out, err, server, clientOptions, closed: 0 } as Harness;

  h.ctx = {
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    loadConfig: () => config,
    makeClient: (options) => {
      clientOptions.push({ ...options });
      const client = makeClient(server, options as Record<string, unknown>);
      const realClose = client.close.bind(client);
      client.close = async () => {
        h.closed += 1;
        await realClose();
      };
      return client;
    },
  };
  return h;
}

const noop = async () => ({ status: "success" });

describe("runClientCommand: context resolution", () => {
  it("prefers the explicit context id", async () => {
    const h = harness({ context_id: "from-config" });
    let seen = "";
    await runClientCommand(h.ctx, "from-flag", async (_c, id) => {
      seen = id;
      return {};
    });
    expect(seen).toBe("from-flag");
  });

  it("falls back to .kagura.json's context_id", async () => {
    const h = harness({ context_id: "from-config" });
    let seen = "";
    await runClientCommand(h.ctx, undefined, async (_c, id) => {
      seen = id;
      return {};
    });
    expect(seen).toBe("from-config");
  });

  it.each([[undefined], [""], [null]])(
    "raises the Python message when no context resolves (config %j)",
    async (configured) => {
      // Reporting is the router's job — it owns the `Error: ` prefix and
      // the exit code, so there is exactly one place that formats them.
      const h = harness({ context_id: configured as string | null | undefined });
      await expect(runClientCommand(h.ctx, undefined, noop)).rejects.toThrow(
        "context_id required. Use --context-id or set in .kagura.json",
      );
      expect(h.out).toEqual([]);
    },
  );

  it("treats an empty --context-id as absent, matching Python's `or` chain", async () => {
    // `context_id or config.get("context_id") or ""` — an empty string is
    // falsy in Python, so `--context-id=` falls through to the config.
    const h = harness({ context_id: "from-config" });
    let seen = "";
    await runClientCommand(h.ctx, "", async (_c, id) => {
      seen = id;
      return {};
    });
    expect(seen).toBe("from-config");
  });

  it("skips the context requirement when the command does not need one", async () => {
    const h = harness({});
    let seen = "unset";
    const code = await runClientCommand(
      h.ctx,
      undefined,
      async (_c, id) => {
        seen = id;
        return { ok: true };
      },
      { needsContext: false },
    );
    expect(code).toBe(0);
    expect(seen).toBe("");
    expect(h.err).toEqual([]);
  });
});

describe("runClientCommand: client construction", () => {
  it("passes api_key and mcp_url from config", async () => {
    const h = harness({ context_id: "c", api_key: "k-1", mcp_url: "https://x.test/mcp" });
    await runClientCommand(h.ctx, undefined, noop);
    expect(h.clientOptions[0]).toMatchObject({ apiKey: "k-1", mcpUrl: "https://x.test/mcp" });
  });

  it.each([[""], [undefined]])(
    "omits an empty api_key (%j) so the resolution chain still runs",
    async (apiKey) => {
      // Python: `api_key=config.get("api_key") or None`. Passing "" would
      // send `Authorization: Bearer ` and always 401, instead of letting
      // the OAuth profile resolve.
      const h = harness({ context_id: "c", api_key: apiKey });
      await runClientCommand(h.ctx, undefined, noop);
      expect(h.clientOptions[0]).not.toHaveProperty("apiKey");
    },
  );

  it("omits an empty mcp_url", async () => {
    const h = harness({ context_id: "c", mcp_url: "" });
    await runClientCommand(h.ctx, undefined, noop);
    expect(h.clientOptions[0]).not.toHaveProperty("mcpUrl");
  });
});

describe("runClientCommand: output and exit codes", () => {
  it("prints the result as indented JSON and exits 0", async () => {
    const h = harness({ context_id: "c" });
    const code = await runClientCommand(h.ctx, undefined, async () => ({ status: "success", n: 2 }));
    expect(code).toBe(0);
    expect(h.out).toEqual(['{\n  "status": "success",\n  "n": 2\n}']);
  });

  it("forwards a Kagura error's guidance rather than a stack trace", async () => {
    const h = harness({ context_id: "c" });
    await expect(
      runClientCommand(h.ctx, undefined, async () => {
        throw new KaguraError("Run: kagura auth login");
      }),
    ).rejects.toThrow("Run: kagura auth login");
    expect(h.out).toEqual([]);
  });

  it("forwards a non-Error throw rather than [object Object]", async () => {
    const h = harness({ context_id: "c" });
    await expect(
      runClientCommand(h.ctx, undefined, async () => {
        throw "plain string";
      }),
    ).rejects.toThrow("plain string");
  });

  it("preserves a CliUsageError's exit code instead of demoting it to 1", async () => {
    // A command may validate lazily inside the operation; wrapping that in
    // a CliError would turn "you invoked it wrong" (2) into "the call
    // failed" (1).
    const h = harness({ context_id: "c" });
    await expect(
      runClientCommand(h.ctx, undefined, async () => {
        throw new CliUsageError("bad flag");
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("closes the client on success", async () => {
    const h = harness({ context_id: "c" });
    await runClientCommand(h.ctx, undefined, noop);
    expect(h.closed).toBe(1);
  });

  it("closes the client even when the operation throws", async () => {
    // Python uses `async with client:`; a leaked MCP session would keep the
    // process alive past the command.
    const h = harness({ context_id: "c" });
    await expect(
      runClientCommand(h.ctx, undefined, async () => {
        throw new KaguraError("boom");
      }),
    ).rejects.toThrow();
    expect(h.closed).toBe(1);
  });

  it("does not construct a client when the context check already failed", async () => {
    const h = harness({});
    await expect(runClientCommand(h.ctx, undefined, noop)).rejects.toThrow();
    expect(h.clientOptions).toEqual([]);
  });

  it("reaches the server with the resolved context id", async () => {
    const h = harness({ context_id: "ctx-9", api_key: "k" });
    const code = await runClientCommand(h.ctx, undefined, async (client: KaguraClient, id) =>
      client.recall({ contextId: id, query: "hello" }),
    );
    expect(code).toBe(0);
    expect(h.server.toolCallArgs(0)).toMatchObject({ context_id: "ctx-9", query: "hello" });
  });
});

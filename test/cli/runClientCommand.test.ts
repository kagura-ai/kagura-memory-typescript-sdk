import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultCredentialsPath,
  emptyCredentialsFile,
  resetStateCache,
  saveCredentialsFile,
  setProfile,
} from "../../src/auth/credentials.js";
import { KaguraClient } from "../../src/client.js";
import { loadConfig, type KaguraConfig } from "../../src/config.js";
import {
  mcpOptions,
  runClientCommand,
  type ClientCommandContext,
} from "../../src/cli/runClientCommand.js";
import { KaguraError, KaguraQuotaError } from "../../src/errors.js";
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

  const unusedRestClient = () => {
    throw new Error("this suite exercises the MCP path only");
  };

  h.ctx = {
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    resolveAuth: unusedRestClient,
    makeFilesClient: unusedRestClient,
    makeResourceClient: unusedRestClient,
    makeSecretClient: unusedRestClient,
    makeMemoryClient: unusedRestClient,
    makeWorkspaceClient: unusedRestClient,
    isTty: () => false,
    readStdin: () => null,
    spawnChild: async () => 0,
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
        "context_id required. Pass the context ID or set context_id in .kagura.json",
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

  it("keeps a gate refusal's Resets at / Required plan lines when it wraps it", async () => {
    // The CliError it throws is all the router sees: the lines must be in
    // its message already (Python's _cli_error_message, in the helper).
    const h = harness({ context_id: "c" });
    await expect(
      runClientCommand(h.ctx, undefined, async () => {
        throw new KaguraQuotaError("Daily limit.", null, {
          resetsAt: "2026-09-26T00:00:00Z",
          requiredPlan: "pro",
          requiredPlanDisplay: "Pro",
        });
      }),
    ).rejects.toMatchObject({
      message: "Daily limit.\n  Resets at: 2026-09-26T00:00:00+00:00\n  Required plan: Pro (pro)",
      exitCode: 1,
    });
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

describe("mcpOptions", () => {
  it("carries mcp_url as well as the key", () => {
    // `files upload --remember` builds an MCP client after a REST upload.
    // Options without mcp_url dropped a self-hosted server and sent the
    // memory to the default cloud one.
    expect(mcpOptions({ api_key: "k", mcp_url: "https://self.hosted/mcp" })).toEqual({
      apiKey: "k",
      mcpUrl: "https://self.hosted/mcp",
    });
  });

  it("omits empties, so the resolution chain still runs", () => {
    // Python: `api_key=config.get("api_key") or None`. Forwarding "" would
    // send `Authorization: Bearer ` and always 401 instead of letting the
    // OAuth profile resolve.
    expect(mcpOptions({ api_key: "", mcp_url: "" })).toEqual({});
  });
});

describe("mcpOptions without a .kagura.json", () => {
  // loadConfig then fills mcp_url from KAGURA_MCP_URL or the default.
  // Forwarded as an explicit URL, that overrode an OAuth profile's own
  // server: `guardrails load`, `measure`, `recall` and the other MCP
  // commands sent the profile's token to https://memory.kagura-ai.com/mcp.
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-mcpopts-"));
    resetStateCache();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    resetStateCache();
  });

  /** One OAuth profile, `default`, bound to `mcpUrl`, in the sandbox's credentials file. */
  function seedProfile(mcpUrl: string): void {
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", {
      server: new URL(mcpUrl).origin,
      mcpUrl,
      clientId: "kagura-cli",
      accessToken: "at-self-hosted",
      refreshToken: "rt-1",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000),
      scope: "memory:read memory:write",
      workspaceId: "ws-1",
      workspaceName: "Acme",
      userEmail: "dev@example.test",
      issuedAt: new Date(),
    });
    saveCredentialsFile(cf, defaultCredentialsPath(sandbox));
  }

  /** The URL the CLI's MCP client ends up at, built as the CLI builds it. */
  function clientUrl(env: Record<string, string>): string {
    const config = loadConfig({ cwd: sandbox, home: sandbox, env });
    return new KaguraClient({ ...mcpOptions(config), env, home: sandbox }).mcpUrl;
  }

  it("forwards neither the default URL nor the key it filled in", () => {
    const config = loadConfig({ cwd: sandbox, home: sandbox, env: { KAGURA_API_KEY: "k" } });
    expect(config.mcp_url).toBe("https://memory.kagura-ai.com/mcp");
    expect(mcpOptions(config)).toEqual({});
  });

  it("leaves an OAuth profile on its own server", () => {
    seedProfile("https://self.hosted.test/mcp");
    expect(clientUrl({})).toBe("https://self.hosted.test/mcp");
  });

  it("still sends KAGURA_API_KEY to KAGURA_MCP_URL, else the default", () => {
    seedProfile("https://self.hosted.test/mcp");
    expect(clientUrl({ KAGURA_API_KEY: "k", KAGURA_MCP_URL: "https://env.test/mcp" })).toBe("https://env.test/mcp");
    expect(clientUrl({ KAGURA_API_KEY: "k" })).toBe("https://memory.kagura-ai.com/mcp");
  });

  it("still forwards a real file's mcp_url and key", () => {
    fs.writeFileSync(
      path.join(sandbox, ".kagura.json"),
      JSON.stringify({ api_key: "k-file", mcp_url: "https://file.test/mcp" }),
    );
    expect(mcpOptions(loadConfig({ cwd: sandbox, home: sandbox, env: {} }))).toEqual({
      apiKey: "k-file",
      mcpUrl: "https://file.test/mcp",
    });
  });
});

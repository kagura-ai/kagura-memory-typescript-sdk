/**
 * Workspace/credential pairing for the REST command runners (#115) —
 * `_resolve_workspace_from_source`, `_bound_workspace_for_hint` and the
 * front half of `_run_workspace_command` / `_run_files_command` in the
 * Python CLI. The messages are pinned verbatim; the cases follow the
 * Python tests in tests/test_cli_files.py and tests/test_cli_workspace.py
 * that exercise the pairing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAuth, type ResolveAuthOptions } from "../../src/auth/resolve.js";
import type { ResolvedAuth } from "../../src/auth/types.js";
import type { KaguraConfig } from "../../src/config.js";
import {
  boundWorkspaceForHint,
  pairWorkspaceCredential,
  refuseBlankWorkspaceOverride,
  resolveCliAuth,
  resolveWorkspaceFromSource,
} from "../../src/cli/credentialSource.js";
import { CliError } from "../../src/cli/parse.js";
import type { ClientCommandContext } from "../../src/cli/runClientCommand.js";
import { KaguraAuthError } from "../../src/errors.js";

const WS = "11111111-2222-3333-4444-555555555555";
const OAUTH_WS = "aaaaaaaa-0000-0000-0000-000000000000";

const ENV_KEY: ResolvedAuth = {
  kind: "static",
  apiKey: "env-key",
  mcpUrl: "https://x.test/mcp",
  source: "env",
};
const CONFIG_KEY: ResolvedAuth = { ...ENV_KEY, apiKey: "cfg-key", source: "config" };
const OAUTH: ResolvedAuth = {
  kind: "oauth",
  oauth: { getAuthHeader: async () => "Bearer t" },
  mcpUrl: "https://x.test/mcp",
  workspaceId: OAUTH_WS,
};

const OAUTH_NO_WS =
  "OAuth profile has no workspace bound. Re-run `kagura-memory auth login` or pass --context-id <uuid>.";
const CONFIG_NO_WS =
  '.kagura.json has api_key but context_id is missing or "auto". Set context_id to the ' +
  "workspace UUID bound to this api_key, or pass --context-id. (Falling back to the OAuth " +
  "profile would mix credential sources — see issue #115.)";
const ENV_NO_WS =
  "api_key from KAGURA_API_KEY env has no associated workspace; pass --context-id " +
  "(mixing api_key and OAuth profile's workspace is not allowed — see issue #115).";
const BLANK_OVERRIDE =
  "--workspace was provided but empty (or 'auto') — refusing to fall back to the " +
  "credential source's workspace. Pass the target workspace UUID.";

describe("resolveWorkspaceFromSource", () => {
  it("lets an explicit override win over every source, stripped", () => {
    for (const auth of [ENV_KEY, CONFIG_KEY, OAUTH]) {
      expect(resolveWorkspaceFromSource(auth, { context_id: "cfg" }, `  ${WS}\t`)).toBe(WS);
    }
  });

  it("keeps an override as typed apart from the strip: UUID checks are the caller's", () => {
    expect(resolveWorkspaceFromSource(ENV_KEY, {}, "not-a-uuid")).toBe("not-a-uuid");
    expect(resolveWorkspaceFromSource(ENV_KEY, {}, "AUTO")).toBe("AUTO");
  });

  it.each(["", "   ", "auto", " auto "])(
    "reads the override %j as none and falls back to the source",
    (override) => {
      expect(resolveWorkspaceFromSource(OAUTH, {}, override)).toBe(OAUTH_WS);
    },
  );

  it("takes an OAuth profile's workspace, ignoring .kagura.json's context_id", () => {
    expect(resolveWorkspaceFromSource(OAUTH, { context_id: WS }, undefined)).toBe(OAUTH_WS);
  });

  it("refuses an OAuth profile with no workspace, naming the flag", () => {
    const auth: ResolvedAuth = { ...OAUTH, workspaceId: null } as ResolvedAuth;
    expect(() => resolveWorkspaceFromSource(auth, {}, undefined)).toThrow(new CliError(OAUTH_NO_WS));
    expect(() => resolveWorkspaceFromSource(auth, {}, undefined, "--workspace")).toThrow(
      OAUTH_NO_WS.replace("--context-id", "--workspace"),
    );
  });

  it("pairs a .kagura.json key with that file's context_id, stripped", () => {
    expect(resolveWorkspaceFromSource(CONFIG_KEY, { context_id: ` ${WS} ` }, undefined)).toBe(WS);
  });

  it.each([
    ["missing", {}],
    ["null", { context_id: null }],
    ["blank", { context_id: "  " }],
    ["auto", { context_id: "auto" }],
    ["not a string", { context_id: 42 as unknown as string }],
  ])("refuses a .kagura.json key whose context_id is %s", (_id, config: KaguraConfig) => {
    expect(() => resolveWorkspaceFromSource(CONFIG_KEY, config, undefined)).toThrow(
      new CliError(CONFIG_NO_WS),
    );
  });

  it("refuses a KAGURA_API_KEY key: it has no workspace to pair with", () => {
    // Not even KAGURA_CONTEXT_ID, which the env-derived config carries.
    expect(() => resolveWorkspaceFromSource(ENV_KEY, { context_id: WS }, undefined)).toThrow(
      new CliError(ENV_NO_WS),
    );
    expect(() => resolveWorkspaceFromSource(ENV_KEY, {}, "", "--workspace")).toThrow(
      ENV_NO_WS.replace("--context-id", "--workspace"),
    );
  });
});

describe("boundWorkspaceForHint", () => {
  it("is the .kagura.json context_id for a .kagura.json key", () => {
    expect(boundWorkspaceForHint(CONFIG_KEY, { context_id: ` ${WS}` })).toBe(WS);
  });

  it.each([
    ["an env key", ENV_KEY, { context_id: WS }],
    ["an OAuth profile", OAUTH, { context_id: WS }],
    ["an auto context_id", CONFIG_KEY, { context_id: "auto" }],
    ["no context_id", CONFIG_KEY, {}],
  ])("is null for %s", (_id, auth: ResolvedAuth, config: KaguraConfig) => {
    expect(boundWorkspaceForHint(auth, config)).toBeNull();
  });
});

describe("refuseBlankWorkspaceOverride", () => {
  it.each(["", "   ", "auto", " auto "])("refuses %j", (value) => {
    expect(() => refuseBlankWorkspaceOverride(value)).toThrow(new CliError(BLANK_OVERRIDE));
  });

  it.each([undefined, WS, "AUTO"])("lets %j through", (value) => {
    // `AUTO` is not the sentinel; it fails the UUID check later instead.
    expect(() => refuseBlankWorkspaceOverride(value)).not.toThrow();
  });
});

describe("resolveCliAuth", () => {
  it("resolves with the loaded config and no URL, so each source keeps its own URL", () => {
    const seen: ResolveAuthOptions[] = [];
    const config = { api_key: "cfg-key", mcp_url: "https://cfg.test/mcp" };
    const auth = resolveCliAuth(
      {
        resolveAuth: (options) => {
          seen.push(options!);
          return CONFIG_KEY;
        },
      },
      config,
    );
    expect(auth).toBe(CONFIG_KEY);
    expect(seen).toEqual([{ apiKey: null, mcpUrl: null, profile: null, config }]);
  });

  it("reports a missing credential as a CLI error with the resolver's message", () => {
    const failing = () => {
      throw new KaguraAuthError("No credentials found.\n  Run: kagura auth login");
    };
    expect(() => resolveCliAuth({ resolveAuth: failing }, {})).toThrow(
      new CliError("No credentials found.\n  Run: kagura auth login"),
    );
  });
});

describe("pairWorkspaceCredential", () => {
  function context(config: KaguraConfig | Error, auth: ResolvedAuth | Error) {
    const calls: string[] = [];
    const ctx = {
      loadConfig: () => {
        calls.push("loadConfig");
        if (config instanceof Error) throw config;
        return config;
      },
      resolveAuth: () => {
        calls.push("resolveAuth");
        if (auth instanceof Error) throw auth;
        return auth;
      },
    } as unknown as ClientCommandContext;
    return { ctx, calls };
  }

  it("pairs the workspace and the hint with the resolved credential", () => {
    const { ctx } = context({ api_key: "cfg-key", context_id: WS }, CONFIG_KEY);
    expect(pairWorkspaceCredential(ctx, undefined)).toEqual({
      config: { api_key: "cfg-key", context_id: WS },
      auth: CONFIG_KEY,
      workspaceId: WS,
      workspaceIdHint: WS,
    });
  });

  it("keeps the source's hint when an override picks another workspace", () => {
    const other = "22222222-2222-3333-4444-555555555555";
    const { ctx } = context({ context_id: WS }, CONFIG_KEY);
    const paired = pairWorkspaceCredential(ctx, other, { flag: "--workspace" });
    expect(paired.workspaceId).toBe(other);
    expect(paired.workspaceIdHint).toBe(WS);
  });

  it("refuses a blank --workspace before loading anything", () => {
    const { ctx, calls } = context({}, CONFIG_KEY);
    expect(() =>
      pairWorkspaceCredential(ctx, " ", { flag: "--workspace", refuseBlankOverride: true }),
    ).toThrow(BLANK_OVERRIDE);
    expect(calls).toEqual([]);
  });

  it("falls back to the source for a blank --context-id, as the files commands do", () => {
    const { ctx } = context({}, OAUTH);
    expect(pairWorkspaceCredential(ctx, "").workspaceId).toBe(OAUTH_WS);
  });

  it("reports a bad config file before resolving the credential", () => {
    const { ctx, calls } = context(new Error("Invalid JSON or encoding in .kagura.json"), OAUTH);
    expect(() => pairWorkspaceCredential(ctx, undefined)).toThrow(
      new CliError("Invalid JSON or encoding in .kagura.json"),
    );
    expect(calls).toEqual(["loadConfig"]);
  });

  it("reports a missing credential before pairing", () => {
    const { ctx } = context({}, new KaguraAuthError("No credentials found."));
    expect(() => pairWorkspaceCredential(ctx, WS)).toThrow(new CliError("No credentials found."));
  });

  it("resolves the credential only, with no hint, when no workspace is needed", () => {
    const { ctx } = context({ context_id: WS }, ENV_KEY);
    expect(pairWorkspaceCredential(ctx, undefined, { needsWorkspace: false })).toEqual({
      config: { context_id: WS },
      auth: ENV_KEY,
      workspaceId: "",
      workspaceIdHint: null,
    });
  });
});

describe("pairing through the real credential chain", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-pairing-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function chain(env: Record<string, string>, config: KaguraConfig): ClientCommandContext {
    return {
      loadConfig: () => config,
      resolveAuth: (options?: ResolveAuthOptions) => resolveAuth({ ...options, env, home }),
    } as unknown as ClientCommandContext;
  }

  it("never pairs an env key with .kagura.json's workspace", () => {
    const ctx = chain({ KAGURA_API_KEY: "env-key" }, { api_key: "cfg-key", context_id: WS });
    expect(() => pairWorkspaceCredential(ctx, undefined)).toThrow(ENV_NO_WS);
  });

  it("pairs a .kagura.json key with its own context_id and URL", () => {
    const ctx = chain({}, { api_key: "cfg-key", mcp_url: "https://cfg.test/mcp", context_id: WS });
    const paired = pairWorkspaceCredential(ctx, undefined);
    expect(paired.auth).toMatchObject({ kind: "static", source: "config", mcpUrl: "https://cfg.test/mcp" });
    expect(paired.workspaceId).toBe(WS);
  });

  it("surfaces the resolver's no-credential message", () => {
    const ctx = chain({}, {});
    expect(() => pairWorkspaceCredential(ctx, WS)).toThrow(/^No credentials found\./);
  });
});

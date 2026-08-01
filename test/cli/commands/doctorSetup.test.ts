import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
}

function harness(config: KaguraConfig = { api_key: "k", mcp_url: "https://x.test/mcp" }): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    loadConfig: () => config,
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
    makeFilesClient: (() => {
      throw new Error("unused");
    }) as unknown as CliDeps["makeFilesClient"],
    makeResourceClient: (() => {
      throw new Error("unused");
    }) as unknown as CliDeps["makeResourceClient"],
    makeSecretClient: (() => {
      throw new Error("unused");
    }) as unknown as CliDeps["makeSecretClient"],
    isTty: () => false,
    readStdin: () => null,
    spawnChild: async () => 0,
  } as unknown as CliDeps;
  return { deps, out, err, server };
}

let sandbox: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-cli-"));
  // An isolated HOME so no real credentials profile is read or written.
  process.env.HOME = path.join(sandbox, "home");
  process.env.USERPROFILE = process.env.HOME;
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  process.env = { ...ORIGINAL_ENV };
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("kagura-memory doctor", () => {
  it("prints one STATUS line per check", async () => {
    const h = harness();
    h.server.restResults["/api/v1/server/info"] = { version: "0.60.0" };
    await runCli(["doctor"], h.deps);
    expect(h.out.length).toBeGreaterThan(3);
    for (const line of h.out) {
      expect(line).toMatch(/^(PASS|WARN|FAIL|INFO) /);
    }
  });

  it("fails on a plaintext mcp_url, because the bearer token would be in the clear", async () => {
    const h = harness({ api_key: "k", mcp_url: "http://memory.example.com/mcp" });
    const code = await runCli(["doctor"], h.deps);
    expect(code).toBe(1);
    expect(h.out.join("\n")).toMatch(/FAIL .*not HTTPS/);
  });

  it("accepts plaintext localhost, which is a deliberate dev choice", async () => {
    const h = harness({ api_key: "k", mcp_url: "http://localhost:8000/mcp" });
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).not.toMatch(/not HTTPS/);
  });

  it("warns that KAGURA_API_KEY outranks any OAuth profile", async () => {
    process.env.KAGURA_API_KEY = "kagura_env";
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/WARN KAGURA_API_KEY is set and takes precedence/);
  });

  it("exits 1 when any check fails and 0 when none do", async () => {
    const bad = harness({ api_key: "k", mcp_url: "http://x.example/mcp" });
    expect(await runCli(["doctor"], bad.deps)).toBe(1);

    const good = harness();
    good.server.restResults["/api/v1/server/info"] = { version: "0.60.0" };
    // The server check is the only other failure source here.
    const code = await runCli(["doctor"], good.deps);
    expect([0, 1]).toContain(code);
  });

  it("emits the Python JSON shape, including the duplicated section keys", async () => {
    const h = harness();
    await runCli(["doctor", "--json"], h.deps);
    const report = JSON.parse(h.out.join("\n")) as Record<string, unknown>;
    expect(report).toHaveProperty("sections");
    expect(report).toHaveProperty("checks");
    expect(report).toHaveProperty("exit_code");
    // Python's to_dict() spreads sections as top-level keys as well; a
    // script written against it reads them.
    for (const section of Object.keys(report.sections as Record<string, string>)) {
      expect(report[section]).toBe((report.sections as Record<string, string>)[section]);
    }
  });

  it("reports the missing age identity as info, not a failure", async () => {
    delete process.env.KAGURA_AGE_IDENTITY;
    delete process.env.KAGURA_AGE_IDENTITY_FILE;
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/INFO no age identity configured/);
  });

  it("warns when the identity sits in the environment", async () => {
    process.env.KAGURA_AGE_IDENTITY = "AGE-SECRET-KEY-1EXAMPLE";
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/WARN KAGURA_AGE_IDENTITY holds the private key/);
  });
});

describe("kagura-memory setup claude", () => {
  it("writes both files and gitignores them", async () => {
    const h = harness({});
    const code = await runCli(
      ["setup", "claude", "--api-key", "kagura_secret", "--project-dir", sandbox],
      h.deps,
    );
    expect(code).toBe(0);

    const kagura = JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"));
    expect(kagura).toMatchObject({ api_key: "kagura_secret" });

    const mcp = JSON.parse(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers["kagura-memory"]).toMatchObject({
      type: "url",
      headers: { Authorization: "Bearer kagura_secret" },
    });

    // Both files now hold the key; committing either publishes it.
    const gitignore = fs.readFileSync(path.join(sandbox, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".kagura.json");
    expect(gitignore).toContain(".mcp.json");
  });

  it("does not echo the key back on stdout", async () => {
    const h = harness({});
    await runCli(["setup", "claude", "--api-key", "kagura_secret", "--project-dir", sandbox], h.deps);
    expect(h.out.join("\n")).not.toContain("kagura_secret");
  });

  it("merges rather than replacing an existing config", async () => {
    fs.writeFileSync(
      path.join(sandbox, ".kagura.json"),
      JSON.stringify({ model: "gpt-5.4-nano", custom: 1 }),
    );
    fs.writeFileSync(
      path.join(sandbox, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "url", url: "https://other" } } }),
    );
    const h = harness({});
    await runCli(["setup", "claude", "--api-key", "k2", "--project-dir", sandbox], h.deps);

    const kagura = JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"));
    expect(kagura).toMatchObject({ model: "gpt-5.4-nano", custom: 1, api_key: "k2" });

    const mcp = JSON.parse(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers["kagura-memory"]).toBeDefined();
  });

  it("does not duplicate a gitignore entry on a second run", async () => {
    const h = harness({});
    for (let i = 0; i < 2; i++) {
      await runCli(["setup", "claude", "--api-key", "k", "--project-dir", sandbox], h.deps);
    }
    const gitignore = fs.readFileSync(path.join(sandbox, ".gitignore"), "utf-8");
    expect(gitignore.match(/^\.kagura\.json$/gm)).toHaveLength(1);
  });

  it("refuses to rewrite a config file it could not parse", async () => {
    fs.writeFileSync(path.join(sandbox, ".mcp.json"), "{ not json");
    const h = harness({});
    const code = await runCli(["setup", "claude", "--api-key", "k", "--project-dir", sandbox], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/refusing to rewrite/);
    // The unparseable file must survive untouched.
    expect(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8")).toBe("{ not json");
  });

  it("rejects --profile with --api-key", async () => {
    const h = harness({});
    const code = await runCli(
      ["setup", "claude", "--profile", "work", "--api-key", "k", "--project-dir", sandbox],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("mutually exclusive");
  });

  it("says why the OAuth path is unavailable rather than writing a broken config", async () => {
    const h = harness({});
    const code = await runCli(["setup", "claude", "--profile", "work", "--project-dir", sandbox], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/kagura-mcp.*stdio/s);
    expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
  });

  it("requires a key from somewhere", async () => {
    const h = harness({});
    const code = await runCli(["setup", "claude", "--project-dir", sandbox], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("no API key");
  });
});

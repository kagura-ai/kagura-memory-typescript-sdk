import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-cwd-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-home-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("prefers ./.kagura.json over home and env", () => {
    fs.writeFileSync(path.join(cwd, ".kagura.json"), JSON.stringify({ api_key: "local" }));
    fs.writeFileSync(path.join(home, ".kagura.json"), JSON.stringify({ api_key: "home" }));
    const config = loadConfig({ cwd, home, env: { KAGURA_API_KEY: "env" } });
    expect(config.api_key).toBe("local");
  });

  it("falls back to ~/.kagura.json", () => {
    fs.writeFileSync(path.join(home, ".kagura.json"), JSON.stringify({ api_key: "home" }));
    const config = loadConfig({ cwd, home, env: {} });
    expect(config.api_key).toBe("home");
  });

  it("falls back to env vars with defaults", () => {
    const config = loadConfig({
      cwd,
      home,
      env: { KAGURA_API_KEY: "env-key", KAGURA_CONTEXT_ID: "ctx" },
    });
    expect(config.api_key).toBe("env-key");
    expect(config.mcp_url).toBe("https://memory.kagura-ai.com/mcp");
    expect(config.model).toBe("gpt-5.4-nano");
    expect(config.context_id).toBe("ctx");
  });

  it("returns empty api_key and null context_id when nothing is set", () => {
    const config = loadConfig({ cwd, home, env: {} });
    expect(config.api_key).toBe("");
    expect(config.context_id).toBeNull();
  });

  it("throws a helpful error for invalid JSON", () => {
    fs.writeFileSync(path.join(cwd, ".kagura.json"), "{not json");
    expect(() => loadConfig({ cwd, home, env: {} })).toThrow(/Invalid JSON/);
  });

  it("throws for a non-object JSON body", () => {
    fs.writeFileSync(path.join(cwd, ".kagura.json"), "[1,2]");
    expect(() => loadConfig({ cwd, home, env: {} })).toThrow(/Invalid JSON/);
  });

  it("preserves unknown keys from the file", () => {
    fs.writeFileSync(
      path.join(cwd, ".kagura.json"),
      JSON.stringify({ api_key: "k", custom: 42 }),
    );
    const config = loadConfig({ cwd, home, env: {} });
    expect(config.custom).toBe(42);
  });
});

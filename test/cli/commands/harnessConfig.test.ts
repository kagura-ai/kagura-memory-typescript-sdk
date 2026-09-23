import { describe, expect, it } from "vitest";

import {
  codexTomlBlock,
  hermesEnvVar,
  hermesYamlBlock,
  json5HasServer,
  openclawBlock,
  pluginServerUrl,
  queryParam,
  shellCommand,
  tomlHasServer,
  upsertEnvLine,
  withQueryParam,
  yamlHasServer,
} from "../../../src/cli/commands/harnessConfig.js";

const UUID = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";

describe("withQueryParam", () => {
  it("adds the first parameter with ?", () => {
    expect(withQueryParam("https://x.test/mcp", "guardrails", "off")).toBe(
      "https://x.test/mcp?guardrails=off",
    );
  });

  it("joins with & and keeps every other parameter byte-for-byte", () => {
    // Re-serialising through URLSearchParams would turn `tools=a,b` into
    // `tools=a%2Cb`; the server reads both, but "kept" means kept.
    expect(withQueryParam("https://x.test/mcp?profile=core&tools=a,b", "guardrails", "off")).toBe(
      "https://x.test/mcp?profile=core&tools=a,b&guardrails=off",
    );
  });

  it("replaces an existing value in place and drops repeats", () => {
    expect(
      withQueryParam(`https://x.test/mcp?guardrails=${UUID}&profile=core&guardrails=x`, "guardrails", "off"),
    ).toBe("https://x.test/mcp?guardrails=off&profile=core");
  });

  it("does not mistake a parameter whose name merely starts the same", () => {
    expect(withQueryParam("https://x.test/mcp?guardrails_x=1", "guardrails", "off")).toBe(
      "https://x.test/mcp?guardrails_x=1&guardrails=off",
    );
  });

  it("keeps a fragment after the query", () => {
    expect(withQueryParam("https://x.test/mcp#frag", "profile", "core")).toBe(
      "https://x.test/mcp?profile=core#frag",
    );
  });
});

describe("queryParam", () => {
  it("reads a value, or undefined when absent", () => {
    expect(queryParam("https://x.test/mcp?profile=core&guardrails=off", "guardrails")).toBe("off");
    expect(queryParam("https://x.test/mcp?profile=core", "guardrails")).toBeUndefined();
    expect(queryParam("https://x.test/mcp", "guardrails")).toBeUndefined();
  });
});

describe("pluginServerUrl", () => {
  it("drops the query", () => {
    expect(pluginServerUrl(`https://x.test/mcp?profile=core&guardrails=${UUID}`)).toBe(
      "https://x.test/mcp",
    );
  });

  it("keeps guardrails=off and nothing else", () => {
    expect(pluginServerUrl("https://x.test/mcp?profile=core&guardrails=OFF")).toBe(
      "https://x.test/mcp?guardrails=off",
    );
  });
});

describe("upsertEnvLine", () => {
  it("appends to an empty file", () => {
    expect(upsertEnvLine("", "KAGURA_API_KEY", "k1")).toBe("KAGURA_API_KEY=k1\n");
  });

  it("appends after existing lines, adding the missing final newline", () => {
    expect(upsertEnvLine("A=1", "KAGURA_API_KEY", "k1")).toBe("A=1\nKAGURA_API_KEY=k1\n");
  });

  it("replaces the existing line in place rather than adding a duplicate", () => {
    const before = "A=1\nKAGURA_API_KEY=old\nB=2\n";
    expect(upsertEnvLine(before, "KAGURA_API_KEY", "new")).toBe("A=1\nKAGURA_API_KEY=new\nB=2\n");
  });

  it("collapses repeated lines, so the new value is the only one", () => {
    const before = "KAGURA_API_KEY=a\nB=2\nKAGURA_API_KEY=b\n";
    expect(upsertEnvLine(before, "KAGURA_API_KEY", "new")).toBe("KAGURA_API_KEY=new\nB=2\n");
  });

  it("keeps an export prefix, CRLF endings, comments and look-alike names", () => {
    const before = "# KAGURA_API_KEY=commented\r\nexport KAGURA_API_KEY = old\r\nKAGURA_API_KEY_2=x\r\n";
    expect(upsertEnvLine(before, "KAGURA_API_KEY", "new")).toBe(
      "# KAGURA_API_KEY=commented\r\nexport KAGURA_API_KEY=new\r\nKAGURA_API_KEY_2=x\r\n",
    );
  });

  it("refuses a value with a line break, which would inject a second line", () => {
    expect(() => upsertEnvLine("", "KAGURA_API_KEY", "k\nPATH=/tmp")).toThrow(/line break/);
  });
});

describe("tomlHasServer", () => {
  it.each([
    "[mcp_servers.kagura-memory]\nurl = 'x'",
    '[mcp_servers."kagura-memory"]\nurl = "x"',
    "[ mcp_servers . kagura-memory ]",
    "[mcp_servers.kagura-memory.env]\nA = '1'",
    "mcp_servers.kagura-memory.url = 'x'",
    "[mcp_servers]\nkagura-memory = { url = 'x' }",
    "mcp_servers = { kagura-memory = { url = 'x' } }",
  ])("finds the entry in %j", (text) => {
    expect(tomlHasServer(text, "kagura-memory")).toBe(true);
  });

  it.each([
    "",
    "[mcp_servers.other]\nurl = 'x'",
    "[mcp_servers.kagura-memory-old]",
    "[profiles]\nkagura-memory = 'x'",
    "# [mcp_servers.kagura-memory]",
  ])("does not find it in %j", (text) => {
    expect(tomlHasServer(text, "kagura-memory")).toBe(false);
  });
});

describe("yamlHasServer", () => {
  it.each([
    "mcp_servers:\n  kagura-memory:\n    url: x",
    "model: m\nmcp_servers:\n  # note\n\n  other:\n    url: y\n  'kagura-memory':\n    url: x",
    "mcp_servers: { kagura-memory: { url: x } }",
  ])("finds the entry in %j", (text) => {
    expect(yamlHasServer(text, "kagura-memory")).toBe(true);
  });

  it.each([
    "",
    "mcp_servers:\n  other:\n    url: y",
    "mcp_servers:\n  other:\n    url: y\nplugins:\n  kagura-memory:\n    on: true",
    "kagura-memory:\n  url: x",
  ])("does not find it in %j", (text) => {
    expect(yamlHasServer(text, "kagura-memory")).toBe(false);
  });
});

describe("json5HasServer", () => {
  it("reads plain JSON exactly", () => {
    expect(json5HasServer('{"mcp":{"servers":{"kagura-memory":{}}}}', "kagura-memory")).toBe(true);
    expect(json5HasServer('{"mcp":{"servers":{"other":{}}},"x":{"kagura-memory":1}}', "kagura-memory")).toBe(
      false,
    );
  });

  it("falls back to a key scan for JSON5, erring toward 'exists'", () => {
    const json5 = "{\n  // comment\n  mcp: { servers: { 'kagura-memory': { url: 'x' }, }, },\n}";
    expect(json5HasServer(json5, "kagura-memory")).toBe(true);
    expect(json5HasServer("{ mcp: { servers: {} }, }", "kagura-memory")).toBe(false);
  });

  it("treats an empty file as no entry", () => {
    expect(json5HasServer("", "kagura-memory")).toBe(false);
  });
});

describe("blocks", () => {
  it("codex: exactly url and bearer_token_env_var", () => {
    expect(codexTomlBlock("kagura-memory", "https://x.test/mcp?guardrails=off")).toBe(
      '[mcp_servers.kagura-memory]\nurl = "https://x.test/mcp?guardrails=off"\nbearer_token_env_var = "KAGURA_API_KEY"',
    );
  });

  it("hermes: derives the variable the way `hermes mcp add` does", () => {
    expect(hermesEnvVar("kagura-memory")).toBe("MCP_KAGURA_MEMORY_API_KEY");
    expect(hermesYamlBlock("kagura-memory", "https://x.test/mcp", "MCP_KAGURA_MEMORY_API_KEY")).toBe(
      [
        "mcp_servers:",
        "  kagura-memory:",
        '    url: "https://x.test/mcp"',
        "    headers:",
        '      Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}"',
      ].join("\n"),
    );
  });

  it("openclaw: streamable-http is explicit, and the header is a variable reference", () => {
    const parsed = JSON.parse(openclawBlock("kagura-memory", "https://x.test/mcp"));
    expect(parsed).toEqual({
      mcp: {
        servers: {
          "kagura-memory": {
            url: "https://x.test/mcp",
            transport: "streamable-http",
            headers: { Authorization: "Bearer ${KAGURA_API_KEY}" },
          },
        },
      },
    });
  });
});

describe("shellCommand", () => {
  it("quotes only what the shell would reinterpret", () => {
    const argv = [
      "openclaw",
      "mcp",
      "add",
      "--url",
      "https://x.test/mcp?a=1&b=2",
      "--header",
      "Authorization=Bearer ${KAGURA_API_KEY}",
    ];
    expect(shellCommand(argv)).toBe(
      "openclaw mcp add --url 'https://x.test/mcp?a=1&b=2' --header 'Authorization=Bearer ${KAGURA_API_KEY}'",
    );
  });

  it("escapes a single quote", () => {
    expect(shellCommand(["echo", "it's"])).toBe("echo 'it'\\''s'");
  });
});

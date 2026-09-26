import { describe, expect, it } from "vitest";

import {
  codexTomlBlock,
  codexTomlOauthBlock,
  hermesEnvVar,
  hermesYamlBlock,
  hermesYamlOauthBlock,
  isHttpUrl,
  json5HasServer,
  mcpUrlWithQuery,
  normalizeUrl,
  openclawBlock,
  openclawOauthBlock,
  openclawOauthEntry,
  pluginServerUrl,
  queryParam,
  shellCommand,
  tomlHasServer,
  withoutQuery,
  withoutQueryParam,
  yamlHasServer,
  yamlServersIndent,
  yamlServersInline,
} from "../../../src/cli/commands/harnessConfig.js";

const UUID = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";

describe("mcpUrlWithQuery", () => {
  it("adds the first parameter with ?", () => {
    expect(mcpUrlWithQuery("https://x.test/mcp", { guardrails: "off" })).toBe(
      "https://x.test/mcp?guardrails=off",
    );
  });

  it("joins with & and keeps every other parameter byte-for-byte", () => {
    // Re-serialising through URLSearchParams would turn `tools=a,b` into
    // `tools=a%2Cb`; the server reads both, but "kept" means kept.
    expect(mcpUrlWithQuery("https://x.test/mcp?profile=core&tools=a,b", { guardrails: "off" })).toBe(
      "https://x.test/mcp?profile=core&tools=a,b&guardrails=off",
    );
  });

  it("puts guardrails before profile, both after the kept parameters, as Python does", () => {
    expect(
      mcpUrlWithQuery("https://x.test/mcp?profile=full&tools=a", { guardrails: UUID, profile: "core" }),
    ).toBe(`https://x.test/mcp?tools=a&guardrails=${UUID}&profile=core`);
  });

  it("moves a key it sets to the end and drops every earlier value of it", () => {
    // The server reads the first value it finds, so a stale one must go.
    expect(
      mcpUrlWithQuery(`https://x.test/mcp?guardrails=${UUID}&profile=core&guardrails=x`, { guardrails: "off" }),
    ).toBe("https://x.test/mcp?profile=core&guardrails=off");
  });

  it("leaves a key it does not set where it stands", () => {
    expect(mcpUrlWithQuery(`https://x.test/mcp?guardrails=${UUID}&tools=a`, { profile: "core" })).toBe(
      `https://x.test/mcp?guardrails=${UUID}&tools=a&profile=core`,
    );
  });

  it("matches a key by its decoded name", () => {
    expect(mcpUrlWithQuery("https://x.test/mcp?guard%72ails=x&a=1", { guardrails: "off" })).toBe(
      "https://x.test/mcp?a=1&guardrails=off",
    );
  });

  it("does not mistake a parameter whose name merely starts the same", () => {
    expect(mcpUrlWithQuery("https://x.test/mcp?guardrails_x=1", { guardrails: "off" })).toBe(
      "https://x.test/mcp?guardrails_x=1&guardrails=off",
    );
  });

  it("form-encodes a value as Python's urlencode does", () => {
    expect(mcpUrlWithQuery("https://x.test/mcp", { profile: "a b!(c)~" })).toBe(
      "https://x.test/mcp?profile=a+b%21%28c%29~",
    );
  });

  it("returns the URL untouched when nothing is set", () => {
    expect(mcpUrlWithQuery("https://x.test/mcp?b=2&a=1", {})).toBe("https://x.test/mcp?b=2&a=1");
  });

  it("keeps a fragment after the query", () => {
    expect(mcpUrlWithQuery("https://x.test/mcp#frag", { profile: "core" })).toBe(
      "https://x.test/mcp?profile=core#frag",
    );
  });
});

describe("withoutQueryParam", () => {
  it("drops every occurrence and keeps the rest as written", () => {
    expect(
      withoutQueryParam(`https://x.test/mcp?guardrails=${UUID}&tools=a,b&guardrails=off#f`, "guardrails"),
    ).toBe("https://x.test/mcp?tools=a,b#f");
  });

  it("leaves no bare ? behind", () => {
    expect(withoutQueryParam("https://x.test/mcp?guardrails=off", "guardrails")).toBe("https://x.test/mcp");
    expect(withoutQueryParam("https://x.test/mcp", "guardrails")).toBe("https://x.test/mcp");
  });

  it("matches names decoded, as the server reads them", () => {
    // parse_qsl decodes names: guard%72ails and guard+rails-less spellings.
    expect(withoutQueryParam(`https://x.test/mcp?guard%72ails=${UUID}&a=1`, "guardrails")).toBe(
      "https://x.test/mcp?a=1",
    );
    expect(withoutQueryParam("https://x.test/mcp?guardrails_x=1", "guardrails")).toBe(
      "https://x.test/mcp?guardrails_x=1",
    );
  });

  it("returns a URL without the key as written, as Python does", () => {
    expect(withoutQueryParam("https://x.test/mcp?a=1&&b=2&", "guardrails")).toBe("https://x.test/mcp?a=1&&b=2&");
  });
});

describe("a URL the query edits rewrite", () => {
  // Python rebuilds it through urlunsplit(urlsplit(url)), which lower-cases
  // the scheme and writes no `#` for an empty fragment; the host, the path
  // and every kept parameter stay as written. Each row is Python's output.
  it.each([
    ["HTTP://X.test/mcp", "http://X.test/mcp?guardrails=off", "HTTP://X.test/mcp"],
    [
      "HtTpS://X.TEST/Mcp?guardrails=a&tools=a,b#Frag",
      "https://X.TEST/Mcp?tools=a,b&guardrails=off#Frag",
      "https://X.TEST/Mcp?tools=a,b#Frag",
    ],
    ["https://x.test/mcp?a=1#", "https://x.test/mcp?a=1&guardrails=off", "https://x.test/mcp?a=1#"],
    ["HTTPS://x.test/mcp#", "https://x.test/mcp?guardrails=off", "HTTPS://x.test/mcp#"],
    ["HTTPS://x.test/mcp?guardrails=x#", "https://x.test/mcp?guardrails=off", "https://x.test/mcp"],
    ["HTTPS://x.test/mcp?tools=a", "https://x.test/mcp?tools=a&guardrails=off", "HTTPS://x.test/mcp?tools=a"],
  ])("%s: set %s, dropped %s", (url, set, dropped) => {
    expect(mcpUrlWithQuery(url, { guardrails: "off" })).toBe(set);
    expect(withoutQueryParam(url, "guardrails")).toBe(dropped);
  });

  it("is left as written when there is nothing to set", () => {
    expect(mcpUrlWithQuery("HTTPS://x.test/mcp?tools=a#", {})).toBe("HTTPS://x.test/mcp?tools=a#");
  });
});

describe("withoutQuery", () => {
  it("drops the query and the fragment, and keeps the path", () => {
    expect(withoutQuery("https://x.test/mcp/w/ws1?profile=core&tools=a,b#f")).toBe("https://x.test/mcp/w/ws1");
    expect(withoutQuery("https://x.test/mcp")).toBe("https://x.test/mcp");
  });
});

describe("queryParam", () => {
  it("reads a value, or undefined when absent", () => {
    expect(queryParam("https://x.test/mcp?profile=core&guardrails=off", "guardrails")).toBe("off");
    expect(queryParam("https://x.test/mcp?profile=core", "guardrails")).toBeUndefined();
    expect(queryParam("https://x.test/mcp", "guardrails")).toBeUndefined();
  });

  it("reads the first value, the one the server reads, by its decoded name", () => {
    expect(queryParam(`https://x.test/mcp?guard%72ails=${UUID}&guardrails=off`, "guardrails")).toBe(UUID);
    expect(queryParam("https://x.test/mcp?guardrails", "guardrails")).toBe("");
    expect(queryParam("https://x.test/mcp?guardrails=a+b%21", "guardrails")).toBe("a b!");
  });
});

describe("normalizeUrl", () => {
  // Python's test__http.py table (python-sdk#279).
  it.each([
    ["  https://h.example/mcp\n", "https://h.example/mcp"],
    ["\x00\x1fhttps://h.example/mcp\u3000", "https://h.example/mcp"],
    ["ht\ttps://h.exa\nmple/m\rcp", "https://h.example/mcp"],
    ["\u00a0https://h.example/mcp\u0085", "https://h.example/mcp"],
    ["HTTPS://H.example/a b", "HTTPS://H.example/a b"],
  ])("reads %j as %j", (given, expected) => {
    expect(normalizeUrl(given)).toBe(expected);
  });

  it("keeps a BOM, which is no whitespace to Python", () => {
    expect(normalizeUrl("\ufeffhttps://h.example/mcp")).toBe("\ufeffhttps://h.example/mcp");
  });
});

describe("isHttpUrl", () => {
  it.each([
    "https://memory.kagura-ai.com/mcp/w/ws",
    "HTTPS://h.example",
    "http://localhost:8080/mcp",
    "https://[::1]:8443/mcp",
    "https://[fe80::1%eth0]/mcp",
    "https://[v1.x]/mcp",
    "https://user@[::1]/mcp",
    "https://@/mcp",
    "https://h:abc/",
    "https://\u00e9xample.com/mcp",
  ])("takes %j, as urlsplit reads a host in it", (url) => {
    expect(isHttpUrl(url)).toBe(true);
  });

  it.each([
    "",
    "--help",
    "memory.kagura-ai.com/mcp",
    "localhost:8080/mcp",
    "ftp://h.example/mcp",
    "https:h.example",
    "https:/h.example",
    "https://",
    "https:///mcp",
    "https://?q",
    "https://#f",
    "https+x://h.example",
    "https://[::1/mcp",
    "https://]x/mcp",
    "https://[notipv6]/mcp",
    "https://[1.2.3.4]/mcp",
    "https://a[b]c/mcp",
    "https://[::1]x/mcp",
    "https://x[::1]/mcp",
    "https://[vz.x]/mcp",
    "https://\u2100.example/mcp",
    "https://h\uff03x/mcp",
  ])("refuses %j, where urlsplit raises or finds no http(s) host", (url) => {
    expect(isHttpUrl(url)).toBe(false);
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
    // Python strips the value before comparing it.
    expect(pluginServerUrl("https://x.test/mcp?guardrails=+off")).toBe("https://x.test/mcp?guardrails=off");
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

describe("yamlHasServer behind a BOM or a quoted key", () => {
  it("still finds the entry", () => {
    expect(yamlHasServer("\uFEFFmcp_servers:\n  kagura-memory:\n    url: x", "kagura-memory")).toBe(true);
    expect(yamlHasServer('"mcp_servers":\n  kagura-memory:\n    url: x', "kagura-memory")).toBe(true);
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

describe("yamlServersIndent", () => {
  it("is null without a top-level mcp_servers key", () => {
    expect(yamlServersIndent("")).toBeNull();
    expect(yamlServersIndent("model: x\nplugins:\n  mcp_servers:\n    a: 1")).toBeNull();
  });

  it("copies the indentation of the entries already under it", () => {
    expect(yamlServersIndent('mcp_servers:\n  other:\n    url: "https://o"')).toBe("  ");
    expect(yamlServersIndent("model: x\nmcp_servers:\n\n    # a note\n    other:\n      url: y")).toBe("    ");
  });

  it("finds the key behind a BOM or in quotes", () => {
    expect(yamlServersIndent('\uFEFFmcp_servers:\n  other:\n    url: y')).toBe("  ");
    expect(yamlServersIndent('"mcp_servers":\n    other: {}')).toBe("    ");
    expect(yamlServersIndent("'mcp_servers':")).toBe("  ");
  });

  it("uses two spaces when the key has no block entries to copy from", () => {
    expect(yamlServersIndent("mcp_servers:\nmodel: x")).toBe("  ");
    expect(yamlServersIndent("mcp_servers: {}")).toBe("  ");
    expect(yamlServersIndent("mcp_servers:")).toBe("  ");
  });
});

describe("yamlServersInline", () => {
  it("is true when the key's value is written inline, flow style or null", () => {
    expect(yamlServersInline("mcp_servers: {}")).toBe(true);
    expect(yamlServersInline("mcp_servers: {other: {url: x}}")).toBe(true);
    expect(yamlServersInline("mcp_servers: null")).toBe(true);
    expect(yamlServersInline('"mcp_servers": ~')).toBe(true);
  });

  it("is false for a block mapping, a bare key, or no key", () => {
    expect(yamlServersInline("mcp_servers:\n  other:\n    url: y")).toBe(false);
    expect(yamlServersInline("mcp_servers:   # servers below")).toBe(false);
    expect(yamlServersInline("mcp_servers:")).toBe(false);
    expect(yamlServersInline("model: x")).toBe(false);
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
    // --api-key-env names another variable.
    expect(codexTomlBlock("kagura-memory", "https://x.test/mcp", "KAGURA_CODEX_KEY")).toBe(
      '[mcp_servers.kagura-memory]\nurl = "https://x.test/mcp"\nbearer_token_env_var = "KAGURA_CODEX_KEY"',
    );
  });

  it("hermes: derives the variable the way `hermes mcp add` does", () => {
    expect(hermesEnvVar("kagura-memory")).toBe("MCP_KAGURA_MEMORY_API_KEY");
    // Hermes strips the underscores a leading or trailing '-' or '_' leaves.
    expect(hermesEnvVar("kagura_")).toBe("MCP_KAGURA_API_KEY");
    expect(hermesEnvVar("-kagura-")).toBe("MCP_KAGURA_API_KEY");
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

  it("hermes: the entry alone, at the given indent, for a file that has mcp_servers already", () => {
    // Appended as a second top-level mcp_servers key, the full block would
    // replace the servers already there: YAML keeps the last one.
    expect(hermesYamlBlock("kagura-memory", "https://x.test/mcp", "MCP_KAGURA_MEMORY_API_KEY", "    ")).toBe(
      [
        "    kagura-memory:",
        '      url: "https://x.test/mcp"',
        "      headers:",
        '        Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}"',
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
    const renamed = JSON.parse(openclawBlock("kagura-memory", "https://x.test/mcp", "OC_KEY"));
    expect(renamed.mcp.servers["kagura-memory"].headers).toEqual({ Authorization: "Bearer ${OC_KEY}" });
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

describe("the --oauth entries (python-sdk#282)", () => {
  const url = "http://127.0.0.1:47701/mcp/w/ws-1";

  it("codex: the table has only url, so Codex's auth defaults to OAuth", () => {
    expect(codexTomlOauthBlock("kagura-memory", url)).toBe(
      '[mcp_servers.kagura-memory]\nurl = "http://127.0.0.1:47701/mcp/w/ws-1"',
    );
  });

  it("hermes: url and auth: oauth, whole or under an existing mcp_servers key", () => {
    expect(hermesYamlOauthBlock("kagura-memory", url)).toBe(
      'mcp_servers:\n  kagura-memory:\n    url: "http://127.0.0.1:47701/mcp/w/ws-1"\n    auth: oauth',
    );
    expect(hermesYamlOauthBlock("kagura-memory", url, "    ")).toBe(
      '    kagura-memory:\n      url: "http://127.0.0.1:47701/mcp/w/ws-1"\n      auth: oauth',
    );
  });

  it("openclaw: streamable-http with auth oauth and no headers", () => {
    expect(openclawOauthEntry(url)).toEqual({ url, transport: "streamable-http", auth: "oauth" });
    expect(JSON.parse(openclawOauthBlock("kagura-memory", url))).toEqual({
      mcp: { servers: { "kagura-memory": { url, transport: "streamable-http", auth: "oauth" } } },
    });
  });
});

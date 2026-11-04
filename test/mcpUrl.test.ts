/**
 * The MCP URL's endpoint query: the one composer (`mcpUrlWithQuery`) and
 * the one reader (`mcpUrlToolView`) every command shares (#83).
 *
 * Each case's expected value was recorded from the Python SDK 0.44.0 —
 * `mcp_url_with_query`, `mcp_url_tool_view`, `normalize_add_tools`,
 * `normalize_tool_profile` (kagura_memory/_http.py) — called with the same
 * arguments, so both SDKs write and read one URL alike, and as memory-cloud
 * reads it (`select_tool_definitions`, `select_default_context`:
 * `parse_qsl(keep_blank_values=True)`, the first value wins).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_ADD_TOOLS,
  mcpQueryToolView,
  mcpUrlGuardrailsOff,
  mcpUrlQueryValues,
  mcpUrlToolView,
  mcpUrlWithQuery,
  normalizeAddTools,
  normalizeGuardrails,
  normalizeToolProfile,
  parseMcpUrl,
  queryParam,
  readAddToolsFlag,
  splitWithoutQueryParam,
  withoutQuery,
  withoutQueryParam,
  type McpUrlQuery,
} from "../src/http.js";

const B = "https://memory.example.com/mcp/w/ws";
const U = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
const names = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe("mcpUrlWithQuery", () => {
  // [url, updates, Python's mcp_url_with_query(url, **kwargs)]
  it.each<[string, McpUrlQuery, string]>([
    [B, {}, B],
    [B, { addTools: ["explore"], context: U }, `${B}?add_tools=explore&context=${U}`],
    [
      B,
      { addTools: ["explore, list_edges", "explore", " "], profile: "core" },
      `${B}?profile=core&add_tools=explore,list_edges`,
    ],
    [
      B,
      { guardrails: "off", profile: "full", addTools: ["explore"], context: U },
      `${B}?guardrails=off&profile=full&add_tools=explore&context=${U}`,
    ],
    // Every earlier value of a key it sets goes; the rest stays, in place.
    [
      `${B}?profile=full&add_tools=x&context=old&tools=recall`,
      { addTools: ["explore"], context: U },
      `${B}?profile=full&tools=recall&add_tools=explore&context=${U}`,
    ],
    // Names compare decoded; the fragment stays last.
    [`${B}?add_tools=a&add%5Ftools=b&keep=1#frag`, { addTools: ["c"] }, `${B}?keep=1&add_tools=c#frag`],
    // A kept parameter is not re-encoded; a context in any uuid.UUID spelling is written canonically.
    [`${B}?x=a%2Cb&y=1`, { context: `{${U.toUpperCase()}}` }, `${B}?x=a%2Cb&y=1&context=${U}`],
    // A list naming no tool leaves the key alone.
    [B, { addTools: [] }, B],
    [B, { addTools: [" , "] }, B],
    // Rebuilt as urlunsplit rebuilds it: the scheme lower-cased, the host as written.
    ["HTTPS://Memory.example.com/mcp?", { context: U }, `https://Memory.example.com/mcp?context=${U}`],
    // Form-encoded with commas literal (urlencode(…, safe=",")).
    [B, { profile: "a b" }, `${B}?profile=a+b`],
    [B, { addTools: ["a+b", "c&d"] }, `${B}?add_tools=a%2Bb,c%26d`],
  ])("%s with %j is Python's %s", (url, updates, expected) => {
    expect(mcpUrlWithQuery(url, updates)).toBe(expected);
  });

  it("writes tools, which Python never sets, between profile and add_tools, read like add_tools", () => {
    expect(mcpUrlWithQuery(`${B}?tools=old`, { tools: [" recall", "remember,recall"], addTools: ["x"] })).toBe(
      `${B}?tools=recall,remember&add_tools=x`,
    );
    expect(mcpUrlWithQuery(`${B}?tools=old`, { tools: [] })).toBe(`${B}?tools=old`);
  });

  it("writes a dry run's guardrails placeholder unencoded with guardrailsAsIs, the other keys encoded (#105)", () => {
    const placeholder = "<UUID of context my proj>";
    expect(mcpUrlWithQuery(B, { guardrails: placeholder, addTools: ["a b"] }, { guardrailsAsIs: true })).toBe(
      `${B}?guardrails=${placeholder}&add_tools=a+b`,
    );
    // Without the option the placeholder is validated, and refused.
    expect(() => mcpUrlWithQuery(B, { guardrails: placeholder })).toThrow(
      new Error(`guardrails must be 'off' or a context UUID, got '${placeholder}'`),
    );
  });

  it("trims the profile it writes", () => {
    expect(mcpUrlWithQuery(B, { profile: " core " })).toBe(`${B}?profile=core`);
  });

  // Python's ValueError texts, from the same calls.
  it.each<[McpUrlQuery, string]>([
    [{ context: "nope" }, "context must be a UUID, got 'nope'"],
    [{ context: "" }, "context must be a UUID, got ''"],
    [{ addTools: ["-x"] }, "add_tools names cannot start with '-': '-x'"],
    [{ addTools: ["a", "-b"] }, "add_tools names cannot start with '-': '-b'"],
    [{ addTools: names(101) }, "add_tools accepts at most 100 tool names, got 101"],
    [{ profile: "" }, "tool_profile must not be empty"],
    [{ profile: "-x" }, "tool_profile cannot start with '-': '-x'"],
    [{ tools: ["-x"] }, "tools names cannot start with '-': '-x'"],
  ])("refuses %j before writing anything", (updates, message) => {
    expect(() => mcpUrlWithQuery(B, updates)).toThrow(new Error(message));
  });

  it("refuses a string for a name list, which would be read a character at a time", () => {
    expect(() => mcpUrlWithQuery(B, { addTools: "explore" as unknown as string[] })).toThrow(
      new TypeError("add_tools must be a list of tool names, not a str"),
    );
    expect(() => mcpUrlWithQuery(B, { addTools: [5 as unknown as string] })).toThrow(TypeError);
  });

  // Python's `type(item).__name__` in normalize_add_tools' TypeError.
  it.each<[unknown, string]>([
    [5, "int"],
    [1.5, "float"],
    [null, "NoneType"],
    [true, "bool"],
    [["x"], "list"],
    [{}, "dict"],
  ])("names a %j item by its Python type", (item, name) => {
    expect(() => normalizeAddTools(["ok", item as string])).toThrow(
      new TypeError(`add_tools items must be str, got ${name}`),
    );
  });

  it("validates guardrails as normalizeGuardrails does, unless shown as is", () => {
    expect(mcpUrlWithQuery(B, { guardrails: " OFF " })).toBe(`${B}?guardrails=off`);
    expect(mcpUrlWithQuery(B, { guardrails: `{${U.toUpperCase()}}` })).toBe(`${B}?guardrails=${U}`);
    expect(() => mcpUrlWithQuery(B, { guardrails: "on" })).toThrow(
      new Error("guardrails must be 'off' or a context UUID, got 'on'"),
    );
    expect(() => mcpUrlWithQuery(B, { guardrails: "" })).toThrow(
      new Error("guardrails must be 'off' or a context UUID, got ''"),
    );
    expect(mcpUrlWithQuery(B, { guardrails: "<UUID of context x>" }, { guardrailsAsIs: true })).toBe(
      `${B}?guardrails=<UUID of context x>`,
    );
  });
});

describe("normalizeAddTools / normalizeToolProfile / normalizeGuardrails", () => {
  it("joins names as the server reads them, as Python's normalize_add_tools does", () => {
    expect(normalizeAddTools([])).toBe("");
    expect(normalizeAddTools([""])).toBe("");
    expect(normalizeAddTools(["a,,b, a"])).toBe("a,b");
    // Exactly 100 is fine; the cap is the server's MAX_TOOL_NAMES.
    expect(normalizeAddTools(names(100)).split(",")).toHaveLength(MAX_ADD_TOOLS);
    // Duplicates are dropped before counting.
    expect(normalizeAddTools([...names(100), "t0"]).split(",")).toHaveLength(100);
  });

  it.each([
    ["", "tool_profile must not be empty"],
    [" ", "tool_profile must not be empty"],
    ["-x", "tool_profile cannot start with '-': '-x'"],
  ])("normalizeToolProfile(%j) refuses it in Python's words", (value, message) => {
    expect(() => normalizeToolProfile(value)).toThrow(new Error(message));
  });

  it("normalizeToolProfile trims", () => {
    expect(normalizeToolProfile(" core ")).toBe("core");
  });

  it("normalizeGuardrails takes off in any case or a UUID in any spelling, canonically", () => {
    expect(normalizeGuardrails(" OFF ")).toBe("off");
    expect(normalizeGuardrails(`urn:uuid:${U.toUpperCase()}`)).toBe(U);
    expect(() => normalizeGuardrails("on")).toThrow(new Error("guardrails must be 'off' or a context UUID, got 'on'"));
  });
});

describe("readAddToolsFlag (the CLI's and the proxy's --add-tools check)", () => {
  it.each<[string[], { names: string[] } | { problem: string }]>([
    [[], { names: [] }],
    [["explore", " list_edges,explore"], { names: ["explore", "list_edges"] }],
    [["explore", " , "], { problem: "must name at least one tool" }],
    [[""], { problem: "must name at least one tool" }],
    [["a,-b"], { problem: "add_tools names cannot start with '-': '-b'" }],
    // Each value is checked first, in order, as click and argparse check them.
    [["", "-x"], { problem: "must name at least one tool" }],
    [["-x", ""], { problem: "add_tools names cannot start with '-': '-x'" }],
    [[names(60).join(","), names(101).slice(60).join(",")], { problem: "add_tools accepts at most 100 tool names, got 101" }],
  ])("reads %j", (values, expected) => {
    expect(readAddToolsFlag(values)).toEqual(expected);
  });
});

describe("mcpUrlToolView", () => {
  // [url, Python's mcp_url_tool_view(url)]
  it.each<[string, { profile: string | null; tools: string[] | null; addTools: string[] }]>([
    [B, { profile: null, tools: null, addTools: [] }],
    [`${B}?profile=full`, { profile: "full", tools: null, addTools: [] }],
    [`${B}?profile=%20core%20`, { profile: "core", tools: null, addTools: [] }],
    // A blank profile is present, not absent: the server refuses it.
    [`${B}?profile=`, { profile: "", tools: null, addTools: [] }],
    [`${B}?profile`, { profile: "", tools: null, addTools: [] }],
    // The first value wins, even a blank one.
    [`${B}?profile=&profile=full`, { profile: "", tools: null, addTools: [] }],
    [`${B}?profile=full&profile=core`, { profile: "full", tools: null, addTools: [] }],
    [`${B}?tools=`, { profile: null, tools: [], addTools: [] }],
    [`${B}?tools=recall,%20remember,recall,,`, { profile: null, tools: ["recall", "remember"], addTools: [] }],
    [`${B}?tools=recall&tools=remember`, { profile: null, tools: ["recall"], addTools: [] }],
    [`${B}?add_tools=explore&add_tools=list_edges`, { profile: null, tools: null, addTools: ["explore"] }],
    [
      `${B}?add_tools=+explore+,list_edges&profile=core`,
      { profile: "core", tools: null, addTools: ["explore", "list_edges"] },
    ],
    // Which key wins is the caller's: all three are read.
    [`${B}?tools=recall&add_tools=explore&profile=full`, { profile: "full", tools: ["recall"], addTools: ["explore"] }],
    [`${B}?prof%69le=full`, { profile: "full", tools: null, addTools: [] }],
    [`${B}?add_tools=a%2Cb`, { profile: null, tools: null, addTools: ["a", "b"] }],
    [`${B}?add_tools=x#add_tools=y`, { profile: null, tools: null, addTools: ["x"] }],
    // parse_qsl splits on & alone.
    [`${B}?a=1;profile=full`, { profile: null, tools: null, addTools: [] }],
  ])("reads %s as Python does", (url, view) => {
    expect(mcpUrlToolView(url)).toEqual(view);
  });

  it("is mcpQueryToolView of the URL's query values, as Python's mcp_query_tool_view", () => {
    const url = `${B}?tools=recall&add_tools=explore,x&profile=%20full`;
    expect(mcpQueryToolView(mcpUrlQueryValues(url))).toEqual(mcpUrlToolView(url));
    expect(mcpQueryToolView(new Map())).toEqual({ profile: null, tools: null, addTools: [] });
  });

  it("reads the first 100 names of a list, as the server does", () => {
    const url = `${B}?add_tools=${names(105).join(",")}&tools=${names(105).join(",")}`;
    expect(mcpUrlToolView(url).addTools).toEqual(names(100));
    expect(mcpUrlToolView(url).tools).toEqual(names(100));
    // A blank item still counts towards the 100.
    expect(mcpUrlToolView(`${B}?tools=,${names(100).join(",")}`).tools).toEqual(names(99));
  });
});

describe("mcpUrlQueryValues and queryParam", () => {
  it("map each decoded name to its first decoded value, a blank one kept", () => {
    expect([...mcpUrlQueryValues(`${B}?guard%72ails=off&guardrails=${U}&a&b=x+y%21&&c=%zz#d=1`)]).toEqual([
      ["guardrails", "off"],
      ["a", ""],
      ["b", "x y!"],
      ["c", "%zz"],
    ]);
    expect(queryParam(`${B}?context=${U}`, "context")).toBe(U);
    expect(queryParam(B, "context")).toBeUndefined();
  });

  it("decode percent escapes as UTF-8, an invalid sequence as U+FFFD, as unquote_plus does", () => {
    expect(queryParam(`${B}?n=%E3%81%82`, "n")).toBe("あ");
    expect(queryParam(`${B}?n=%ff`, "n")).toBe("�");
  });

  // Recorded from the Python SDK 0.44.0 (and the server's parse_qsl reads
  // them alike): unquote_plus keeps a U+FEFF, which a default TextDecoder
  // would strip from the start of each escape run.
  it("keep an escaped U+FEFF, as unquote_plus does", () => {
    expect(queryParam(`${B}?n=x%EF%BB%BF`, "n")).toBe("x﻿");
    expect(queryParam(`${B}?n=%EF%BB%BF%EF%BB%BFx`, "n")).toBe("﻿﻿x");
    expect(mcpUrlToolView(`${B}?profile=%EF%BB%BFcore`).profile).toBe("﻿core");
    expect(mcpUrlToolView(`${B}?add_tools=a,%EF%BB%BFb`).addTools).toEqual(["a", "﻿b"]);
    // A name that decodes to U+FEFF + profile is another parameter, kept.
    expect(mcpUrlWithQuery(`${B}?%EF%BB%BFprofile=x`, { profile: "core" })).toBe(
      `${B}?%EF%BB%BFprofile=x&profile=core`,
    );
    expect(mcpUrlWithQuery(B, { addTools: ["﻿explore"] })).toBe(`${B}?add_tools=%EF%BB%BFexplore`);
  });
});

describe("mcpUrlGuardrailsOff", () => {
  // [query, Python 0.44.0's mcp_url_guardrails_off(B + query)]: the first
  // value, str.strip()ped (which takes \x1c-\x1f and U+0085 but keeps
  // U+FEFF, unlike String.prototype.trim), in any case.
  it.each<[string, boolean]>([
    ["?guardrails=off", true],
    ["?guardrails=%20OFF%20", true],
    ["?guardrails=%1Foff%1C", true],
    ["?guardrails=%C2%85off", true],
    ["?guardrails=%E3%80%80off", true],
    ["?guardrails=%EF%BB%BFoff", false],
    ["?guardrails=&guardrails=off", false],
    ["?guardrails=off&guardrails=x", true],
    ["?guard%72ails=Off", true],
    ["?guardrails", false],
    ["", false],
    ["?guardrails=offx", false],
  ])("reads %j as Python does", (query, off) => {
    expect(mcpUrlGuardrailsOff(`${B}${query}`)).toBe(off);
    expect(mcpUrlGuardrailsOff(parseMcpUrl(`${B}${query}`))).toBe(off);
  });
});

describe("parseMcpUrl (one split for the readers and the composer)", () => {
  it("splits the URL as the server does", () => {
    const url = `${B}?guard%72ails=off&&profile=+core&profile=full#frag`;
    const parsed = parseMcpUrl(url);
    expect(parsed).toEqual({
      url,
      base: B,
      params: ["guard%72ails=off", "profile=+core", "profile=full"],
      fragment: "#frag",
      query: mcpUrlQueryValues(url),
    });
    expect([...parsed.query]).toEqual([
      ["guardrails", "off"],
      ["profile", " core"],
    ]);
    // An already parsed URL comes back as it is.
    expect(parseMcpUrl(parsed)).toBe(parsed);
  });

  it.each([
    B,
    `${B}?tools=recall&profile=full#x`,
    `${B}?add_tools=a&add%5Ftools=b&keep=1#frag`,
    `${B}?x=a%2Cb&guardrails=OFF&context=old`,
    `HTTPS://X.test/mcp?profile=`,
  ])("reads and composes %s as the URL string does", (url) => {
    const parsed = parseMcpUrl(url);
    expect(mcpUrlToolView(parsed)).toEqual(mcpUrlToolView(url));
    expect(queryParam(parsed, "guardrails")).toBe(queryParam(url, "guardrails"));
    expect(mcpUrlGuardrailsOff(parsed)).toBe(mcpUrlGuardrailsOff(url));
    expect(withoutQuery(parsed)).toBe(withoutQuery(url));
    expect(withoutQueryParam(parsed, "guardrails")).toBe(withoutQueryParam(url, "guardrails"));
    const updates: McpUrlQuery = { guardrails: "off", profile: "core", addTools: ["explore"], context: U };
    expect(mcpUrlWithQuery(parsed, updates)).toBe(mcpUrlWithQuery(url, updates));
  });

  it("gives back the URL as written when nothing is set or dropped", () => {
    const url = `${B}?x=a%2Cb&&y#f`;
    expect(mcpUrlWithQuery(parseMcpUrl(url), {})).toBe(url);
    expect(mcpUrlWithQuery(parseMcpUrl(url), { addTools: [" , "] })).toBe(url);
    expect(withoutQueryParam(parseMcpUrl(url), "guardrails")).toBe(url);
  });

  it("decodes the query once, and only for a reader of it", () => {
    const parsed = parseMcpUrl(`${B}?guard%72ails=off&profile=core`);
    const query = Object.getOwnPropertyDescriptor(parsed, "query")!;
    let decodes = 0;
    Object.defineProperty(parsed, "query", {
      get: () => {
        decodes += 1;
        return query.get!.call(parsed);
      },
    });
    // Rewriting the query reads no value of it.
    withoutQuery(parsed);
    withoutQueryParam(parsed, "guardrails");
    splitWithoutQueryParam(parsed, "profile");
    mcpUrlWithQuery(parsed, { guardrails: "off", profile: "full" });
    expect(decodes).toBe(0);
    // A reader decodes it, once for every later read.
    const first = parsed.query;
    expect(first).toEqual(new Map([["guardrails", "off"], ["profile", "core"]]));
    expect(parsed.query).toBe(first);
    expect(queryParam(parsed, "guardrails")).toBe("off");
  });

  it.each([
    `${B}?guardrails=x&profile=full&keep=a,b#frag`,
    `${B}?guardrails=a&guard%72ails=off&add_tools=explore`,
    `HTTPS://X.test/mcp?guardrails=${U}&tools=recall#`,
    `${B}?guardrails=`,
    `${B}?keep=1`,
    B,
  ])("splitWithoutQueryParam(%s) is withoutQueryParam, still split", (url) => {
    const split = splitWithoutQueryParam(url, "guardrails");
    expect(split.url).toBe(withoutQueryParam(url, "guardrails"));
    // Read and composed as the URL it stands for.
    const reparsed = parseMcpUrl(split.url);
    expect(split.params).toEqual(reparsed.params);
    expect([...split.query]).toEqual([...reparsed.query]);
    expect(mcpUrlToolView(split)).toEqual(mcpUrlToolView(split.url));
    expect(withoutQuery(split)).toBe(withoutQuery(split.url));
    const updates: McpUrlQuery = { guardrails: "off", profile: "core", addTools: ["explore"] };
    expect(mcpUrlWithQuery(split, updates)).toBe(mcpUrlWithQuery(split.url, updates));
    expect(mcpUrlWithQuery(split, {})).toBe(split.url);
  });
});

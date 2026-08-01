import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FilesClient } from "../../../src/filesClient.js";
import { ResourceClient } from "../../../src/resourceClient.js";

const CONTEXT_UUID = "11111111-2222-4333-8444-555555555555";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

class FakeRest {
  requests: Recorded[] = [];
  status = 200;
  body: unknown = {};

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    this.requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const nullBody = this.status === 204 || this.status === 304;
    return new Response(nullBody ? null : JSON.stringify(this.body), { status: this.status });
  };

  last(): Recorded {
    return this.requests[this.requests.length - 1]!;
  }
  query(): URLSearchParams {
    return new URL(this.last().url).searchParams;
  }
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  rest: FakeRest;
}

function harness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const rest = new FakeRest();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    // FilesClient requires a UUID workspace id, so the fallback must be one.
    loadConfig: () => ({ api_key: "k", context_id: CONTEXT_UUID }),
    makeClient: (() => {
      throw new Error("MCP client not expected here");
    }) as unknown as CliDeps["makeClient"],
    makeFilesClient: (o: Record<string, unknown>) =>
      new FilesClient({ ...o, baseUrl: "https://api.test", fetch: rest.fetch }),
    makeResourceClient: (o: Record<string, unknown>) =>
      new ResourceClient({ ...o, baseUrl: "https://api.test", fetch: rest.fetch }),
  } as unknown as CliDeps;
  return { deps, out, err, rest };
}

describe("nested groups", () => {
  it("routes the three-level `resource tokens list`", async () => {
    const h = harness();
    h.rest.body = { tokens: [], total: 0 };
    expect(await runCli(["resource", "tokens", "list"], h.deps)).toBe(0);
    expect(h.rest.last().url).toContain("/api/v1/resource-tokens");
  });

  it("lists subcommands for a nested group with --help", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/Usage: kagura-memory resource tokens/);
    for (const name of ["create", "list", "revoke", "update"]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
    }
  });

  it("rejects an unknown nested subcommand", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "frobnicate"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/No such command 'frobnicate'/);
  });
});

describe("kagura-memory resource events", () => {
  it("takes RESOURCE_ID positionally, unlike the rest of the group", async () => {
    const h = harness();
    h.rest.body = { events: [], next_cursor: null };
    expect(await runCli(["resource", "events", "res-1"], h.deps)).toBe(0);
    expect(h.rest.last().url).toContain("/api/v1/resources/res-1/events");
    expect(h.rest.query().get("limit")).toBe("50");
  });

  it("reads -c as --cursor, not --context-id", async () => {
    const h = harness();
    h.rest.body = { events: [] };
    await runCli(["resource", "events", "res-1", "-c", "cur-9"], h.deps);
    expect(h.rest.query().get("cursor")).toBe("cur-9");
  });

  it("reads -V as the document version", async () => {
    const h = harness();
    h.rest.body = { events: [] };
    await runCli(["resource", "events", "res-1", "-V", "3"], h.deps);
    expect(h.rest.query().get("version")).toBe("3");
  });

  it.each([["0"], ["101"]])("range-checks --limit %j locally", async (value) => {
    const h = harness();
    expect(await runCli(["resource", "events", "res-1", "--limit", value], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain(`is not in the range 1<=x<=100.`);
    expect(h.rest.requests).toEqual([]);
  });

  it("rejects a malformed --since before any request", async () => {
    // `new Date("garbage")` is an Invalid Date that serializes to null and
    // would silently drop the filter, returning everything.
    const h = harness();
    expect(await runCli(["resource", "events", "res-1", "--since", "garbage"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("is not a valid ISO 8601 instant");
    expect(h.rest.requests).toEqual([]);
  });

  it("accepts a real ISO 8601 --since", async () => {
    const h = harness();
    h.rest.body = { events: [] };
    expect(await runCli(["resource", "events", "res-1", "--since", "2026-06-01T00:00:00Z"], h.deps)).toBe(0);
    expect(h.rest.query().get("since")).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("kagura-memory resource schema vs ingest: the -v/-V trap", () => {
  it("reads lowercase -v as the schema version on `schema`", async () => {
    const h = harness();
    h.rest.body = { fields: [] };
    expect(await runCli(["resource", "schema", "-r", "res-1", "-v", "2"], h.deps)).toBe(0);
    expect(h.rest.query().get("schema_version")).toBe("2");
  });

  it("reads capital -V as the document version on `ingest`", async () => {
    const h = harness();
    h.rest.body = { status: "accepted" };
    expect(
      await runCli(
        ["resource", "ingest", "-r", "res-1", "-k", "rk", "--doc-id", "d1", "-V", "4"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.rest.last().body).toMatchObject({ doc_id: "d1", version: 4, op: "upsert" });
    expect(h.rest.last().headers["x-resource-api-key"]).toBe("rk");
  });

  it("rejects lowercase -v on `ingest`, where it is not declared", async () => {
    const h = harness();
    expect(
      await runCli(["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "-v", "4"], h.deps),
    ).toBe(2);
    expect(h.err.join("\n")).toMatch(/Unknown option: -v/);
  });
});

describe("kagura-memory resource quota range checks", () => {
  it("range-checks setup --quota locally", async () => {
    const h = harness();
    expect(await runCli(["resource", "setup", "-r", "res-1", "-q", "20000"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("is not in the range 1<=x<=10000.");
  });

  it("does NOT range-check tokens create --quota, matching Python", async () => {
    // Python declares plain `type=int` there; the bound is pydantic's, on
    // the server. A local check would reject input the Python CLI sends.
    const h = harness();
    h.rest.body = { id: 1, token: "t" };
    expect(await runCli(["resource", "tokens", "create", "-r", "res-1", "-q", "20000"], h.deps)).toBe(0);
    expect(h.rest.last().body).toMatchObject({ quota_events_per_hour: 20000 });
  });
});

describe("kagura-memory resource tokens", () => {
  it("requires TOKEN_ID to be an integer", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "revoke", "abc"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("Invalid value for 'TOKEN_ID': 'abc' is not a valid integer.");
  });

  it("names the missing required option", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "create"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("Missing option '--resource-id' / '-r'.");
  });
});

describe("kagura-memory resource ingest --payload", () => {
  it("rejects a JSON array", async () => {
    const h = harness();
    expect(
      await runCli(
        ["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "-p", "[1,2]"],
        h.deps,
      ),
    ).toBe(2);
    expect(h.err.join("\n")).toContain("--payload must be a JSON object.");
  });

  it("sends a JSON object through", async () => {
    const h = harness();
    h.rest.body = { status: "accepted" };
    await runCli(
      ["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "-p", '{"a":1}'],
      h.deps,
    );
    expect(h.rest.last().body).toMatchObject({ payload: { a: 1 } });
  });
});

describe("kagura-memory files", () => {
  it("reports a path that does not exist as a usage error", async () => {
    const h = harness();
    expect(await runCli(["files", "upload", "./definitely-not-here.bin"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Invalid value for 'PATH'.*does not exist/);
    expect(h.rest.requests).toEqual([]);
  });

  it("reports a directory as a usage error", async () => {
    const h = harness();
    expect(await runCli(["files", "upload", "."], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/is a directory/);
  });

  it("range-checks --limit on list", async () => {
    const h = harness();
    expect(await runCli(["files", "list", "--limit", "501"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("is not in the range 1<=x<=500.");
  });

  it("sends the workspace id and default limit on list", async () => {
    const h = harness();
    h.rest.body = [];
    expect(await runCli(["files", "list"], h.deps)).toBe(0);
    expect(h.rest.query().get("workspace_id")).toBe(CONTEXT_UUID);
    expect(h.rest.query().get("limit")).toBe("50");
  });

  it("confirms a delete rather than printing nothing for a 204", async () => {
    const h = harness();
    h.rest.status = 204;
    expect(await runCli(["files", "delete", "file-1", "-c", CONTEXT_UUID], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ status: "success", file_id: "file-1" });
  });
});

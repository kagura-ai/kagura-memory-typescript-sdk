/**
 * `kagura-memory resource import` against the Python CLI's
 * `resource_import`: detection by extension, its readers' errors (all
 * ClickException, exit 1), the 100-event batches, and the `-v` / `--progress`
 * stream with its single terminal event (tests/test_cli.py and
 * tests/test_logger_progress.py of the Python SDK).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../../src/auth/types.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { KaguraAuthError } from "../../../src/errors.js";
import { ResourceClient } from "../../../src/resourceClient.js";
import { restClientFromAuth } from "../../../src/restBase.js";

const AUTH: ResolvedAuth = {
  kind: "static",
  apiKey: "k",
  mcpUrl: "https://api.test/mcp",
  source: "config",
};
const NDJSON_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Batch {
  url: string;
  apiKey: string | undefined;
  events: Array<Record<string, unknown>>;
}

/** The batch endpoint: accepts every event, unless a call is scripted to fail. */
class FakeIngest {
  batches: Batch[] = [];
  /** Each request body as sent. */
  bodies: string[] = [];
  /** Call index (0-based) → the response to give instead. */
  failures: Record<number, { status: number; body: unknown }> = {};
  /** Per-call extra fields for the success body. */
  extra: Record<number, Record<string, unknown>> = {};

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.bodies.push(String(init?.body));
    const body = JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> };
    const call = this.batches.length;
    this.batches.push({ url: String(input), apiKey: headers["X-Resource-API-Key"], events: body.events });
    const failure = this.failures[call];
    if (failure !== undefined) return new Response(JSON.stringify(failure.body), { status: failure.status });
    const created = { created_count: body.events.length, failed_count: 0, errors: [], ...this.extra[call] };
    return new Response(JSON.stringify(created), { status: 200 });
  };
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  ingest: FakeIngest;
  stdinReads: number;
  clients: Array<ResolvedAuth | undefined>;
}

function harness(
  options: {
    /** An Error is a read that fails: thrown when asked to, else read as no input, as the bin does. */
    stdin?: string | null | Error;
    config?: KaguraConfig | Error;
    auth?: ResolvedAuth | Error;
  } = {},
): Harness {
  const h: Harness = {
    deps: undefined as unknown as CliDeps,
    out: [],
    err: [],
    ingest: new FakeIngest(),
    stdinReads: 0,
    clients: [],
  };
  h.deps = {
    write: (line: string) => void h.out.push(line),
    writeError: (line: string) => void h.err.push(line),
    confirm: async () => true,
    loadConfig: () => {
      if (options.config instanceof Error) throw options.config;
      return options.config ?? { api_key: "k" };
    },
    resolveAuth: () => {
      if (options.auth instanceof Error) throw options.auth;
      return options.auth ?? AUTH;
    },
    readStdin: (read?: { throwOnError?: boolean }) => {
      h.stdinReads++;
      if (options.stdin instanceof Error) {
        if (read?.throwOnError === true) throw options.stdin;
        return null;
      }
      return options.stdin ?? null;
    },
    makeResourceClient: (auth?: ResolvedAuth) => {
      h.clients.push(auth);
      return restClientFromAuth(ResourceClient, auth!, { fetch: h.ingest.fetch });
    },
  } as unknown as CliDeps;
  return h;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-import-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function jsonl(n: number): string {
  return Array.from({ length: n }, (_, i) => `{"name": "row${i}"}`).join("\n");
}

const IMPORT = ["resource", "import", "-r", "products", "-k", "TOKEN"];

/** The NDJSON lines on stderr, `ts` checked and dropped. */
function events(err: string[]): Array<Record<string, unknown>> {
  return err
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      const { ts, ...rest } = JSON.parse(l) as Record<string, unknown>;
      expect(ts).toMatch(NDJSON_TS);
      return rest;
    });
}

describe("resource import: reading and batching", () => {
  it("imports a CSV file in batches of 100, one aggregate printed", async () => {
    const h = harness();
    const rows = Array.from({ length: 150 }, (_, i) => `${i + 1}`).join("\n");
    const file = write("items.csv", `n\n${rows}\n`);
    expect(await runCli([...IMPORT, "-f", file], h.deps)).toBe(0);
    expect(h.ingest.batches.map((b) => b.events.length)).toEqual([100, 50]);
    expect(h.ingest.batches[0]!.url).toBe("https://api.test/api/v1/resources/products/events/batch");
    expect(h.ingest.batches[0]!.apiKey).toBe("TOKEN");
    expect(h.ingest.batches[0]!.events[0]).toEqual({
      op: "upsert",
      doc_id: "1",
      version: 1,
      payload: { n: "1" },
      event_metadata: {},
    });
    expect(JSON.parse(h.out.join("\n"))).toEqual({ created: 150, failed: 0, total: 150 });
    expect(h.err).toEqual([]);
    // Built from the credential the chain resolved with the loaded config.
    expect(h.clients).toEqual([AUTH]);
  });

  it("reads stdin with --format, as Python's tests feed it", async () => {
    const h = harness({ stdin: '{"name":"A"}\n{"name":"B"}' });
    expect(await runCli([...IMPORT, "--format", "jsonl"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ created: 2, failed: 0, total: 2 });
  });

  it.each([
    ["data.jsonl", '{"a":1}\n{"a":2}\n', 2],
    ["data.json", '[{"a":1},{"a":2},{"a":3}]', 3],
    ["data.csv", "a\n1\n", 1],
  ])("detects %s by its extension", async (name, text, total) => {
    const h = harness();
    expect(await runCli([...IMPORT, "-f", write(name, text)], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ total });
  });

  it("keeps the first five errors of each batch and prints ten in all", async () => {
    const h = harness();
    const errs = Array.from({ length: 8 }, (_, i) => ({ index: i }));
    h.ingest.extra = { 0: { failed_count: 8, errors: errs }, 1: { failed_count: 8, errors: errs }, 2: { errors: errs } };
    const file = write("rows.jsonl", jsonl(250));
    expect(await runCli([...IMPORT, "-f", file], h.deps)).toBe(0);
    const printed = JSON.parse(h.out.join("\n"));
    expect(printed).toMatchObject({ created: 250, failed: 16, total: 250 });
    expect(printed.errors).toEqual([...errs.slice(0, 5), ...errs.slice(0, 5)]);
  });

  it("takes -V as the version and -v as verbose", async () => {
    const h = harness();
    const file = write("rows.csv", "a\n1\n");
    expect(await runCli([...IMPORT, "-f", file, "-V", "4", "-v"], h.deps)).toBe(0);
    expect(h.ingest.batches[0]!.events[0]).toMatchObject({ version: 4 });
    expect(h.err[0]).toBe("→ Importing events 1 event(s)");
  });

  describe("--id-column", () => {
    it.each<[string, string, string[]]>([
      ["rows.csv", "sku,qty\nA-1,3\nB-2,4\n", ["A-1", "B-2"]],
      // Python's str() of each JSON value.
      ["rows.jsonl", '{"sku": 5}\n{"sku": true}\n{"sku": null}\n{"sku": 1.5}\n{"sku": [1]}', ["5", "True", "None", "1.5", "[1]"]],
      // A short CSV row's missing cell is None, and str(None) is the doc_id.
      ["short.csv", "qty,sku\n3\n", ["None"]],
    ])("takes the doc_id from the column in %s", async (name, text, ids) => {
      const h = harness();
      expect(await runCli([...IMPORT, "-f", write(name, text), "--id-column", "sku"], h.deps)).toBe(0);
      expect(h.ingest.batches[0]!.events.map((e) => e.doc_id)).toEqual(ids);
    });

    it("numbers the rows when it is empty, as Python's `if id_column:` does", async () => {
      const h = harness();
      expect(await runCli([...IMPORT, "-f", write("r.csv", "a\nx\ny\n"), "--id-column="], h.deps)).toBe(0);
      expect(h.ingest.batches[0]!.events.map((e) => e.doc_id)).toEqual(["1", "2"]);
    });

    it("names the row and the keys when the column is missing (exit 1)", async () => {
      const h = harness();
      const file = write("r.csv", "name,price\nWidget,9.99\n");
      expect(await runCli([...IMPORT, "-f", file, "--id-column", "nope"], h.deps)).toBe(1);
      expect(h.err).toEqual(["Error: Row 1: column 'nope' not found. Keys: ['name', 'price']"]);
      expect(h.ingest.batches).toEqual([]);
    });

    it("lists the restkey None among the keys of a row with extra cells", async () => {
      const h = harness();
      const file = write("r.csv", "name\nWidget,9.99\n");
      expect(await runCli([...IMPORT, "-f", file, "--id-column", "sku"], h.deps)).toBe(1);
      expect(h.err).toEqual(["Error: Row 1: column 'sku' not found. Keys: ['name', None]"]);
    });

    it("keeps apart two ids past 2^53, which a JS number would round to one doc_id", async () => {
      // Both would be sent as 1234567890123456768, the second upserted over the first.
      const h = harness();
      const file = write("snow.jsonl", '{"id": 1234567890123456789, "name": "a"}\n{"id": 1234567890123456788, "name": "b"}\n');
      expect(await runCli([...IMPORT, "-f", file, "--id-column", "id"], h.deps)).toBe(0);
      expect(h.ingest.batches[0]!.events.map((e) => e.doc_id)).toEqual(["1234567890123456789", "1234567890123456788"]);
    });

    it("makes a doc_id of a float as Python's str() does", async () => {
      const h = harness();
      const file = write("types.json", '[{"id": 10.0}, {"id": 1e20}, {"id": -0}, {"id": [1.0, {"2": 3, "a": 1.5e-7}]}]');
      expect(await runCli([...IMPORT, "-f", file, "--id-column", "id"], h.deps)).toBe(0);
      expect(h.ingest.batches[0]!.events.map((e) => e.doc_id)).toEqual([
        "10.0",
        "1e+20",
        "0",
        "[1.0, {'2': 3, 'a': 1.5e-07}]",
      ]);
    });

    it.each<[string, string, string]>([
      ["years.csv", "name,2024,1\nx,a,b\n", "['name', '2024', '1']"],
      ["numkeys.json", '[{"name": "x", "10": 1, "2": 2}]', "['name', '10', '2']"],
    ])("lists the keys of %s in the order read, as Python's dict does", async (name, text, keys) => {
      const h = harness();
      expect(await runCli([...IMPORT, "-f", write(name, text), "--id-column", "id"], h.deps)).toBe(1);
      expect(h.err).toEqual([`Error: Row 1: column 'id' not found. Keys: ${keys}`]);
    });

    it("refuses an empty doc_id before sending anything, where Python's model raises a traceback", async () => {
      const h = harness();
      const file = write("r.csv", "sku,qty\nA-1,1\n,2\n");
      expect(await runCli([...IMPORT, "-f", file, "--id-column", "sku"], h.deps)).toBe(1);
      expect(h.err).toEqual(["Error: Row 2: doc_id from column 'sku' must be 1-255 characters, got 0."]);
      expect(h.ingest.batches).toEqual([]);
    });
  });

  it("sends each row's keys in the order read, integer-like ones included", async () => {
    const h = harness();
    expect(await runCli([...IMPORT, "-f", write("years.csv", "name,2024,1\nx,a,b\n")], h.deps)).toBe(0);
    // The raw body: parsed back into a plain object, the order would be lost again.
    expect(h.ingest.bodies[0]).toContain('"payload":{"name":"x","2024":"a","1":"b"}');
  });

  it("refuses a CSV row with more cells than the header, where Python's model raises a traceback", async () => {
    const h = harness();
    expect(await runCli([...IMPORT, "-f", write("r.csv", "a,b\n1,2\n1,2,3\n")], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Row 2: more fields than the header has columns."]);
    expect(h.ingest.batches).toEqual([]);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4).
  it("refuses a doc_id past 255 characters, naming the row, before any event", async () => {
    const h = harness();
    const file = write("long.csv", `id,name\n${"x".repeat(256)},a\n`);
    expect(await runCli([...IMPORT, "-f", file, "--id-column", "id", "--progress", "json"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Row 1: doc_id from column 'id' must be 1-255 characters, got 256."]);
    expect(h.ingest.batches).toEqual([]);
  });

  it("refuses a row with cells past the header before any event", async () => {
    const h = harness();
    const file = write("extra.csv", "id,name\n1,a\n2,b,EXTRA\n");
    expect(await runCli([...IMPORT, "-f", file, "--progress", "json"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Row 2: more fields than the header has columns."]);
    expect(h.ingest.batches).toEqual([]);
  });
});

describe("resource import: errors in Python's words", () => {
  it.each<[string, string, string]>([
    ["json", "not json", "Error: Invalid JSON: Expecting value: line 1 column 1 (char 0)"],
    ["json", '{"not": "array"}', "Error: JSON must be an array of objects"],
    ["json", "[1, 2, 3]", "Error: JSON item 0 is not an object: int"],
    ["jsonl", '{"ok":1}\nnot json\n{"ok":2}', "Error: Invalid JSONL at line 2: Expecting value: line 1 column 1 (char 0)"],
    ["jsonl", '{"ok":1}\n[1]', "Error: JSONL line 2 is not an object"],
    ["jsonl", "", "Error: No data found in input"],
    ["json", "[]", "Error: No data found in input"],
    ["csv", "name,price\n", "Error: No data found in input"],
  ])("--format %s refuses %j (exit 1)", async (format, stdin, message) => {
    const h = harness({ stdin });
    expect(await runCli([...IMPORT, "--format", format], h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.ingest.batches).toEqual([]);
  });

  it("never quotes the input: V8's own JSON error would", async () => {
    const h = harness({ stdin: "kagura_secret_key" });
    await runCli([...IMPORT, "--format", "json"], h.deps);
    expect(h.err.join("\n")).not.toContain("kagura_secret_key");
  });

  it("cannot detect the format of stdin, and does not read it", async () => {
    const h = harness({ stdin: "some data" });
    expect(await runCli(IMPORT, h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Cannot detect format. Use --format csv|json|jsonl"]);
    expect(h.stdinReads).toBe(0);
  });

  it.each(["data.CSV", "data.txt", "data"])("cannot detect the format of %s", async (name) => {
    const h = harness();
    expect(await runCli([...IMPORT, "-f", write(name, "a\n1\n")], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Cannot detect format. Use --format csv|json|jsonl"]);
  });

  it("names a file that cannot be opened while converting --file (exit 2)", async () => {
    const h = harness();
    const missing = path.join(dir, "missing.csv");
    expect(await runCli([...IMPORT, "-f", missing], h.deps)).toBe(2);
    expect(h.err).toEqual([`Error: Invalid value for '--file' / '-f': '${missing}': No such file or directory`]);
  });

  it("reports the file before a missing required option, as click converts given options first", async () => {
    const h = harness();
    const missing = path.join(dir, "missing.csv");
    expect(await runCli(["resource", "import", "-f", missing], h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/^Error: Invalid value for '--file' \/ '-f': /);
  });

  it("refuses bytes that are not UTF-8 (exit 1)", async () => {
    const h = harness();
    const file = path.join(dir, "bad.csv");
    fs.writeFileSync(file, Buffer.from([0x61, 0x0a, 0xff]));
    expect(await runCli([...IMPORT, "-f", file], h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^Error: Failed to read input: /);
  });

  it.each<[string[], string]>([
    [["--format", "CSV"], "Error: Invalid value for '--format': 'CSV' is not one of 'auto', 'csv', 'json', 'jsonl'."],
    [["--version", "0"], "Error: Invalid value for '--version' / '-V': 0 is not in the range x>=1."],
    [["-V", "abc"], "Error: Invalid value for '--version' / '-V': 'abc' is not a valid integer range."],
    [["--progress", "auto"], "Error: Invalid value for '--progress': 'auto' is not one of 'rich', 'json', 'none'."],
    [["--verbose=1"], "Error: Option '--verbose' does not take a value."],
  ])("refuses %j (exit 2)", async (flags, message) => {
    const h = harness({ stdin: "a\n1" });
    expect(await runCli([...IMPORT, ...flags], h.deps)).toBe(2);
    expect(h.err[0]).toBe(message);
    expect(h.stdinReads).toBe(0);
  });

  it.each(["9007199254740993", "9_007_199_254_740_992", "1" + "0".repeat(30)])(
    "refuses -V %s as too large to send, not as outside x>=1 (exit 2)",
    async (raw) => {
      // Python's IntRange(1) has no upper bound and sends it; a JS number would round it.
      const h = harness({ stdin: "a\n1" });
      expect(await runCli([...IMPORT, "--format", "csv", "-V", raw], h.deps)).toBe(2);
      const digits = BigInt(raw.replace(/_/g, "")).toString();
      expect(h.err).toEqual([
        `Error: Invalid value for '--version' / '-V': ${digits} is too large for this CLI to send ` +
          "exactly (at most 9007199254740991).",
      ]);
      expect(h.ingest.batches).toEqual([]);
    },
  );

  it("sends -V 2^53-1, the largest it can send exactly", async () => {
    const h = harness({ stdin: "a\n1" });
    expect(await runCli([...IMPORT, "--format", "csv", "-V", "9007199254740991"], h.deps)).toBe(0);
    expect(h.ingest.bodies[0]).toContain('"version":9007199254740991');
  });

  it("names a failed read of stdin rather than reading it as empty (exit 1)", async () => {
    const eagain = Object.assign(new Error("EAGAIN: resource temporarily unavailable, read"), { code: "EAGAIN" });
    const h = harness({ stdin: eagain });
    expect(await runCli([...IMPORT, "--format", "jsonl"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Failed to read input: EAGAIN: resource temporarily unavailable, read"]);
    expect(h.ingest.batches).toEqual([]);
  });

  it.each<[string[], string]>([
    [["resource", "import", "-k", "K"], "Error: Missing option '--resource-id' / '-r'."],
    [["resource", "import", "-r", "R"], "Error: Missing option '--api-key' / '-k'."],
  ])("names a missing required option: %j", async (argv, message) => {
    const h = harness();
    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.err[0]).toBe(message);
  });
});

describe("resource import: -v and --progress", () => {
  it("streams Python's five events for 250 rows, one terminal event", async () => {
    const h = harness({ stdin: jsonl(250) });
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(0);
    expect(events(h.err)).toEqual([
      { v: 1, stage: "import_start", kind: "action", msg: "Importing events", detail: { desc: "250 event(s)" } },
      { v: 1, stage: "import_batch", kind: "action", msg: "Ingesting batch", detail: { desc: "1/3 (100 event(s))" } },
      { v: 1, stage: "import_batch", kind: "action", msg: "Ingesting batch", detail: { desc: "2/3 (100 event(s))" } },
      { v: 1, stage: "import_batch", kind: "action", msg: "Ingesting batch", detail: { desc: "3/3 (50 event(s))" } },
      {
        v: 1,
        stage: "complete",
        kind: "success",
        msg: "Import complete",
        detail: { created: 250, failed: 0, total: 250 },
      },
    ]);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ created: 250, failed: 0, total: 250 });
  });

  it("ends a failed batch with one error carrying the partial counts", async () => {
    const h = harness({ stdin: jsonl(200) });
    h.ingest.failures = { 1: { status: 500, body: { detail: "simulated server crash" } } };
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
    const stream = events(h.err);
    const terminal = stream.filter((e) => e.kind === "success" || e.kind === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      stage: "complete",
      kind: "error",
      msg: expect.stringMatching(/^Import failed: /),
      detail: { created_so_far: 100, failed_so_far: 0, total_events: 200 },
    });
    expect(stream[stream.length - 1]).toBe(terminal[0]);
    expect(h.err[h.err.length - 1]).toMatch(/^Error: /);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4): with no
  // credential, `resource import … --progress json` prints the error alone, no
  // event: the stream starts only once the client is built (python-sdk #285).
  it("starts no stream when the credential fails", async () => {
    const h = harness({ stdin: jsonl(2), auth: new KaguraAuthError("No credentials found.") });
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
    expect(events(h.err)).toEqual([]);
    expect(h.err).toEqual(["Error: No credentials found."]);
    expect(h.ingest.batches).toEqual([]);
  });

  it("starts no stream when building the client fails", async () => {
    const h = harness({ stdin: jsonl(2) });
    h.deps.makeResourceClient = (() => {
      throw new Error("boom");
    }) as unknown as CliDeps["makeResourceClient"];
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
    expect(events(h.err)).toEqual([]);
    expect(h.err).toEqual(["Error: boom"]);
  });

  describe("NaN and Infinity, which json.loads reads and httpx refuses to send", () => {
    it("fails the batch holding one, as Python's request encoding does, and sends nothing", async () => {
      // JSON.stringify would have sent {"a": null, "id": 1} and reported success.
      const h = harness();
      const file = write("nan.json", '[{"a": NaN, "id": 1.0}]');
      expect(await runCli([...IMPORT, "-f", file, "--progress", "json"], h.deps)).toBe(1);
      expect(events(h.err)).toEqual([
        { v: 1, stage: "import_start", kind: "action", msg: "Importing events", detail: { desc: "1 event(s)" } },
        { v: 1, stage: "import_batch", kind: "action", msg: "Ingesting batch", detail: { desc: "1/1 (1 event(s))" } },
        {
          v: 1,
          stage: "complete",
          kind: "error",
          msg: "Import failed: Out of range float values are not JSON compliant: nan",
          detail: { created_so_far: 0, failed_so_far: 0, total_events: 1 },
        },
      ]);
      expect(h.err[h.err.length - 1]).toBe("Error: Out of range float values are not JSON compliant: nan");
      expect(h.ingest.batches).toEqual([]);
      expect(h.out).toEqual([]);
    });

    it.each<[string, string]>([
      ['{"a": Infinity}\n{"b": 1e400}\n', "inf"],
      ['{"a": {"b": [1, -Infinity]}}\n', "-inf"],
    ])("refuses %j, naming the value", async (text, shown) => {
      const h = harness();
      expect(await runCli([...IMPORT, "-f", write("inf.jsonl", text)], h.deps)).toBe(1);
      expect(h.err).toEqual([`Error: Out of range float values are not JSON compliant: ${shown}`]);
      expect(h.ingest.batches).toEqual([]);
    });

    it("sends the batches before the one holding it, and counts them", async () => {
      const rows = Array.from({ length: 150 }, (_, i) => (i === 119 ? '{"x": {"y": NaN}}' : `{"n": ${i}}`));
      const h = harness({ stdin: rows.join("\n") });
      expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
      expect(h.ingest.batches.map((b) => b.events.length)).toEqual([100]);
      expect(events(h.err).pop()).toMatchObject({
        kind: "error",
        detail: { created_so_far: 100, failed_so_far: 0, total_events: 150 },
      });
    });
  });

  it("emits nothing when .kagura.json cannot be loaded", async () => {
    const h = harness({ stdin: jsonl(2), config: new Error("Invalid JSON or encoding in .kagura.json") });
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Invalid JSON or encoding in .kagura.json"]);
  });

  it("names an error that has no message by its class", async () => {
    const h = harness({ stdin: jsonl(1) });
    h.deps.makeResourceClient = (() => ({
      ingestEvents: async () => {
        throw new RangeError();
      },
    })) as unknown as CliDeps["makeResourceClient"];
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
    expect(events(h.err)[2]).toMatchObject({ kind: "error", msg: "Import failed: RangeError" });
    expect(h.err[h.err.length - 1]).toBe("Error: RangeError");
  });

  it("-v prints Rich's plain lines and leaves stdout alone", async () => {
    const h = harness({ stdin: jsonl(250) });
    expect(await runCli([...IMPORT, "--format", "jsonl", "-v"], h.deps)).toBe(0);
    expect(h.err).toEqual([
      "→ Importing events 250 event(s)",
      "→ Ingesting batch 1/3 (100 event(s))",
      "→ Ingesting batch 2/3 (100 event(s))",
      "→ Ingesting batch 3/3 (50 event(s))",
      "✓ Import complete",
    ]);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ created: 250, failed: 0, total: 250 });
  });

  it("-v shows a failure, then the error", async () => {
    const h = harness({ stdin: jsonl(1) });
    h.ingest.failures = { 0: { status: 500, body: { detail: "down" } } };
    expect(await runCli([...IMPORT, "--format", "jsonl", "-v"], h.deps)).toBe(1);
    expect(h.err[2]).toMatch(/^✗ Import failed: /);
    expect(h.err[3]).toMatch(/^Error: /);
  });

  it("is silent without -v, and with --progress none", async () => {
    for (const flags of [[], ["-v", "--progress", "none"]]) {
      const h = harness({ stdin: jsonl(3) });
      expect(await runCli([...IMPORT, "--format", "jsonl", ...flags], h.deps)).toBe(0);
      expect(h.err).toEqual([]);
    }
  });

  it("emits nothing for input it refuses before the import starts", async () => {
    const h = harness({ stdin: "" });
    expect(await runCli([...IMPORT, "--format", "jsonl", "--progress", "json"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: No data found in input"]);
  });
});

describe("resource import --help", () => {
  it("lists Python's options, help texts and examples, -v and --progress last", async () => {
    const h = harness();
    expect(await runCli(["resource", "import", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    const lines = text.split("\n");
    const options = lines.slice(lines.indexOf("Options:") + 1).map((l) => l.trim());
    expect(options.map((l) => l.split(/\s{2,}/)[0])).toEqual([
      "-r, --resource-id TEXT",
      "-k, --api-key TEXT",
      "-f, --file FILENAME",
      "--format [auto|csv|json|jsonl]",
      "--id-column TEXT",
      "-V, --version INTEGER",
      "-v, --verbose",
      "--progress [rich|json|none]",
      "--help",
    ]);
    // Python shows no default for these, and no help for --file / --format.
    expect(options[2]).toBe("-f, --file FILENAME");
    expect(options[3]).toBe("--format [auto|csv|json|jsonl]");
    expect(text).toContain("Column name to use as doc_id (default: row number)");
    expect(text).toContain("Version (>=1)");
    expect(text).toContain("Auto-detects format from file extension, or specify --format.");
    expect(text).toContain("cat items.json | kagura-memory resource import -r products -k TOKEN --format json");
  });
});

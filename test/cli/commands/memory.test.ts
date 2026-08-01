import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
}

function harness(config: KaguraConfig = { context_id: "ctx-default", api_key: "k" }): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    login: (async () => {
      throw new Error("not used");
    }) as unknown as CliDeps["login"],
    refresh: (async () => {
      throw new Error("not used");
    }) as unknown as CliDeps["refresh"],
    loadConfig: () => config,
    makeClient: (options: Record<string, unknown>) => makeClient(server, options),
  } as unknown as CliDeps;
  return { deps, out, err, server };
}

/** The arguments the CLI actually put on the wire. */
async function wire(argv: string[], config?: KaguraConfig) {
  const h = config ? harness(config) : harness();
  const code = await runCli(argv, h.deps);
  return { code, args: code === 0 ? h.server.toolCallArgs(0) : undefined, h };
}

describe("kagura-memory remember", () => {
  it("sends summary, content and the defaulted type/importance", async () => {
    const { code, args } = await wire(["remember", "-s", "Sum", "--content", "Body"]);
    expect(code).toBe(0);
    // Python declares defaults on the options, so both are always sent.
    expect(args).toMatchObject({
      context_id: "ctx-default",
      summary: "Sum",
      content: "Body",
      type: "note",
      importance: 0.5,
    });
  });

  it("omits tags and provenance keys that were not given", async () => {
    const { args } = await wire(["remember", "-s", "S", "--content", "C"]);
    for (const key of ["tags", "source_uri", "source_type", "linked_memory_ids", "details"]) {
      expect(args).not.toHaveProperty(key);
    }
  });

  it("splits comma-separated tags and link lists", async () => {
    const { args } = await wire([
      "remember",
      "-s",
      "S",
      "--content",
      "C",
      "--tags",
      "python, fastapi",
      "--linked-memory-ids",
      "id-1,id-2",
      "--linked-source-uris",
      "vault://a",
    ]);
    expect(args).toMatchObject({
      tags: ["python", "fastapi"],
      linked_memory_ids: ["id-1", "id-2"],
      linked_source_uris: ["vault://a"],
    });
  });

  it("accepts --source-type case-insensitively and sends the canonical value", async () => {
    const { args } = await wire([
      "remember",
      "-s",
      "S",
      "--content",
      "C",
      "--source-uri",
      "file:///x.md",
      "--source-type",
      "FILE",
    ]);
    expect(args).toMatchObject({ source_uri: "file:///x.md", source_type: "file" });
  });

  it("rejects an unknown --source-type with exit 2", async () => {
    const { code, h } = await wire(["remember", "-s", "S", "--content", "C", "--source-type", "ftp"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/Invalid value for '--source-type'/);
  });

  it("merges --location into details", async () => {
    const { args } = await wire([
      "remember",
      "-s",
      "S",
      "--content",
      "C",
      "--details",
      '{"a":1}',
      "--location",
      "35.68,139.76,Tokyo HQ",
    ]);
    expect(args).toMatchObject({
      details: { a: 1, location: { lat: 35.68, lon: 139.76, label: "Tokyo HQ" } },
    });
  });

  it("sends coordinates as JSON numbers, not strings", async () => {
    // The server 422s string-typed lat/lon by design.
    const { args } = await wire(["remember", "-s", "S", "--content", "C", "--location", "35.68,139.76"]);
    const details = args?.details as { location: { lat: unknown; lon: unknown } };
    expect(typeof details.location.lat).toBe("number");
    expect(typeof details.location.lon).toBe("number");
  });

  it.each([
    [["--summary", "S"], "'--content'"],
    [["--content", "C"], "'--summary' / '-s'"],
  ])("exits 2 naming the missing required option (%j)", async (argv, expected) => {
    const { code, h } = await wire(["remember", ...argv]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain(`Missing option ${expected}.`);
  });

  it("does not clamp an out-of-range importance", async () => {
    const { args } = await wire(["remember", "-s", "S", "--content", "C", "-i", "5"]);
    expect(args).toMatchObject({ importance: 5 });
  });
});

describe("kagura-memory recall", () => {
  it("takes the query as a positional and defaults -k to 5", async () => {
    const { code, args } = await wire(["recall", "hello world"]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ context_id: "ctx-default", query: "hello world", k: 5 });
  });

  it("honours -c and -k", async () => {
    const { args } = await wire(["recall", "q", "-c", "ctx-9", "-k", "20"]);
    expect(args).toMatchObject({ context_id: "ctx-9", query: "q", k: 20 });
  });

  it("rejects --k, which Python does not declare", async () => {
    const { code, h } = await wire(["recall", "q", "--k", "3"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/Unknown option: --k/);
  });

  it("exits 2 when the query positional is missing", async () => {
    const { code, h } = await wire(["recall"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Missing argument 'QUERY'.");
  });

  it("exits 2 for a non-integer -k", async () => {
    const { code, h } = await wire(["recall", "q", "-k", "abc"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("'abc' is not a valid integer.");
  });

  it("exits 1 when no context resolves, with the Python message", async () => {
    const { code, h } = await wire(["recall", "q"], {});
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe(
      "Error: context_id required. Use --context-id or set in .kagura.json",
    );
  });
});

describe("an explicitly empty value", () => {
  // Python accepts an explicit empty value everywhere; only two options
  // here reject it, and only because "" does damage there rather than
  // nothing. Measured against the real Python CLI, which reaches
  // authentication with both of the argv below.
  it("lets --context-id= fall through to the config", async () => {
    // `context_id or config.get("context_id") or ""` — the resolution was
    // written for exactly this, but a global guard rejected it first.
    const { code, args } = await wire(["recall", "q", "--context-id="]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ context_id: "ctx-default" });
  });

  it("treats --tags= as unset rather than a usage error", async () => {
    // An unset shell variable expands to this; erroring would make
    // `--tags "$MAYBE_EMPTY"` unusable.
    const { code, args } = await wire(["remember", "-s", "S", "--content", "C", "--tags="]);
    expect(code).toBe(0);
    expect(args).not.toHaveProperty("tags");
  });

  it("treats --details= as unset", async () => {
    const { code, args } = await wire(["remember", "-s", "S", "--content", "C", "--details="]);
    expect(code).toBe(0);
    expect(args).not.toHaveProperty("details");
  });

});

describe("kagura-memory forget", () => {
  it("requires one of --memory-id or --query, exiting 1", async () => {
    // ClickException in Python, so exit 1 rather than the usage code 2.
    const { code, h } = await wire(["forget"]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe("Error: Either --memory-id or --query is required");
  });

  it("does not send k in pure memory-id mode", async () => {
    const { args } = await wire(["forget", "-m", "mem-1"]);
    expect(args).toMatchObject({ context_id: "ctx-default", memory_id: "mem-1" });
    expect(args).not.toHaveProperty("k");
  });

  it("defaults k to 10 in query mode — not recall's 5", async () => {
    const { args } = await wire(["forget", "-q", "stale"]);
    expect(args).toMatchObject({ query: "stale", k: 10 });
  });
});

describe("kagura-memory update-memory", () => {
  it("requires exactly one of --memory-id / --external-id", async () => {
    const a = await wire(["update-memory"]);
    expect(a.code).toBe(1);
    expect(a.h.err.join("\n")).toContain("Either --memory-id or --external-id is required");

    const b = await wire(["update-memory", "-m", "m", "--external-id", "e"]);
    expect(b.code).toBe(1);
    expect(b.h.err.join("\n")).toContain("Provide only one of --memory-id or --external-id");
  });

  it("omits every field that was not passed, so nothing is overwritten", async () => {
    const { args } = await wire(["update-memory", "-m", "mem-1", "-s", "New summary"]);
    expect(args).toMatchObject({ context_id: "ctx-default", memory_id: "mem-1", summary: "New summary" });
    // Unlike `remember`, there is no default type/importance here — an
    // absent key means "leave unchanged".
    for (const key of ["type", "importance", "content", "tags"]) {
      expect(args).not.toHaveProperty(key);
    }
  });
});

describe("kagura-memory explore / reference", () => {
  it("always sends explore's depth and min_weight defaults", async () => {
    const { args } = await wire(["explore", "-m", "seed"]);
    expect(args).toMatchObject({ memory_id: "seed", depth: 2, min_weight: 0.05 });
  });

  it("honours -d and -w", async () => {
    const { args } = await wire(["explore", "-m", "seed", "-d", "4", "-w", "0.2"]);
    expect(args).toMatchObject({ depth: 4, min_weight: 0.2 });
  });

  it("requires reference's --memory-id", async () => {
    const { code, h } = await wire(["reference"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Missing option '--memory-id' / '-m'.");
  });

  it("sends reference's two keys and nothing else", async () => {
    const { args } = await wire(["reference", "-m", "mem-1"]);
    expect(args).toEqual({ context_id: "ctx-default", memory_id: "mem-1" });
  });
});

describe("output", () => {
  it("prints the server payload as indented JSON", async () => {
    const h = harness();
    h.server.toolResults.recall = { status: "success", results: [] };
    expect(await runCli(["recall", "q"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe('{\n  "status": "success",\n  "results": []\n}');
  });
});

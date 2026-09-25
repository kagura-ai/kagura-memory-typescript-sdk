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
    expect(h.err[0]).toBe(
      "Error: Invalid value for '--source-type': 'ftp' is not one of 'file', 'url', 'vault', 'api', 'manual'.",
    );
  });

  it("matches --source-type casefolded, as click's case-insensitive Choice does", async () => {
    // `ﬁle` (the fi ligature) casefolds to `file`; Python 0.40.1 takes it.
    const { args } = await wire(["remember", "-s", "S", "--content", "C", "--source-type", "\u{fb01}le"]);
    expect(args).toMatchObject({ source_type: "file" });
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

  it("sends filters.trust_tier = trusted with --trusted-only", async () => {
    const { code, args } = await wire(["recall", "q", "--trusted-only"]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ query: "q", filters: { trust_tier: "trusted" } });
  });

  it("describes --trusted-only in the Python CLI's words", async () => {
    const h = harness();
    expect(await runCli(["recall", "--help"], h.deps)).toBe(0);
    const line = h.out.join("\n").split("\n").find((l) => l.trimStart().startsWith("--trusted-only"));
    expect(line).toContain(
      "Exclude external / connector-ingested memories (filters.trust_tier=trusted; " +
        "server v0.24.0+). Use it for reads fed back to an agent, like the SessionStart hook.",
    );
  });

  it("sends no filters without --trusted-only", async () => {
    const { args } = await wire(["recall", "q"]);
    expect(args).not.toHaveProperty("filters");
  });

  it("omits use_rerank without --rerank/--no-rerank, so the context's config decides", async () => {
    const { code, args } = await wire(["recall", "q"]);
    expect(code).toBe(0);
    expect(args).not.toHaveProperty("use_rerank");
  });

  it("sends use_rerank: true with --rerank", async () => {
    const { code, args } = await wire(["recall", "q", "--rerank"]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ query: "q", use_rerank: true });
  });

  it("sends an explicit use_rerank: false with --no-rerank", async () => {
    // false is a request of its own (skip reranking for this call), not
    // "unset": the key must be on the wire.
    const { code, args } = await wire(["recall", "q", "--no-rerank"]);
    expect(code).toBe(0);
    expect(args).toHaveProperty("use_rerank", false);
  });

  it("combines --no-rerank with --trusted-only", async () => {
    const { args } = await wire(["recall", "latency-sensitive lookup", "--no-rerank", "--trusted-only"]);
    expect(args).toMatchObject({
      query: "latency-sensitive lookup",
      use_rerank: false,
      filters: { trust_tier: "trusted" },
    });
  });

  it("refuses --rerank with --no-rerank, exiting 2 before any call", async () => {
    // click takes the last of the pair; this bin refuses the pair, as it
    // does for `context search-config --rerank --no-rerank`.
    const { code, h } = await wire(["recall", "q", "--rerank", "--no-rerank"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("--rerank and --no-rerank are mutually exclusive; pick one.");
    expect(h.server.requests).toHaveLength(0);
  });

  it("describes --rerank/--no-rerank in the Python CLI's words", async () => {
    const h = harness();
    expect(await runCli(["recall", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n");
    const line = (flag: string) =>
      help.split("\n").find((l) => l.trimStart().startsWith(`${flag} `)) ?? "";
    expect(line("--rerank")).toContain(
      "Request reranking for this call (default: follow the context's search config)",
    );
    expect(line("--no-rerank")).toContain("Skip reranking for this call");
    // Python's docstring, reflowed.
    expect(help.replace(/\s+/g, " ")).toContain(
      "Without --rerank/--no-rerank the server follows the context's search config " +
        "(memory-cloud v0.69.0+). --rerank applies only when the context enables " +
        "reranking; --no-rerank always skips it.",
    );
    expect(help).toContain('kagura-memory recall "latency-sensitive lookup" --no-rerank');
  });

  it("rejects --k, which Python does not declare", async () => {
    const { code, h } = await wire(["recall", "q", "--k", "3"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/Error: No such option: --k/);
  });

  it("exits 2 when the query positional is missing", async () => {
    const { code, h } = await wire(["recall"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Missing argument 'QUERY'.");
  });

  it("exits 2 for a non-integer -k, naming it as click does: -k alone, with no long form", async () => {
    for (const argv of [["recall", "q", "-k", "abc"], ["recall", "q", "-kabc"]]) {
      const { code, h } = await wire(argv);
      expect(code).toBe(2);
      expect(h.err[0]).toBe("Error: Invalid value for '-k': 'abc' is not a valid integer.");
    }
  });

  it("prints a quota refusal with Python's Resets at / Required plan lines", async () => {
    // What `kagura remember` prints for the same envelope (_cli_error_message).
    const h = harness();
    h.server.toolResults.remember = {
      status: "error",
      error: "quota_exceeded",
      message: "Daily memory limit reached (100/day).",
      gate: "quota",
      quota_type: "memories_per_day",
      current: 100,
      limit: 100,
      required_plan: "basic",
      required_plan_display: "M",
      resets_at: "2026-09-24T00:00:00Z",
    };
    expect(await runCli(["remember", "-s", "S", "--content", "C"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: remember failed (quota_exceeded): Daily memory limit reached (100/day).\n" +
        "  Resets at: 2026-09-24T00:00:00+00:00\n" +
        "  Required plan: M (basic)",
    ]);
    expect(h.out).toEqual([]);
  });

  it("exits 1 when no context resolves, with the Python message", async () => {
    const { code, h } = await wire(["recall", "q"], {});
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe(
      "Error: context_id required. Pass the context ID or set context_id in .kagura.json",
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

  it("converts -k before the memory-id/query check, so a bad -k exits 2 as in click", async () => {
    // click coerces `type=int` before the body's ClickException can run.
    const { code, h } = await wire(["forget", "-k", "abc"]);
    expect(code).toBe(2);
    expect(h.err[0]).toBe("Error: Invalid value for '-k': 'abc' is not a valid integer.");
    expect(h.err.join("\n")).not.toContain("Either --memory-id or --query is required");
    expect(h.server.requests).toHaveLength(0);
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
    for (const key of ["type", "importance", "content", "tags", "dismiss_supersede_candidate"]) {
      expect(args).not.toHaveProperty(key);
    }
  });

  it("sends dismiss_supersede_candidate: true with --dismiss-supersede-candidate", async () => {
    const { code, args } = await wire(["update-memory", "-m", "mem-1", "--dismiss-supersede-candidate"]);
    expect(code).toBe(0);
    expect(args).toEqual({
      context_id: "ctx-default",
      memory_id: "mem-1",
      dismiss_supersede_candidate: true,
    });
  });

  it("refuses --dismiss-supersede-candidate with --external-id, exiting 1 before any call", async () => {
    // ClickException in Python, so exit 1: an upsert replaces the memory,
    // leaving no suggestion to dismiss.
    const { code, h } = await wire([
      "update-memory",
      "--external-id",
      "ext-key",
      "--dismiss-supersede-candidate",
    ]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe(
      "Error: --dismiss-supersede-candidate requires --memory-id (not --external-id)",
    );
    expect(h.server.requests).toHaveLength(0);
  });

  it("refuses it beside an empty --external-id= too, which the client would send", async () => {
    // The client tests for presence, not truthiness, because "" still goes
    // out as external_id; checking the same way here keeps the refusal a
    // CLI error rather than the client's.
    const { code, h } = await wire([
      "update-memory",
      "-m",
      "mem-1",
      "--external-id=",
      "--dismiss-supersede-candidate",
    ]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe(
      "Error: --dismiss-supersede-candidate requires --memory-id (not --external-id)",
    );
    expect(h.server.requests).toHaveLength(0);
  });

  it("keeps the memory-id/external-id checks ahead of the dismissal check", async () => {
    // Python's order: neither, then both, then the dismissal.
    const { code, h } = await wire(["update-memory", "--dismiss-supersede-candidate"]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe("Error: Either --memory-id or --external-id is required");
  });

  it("converts -i before any of those checks, so a bad float exits 2 as in click", async () => {
    // click coerces `type=float` before the body's ClickExceptions run, so
    // the usage error wins over every exit-1 check.
    for (const argv of [
      ["update-memory", "-i", "abc", "--dismiss-supersede-candidate", "--external-id", "y"],
      ["update-memory", "-i", "abc"],
      ["update-memory", "-m", "m", "--external-id", "e", "-i", "abc"],
    ]) {
      const { code, h } = await wire(argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(h.err.join("\n")).toContain(
        "Invalid value for '--importance' / '-i': 'abc' is not a valid float.",
      );
      expect(h.server.requests).toHaveLength(0);
    }
  });

  it("describes --dismiss-supersede-candidate in the Python CLI's words, with its example", async () => {
    const h = harness();
    expect(await runCli(["update-memory", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n");
    expect(help.replace(/\s+/g, " ")).toContain(
      "Reject this memory's supersede_candidate suggestion (needs --memory-id; " +
        "server v0.65.0+, older servers drop it silently)",
    );
    expect(help).toContain("kagura-memory update-memory -m MEM_UUID --dismiss-supersede-candidate");
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

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { SecretClient } from "../../../src/secrets/client.js";
import { TEST_IDENTITY } from "../../secrets/vectors.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

class FakeRest {
  requests: Recorded[] = [];
  routes: Record<string, unknown> = {};
  status = 200;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.requests.push({
      url,
      method: init?.method ?? "GET",
      headers: {},
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const path = new URL(url).pathname;
    const payload = this.routes[path] ?? {};
    return new Response(JSON.stringify(payload), { status: this.status });
  };

  last(): Recorded {
    return this.requests[this.requests.length - 1]!;
  }
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  rest: FakeRest;
  prompts: string[];
  spawned: { command: string; argv: string[]; env: Record<string, string> }[];
}

function harness(options: { tty?: boolean; stdin?: string | null; confirm?: boolean } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const spawned: Harness["spawned"] = [];
  const rest = new FakeRest();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async (q: string) => {
      prompts.push(q);
      return options.confirm ?? true;
    },
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    loadConfig: () => ({ api_key: "k" }),
    makeClient: (() => {
      throw new Error("MCP client not expected here");
    }) as unknown as CliDeps["makeClient"],
    makeFilesClient: (() => {
      throw new Error("files client not expected here");
    }) as unknown as CliDeps["makeFilesClient"],
    makeResourceClient: (() => {
      throw new Error("resource client not expected here");
    }) as unknown as CliDeps["makeResourceClient"],
    makeSecretClient: (o: Record<string, unknown>) =>
      new SecretClient({ ...o, baseUrl: "https://api.test", fetch: rest.fetch }),
    isTty: () => options.tty ?? false,
    readStdin: () => options.stdin ?? null,
    spawnChild: async (command: string, argv: string[], env: Record<string, string>) => {
      spawned.push({ command, argv, env });
      return 0;
    },
  } as unknown as CliDeps;
  return { deps, out, err, rest, prompts, spawned };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("identity resolution fails closed", () => {
  it.each([
    [["secret", "get", "db-url"]],
    [["secret", "exec", "--as", "A=db-url", "--", "echo"]],
  ])("refuses %j with instructions when no identity is configured", async (argv) => {
    delete process.env.KAGURA_AGE_IDENTITY;
    delete process.env.KAGURA_AGE_IDENTITY_FILE;
    const h = harness();
    expect(await runCli(argv, h.deps)).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain("No age private key available.");
    expect(text).toContain("KAGURA_AGE_IDENTITY");
    // Nothing may be fetched before we know we can decrypt it.
    expect(h.rest.requests).toEqual([]);
  });

  it("never echoes the file contents when the file has no key line", async () => {
    delete process.env.KAGURA_AGE_IDENTITY;
    process.env.KAGURA_AGE_IDENTITY_FILE = "package.json";
    const h = harness();
    expect(await runCli(["secret", "get", "db-url"], h.deps)).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain("contains no AGE-SECRET-KEY-1 line");
    expect(text).not.toContain("kagura-memory");
  });
});

describe("the TTY guard", () => {
  it("refuses to print a secret to a terminal", async () => {
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness({ tty: true });
    expect(await runCli(["secret", "get", "db-url"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("refusing to print a secret to a terminal");
    // The guard runs before the fetch: there is no point decrypting
    // something we will refuse to show.
    expect(h.rest.requests).toEqual([]);
  });

  it("refuses to print a generated private key to a terminal", async () => {
    const h = harness({ tty: true });
    expect(await runCli(["secret", "keygen"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("refusing to print a private key to a terminal");
    expect(h.out.join("\n")).not.toContain("AGE-SECRET-KEY-1");
  });

  it("allows it when stdout is redirected", async () => {
    const h = harness({ tty: false });
    expect(await runCli(["secret", "keygen", "--no-register"], h.deps)).toBe(0);
    const printed = JSON.parse(h.out.join("\n")) as Record<string, string>;
    expect(printed.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(printed.recipient).toMatch(/^age1/);
  });
});

describe("kagura-memory secret put", () => {
  it("reads the value from stdin, never from a flag", async () => {
    // A value in argv lands in shell history and every `ps` listing, so
    // there is deliberately no --value.
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness({ stdin: "hunter2\n" });
    h.rest.routes["/api/v1/config/secrets/pubkeys"] = [];
    expect(await runCli(["secret", "put", "db-url", "--value", "x"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Unknown option: --value/);
  });

  it("reports a missing stdin rather than storing an empty secret", async () => {
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness({ stdin: null });
    expect(await runCli(["secret", "put", "db-url"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("no value on stdin");
  });

  it("accepts --to more than once", async () => {
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness({ stdin: "v" });
    h.rest.routes["/api/v1/config/secrets/pubkeys"] = [];
    // Both ids are unknown to the fake, so this fails — but it must fail
    // naming the *second* id, proving both were parsed.
    expect(await runCli(["secret", "put", "s", "--to", "p1", "--to", "p2"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("no such pubkey id: p1");
  });
});

describe("kagura-memory secret exec", () => {
  it("requires --as and a command", async () => {
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const a = harness();
    expect(await runCli(["secret", "exec", "--", "echo"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toContain("Missing option '--as'.");

    const b = harness();
    expect(await runCli(["secret", "exec", "--as", "A=s"], b.deps)).toBe(2);
    expect(b.err.join("\n")).toContain("Missing argument 'COMMAND'.");
  });

  it("passes the child's own flags through untouched", async () => {
    // Click sets ignore_unknown_options + allow_interspersed_args=False on
    // this command precisely so `-la` reaches `ls`. Measured against the
    // real Python CLI, which gets as far as authentication with the same
    // argv this used to reject.
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness();
    h.rest.routes["/api/v1/config/secrets/fetch"] = {
      name: "s",
      version_number: 1,
      alg: "age",
      ciphertext: "x",
      recipients_snapshot: [],
      rotation_needed: false,
      created_at: "2026-01-01T00:00:00Z",
    };
    // Decryption of the stub ciphertext fails, but the argv must have been
    // accepted to get that far — a parse rejection exits 2 with
    // "Unknown option: -la" and never reaches the fetch.
    const code = await runCli(["secret", "exec", "--as", "A=s", "--", "ls", "-la"], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).not.toMatch(/Unknown option/);
    expect(h.rest.requests.length).toBeGreaterThan(0);
  });

  it("works without the -- separator too", async () => {
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness();
    const code = await runCli(["secret", "exec", "--as", "A=s", "ls", "-la"], h.deps);
    expect(h.err.join("\n")).not.toMatch(/Unknown option/);
    expect(code).not.toBe(2);
  });

  it("rejects an --as without an equals sign", async () => {
    process.env.KAGURA_AGE_IDENTITY = TEST_IDENTITY;
    const h = harness();
    expect(await runCli(["secret", "exec", "--as", "NOEQUALS", "--", "echo"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("--as expects ENV_NAME=secret_name");
  });
});

describe("kagura-memory secret delete", () => {
  it("prompts before a hard delete and aborts on a decline", async () => {
    const h = harness({ confirm: false });
    expect(await runCli(["secret", "delete", "db-url"], h.deps)).toBe(1);
    expect(h.prompts).toEqual(["Hard-delete secret 'db-url' and all versions?"]);
    expect(h.rest.requests).toEqual([]);
  });

  it("skips the prompt with -y", async () => {
    const h = harness();
    expect(await runCli(["secret", "delete", "db-url", "-y"], h.deps)).toBe(0);
    expect(h.prompts).toEqual([]);
  });
});

describe("commands that need no private key", () => {
  it.each([
    [["secret", "list"], "/api/v1/config/secrets"],
    [["secret", "pubkeys"], "/api/v1/config/secrets/pubkeys"],
    [["secret", "pubkeys", "--mine"], "/api/v1/config/secrets/pubkeys/me"],
    [["secret", "audit-verify"], "/api/v1/config/secrets/audit/verify"],
  ])("runs %j without any identity configured", async (argv, path) => {
    delete process.env.KAGURA_AGE_IDENTITY;
    delete process.env.KAGURA_AGE_IDENTITY_FILE;
    const h = harness();
    h.rest.routes[path] = [];
    expect(await runCli(argv, h.deps)).toBe(0);
    expect(new URL(h.rest.last().url).pathname).toBe(path);
  });
});

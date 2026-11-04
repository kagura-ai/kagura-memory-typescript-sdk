/**
 * Keeps the README's method reference honest.
 *
 * A hand-written API table is a snapshot that rots: a method gets added and
 * nobody remembers the table exists. These assertions fail the build
 * instead, so the reference stays a description of the code rather than of
 * whatever the code looked like when someone last wrote prose.
 *
 * Scope is deliberately narrow — that every public method is *named*, and
 * that internal anchors resolve. Whether the description is any good is a
 * human's call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
const clientSource = fs.readFileSync(path.join(repoRoot, "src", "client.ts"), "utf8");

/**
 * The body of `export class KaguraClient { ... }`, by brace depth.
 *
 * Scoping to the class matters: `client.ts` also declares option
 * interfaces at the top level, and a method signature in one of those
 * would otherwise be scraped as if it were client API.
 */
function clientClassBody(): string[] {
  const lines = clientSource.split(/\r?\n/);
  const start = lines.findIndex((l) => /^export class KaguraClient\b/.test(l));
  if (start === -1) {
    throw new Error("could not find `export class KaguraClient` in src/client.ts");
  }

  const body: string[] = [];
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (depth === 1) {
      body.push(line);
    }
    // Brace counting is naive about braces inside strings/comments, but the
    // depth-1 slice only needs to end at the right place, and a stray brace
    // would truncate the body — surfacing as a failed method count below,
    // not as a silent pass.
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0 && i > start) {
      break;
    }
  }
  return body;
}

/**
 * Public methods declared on KaguraClient.
 *
 * Tolerates any combination of `public`/`static`/`async` and does not
 * assume every method is async, so adding `public foo()` cannot slip past
 * the README guard. `private`/`protected` members and the constructor are
 * excluded explicitly rather than by failing to match — an under-matching
 * extractor makes this whole suite pass vacuously.
 */
function publicClientMethods(): string[] {
  const names: string[] = [];
  for (const line of clientClassBody()) {
    const match = /^ {2}((?:(?:public|private|protected|static|async)\s+)*)([a-zA-Z_][\w]*)\s*[(<]/.exec(
      line,
    );
    if (!match) {
      continue;
    }
    const modifiers = match[1]!;
    const name = match[2]!;
    if (/\b(?:private|protected)\b/.test(modifiers) || name === "constructor") {
      continue;
    }
    // Control-flow keywords can't be class members, but a reformat could
    // indent one here; never let a keyword become a "method".
    if (["if", "for", "while", "switch", "catch", "return"].includes(name)) {
      continue;
    }
    names.push(name);
  }
  return names;
}

/**
 * Method names listed in the first column of the reference tables.
 *
 * A row's first cell holds one or more backticked method names (some rows
 * group siblings, e.g. `createEdge` / `updateEdge` / `deleteEdge`). Later
 * columns are prose that mentions option names, so only the first cell is
 * a reliable source of method identifiers.
 */
function referenceTableMethods(): string[] {
  const section = readme.split("## `KaguraClient` method reference")[1];
  if (section === undefined) {
    throw new Error("README is missing the `KaguraClient` method reference section");
  }
  const tables = section.split("## Agent control plane")[0] ?? "";

  const names: string[] = [];
  for (const row of tables.split(/\r?\n/)) {
    if (!row.startsWith("|")) {
      continue;
    }
    const firstCell = row.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`([a-zA-Z][\w]*)`/g)) {
      names.push(match[1]!);
    }
  }
  return [...new Set(names)];
}

/** GitHub's heading→anchor slug: lowercase, drop punctuation, spaces→dashes. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

describe("the extractor these assertions rest on", () => {
  // If publicClientMethods() under-matches, every check below passes
  // vacuously. Pin its behaviour against known members of both kinds.
  it("finds public methods and excludes private ones", () => {
    const methods = publicClientMethods();

    for (const name of ["remember", "recall", "recallNearby", "listTags", "close"]) {
      expect(methods).toContain(name);
    }
    for (const name of ["callTool", "callToolChecked", "makeJsonRpcRequest", "restGet", "post"]) {
      expect(methods).not.toContain(name);
    }
    expect(methods).not.toContain("constructor");
  });

  it("reads the class body, not the whole file", () => {
    const body = clientClassBody();
    expect(body.length).toBeGreaterThan(100);
    // Option interfaces live above the class; none of their members should
    // be in scope.
    expect(body.join("\n")).not.toMatch(/^export interface /m);
  });
});

describe("README method reference", () => {
  it("names every public KaguraClient method", () => {
    const methods = publicClientMethods();
    expect(methods.length).toBeGreaterThan(40);

    const undocumented = methods.filter(
      (name) => !new RegExp("`" + name + "[`(]").test(readme),
    );
    expect(undocumented).toEqual([]);
  });

  it("does not name methods that no longer exist", () => {
    // Read the tables' first column only. Prose and later columns mention
    // option names (`details`, `withTags`) that are not methods, so
    // scanning the whole section would produce false failures.
    const listed = referenceTableMethods();
    expect(listed.length).toBeGreaterThan(30);

    const known = new Set(publicClientMethods());
    expect(listed.filter((name) => !known.has(name))).toEqual([]);
  });
});

describe("README links", () => {
  it("resolves every in-page anchor to a real heading", () => {
    const headings = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slugify(m[1]!));
    const anchors = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((a) => !headings.includes(a))).toEqual([]);
  });

  it("resolves every relative file link to a file that exists", () => {
    const links = [...readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]!);
    const broken = links.filter((rel) => !fs.existsSync(path.join(repoRoot, rel.split("#")[0]!)));
    expect(broken).toEqual([]);
  });
});

describe("wording memory-cloud v0.77.0 made stale (python-sdk 0.41.0)", () => {
  it("no longer says the MCP list_tags tool lacks with_tags", () => {
    // memory-cloud#1669: the tool has with_tags from v0.77.0.
    expect(readme).not.toContain("ignores `withTags` (through server v0.76.0)");
    expect(clientSource).not.toContain("has no `with_tags` (through v0.76.0)");
    expect(clientSource).not.toContain("has no with_tags through server v0.76.0");
    expect(readme).toContain("has `with_tags` only from server v0.77.0");
  });
});

/** Prose with every run of whitespace folded to one space: line breaks fall anywhere. */
function fold(text: string): string {
  return text.split(/\s+/).join(" ");
}

/**
 * The parity target the README's "Relationship to the Python SDK" paragraph
 * names: the Python SDK/CLI version and the memory-cloud version (no `v`).
 */
function readmeParity(): { python: string; server: string } {
  const match =
    /The parity target is the Python SDK and CLI \*\*(\d+\.\d+\.\d+)\*\*, checked against memory-cloud up to \*\*v(\d+\.\d+\.\d+)\*\*\./.exec(
      fold(readme),
    );
  if (!match) {
    throw new Error("README is missing its parity paragraph (`The parity target is the Python SDK and CLI **X**, …`)");
  }
  return { python: match[1]!, server: match[2]! };
}

/** MAJOR.MINOR.PATCH of a version; a pre-release or build suffix is ignored. */
function versionTriple(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`not a MAJOR.MINOR.PATCH version: ${JSON.stringify(version)}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe("README parity target", () => {
  it("names the Python CLI 0.44.0 and memory-cloud v0.143.0 (#93)", () => {
    const flat = fold(readme);
    const { python, server } = readmeParity();
    expect({ python, server }).toEqual({ python: "0.44.0", server: "0.143.0" });
    // The Command line intro and the Installation paragraph say the same.
    expect(flat).toContain(`parity target is the Python CLI **${python}**`);
    expect(flat).toContain(`is checked against memory-cloud up to **v${server}**`);
    expect(flat).toContain("**Differences from the Python CLI 0.42.0–0.44.0");
    expect(flat).not.toContain("**0.42.0**");
    expect(flat).not.toContain("**v0.77.0**");
  });
});

describe("versionTriple", () => {
  it("ignores a pre-release or build suffix", () => {
    expect(versionTriple("0.15.0")).toEqual([0, 15, 0]);
    expect(versionTriple("0.15.0-rc.1")).toEqual([0, 15, 0]);
    expect(versionTriple("1.2.3+build.5")).toEqual([1, 2, 3]);
    expect(() => versionTriple("0.15")).toThrow("not a MAJOR.MINOR.PATCH version");
  });
});

describe("docs/compatibility.md (#93)", () => {
  const compatPath = path.join(repoRoot, "docs", "compatibility.md");
  const minServer = /export const MIN_SERVER_VERSION = "([^"]+)";/.exec(clientSource)?.[1];

  /**
   * Read when a test runs, not when the file is collected, so a missing
   * file fails these tests with a clear message instead of every test here.
   */
  function compat(): string {
    if (!fs.existsSync(compatPath)) {
      throw new Error("docs/compatibility.md is missing (#93)");
    }
    return fs.readFileSync(compatPath, "utf8");
  }

  /** The first release section: from its `## X.Y.Z` heading to the next `## `. */
  function firstSection(): { version: string; text: string } {
    const match = /^## (\d+\.\d+\.\d+)\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(compat());
    if (!match) {
      throw new Error("docs/compatibility.md has no `## X.Y.Z` release section");
    }
    return { version: match[1]!, text: fold(match[2]!) };
  }

  it("states the MIN_SERVER_VERSION src/client.ts defines", () => {
    expect(minServer).toBeDefined();
    expect(fold(compat())).toContain(
      `\`MIN_SERVER_VERSION\` (exported from the package, defined in \`src/client.ts\`) is **${minServer}**`,
    );
  });

  it("opens with a section no older than the package version", () => {
    // A release adds its section at the top; one that forgets fails here.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const a = versionTriple(firstSection().version);
    const b = versionTriple(pkg.version);
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    expect(cmp).toBeGreaterThanOrEqual(0);
  });

  it("gives its first section MIN_SERVER_VERSION and the README's parity target", () => {
    const { python, server } = readmeParity();
    expect(firstSection().text).toContain(
      `**Min memory-cloud:** ${minServer} — checked against memory-cloud up to **${server}** ` +
        `(parity target: the Python SDK and CLI ${python},`,
    );
  });

  it("is linked from the README", () => {
    expect(readme).toContain("[`docs/compatibility.md`](docs/compatibility.md)");
  });
});

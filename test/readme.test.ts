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
    const section = readme.split("## `KaguraClient` method reference")[1] ?? "";
    const table = section.split("## Agent control plane")[0] ?? "";
    const known = new Set(publicClientMethods());

    // Only check identifiers followed by `()` — those are unambiguously
    // method references, unlike bare backticked option names.
    const referenced = [...table.matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)\(\)`/g)].map((m) => m[1]!);
    const stale = [...new Set(referenced)].filter((name) => !known.has(name));
    expect(stale).toEqual([]);
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

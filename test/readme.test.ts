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

/** Public (non-`private`) async methods declared on KaguraClient. */
function publicClientMethods(): string[] {
  const names: string[] = [];
  for (const line of clientSource.split(/\r?\n/)) {
    const match = /^ {2}async ([a-zA-Z0-9_]+)\(/.exec(line);
    if (match?.[1]) {
      names.push(match[1]);
    }
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

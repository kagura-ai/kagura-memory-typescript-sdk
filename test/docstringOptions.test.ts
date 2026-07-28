/**
 * Keeps `method({ option })` promises made in JSDoc honest.
 *
 * #25 shipped because `RememberOptions.supersedes` told callers to read the
 * history back with `recall({ includeSuperseded: true })` while
 * `RecallOptions` had no such field and `recall()` built its wire arguments
 * from an allowlist — so the documented option was unreachable even through
 * a cast. Nothing failed; the docs were simply wrong for a release.
 *
 * A docstring that names a sibling method's option is an API promise. These
 * assertions resolve each one against the option interface that method
 * actually takes, so the next such promise either exists or fails the build.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = fs.readFileSync(path.join(repoRoot, "src", "client.ts"), "utf8");

interface Promised {
  method: string;
  option: string;
}

/**
 * Every `` `method({ option ... })` `` written inside a doc comment.
 *
 * Backticks are the discriminator: real code never wraps a call in them,
 * so this only ever reads prose.
 */
function promisedOptions(source: string): Promised[] {
  const found: Promised[] = [];
  for (const match of source.matchAll(/`([a-zA-Z_]\w*)\(\{\s*([a-zA-Z_]\w*)/g)) {
    found.push({ method: match[1]!, option: match[2]! });
  }
  return found;
}

/** The option-interface name in `async method(options: XOptions)`. */
function optionsInterfaceFor(method: string, source: string): string | null {
  const signature = new RegExp(
    `^  (?:(?:public|static|async)\\s+)*${method}\\s*\\(\\s*options:\\s*(\\w+)`,
    "m",
  ).exec(source);
  return signature?.[1] ?? null;
}

/**
 * Property names declared directly on `export interface Name { ... }`,
 * found by brace depth so nested object types cannot leak members up.
 */
function interfaceFields(name: string, source: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^export interface ${name}\\b`).test(l));
  if (start === -1) {
    throw new Error(`could not find \`export interface ${name}\` in src/client.ts`);
  }

  const fields: string[] = [];
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (depth === 1) {
      const field = /^ {2}([a-zA-Z_]\w*)\??:/.exec(line);
      if (field) {
        fields.push(field[1]!);
      }
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0 && i > start) {
      break;
    }
  }
  return fields;
}

describe("the extractors these assertions rest on", () => {
  // Each helper below can fail by finding nothing, which would make every
  // assertion pass vacuously. Pin all three against known-good inputs.
  it("reads options out of doc comments", () => {
    const promises = promisedOptions(clientSource);
    expect(promises).toContainEqual({ method: "recall", option: "includeSuperseded" });
    expect(promises).toContainEqual({ method: "remember", option: "details" });
  });

  it("resolves a method to its option interface", () => {
    expect(optionsInterfaceFor("recall", clientSource)).toBe("RecallOptions");
    expect(optionsInterfaceFor("remember", clientSource)).toBe("RememberOptions");
    expect(optionsInterfaceFor("noSuchMethod", clientSource)).toBeNull();
  });

  it("reads an interface's own fields, not nested ones", () => {
    const fields = interfaceFields("RecallOptions", clientSource);
    expect(fields).toContain("query");
    expect(fields).toContain("includeExploreHints");
    expect(fields).toContain("includeSuperseded");
    // `filters` is documented with nested keys in prose but declared as a
    // Record; nothing from inside another type should appear here.
    expect(fields).not.toContain("trust_tier");
  });
});

describe("documented client options exist", () => {
  it("resolves every `method({ option })` promise in src/client.ts", () => {
    const promises = promisedOptions(clientSource);
    expect(promises.length).toBeGreaterThan(0);

    const broken = promises.filter(({ method, option }) => {
      const interfaceName = optionsInterfaceFor(method, clientSource);
      // Methods taking an inline object type (recallNearby, listTags) are
      // out of scope — there is no named interface to check against.
      if (interfaceName === null) {
        return false;
      }
      return !interfaceFields(interfaceName, clientSource).includes(option);
    });

    expect(broken).toEqual([]);
  });
});

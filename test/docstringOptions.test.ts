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
 *
 * Walks the literal rather than matching one identifier, for two reasons.
 * Reading only the first key would silently skip the rest of
 * `recall({ contextId, includeSuperseded: true })` — under-matching is how
 * a guard turns vacuous. And only depth-1 keys are option names: the
 * `location`/`lat` in `remember({ details: { location: { lat } } })`
 * belong to the value's type, not to `RememberOptions`.
 */
function promisedOptions(source: string): Promised[] {
  const found: Promised[] = [];
  // The literal lives in an inline code span, so the closing backtick ends
  // the scan; the cap is a safety valve against an unterminated one.
  const maxSpan = 400;
  for (const match of source.matchAll(/`([a-zA-Z_]\w*)\(\{/g)) {
    const method = match[1]!;
    const start = match.index + match[0].length;
    let depth = 1;
    let key = "";
    let expectKey = true; // false between a `:` and the next `,`

    for (let i = start; i < source.length && i - start < maxSpan && depth > 0; i++) {
      const ch = source[i]!;
      if (ch === "`") {
        break;
      }
      if (ch === "{") {
        depth++;
        key = "";
        continue;
      }
      if (ch === "}") {
        if (depth === 1 && expectKey && key) {
          found.push({ method, option: key }); // shorthand: `{ contextId }`
        }
        depth--;
        key = "";
        continue;
      }
      if (depth !== 1) {
        continue;
      }
      if (/[\w$]/.test(ch)) {
        key += ch;
        continue;
      }
      // Whitespace must not clear the key, or `{ contextId }` is lost.
      if (/\s/.test(ch)) {
        continue;
      }
      if ((ch === ":" || ch === ",") && expectKey && key) {
        found.push({ method, option: key });
      }
      if (ch === ":" || ch === ",") {
        expectKey = ch === ",";
      }
      key = "";
    }
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

  it("reads every top-level option, not only the first", () => {
    // Synthetic input on purpose: these shapes are legal in a docstring
    // today even if client.ts happens not to contain them, and a guard
    // that only handles the shapes already present is a guard that stops
    // working the moment someone writes a normal sentence.
    const sample = [
      "* `recall({ contextId, includeSuperseded: true })` returns history.",
      "* `remember({ details: { location: { lat, lon, label } } })`; see below.",
      "* `forget({ memoryId })` soft-deletes.",
    ].join("\n");

    expect(promisedOptions(sample)).toEqual([
      { method: "recall", option: "contextId" },
      { method: "recall", option: "includeSuperseded" },
      // `location`/`lat`/`lon`/`label` are the value's shape, not options.
      { method: "remember", option: "details" },
      { method: "forget", option: "memoryId" },
    ]);
  });

  it("does not mistake a value for an option name", () => {
    // `true` sits after the colon; only keys count.
    expect(promisedOptions("`recall({ useRerank: true })`")).toEqual([
      { method: "recall", option: "useRerank" },
    ]);
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

/**
 * `SDK_VERSION` is hand-maintained and had silently drifted: package.json
 * moved 0.1.0 → 0.2.0 → 0.3.0 while `src/version.ts` stayed on 0.1.0, so
 * every User-Agent header and MCP `clientInfo` reported the wrong version.
 * Nothing failed, because nothing compared them. This does.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SDK_VERSION } from "../src/version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("SDK_VERSION", () => {
  it("matches the package.json version", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

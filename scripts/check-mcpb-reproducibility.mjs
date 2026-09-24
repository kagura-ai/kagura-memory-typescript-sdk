import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const path = join(root, "artifacts", `kagura-memory-${version}.mcpb`);
const before = readFileSync(path);
execFileSync(
  process.execPath,
  [join(root, "node_modules/tsup/dist/cli-default.js")],
  { cwd: root, stdio: "inherit" },
);
execFileSync(process.execPath, [join(root, "scripts/build-mcpb.mjs")], {
  cwd: root,
  stdio: "inherit",
});
assert.deepEqual(
  readFileSync(path),
  before,
  "Repeated bundle builds must have identical bytes",
);
console.log("MCPB reproducibility passed");

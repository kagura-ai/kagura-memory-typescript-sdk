import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { VERSIONED_MANIFEST_SCHEMAS } from "@anthropic-ai/mcpb/schemas";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path));
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("mcpb/manifest.json"));
manifest.version = pkg.version;
VERSIONED_MANIFEST_SCHEMAS[manifest.manifest_version].parse(manifest);
const text = (path) =>
  Buffer.from(read(path).toString("utf8").replace(/\r\n/g, "\n"));
// Explicit allowlist: no credentials, checkout paths, node_modules or developer files.
const files = {
  LICENSE: text("LICENSE"),
  "README.md": text("docs/mcpb.md"),
  "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
  "server/mcp.cjs": text("dist-mcp/mcp.cjs"),
};
// Official mcpb pack uses wall-clock timestamps. Use the same ZIP library with
// sorted entries, fixed DOS time and fixed permissions for reproducible bytes.
const entries = Object.fromEntries(
  Object.keys(files)
    .sort()
    .map((name) => [name, [files[name], { os: 3, attrs: 0o100644 << 16 }]]),
);
const bytes = zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) });
const name = `kagura-memory-${pkg.version}.mcpb`;
mkdirSync(resolve(root, "artifacts"), { recursive: true });
writeFileSync(resolve(root, "artifacts", name), bytes);
const hash = createHash("sha256").update(bytes).digest("hex");
writeFileSync(
  resolve(root, "artifacts", `${name}.sha256`),
  `${hash}  ${name}\n`,
);
console.log(`${name} (${bytes.length} bytes)\nsha256: ${hash}`);

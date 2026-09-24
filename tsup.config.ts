import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/mcp.ts"],
    outDir: "dist-mcp",
    format: ["cjs"],
    dts: false,
    sourcemap: false,
    clean: true,
    target: "node18",
    platform: "node",
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node18",
    platform: "node",
  },
  {
    // The bin ships ESM only (package.json is "type": "module") and needs
    // no .d.ts — nothing imports it. `clean` stays off so it cannot wipe
    // the library build above.
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node18",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
  },
]);

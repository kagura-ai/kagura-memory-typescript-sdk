/**
 * The whole suite, run as if on Node 18 — no `globalThis.crypto` (#28).
 *
 * Same pool settings as the base config (see vitest.config.ts for why those
 * are load-bearing); the only difference is the setup file that removes the
 * WebCrypto global. Kept as a separate config rather than a second `include`
 * because the global has to be gone before any module loads.
 */

import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ["./test/setup/noWebCrypto.ts"],
    },
  }),
);

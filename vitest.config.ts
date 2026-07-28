import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Both settings are load-bearing, measured over 24 runs each on a
    // 32-core Windows host (#20). The default threads pool loses a
    // tinypool worker mid-run — "Worker exited unexpectedly" — taking a
    // whole test file's results with it:
    //
    //   threads, uncapped (default)  14/24 failed
    //   threads, maxThreads: 4       12/24
    //   forks,   uncapped             6/24
    //   forks,   maxForks: 4          0/24
    //
    // Capping concurrency alone barely helps; the pool switch is what
    // matters, and the cap closes the rest. Neither the fs-heavy files
    // (auth/credentials, auth/filelock) nor the pure ones reproduce it in
    // isolation, so it is contention across many concurrent workers
    // rather than any single test.
    //
    // The run itself fails loudly — an unhandled error and a non-zero
    // exit — so this was never a green-over-partial-suite risk. What
    // disappears quietly is the file's *results*: the totals shrink while
    // everything that did run still reads as passed. The suite takes ~1s
    // of actual test time, so the extra process startup costs little next
    // to re-running by hand every other attempt.
    pool: "forks",
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});

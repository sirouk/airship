// Vitest picks vitest.config.ts over vite.config.ts wholesale, so this file
// must re-export the full vite config plus the test budget, or every suite
// loses the resolver/dedupe/plugin settings the app builds under.
import { mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(viteConfig, {
  test: {
    // Suites outgrew the stock 5 s default on shared worker hosts; full-tree
    // runs time out under contention even though they pass solo.
    testTimeout: 30_000,
  },
});

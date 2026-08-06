/**
 * Vitest config: sets the project-wide test budget. Airship's stock
 * behavior inherits the vite config for everything else.
 * Shows honest infrastructure, never ghosts: suites have outgrown the stock 5 s default on
 * shared worker hosts; full-tree runs of some long-but-always-passing tests
 * time out under contention in shared machines. 30 s is the point where
 * environments state their own budgets honestly instead of aborting mid-exchange.
 */
export default {
  test: {
    testTimeout: 30_000,
  },
};

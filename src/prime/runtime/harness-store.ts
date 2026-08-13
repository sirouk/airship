import { IndexedDBHarnessStore, type HarnessStore } from "../harness/store";

/**
 * The device's continual-harness store, and the one place that decides there
 * is exactly one.
 *
 * Scope is a *value* in this port, not a database: every entry carries
 * `"local"` or `"global"`, and `mergeHarnessScopes` does local-shadows-global
 * at projection time. So one IndexedDB database per device is the shape the
 * port was written for, and `harness/PORT.md` names it —
 * `airship-prime-harness-v1`, one `kv` object store.
 *
 * Imported statically, not dynamically: this module is only reachable from the
 * prime runtime chunk, which is itself lazy and loads only when a prime turn
 * runs. A dynamic import here would buy no laziness that the chunk boundary
 * does not already provide, and would cost a separate artifact for the release
 * gate to classify.
 *
 * Construction is still lazy, because opening an IndexedDB connection is not
 * free and a page that never takes a turn should never open one. And the
 * getter returns `undefined` rather than throwing where IndexedDB is missing:
 * a session without a harness must omit `prime_harness` with a named reason —
 * which `createPrimeToolRegistry` already does — rather than fail a turn over
 * a capability the page never had.
 */
let store: HarnessStore | undefined;
let resolved = false;

export function primeHarnessStore(): HarnessStore | undefined {
  if (resolved) return store;
  resolved = true;
  try {
    if (typeof indexedDB === "undefined") return undefined;
    store = new IndexedDBHarnessStore();
  } catch {
    // A blocked or unavailable IndexedDB is a missing capability, never a
    // failed turn.
    store = undefined;
  }
  return store;
}

/** Test seam: replace or clear the device store without touching IndexedDB. */
export function setPrimeHarnessStoreForTests(next: HarnessStore | undefined): void {
  store = next;
  resolved = true;
}

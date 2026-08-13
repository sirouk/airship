import type { PrimeHeartbeatStateStore } from "../tools/rlm-tools";

/**
 * The heartbeat registry's state, held where a synchronous read can reach it.
 *
 * `createPrimeRlmHeartbeatTool` reads through this and passes the result
 * straight into `canonicalHeartbeatRegistryState`, so `read` MUST be
 * synchronous — hand it a Promise and every record canonicalizes to empty and
 * the tool silently forgets every heartbeat ever registered. That single
 * constraint is why `HarnessStore` cannot be used directly here: its whole
 * interface is async.
 *
 * So this is a synchronous cache with a durable write-behind. The cache is the
 * authority for reads within a page; the durable side is best-effort and
 * hydrated once at construction. Losing a write to a blocked quota costs the
 * schedule, never the turn — which is the right trade for a data plane whose
 * tool is explicitly documented as CRUD-only, with the clock and the wake owned
 * by the session authority.
 *
 * `localStorage` rather than IndexedDB, and deliberately: it is the only
 * durable browser store with a synchronous read, so hydration needs no await
 * and the first `read` after a reload is already correct. The payload is one
 * bounded slot — at most 32 records, each capped by the tool — so the storage
 * budget this spends is measured in kilobytes.
 */
const STORAGE_KEY = "airship.prime.heartbeats.v1";

export function createPrimeHeartbeatStore(): PrimeHeartbeatStateStore {
  const cache = new Map<string, unknown>();
  hydrate(cache);
  return {
    read(kind: string, id: string): unknown {
      return cache.get(slot(kind, id));
    },
    write(kind: string, id: string, value: unknown): void {
      cache.set(slot(kind, id), value);
      persist(cache);
    },
  };
}

function slot(kind: string, id: string): string {
  return `${kind}/${id}`;
}

function hydrate(cache: Map<string, unknown>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) cache.set(key, value);
  } catch {
    // Corrupt or unreadable state is an empty registry, never a thrown read.
    // The tool already degrades a malformed payload to `{schema:1,records:{}}`;
    // this is the same rule one layer down.
  }
}

function persist(cache: Map<string, unknown>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Best-effort by construction: a full or blocked store costs the schedule,
    // not the turn that registered it.
  }
}

/**
 * One store per page, built on first use.
 *
 * The registry slot is chat-scoped by the tool's own doctrine, but the durable
 * payload is a single bounded slot and the cache is keyed by `kind/id`, so one
 * instance serves every conversation in the tab without them colliding.
 */
let shared: PrimeHeartbeatStateStore | undefined;

export function primeHeartbeatStore(): PrimeHeartbeatStateStore {
  shared ??= createPrimeHeartbeatStore();
  return shared;
}

/** Test seam: drop the cached instance so a fresh one re-hydrates. */
export function resetPrimeHeartbeatStoreForTests(): void {
  shared = undefined;
}

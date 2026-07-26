# Client storage acceleration

**Status:** implemented, browser-conditional, and non-authoritative  
**Boundary:** ciphertext only

Airship can accelerate encrypted Vault workspace objects, conventional Git
metadata stored inside that workspace, and encrypted Context Fabric pages with
origin-private client storage. Google Drive or S3 remains the authority. The
accelerator is never a second Vault and never decides a mutable head.

## Selection ladder

[`createClientCiphertextCache`](../src/storage/client-ciphertext-cache.ts)
selects one backend per adopted Vault partition:

1. OPFS in a dedicated Worker using `FileSystemSyncAccessHandle` when the
   browser actually creates one;
2. OPFS asynchronous file streams in the same worker when OPFS exists but the
   synchronous handle does not;
3. IndexedDB with atomic record writes;
4. a page-memory ciphertext map when persistent browser storage is absent,
   blocked, or fails to initialize.

The selection result is a narrow `CiphertextCacheCapability`. It reports the
activated backend, whether a synchronous access handle is active, persistent
versus page-memory lifetime, supported cache classes, and these fixed facts:

```text
persistenceBoundary = ciphertext-only
authority            = vault-provider-remains-authoritative
```

It does not infer durability from API presence. OPFS is reported only after the
worker opens its origin-private directory and performs a real sync-handle probe.

## Authority and correctness

[`CiphertextCachingObjectStore`](../src/storage/caching-object-store.ts) wraps a
provider only after provider conformance and the encrypted-composition probe
have passed. Its rules are deliberately asymmetric:

- `list`, mutable `get`, `putIfAbsent`, and every `compareAndSwap` go to the
  provider;
- workspace immutable-file objects and `context/segments/*` are the only
  current cacheable key families;
- mutable workspace, journal, and profile heads never match the immutable-key
  classifier;
- a successful CAS invalidates any accidentally classified local copy;
- cache quota, eviction, corruption, and worker failure become cache misses and
  cannot turn a provider commit into a false failure (see *Residency ceiling*:
  the cache bounds its own footprint rather than waiting for browser quota);
- worker closure is terminal and idempotent: in-flight operations reject,
  later operations fail immediately without posting to a terminated Worker,
  and the wrapper proceeds to provider authority instead of waiting forever;
- every cached record binds its kind, exact byte range, ETag, total length, and
  SHA-256 ciphertext digest. A corrupt or mismatched record is removed before
  provider fallback.

Consumers still validate the cached immutable object's ETag or authenticated
descriptor against the current provider-read manifest/head. Thus OPFS does not
become the linearization point and cannot let a stale tab win a workspace or
session CAS.

## Residency ceiling

Eviction is **not** delegated to the browser. Workspace writes mint a fresh
revision-scoped key per edit, so every historical revision would otherwise be
cached under its own key that nothing invalidates. Because a quota eviction
takes the whole origin bucket — including the Local Device vault's own OPFS
records — an unbounded acceleration cache is a durability hazard for the one
provider-independent vault.

`ClientCiphertextCache` therefore owns the bound, so all four page backends
(OPFS sync worker, OPFS async worker, IndexedDB, page memory) inherit it:

- a persisted LRU index under one reserved storage key derived from a constant,
  bounding **both** total bytes (256 MiB default) and entry count (4096,
  because the index is rewritten whole);
- the byte budget is clamped to at most 25% of `navigator.storage.estimate()`
  when that reports a quota, and falls back to the static budget when the
  estimate is absent or throws;
- `CiphertextPageBackend.list()` is a required interface member, not optional:
  reconciliation against the real page listing at cache open is the only way to
  reclaim pages stranded by a crash, a lost index write, or an older build;
- index mutation is serialized across tabs with a `navigator.locks` name derived
  from the partition, and the persisted index is merged rather than clobbered:
  a flushing tab adopts every persisted row it does not know — with that row's
  recorded size and recency — instead of dropping it, so a second tab's pages
  stay inside the ceiling and are not erased from the shared inventory. Rows for
  pages this tab has provably removed since its last flush are the one exception
  and are not revived. A tab's own view still lags another tab's writes until
  its next flush, so the ceiling is enforced per flush, not instantaneously;
  the budget is re-applied to the merged view before it is written;
- read-path recency updates stay in page memory and are coalesced, so a cache
  hit never costs an index rewrite;
- an index that cannot be maintained is a **refusal to cache**, never an
  uncapped cache — the provider stays authoritative either way;
- `CiphertextCachingObjectStore.dropSupersededRevision(key)` releases a
  revision-scoped page that no committed manifest can reference again.
  `EncryptedObjectWorkspace` calls it for the replaced entry after a manifest
  CAS succeeds, for the *just-minted* key when the CAS is lost (on a lost race
  the new revision is the orphan), and for the removed entry in `remove()`.
  This touches only the cache; the provider object is retained until a
  reclamation job trashes it, so a reader holding an older manifest generation
  still resolves.

The OPFS worker also reclaims sibling partition directories under
`airship-ciphertext-cache-v1/` at initialization, but only ones it can prove are
not in use. Every cache holds a **shared** Web Lock named for its own partition
for as long as its worker runs, taken before its directory is created; the sweep
deletes a sibling only if it can take that sibling's **exclusive** lock with
`ifAvailable`. A partition open in another tab therefore fails that check and is
never deleted, and a worker without the Locks API reclaims nothing at all rather
than assuming a sibling is stale. Only this cache root is enumerated, and at
most 64 siblings per initialization.

## Privacy boundary

The cache API receives no `WorkspaceRootKey`, OAuth bearer, S3 credential,
workspace path, prompt, vector plaintext, or decoded Git object. It receives
only bytes already sealed for the Vault `ObjectStore`. The OPFS/IndexedDB key is
a SHA-256 derivation of the cache class, opaque provider key, exact range, and a
hashed Vault partition; the logical provider key is not serialized in the
cache record.

Ephemeral workspace plaintext remains in page memory. Airship does not silently
promote the ordinary `MemoryWorkspace` into persistent OPFS. Any future
plaintext persistence mode requires a separate, explicit user policy and must
not reuse this ciphertext-only contract.

OPFS and IndexedDB remain subject to browser quota, eviction, profile clearing,
private-browsing behavior, and device loss. They establish local acceleration,
not provider synchronization, backup, recovery, or cross-device convergence.

## Coverage

- `client-ciphertext-cache.test.ts` proves backend selection, hashed logical
  addressing, digest corruption rejection, exact range binding, and fail-fast
  worker closure/error lifecycle behavior.
- `caching-object-store.test.ts` proves immutable hits, exact encrypted range
  hits, provider-only mutable reads/CAS, and fail-open-to-authority cache errors.
- `coordinator.test.ts` proves Vault adoption exposes an honest acceleration
  record while stored workspace bytes remain encrypted.
- `opfs-ciphertext-cache.spec.ts` opens a real Chromium OPFS directory, activates
  a dedicated-worker synchronous access handle, closes/reopens the cache, and
  recovers the exact ciphertext page. A third case opens two partitions at once
  and asserts the live one survives the second worker's sweep, then that the same
  directory is reclaimed once its worker is closed and its lock released.

Firefox and WebKit may select async OPFS, IndexedDB, or memory according to the
APIs and permissions actually available. A responsive/device emulation is not
evidence of a real iOS OPFS implementation; that remains a physical-device
acceptance gate.

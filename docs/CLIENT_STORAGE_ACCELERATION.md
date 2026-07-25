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
  cannot turn a provider commit into a false failure;
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
  recovers the exact ciphertext page.

Firefox and WebKit may select async OPFS, IndexedDB, or memory according to the
APIs and permissions actually available. A responsive/device emulation is not
evidence of a real iOS OPFS implementation; that remains a physical-device
acceptance gate.

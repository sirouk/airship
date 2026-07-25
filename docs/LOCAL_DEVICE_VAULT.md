# Encrypted local-device Vault

Status: implemented provider core, custody/recovery UI, encrypted
backup/atomic-restore UI, runtime adoption, and real Chromium OPFS acceptance.

Airship can use the browser origin itself as the authoritative Vault. This is a
real offline persistence mode, not `localStorage`, a page-memory demonstration,
or a cache in front of a required cloud provider.

## Contract

[`LocalDeviceObjectStore`](../src/storage/local-device-object-store.ts)
implements the same `ObjectStore` contract as Google Drive and S3:

- exact byte ranges or an explicit failure;
- atomic create-if-absent;
- single-winner compare-and-swap;
- deterministic prefix listing;
- bounded objects, inventory, and backup files; and
- no inference/API credential persistence.

The production opener selects:

1. **OPFS + Web Locks** — first choice. Web Locks serialize authority changes
   across tabs. Each encrypted record is an opaque-ID file. A full restore
   writes a new generation and commits one atomic authority pointer, so an
   interruption cannot expose half a backup.
2. **IndexedDB** — persistent fallback when OPFS or Web Locks are unavailable.
   One read/write transaction decides each conditional create or CAS. Backup
   replacement clears and installs the authenticated inventory in one
   transaction.
3. **No page-memory fallback** — if neither persistent browser primitive is
   available, opening the provider fails. `MemoryLocalDeviceRecordBackend`
   exists only as an injected deterministic test backend.

The browser may evict ordinary origin storage under pressure. Airship reports
whether persistent-storage permission is already granted and offers a separate,
explicit `requestPersistentLocalDeviceStorage()` user action. It never silently
turns a browser-managed retention policy into a durability promise.

## Encryption and custody

The device adapter receives a non-extractable `WorkspaceRootKey`. It derives a
separate AES-256-GCM key for every opaque object ID and revision. The encrypted
frame authenticates:

- the hidden logical key;
- the object bytes;
- revision, ETag, timestamp, and byte size; and
- its partition-specific opaque storage ID.

OPFS and IndexedDB therefore receive ciphertext, opaque IDs, hashes,
timestamps, and sizes—not logical file paths or plaintext. The partition has
an authenticated identity anchor. Reopening an existing partition with the
wrong recovery key fails closed instead of creating an apparently empty Vault.

This protects stored records and exported backup content. It does not protect
against a compromised browser process, extension, operating system, origin
supply chain, or plaintext deliberately sent to inference.

## Complete runtime composition

[`openLocalDeviceVault`](../src/vault/local-device.ts) returns the same operative
keys as the cloud `ReadyVaultRuntime`:

```ts
const deviceVault = await openLocalDeviceVault({
  partition: `profiles/${profileId}`,
  workspaceKey,
  disposition: "open-existing",
  displayName: "On this device",
});

const {
  store,
  journal,
  workspace,
  profiles,
  contextFabric,
} = deviceVault.runtime;
```

The returned runtime has encrypted sessions, workspace/Git objects, profile
catalogs, and context-fabric generations. Its `acceleration` field explicitly
says `provider-native`: OPFS/IndexedDB is already authoritative, so Airship
does not add a redundant second device cache.

The status/configuration surface contains no key, credential, or plaintext
record. Coordinator/UI adoption can treat this runtime like an already-ready
provider; the cloud coordinator's destructive network conformance probe is not
needed and is not run.

## Encrypted backup and restore

`exportEncryptedBackup()` produces a bounded, versioned, deterministic
encrypted-record inventory. It excludes the workspace recovery key and does not
reveal the plaintext partition, logical paths, or values. Format/version,
opaque IDs, sizes, timestamps, and integrity hashes remain visible metadata.
Restore:

1. bounds and parses the complete file;
2. verifies its partition and inventory digest;
3. rejects duplicate IDs;
4. authenticates every object and exactly one identity anchor with the supplied
   workspace key; and only then
5. atomically replaces the active backend inventory.

Restore is not a method on an adopted runtime. Close every handle and call
`restoreLocalDeviceVaultBackup(...)`; it authenticates the whole backup before
touching the target and takes an exclusive cross-tab Web Lock. A live runtime
holds the corresponding shared lock, so replacement cannot occur beneath
journal, workspace, profile, or context adapters. Browsers without Web Locks
can use the IndexedDB Vault but cannot perform an in-browser restore safely.

A wrong key, corrupted/truncated file, wrong partition, duplicate, or
interrupted pre-commit restore leaves the current Vault untouched. Export is a
manual snapshot, not background sync. Users remain responsible for retaining
both the encrypted backup and the separate recovery material.

The mounted `LocalDeviceVaultSetup` performs that sequence without exposing the
recovery value to application state: it quiesces the active terminal, releases
the adopted shared lease, invokes the authenticated atomic restore, then
reopens the restored authority as target-authoritative state. Current
page-memory state is never merged over a restored backup.

## Schema and migration

The provider reports storage schema `2`.

- IndexedDB upgrades the prior version-1 object database in place and installs
  an explicit schema record.
- OPFS accepts a version-1 authority pointer, preserves its referenced
  generation, and atomically rewrites the pointer to version 2.
- If a partition already has records in the IndexedDB fallback and the browser
  later gains OPFS, Airship keeps the existing IndexedDB authority rather than
  silently opening an empty OPFS Vault. If both backends contain records it
  fails as ambiguous and requires an explicit backup/restore decision.
- Callers explicitly choose `create-new` or `open-existing`. Creation installs
  the identity anchor only through an atomic "complete inventory is empty"
  operation. Existing records without an anchor, an OPFS generation without an
  authority pointer, and a losing race with a non-matching identity payload all
  fail closed.
- Unknown/future schemas fail closed. They are never treated as an empty Vault.

## Evidence

- [`local-device-object-store.test.ts`](../src/storage/local-device-object-store.test.ts)
  covers object-store conformance, encryption, wrong-key/corruption failure,
  races, partition binding, and atomic authenticated backup restore.
- [`local-device-vault.spec.ts`](../e2e/local-device-vault.spec.ts) exercises
  real Chromium OPFS, two simultaneously opened authorities, persistence after
  reload, workspace composition, ciphertext-only backup, and atomic restore.
- [`local-device-product-journey.spec.ts`](../e2e/local-device-product-journey.spec.ts)
  exercises the mounted desktop recovery ceremony, runtime adoption,
  ciphertext download, encrypted context publication, reload, and the mobile
  control surface.

Physical-device retention, quota, eviction, private-mode behavior, and browser
storage bugs remain properties of the selected browser/device and require the
release device matrix; they are not inferred from the Chromium acceptance run.

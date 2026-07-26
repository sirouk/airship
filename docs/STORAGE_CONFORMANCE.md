# Authoritative storage contract

Status: normative for every primary Airship store.

Airship needs more than blob durability. Its authoritative store serializes a
multi-device encrypted event log, mutable vault root, workspace generations,
and selectively streamed context pages. A provider is primary only after it
passes the same observable contract from a real browser.

## Required profile

### Correctness

- Strong read-after-write for new objects and overwrites.
- Atomic create-if-absent equivalent to `PUT` with `If-None-Match: *`.
- Atomic compare-and-swap equivalent to `PUT` with `If-Match: <current-etag>`.
- Exactly one winner when two clients race the same expected ETag.
- Stable, opaque ETags exposed on create, read, range read, list, and CAS.
- Prefix listing with bounded, stable pagination.
- No silent last-write-wins fallback when a conditional header is unsupported.
- `412 Precondition Failed` for a definite expected-version mismatch. A
  provider-specific `409` concurrent-operation conflict is retryable and is
  never collapsed into a false claim that the precondition definitely failed.

The CAS operation is the linearization point for the encrypted vault head. If a
blob network cannot overwrite objects, it can satisfy the same contract with an
atomic named-pointer transaction whose expected generation/digest is checked on
chain. Append-only blobs alone are insufficient because a new device cannot
discover a unique current head or serialize concurrent writers safely.

### Selective retrieval

- Exact single-range reads returning `206`, exact `Content-Range`, exposed
  `Content-Length`, and the same ETag as the full object.
- No implementation that downloads the full parent object before returning a
  slice.
- Cancellation, bounded response sizes, retryable error classification, and
  read-after-write propagation behavior.
- Parallel reads that do not serialize unrelated keys.

### Browser authorization

- Direct HTTPS and CORS; no Airship proxy.
- A standards-based public-client flow that exchanges an existing identity
  assertion for short-lived credentials or signed capabilities.
- Credentials scoped to one account/bucket, opaque prefix, methods, byte limit,
  and short expiry. They live in memory only.
- No long-lived secret, account private key, treasury key, or reusable shared
  SigV4 secret delivered to JavaScript/WASM.
- Revocation, rate limits, replay protection, clock-skew behavior, and a
  fail-closed refresh path.

Required CORS request headers include `Authorization`, `Range`, `If-Match`,
`If-None-Match`, `Content-Type`, `x-amz-date`, `x-amz-content-sha256`, and the
temporary session token. Exposed response headers include `ETag`,
`Content-Range`, `Content-Length`, `Last-Modified`, provider request IDs, and
version IDs when available.

Airship's public default CSP allowlists only Chutes and the current Shelbynet
API. An exact bucket or gateway origin must be added to both `index.html` and
`public/_headers` in a provider-specific build/deployment. The two policies
must remain byte-for-byte aligned because browsers intersect multiple CSPs.
Airship does not use provider-wide wildcards or blanket `connect-src https:`:
either would let a same-origin supply-chain compromise exfiltrate ciphertext
and credentials to an attacker-owned bucket. Truly arbitrary runtime-selected
S3 endpoints therefore require a packaged client policy rather than the public
web build.

### Lifecycle and operations

- Explicit limits, pricing, quotas, availability target, regions, and support
  path.
- Retention extension/renewal that does not require plaintext or a complete
  browser re-upload.
- Honest deletion semantics for primary replicas, caches, erasure fragments,
  backups, and on-chain metadata.
- Export remains available during subscription grace and after inference is
  disabled.
- Provider health, low balance, expiry horizon, and replication state are
  observable without exposing plaintext.

## Implemented baseline

[`S3ObjectStore`](../src/storage/s3-object-store.ts) is the executable reference
adapter. It includes:

- dependency-free browser SigV4 signing, verified against Amazon's published
  signature example;
- only short-lived injected credentials;
- exact range validation;
- `If-None-Match` create and `If-Match` CAS;
- streamed and bounded `ListObjectsV2` pagination and strict XML decoding;
- namespace-confined object keys, bytewise SigV4 sorting, no-store reads, and
  redirect rejection;
- bounded jittered retry for idempotent reads and definite `409`
  conditional-operation conflicts, while ambiguous write transport failures
  are surfaced for read-after-failure recovery rather than blindly replayed;
- HTTPS, response-size, strong ETag, temporary-token, and operation-aware
  credential-expiry checks; and
- no cookie or local credential persistence.

[`runObjectStoreConformance`](../src/storage/conformance.ts) is the provider
gate. Against a disposable prefix it verifies conditional and concurrent
creation, immediate visibility, exact range size/ETag, special-key injectivity,
requested-prefix isolation, empty-prefix listing, missing/stale CAS behavior,
a two-writer CAS race with exactly one winner, and visibility of the winning
root. It returns the keys it creates because the narrow runtime store does not
include deletion. A caller whose store also implements the optional
`ReclaimableObjectStore` may sweep those keys afterwards — `VaultCoordinator`
does, and reports only the removals the provider confirmed. Every other caller
must still configure provider expiry or clean them out-of-band.

Every adapter also exposes a provider-neutral, immutable capability record for
range limits, conditional-write intent, upload mode, and interruption
recovery. That record describes code paths; it is not evidence that a selected
deployment honors them. Only the live conformance result promotes exact range,
conditional create, and CAS to `verified`. Google Drive advertises
`resumable-active-call`; S3 advertises retry of an immutable shard because its
multipart-resume contract is not implemented here. Neither adapter claims a
persisted upload session, partial-object encryption, or cross-refresh resume.

The optional local accelerator is outside provider conformance. Conformance
runs directly against Drive/S3 before the wrapper is installed, so an OPFS or
IndexedDB hit can never manufacture provider evidence. Once ready, only
protocol-declared immutable ciphertext families may be read from the cache;
mutable heads, list, conditional create, and CAS continue through the tested
provider. The exact boundary is documented in
[CLIENT_STORAGE_ACCELERATION.md](CLIENT_STORAGE_ACCELERATION.md).

[`EncryptedObjectJournalBackend`](../src/storage/encrypted-object-journal.ts)
is the first consumer of that contract. It proves the ordering requirement in
code: immutable encrypted segment first, authenticated digest verification,
then encrypted session-head CAS. It never acknowledges a journal append whose
head update lost the race.

The no-custom-backend AWS credential path is implemented by
[`CognitoIdentityCredentialProvider`](../src/storage/cognito-identity-credentials.ts).
Its exact OIDC, IAM, CORS, CSP, and scale boundaries are documented in
[AWS_S3_REFERENCE.md](AWS_S3_REFERENCE.md).

Amazon S3 is the semantic reference because its current API supports both
`If-None-Match` and `If-Match` conditional writes. A browser can receive
temporary, limited AWS credentials directly through Cognito Identity
Pools/STS, so no custom Airship credentials broker is required. Cloudflare R2
also documents Range, `ListObjectsV2`, and conditional `PutObject`; its own
authorization path must still supply temporary user-scoped credentials or
capabilities without embedding an account token.

## Storage roles

```text
Primary S3 contract
  mutable vault head (CAS)
  encrypted manifests
  encrypted event/workspace objects
  Context Fabric packs and exact ranges
  account recovery metadata

Optional immutable networks
  encrypted archive generations
  public verification artifacts
  content-addressed pack replicas
```

Airship may mirror ciphertext to Walrus or another content-addressed network,
but a mirror never becomes the only copy until it also supplies the authoritative
head and recovery contract.

## Primary references

- [Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Amazon S3 SigV4 header authentication](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html)
- [Amazon Cognito Identity Pools for temporary client credentials](https://docs.aws.amazon.com/cognito/latest/developerguide/getting-started-identity-pools-application.html)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

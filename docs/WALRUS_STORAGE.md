# Walrus storage decision

Status: accepted for implementation as an optional immutable data plane; WalruS3 is experimental only.

Date: 2026-07-18

## Decision

Airship should support Walrus, but it should not make the current WalruS3 service its production S3 compatibility layer.

The production shape is:

1. The browser encrypts every session event, workspace object, index page, and manifest before upload.
2. Small immutable records with the same retention policy are batched into Walrus Quilts. Each record remains individually retrievable by quilt patch ID.
3. Large immutable objects are regular Walrus blobs.
4. A small, versioned vault-root record points to the current encrypted generation manifest. Walrus alone does not supply a mutable key namespace or compare-and-swap, so the root must live in either:
   - the user's existing S3-compatible store with conditional writes;
   - a user-owned Sui registry object; or
   - a narrowly scoped storage sidecar operated by the identity/billing provider.
5. Reads go directly from the browser to at least two independently operated aggregators. Fresh writes retry propagation misses with bounded exponential backoff.
6. Mainnet writes go to an authenticated publisher using one-time, short-lived, upload-specific grants. No wallet secret is ever shipped to the client.

This keeps prompts, plaintext, keys, embeddings, file names, and repository contents out of the storage control plane.

## Why WalruS3 is not the production answer today

[WalruS3](https://github.com/chainbase-labs/WalruS3) is a useful compatibility prototype. Its own README describes a service made of Walrus plus PostgreSQL metadata and an API server. That is materially different from Airship's browser-only application model.

The current implementation has four blocking properties:

- `GET` range handling in [`backend/s3walrus/backend.go`](https://github.com/chainbase-labs/WalruS3/blob/master/backend/s3walrus/backend.go) reads the entire Walrus blob into memory and slices it afterward. That defeats the Context Fabric's byte-range budget.
- Bucket names, object keys, versions, deletes, and listings are centralized in PostgreSQL. Losing or corrupting that database loses the namespace even when ciphertext blobs still exist on Walrus.
- It does not expose the conditional create/update contract Airship uses for a single-writer root (`If-None-Match: *`, `If-Match: <etag>`). Treating last-write-wins as compare-and-swap would corrupt concurrent generations.
- Its inherited S3 surface is not yet an adequate security boundary for a funded public service. Authentication, per-user quotas, replay protection, browser CORS exposure, and abuse controls need a dedicated review and implementation.

WalruS3 can still be useful as:

- a local migration tool;
- a developer-mode S3 adapter;
- a reference for mapping S3 objects to Walrus blob IDs; and
- a fork base if its metadata store, authentication, exact range behavior, and conditional-write semantics are replaced and tested.

It must pass the production gate below before the adapter can be promoted.

## Never expose a shared funded wallet

A public wallet key, publisher with no authentication, or reusable bearer token is a direct drain primitive. Anyone who extracts it can spend WAL and SUI, fill capacity, or create lifecycle obligations. Obfuscation in JavaScript or WASM does not protect a secret delivered to an untrusted device.

One treasury can fund every customer, but only behind a constrained publisher:

```text
Airship device                 Chutes storage capability        Walrus
--------------                 --------------------------        ------
hash encrypted upload  -----> check identity + plan + quota
                            <- one-time signed upload grant
encrypted bytes + grant -------------------------------------> authenticated publisher
                            <- blob/quilt receipt + expiry
encrypted reads ---------------------------------------------> aggregator pool
```

Each grant should bind at least:

- issuer, audience, subject, and unique `jti`;
- a short expiry and one-time use;
- network and publisher;
- exact ciphertext byte count and preferably its SHA-256 digest;
- maximum epochs or a concrete expiry;
- workspace/account scope and idempotency key;
- whether the resulting blob object is transferred and to which address; and
- an upload-class quota such as session, workspace, index, or receipt.

Publisher-side enforcement must include authenticated issuance, rate limits, per-user and global budgets, replay suppression, strict body limits, request timeouts, and an emergency circuit breaker. The treasury is split into hot sub-wallets with small balances and automated refill thresholds; the cold treasury never serves requests.

## Clean one-bill model

The best customer experience is a Chutes storage sidecar, not an Airship billing middleman:

- Chutes Plus/Pro includes an encrypted-storage allowance and optional overage/top-up.
- Chutes authentication issues an Airship-scoped token usable in a public client without exposing an OAuth client secret.
- A Chutes storage-capability endpoint checks current account standing and returns one-time Walrus publisher grants.
- The browser sends ciphertext directly to the authenticated publisher and reads ciphertext directly from aggregators.
- Storage usage appears on the same Chutes balance/plan surface as inference.
- Airship remains a static client and never receives payment webhooks, card data, prompt data, or storage keys.

This is still a service-side control plane, because safe sponsorship and account billing cannot be achieved with only static JavaScript. It is not an Airship application backend and does not enter the prompt/data plane.

Until that partnership exists, support these modes in order:

1. **Bring your existing object store** — one bill the user already has; full S3 conditional-write semantics.
2. **User-funded Walrus** — fully self-custodial through the official browser/mobile SDK and upload relay, but it requires a wallet and WAL/SUI funding.
3. **Capped Airship preview pool** — test-only, explicit quota, short-lived grants, no persistence promise, and no public wallet material.

Stripe can charge Airship for a plan, but a static Payment Link cannot securely mint storage or Chutes credentials. Fulfillment, refunds, disputes, entitlement changes, and quota reconciliation require a signed service-to-service event path. If Chutes owns the combined subscription, this complexity stays behind the Chutes account the user already pays.

## Walrus-native object layout

```text
Sui vault root or S3 CAS root
  generation: 481
  manifest_handle: quilt-patch-or-blob-id
  previous_root_digest: ...
  writer_key_id: ...
  signature: ...
              |
              v
encrypted generation manifest
  sessions/*       -> quilt patch IDs
  workspace/*      -> quilt patch IDs or blob IDs
  context/mirror   -> patch ID
  context/experts  -> patch IDs
  receipts/*       -> patch IDs
  prior generation -> manifest handle
```

Names inside Walrus are opaque random identifiers. Descriptive paths live only inside the encrypted manifest. A quilt groups up to a bounded batch of records with the same retention and deletion policy. The Context Fabric fetches only selected expert patches, not the entire quilt. A manifest is published last and the root advances only after every referenced blob is readable from two aggregators.

For recovery, the client validates:

1. root signature and monotonic generation;
2. manifest ciphertext digest and AEAD metadata;
3. every selected blob or patch digest after decryption;
4. the hash link to the prior generation; and
5. expiry horizon, scheduling renewal before the paid end epoch.

Walrus blob confidentiality is not assumed. Everything is encrypted locally with workspace-derived keys; blob IDs, sizes, timing, access patterns, and expiry remain observable. Padding, batching, delayed flushes, query fanout floors, and aggregator rotation reduce—but do not eliminate—metadata leakage.

## Browser transport already implemented

[`WalrusBlobTransport`](../src/storage/walrus-blob-transport.ts) now provides the first production-shaped seam:

- encrypted-blob-only naming;
- HTTPS-only remote endpoints;
- exact `206`/`Content-Range` validation;
- bounded response sizes;
- deterministic multi-aggregator failover;
- current `newlyCreated` and `alreadyCertified` receipt parsing;
- ciphertext SHA-256 commitments;
- optional one-time upload-grant issuance;
- no cookies, wallet keys, or reusable credentials; and
- hard epoch and byte limits.

It deliberately does not implement `ObjectStore`. Pretending immutable blob IDs provide S3 listing and compare-and-swap would hide a correctness bug. The next adapter binds encrypted generation manifests and Quilt patches to this transport after the vault-root choice is finalized.

## Updated operator smoke tests

The earlier service notes are useful, but endpoints and ports are deployment configuration, not protocol constants. Discover current community endpoints from the official network reference and pin an allowlist through signed configuration.

For every configured aggregator:

```sh
curl -fsS "$AGGREGATOR/v1/api"
curl -fsSI "$AGGREGATOR/v1/blobs/$KNOWN_BLOB_ID"
curl -fsS -D - -H 'Range: bytes=1-2' "$AGGREGATOR/v1/blobs/$KNOWN_BLOB_ID" -o /tmp/airship-range.bin
```

The range probe must return `206`, an exact `Content-Range`, and two bytes. Browser preflight must allow `GET`, `Range`, and expose `Content-Range`, `Content-Length`, and `ETag`.

For an authenticated publisher, use a disposable one-use grant and disposable ciphertext:

```sh
curl -fsS -X PUT \
  -H "Authorization: Bearer $ONE_TIME_GRANT" \
  --data-binary @/tmp/airship-ciphertext.bin \
  "$PUBLISHER/v1/blobs?epochs=1"
```

Never put a treasury key, publisher JWT signing secret, long-lived bearer token, or production user plaintext into a smoke-test script.

## Production gate

Walrus becomes a primary Airship storage mode only after all of these are demonstrated:

- Mainnet, not Testnet, for durable customer state;
- two healthy aggregators from independent operators plus bounded retry/backoff;
- exact browser range or Quilt-patch retrieval without whole-parent download;
- authenticated, one-time, parameter-bound upload grants;
- strict quotas, accounting, wallet isolation, and treasury circuit breakers;
- encrypted, signed, recoverable generation manifests;
- a linearizable vault-root update or explicit single-writer lease;
- multi-device key recovery without a reusable client secret;
- automated expiry renewal and low-balance alerts;
- delete/retention semantics documented honestly, including immutable replicas and caches;
- chaos tests for cached `404`, publisher outage, aggregator corruption, stale root, duplicate grant, and epoch rollover; and
- independent security review of publisher, grant issuer, wallet operations, and browser CORS.

## Primary references

- [Walrus network reference](https://docs.wal.app/docs/network-reference)
- [Authenticated publisher](https://docs.wal.app/docs/operator-guide/publishers/auth-publisher)
- [Browser and mobile applications](https://docs.wal.app/docs/examples/browser-and-mobile)
- [Funding Walrus storage](https://docs.wal.app/walrus-memory/fundamentals/architecture/funding-storage)
- [Batch storage with Quilt](https://docs.wal.app/docs/system-overview/quilt)
- [Quilt HTTP APIs](https://docs.wal.app/docs/http-api/quilt-http-apis)
- [WalruS3](https://github.com/chainbase-labs/WalruS3)

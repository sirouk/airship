# Shelby integration brief

Status: candidate primary store; current public interface does not yet satisfy
the full Airship contract.

Date: 2026-07-18

## Short brief to send the Shelby team

> Airship is a static browser agent. The device encrypts every object and calls
> storage directly; there is no Airship data backend. Can Shelby provide either
> (A) a hosted browser-CORS S3 endpoint with per-user/prefix, expiring session
> credentials, exact `206` ranges, `If-None-Match: *`, and atomic `If-Match`
> replacement, or (B) immutable native Shelby blobs plus an Aptos
> compare-and-set vault-head transaction? Chutes/Airship should be able to
> sponsor fees and quota so the user sees one bill. We have an executable
> two-writer/range/list conformance harness and would like to run it against a
> disposable Shelbynet account from the deployed browser origin.

The phrase “S3-compatible” alone is not the gate. The three decisive questions
are: **How does an untrusted browser obtain a short-lived per-user capability?**
**Where is the one-winner mutable vault head linearized?** **Does a byte-range
read deliver and charge for only that range?**

## Why Shelby is strategically attractive

Shelby is much closer to Airship's intended hot-storage workload than a generic
decentralized archive:

- it is designed for high-throughput, read-heavy workloads;
- the official TypeScript SDK explicitly supports browsers;
- RPC reads accept byte ranges;
- user namespaces and blob paths map naturally to encrypted object keys;
- the S3 gateway exposes Range, prefix listing, multipart upload, delete,
  stable commitment-based ETags, and `If-None-Match: *`; and
- Aptos can provide an atomic coordination layer for a vault-head primitive.

Airship encrypts before Shelby sees an object. Blob names are opaque random
identifiers, and plaintext paths live only in an encrypted manifest.

## Current public gaps

The current S3 gateway is an interoperability tool, not a backendless browser
authorization path. Its documented setup runs an always-on gateway holding:

- a shared SigV4 verification secret;
- a Shelby API key; and
- an Aptos Ed25519 private key for write transactions.

The gateway does not support presigned URLs or object versioning. Shelby blobs
cannot be overwritten with different content at the same name; the documented
replacement flow is delete then create. It supports create-if-absent, but not
the `If-Match` compare-and-swap required for Airship's mutable vault head.

The native browser SDK avoids the local gateway and supports direct range
reads/uploads, but the documented upload flow requires an Aptos wallet plus APT
and ShelbyUSD. That creates the second-bill and wallet friction the product is
trying to remove. Shelby is also currently described as Early Access/Shelbynet,
so production persistence, commercial SLA, pricing, and launch guarantees need
confirmation.

Additional current constraints matter for the conformance gate:

- the browser SDK forwards a range but does not itself prove that the RPC
  returned `206`, the requested `Content-Range`, and only the requested bytes;
- documented frontend/Geomi API keys identify and rate-limit an application,
  but are not per-user, prefix/method-scoped storage capabilities;
- configurable production bucket CORS is not part of the current S3 gateway;
  and
- the gateway's indexer-backed list/delete view can lag the chain, so global
  read/list/delete consistency is not yet a documented contract.

## Smallest protocol work that unlocks Airship

There are two valid designs. Shelby need implement only one vault-head option,
plus browser-safe authorization.

### Option A: S3-complete path

1. Hosted Shelby S3 endpoint with browser CORS.
2. Identity-token exchange for short-lived prefix/method/byte-scoped
   credentials; no shared secret or Aptos private key in the browser.
3. `PutObject` with real `If-Match` atomic replacement and `412` on mismatch.
4. Stable ETag returned and exposed by PUT/GET/Range/List.
5. Provider-funded or delegated Aptos fee/storage sponsorship included in the
   same account entitlement.

This lets Shelby pass Airship's existing `S3ObjectStore` and live conformance
suite unchanged.

### Option B: native Shelby path

1. Keep data blobs immutable and use the browser SDK's direct Range API.
2. Add an Aptos `VaultRegistry` resource keyed by account and opaque vault ID:

```move
compare_and_set_head(
  vault_id,
  expected_generation,
  expected_manifest_commitment,
  next_generation,
  next_blob_name,
  next_manifest_commitment,
  writer_fencing_token,
)
```

3. The transaction aborts unless both expected generation and commitment match.
4. The same transaction records the next head and monotonically increasing
   fencing token.
5. Shelby or Chutes sponsors the transaction after validating a one-use scoped
   capability. The user does not manage APT or ShelbyUSD.

This is semantically equivalent to S3 CAS and may fit Shelby's immutable model
better than overwrite support. The Airship adapter would implement
`compareAndSwap` through the registry while storing every manifest generation as
an immutable Shelby blob.

## Proposed browser capability

The ideal exchange is:

```text
Chutes OIDC/service token + Airship public-client PKCE assertion
    -> Shelby delegated storage token
       subject, account, opaque prefix, methods, max bytes, max expiry,
       request count, jti, audience, plan authorization, optional fee sponsor
```

The token authorizes protocol actions; it is not an Aptos account key. A write
receipt returns the blob commitment, transaction hash, account/name,
expiration, byte count, and provider acknowledgements. Airship binds those
fields into its encrypted storage receipt.

For one bill, Chutes can purchase or settle Shelby capacity as a service
partner, and Chutes account standing can authorize Shelby capabilities. The
device still sends only ciphertext directly to Shelby. If Shelby prefers to own
the subscription, Chutes inference can instead be a metered entitlement inside
Shelby's account. Either direction is clean; asking the browser to manage two
tokens and two balances is not.

## Questions for the Shelby team

These are the blocking integration questions, in priority order:

1. Can Shelby expose an atomic compare-and-set named head—through S3
   `If-Match` or an Aptos registry transaction—with exactly one winner under a
   concurrent race?
2. Is there a hosted S3 gateway roadmap, or should browser applications use only
   the native SDK/RPC?
3. What is the public-client authentication plan? Can an OIDC token be exchanged
   for short-lived scoped capabilities without an embedded API secret or Aptos
   private key?
4. Can Shelby sponsor both APT gas and ShelbyUSD storage/read payments and meter
   them to one partner account while preserving per-user quotas and receipts?
5. Do Range responses guarantee exact `206`, `Content-Range`, stable commitment
   ETag, CORS exposure, and no full-object retrieval inside the RPC?
6. What are the formal read-after-write, list/indexer lag, concurrent-create,
   delete, and RPC failover semantics?
7. Can retention be extended in place without re-uploading ciphertext? Who can
   renew, and what happens during account/payment lapse?
8. What blob-name, size, timing, reader, payment-channel, and account metadata is
   public on Aptos or visible to RPC/storage providers?
9. Are reads access-controlled today, or public to anyone who knows the
   account/name? Can capabilities restrict reads to an opaque prefix?
10. What are current/future object, range, request, multipart, account, and
    pagination limits, prices, mainnet date, SLO/SLA, and supported regions?
11. Is there a browser-safe way to verify range bytes against the on-chain Merkle
    commitment without downloading the full blob?
12. Will the team run Airship's live
    [`runObjectStoreConformance`](../src/storage/conformance.ts) harness against a
    disposable Shelbynet account and publish the report?
13. Can the native RPC return a range proof that a browser can verify against
    the on-chain Merkle commitment, while charging only for delivered bytes?

## Recommendation

Use real AWS S3 or a conformant S3 provider as the M1 authoritative store now.
Keep the storage contract provider-neutral. Build Shelby as the preferred
candidate adapter with the team, targeting either Option A or Option B above.
Do not block the agent runtime, encryption format, Context Fabric, or Git work
on Shelby's commercial/protocol timeline.

## Primary references

- [Shelby protocol](https://docs.shelby.xyz/protocol)
- [Shelby architecture](https://docs.shelby.xyz/protocol/architecture/overview)
- [Shelby browser TypeScript SDK](https://docs.shelby.xyz/sdks/typescript/browser)
- [Shelby RPC range API](https://docs.shelby.xyz/apis/rpc/shelbynet/storage/getBlob)
- [Shelby S3 gateway](https://docs.shelby.xyz/tools/s3-gateway)
- [Shelby S3 compatibility](https://docs.shelby.xyz/tools/s3-gateway/compatibility)
- [Shelby S3 uploads](https://docs.shelby.xyz/tools/s3-gateway/uploads)

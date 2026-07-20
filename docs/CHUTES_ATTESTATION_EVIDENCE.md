# Chutes attestation evidence in Airship

Status: implemented provider/evidence client and browser-local Intel DCAP QVL.
Source review and live probes: 2026-07-19.

## Executive trust statement

Airship requests fresh Chutes endpoint evidence, parses it defensively, binds
the caller nonce and discovered E2EE key to Intel TDX `report_data`, and runs
Phala's pure-Rust `dcap-qvl` locally in deferred browser WASM. A verified CPU
claim requires an Intel production chain, CRLs, QE Identity, collateral
validity, debug prohibition, and aggregate/QE/platform `UpToDate` status with no
advisories. Airship separately compares MRTD/RTMR measurements with Chutes'
published policy feed.

NVIDIA verification is currently partial. Chutes' evidence schema also does not bind model weights, a
request, a response, a conversation, usage, or payment. The resulting object is
an `endpoint-evidence` record whose claims are evaluated independently. Only a
fresh exact-instance/key CPU-QVL result plus matched runtime policy can promote
the endpoint tier; it never becomes a verified conversation receipt. A local
mismatch is `rejected`.

## Current browser-facing provider surfaces

| Surface | Authentication | What it returns | Important limit |
| --- | --- | --- | --- |
| `GET /e2e/instances/{chute_id}` | Bearer required; Chutes accepts `cak_` OAuth access tokens and `cpk_` API keys subject to server-side scope/access checks | A random bounded subset of active E2EE instances, ML-KEM-768 public keys, and single-use invocation nonces | Current server code returns at most 5 instances, 10 nonces each, with a 60-second client window and 75-second Redis TTL |
| `GET /instances/{instance_id}/evidence?nonce={64 lowercase hex}` | Bearer required; access to the owning/shared/public chute is checked | One TDX quote, per-GPU NVIDIA evidence objects, and a DER certificate | 60/minute; current runtime-evidence implementation requires `chutes_version >= 0.6.0` |
| `GET /chutes/{chute_id}/evidence?nonce={64 lowercase hex}` | Anonymous for a public chute; otherwise bearer access | Evidence for all currently eligible instances plus `failed_instance_ids` | Dynamic batch; the instance set can change between calls |
| `GET /servers/tee/measurements` | Public | Chutes-accepted MRTD, boot/runtime RTMRs, expected GPU families, and GPU counts | Server caches the feed for one hour and excludes release-candidate policies |

Authoritative source locations in this checkout:

- `chutes-api/docs/tee-verification.md`
- `chutes-api/api/e2e/router.py`
- `chutes-api/api/instance/router.py`
- `chutes-api/api/chute/router.py`
- `chutes-api/api/server/router.py`
- `chutes-api/api/server/service.py`
- `chutes-api/api/server/schemas.py`
- `chutes-api/api/main.py`
- `chutes-api/api/api_key/util.py`

The reviewed deployed-code snapshot originally classified discovery as a chute
invocation but let evidence routes fall through to path-derived
`evidence:read`. Thus `openid profile chutes:invoke billing:read` could discover
an endpoint and receive HTTP 403 on its private evidence.

This workspace now classifies exact evidence `GET` routes under
`chutes:invoke`: chute-batch requests preserve the chute identifier, while an
instance request requires wildcard invoke and then relies on the existing
handler's ownership/share/public/subnet authorization. Read/profile/unrelated
methods and routes do not gain access. Focused OAuth/API-key tests cover both
positive and confused-scope cases. This is a least-privilege source fix, not
production evidence until deployed. Airship still treats every 401/403 as an
access failure; for a public chute only, it may retry the anonymous batch route
and retain the exact already-authenticated discovery instance/key pair.

### Live payload observations

On 2026-07-18, the public `Qwen/Qwen3-32B-TEE` chute
`ac059e33-eb27-541c-b9a9-24b214036475` returned:

- 14 instance evidence records;
- 8 GPU evidence objects per instance;
- 0 failed instances;
- approximately 1.48 MB of JSON.

The public measurement feed returned 21 valid records (approximately 22.8 KB).
One observed policy was version `1.3.0`, profile `8xh200`, GPU count 8.

These observations are diagnostics, not schema guarantees. The client keeps a
4 MiB hard evidence-response cap, 256 KiB discovery/policy caps, 64 batch
instances, 16 GPU evidence objects per selected instance, and 128 policy rows.

## Direct browser availability and fail-closed behavior

The Kubernetes ingress enables CORS. The live preflight and subsequent evidence
and measurement GETs were most recently observed with wildcard origin
authorization, and Airship's real Chromium live test retrieved endpoint
evidence directly without an Airship proxy. This is an observed deployment
state, not an eternal provider guarantee.

Airship therefore maps an unreadable cross-origin fetch to
`cross-origin-unreadable`. Browser Fetch cannot distinguish missing CORS from
DNS, TLS, offline, or another network failure, so the diagnostic says exactly
that: CORS authorization or the network path may have failed. No evidence is
accepted and no TEE claim is failed or promoted merely because transport was
unreadable.

There is intentionally no Airship proxy workaround. The API ingress template in
this workspace explicitly declares wildcard origin access while keeping CORS
credentials disabled, consistent with a direct public/bearer-token API; a
deployment-contract test prevents accidental removal. Airship still verifies
the response headers and evidence content every time rather than promoting an
old successful probe into a permanent trust claim.

### Complete QVL and compact fallback

Airship's deferred `dcap-qvl` WASM pack uses the pure-Rust `rustcrypto` backend
and downloads only when evidence is evaluated. It validates the production
Intel chain, PCK/root revocation, QE Identity, collateral windows, quote
signature, debug policy, and TCB. Generated glue is rejected at build time if
it contains unresolved native imports. A real Chromium test runs a captured
Chutes quote through the actual WASM and live Intel-signed collateral path.

The compact WebCrypto fallback validates the quote/PCK signature path to a
pinned Intel root, the caller nonce and endpoint-key `report_data` binding, TD
debug state, signed TCB information, and an `UpToDate` result with no
advisories. That is meaningful local evidence, but it is not a complete Intel
QVL decision: PCK/root revocation lists, QE Identity, and every collateral
validity window are not yet evaluated. The UI therefore labels a successful
compact check as **partial / unverified**, never `verified`.

## Exact evidence semantics

### What the quote locally binds

Chutes documents this construction:

```
report_data[0..32] == SHA256(UTF8(attestation_nonce + e2e_pubkey_base64))
```

Airship generates a cryptographically random 32-byte nonce, validates canonical
ML-KEM-768 public-key encoding, parses bounded Intel TDX quote-v4/v5 envelopes,
and performs a constant byte comparison.

A match establishes only that returned bytes are internally consistent. After
an independent quote signature and policy verification, that same match can
establish challenge freshness and key possession inside the attested TD.

The quote construction does **not** contain the chute ID or instance ID. Those
IDs are API/discovery correlation metadata, not cryptographically quote-bound
identities. It also does not contain a model identifier or model artifact digest.
Each endpoint record includes `subject.e2ePublicKeyDigest`, computed with
Airship's canonical `sha256:` base64url function over the canonical base64 key
string. A turn may correlate to endpoint evidence only when its invocation-time
instance ID and this key digest both match; the instance ID remains provider
metadata rather than a quote claim.

### CPU / Intel TDX

Airship labels CPU authenticity `verified` only when the complete local QVL and
the exact nonce/key binding pass. The implemented verifier validates:

- quote-v4/v5 signature and certificate chain (the bundled QVL currently
  verifies attestation key type 2; Chutes-accepted key type 3 is reported as
  verifier-unsupported and never promoted);
- Intel DCAP collateral and its freshness;
- TCB status under an explicit fail-closed policy;
- TDX debug/production attributes;
- MRTD and all runtime RTMR values against a pinned policy;
- the nonce and E2EE public-key digest in `report_data`.

The browser wall clock supplies collateral time. Structural parsing and
measurement equality never replace these checks.

### Published measurement policy

`GET /servers/tee/measurements` is useful transparency data. Airship strictly
validates its schema and compares the quote's MRTD and RTMR0-3 to every published
runtime policy. A match is `matched`, not `verified`, because the feed is Chutes-
published HTTPS JSON without a separate signature or transparency-log proof.
No stale feed is used after an invalid or failed refresh.

### GPU / NVIDIA

Airship currently checks the NVIDIA certificate chain and SPDM signature, so a
successful result is `matched/partial`. It is not `verified`: caller nonce
binding, RIM/golden firmware comparison, revocation/freshness, and complete
confidential-compute policy remain required. Counting JSON objects is never GPU
authenticity.

### Certificate

Chutes documents the DER certificate as reference material. The third-party
evidence construction described above does not establish a certificate-to-quote
binding, so Airship records `binding: not-established`.

### Model and conversation

Current evidence supplies no cryptographic proof for:

- model weights or artifact digest;
- plaintext or ciphertext request digest;
- plaintext or ciphertext response digest;
- full conversation transcript;
- inference usage, price, charge, or settlement.

Those dimensions remain `unavailable`. Local Airship journal hashes are valuable
client records but are not enclave signatures.

## Discovery and post-hoc inspection

`ChutesAttestationEvidenceClient.inspect()` is designed for App integration when
Airship has a chute ID and receipt instance ID but no preserved lease key:

1. perform authenticated E2EE discovery;
2. locate the exact requested instance;
3. discard all returned invocation nonce values immediately;
4. refuse to substitute a different instance;
5. request evidence for that endpoint;
6. return either a typed evidence record or a typed unavailable snapshot.

Discovery may return only a random subset of active instances. Failure to find
the exact instance is therefore unavailable, not proof that it never existed.
Rediscovery also describes the current endpoint, not necessarily the endpoint
key used by a prior turn. It must never retroactively upgrade a conversation.

The correct production design is to pin the invocation-time lease before
encryption: chute ID, instance ID, E2EE public key digest, discovery timestamp,
and nonce-window metadata. Post-hoc evidence must match that immutable lease.

## Client reliability and privacy controls

The implementation lives in:

- `src/attestation/provider-types.ts`
- `src/attestation/provider-client.ts`
- `src/attestation/provider-client.test.ts`

Controls include:

- exact allowlisted schemas and unknown-field rejection;
- canonical base64, quote-v4/v5, DER, identifier, count, depth, string, and byte bounds;
- CORS mode, `credentials: omit`, no referrer, no-store, and redirect rejection;
- safe HTTP diagnostics that never expose provider bodies or bearer values;
- per-caller abort isolation and shared-request deduplication;
- latest-refresh-wins supersession even when a fetch implementation ignores abort;
- cache writes gated by active request generation;
- immutable account/connection cache partitions;
- no stale evidence or stale policy fallback;
- optional policy-feed timeout/failure degrades only the policy claim to
  `unavailable`; explicit caller cancellation still aborts the acquisition;
- a 90-second evidence memory-cache policy (not proof expiry);
- 16-entry and 8 MiB total raw-evidence memory LRU bounds;
- deadline timers that evict unused raw evidence without waiting for another read;
- provider discovery expiry respected and capped at 60 seconds locally;
- no localStorage, IndexedDB, OPFS, cloud, cookie, journal, or log persistence;
- no invocation nonce values in discovery snapshots;
- metadata-only portable export by default;
- explicit `{ includeRawEvidence: true }` opt-in for forensic export.

The standard export removes raw quote/GPU/certificate material, the E2EE key,
attestation nonce, report data, binding digests, and the query-bearing request
URL. It retains claim states, record identity, payload digest, sizes, provider
metadata, and warnings.

### Performance note

The client selects one instance record from a bounded batch, but the browser must
still parse the provider's complete JSON response. Canonical evidence hashing and
normalization currently run on the main thread, while SHA-256 itself uses Web
Crypto. Before routine high-frequency attestation, move batch parsing,
canonicalization, and policy matching to a dedicated worker with transferable
buffers or a streaming parser. The current short-lived, explicit inspection flow
is bounded and cancellation-safe but is not the final billion-device hot path.

## Remaining trust-tier gates

Airship may display **CPU TEE verified** after the exact invocation-time key,
fresh nonce, complete local Intel QVL, and current Chutes runtime-measurement
match pass. It must not turn that scoped result into a whole-endpoint,
accelerator, model, conversation, or payment seal.

Stronger tiers still require:

1. a signed/pinned workload policy rather than mutable HTTPS JSON;
2. NVIDIA nonce, revocation, RIM/firmware, freshness, and confidential-mode
   policy verification;
3. a model artifact digest cryptographically bound to execution;
4. an enclave signature over request, response, model, endpoint, session, turn,
   usage, and timestamp for conversation-level proof; and
5. a separately signed payment/settlement proof bound to that turn.

Every icon remains claim-scoped: `verified`, `matched`, `unverified`,
`unavailable`, or `rejected`—never an aggregate implication.

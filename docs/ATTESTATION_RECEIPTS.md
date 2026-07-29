# Attestation and conversation receipts

Implementation status, 2026-07-28: the unified `ProofView` is mounted in `App`
with receipt, session-audit, endpoint-evidence, and verifier-ledger tabs,
automatic bounded evidence acquisition, and explicit acquisition notices. The
legacy Attestations route deep-links to the evidence tab; it is not a second
trust surface. Proof does not claim that evidence has been pulled merely
because the route exists.

Acquisition scheduler state and accepted endpoint-evidence records are separate,
Profile-partitioned compare-and-swap checkpoints under private `.airship` paths
through the active authoritative `WorkspacePort`. In page-memory mode they
remain page-lifetime state. When the active port is a client-encrypted Local
Device, Google Drive, or S3-compatible Vault, both checkpoints inherit that
port's encrypted durability. Storage/Profile switches quiesce the old queue,
client, and record authority before migration. After reload or a scope change,
Airship first installs a credential-backed evidence client, then recovers the
matching Profile/workspace record store, and only then resumes interrupted queue
work. With no credential, persisted queue work is paused rather than spent as a
failed attempt.

The record checkpoint retains each accepted credential-free record whole:
bounded raw TDX quote, DER certificate, NVIDIA/provider evidence, request nonce,
endpoint public key, report data, binding digests, measurements, local verifier
results, and warnings. It retains at most 32 records, at most 3 MiB per complete
record, and at most 12 MiB per Profile checkpoint. There is no silent age
pruning or capacity eviction. A record that crosses a boundary, or whose CAS
write fails, remains explicitly page-only with a visible reason; existing proof
is preserved and no raw field is silently truncated. The evidence client's
transient request/cache machinery and every Chutes credential remain page-memory
only. This is therefore a bounded durable evidence cache, not a complete proof
archive, so Proof completeness remains partial.

Airship makes proof visible at the point where a user needs it: beside each
assistant response. A compact row of badges opens an evidence drawer. The
default **unsigned, privacy-safe status summary** omits raw quotes,
certificates, signatures, public keys, nonces, provider bodies, arbitrary claim
detail objects, dictionary-testable plaintext request/response digests,
free-form verifier prose, and identity metadata. Proof also offers a separately
labeled **raw verification bundle** containing the bounded receipt, journal
audit, and complete endpoint-evidence records available for that Profile and
session. Those raw artifacts can be checked by independent Intel/NVIDIA and
binding verifiers, but the bundle is unsigned by Airship or an enclave and does
not contain the full immutable journal. A future selective-disclosure bundle
still needs a canonical signed manifest and explicitly selected artifacts; it
must never replace the privacy-safe default.

## Badge vocabulary

| Badge | Claim | Verified only when |
| --- | --- | --- |
| Lock | Payload encryption | request and response cryptographic operations completed under the declared suite |
| Spark | Freshness | a client-generated 32-byte challenge is bound into valid evidence and is within policy age |
| Chip | CPU TEE | Intel DCAP quote signature/chain and TCB status pass policy, debug is off, and measurements are allowed |
| GPU | GPU confidential mode | NVIDIA evidence passes an accepted verifier and is bound to the same challenge/key |
| Key | Endpoint binding | quote `report_data` matches `SHA256(attestation_nonce + e2e_pubkey)`; chute/instance IDs remain API/discovery correlation only |
| Cube | Model/runtime | approved model artifact digest, image/runtime measurement, and configuration are cryptographically bound |
| Page | Conversation | enclave-signed receipt binds canonical request and final response/transcript digest with a terminal record |
| Coin | Payment | signed settlement/authorization receipt binds price/usage to the turn without exposing payment authority |

Each badge is `verified`, `partial`, `failed`, `expired`, or `unavailable`.
Color is never the only signal. The summary must say what was checked locally,
what an external verifier asserted, what policy was used, and what remains
unproved.

## Proof levels

1. **Local receipt** — Airship records canonical plaintext digests, ciphertext
   digests, provider metadata, timing, and code version. Useful for integrity
   and debugging, but self-asserted by the client.
2. **Attested endpoint receipt** — fresh Intel/NVIDIA evidence verifies the
   exact E2EE public key and approved runtime measurements. Chute and instance
   IDs are correlated through API/discovery metadata, not quote `report_data`.
   See [Chutes attestation evidence](./CHUTES_ATTESTATION_EVIDENCE.md).
3. **Model-bound receipt** — evidence or a signed manifest additionally binds
   the exact model weights/revision and inference configuration.
4. **Conversation receipt** — an enclave key attested above signs canonical
   request digest, ordered response/transcript digest, terminal state, model
   digest, instance, and time/counter. This is the target for independently
   proving a specific conversation.
5. **Settlement receipt** — a payment service signature binds billable usage and
   amount/currency/token transfer to the conversation receipt digest.

Levels are cumulative. Airship never promotes a local hash to a hardware proof.

## Current Chutes evidence flow

For every successful Chutes turn, the inference transport records the exact
invoked instance and a digest of the E2EE public key in that immutable local
receipt. It also commits the request ciphertext and a domain-separated,
order-sensitive SHA-256 chain over every authenticated response-ciphertext
record. That promotes only the local conversation-integrity claim to
`partial / airship-client`; it is not an enclave-signed transcript and cannot
promote the Conversation badge to verified. Evidence acquisition is a
separate, non-mutating follow-up:

1. use the turn's exact chute, instance, and invocation-time key digest;
2. call authenticated `GET /e2e/instances/{chute_id}` and select only the exact
   instance whose public-key digest matches that receipt;
3. generate 32 random bytes and hex-encode them;
4. call `GET /instances/{instance_id}/evidence?nonce={hex}` with the user's
   memory-only Chutes credential;
5. if that request is specifically unauthorized and the chute is public, try
   the anonymous public-chute batch route, then retain only the exact previously
   discovered instance/key pair;
6. validate and retain the returned base64 TDX quote, NVIDIA evidence,
   certificate, nonce, endpoint key, and binding material as one complete,
   Profile/session/receipt-scoped record through the active `WorkspacePort`, or
   mark that whole record page-only when an explicit boundary is crossed;
7. structurally parse the TDX quote and evidence envelope;
8. compute `SHA256(nonce + e2e_pubkey)` using the documented string
   concatenation and compare it with the first 32 bytes of TDX `report_data`;
9. optionally compare quote measurements with the Chutes-published HTTPS
   measurement feed, clearly labeling this as a local comparison to an
   unsigned provider feed; and
10. pass the bounded record to separately reviewed Intel, NVIDIA, model, and
    transcript verifier ports when those verifiers exist.

Provider request URLs are reduced to their query-free source before durable
storage, and credentials or credential-shaped fields are rejected. The
Profile/workspace/session-fenced presentation state keeps the complete accepted
record so the raw bundle remains independently checkable, while the ordinary
Proof surface renders normalized claims and lazy disclosures instead of a raw
wall. Correlation retains the exact session, receipt, instance, and
invocation-time endpoint-key digest. Evidence never rewrites or promotes the
historical receipt.

Evidence retrieval alone does not verify quote authenticity, current TCB,
NVIDIA authenticity, model weights, or a conversation. Airship's deferred local
Intel QVL verifies CPU authenticity and TCB before promoting that claim; the
NVIDIA result remains partial, and Chutes endpoint evidence still carries no
model-artifact signature or enclave-signed request/response transcript.

The key-binding comparison is small enough to perform directly in the browser.
Full Intel DCAP verification runs in reviewed, deferred browser WASM without an
Airship backend. Complete NVIDIA verification still requires the missing
nonce/RIM/firmware/revocation policy checks. Evidence fetch or partial parsing
alone never produces a green CPU/GPU badge.

### Current browser-access finding

On 2026-07-23 the live Chromium acceptance gate retrieved Chutes endpoint
evidence and the public measurement feed directly from the browser after an
encrypted vision turn. The observed ingress authorized cross-origin reads.
This is deployment evidence, not a permanent API guarantee and not proof that
any quote is authentic.

If a later browser cannot read the route, Airship reports **cross-origin
unreadable / evidence not pulled** because CORS authorization, DNS, TLS,
offline state, or another network-path failure can look identical to browser
JavaScript. It is not a TEE failure and cannot create a failed or verified
hardware claim. Airship does not suggest or insert a hidden proxy.

The reviewed Chutes API snapshot originally classified evidence routes as
`evidence:read`, so the Airship OAuth grant (`openid profile chutes:invoke
billing:read`) could discover invocation endpoints yet receive HTTP 403 on
private evidence. This workspace now contains a least-privilege middleware fix:
exact evidence `GET` routes classify as `chutes:invoke`, chute-scoped batch
evidence preserves its chute identifier, instance evidence requires wildcard
invoke and then relies on the existing handler's ownership/share/public/subnet
authorization. Read/profile/unrelated routes are unchanged. The ingress chart
also now explicitly emits wildcard ACAO with credentialed CORS disabled, which
matches a direct bearer-token/static-client API. These changes and their 25
focused regressions must still be deployed and verified from the production
Airship origin; the live observation above remains the truth for the currently
observed deployment.

Because evidence batches are substantial, the UI renders normalized counts,
digests, measurements, and claim summaries. Raw artifacts remain bounded and
appear only through explicit disclosure or raw-bundle export rather than an
undifferentiated default render.

The presentation boundary accepts at most 512 endpoint records and 512 receipts
per supplied page, then retains the newest 128 of each source. An oversized
page is rejected before copying or sorting and must be paginated upstream. The
durable endpoint-record cache has the stricter 32-record, 3 MiB-per-record, and
12 MiB-per-checkpoint boundaries described above.

## Portable receipt v1

The following is the target shape after every named verifier has genuinely
succeeded; it is not the state produced by evidence fetching alone.

```json
{
  "version": 1,
  "receiptId": "urn:airship:receipt:...",
  "sessionId": "opaque-id",
  "turnId": "opaque-id",
  "createdAt": "2026-07-18T12:00:00.000Z",
  "proofLevel": "attested-endpoint",
  "provider": "chutes",
  "instanceId": "...",
  "claims": {
    "encryption": { "status": "verified", "suite": "chutes-e2e-v1" },
    "freshness": { "status": "verified" },
    "cpuTee": { "status": "verified", "policyDigest": "..." },
    "gpuTee": { "status": "verified", "policyDigest": "..." },
    "endpointKey": { "status": "verified" },
    "model": { "status": "unavailable" },
    "conversation": {
      "status": "partial",
      "verifier": "airship-client",
      "details": {
        "commitment": "airship-chutes-e2e-response-sha256-chain-v1",
        "authority": "local-client"
      }
    },
    "payment": { "status": "unavailable" }
  },
  "bindings": {
    "requestDigest": "sha256:...",
    "responseDigest": "sha256:...",
    "requestCiphertextDigest": "sha256:...",
    "responseCiphertextDigest": "sha256:...",
    "evidenceDigest": "sha256:..."
  },
  "evidence": {
    "format": "chutes-tee-evidence-v1",
    "payload": {}
  },
  "verifications": [
    {
      "verifier": "airship-client",
      "status": "partial",
      "claim": "conversation"
    }
  ]
}
```

Sensitive plaintext is never embedded by default. Unsalted hashes of short or
low-entropy prompts and answers are dictionary-testable, so the public status
summary omits plaintext request/response digests too. A future disclosure
package may contain selected salted or keyed commitments plus the material
needed to verify them. Receipt IDs and cloud object names are opaque so they do
not leak conversation titles.

## Receipt import trust boundary

`ConversationReceipt` is a structural data shape, not proof of authenticity.
Every receipt entering `AttestationsView` is therefore rendered as an
**assertion / partial**, regardless of a claimed verifier name. There is no
public validation-wrapper escape hatch in this milestone. Future promotion
requires an opaque, verifier-produced artifact that recomputes the exact
canonical receipt digest, validates its signature and claim-authority policy,
deep-freezes the bound receipt, and cannot be reconstructed from cloud JSON.

## Canonical transcript binding

Conversation proof uses a versioned canonical encoding, not rendered Markdown
or provider JSON. It covers ordered roles/content/tool calls/tool results,
attachments by content digest, system/tool manifest digests, model/runtime
identity, and a terminal completion marker. Streaming deltas are folded into the
final ordered content and an optional incremental transcript hash.

## Verification UX

- Badges appear on every assistant message and in the global connection strip.
- The unified Proof surface keeps endpoint acquisitions and
  conversation receipts as separate selectable records. It shows a claim
  matrix for transport, freshness, CPU TEE, GPU TEE, endpoint key, model/policy,
  conversation signature, and settlement, with an independently selectable
  verifier ledger.
- Clicking a claim shows its plain-language summary, exact status and
  qualifier, verification authority/class, verifier version, checked time,
  actual expiry when supplied, policy digest, measurements, and bindings.
  Cache lifetime is never labeled evidence expiry.
- Status-summary export contains normalized claims, authorities, timestamps,
  measurements, and non-plaintext commitments using fixed vocabulary only.
  Free-form prose and identity metadata are omitted. It is unsigned and
  explicitly not an independently verifiable proof. Raw evidence requires a
  separate, explicit diagnostic or selective-disclosure action outside this UI.
- A downgrade, expired evidence, instance change, or policy change is announced
  before sending private content.
- Users can pin a policy (measurements, minimum TCB, GPU mode, model digest) and
  choose fail-closed behavior. Private mode defaults to fail closed.
- A future verification bundle—not the status-summary export—must include a
  signed canonical manifest, artifacts, policies, and standalone verifier
  recipes/versions so a third party is not forced to trust the Airship UI.

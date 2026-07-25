# Airship compute continuum

**Status:** normative design; browser placement, an isolated browser-job
transition skeleton, and structural remote-transcript validation implemented;
no executable remote placement or remote executor is shipped  
**Last reconciled:** 2026-07-23

## Decision

Airship will expose one stable execution contract across browser runtimes and
explicitly paired confidential executors. Placement is resolved **before a job
starts**. The browser remains the control authority regardless of where compute
runs.

This is transparent to the agent's tool contract, not transparent operating
system process migration. Airship does not claim that a running Worker,
Pyodide interpreter, WebContainer process, or WASI component can migrate into a
Linux VM. CRIU cannot restore those browser runtimes, and WASI does not supply
universal Linux/POSIX semantics.

The implemented foundation is
[`compute-continuum.ts`](../src/execution/compute-continuum.ts). It provides:

- deterministic pre-spawn placement with browser-first defaults;
- no fallback from an explicitly confidential request to a weaker local path;
- an explicit refusal to promote provider assertions, evidence-only results, or
  channel-only observations into executable remote authority;
- an isolated browser-job transition skeleton with strict record parsing,
  sticky cancellation, bounded reconciliation counters/deadline, unresolved
  `lost` state, and no output adoption before structural result verification;
- a target remote start record that is data only and cannot authorize spawn;
- binary-safe, ordered, bounded, exact-schema, digest-linked structural frame
  validation, including accepted plan/channel/snapshot and result commitments;
- permanent validator failure after missing acceptance, gaps, replay, mutation,
  over-budget output, duplicate/unauthorized deltas, or invalid terminal state.

It does **not** provide a Chutes remote execution endpoint, channel
cryptography, a remote Linux image, a signed terminal receipt, or remote
workspace adoption. It also does not yet mint an opaque, plan-bound remote
approval or a verifier-minted readiness capability. Remote placement therefore
always remains unavailable until a real private broker passes the gates in this
document. No fake adapter or TEE badge fills that gap.

## Invariants

1. The browser owns the agent loop, approval decision, job sequencing, context
   selection, active workspace head, journal, and final receipt verdict.
2. A remote executor receives one immutable, bounded, approved job. It cannot
   advance a journal, Workspace/Vault head, Git ref, memory/index generation,
   profile, or session manifest.
3. Placement is part of the prepared effect. Changing executor, evidence,
   runtime, artifact, mounts, egress, secrets, limits, or price invalidates the
   approval.
4. A job is never dispatched on provider metadata alone. Fresh evidence must
   bind the exact ephemeral channel key, measurement policy, and execution
   subject.
5. TLS is transport protection, not application E2EE or attestation. An
   attested application channel is a separate claim.
6. The remote never receives the workspace root key, a Google access token, an
   S3 credential, a Bitwarden machine token, or an unrestricted storage grant.
7. Remote output is quarantined until ordering, bounds, terminal disposition,
   receipt, and any workspace delta verify.
8. On a provider with proved conditional writes, the browser attempts at most
   one successful conditional workspace-head transition for a verified delta.
   An unknown response is reconciled; a conflict preserves the delta. Drive
   instead requires immutable successor/multi-head reconciliation until its
   conditional contract is proved.
9. Exactly-once arbitrary external effects are not promised. Airship targets an
   idempotent operation record, read-after-unknown reconciliation, and at most
   one acknowledged conditional head transition where the selected store has
   proved that contract.
10. Context and vector routing remain browser-owned. The executor receives only
    the selected files/blocks and context approved for that job.

## Authority and data flow

```text
model tool request
  -> browser canonicalizes arguments
  -> browser inspects live local and paired-executor capabilities
  -> browser prepares an immutable effect plan
  -> approval binds the plan digest
  -> browser captures a coherent workspace snapshot
  -> browser verifies evidence and establishes a key-bound channel
  -> one idempotent job is accepted locally or remotely
  -> bounded stdout/stderr/status/delta frames stream to the browser
  -> browser verifies terminal receipt and transcript
  -> browser adopts the delta or preserves a conflict
  -> browser appends canonical terminal events and receipt
```

The executor may run an ordinary Linux program without modifying that program
when its binary, libraries, files, environment, network policy, and resource
limits are present in the remote sandbox. This does not make the program's
live state portable to another runtime.

## Placement contract

Airship supports three placement policies:

| Policy | Meaning |
| --- | --- |
| `browser-only` | Run only on a compatible ready browser adapter. |
| `prefer-browser` | Use the browser when compatible; use a verified remote only when local is unavailable and this exact remote effect is already approved. |
| `remote-confidential` | Use the exact verified confidential executor or fail. Never downgrade to local or unattested remote execution. |

These are target policy semantics. Today the executable planner can select only
a caller-reported compatible browser runtime; the adapter must still prove
readiness when invoked. A `remote-confidential` request, an
evidence-verified observation, and even a structurally channel-bound observation
all return `remote-not-ready`; plain JavaScript records cannot mint authority.

The current planner evaluates local runtime compatibility, native-Linux/runtime
consistency, bounded requirements, and observed remote lifecycle state. The
future private broker must additionally evaluate:

- exact runtime identity;
- whether native Linux is required;
- local readiness rather than an install label;
- independent remote evidence state;
- evidence and approval validity windows;
- operation, scope, and executor identity;
- input, output, workspace-read, workspace-write, and wall-time budgets;
- requested workspace access versus the approved access class.

It does not perform speculative dispatch. Once any executor accepts a job,
automatic fallback is forbidden because execution may already have produced an
effect.

## Executor offer and trust ladder

A remote offer contains an exact endpoint origin, runtime set, transport,
resource ceilings, and a verified evidence lease. It is deliberately distinct
from the current browser-only `ExecutionAdapter` and from Chutes inference
attestation.

The lifecycle is:

```text
unavailable
  -> discovered
  -> provider-asserted
  -> evidence-verified
  -> endpoint-key-bound
  -> channel-confirmed
  -> live-probe-passed
  -> ready
  -> expired | revoked | degraded
```

Only `ready` is executable. Discovery, HTTPS, an enclave label, or a matching
public key alone never promotes the executor.

An execution quote must bind a domain-separated digest of at least:

```text
client challenge
client ephemeral public key
executor ephemeral public key
executor receipt-signing public key
executor descriptor digest
runtime/image measurement-policy digest
protocol and cipher-suite digest
```

The verifier must separately evaluate vendor collateral, TCB status, debug
state, freshness, expected measurements, report-data binding, and revocation.
A CPU-only executor may truthfully verify a CPU TEE while declaring no GPU; it
must not inherit the CPU/GPU subject semantics of an inference endpoint.

## Attested channel

The compatibility transport is WSS. WebTransport may be selected only after an
actual browser and endpoint probe. WebTransport provides streams over an HTTPS
endpoint; it is not a raw QUIC socket. WebRTC is not the default because it
introduces signaling and often STUN/TURN services.

Both transports require an application channel whose keys are derived only
after evidence verification. Browser JavaScript cannot programmatically install
a client certificate for WebSocket, `fetch`, or WebTransport, so the design
does not claim browser mTLS.

The first interoperable candidate is ephemeral P-256 ECDH,
HKDF-SHA-256, and AES-256-GCM through WebCrypto. Before promotion it requires a
cryptographic review and known-answer/interoperability tests. The channel must:

- bind its transcript to the verified endpoint key and executor descriptor;
- derive separate client-to-executor and executor-to-client keys;
- construct direction-separated nonces from a unique channel/rekey epoch and
  monotonically increasing sequence, with proof that reconnect/resume never
  reuses a nonce under the same key;
- authenticate channel, job, direction, frame type, and sequence as AAD;
- close on replay, gap, wrong channel/job, counter exhaustion, or invalid tag;
- rekey at bounded time and byte thresholds;
- implement bounded queues and backpressure;
- expose a terminal channel digest for the execution receipt.

Transport fallback requires a new prepared plan if its privacy or reliability
properties change.

## Process protocol

The target protocol supports pipes and, later, PTY mode:

- pipes retain separate stdout and stderr;
- a PTY exposes one combined terminal stream and never invents stderr;
- stdin offsets, output offsets, and frame sequence are monotonic;
- resize is valid only for a PTY;
- interrupt, terminate, and kill are capability-declared;
- cancellation is complete only after a terminal observation;
- reconnect may resume only with authenticated resume state, a matching
  acknowledged-prefix commitment, and fresh keys or safely retained counters;
- bounded heartbeats may report liveness but are never completion evidence.

The implemented v1 structural validator has no transport or stdin API. It
requires:

1. exactly one `accepted` frame first;
2. contiguous sequence numbers and a matching previous digest;
3. an exact versioned schema and canonical structural digest for every frame;
4. non-empty canonical base64url byte frames, preserving binary stdout/stderr,
   with 256 KiB per-frame and 8 MiB aggregate hard ceilings;
5. at most one encrypted workspace-delta manifest;
6. acceptance bound to exact executor, runtime, artifact, I/O mode, plan,
   approval, channel, and optional snapshot digests;
7. no output after the delta, no separate stderr for PTY mode, and a result
   commitment that binds the complete delta commitment rather than only its
   manifest digest;
8. terminal stdout/stderr and result commitments recomputed locally;
9. exactly one valid `exited` or `failed` terminal frame;
10. no frame after terminal state and permanent failure after any rejected frame
    or an attempted early `finish()`.

The unkeyed digest chain proves internal consistency only. A malicious peer can
recompute it. Authorship and tamper authentication require the future AEAD
channel and/or attestation-bound terminal signature.

The eventual signed terminal receipt must commit to the plan and approval
digests, executor/runtime/artifact, measurement policy, input snapshot,
stdout/stderr, disposition, delta, channel binding, start/finish counters, and
signing key. Resource telemetry and provider billing are separate claims.

## Job reliability state machine

```text
draft
  -> planned
  -> awaiting-approval
  -> denied | cancelled | failed-local | approved
  -> staging -> cancelled | failed-local | dispatching
  -> dispatch-unknown -> reconciling -> lost (unresolved)
  -> accepted
  -> running
  -> disconnected -> reconciling
  -> cancelling (sticky)
  -> draining
  -> result-received
  -> verifying-result
  -> quarantined | verified
  -> completed-without-writeback | awaiting-adoption
  -> adopting
  -> completed | conflicted
```

The implemented lifecycle module is an isolated, browser-placement-only
transition skeleton—not an authority boundary or a production reconciler. Its
records and requested phase edges are ordinary caller-constructible JavaScript;
future critical edges must consume broker/verifier/CAS-minted outcomes behind a
private effect broker. It is not yet routed into the active execution adapters.

Within that structural boundary it rejects unknown/malformed records, illegal
edges, timestamp regression, sequence exhaustion, direct retry from
`dispatch-unknown`, ordinary resume or writeback after cancellation, adoption
before result verification, and mutation of settled states. Reconciliation
attempts and time are bounded. `lost` remains unresolved and permits a late
terminal observation; it is not treated as permission to retry or clean up an
external effect.

Target recovery states are `dispatch-unknown`, `disconnected`, `reconciling`,
and `lost`. A dropped start response is not permission to dispatch again. The
future browser broker must query by operation/idempotency key and record the
matched response through durable expected-revision CAS. That query, provider
job identity, dispatch lease, durable uniqueness record, and CAS integration do
not exist yet; the current skeleton only prevents a direct syntactic redispatch
edge and bounds its local recovery counters.

## Workspace snapshot and overlay

The primary remote filesystem protocol is coarse immutable staging plus a
copy-on-write overlay—not syscall-by-syscall WAN forwarding.

The browser captures a coherent snapshot containing exact revisions, content
digests, opaque encrypted blob/block references, size limits, and allowed mount
roots. The executor receives a read-only base and writes to an overlay. It
returns a delta with create, replace, and delete operations fenced to the base
revision/digest.

Initial remote policy excludes:

- `.airship` control-plane state;
- credentials, key envelopes, and browser auth grants;
- `.git` and repository control-plane objects;
- context/index generations not explicitly selected;
- symlinks and paths outside `/workspace`.

Remote Git becomes a separate transactional capability only after worktree and
`.git` changes can be validated and adopted as one repository delta. Until
then, browser Git remains authoritative.

Airship's current encrypted workspace seals a whole text file and limits it to
16 MiB. The segmented-object layer supports authenticated range reads, but the
general workspace has not yet been migrated to a binary, extent-based snapshot
format. Therefore Airship does not yet claim arbitrary partial-file workspace
streaming.

The target workspace-pack layer is:

```text
logical files
  -> bounded binary extents
  -> optional deterministic compression policy
  -> independently authenticated encrypted blocks
  -> immutable segment objects
  -> encrypted manifest and generation head
```

Every requested byte range expands to complete authenticated encryption blocks.
The client verifies object identity, generation, provider version evidence, block
digest, nonce/AAD, decompression limit, and plaintext range before returning
bytes.

## Google Drive and S3 semantics

Google Drive is treated as an encrypted blob/object provider, not a POSIX
filesystem. Its documented APIs support HTTP range downloads of blob files and
resumable uploads. They do not document an atomic object-store-style
compare-and-swap contract for arbitrary concurrent writers.

Range download applies to Drive blob files, not exported Workspace documents.
Resumable upload is a whole-file upload session; non-final chunks follow
Google's 256 KiB multiple rule, and sessions expire. Consequently:

- Airship treats chunks as immutable by convention, but a holder of the Drive
  credential can still update/delete them and ambiguous creates can duplicate
  them;
- a Drive Vault must advertise single-browser sequencing or explicit
  conflict-detected multi-head behavior until a live atomic conditional-update
  contract is proved;
- the browser remains the sole active head writer during a paired job;
- the executor returns a delta rather than mutating Drive state;
- Drive access tokens remain in the browser and are never delegated;
- background sync is not promised after browser suspension or token expiry.

S3-compatible stores may provide conditional head updates, but each deployment
must pass the existing live conformance suite. A successful MinIO lab does not
prove every S3-compatible provider.

ZeroFS is valuable prior art for immutable segments, encryption, caching, and
9P exports, but it is a deployed server filesystem—not a browser/Google Drive
library. ZboxFS is archived. rclone crypt, gocryptfs, and Cryptomator are format
and conflict-handling references, not dependencies or acceptance evidence.

## Keys and remote data grants

The workspace seed is generated by the user-controlled client and imported as
a non-extractable WebCrypto key. Remote execution never receives that root.

After an exact job is approved and a channel is attestation-bound, the browser
creates a fresh job-data key. It encrypts only the selected snapshot blocks and
is wrapped to the verified ephemeral executor key. The grant commits to job,
operation, executor, snapshot, mount policy, limits, expiry, and evidence lease.
The grant expires and the browser drops its references when the job/channel
ends. Executor erasure is a required enclave policy and receipt claim, not a
guarantee of physical deletion that the browser can independently observe.
Future provider presigned reads may optimize transfer only if they are object-,
operation-, and expiry-scoped.

Ordinary passkeys are signing credentials; JavaScript cannot extract their
private keys. WebAuthn's optional PRF extension may derive wrapping material
after user verification when that exact credential reports support. It is an
optional unlock wrapper, not the only recovery path and not a universal
hardware-bound claim.

Bitwarden Secrets Manager machine tokens are bearer capabilities intended for
programmatic machines. The Hermes integration stores `BWS_ACCESS_TOKEN` in a
local `.env` and normally caches fetched secret values on that CLI host. That
trust model must not be copied into a public PWA.

Airship never accepts a shared Bitwarden token and never embeds or persists any
user-owned token in JavaScript, WASM, a service worker, a downloadable binary,
browser storage, Drive, logs, or receipts. A future optional integration may
accept a user-owned, expiring, read-only token in page memory, fetch exactly one
recovery wrapping key in an isolated Worker, then terminate and release it. A
native companion may retain a per-user token only in OS credential storage and
is the preferred unattended form. The Bitwarden browser SDK also requires
explicit license and live-delivery review before adoption.

[`KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md`](KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md)
is normative for the complete custody and Bitwarden boundary; this section only
states the remote-execution consequence.

## Performance strategy

The fast path minimizes round trips and authority crossings:

- choose placement once before spawn;
- stage immutable manifests and only selected blocks;
- batch small encrypted extents into segment objects;
- use bounded parallel range reads with cancellation;
- keep ciphertext-only OPFS/IndexedDB caches non-authoritative;
- use channel flow control rather than unbounded buffering;
- render streaming output as provisional while withholding it from the agent
  loop, tools, context, durable state, adoption, and proof until terminal
  verification;
- cache verified evidence only through its exact lease and endpoint-key scope;
- schedule and prefetch from the browser's active workspace/context experts;
- preserve one compact routing mirror rather than downloading a global vector
  database.

Performance claims require measured desktop, tablet, mobile, constrained-memory,
loss/reconnect, and large-workspace gates. A native project benchmark does not
prove browser performance.

## User experience and truth language

The UI separates:

```text
control authority: Browser
compute location: Browser | Paired executor
transport: Local | TLS | Application E2EE | Attestation-bound E2EE
runtime: exact engine and artifact
workspace: None | Snapshot read-only | Copy-on-write overlay
network: None | Brokered approved egress
result proof: Local observation | Channel-bound | Signed and attested
```

Ask First shows placement, evidence age, command/artifact, mounts, writeback,
egress origins, secret identifiers (never values), resource ceilings, and
estimated price. Auto Approve and Full Access may skip discretionary prompts
only inside a pre-granted policy. They cannot lower proof requirements, widen
data/egress, release a new secret, exceed a budget, or retry an unknown dispatch.

Use **paired remote job** and **Linux process in paired runtime**. Do not use
**transparent process migration**, **full Linux in the browser**, **mTLS**,
**zero metadata**, **ZeroFS on Drive**, or **TEE active** without evidence for
that exact claim.

## Delivery sequence

1. **Local continuum foundation — implemented in part.** Browser-only
   placement, an isolated transition skeleton, and structural transcript
   contracts are live. Existing browser adapters are not yet routed through the
   skeleton, which does not itself authenticate lifecycle events or perform
   reconciliation.
2. **Authority-bearing preparation.** Add private verifier-minted readiness and
   exact prepared-effect approval capabilities; bind placement, evidence,
   channel, mount, egress, secret, resource, and price digests into approval
   tickets and critical journal events. Plain records remain non-authorizing.
3. **Atomic workspace snapshots.** Add a separate snapshot/delta port and
   extent-based binary workspace pack.
4. **Untrusted protocol peer.** Exercise framing, replay, loss, resume, and
   reconciliation without any TEE claim.
5. **Chutes CPU pairing.** Verify a distinct execution subject and bind a live
   channel; still expose no execution claim until the probe succeeds.
6. **Read-only remote job.** No secrets, network, or writeback; require a signed
   terminal receipt.
7. **Transactional overlay adoption.** Validate and atomically adopt or preserve
   conflicts.
8. **Linux/PTY, brokered egress, and exact secret grants.** Add only after the
   corresponding approval, receipt, and recovery gates.
9. **Checkpoint/restart.** Exact runtime/image/ABI checkpoints only; never a
   generic browser-to-Linux migration claim.

## Promotion gates

Before the first remote job can be advertised, tests must reject stale/wrong
quotes, nonces, keys, measurements, subjects, policies, and signing keys; AEAD
replay/reordering/gaps and oversized frames; wrong jobs/channels; dropped start
acknowledgements; duplicated dispatch; invalid terminal signatures; approval
mutation; evidence expiry; workspace traversal/control-plane paths; stale base
revisions; and CAS conflicts. A live Chutes gate must exercise actual evidence,
forced channel loss, cancellation, rotation, resource exhaustion, and signed
completion.

## Primary references

- [Google Drive partial downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive file version metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [IETF Remote ATtestation procedureS architecture (RFC 9334)](https://www.rfc-editor.org/rfc/rfc9334)
- [AEAD requirements and nonce discipline (RFC 5116)](https://www.rfc-editor.org/rfc/rfc5116)
- [WebAuthn Level 3 PRF extension](https://www.w3.org/TR/webauthn-3/#sctn-prf-extension)
- [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [WebTransport specification](https://www.w3.org/TR/webtransport/)
- [WebSocket standard](https://websockets.spec.whatwg.org/)
- [WASI Preview 1](https://wasi.dev/releases/wasi-p1) and [Preview 2](https://wasi.dev/releases/wasi-p2)
- [Bitwarden machine accounts](https://bitwarden.com/help/machine-accounts/) and [access tokens](https://bitwarden.com/help/access-tokens/)
- [ZeroFS](https://github.com/Barre/zerofs), [rclone crypt](https://rclone.org/crypt/), and [Cryptomator architecture](https://docs.cryptomator.org/security/architecture/)

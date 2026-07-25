# Airship key custody and device enrollment

**Status:** normative target design; manual `airship-wrk-v1` recovery plus
same-browser non-extractable handle custody are implemented  
**Last reconciled:** 2026-07-24

## Decision

Storage authorization, workspace-key custody, and remote execution grants are
three different authorities:

```text
Google/S3 grant -> encrypted object access
key custodian   -> unwrap one workspace seed
job grant       -> disclose selected data to one verified executor
```

No single shared service token supplies all three. The random 256-bit workspace
seed remains the root of the existing `WorkspaceRootKey`; every convenience or
recovery method wraps that seed independently.

## Current implementation truth

Airship currently:

- generates/imports a 32-byte seed into a non-extractable HKDF WebCrypto key;
- prepares Local Device enrollment without writing anything, requires explicit
  acknowledgement that the one-time recovery value was saved, initializes the
  authenticated Vault identity, and only then persists a structured-cloned
  non-extractable key handle in IndexedDB;
- authenticates a recovery import against the existing Local Device identity
  before installing that handle; wrong or empty authorities never acquire it;
- keeps provider bearer credentials and the active key in page memory;
- exports/imports a manually handled `airship-wrk-v1` raw recovery value;
- uses imported recovery only to open an existing Google Drive hierarchy; a
  missing hierarchy/account/key fails closed and cannot create a blank
  replacement;
- asks the coordinator to reset and drops its active key/credential references
  on Vault disconnect; JavaScript GC and caller-held references prevent a
  guarantee of immediate physical erasure;
- stores client-encrypted workspace/session/index objects remotely in normal
  operation. Explicit provider-conformance probes may write bounded,
  non-sensitive recognizable markers and are never production state.

Airship does not yet implement passkey PRF unlock, portable device wrappers,
cross-device enrollment, wrapper rotation, device revocation, Bitwarden
recovery, or cross-device convergence. The interface must not imply otherwise.

The deterministic Google Drive browser gate does exercise a storage-empty
second browser context with the saved v1 value and an independent page-memory
Google grant. That proves the implemented manual recovery ceremony and exact
folder rediscovery at the substituted provider boundary; it is not physical
device, real-account, or multi-writer convergence certification.

## Target key graph

```text
random workspace seed (256 bit)
  -> non-extractable WorkspaceRootKey for object naming/encryption
  -> recovery-kit wrapper
  -> optional passkey-PRF wrapper
  -> one wrapper per enrolled device
  -> optional user-owned custodian wrapper
```

The remote keyset contains only authenticated wrapped-seed envelopes and public
recipient metadata. Removing a wrapper prevents a recipient that never obtained
the seed from unlocking through that path; it cannot claw back a seed,
plaintext, or ciphertext already copied by an authorized device/token. Effective
future-data revocation requires a new seed epoch and migration to the remaining
recipient set. Historical disclosure cannot be undone.

Every wrapper binds as authenticated data:

- protocol and suite version;
- workspace ID and key epoch;
- recipient kind and immutable recipient ID;
- keyset generation;
- wrapping public-key/credential revision;
- creation and optional expiry time;
- recovery policy digest.

Before the seed is unwrapped, provider version metadata and recipient
signatures are routing/authorization evidence only. Any root-derived
MAC/commitment can be checked only after unlock. A device needs a locally pinned
generation, an independent witness, or an explicit multi-head comparison to
detect keyset rollback; a fully isolated fresh device cannot prove it has the
globally newest keyset.

An unlock produces a page-memory `WorkspaceKeyLease`. It owns the active
non-extractable key, scope, epoch, provenance, and release signal. Disconnect,
account switch, logout, abort, route teardown where required, and worker crash
must release the lease: Airship drops reachable handles, aborts authorized
operations, and refuses further use. WebCrypto/JavaScript do not guarantee
physical zeroization. No API serializes the lease.

## Bootstrap envelope store

Existing encrypted object names depend on the workspace root key. Cross-device
unlock therefore needs a small root-key-independent `KeyEnvelopeStore` before
the encrypted object store can open.

The store contains no workspace plaintext or raw key. It exposes:

- load an exact workspace keyset generation;
- create a first keyset only if absent;
- advance a generation through a provider-proved conditional operation or
  append a conflict head;
- list bounded recovery heads for explicit reconciliation;
- preserve revoked-recipient tombstones;
- return provider version evidence with every read.

Google Drive must use single-writer or explicit multi-head reconciliation until
an atomic conditional update passes a real provider gate. An in-memory/mock
`If-Match` response is not sufficient evidence.

## Recovery methods

### Recovery kit v2

The ordinary recovery path is a high-entropy recovery key-encryption key that
wraps the workspace seed. It no longer exposes the raw seed as `airship-wrk-v1`
does. The kit includes a human-verifiable workspace identifier, version,
checksum, and recovery policy. Import is explicit and never sent to inference,
storage, telemetry, logs, or the clipboard without a user action.

The recovery KEK is full decryption authority and must be protected as
carefully as the raw seed. Its checksum catches transcription mistakes; it is
not authentication against an attacker who can replace the whole kit.

The existing v1 value remains a migration input: open the current workspace,
create v2 wrappers, verify a round trip, then mark the migration complete. It
cannot be silently reinterpreted as v2.

### Passkey PRF

Ordinary WebAuthn credentials sign assertions; JavaScript cannot extract their
private keys. Airship may use the optional WebAuthn PRF extension to derive a
wrapping key only when the exact credential reports valid PRF output after user
verification.

Every PRF ceremony sets WebAuthn `userVerification: "required"`, verifies the UV
flag, returned credential ID, registration `prf.enabled`, and authentication
`prf.results.first`, and treats the result as local unlock material—not
server-verified identity or an attestation receipt.

PRF unlock must fail closed for absent support, ignored extensions,
cancellation, the wrong credential/RP ID, an origin outside the explicit
accepted-origin policy, the wrong salt, or invalid output length. WebAuthn is
scoped primarily by RP ID rather than exactly one origin; localhost credentials
do not transfer to a production RP. It is a convenience wrapper, not the only
recovery route and not automatically hardware-bound or cross-device.

### Existing-device enrollment

A new device creates an agreement/signing identity and publishes a short-lived
request. An already unlocked device:

1. verifies the workspace and request structure;
2. uses a QR code or short authentication string to authenticate the request
   transcript, recipient public key, and proof of possession—not a person's
   real-world identity;
3. checks request expiry and replay state;
4. wraps the seed to the new recipient;
5. signs and appends an immutable grant/head; providers with proved conditional
   writes may fence the head, while Drive preserves/reconciles divergent heads;
6. leaves an auditable enrollment event without key material.

Stale generations, substituted public keys, reused requests, revoked issuers,
and authentication-string mismatch stop enrollment. An independent recovery
custodian is still required for loss of all devices; the recovery kit is the
default.

The current active `WorkspaceRootKey` is non-extractable and cannot recover or
wrap its original seed. Enrollment must freshly unwrap seed bytes from an
existing recovery/device envelope (or use a separately reviewed
enrollment-capable hierarchy), create the new wrapper, import the runtime key,
then release transient buffers best-effort. An active key lease alone cannot
enroll another device. The final protocol also requires defined SAS entropy and
retry limits, confirmation on both devices, transcript binding, separate
signing/agreement keys, and immutable replay records; custom ECDH is not
accepted without review.

### Same-browser convenience

Where structured cloning a non-extractable `CryptoKey` into IndexedDB actually
passes, Airship persists the Local Device workspace handle after the recovery
save ceremony and authenticated identity initialization. The UI
must call this **browser-profile unlock**, not hardware-backed storage. Browser
data clearing, profile loss, private browsing, quota eviction, and platform
migration may destroy it. Non-extractable prevents key export through WebCrypto;
malicious same-origin code can still invoke the key while it is available.

### Optional Bitwarden recovery

Bitwarden Secrets Manager machine-account access tokens are powerful bearer
credentials. Hermes stores such a token in `~/.hermes/.env`, invokes the native
`bws` process, and normally caches fetched secret values in a mode-0600 file for
five minutes. That is a conventional user-controlled CLI trust model, not a
static-PWA pattern.

Airship must not:

- embed a shared machine token in JavaScript, WASM, a service worker, or a
  downloadable binary;
- persist a user token in local/session storage, IndexedDB, OPFS, Cache Storage,
  Drive, logs, journals, history, or receipts;
- put the workspace root key itself in Bitwarden;
- derive an encryption key from the bearer token;
- bulk-list a project or inject secrets into global environment variables;
- give a remote executor or inference endpoint the Bitwarden token;
- describe compilation or obfuscation as non-reversible secret storage.

A future advanced adapter may accept a user-owned, expiring, read-only token in
page memory only when the machine-account authorization graph exposes exactly
the designated secret, fetch that one recovery KEK by immutable secret ID in an
isolated Worker, unwrap locally, release references best-effort, and terminate
the Worker. Worker isolation is lifetime/compartment hygiene, not a security
boundary against compromised same-origin code or extensions; JavaScript strings
cannot be reliably zeroized. The token is never a shared Airship credential. A
native companion backed by the OS keychain is preferred if unattended retention
is desired.

Airship has not established that Bitwarden offers a supported production browser
SDK/CORS contract. The public SDK repository includes a WASM-capable Rust core,
but its bundle/runtime behavior and restrictive SDK license require explicit
technical, legal, provenance, and live-provider gates before any distribution.

## Remote executor grants

Remote execution uses a fresh per-job data key, not a key-custody wrapper. Only
after approval and attestation-bound channel verification does Airship wrap
that key to the executor's verified ephemeral key. The grant is bound to:

- operation and prepared-plan digest;
- executor, endpoint key, and evidence lease;
- workspace snapshot and allowed mounts;
- input/output byte and time ceilings;
- exact egress and secret capability identifiers;
- expiry and channel identity.

The executor cannot use that grant to discover or unwrap any other workspace
object. See [`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md).

## Secret capabilities for tools

Agent/API secrets are separate from workspace recovery. A
`SecretCapabilityProvider` returns a bounded page-memory lease directly to one
authorized tool adapter and exact destination request. A lease identifies
purpose, recipient, expiry, and permitted operations. The value is disclosed
only to that operation/destination and never enters a prompt, generic result,
persistent file/state, terminal-wide environment, unrelated adapter, receipt,
or journal.

## Required gates

- Wrapper round trip and rejection of wrong workspace, epoch, recipient,
  generation, AAD, nonce, and ciphertext.
- v1-to-v2 recovery migration without losing existing ciphertext access.
- Outside an explicit user-initiated recovery/token ceremony, no token/key value
  is serialized into Airship durable JSON/state, snapshots, errors, DOM, logs,
  receipts, journal, clipboard-facing UI, history, IndexedDB, OPFS, Cache
  Storage, or service-worker messages. Provider responses may be JSON only
  inside the authorized memory boundary. During a ceremony the minimum
  input/export view is allowed transiently, then must be cleared and proved
  absent from every persistence surface.
- Release on disconnect, logout, account switch, abort, teardown, and crash.
- PRF absent/ignored/cancelled/wrong-credential/wrong-salt failures.
- Enrollment replay, expiry, substitution, stale CAS, revocation, and concurrent
  grant failures.
- Fresh-browser recovery, same-browser unlock, two-device enrollment, device
  revocation, and total-device-loss exercises.
- Release-gate rejection of realistic Bitwarden token shapes and build-time
  token variables.
- Optional Bitwarden pack proves exact-secret fetch only, no persistence, a
  machine-account authorization graph containing only that secret and no
  project-wide/write permission, sanitized errors, Worker termination, origin
  allowlisting, and no service-worker caching.
- Any live Bitwarden test uses a disposable, expiring, single-secret read-only
  token, never prints or records it, revokes it during cleanup, and proves
  post-revocation access fails where provider automation permits.

## Primary references

- [WebAuthn Level 3 PRF extension](https://www.w3.org/TR/webauthn-3/#sctn-prf-extension)
- [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [Bitwarden machine accounts](https://bitwarden.com/help/machine-accounts/)
- [Bitwarden access tokens](https://bitwarden.com/help/access-tokens/)
- [Bitwarden Secrets Manager SDK](https://bitwarden.com/help/secrets-manager-sdk/)

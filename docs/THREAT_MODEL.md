# Airship threat model

Status: design baseline; review before every protocol or trust-boundary change.

## Protected assets

- prompts, model output, memories, workspace contents, filenames, and metadata;
- provider credentials, workspace master keys, device keys, recovery material;
- tool approvals and high-integrity tool results;
- session ordering, authorship, model/tool provenance, and deletion state;
- availability of current local work and recoverability of synced work.

## Trust boundaries

Trusted for plaintext in the web tier:

- the user's device OS, browser engine, active Airship origin, and current
  Airship JavaScript/WASM bundle;
- explicitly approved tools while they execute;
- a remote enclave only after its ephemeral key, measurement, model digest,
  freshness challenge, and policy are verified by the client.

Not trusted with plaintext:

- CDN, service control planes, object store, ledger, relay,
  telemetry system, and normal inference control plane;
- other devices until enrolled into the workspace key graph.

Outside the browser threat model:

- a compromised OS/browser, malicious extension with page access, DevTools,
  screen capture, hardware keylogger, or malicious same-origin release can read
  plaintext. WASM is not a TEE or obfuscation boundary.

## Security posture vocabulary

| Posture | Meaning |
| --- | --- |
| `local` | No inference payload left the device |
| `plaintext-remote` | TLS only; provider terminates plaintext normally |
| `encrypted-unattested` | Payload encrypted to a discovered key, but client did not prove an approved enclave owns it |
| `encrypted-attested` | Client verified fresh evidence binding the key, code measurement, model digest, and policy |

The current Chutes v1 prototype is `encrypted-unattested` because discovery
returns an ML-KEM key without client-verified evidence. The `-TEE` model suffix
is metadata, not proof.

## Principal threats and controls

| Threat | Required controls | Residual risk |
| --- | --- | --- |
| Malicious storage reads objects | client envelope encryption, opaque HMAC object IDs, key separation | sizes, timing, account and access patterns leak |
| Storage rollback/fork | signed/hashed manifest heads, monotonic device counters, fork visibility | fully isolated device may not see a global rollback immediately |
| Inference key substitution | fresh nonce challenge, signed attestation chain, measurement/model policy, key binding | attestation ecosystem/root compromise |
| Replay/routing confusion | request ID and routing fields in AEAD AAD, nonce uniqueness, expiry, idempotency ledger | provider may compute then lose final response |
| Stream truncation/reorder | authenticated sequence, request ID, transcript hash, terminal record | availability attacks remain possible |
| XSS/supply-chain theft | no inline/eval, strict CSP/Trusted Types, pinned lockfile, minimal dependencies, signed release/SRI strategy | trusted same-origin code still sees plaintext |
| API key persistence/leak | memory-only input, no logs/URLs/storage, scoped low-quota tokens, explicit zeroization where possible | JS GC and compromised runtime limit erasure guarantees |
| Tool prompt injection | capability policy outside model, typed schemas, origin labels, approvals, output taint, least privilege | user may approve a deceptive action |
| Duplicate side effects after crash | operation IDs, persist-before-execute, idempotent tool adapters/result journal | external tools without idempotency require confirmation/reconciliation |
| Cross-device concurrent turn | expiring writer lease, fencing token, fork on conflict | offline devices can intentionally create branches |
| Device loss | wrapped workspace keys, recovery kit, revocation, key rotation | a copied unlocked device key can read historical ciphertext |
| Remote executor substitution | separate execution subject, fresh quote, exact ephemeral channel/receipt-key and runtime-policy binding, live probe | verifier/vendor root compromise |
| Remote replay or duplicated dispatch | plan-bound approval, idempotency key, ordered AEAD records, digest-linked frames, reconciliation before retry | arbitrary external effects may not be exactly-once |
| Remote workspace overwrite | immutable browser-captured base, copy-on-write delta, revision/digest validation, one browser-owned head adoption | valid execution can still conflict with a newer head |
| Overbroad remote data access | selected snapshot only, per-job data key, exact mounts/bytes/expiry, no storage/root credentials | approved plaintext is visible inside the verified executor |
| Embedded secret custodian token | no shared browser/binary token; user-owned memory lease or native keychain; static release scans | compromised active page can read a user-supplied live token |
| Denial/quota exhaustion | bounds, backpressure, timeouts over body lifetime, budgets, circuit breakers | network/provider outage cannot be hidden |

## Key hierarchy

1. Generate a random 256-bit workspace root secret on a trusted client.
2. Derive independent keys for object encryption, object-name HMAC, manifest
   authentication, export, and search/index data using a versioned KDF context.
3. Give every enrolled device its own signing/agreement identity.
4. Wrap the workspace secret separately to each device and optional offline
   recovery key. The server never receives an unwrapped workspace secret.
5. Rotation creates a new epoch. New writes use the new epoch; background
   re-encryption is optional and revocation cannot erase ciphertext already
   copied by an authorized former device.

Browser key persistence must feature-detect structured-clone support for
non-extractable `CryptoKey`. Cross-device enrollment and recovery require a
separate reviewed protocol; localStorage is never an acceptable fallback.

Ordinary WebAuthn private keys are not volume keys. Only the optional PRF
extension may derive a wrapping key after an exact credential reports support.
A recovery kit remains mandatory until device enrollment and loss recovery pass
their real multi-device gates.

Bitwarden machine-account access tokens are bearer capabilities. Hermes'
plaintext local `.env` and short-lived disk-cache pattern belongs to a
user-controlled CLI host and is not copied into Airship. A token is never
embedded or persisted in the PWA/binary and never delegated to inference,
storage, or a remote executor. See
[`KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md`](KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md).

## Remote execution boundary

Inference attestation does not attest a CPU execution sandbox. Remote execution
uses a separate evidence subject, measurement policy, endpoint/channel key, and
terminal receipt key. TLS, provider metadata, or an endpoint-key match alone is
insufficient.

Placement is chosen before spawn. The browser remains approval, journal,
workspace-head, context, and receipt-verdict authority. A paired executor may
run one job against a read-only snapshot and return a bounded copy-on-write
delta. It never receives the workspace root, Google/S3/Bitwarden credentials,
or permission to update an authoritative head.

The primary data path stages authenticated immutable blocks. WAN syscall, file
descriptor, `mmap`, or live CRIU migration is not a baseline promise. Invalid
frames or receipts quarantine outputs and forbid delta adoption; lost dispatch
acknowledgements reconcile by operation ID before any retry. See
[`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md).

## Chutes E2EE v1 compatibility risks

The existing prototype uses ML-KEM-768, HKDF-SHA256, ChaCha20-Poly1305, and
gzip. Compatibility mode preserves that wire format, including empty AAD, so it
cannot authenticate routing headers or claim attestation. Airship v1 must:

- label the posture `encrypted-unattested`;
- keep response secrets behind opaque WASM handles rather than copying them to
  JavaScript arrays;
- bound compressed/decompressed messages and SSE buffers;
- time out the response body, not only the initial fetch;
- reject duplicate stream nonces locally;
- avoid compression for future payloads mixing secrets with attacker-controlled
  reflected content where the server protocol permits it.

An attested v2 protocol must bind version, suite, chute, instance, model digest,
path, stream flag, discovery nonce, request ID, and evidence digest into AAD.

## Receipt limitation

A valid TDX quote binding a fresh nonce to an instance E2EE key proves the
identity of the encryption endpoint under the accepted Intel/measurement
policy. It does not, by itself, prove to a third party that particular plaintext
prompt and response bytes were processed by a particular model. Absolute
transcript verification additionally requires an enclave signing key bound into
the attestation and a signed result covering request digest, response digest,
model/artifact digest, runtime policy, and completion state. Airship displays
endpoint and transcript claims separately until Chutes exposes that receipt.

## Compliance caveat

Do not use the words "compliant", "zero knowledge", "full TEE", or "end to end"
as a blanket product claim. Tie every claim to a defined data flow, posture,
control owner, test, and independently reviewable evidence.

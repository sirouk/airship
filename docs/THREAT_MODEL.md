# Airship threat model

Status: current baseline for the simplified browser runtime.

## Protected assets

- prompts, model output, workspace content, and derived context;
- the files inside a folder the user attached from this device;
- provider credentials and storage capabilities;
- workspace keys and recovery material;
- session order, provenance, and approval history;
- availability and recoverability of user-owned encrypted state.

## Trusted for plaintext

- the current device OS and browser;
- the active Airship origin and loaded bundle;
- explicitly approved tools while they run;
- the provider the user chose for a remote turn;
- anyone who holds a readable work bundle the user exported.

A remote provider necessarily receives turn plaintext for `provider-tls` turns.
That is the same trust reality as any direct API client.

## Plaintext leaves the browser on exactly three paths

1. a remote turn, to the provider the user connected (`provider-tls`);
2. a folder the user opened on this device, written in place through the
   Chromium File System Access API, with no copy and no undo;
3. a **readable** work bundle, which is ordinary JSON holding every message it
   carries. A **sealed** bundle instead uses the active Vault's AES-256-GCM
   envelope and can only be reopened by Airship against that same Vault.

Everything else Airship makes durable is client-encrypted first.

## Not trusted for plaintext

- static hosts and CDNs serving the bundle;
- object stores and vault providers;
- relays and companion transport helpers;
- non-enrolled devices.

These services may observe ciphertext sizes, timing, and account metadata, but
not plaintext session or workspace content through Airship's storage protocol.

## Inference posture vocabulary

| Label | Meaning |
| --- | --- |
| `loopback-local` | The turn stayed on the current machine via a loopback provider |
| `provider-tls` | The turn crossed TLS to a remote provider that processed plaintext |

These are the only inference postures Airship currently claims.

## Main threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Provider reads prompts | explicit provider choice; local providers for sensitive work | a connected remote provider sees plaintext |
| Storage reads durable state | client encryption, opaque object IDs, key separation | sizes and timing still leak |
| Storage rollback or fork | authenticated heads, immutable objects, conflict visibility | heads are authenticated, not fresh: a hostile store can serve an older authentic head or omit objects, and an isolated device may not notice |
| Credential leakage | page-memory custody, no URL/storage/log persistence | a compromised runtime can still read live secrets |
| Tool prompt injection | typed tools, approval policy, origin labeling, least privilege | a user can still approve a bad action |
| Tool writes to a real folder on the device | any non-read effect naming the mounted folder is reviewed in every approval mode, Auto Approve and Full Access included; the Terminal refuses the mount entirely; the attachment is keyed to one profile | an approved write lands on the user's own disk and cannot be undone |
| An imported file claims authority | a bundle may not carry `approvalModeOverride`, `modelOverride`, `contextPolicyOverride`, `headIncarnation` or `importedAt`; a replayed history grants no pin; a manifest whose system prompt does not hash to its own digest is refused; an imported conversation is read-only and continues by fork | a digest chain still proves only that events were not edited after they were written, never who wrote them |
| Model-written JavaScript escapes its kernel | dedicated worker-only eval CSP, private controller closure, per-generation capability, ambient-channel scrubbing, strict host frame/state/budget checks | CPU and memory denial remain bounded mainly by worker termination; approved tool effects still have their declared authority |
| Duplicate side effects after crash | operation IDs and journal-first execution discipline | external systems may still need reconciliation |
| XSS or malicious same-origin code | strict static-host security boundary and minimized dependencies | trusted same-origin code still sees plaintext |
| Device compromise | key wrapping, recovery, rotation, revocation flows | a compromised active device can read its plaintext |

## What the digest chain is not

Session journals, work bundles and receipts are unsigned local metadata. The
chain is self-certifying: any file can mint a chain that recomputes, so a chain
that verifies shows internal consistency and nothing about origin. Airship signs
no artifact, issues no attestation, and the release manifest states that it is
unsigned. `assessSessionHistory` reports `authenticity: not-proven` on purpose.

## Claim discipline

Do not claim "private inference", "zero knowledge", or remote confidential
execution for ordinary cloud API turns. Tie every trust claim to a specific data
flow and a control the client can actually observe.

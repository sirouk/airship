# Airship threat model

Status: current baseline for the simplified browser runtime.

## Protected assets

- prompts, model output, workspace content, and derived context;
- provider credentials and storage capabilities;
- workspace keys and recovery material;
- session order, provenance, and approval history;
- availability and recoverability of user-owned encrypted state.

## Trusted for plaintext

- the current device OS and browser;
- the active Airship origin and loaded bundle;
- explicitly approved tools while they run;
- the provider the user chose for a remote turn.

A remote provider necessarily receives turn plaintext for `provider-tls` turns.
That is the same trust reality as any direct API client.

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
| Model-written JavaScript escapes its kernel | dedicated worker-only eval CSP, private controller closure, per-generation capability, ambient-channel scrubbing, strict host frame/state/budget checks | CPU and memory denial remain bounded mainly by worker termination; approved tool effects still have their declared authority |
| Duplicate side effects after crash | operation IDs and journal-first execution discipline | external systems may still need reconciliation |
| XSS or malicious same-origin code | strict static-host security boundary and minimized dependencies | trusted same-origin code still sees plaintext |
| Device compromise | key wrapping, recovery, rotation, revocation flows | a compromised active device can read its plaintext |

## Claim discipline

Do not claim "private inference", "zero knowledge", or remote confidential
execution for ordinary cloud API turns. Tie every trust claim to a specific data
flow and a control the client can actually observe.

# Pass 3 — Security, Resilience, Adversarial Load

**Status: complete (two rounds, all gates green).**
**Conducted:** 2026-07-30, against `main` at `0b00eb9` (pass 2) plus the
brand/vault/mobile pack at `43ac110`.
**Verifier:** single reviewer with direct line-read authority, vitest and the
browser acceptance suites. Scout agents were unavailable in-session; the sweep
was therefore performed with surgical greps over chokepoints, full reads of
each found surface, and executable batteries wherever the house lacked one.

The headline: earlier passes had already absorbed most of pass 3's territory.
Every surface that could carry hostile or damaged input had some guard, and
nearly all had executable regression coverage. Pass 3's real yield is two
defects genuinely open at pass-2 HEAD, both now fixed and pinned.

---

## Findings remediated

### 1. Profile catalog revival blessed poison keys silently — HIGH, fixed

A hostile Vault seed (any earlier evil write into this origin's ciphertext) can
plant `__proto__`, `constructor`, and `prototype` as **own enumerable keys** —
this is exactly what `JSON.parse` does with a `"__proto__"` property (the
naive assignment used by most prototype-pollution probes only touches a
prototype and hides the hole). The rebuild in `validateProfileCatalog` dropped
unknown fields, so the poisoned record was *blessed silently* at every nest
level: top, theme, theme colors, skill, profile. The digests then proved only
the shape the seed chose to be.

Fix: `rejectPoisonKeys` (depth-bounded, own-key check, same fail-closed
posture as the billing payload walk) runs before any rebuild or digest work in
`src/profiles/persistence.ts`. Locked by
`src/profiles/catalog-adversarial.test.ts` — 5 tests, poison at 5 nests × 3
keys, oversized populations rejected at the bound rather than after digest
work, forged/fetch-beacon colors rejected on both directions of the wire.

### 2. `javascript:alert(1)` parsed as a bare OAuth authorization code — LOW, fixed

`readBareCode` in `src/ui/connect/authorization-code-paste.ts` accepted any
printable-ASCII bare string. A `scheme:`-prefixed value — including live script
sinks — became an accepted code and flowed to the vendor token exchange, where
only the vendor's own refusal stood between it and the wire. It could never be
a provider's code, and the one legitimate colon-carrying candidate (`sk-…` API
keys) is named separately. The parser now refuses all scheme-shaped values;
conformance with the exchange authority (`parsePastedAuthorizationCode`) holds
and is pinned by the shared tests. Locked by
`src/ui/connect/authorization-code-paste-adversarial.test.ts`.

---

## Axes swept, and how they were verified

**Injection sinks.** Zero `innerHTML`, `eval`, `Function`, or
`dangerouslySetInnerHTML` in the shipped graph. Extension and Worker message
channels carry their own strict protocols.

**Credential hygiene.** No account key, OAuth token, vault key, or recovery
material is logged, echoed in errors, or carried in a URL (grep over all
`console.*` outside tests found only sandbox-shim definitions and doc strings);
transports build credentials per request behind a redaction class
(`ApiKeyRedaction`).

**CSP ↔ transport agreement.** The HTML and `_headers` connect-src allowlists
are checked against the exact enumerated `DEFAULT_LOCAL_MODEL_ORIGINS` in the
release gate; `style-src 'unsafe-inline'` is the deliberate, documented
trade for runtime theme tokens, and nothing else.

**Crypto boundary.** Local-device OPFS failures classify into named errors by
exception kind (`unavailableOpfs`); quota is a named Vault error, not a wedge.
Theme manifests are hex-only and digest-verified before any application — a
forged `url()` in a manifest is a dead seed on both the wire and at
`createThemeManifest`.

**Origin allowlists.** Local endpoints are exactly the twelve enumerated
loopbacks; LAN, IPC and unicode slips fail closed. The page-side bridge
destination allowlist re-checks canonicalized URLs using the same rules the
extension applies, so an OAuth credential can never creep into another
provider's host.

**Workspace traversal.** `normalizeWorkspacePath` is the only chokepoint
(twenty-six call sites); the new `path-adversarial.test.ts` locks 14 traversal
spellings, control characters/NUL, sibling-prefix behavior, and documents why
percent escapes can never leave `/workspace` (nothing in the pipeline URL-decodes).

**Extension bridge.** Direction markers, strict per-field parses, base64/seq
validation, body-before-head and out-of-order refusals, per-chunk and
cumulative byte ceilings, concurrency caps, cancel propagation, listener
release, memoized-presence re-probing — all verified as executable tests in
`src/inference/bridge/protocol.test.ts` and `client.test.ts` (60+ cases).

**Provider catalogs (hostile shapes).** New
`providers-adversarial.test.ts`: each broker enumerates at most its own bound
(128 LM Studio / 256 Ollama), junk rows filter (nulls, non-records, empty/numeric
ids), `__proto__`-planted rows never splash, hostile-typed detail fields (NaN
sizes, numeric timestamps, poisoned family records) never surface, and
non-JSON bodies / non-array payloads keep their named diagnostics
(`invalid-json`, `invalid-payload`).

**Attestation evidence.** Queue and both persistence stores: dedup fences,
terminal-state machine, name redaction, CAS merge, bounded pruning, revival
with malformed/cross-profile/credential-shaped payloads rejected — covered
edge-to-edge by the existing suite.

**Resilience (revive, retries, cross-tab).** Profile catalog commits are
`readCommitLoop` CAS with generation fences and stale-writer refusal; local
device restore recovery paths exist and are asserted in
`local-device-restore-resilience.test.ts`; vault auto-adoption/ejection is
e2e-covered (`vault-auto-adoption.spec.ts`), including rename durability
across a reload; `evidence-acquisition-notice` drives recovery off the fault
channel, never the record tick, which is exactly the channel the queue's
`wake()` publishes.

---

## Deliberately left outside the sweep

- Live provider transports (Chutes, OpenAI, Anthropic, xAI) hostile response
  shapes — requires accredited credentials and a recording harness; the
  non-live halves (billing telemetry limits, catalog max-models bounds,
  browser's own CSP refusal) are what was verified here.
- Mid-write crash forensics for browser storage (kill-the-tab-during-write) —
  browsers do not offer a deterministic interruption mechanism in this
  harness; the envelope writes use put-if-absent/CAS and ordered commit points
  derived from the earlier passes, which is the best the platform affords.
- The two were-stale bundle partitions the dev report once forecast (sessions
  route, deferred capabilities) — inventory is the release gate's job and it
  is green.

---

## Regression batteries added this pass

| Battery | File | Locks |
|---|---|---|
| Catalog revival | `src/profiles/catalog-adversarial.test.ts` | poison keys everywhere, oversize at bound, hex-only colors, forged identifiers |
| Workspace traversal | `src/workspace/path-adversarial.test.ts` | 14 traversal spellings, controls/NUL, sibling prefixes, encoding traps |
| OAuth paste | `src/ui/connect/authorization-code-paste-adversarial.test.ts` | scheme rejection, overbound length, invisible characters, exchange-agreement |
| Provider catalogs | `src/inference/local/providers-adversarial.test.ts` | flood caps, record hygiene, proto splash, NaN details, bad payload diagnostics |

**Gates:** `tsc` clean; 3,076 unit tests green; static security aligned;
release gate green with all ceilings holding (132 artifacts recorded).

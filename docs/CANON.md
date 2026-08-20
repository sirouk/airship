# Airship canon

**Status:** current product definition for the provider-neutral browser runtime
**Last revised:** 2026-08-20 (`simplify/edge-runtime`)

Airship is a local-first, browser-native agent runtime distributed as a static
PWA. There is no Airship application backend. The browser owns the agent loop,
plaintext assembly, approvals, context selection, workspace state, and client
encryption. External services are direct adapters for inference, storage,
identity, or optional execution.

## Product thesis

Airship should feel like a strong local agent workbench without pretending the
browser is a privileged daemon. The app combines:

- persistent conversations with append-only journals;
- direct provider connections and per-turn provenance;
- a real virtual workspace with editor, terminal, and Git surfaces;
- client-side encrypted durability you can place on infrastructure you control;
- recursive PRIME agents and capability-gated tools;
- static hosting on ordinary web infrastructure.

## Non-negotiable rules

1. **No hidden Airship backend.** The shipped app is static HTML, CSS,
   JavaScript, WASM, and versioned assets.
2. **The device owns the turn loop.** Providers return inference. They do not
   become the Airship runtime.
3. **Cloud state is ciphertext.** Durable journal, workspace, and derived index
   data are encrypted before leaving the browser.
4. **History is append-only.** Airship records immutable conversation events and
   exact per-turn provenance.
5. **No provider is privileged.** Chutes is one ordinary OpenAI-compatible
   provider entry, not a special transport or trust tier.
6. **Concurrency is per session.** One running conversation does not globally
   freeze navigation, composition, or other sessions.
7. **Claims stay honest.** Airship labels remote inference `provider-tls` and
   local loopback inference `loopback-local`. It makes no stronger remote claim
   without independently verifiable evidence.

## Implemented product shape

### Providers

Airship supports direct browser connections for OpenAI, Anthropic, xAI,
Chutes, custom OpenAI-compatible endpoints, and loopback local providers such
as Ollama and LM Studio. Credentials stay in page memory. Model lists come from
each provider's own directory.

### Sessions

Sessions are append-only journals. A conversation records which provider,
connection generation, model, and transport boundary produced each turn.
Changing a session's model is a journaled in-place override that applies on the
next turn. It is not a hidden fork.

### Storage

Airship starts in ephemeral page memory. The stock selector can adopt Local
Device storage or Google Drive in a configured build. Durable state is
client-encrypted before upload. S3-compatible storage remains a host-composed
adapter (plus the loopback lab), and Walrus remains an optional immutable blob
transport rather than a selectable Vault.

### Workspace and execution

The app includes a virtual workspace, editor, terminal, browser Git, approvals,
execution packs, and optional local semantic indexing. PRIME is the default
agent engine.

### Distribution

The primary product is a static installable web app. An optional companion
extension may help with fixed-host relays or acceleration, but it is not an
Airship backend and does not change the trust meaning of provider traffic.

## Honest limits

Airship does **not** claim:

- arbitrary host shell or filesystem access from the plain browser tier;
- reliable background execution after the OS suspends the tab;
- secrecy from the current OS, browser, extensions, or DevTools; or
- provider-side isolation, attestation, or confidential computing for ordinary
  remote API calls.

## Authority order

When documents disagree:

1. this canon defines the product boundary and claim language;
2. executable code and tests define actual machine behavior;
3. focused living docs such as `ARCHITECTURE.md`, `PROTOCOLS.md`, and
   `THREAT_MODEL.md` define subsystem detail;
4. `docs/archive/` is historical only.

## Living document map

- [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) — user jobs and required behavior
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime layering and data flow
- [`THREAT_MODEL.md`](THREAT_MODEL.md) — assets, boundaries, and claim rules
- [`INFERENCE_PROVIDER_REGISTRY.md`](INFERENCE_PROVIDER_REGISTRY.md) — provider
  contract
- [`PROTOCOLS.md`](PROTOCOLS.md) — journal, inference, and storage shapes
- [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) — release gates and launch work
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — static hosting guidance
- [`SIMPLIFICATION.md`](SIMPLIFICATION.md) — migration summary

# Inference providers: connection, model, and session contract

Status: implemented core and browser transport adapters  
Evidence review: 2026-07-24

Airship may hold several inference connections at once. A running session does
not follow a mutable "current model" preference: it pins one provider revision,
one connection generation, and one immutable model snapshot. Selecting another
provider or model creates a new session or an explicit fork.

## Official capability matrix

This table distinguishes a provider's first-party product login from an OAuth
contract that a third-party browser application can actually register and use.
OAuth is not inferred from a branded "Sign in" screen.

| Provider | Third-party inference OAuth available to Airship | API authentication | Browser reality encoded by Airship | Implemented wire adapter |
| --- | --- | --- | --- | --- |
| Chutes | Yes only when the deployment supplies a reviewed Browser/native registration with Authorization Code, S256 PKCE, and token endpoint authentication `none`. The existing development confidential bridge remains a separate local-companion path. | Chutes API key or the reviewed OAuth access token | Chutes is the reviewed direct E2EE path. Existing Chutes transport and attestation behavior is unchanged. | Existing Chutes E2EE v1 |
| OpenAI | No published third-party public-client registration for Airship. A clean-room Codex registration descriptor exists for research, but no production controller is enabled; UI account sign-in is unavailable. | Bearer API key (or workload identity for workload federation) | Advanced compatibility only for keys. OpenAI says standard API keys must not be exposed in browsers/apps. The companion does not change this authorization state. | Responses API, SSE, images, usage, and function calls |
| Anthropic | No published third-party consumer/Claude-login registration for Airship. Claude Code's browser login is a first-party Claude Code flow. | `x-api-key`; workload identity is a separate machine identity facility | The companion can provide the fixed-host network transport where header rewriting works, but transport does not grant Airship account authorization. UI OAuth remains unavailable; API keys are unaffected. | Messages API, SSE, images, usage, and tool use |
| xAI | No published third-party public-client inference registration for Airship. | Bearer API key; xAI documents ephemeral browser tokens for Realtime only | The companion can technically carry the fixed xAI device/token hosts, but no production Airship OAuth controller is enabled. General inference becomes ready only after its actual request succeeds. | Responses-compatible API, SSE, function calls; `/v1/language-models` modalities |
| Ollama / LM Studio / compatible local service | Not applicable | Usually none on an explicitly approved loopback origin | The local adapter owns discovery, CORS/PNA diagnostics, and endpoint policy. The registry permits unauthenticated connections only on `localhost`, `127.0.0.1`, or `[::1]`. | See `src/inference/local/` |

Primary sources:

- OpenAI API authentication says API keys must not be exposed in browsers or
  apps: <https://developers.openai.com/api/reference/overview/>
- OpenAI's official TypeScript SDK documents the explicit browser danger
  opt-in: <https://github.com/openai/openai-node/blob/master/README.md>
- OpenAI's Codex sign-in article describes the first-party Codex flow and the
  separate API key it creates:
  <https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt>
- Anthropic's official TypeScript SDK documents server-side use and the
  explicit browser danger opt-in:
  <https://github.com/anthropics/anthropic-sdk-typescript/blob/main/README.md>
- Anthropic documents Claude Code's own account login:
  <https://code.claude.com/docs/en/getting-started>
- xAI inference authentication requires bearer API keys:
  <https://docs.x.ai/developers/rest-api-reference/inference>
- xAI's language-model directory publishes model modalities:
  <https://docs.x.ai/developers/rest-api-reference/inference/models>
- xAI's browser-safe Realtime tokens require a server to mint them from a
  standard API key:
  <https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens>

## Runtime contracts

The implementation lives in `src/inference/providers/`:

- `provider-catalog.ts` validates and freezes provider routes, authentication
  methods, OAuth posture, protocol, and transport boundary.
- `connection-registry.ts` is the page-memory credential authority. Metadata
  snapshots contain no key, access token, or refresh token. A trusted transport
  borrows credential material per request.
- `model-catalog.ts` atomically publishes connection-observed model metadata.
  Missing capabilities remain unknown; Airship never derives vision, tools, or
  context size from a model's name.
- `session-route.ts` pins a provider revision, connection generation, and model
  snapshot. A reconnect, provider route change, disconnect, failed health
  check, or unavailable model blocks resolution instead of silently routing
  elsewhere.
- `browser-cloud.ts` implements bounded, cancellable direct adapters for OpenAI
  Responses, Anthropic Messages, and xAI Responses compatibility. Requests use
  `credentials: omit`, `redirect: error`, `referrerPolicy: no-referrer`, and
  `cache: no-store`. Anthropic and xAI OAuth turns are the exception: they are
  relayed by the extension and have no direct fallback, so an absent extension
  is reported as `bridge-unavailable` with the cause named, never as a network
  failure.
- `bridge/client.ts` gates a bridged request on a handshake observation. That
  observation is memoized for at most `presenceTtlMs` (30 s) and only when it
  was positive, so the staleness window is bounded and one-directional: an
  absence is always re-probed, and a stale presence can only admit a request,
  which then fails live at the first-byte deadline if the extension has gone.
  The memo is per page load, is never persisted, and is never what a capability
  record reports — `probeExtensionBridge()` always runs a fresh handshake.

### Public PKCE gate

The generic registry accepts OAuth tokens only if its provider descriptor
contains reviewed public-client metadata with all of these properties:

1. HTTPS authorization and token endpoints.
2. An exact HTTPS redirect URI, with loopback HTTP allowed only for local
   development.
3. `codeChallengeMethod: "S256"`.
4. `tokenEndpointAuthMethod: "none"`.
5. Bounded registered scopes.
6. A review ID, canonical review timestamp, and HTTPS review source.
7. No client-secret field.

These are structural properties of a descriptor. They are not a judgement about
whose client registration it is, and the sentence that used to stand here — "an
OpenAI, Anthropic, or xAI first-party product login does not satisfy this gate"
— was wrong on both counts by the time it was read, because the product ships
exactly such a login.

What actually ships, stated plainly:

- `openai-codex-oauth` (`src/inference/providers/official-providers.ts`) records
  a clean-room interoperability descriptor for OpenAI's own Codex public
  registration. It is not an Airship provider grant and no production
  controller is enabled from that descriptor.
- Its `review` record (`openai-codex-live-cors-2026-07`) is asserted metadata.
  Nothing verifies it at runtime. The reachability fact underneath it is real
  and was measured — `https://auth.openai.com/oauth/token` answers a
  cross-origin POST with `access-control-allow-origin: *` — but the review is a
  human statement recorded in code, exactly like the pre-existing Chutes review
  record.
- Anthropic and xAI OAuth are **not** in the generic registry as connectable
  methods. The companion has reviewed transport primitives for their fixed
  hosts, but no account authorization is offered until an Airship-usable grant
  and controller exist. See `src/auth/provider-oauth/registrations.ts` for the
  measured network evidence and `docs/EXTENSION_BRIDGE.md` for the relay
  contract.

Adding any further OAuth method requires client-registration metadata and a
fresh review, not a UI-only flag.

### Credential generations

- Entering or reconnecting an API key creates a new connection generation.
- Completing a new OAuth consent creates a new generation.
- Refreshing tokens for the same OAuth grant uses `rotateOAuth()` and preserves
  the generation. A stale refresh result cannot overwrite a newer generation.
- Disconnecting immediately removes the credential record from the page-memory
  authority.
- No registry method exports all credentials or serializes a token.

This does not make arbitrary browser JavaScript a hardware secret store. XSS,
malicious extensions, and a compromised transport inside the trusted client
boundary can still steal a page-memory string. The provider-specific browser
policy remains visible so the product can require an explicit advanced-mode
acknowledgement.

## Credential-free agent awareness

`createInferenceAvailabilitySnapshot()` returns a bounded object suitable for
an `inspect_inference_connections` read tool. It includes:

- simultaneously connected providers and connection labels;
- observed health and proved capabilities;
- bounded model IDs, availability, and only evidence-backed capabilities;
- the active immutable session route and its current resolution state; and
- explicit omitted counts.

It excludes credentials, refresh metadata, scopes, provider URLs, and request
headers. `renderInferenceAvailabilityForPrompt()` produces a bounded compact
projection for a new session system prompt and explicitly tells the agent not
to switch an active session silently.

`InspectInferenceConnectionsTool` is the concrete governed read-only tool
implementation. It shares the same snapshot builder so the system prompt and
tool result cannot drift into two definitions of availability.

## Integration status (what is actually wired today)

This section is the factual state; the numbered boundaries below it are the
target design, not a description of the running application.

- `BrowserInferenceFabric` (`src/inference/fabric.ts`) is the single mounted
  runtime. It registers `OFFICIAL_CLOUD_PROVIDERS` plus any discovered local
  provider, and it owns the connections, models, transports, and route pins for
  OpenAI, Anthropic, xAI, Ollama, and LM Studio.
- Chutes is **not** mirrored into that registry. The Chutes connection remains
  its own authority in the application shell, and it reaches the agent only
  through the availability snapshot's `project` hook, which appends a synthetic
  Chutes connection row. Point 2 below is therefore still unimplemented.
- Consequently `createChutesProviderDescriptor()` and
  `InferenceConnectionRegistry.connectOAuth()` have no production caller; they
  are reviewed, tested contracts waiting for that mirror, not live code paths.
- `declareModelMetadata()` is the fabric's operator-declared context-window /
  output-ceiling entry point. It exists and is tested; no UI currently calls it,
  so cloud model rows carry neither limit in practice. Anthropic turns
  therefore run on the transport's requested output budget rather than a
  declared ceiling — see "Anthropic `max_tokens`" in docs/PROVIDER_FABRIC.md.
- A declaration rewrites the whole row's `source.kind` to `manual`, including
  fields it did not touch. That is a provenance downgrade, not an upgrade, and
  it is recorded in docs/PROVIDER_FABRIC.md rather than corrected: per-capability
  evidence keeps its own `source`, so nothing claims evidence it lacks.
- Declared values are bounded by `MAX_MODEL_OUTPUT_TOKENS` /
  `MAX_MODEL_CONTEXT_WINDOW_TOKENS` from `providers/contracts.ts`. The transports
  revalidate the output ceiling against the same constant, so the catalog cannot
  accept a number that would then throw on every request.

## Integration points

The UI shell is intentionally not coupled to this core. The next integration
layer should use these exact boundaries:

1. Application boot constructs one `InferenceProviderCatalog`, one
   `InferenceConnectionRegistry`, and one `InferenceModelCatalog`.
2. The existing Chutes connection flow remains authoritative. Its successful
   public-PKCE or API-key connection is mirrored into the generic registry;
   the Chutes E2EE transport is not replaced by the plaintext cloud adapters.
3. OpenAI, Anthropic, and xAI advanced API-key forms call `connectApiKey()`.
   They must render the descriptor's browser warning before connecting.
4. A successful authenticated model-directory request calls
   `replaceConnectionModels(connection.id, connection.generation, providerId,
   models)`, updates `models:list`, and records connection health. The model
   rows must carry that same connection ID and credential generation. A
   successful inference request is what proves `invoke`.
5. Session creation or an explicit fork calls `pinInferenceRoute()`. The
   existing manifest `providerId` and `model` fields should be derived from
   that pin; a future manifest protocol revision can journal the complete pin.
6. Each new session system prompt receives the bounded availability projection.
   A read-only inspection tool returns the structured snapshot.
7. Transport selection uses the pinned provider protocol and connection
   generation. `resolvePinnedInferenceRoute()` must pass before every remote
   turn.
8. Provider preferences may select defaults for a *new* session. They never
   mutate a running session.

### Exact construction and transport calls

```ts
const providers = new InferenceProviderCatalog([
  createChutesProviderDescriptor(reviewedChutesPkce),
  ...OFFICIAL_CLOUD_PROVIDERS,
]);
const connections = new InferenceConnectionRegistry(providers);
const models = new InferenceModelCatalog(providers);

const connection = connections.connectApiKey({
  id: "openai-main",
  providerId: "openai",
  authMethodId: "openai-api-key",
  label: "OpenAI",
  apiKey,
});

const transport = new OpenAiBrowserTransport({
  connectionId: connection.id,
  connectionGeneration: connection.generation,
  connections,
});
const discovered = await transport.listModels(signal);
models.replaceConnectionModels(
  connection.id,
  connection.generation,
  connection.providerId,
  discovered,
);
```

Use `AnthropicBrowserTransport` and `XaiBrowserTransport` with the same pinned
constructor arguments for their corresponding provider. For Chutes, keep the
existing E2EE transport and mirror only its connection metadata into this
registry.

After a real probe, publish only the evidence actually observed:

```ts
connections.updateHealth(connection.id, {
  state: "ready",
  checkedAt: new Date().toISOString(),
});
connections.updateCapabilities(connection.id, {
  "models:list": {
    state: "available",
    source: "live-probe",
    checkedAt: new Date().toISOString(),
  },
});
```

Before a turn, call `resolvePinnedInferenceRoute()`. Transports borrow a key
through `useCredential()` internally and pass the pinned
`expectedGeneration`; no caller receives a credential snapshot.

## Deliberate non-claims

- Airship does not claim that OpenAI, Anthropic, or xAI offer third-party
  browser OAuth for general inference. Running a vendor's own public client
  registration, which is what `openai-codex-oauth` does, is not the same thing
  as being offered one.
- A reviewed OAuth descriptor's `review` record is an asserted human statement.
  Nothing verifies it at runtime, and it is not evidence of anything beyond
  someone having written it down.
- A successful key import does not prove model invocation permission.
- A provider model list does not prove undeclared capabilities.
- An API-key form does not make a browser key safe merely because Airship does
  not persist it.
- A network failure cannot distinguish CORS, provider outage, or local network
  reachability; the adapter reports the combined diagnostic honestly.

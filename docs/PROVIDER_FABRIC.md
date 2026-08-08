# Provider-neutral inference fabric

Status: implemented contracts and isolated browser transports, reviewed
2026-08-05. This document distinguishes protocol reachability from safe
credential custody. A successful CORS preflight is not an OAuth grant, a trust
claim, or permission to embed a provider secret.

## Invariants

1. Airship may hold several inference connections at once. Provider identity,
   connection identity, credential generation, model identity, and transport
   boundary are separate fields.
2. A session pins all five. Reconnecting an identically named connection,
   refreshing a catalog, or changing the selected model never rewrites or
   adopts an existing session. A validated session-library return link locates
   the immutable pin on Connection; it may reopen a session only when the held
   route resolves that exact pin and its profile, full audit, and journal head
   still agree. Otherwise activation fails closed without creating a
   replacement; deliberate adoption requires a new session or fork.
3. Credentials do not enter a session manifest, model directory, availability
   snapshot, system prompt, URL, log, receipt, IndexedDB, OPFS, Vault, service
   worker, or local/session storage.
4. `configured`, `authorized`, `healthy`, `model listed`, and `model invocable`
   are different states. A live provider operation supplies each positive
   claim; missing fields remain unknown and required unknown capabilities fail
   closed.
5. Model suffixes and product branding never imply vision, tools, context
   length, confidentiality, or attestation.
6. Chutes E2EE is its own transport boundary. OpenAI, Anthropic, and xAI direct
   adapters are ordinary provider-TLS connections and must never inherit a TEE
   label.

The implementation lives in
`src/inference/providers/`. `InferenceProviderCatalog` validates provider and
authentication declarations; `InferenceConnectionRegistry` is the page-memory
credential authority; `InferenceModelCatalog` preserves observed capability
evidence per connection and credential generation; and
`SessionInferenceRoutePin` makes routing immutable.
`createInferenceAvailabilitySnapshot()` emits a bounded credential-free object
for tools and the system prompt. The prompt projection tells the agent which
connections can invoke and which model capabilities were positively declared,
while explicitly forbidding silent route changes.

The mounted Connection surface keeps multiple validated connections live at
once. A candidate credential is staged in an isolated page-memory registry;
model discovery must succeed before it is committed, and a failed connection
attempt cannot destroy an existing working route. Choosing a model performs a
bounded invocation check and normally creates a new immutable conversation. A
session-library return link first checks whether this page still holds the
session's exact connection generation, model, and authentication method. Only
then, after profile policy, complete local audit, and stable journal-head checks
also pass, does Connection offer to reopen that conversation without creating
another. Disconnects and replacement credentials fail closed while the prompt
and historical conversation remain intact. Every subsequent turn resolves the
exact pin again.

## Current provider compatibility

| Provider | Third-party account OAuth for Airship | API credential | Model directory | Turn protocol | Browser posture |
| --- | --- | --- | --- | --- | --- |
| Chutes | Authorization Code + S256 PKCE is available when the registered app has token endpoint authentication `none` | `cpk_` bearer, page-memory only | Anonymous `GET https://llm.chutes.ai/v1/models`; protected invocation still needs live authorization | OpenAI Chat Completions payload inside Chutes E2EE v1 | Preferred direct provider path |
| OpenAI | No published third-party public-client grant for reusing a ChatGPT/Codex account | Bearer API key | Authenticated `GET https://api.openai.com/v1/models`; records provide identity/ownership, not a reliable capability matrix | Responses API SSE, function calls, images | Technically reachable but explicit-risk compatibility only |
| Anthropic | Claude/`ant` interactive OAuth is a first-party CLI flow, not a published Airship client registration | `x-api-key`; WIF is workload authentication, not consumer sign-in | Authenticated paginated `GET https://api.anthropic.com/v1/models`; capability fields remain unknown unless another authoritative source supplies them | Messages API SSE content blocks, tool use, images | Explicit-risk compatibility only; requires Anthropic's direct-browser acknowledgement header |
| xAI | Grok Build browser login is first-party; no published third-party public-client inference grant | Bearer API key | Authenticated `GET https://api.x.ai/v1/language-models` supplies declared modalities and pricing; `/v1/models` is the smaller compatibility list | Responses API SSE; Chat Completions remains a separate compatibility surface | Explicit-risk compatibility; local companion preferred |

Airship does not label “Sign in with Codex,” “Sign in with Claude,” or “Sign in
with Grok” as available. Their first-party product flows do not establish that
a separately distributed static client may register, request scopes, refresh
tokens, or spend the user's account balance.

Anthropic now also documents Workload Identity Federation and an OAuth token
exchange for cloud/CI workload identities. That is useful for a user-owned
companion or enterprise deployment, but it is not browser consumer OAuth and
does not change the table above.

xAI documents short-lived browser client secrets for its Realtime voice
WebSocket. Those tokens are minted with an API key by a trusted server and are
not documented as credentials for general Responses or Chat inference.

## Browser probes

On 2026-07-24 Airship issued credential-free `OPTIONS` and unauthorized `GET`
probes from the local Airship origin:

- OpenAI `/v1/models`, Anthropic `/v1/models`, and xAI
  `/v1/language-models` returned CORS headers that permit their required
  request headers. Unauthorized reads correctly returned 401.
- Chutes `/v1/models` returned its anonymous public catalog and permissive CORS.
- Anthropic varied on
  `anthropic-dangerous-direct-browser-access`, matching its SDK's explicit
  browser opt-in.

This is dated deployment evidence only. CORS can change independently of the
API contract. A fetch `TypeError` is reported as “network, provider, or CORS”
rather than falsely diagnosing one cause.

Before enabling these exact direct adapters in the application CSP, re-run the
preflight and one disposable-credential call from the production origin.
Allow-list only:

- `https://api.openai.com`
- `https://api.anthropic.com`
- `https://api.x.ai`
- the existing exact Chutes origins

No user-provided remote base URL belongs in the cloud adapter. Local
OpenAI-compatible services use a separate loopback-only contract.

## Credential custody

### Chutes OAuth

Use a registered Browser/native client, Authorization Code, state, and S256
PKCE. The client has no secret. Airship's reviewed `chutes-api` source supports
`token_endpoint_auth_method = "none"` and requires PKCE for that client type.
The live OpenID discovery advertises `none`; Airship still requires S256 even
if an older deployment advertises `plain`.

Directory visibility (`public`) is not OAuth client type. Airship must inspect
the registration's token endpoint authentication method and fail closed when a
legacy confidential app rejects secretless exchange. Chutes' general web
integration guide still shows a server-held client secret; that example must
not be copied into the PWA.

Access and refresh tokens remain in the page-memory broker. Reload currently
requires reconnection unless a future provider-managed HttpOnly session
contract is introduced. An embedded “obfuscated” client secret is still a
public secret and is prohibited.

### Direct API keys

The cloud transport constructors accept the page-memory connection authority
or, in explicit compatibility mode, a getter—never a serializable
configuration object containing a key. With the authority, the credential
lease remains inside its callback for the complete request and is pinned to
the expected connection generation. Reconnecting another account under the
same connection name makes old transports fail instead of silently adopting
the replacement credential. Each operation adds the credential only to the
exact provider origin. Error bodies are bounded and discarded rather than
surfaced.

This controls accidental persistence; it cannot make a long-lived key secret
from malicious same-origin JavaScript. OpenAI and Anthropic disable their
browser SDK paths by default for this reason, and xAI repeatedly directs
browser clients away from long-lived API keys.

Therefore the durable production preference is a user-owned local companion:

1. store the key in the OS keychain;
2. bind a loopback listener to an install-specific public key and the exact
   Airship origin;
3. require a per-page challenge and explicit provider scope;
4. proxy only reviewed provider paths, methods, and bounded bodies;
5. stream responses without exposing the provider credential;
6. revoke the page grant on disconnect, origin change, or idle expiry.

That companion remains edge software on the user's device, not an Airship
backend. Page-memory direct keys remain an explicit advanced/development mode.
Encrypting a key into IndexedDB is not equivalent: once Airship can decrypt it,
same-origin script can ask Airship to use it.

## Adapter contracts

`OpenAiBrowserTransport` and `XaiBrowserTransport` normalize Responses API
events into Airship's `InferenceEvent` stream:

- visible text deltas;
- reasoning progress, and alongside it whatever reasoning text the provider
  chose to stream, carried as `reasoning-delta`; `runTurn` accumulates those
  deltas into one durable `turn.reasoning` record per request, bounded and
  flagged when truncated, so the transcript keeps what the person was shown
  rather than only the fact that reasoning happened;
- bounded function-call argument assembly;
- usage;
- one terminal completion.

`AnthropicBrowserTransport` performs the equivalent Messages API mapping:
`content_block_*`, `input_json_delta`, `message_delta`, and `message_stop`.
Canonical Airship tool results become Anthropic `tool_result` blocks. Inline
image data is restricted to the media types accepted by the current Messages
contract.

All three adapters omit the entire tool block — `tools`, `tool_choice`, and
(for Responses) `parallel_tool_calls` — from a turn that declares no tools.
Both vendor contracts validate a tool-selection field against the declared tool
list, and `BrowserInferenceFabric.activate()`'s mandatory invocation probe is
exactly a toolless turn, so emitting an empty `tools: []` alongside
`tool_choice` made the probe a request the vendor was entitled to refuse.
Whether either Responses vendor actually refuses it has never been observed
here — no vendor key exists in this repository — which is why the block is
omitted rather than left to chance. The Chutes payload builder already carried
this boundary; the direct cloud adapters now match it.

### Anthropic `max_tokens`

Anthropic requires `max_tokens` on every Messages request and, per its
published contract, rejects any value above the selected model's own ceiling
with a 400 that states that ceiling. A transport is constructed per connection,
before a model is chosen, so one number has to stand in. Airship resolves it in
this order:

1. an operator declaration for that exact model
   (`declareModelMetadata` → `maxOutputTokensForModel`);
2. a ceiling Anthropic itself stated while refusing an earlier send on this
   connection;
3. the connection-wide budget, 64000 tokens.

Step 3 is a requested budget, not a claimed ceiling: Airship still does not
infer a limit from a model name. It is deliberately generous because the two
errors are not symmetric — a budget below a model's real limit silently
shortens every reply, while a budget above it is refused with the real number
attached. On such a refusal `AnthropicBrowserTransport` adopts the stated
ceiling and re-sends **once**; a second refusal is raised. The parser requires
the exact documented shape (a 400 `invalid_request_error` whose message reads
`max_tokens: <asked> > <limit>, …`) and requires the stated limit to be
strictly below what was asked, so anything else propagates the original refusal
untouched. That refusal shape has never been observed here either, which is why
every part of it is checked rather than assumed.

A learned ceiling lives in the transport for the life of the connection and is
**not** written into the model catalog: a catalog row's `source` describes the
provider directory that produced its ID and label, and a request refusal is not
that directory. So a learned ceiling does not appear as `out=` in the agent's
availability snapshot; only an operator declaration or a local provider's own
published limit does.

The declared ceiling is bounded by `MAX_MODEL_OUTPUT_TOKENS`, the same constant
`normalizeModel` validates against, so the fabric cannot accept a declaration
the next request would throw on.

All three adapters:

- use fixed HTTPS provider origins;
- validate and bound API keys, JSON, model counts, SSE events, tool counts,
  tool argument sizes, and total lifetime;
- support cancellation through `AbortSignal`;
- discard bounded provider error bodies and expose only status plus safe prose;
- never generate a receipt or trust claim they cannot prove;
- set OpenAI/xAI Responses `store: false` so Airship remains the conversation
  authority. Provider retention policies still apply independently.

OpenAI's basic model list and Anthropic's model list do not currently carry a
complete machine-readable feature matrix, so their normalized capabilities
remain unknown. xAI's detailed language-model list supplies input/output
modalities; undeclared tool and reasoning capabilities remain unknown.

## Model limits and where they come from

`InferenceModelDescriptor` carries optional `contextWindowTokens` and
`maxOutputTokens`, and the credential-free availability snapshot passes both
through to the agent's `inspect_inference_connections` result and to the prompt
projection, where they render as `ctx=` / `out=` facets. Both are omitted, never
defaulted, when nothing observed them — an absent facet is the honest statement
that the number is unknown, and the agent must not read it as "unlimited".

Sources today:

- Ollama and LM Studio publish a real context length, which the local catalog
  adapter records as `local-discovery`.
- OpenAI, Anthropic, and xAI publish neither limit in their model directories,
  and Airship forbids inferring one from a model name or family (invariant 5).
- `BrowserInferenceFabric.declareModelMetadata()` records an operator-declared
  value and relabels that row's `source.kind` as `manual`, because a person
  asserted the number rather than the provider publishing it. That relabelling
  is a deliberate provenance *downgrade* and it applies to the whole row, not
  just the declared fields: the ID, label, and per-capability evidence still
  came from the provider directory, and each capability keeps its own `source`,
  but the row-level `source.kind` now understates where those unchanged fields
  came from. Understating is the safe direction — nothing claims evidence it
  does not have — so it is left as is and recorded here rather than fixed with
  a second provenance field the UI has no way to render.
- `declareModelMetadata()` has **no UI caller yet**. Nothing in the shipped app
  invokes it, so in practice every cloud row's limits today are whatever the
  provider published (nothing, for the three direct vendors) — see the
  consequence below.

Consequence to state plainly: until a value is declared, a cloud session has no
context window, so the agent runtime pins no context-compression policy for it
and a long conversation grows until the vendor refuses it. Because no UI can
declare one yet, that is the state of *every* direct cloud session today.
Anthropic output length is the one limit that is not simply absent: it falls
back to the 64000-token requested budget above, self-corrected downward only if
the vendor refuses it. That is a known, labeled gap rather than a silent one.

## Live verification status

`src/inference/providers/browser-cloud.live.test.ts` is an env-gated wire gate
(`AIRSHIP_OPENAI_API_KEY`, `AIRSHIP_ANTHROPIC_API_KEY`, `AIRSHIP_XAI_API_KEY`,
with optional `AIRSHIP_*_MODEL`). Per vendor it asserts the declared catalog
route, a toolless probe reaching a terminal event, and a real streamed tool
call. It runs on Node/undici, which sends no `Origin` and enforces no CORS, so
it proves protocol only.

Neither that gate nor a cross-origin browser gate has been executed against
OpenAI, Anthropic, or xAI, so every claim in the compatibility table above about
those three remains a documentation claim plus the dated 2026-07-24 probes
below. Only Chutes has an executed live gate
(`src/inference/chutes/transport.live.test.ts`). A browser reachability gate
driving the built artifact from a real cross-origin page is still outstanding;
the successful authenticated streamed turn from such a page — not an
`access-control-allow-origin` assertion, which browsers do not expose — would be
the CORS proof.

## Authoritative sources

- [Chutes authentication](https://chutes.ai/docs/getting-started/authentication)
- [Sign in with Chutes](https://chutes.ai/docs/sign-in-with-chutes/overview)
- [OpenAI API authentication and API-key warning](https://developers.openai.com/api/reference/overview/)
- [OpenAI model list](https://platform.openai.com/docs/api-reference/models/list)
- [OpenAI Responses streaming](https://platform.openai.com/docs/api-reference/responses-streaming)
- [OpenAI official TypeScript SDK browser warning](https://github.com/openai/openai-node#requirements)
- [Anthropic API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)
- [Anthropic CLI OAuth scope](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication)
- [Anthropic model list](https://platform.claude.com/docs/en/api/models/list)
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic official TypeScript SDK browser warning](https://github.com/anthropics/anthropic-sdk-typescript#requirements)
- [xAI model and detailed language-model lists](https://docs.x.ai/developers/rest-api-reference/inference/models)
- [xAI Responses and Chat endpoints](https://docs.x.ai/developers/rest-api-reference/inference/chat)
- [xAI function calling](https://docs.x.ai/developers/tools/function-calling)
- [xAI browser-safe Realtime ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens)
- [Grok Build first-party browser login](https://docs.x.ai/build/overview)

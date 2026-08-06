# Browser-direct local model providers

Airship can connect directly from the browser to an Ollama or LM Studio API on
the user's device. The adapter does not call an Airship proxy and does not
write provider tokens to browser or vault storage.

## Public integration contract

Import from `src/inference/local/index.ts`:

```ts
import {
  connectLocalProvider,
  createBrowserLocalModelProvider,
  type LocalModelDiscovery,
} from "../src/inference/local";

const provider = createBrowserLocalModelProvider("ollama");
const health = await provider.probeHealth(abortController.signal);
const connected = await connectLocalProvider(provider, {
  connectionId: "local-ollama",
  connectionGeneration: 1,
  providerId: "ollama",
}, abortController.signal);
const discovery: LocalModelDiscovery = connected.discovery;
modelCatalog.replaceConnectionModels(
  "local-ollama",
  1,
  "ollama",
  connected.models,
);
const transport = connected.transport;
```

The provider transport implements Airship's ordinary `InferenceTransport`.
This lets a session pin the exact local provider/model while the agent's
provider roster can carry the discovery result into its system prompt.

The stable exports are:

- `OllamaBrowserProvider` and `LmStudioBrowserProvider`
- `createBrowserLocalModelProvider`
- `OLLAMA_DEFAULT_ENDPOINT` and `LM_STUDIO_DEFAULT_ENDPOINT`
- `BrowserLocalModelProvider`, discovery/model/capability/diagnostic types
- `LocalOpenAiTransport`
- `resolveLocalEndpoint` and `LocalProviderError`

## Network and credential boundary

The defaults are exact loopback origins:

- Ollama: `http://127.0.0.1:11434`
- LM Studio: `http://127.0.0.1:1234`

A caller may pass an `endpoint` on either provider, but only for another origin
already in Airship's enumerated allowlist. The allowlist is one flat set, not a
per-provider partition — `resolveLocalEndpoint` takes no provider argument and
checks the origin against every entry — so either provider may legally be
pointed at any of these twelve:

- ports: `11434`, `11435`, `11436` (Ollama's default plus the two an extra
  instance or `OLLAMA_HOST=:11435` usually lands on) and `1234`, `1235`, `1236`
  (the LM Studio equivalents)
- hosts: `localhost` and `127.0.0.1` only (`[::1]` is a loopback host but is not
  an allowlisted origin, because a CSP `connect-src` source cannot express it)

The ports are grouped above by which service usually occupies them, and that
grouping is documentation only. Nothing rejects an Ollama connection to
`http://127.0.0.1:1234`; what is enforced is the twelve-origin set itself.

Public, private-LAN, link-local, unique-local IPv6, `.local`, and any other
port are rejected, and the rejection names the exact origin that was refused.
Caller options cannot broaden that boundary: the runtime allowlist
(`DEFAULT_LOCAL_MODEL_ORIGINS`) and the `connect-src` policies in `index.html`
and `public/_headers` are the same twelve origins, and a unit test fails if
they ever diverge. A service on any other port must be moved onto one of these,
because a wildcard `connect-src` is refused by the static-security gate.

HTTP loopback remains browser-dependent and is labeled honestly because CORS
and browser local-network access policy can still apply. Airship does not
silently fall back to a proxy or a LAN endpoint when a loopback probe fails.

Opaque browser failures become a `cors-or-private-network-access` diagnostic.
Airship does not work around that failure with a proxy. The user must start the
provider API and configure it to accept the exact Airship origin.

`credential` accepts only a page-memory getter, not a raw stored value. It is
resolved once per request, sent only as a bearer header
to the validated origin, and excluded from discovery records and errors. The
adapter has no persistence dependency or credential-storage API.

## Discovery and capability truth

Ollama discovery uses only the provider's advertised `GET /api/tags` directory.
Airship does not follow that list with `POST /api/show` requests: Ollama may
load a model while answering `show`, so probing every installed row during a
refresh can consume substantial memory before a person chooses a model.
Capabilities are reported only when `/api/tags` itself includes explicit
capability fields; otherwise the state is `unknown`, never guessed from a
model name. An invocation check is reserved for the model a person explicitly
selects.

LM Studio discovery uses the current native `GET /api/v1/models` schema and
falls back to `GET /api/v0/models` only when the server explicitly reports that
the v1 route is unavailable. Capabilities are taken from native v1 capability
fields or the v0 `capabilities`/`type` metadata, with the exact field recorded
as provenance.

Both providers expose OpenAI-compatible `POST /v1/chat/completions` streaming.
The transport supports canonical text, image, tool history, streamed tool
calls, reasoning progress, and usage events through Airship's existing
provider-neutral contracts.

Model choice is always catalog-driven. Airship preserves every model id the
service returns and never derives a model from a name, family, or response
order. If a provider returns exactly one model with explicit text-generation
evidence, that unambiguous route may be opened automatically; otherwise the
Connection view asks the person to choose from the current returned list.

Provider references:

- [Ollama model list](https://docs.ollama.com/api/tags)
- [Ollama model details and capabilities](https://docs.ollama.com/api-reference/show-model-details)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio REST API and model discovery](https://lmstudio.ai/docs/developer/rest)

## Bounds and cancellation

Discovery JSON, model count, request bodies, SSE events, complete streams, tool
count, and tool-argument size are bounded.
Requests have a total deadline and accept caller cancellation. Stream readers
are cancelled in `finally`; the adapter never retries an inference request,
which avoids accidental duplicate tool-producing turns.

Direct fetches use `credentials: omit`, `cache: no-store`,
`referrerPolicy: no-referrer`, and `redirect: error`. An HTTP redirect cannot
turn a reviewed loopback call into an SSRF request. SSE requires `[DONE]` or a
terminal OpenAI `finish_reason`; malformed UTF-8, invalid tool arguments,
post-completion data, and truncated streams fail closed.

The provider reports `local` posture only after the endpoint passes the exact
loopback policy. There is no private-network transport mode in this adapter.

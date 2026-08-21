# Provider-neutral inference fabric

Status: living connection and routing design for Airship's provider layer.

This document describes the fabric behind the **Providers** surface.

## Invariants

1. Airship may hold several provider connections at once.
2. Credentials stay in page memory.
3. Provider identity, connection identity, connection generation, model
   identity, and transport boundary are separate facts.
4. Model catalogs are runtime observations from each connected provider.
5. No provider gets a privileged trust tier, and no transport is selected by
   provider identity. The wire a descriptor declares — OpenAI Responses,
   Anthropic Messages, or OpenAI-compatible chat completions — chooses the
   transport, and that transport reads its origin, catalog endpoint and
   authentication contract from the descriptor it was given.
6. Remote providers are `provider-tls`; exact local loopback providers are
   `loopback-local`.

## Current provider set

| Provider | Protocol | Default endpoint | Boundary |
| --- | --- | --- | --- |
| OpenAI | OpenAI Responses | `https://api.openai.com/v1` | `provider-tls` |
| Anthropic | Anthropic Messages | `https://api.anthropic.com/v1` | `provider-tls` |
| xAI | OpenAI Responses | `https://api.x.ai/v1` | `provider-tls` |
| Chutes | OpenAI-compatible | `https://llm.chutes.ai/v1` | `provider-tls` |
| Ollama | OpenAI-compatible | `http://127.0.0.1:11434` | `loopback-local` |
| LM Studio | OpenAI-compatible | `http://127.0.0.1:1234` | `loopback-local` |
| Custom | OpenAI-compatible, OpenAI Responses, or Anthropic Messages | user supplied | `provider-tls` |

## Connection lifecycle

A candidate credential is staged in memory and used to read the configured
model catalog. The provider descriptor, connection, and models are published
only after that catalog returns a valid non-empty roster. Selecting a model is
local and sends no hidden prompt; provider access is exercised by the person's
first turn. Failed connection attempts must not destroy an existing route.

Custom OpenAI-compatible connections accept a name, HTTPS API base URL,
optional HTTPS model-catalog URL, API-key header, and bearer/raw key format.
The descriptor contains no credential and lasts for the current page lifetime.

## Session routing

Each turn records:

- provider ID;
- connection ID and generation;
- model ID;
- transport boundary.

That provenance is immutable for the completed turn. Later turns may use a new
model through the session's in-place model override event.

## Model switching

Changing a session's model is light:

- it is recorded as a session event;
- it applies on the next turn;
- it does not fork history by itself;
- earlier turns keep their original provider/model provenance.

## Dynamic HTTPS egress

The stock static build intentionally includes one `connect-src https:` grant so
a user can connect a browser-reachable HTTPS provider without rebuilding
Airship. The security gate still rejects wildcards, broad plaintext HTTP,
WebSocket schemes, non-loopback HTTP origins, and policy drift across
`index.html`, `public/_headers`, and `Caddyfile`.

This is a real egress tradeoff. Airship limits executable code to the shipped
same-origin bundle, validates custom provider URLs as credential-free HTTPS,
and sends the key only to the exact API and catalog origins the user entered.
The provider must also allow the Airship origin through CORS. Credentials stay
in page memory and never enter provider descriptors, URLs, storage, or logs.

## Honest claim language

The fabric distinguishes reachability, authorization, health, model discovery,
and successful invocation. A successful model listing does not imply a stronger
privacy, trust, or capability claim.

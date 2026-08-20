# Provider-neutral inference fabric

Status: living connection and routing design for Airship's provider layer.

This document describes the fabric behind the **Providers** surface.

## Invariants

1. Airship may hold several provider connections at once.
2. Credentials stay in page memory.
3. Provider identity, connection identity, connection generation, model
   identity, and transport boundary are separate facts.
4. Model catalogs are runtime observations from each connected provider.
5. No provider gets a privileged trust tier.
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
| Custom | OpenAI-compatible | user supplied | `provider-tls` |

## Connection lifecycle

A candidate credential is staged in memory, validated against the target
provider, and published as a connection only after the fabric has enough live
information to use it safely. Failed connection attempts must not destroy an
existing working route.

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

## Honest claim language

The fabric distinguishes reachability, authorization, health, model discovery,
and successful invocation. A successful model listing does not imply a stronger
privacy, trust, or capability claim.

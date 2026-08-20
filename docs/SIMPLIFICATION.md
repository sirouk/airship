# Provider-neutral simplification

Status: current branch contract for `simplify/edge-runtime`.

Airship used to carry a Chutes-specialized stack: provider-specific sign-in,
E2EE transport code, attestation and receipt surfaces, billing/account
telemetry, and several UI routes that existed only for that stack.

This branch removes that center of gravity.

## What changed

- **Chutes is now ordinary.** It is one OpenAI-compatible provider entry with
  base URL `https://llm.chutes.ai/v1`.
- **One provider surface.** Provider connection lives in one generic
  **Providers** screen instead of provider-specific ceremony.
- **Two honest transport labels.** Airship documents only `provider-tls` and
  `loopback-local`.
- **Light model switching.** Changing a conversation's model is a journaled
  in-place override that applies on the next turn.
- **Per-session concurrency gates.** One busy session does not freeze the rest
  of the app.
- **Docs and copy are provider-neutral.** No provider is privileged in user
  language.

## What was removed from the product contract

- provider-specific OAuth as the center of the connection flow;
- provider-special E2EE and attestation claims;
- proof, evidence, and billing surfaces tied to one provider;
- model-switch flows that forced profile/session ceremony for an ordinary model
  change.

## What stayed

- append-only sessions, forks, and journal provenance;
- encrypted storage providers and the storage ladder;
- workspace, editor, terminal, Git, and execution packs;
- PRIME, approvals, context/memory retrieval, and the static PWA deployment
  model.

## Archive policy

Pre-simplification material moved to [`docs/archive/`](archive/README.md). Those
files are kept for historical reasoning only. They are not normative.

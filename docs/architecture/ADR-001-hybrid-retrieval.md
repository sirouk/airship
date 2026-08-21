# ADR-001: hybrid retrieval for Airship context

Status: accepted architectural direction.

## Decision

Airship uses provider-neutral hybrid retrieval for workspace context.

The browser keeps a compact local routing layer, performs lexical and semantic
selection locally, and fetches only the encrypted ranges it needs from durable
storage when a compatible published index exists.

## Why

- full remote vector databases are a bad default for browser portability;
- the product needs exact lineage and bounded retrieval commitments;
- the same retrieval design must work across ephemeral mode, local durability,
  and encrypted cloud durability;
- users need context quality without surrendering plaintext workspace state to a
  service Airship controls.

## Consequences

- retrieval remains browser-led even when durable encrypted index shards exist;
- lexical and semantic signals are combined under explicit budgets;
- publication of encrypted index material is separate from using a local index;
- a missing or stale published index falls back to the current local generation
  instead of pretending remote retrieval succeeded.

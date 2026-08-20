# PRIME runtime inside Airship

PRIME is Airship's default recursive agent engine.

## What PRIME adds

- a persistent browser-side kernel;
- structured tool execution with approval hooks;
- recursive subagents with explicit budgets and gates;
- deterministic local coordination for longer agent workflows.

## Product role

PRIME runs inside the same Airship product boundary as sessions, providers,
workspace tools, and approvals. It does not change the trust meaning of the
provider connection chosen for a turn.

## Current rule

A PRIME turn uses the active Airship provider connection and records the same
provider/model provenance as any other turn. PRIME is an execution engine, not
a special provider lane.

For implementation detail, see `src/prime/README.md`, `src/prime/PORT-MAP.md`,
and `docs/PRIME-RUNTIME-GATE.md`.

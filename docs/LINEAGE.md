# Design lineage and provenance

Airship is informed by existing agent systems, but it is implemented as a
clean, browser-first runtime with its own contracts.

## Local reference library

The tracked catalog at
[`references/repositories.json`](../references/repositories.json) records the
exact repository URL, immutable revision, upstream relationship, license
status, intended study areas, and reuse boundary for disposable external
checkouts. The operating rules are in [`references/README.md`](../references/README.md)
and [`references/CLEAN_ROOM.md`](../references/CLEAN_ROOM.md).

## Hermes Agent

The Hermes Agent checkout is the main behavioral reference for:

- byte-stable prompt prefixes;
- strict role ordering and append-only history;
- a narrow core with capabilities at the edges;
- explicit sessions, memory provenance, context compression, and cancellable
  streaming.

Airship does not copy Hermes' server, CLI, process, or host-environment
assumptions into the browser runtime.

## `sirouk/claw-code` and `sirouk/claude-code-rs`

These repositories are approved clean-room behavior studies for compact agent
loops, streaming, tools, terminal/workspace behavior, and native packaging.
Their local checkouts are research inputs only and are never copied into the
shipping browser product.

# Airship compute continuum

Status: browser-first execution contract with optional future remote placement.

Airship exposes one execution model across several runtimes. The browser remains
the control authority. Optional stronger execution tiers may exist later, but a
future remote executor is not the current product baseline.

## Current truth

Today Airship ships browser-owned execution paths such as Workers, WASI,
Pyodide, and optional WebContainer activation. No remote executor is part of the
current default product contract.

## Design rules

1. The browser owns approvals, job sequencing, context selection, journaling,
   and final adoption decisions.
2. Placement is decided before a job starts.
3. A remote executor, if added later, receives only one bounded approved job.
4. A remote executor must not receive the workspace root key, vault authority,
   or unrestricted provider/storage credentials.
5. Remote output is quarantined until structure, bounds, and expected records
   verify.
6. TLS alone is not a remote-execution trust claim. Any stronger claim would
   need separate evidence the client can verify.
7. The app must never silently fall back from an explicitly stronger execution
   requirement to a weaker one.

## Capability ladder

| Tier | What it means |
| --- | --- |
| Browser baseline | JS workers and typed browser tools |
| Browser enhanced | local acceleration such as OPFS, WASM SIMD, WebGPU, or optional packs |
| Native companion | explicit user-installed bridge for host capabilities |
| Remote confidential executor | future explicit placement target, separate from ordinary provider inference |

## Remote placement policy

A future remote executor is a separate trust subject from an inference provider.
It would need its own enrollment, its own capability record, and its own result
validation path. Inference metadata alone must never be promoted into execution
authority.

## Workspace and state boundary

The browser remains authoritative for:

- the active workspace head;
- session journals;
- approvals and policy;
- context selection;
- final adoption of any returned delta.

A remote executor may compute on an approved snapshot, but it does not become
the source of truth for Airship state.

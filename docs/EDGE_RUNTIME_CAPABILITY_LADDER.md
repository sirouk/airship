# Airship edge-runtime capability ladder

Status: living capability doctrine for the browser-first product.

Airship runs on a capability ladder. "Runs anywhere" does not mean every device
has the same power. It means the product stays honest about what the current
browser, installed companion, or optional execution tier can actually do.

## Product invariant

The device owns the agent loop, prompt assembly, workspace plaintext, context
selection, approvals, encrypted state, and session history. Static asset
delivery is allowed. Airship is not a disguised session backend.

## Tiers

| Tier | Minimum surface | Typical use | Honest limit |
| --- | --- | --- | --- |
| Web baseline | modern browser, Web Crypto, Worker, fetch | chat, workspace tools, direct provider calls, page-memory or encrypted durability | tab must stay alive; no arbitrary host shell |
| Web enhanced | OPFS, Web Locks, WASM SIMD, optional WebGPU | faster local indexing, larger caches, richer execution packs | varies by engine and device |
| Installed PWA | enhanced tier plus install support | app-like shell and better local continuity | still not a background daemon |
| Native companion | explicit user-installed helper | host files, PTY, native Git, long-running jobs | separate capability and approval boundary |
| Remote confidential executor | future explicit placement target | delegated bounded execution on a separately trusted subject | not the same thing as browser execution |

## Rules

- Capabilities are advertised only after live detection.
- The UI must show the tier actually in use.
- Unsupported capability requests fail clearly.
- Optional higher tiers must not weaken the meaning of lower-tier evidence.

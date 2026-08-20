# Airship

**One static PWA. Any device. Any model. Your keys.**

Airship is an open-source agent workbench that runs in your browser. There is
no Airship backend. You can host the built files on any static host or CDN,
open them on a laptop, phone, or tablet, and connect the app directly to the
model and storage providers you choose.

Airship keeps the browser boundary honest:

- prompts go straight from your browser to the provider you connected;
- durable state is encrypted in the browser before it leaves the page;
- provider credentials stay in page memory;
- local models stay on the current machine;
- the browser does not pretend to have host-root access, background daemons, or
  hardware isolation for its own plaintext.

## What Airship is for

- **Chat in parallel.** Multiple conversations can stream at once. Global UI
  actions stay responsive while one session is busy.
- **Switch models lightly.** Each conversation records the exact provider and
  model that produced every turn. Changing a session's model is an in-place
  override for the next turn, not a hidden fork.
- **Use any provider.** One **Providers** surface covers OpenAI, Anthropic,
  xAI, Chutes, custom OpenAI-compatible endpoints, and local Ollama or
  LM Studio.
- **Let the agent work.** The runtime combines chat, workspace tools,
  approvals, memory/context retrieval, and recursive PRIME subagents.
- **Code and research in one place.** Airship includes a workspace editor,
  browser Git, a terminal, execution packs, and session traces you can inspect.
- **Choose your own storage rung.** Start in ephemeral page memory. Move up to
  encrypted Local Device storage, Google Drive, S3-compatible storage, or
  Walrus only when you want durability.

## Storage ladder

1. **Ephemeral** — page memory only.
2. **Local Device** — encrypted OPFS/IndexedDB on this device.
3. **Google Drive** — client-encrypted app-scoped storage.
4. **S3-compatible Vault** — direct browser SigV4 to your bucket.
5. **Walrus** — immutable encrypted blobs.

Every durable rung stores ciphertext, not plaintext. You own the workspace keys.

## Quickstart

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
# open http://127.0.0.1:4173
```

Then open **Providers** and connect one of these:

| Provider | Transport | Default endpoint |
| --- | --- | --- |
| OpenAI | direct browser API | `https://api.openai.com/v1` |
| Anthropic | direct browser API | `https://api.anthropic.com` |
| xAI | direct browser API | `https://api.x.ai/v1` |
| Chutes | OpenAI-compatible | `https://llm.chutes.ai/v1` |
| Ollama | loopback local | `http://127.0.0.1:11434` |
| LM Studio | loopback local | `http://127.0.0.1:1234` |
| Custom | OpenAI-compatible | your base URL |

For cloud providers, paste an API key. For local providers, connect the
loopback server. Airship keeps inference credentials in page memory and does
not write them to storage, URLs, or logs.

## Honest browser boundary

A browser can host a fast agent loop, a real virtual workspace, encrypted state,
streaming inference, and sandboxed execution packs.

A browser cannot safely claim:

- arbitrary host shell or filesystem access;
- reliable work after the OS suspends the tab;
- secrecy from your own OS, browser, extensions, or DevTools; or
- stronger remote-provider guarantees than the client can independently verify.

Airship therefore uses only two inference boundary labels:

- **`provider-tls`** — a remote provider received the turn over TLS;
- **`loopback-local`** — the turn stayed on the current machine.

See [THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full trust model.

## Architecture guide

Start here:

- [CANON.md](docs/CANON.md) — current product definition and scope
- [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) — user jobs and required behavior
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — runtime layering and data flow
- [THREAT_MODEL.md](docs/THREAT_MODEL.md) — assets, boundaries, and claim rules
- [INFERENCE_PROVIDER_REGISTRY.md](docs/INFERENCE_PROVIDER_REGISTRY.md) —
  provider connection and session rules
- [PROTOCOLS.md](docs/PROTOCOLS.md) — stable event and storage shapes
- [PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) — release gates and
  external launch work
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — serving the static build
- [LOCAL_FULL_SYSTEM_LAB.md](docs/LOCAL_FULL_SYSTEM_LAB.md) — reproducible local lab
- [EXTENSION_BRIDGE.md](docs/EXTENSION_BRIDGE.md) — optional companion extension
- [PRIME.md](docs/PRIME.md) — the default recursive engine
- [SIMPLIFICATION.md](docs/SIMPLIFICATION.md) — what the provider-neutral
  simplification removed, and why

Historical Chutes-era and pre-simplification documents live in
[docs/archive/](docs/archive/).

## Develop

```bash
npm ci
npx playwright install chromium   # once, for browser gates
npm run dev
npm run test
npm run check
npm run build
npm run preview
```

Useful optional flows:

```bash
npm run lab:start
npm run lab:status
npm run lab:test
npm run lab:stop
```

```bash
npm run test:e2e
npm run test:e2e:master
npm run test:e2e:static-host
npm run test:e2e:portability
npm run test:e2e:google-drive
```

## Design lineage

Airship takes behavioral inspiration from Hermes Agent and implementation ideas
from `sirouk/claw-code` and `sirouk/claude-code-rs`, but it is a clean,
browser-first design rather than a source fork. See [LINEAGE.md](docs/LINEAGE.md).

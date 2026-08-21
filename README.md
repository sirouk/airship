# Airship

**One static PWA. Any device. Any model. Your keys.**

Airship is an open-source agent workbench that runs in your browser. There is
no Airship backend. You can host the built files on any static host or CDN,
open them on a laptop, phone, or tablet, and connect the app directly to the
model and storage providers you choose.

Airship keeps the browser boundary honest:

- prompts go straight from your browser to the provider you connected;
- state Airship makes durable in a Vault destination is encrypted in the browser
  before it leaves the page;
- two paths are plaintext on purpose, and each says so where you choose it: a
  folder you open on this device is read and written in place, and a readable
  work bundle is ordinary JSON that anyone holding the file can read;
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
  approvals, memory/context retrieval, and recursive PRIME subagents. Each
  conversation carries one of three approval modes — **Ask First**,
  **Auto Approve**, **Full Access** — chosen in the composer and journaled with
  every decision.
- **Code and research in one place.** Airship includes a workspace editor,
  browser Git, a terminal, execution packs, and session traces you can inspect.
- **Choose when state becomes durable.** Start in ephemeral page memory. Move
  to encrypted Local Device storage, or to Google Drive when the static build
  has a Google OAuth client configured.
- **Open a folder on this device.** Chromium browsers can grant Airship one
  folder of your own. Airship reads and writes those files where they already
  are, keeps no copy, and reviews every non-read tool call that names them in
  *every* approval mode, because such a write cannot be undone.
- **Move work between devices.** *All conversations* → **Move work** writes one
  file holding the conversations you pick. A conversation that arrives in a file
  is readable here and continues by **Fork**: a file grants this device no
  approval mode and no model route.

## Storage ladder

The Vault selector offers two levels in a stock build:

1. **Ephemeral** — page memory only. Your writing dies with the tab. One line
   per conversation stays in this browser — an internal id, the profile, a
   message count, a timestamp, the posture — so a return can tell you something
   was not kept. The Vault route can erase it.
2. **Local Device** — encrypted OPFS/IndexedDB on this device.

A third level, **Google Drive** (client-encrypted, app-scoped), is offered only
when the build carries a real Google OAuth *Web* client ID in
`VITE_GOOGLE_CLIENT_ID`. Without one the option is not shown and cannot be
selected, so a default `npm run dev` build compares two options, not three.

A folder you open on this device is a Workspace tier, not a Vault level: it
holds your own files where they already are, in the clear, and cannot hold the
journal, the profile catalog or the session records.

The repository also carries an S3-compatible object-store adapter with a
Cognito short-lived-credential reference, and a Walrus immutable-blob transport.
None of them reaches a stock build. The S3 adapter is imported only under
`VITE_AIRSHIP_ENABLE_LOCAL_LAB=1`, for the loopback MinIO development lab, and
the release gate fails any stock artifact that carries its request signing. The
Walrus transport is not wired into a product path at all. Treat both as
repository material for a host to compose and qualify, not as shipped
destinations.

Every connected durable Vault destination stores ciphertext, not plaintext. You
own the workspace keys. An attached device folder and a readable work bundle are
not Vault destinations and are not encrypted; both say so at the point of
choice.

## Quickstart

Requires Node.js 22.13 or newer (`engines` in `package.json`).

```bash
npm ci
npm run dev
# open http://127.0.0.1:4173
```

`npm run dev` and `npm run preview` bind `127.0.0.1:4173` with `--strictPort`,
so they fail rather than move if that port is busy.

Before any provider is connected, the composer answers with a deterministic
local demo transport, and says so on screen. It is a demo, not a model.

Then open **Providers** and connect one of these:

| Provider | Transport | Default endpoint |
| --- | --- | --- |
| OpenAI | direct browser API | `https://api.openai.com/v1` |
| Anthropic | direct browser API | `https://api.anthropic.com/v1` |
| xAI | direct browser API | `https://api.x.ai/v1` |
| Chutes | OpenAI-compatible | `https://llm.chutes.ai/v1` |
| Ollama | loopback local | `http://127.0.0.1:11434` |
| LM Studio | loopback local | `http://127.0.0.1:1234` |
| Custom | OpenAI-compatible | your base URL |

For cloud providers, paste an API key. For local providers, connect the
loopback server: Airship dials only its shipped allowlist — `127.0.0.1` and
`localhost` on ports 11434-11436 and 1234-1236 — and refuses any other host,
including a private-LAN address, before the request leaves the page. A custom
endpoint must use HTTPS and allow this page through CORS. Airship keeps
inference credentials in page memory and does not write them to storage, URLs,
provider descriptors, or logs.

## Honest browser boundary

A browser can host a fast agent loop, a real virtual workspace, encrypted state,
streaming inference, and sandboxed execution packs.

A browser cannot safely claim:

- arbitrary host shell or filesystem access — one folder you explicitly grant
  through the Chromium File System Access API is not arbitrary access: it is a
  single directory, for this browser profile, revocable, and unavailable in
  browsers without that API;
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
- [WORK_BUNDLE.md](docs/WORK_BUNDLE.md) — the one file that moves work between
  devices, and what a file may not carry
- [PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) — release gates and
  external launch work
- [RELEASE_GATE.md](docs/RELEASE_GATE.md) — what the static release gate blocks
  on, and the byte ceilings it enforces
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — serving the static build
- [LOCAL_FULL_SYSTEM_LAB.md](docs/LOCAL_FULL_SYSTEM_LAB.md) — reproducible local lab
- [EXTENSION_BRIDGE.md](docs/EXTENSION_BRIDGE.md) — optional companion extension
- [PRIME.md](docs/PRIME.md) — the default recursive engine
- [SIMPLIFICATION.md](docs/SIMPLIFICATION.md) — what the provider-neutral
  simplification removed, and why

Historical Chutes-era and pre-simplification documents live in
[docs/archive/](docs/archive/).

## Community and open source

- [LICENSE](LICENSE)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)
- [Bug report template](.github/ISSUE_TEMPLATE/bug.yml)
- [Feature request template](.github/ISSUE_TEMPLATE/feature.yml)
- [Pull request template](.github/pull_request_template.md)

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

`npm run check` is the required gate. It runs both typechecks, the static
security check, `npm run test` (a lab build) and `npm run test:stock` (a stock
build), the extension package, the static build, the release gate, and the
mobile browser gate. Its browser step starts servers on `127.0.0.1:4173` and
`127.0.0.1:4174`, so free those ports first.

The loopback development lab is opt-in and needs Docker with Compose. It is
composed into a build only by `VITE_AIRSHIP_ENABLE_LOCAL_LAB=1`, which
`npm run lab:start` sets for the dev server it owns; a stock build contains no
part of it.

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

# Airship browser-extension bridge

Some providers cannot be reached from a page at all. This document specifies the
optional extension that carries those exchanges, the exact boundary it enforces,
and what Airship is allowed to claim when it is absent.

## Why an extension exists at all

CORS is enforced by the browser's network stack, beneath everything running in a
tab. Measured against `https://auth.x.ai/oauth2/device/code` from a page origin:

| request | result |
|---|---|
| `fetch(mode: "cors")` | `TypeError: Failed to fetch` |
| `fetch(mode: "no-cors")` | `{ type: "opaque", status: 0, bodyLen: 0 }` |

The `no-cors` request is genuinely sent and the response is genuinely
unreadable. Every in-page runtime shares that stack, so none of them changes the
outcome: WebAssembly has no network API and calls `fetch`; Pyodide's HTTP
shims call `fetch`; a Service Worker's own `fetch` is bound by the same rules and
receives the same opaque response; WebContainer has no raw sockets. A relay
written in any of them would be a relay that cannot read its own replies.

Anthropic additionally rejects browser-shaped token requests by `User-Agent`
(`Mozilla/5.0` → `429`, `axios/1.7.9` → `400`, i.e. reaching code validation).
`User-Agent` is a forbidden header name, so no page script can satisfy it.

An extension background worker is the mechanism browsers explicitly sanction for
cross-origin access, granted by `host_permissions` and reviewable by the user.
Airship Companion also exposes two strictly separate, optional services: a
ciphertext-only acceleration cache and bounded background hashing/vector
ranking. Neither service handles provider credentials, and neither is a backend.

## Provider matrix

| provider | Airship account authorization | transport | extension role |
|---|---|---|---|
| Chutes | Available only with a reviewed Airship Browser/native PKCE registration | direct E2EE | not required |
| OpenAI | No reviewed third-party Airship OAuth grant is published; UI remains unavailable | API-key traffic is browser-direct | install hub only; no permission is manufactured |
| xAI | No reviewed third-party Airship OAuth grant is published; UI remains unavailable | bridge is technically ready for fixed xAI OAuth/API hosts | transport only; a future approved controller may use it |
| Anthropic | No reviewed third-party Airship OAuth grant is published; UI remains unavailable | bridge is technically ready where `User-Agent` rewriting is live | transport only; Safari cannot provide the rewrite |
| Ollama / LM Studio | no account authorization | direct loopback | not required |

API-key paths are unchanged and never require the extension. Anthropic API keys
keep using `anthropic-dangerous-direct-browser-access` directly from the page.
An installed relay is not evidence that a provider authorized Airship, so the UI
does not offer a provider OAuth control from relay presence alone.

## Transport

A content script on the Airship origin relays `window.postMessage` to the
extension background worker. `externally_connectable` is deliberately **not**
used: it is Chromium-only, and `postMessage` plus a content script is the one
shape that works on Chromium, Firefox, and Safari alike.

The content script holds **one long-lived `runtime.connect` port** per page
rather than a `sendMessage` per request: a streamed exchange emits many messages
under one id, which a request/response call cannot carry. When that port drops —
a background worker can be torn down at any moment — every id still outstanding
on it is answered with an explicit `bridge-disconnected` error rather than left
waiting.

```
page  --postMessage-->  content script  --port.postMessage-->  background
page  <--postMessage--  content script  <--port.onMessage----  background
```

### Envelope

```ts
type BridgeRequest = Readonly<{
  airshipBridge: 1;          // protocol version, exact
  from: "page";              // direction marker, mandatory (see below)
  id: string;                // page-generated, unique per request
  kind: "hello" | "fetch" | "cancel";
  provider?: "xai" | "anthropic";
  path?: string;             // allowlisted absolute URL
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  stream?: boolean;
}>;
```

`from` is mandatory in both directions (`"page"` outbound, `"extension"` on every
reply). `window.postMessage` delivers a page's own message back to the page, so
without a direction marker a `hello` request and a `hello` reply are the same
message. `cancel` ends an exchange the page has stopped listening for; it is
answered with silence, not a terminator.

`hello` returns the extension version and the providers it will carry. Absence of
a reply within a bounded deadline means **no extension**; that is a fail-closed
`unavailable`, never an assumption of presence.

Streaming responses are delivered as ordered `chunk` messages carrying the same
`id`, terminated by exactly one `end` or `error`.

### Presence memoization

The page-side client (`src/inference/bridge/client.ts`) does not re-prove
presence on every request. One `hello` result gates requests for
`presenceTtlMs` — **30 s**, in `src/inference/bridge/protocol.ts` — after which
the next request re-probes.

The bound on that staleness is explicit: the memo lives in one client instance,
it is **never persisted**, and it does not survive a reload. Presence is still a
live observation per page load; it is simply not re-observed between two requests
seconds apart. Nothing about the memo can manufacture presence — a client with no
memo probes, and a probe with no answer is `unavailable`.

The extension's own capability observation has a matching 30 s TTL on the worker
side, for the same reason and with the same fail-closed default: a browser can
grant host access while the worker is already running.

## Boundary the extension enforces

These are the rules that make the extension safe to install. An extension that
relayed arbitrary requests would be a general-purpose CORS-bypass weapon for any
page that could talk to it.

1. **Fixed destination allowlist, compiled in.** Only these exact origins and
   path prefixes are ever fetched:
   - `https://auth.x.ai/oauth2/`
   - `https://api.x.ai/v1/`
   - `https://claude.ai/oauth/`
   - `https://platform.claude.com/v1/oauth/`
   - `https://api.anthropic.com/v1/`

   Anything else is refused without a network call. There is no
   caller-supplied host, no template, and no redirect following to a
   non-allowlisted origin.
2. **Fixed caller allowlist, at origin granularity.** The content script is
   injected only on the registered Airship match patterns, and the background
   worker re-checks the sender's frame URL, reported origin and frame id — a
   sender whose browser did not identify the frame is refused rather than
   assumed to be the top one.

   State the boundary as the browser enforces it: the **origin**. The
   `/airship/` path prefix narrows injection, not trust. On GitHub Pages,
   `https://sirouk.github.io/other-project/` is same-origin with Airship and can
   script the Airship window directly, so the effective caller allowlist is the
   whole `sirouk.github.io` origin. Only serving Airship from an origin of its
   own makes the path a boundary.
3. **`credentials: "omit"` on every relayed request.** Without this the
   extension could ride the user's logged-in `claude.ai` cookies. The bridge
   carries only credentials the page explicitly supplies.
4. **Header allowlist.** Only headers the protocols require are forwarded
   (`authorization`, `content-type`, `accept`, `anthropic-version`,
   `anthropic-beta`, `user-agent`, `x-app`). Unknown headers are dropped.
5. **No credential storage.** The relay holds no tokens and no provider request
   or response is written durably. The page owns credentials in memory.
   Separately, the companion cache is disabled by default and accepts only
   caller-declared encrypted Airship pages addressed by opaque identifiers. It
   has per-record, byte, and entry ceilings, verifies SHA-256 on read, evicts
   least-recently-used pages, and can be cleared from the popup. The Vault
   remains authoritative.
6. **Bounded everything.** Request and response byte ceilings, a wall-clock
   deadline, and a concurrent-request cap, mirroring the runtime packs.

   The cap is enforced at **admission**, before the worker awaits anything, so
   it binds against requests dispatched together and not only against requests
   that arrive one at a time. The extension's cap is 4 and the page client's is
   8, so the extension is the binding one: a page that exceeds it gets an
   explicit `too-many-requests` error, not a silently queued request.
   Handshakes draw on a separate budget, because a refused `hello` is
   indistinguishable from an absent extension and a busy bridge must never
   report itself missing.

7. **The destination path is checked as a path.** Only unreserved characters
   and `/` are allowed in it, so percent escapes (`%2f`, and `%25`, which is one
   decode away from spelling one) and `;` path parameters are refused — shapes
   that survive URL normalization and can then be resolved off the approved
   prefix by the origin's own router. The **query** is deliberately not
   restricted: it cannot move the request off the path prefix, and an OAuth
   `redirect_uri` legitimately carries `%2F`.

## Companion cache and compute protocol

The companion channel uses a separate `{ airshipCompanion: 1, from, id, … }`
envelope and a separate extension port. Relay messages can never enter its
IndexedDB store. The page can ask for:

- `hello`: live cache/compute capability evidence;
- `cache get|put|remove|list|stats`: one opaque namespace, one opaque page key,
  and base64 ciphertext. `put` must explicitly set `ciphertext: true`;
- `compute sha256`: bounded byte hashing; and
- `compute cosine-top-k`: bounded Float32 candidate ranking.

The compute lane moves work off the Airship interface thread. It uses the same
browser machine and makes no unmeasured GPU, native-code, or throughput claim.
Airship selects the extension cache only after a live `hello` reports that the
person enabled it; otherwise it falls through to OPFS, page-origin IndexedDB,
then page memory.

## Browser coverage

| browser | source support | distribution state | note |
|---|---|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi, Arc | MV3 service worker, Chrome 116+ | deterministic unpacked package ready; store signing pending | one Chromium build |
| Firefox desktop | MV3 event page, Firefox 128+ | temporary package ready; AMO signing pending | same source, Gecko manifest |
| Firefox for Android | same Gecko source | AMO listing/collection required | mobile extension support varies by Firefox channel |
| Safari desktop, iOS, iPadOS | MV3 non-persistent background page, Safari 16.4+ | converter source ready; Xcode wrapper and Apple signing pending | Anthropic relay unavailable without header rewriting |
| Chrome for Android | **cannot host extensions** | not applicable | Airship remains fully usable without companion services |

### The Safari `User-Agent` limitation

Safari offers an extension neither declarativeNetRequest header rewriting nor
blocking `webRequest`. `User-Agent` is a forbidden header name for `fetch`, so
on Safari there is no mechanism at all by which the worker can set it.

The consequence follows directly from the provider matrix above: Anthropic's
OAuth token host rejects browser user agents, so on Safari the extension
**cannot carry Anthropic** and `hello` reports it unavailable with that reason.
xAI needs no override and works normally. Anthropic **API keys** are unaffected —
they never use the bridge.

This is not inferred from the browser's name. The Safari manifest requests no
rewrite permission because Safari has none to grant, and the worker still
reports what it observed: it tried to install an override, observed none, and
says so. A future Safari that gained a rewrite mechanism would be reported as
carrying Anthropic without a code change.

Airship must never imply the extension is available where it is not. On a
browser that cannot host it, or cannot carry a given provider on it, the
affected providers render as honestly unavailable with the reason stated, and
every other provider keeps working.

## What Airship may claim

- With the bridge absent: Chutes, local providers, and explicit supported
  API-key routes retain their own availability. Provider OAuth is not inferred.
- With the bridge present: the capability record names the extension version
  actually returned by `hello`, and only the providers `hello` said it will
  transport — so on Safari, an installed bridge still leaves Anthropic relay
  transport unavailable with the `User-Agent` reason. This does not make an
  OAuth controller or provider grant available. Presence is a live observation per page load,
  memoized for at most `presenceTtlMs` (30 s) within that page load and never
  persisted; it is never a cached assumption across loads.
- The bridge changes *reachability*, not trust. Traffic still terminates at the
  vendor under provider TLS, so `transportBoundary` stays `provider-tls` and no
  attestation claim is created or upgraded by installing the extension.
- Background compute is an execution-lane observation, not proof that work is
  faster. The encrypted cache is acceleration only, not a source of truth.

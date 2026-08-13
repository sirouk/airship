# Client-side Node egress engine

Airship ships a **client-local CORS proxy** as part of the web client. It is not
an external proxy service and it does not require an Airship backend. When a
page refuses a browser cross-origin read, Airship boots the same Node.js
WebContainer runtime used by `execute_node_project`, mounts a reviewed relay
program into a private scratch workspace, and performs the HTTP(S) request from
that Node process. Browser CORS is not enforced on Node's `http`/`https` client.

The agent-facing contract is deliberately simple: **use `fetch_url` for all web
egress**. The tool owns the routing ladder and reports the route that answered.
The model should not write ad-hoc probe scripts or conclude that a direct CORS
failure means the URL is unreachable.

## Request ladder

With the default Agent Profile setting and `via: "auto"`, `fetch_url` does the
following:

1. Lazily activate the Node.js WebContainer pack and run the shipped core
   `http`/`https` relay. Transient resets are retried with a bare compatibility
   request under the same deadline.
2. If the client Node route cannot run or answer, try a credential-free direct
   browser `GET` as the compatibility fallback.
3. Return a successful textual response with `via: "node-webcontainer"` or
   `via: "browser-direct"`, or one failure envelope listing every route and
   transport-attempt count.

Every Agent Profile exposes **Web requests** under Profile boundaries. **Client
Node first** is the default and applies automatically to ordinary web fetching
(and to web-search adapters using this shared policy). **Browser only** is the
explicit opt-out; it never activates Node and remains subject to browser CORS.

The optional selector exists for diagnosis and explicit control:

```json
{ "url": "https://example.com/page", "via": "auto" }
{ "url": "https://example.com/page", "via": "node-webcontainer" }
{ "url": "https://example.com/page", "via": "browser" }
```

`node-webcontainer` forces the client-local proxy and skips the browser request.
`browser` forbids escalation. Existing callers need no changes because `auto`
is the default.

## What is shipped

- `src/tools/egress/node-egress-script.ts` embeds the CommonJS relay mounted as
  `/workspace/egress-relay.cjs` in a private `MemoryWorkspace`.
- `src/tools/egress/client-node-egress.ts` owns lazy activation, complete-run
  serialization, workspace reconciliation, digest verification, and scratch
  cleanup.
- `src/tools/network-tools.ts` owns the direct-to-Node ladder, provenance, and
  agent-visible tool description.

The relay supports HTTPS and HTTP loopback targets, follows at most five
redirects, decompresses gzip/deflate/Brotli, omits credentials, rejects URL
userinfo, applies a 30-second network deadline, and stages exact response bytes.
The staged bytes cross the reviewed WebContainer workspace-delta channel, carry
an independently checked SHA-256, and are erased immediately after the tool
reads them. They never enter the user's workspace.

## Bulldozer capacity and the real boundary

This implementation does **not** impose the earlier 192 KiB stdout-envelope
limit. Bulk bytes do not travel through stdout at all. The JSON process envelope
contains only metadata and a 16 KiB preview; the body uses Airship's reversible
binary workspace codec and the full **8 MiB per-call** WebContainer delta
channel. `fetch_url` uses the full channel by default rather than silently
restoring the old half-MiB cap. The default is equivalent to:

```json
{
  "url": "https://example.com/large-page",
  "maxBytes": 8388608
}
```

Callers can lower `maxBytes` for a deliberately smaller read. Eight MiB is a
runtime transport invariant, not a crawler policy: the reviewed
Node adapter refuses workspace deltas above that size. Results name
`truncated: true` when the source exceeds the requested/available channel rather
than silently claiming completeness. Larger resources should use multiple
range/URL requests or a workspace-oriented download/import tool instead of
forcing unbounded bytes into one model tool result.

## Browser and provider boundary

The engine is browser compute but its WebContainer runtime is delivered by
StackBlitz. It requires:

- a browser document in a secure context (HTTPS or loopback);
- Airship's shipped COOP/COEP headers and `crossOriginIsolated`;
- `SharedArrayBuffer`, WebAssembly, and Worker support;
- successful WebContainer provider boot and whatever outbound egress that
  provider permits for the requested host.

Airship therefore never promises that every network operator will route every
host. It does promise that CORS alone is no longer the stopping point: the tool
tries the client Node route, records whether it booted, and exposes transport
errors such as `ECONNRESET`, `ENOTFOUND`, or timeout without inventing content.
The relay retries transient resets up to three times under one deadline and uses
a bare Node request profile after the first negotiated request, covering the
same compatibility fallback an agent might otherwise rediscover with ad-hoc
`https.get`. `fetch_url` reports the transport-attempt count. Agent instructions
make this the sole web-request path: they must not activate WebContainer or use
execution tools merely to reproduce the relay. After retries are exhausted,
they retry `fetch_url` once or choose another source/canonical REST endpoint.
A browser that cannot activate WebContainer still retains direct CORS-enabled
fetches and receives an explicit `node-egress-unavailable` attempt.

## Verification

The test suite executes the exact embedded relay under Node against a live
loopback fixture. It covers plain text, gzip, redirects, redirect loops, body
truncation with digest verification, HTTP error passthrough, timeout, invalid
schemes, credential-bearing URLs, and the tool ladder's routing/provenance.

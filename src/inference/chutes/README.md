# Chutes browser inference transport

`ChutesInferenceTransport` implements Airship's `InferenceTransport` with the
Chutes E2EE v1 wire protocol and opaque Rust/WASM key contexts.

```ts
const transport = new ChutesInferenceTransport({
  apiKey: () => obtainShortLivedChutesToken(),
  attestationMode: "required", // default
  attestationGate,
});
```

The transport:

- discovers only models with `confidential_compute === true`;
- sends the complete canonical system prompt, message/tool history, and OpenAI
  function schemas inside the encrypted payload;
- bounds and deduplicates one-use discovery nonces;
- isolates each caller's cancellation while model and E2EE discovery requests
  are shared; the underlying fetch is cancelled only after its final waiter leaves;
- keeps timeout and cancellation active through response-body streaming;
- enforces a no-progress stream timer and bounded SSE records;
- accepts both the deployed inner-SSE byte stream and the Chutes v1 reference
  client's directly authenticated JSON-record form, including records split at
  arbitrary encrypted boundaries;
- incrementally emits text, assembles fragmented OpenAI tool calls, and frees
  every opaque WASM request/stream context;
- requires an authenticated OpenAI finish reason before an outer `[DONE]` or
  response EOF can finalize the turn, and never blocks completion on a remote
  stream-cancellation handshake;
- retries once only for an exact, recognized nonce-rejection response.

## Attestation modes

`required` fails before request encryption/invocation unless `AttestationGate`
returns a fresh receipt binding the exact discovered chute, instance, and E2EE
public key. `optional` may continue and produces an
`encrypted-unattested` receipt with the verifier failure recorded as an
unavailable endpoint-key claim. When the gate acquired and evaluated exact
endpoint evidence but could not promote it, optional mode retains only bounded
claim summaries and the evidence digest (freshness, endpoint key, CPU/GPU, and
runtime policy). Raw quotes, certificates, nonces, and endpoint keys are not
copied into the conversation receipt. Required mode still fails before invoke
unless the exact endpoint produces a fresh verified receipt.

An endpoint receipt never upgrades the `model` or `conversation` claims. Chutes
v1 has no model-artifact proof, header/AAD binding, stream sequence field, or
authenticated final transcript record. Completed receipts state these gaps.

The verified CPU path runs `dcap-qvl` locally in deferred Rust/WASM and requires
an advisory-free `UpToDate` aggregate, QE, and platform status. It verifies the
Intel production chain, CRLs, QE Identity, collateral time windows, debug
prohibition, quote signature, and the fresh nonce + selected ML-KEM key binding.
The Chutes MRTD/RTMR allowlist is a separate local match against the public
`/servers/tee/measurements` feed. That feed is HTTPS-authenticated but is not a
signed transparency artifact, so Airship does not describe it as independent
provider-policy authorization. GPU evidence likewise remains `matched`, not
verified, until caller-nonce binding and NVIDIA RIM/revocation evaluation are
available.

## Build crypto

```bash
node scripts/build-e2ee.mjs
```

The script builds `crates/chutes-e2ee-wasm` with `wasm-pack` and writes the
checked browser ABI and WASM artifact to `src/inference/chutes/wasm`. It rejects
native or otherwise unresolved WASM imports so a release cannot silently ship
an artifact that only fails when loaded by a browser.

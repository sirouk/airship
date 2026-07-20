# Chutes E2EE WASM

Bounded, wire-compatible Chutes E2EE v1 crypto for Airship. The crate keeps
response decapsulation material behind opaque `wasm-bindgen` contexts instead
of returning a raw `response_sk` to JavaScript.

## JavaScript API

```ts
const request = build_e2ee_request(instance.e2e_pubkey, JSON.stringify(payload));
const encryptedBody: Uint8Array = request.take_blob(); // one shot

// Non-stream response (consumes the response secret, success or failure):
const plaintextJson: string = request.decrypt_response(responseBytes);

// Or stream response (also consumes the request context's response secret):
const stream = request.open_stream(e2eInitBase64);
const plaintextSseLine: string = stream.decrypt_chunk(e2eChunkBase64);
stream.finish(); // immediately destroys the stream key

// wasm-bindgen objects should also be explicitly released when no longer used.
stream.free();
request.free();
```

Exact exports:

- `build_e2ee_request(e2e_pubkey_b64, payload_json) -> E2eeRequestContext`
- `E2eeRequestContext.take_blob() -> Uint8Array`
- `E2eeRequestContext.decrypt_response(response_blob) -> string`
- `E2eeRequestContext.open_stream(mlkem_ct_b64) -> E2eeStreamContext`
- `E2eeRequestContext.consumed: boolean`
- `E2eeRequestContext.blob_taken: boolean`
- `E2eeStreamContext.decrypt_chunk(enc_chunk_b64) -> string`
- `E2eeStreamContext.finish() -> void`
- `E2eeStreamContext.finished: boolean`
- `E2eeStreamContext.chunks_decrypted: number`

Errors crossing the WASM boundary are JavaScript `Error` objects named
`ChutesE2eeError`. They have a stable `code` property such as
`AUTHENTICATION_FAILED`, `RESPONSE_CONTEXT_CONSUMED`, or
`STREAM_NONCE_REUSE`. A failed response-decrypt or stream-open attempt consumes
the response secret deliberately; construct a fresh request and use a fresh
server discovery nonce before retrying.

## V1 wire format

The format intentionally matches the existing Chutes browser client:

- Request: `ML-KEM-768 ciphertext || 12-byte nonce || ChaCha20-Poly1305 data`
- Non-stream response: the same framing, with gzip inside the AEAD
- Stream init: base64 ML-KEM-768 ciphertext
- Stream record: base64 `12-byte nonce || ChaCha20-Poly1305 data`
- HKDF-SHA256 domains: `e2e-req-v1`, `e2e-resp-v1`, `e2e-stream-v1`
- AEAD associated data is empty

The response private key is retained as the ML-KEM 64-byte seed. Both ML-KEM
key objects and retained byte buffers are zeroized on consume/drop. Plaintext
still necessarily exists in Rust/WASM and JavaScript memory while in use; WASM
is not a hardware TEE or a secure-erasure boundary.

## Bounds

- Request JSON: 8 MiB
- Emitted request frame: 16 MiB
- Non-stream response frame: 64 MiB
- Decompressed non-stream response: 64 MiB
- Decoded stream record: 4 MiB
- Authenticated stream records per context: 131,072

Stream contexts reject reuse of a nonce after a record authenticates. V1 has no
wire sequence number or authenticated final record, so the client cannot prove
record order, completeness, or an outer SSE `[DONE]` marker without breaking
compatibility.

## Explicitly unresolved for v2

This crate does **not** verify TEE attestation or authenticate the discovered
instance public key. Chutes v1 also does not bind routing headers, the discovery
nonce, model/chute identity, request ID, or stream sequencing as AEAD associated
data. Those properties require a negotiated v2 descriptor and wire protocol;
they must not be silently added to v1 because doing so would break deployed
servers.


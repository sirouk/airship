# Walrus storage in Airship

Walrus is an optional immutable blob transport in Airship's encrypted storage
ladder.

## Product role

Use Walrus when you want immutable encrypted blob storage rather than a mutable
primary vault. Airship encrypts objects locally before upload and treats Walrus
as a blob transport, not as the session authority.

It is a host-composed source module rather than a stock Vault choice:

```ts
import { WalrusBlobTransport } from "../src/storage/walrus-blob-transport";

const blobs = new WalrusBlobTransport({
  publisherUrl: "https://publisher.example/",
  aggregatorUrls: ["https://aggregator.example/"],
});
```

The host must review those HTTPS origins and provide any short-lived upload
`grantIssuer`; Airship does not mint wallet authority in the browser.

## What Walrus is good for

- immutable encrypted exports;
- replicated blob distribution;
- large object storage where object IDs are already opaque.

## What Walrus is not

- the mutable session-head authority;
- a replacement for compare-and-swap storage when the product needs a current
  encrypted head;
- a plaintext trust boundary.

## Claim rules

Walrus does not receive plaintext through Airship's storage path, but it can
still observe blob IDs, sizes, timing, access patterns, and retention details.
Airship therefore treats Walrus as encrypted blob storage, not as a secrecy
claim about surrounding metadata.

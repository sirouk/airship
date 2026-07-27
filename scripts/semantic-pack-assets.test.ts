import { describe, expect, it } from "vitest";
import { semanticPackResponseHeaders } from "./semantic-pack-assets";

describe("semantic pack response policy", () => {
  it("keeps nested ORT workers isolated and large verified assets cacheable", () => {
    expect(semanticPackResponseHeaders(
      "/semantic-pack/v1/runtime/ort-wasm-simd-threaded.asyncify.mjs",
      47_396,
    )).toEqual({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": "47396",
      "Content-Type": "text/javascript; charset=utf-8",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    expect(semanticPackResponseHeaders("/semantic-pack/v1/model.onnx", 24_448_010))
      .toMatchObject({
        "Content-Length": "24448010",
        "Content-Type": "application/octet-stream",
        "Cross-Origin-Embedder-Policy": "credentialless",
      });
  });
});

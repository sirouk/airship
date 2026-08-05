import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  airshipSemanticPackAssets,
  isSemanticPackPrepared,
  readVerifiedSemanticPack,
  semanticPackBuildAssets,
  semanticPackPublicPrefix,
  semanticPackResponseHeaders,
} from "./semantic-pack-assets";

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

  it("declares the optional pack available only when every pinned file matches its byte and hash pins", () => {
    const root = mkdtempSync(join(tmpdir(), "airship-semantic-pack-"));
    const assets = {
      "runtime/transformers.web.js": { bytes: 4, sha256: digest("pack") },
      "models/example/model.onnx": { bytes: 3, sha256: digest("onn") },
    } as const;
    try {
      const runtime = resolve(root, "runtime/transformers.web.js");
      mkdirSync(dirname(runtime), { recursive: true });
      writeFileSync(runtime, "pack");
      expect(isSemanticPackPrepared(root, assets)).toBe(false);

      const model = resolve(root, "models/example/model.onnx");
      mkdirSync(dirname(model), { recursive: true });
      writeFileSync(model, "onn");
      expect(isSemanticPackPrepared(root, assets)).toBe(true);
      const verified = readVerifiedSemanticPack(root, assets);
      expect(verified?.map(({ relativePath }) => relativePath)).toEqual(Object.keys(assets));
      expect(typeof airshipSemanticPackAssets(verified).generateBundle).toBe("function");
      expect(semanticPackBuildAssets(verified ?? []).map(({ fileName }) => fileName)).toEqual([
        "semantic-pack-state.json",
        "semantic-pack/v1/runtime/transformers.web.js",
        "semantic-pack/v1/models/example/model.onnx",
      ]);
      expect(JSON.parse(semanticPackBuildAssets([])[0].source.toString("utf8"))).toMatchObject({
        schema: "airship.semantic-pack-state.v1",
        available: false,
      });

      // A same-size mutation used to pass the build-time availability check and
      // fail only after a browser had downloaded the pack.
      writeFileSync(model, "bad");
      expect(isSemanticPackPrepared(root, assets)).toBe(false);

      writeFileSync(model, "wrong-size");
      expect(isSemanticPackPrepared(root, assets)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps requests through the configured public subpath", () => {
    expect(semanticPackPublicPrefix("/")).toBe("/semantic-pack/v1/");
    expect(semanticPackPublicPrefix("/airship/")).toBe("/airship/semantic-pack/v1/");
    expect(semanticPackPublicPrefix("/airship")).toBe("/airship/semantic-pack/v1/");
  });
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertWithinBudget,
  assertOptionalPacksAreNotPreloaded,
  createReleaseManifest,
  inspectPayload,
  isOptionalExecutionPackPath,
  isOptionalNodeExecutionPackPath,
  isOptionalModelCatalogPath,
  isOptionalWorkspaceWorkbenchPath,
  isOptionalTerminalPath,
  isOptionalSemanticWorkerPath,
  isDeferredCapabilityPackPath,
  serializeReleaseManifest,
} from "./release-gate.mjs";

describe("release gate", () => {
  it("discloses only the embedding origin required by the WebContainer frame", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="referrer" content="origin" />');
    expect(html).not.toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("emits a stable, sorted, explicitly unsigned manifest", () => {
    const artifacts = [
      artifact("z.js", "z"),
      artifact("assets/a.css", "a"),
    ];

    const first = serializeReleaseManifest(createReleaseManifest(artifacts));
    const second = serializeReleaseManifest(createReleaseManifest([...artifacts].reverse()));

    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual({
      schema: "airship.release-manifest.v1",
      hashAlgorithm: "sha256",
      signed: false,
      artifacts: [artifact("assets/a.css", "a"), artifact("z.js", "z")],
    });
    expect(first).not.toMatch(/timestamp|createdAt|generatedAt/iu);
  });

  it("rejects source maps, inline map directives, and actual credential-shaped values", () => {
    expect(inspectPayload("assets/main.js.map", Buffer.from("{}"))).toContain("production source map");
    expect(inspectPayload("assets/main.js.map.br", Buffer.from("compressed"))).toContain("production source map");
    expect(inspectPayload("assets/main.js", Buffer.from("//# sourceMappingURL=data:application/json;base64,e30="))).toContain(
      "sourceMappingURL directive",
    );
    expect(inspectPayload("assets/main.js", Buffer.from(`const value = "cak_${"x".repeat(40)}"`))).toContain(
      "Chutes user credential",
    );
    expect(inspectPayload(`assets/cpk_${"y".repeat(40)}.js`, Buffer.from("export {}"))).toContain(
      "Chutes inference key",
    );
    expect(inspectPayload("assets/main.js", Buffer.from('const help = "cak_ or cpk_"'))).toEqual([]);
  });

  it("fails either raw or compressed budget overruns without echoing payloads", () => {
    expect(() => assertWithinBudget("fixture", { raw: 11, gzip: 5 }, { raw: 10, gzip: 10 })).toThrow(
      /raw/iu,
    );
    expect(() => assertWithinBudget("fixture", { raw: 5, gzip: 11 }, { raw: 10, gzip: 10 })).toThrow(
      /gzip/iu,
    );
    expect(() => assertWithinBudget("fixture", { raw: 5, gzip: 5 }, { raw: 10, gzip: 10 })).not.toThrow();
  });

  it("recognizes only the hashed execution pack and forbids optional-pack preloads", () => {
    expect(isOptionalExecutionPackPath("assets/execution-runtime-pack-Ab_12-CD.js")).toBe(true);
    expect(isOptionalExecutionPackPath("assets/execution-tools-Ab_12-CD.js")).toBe(false);
    expect(isOptionalNodeExecutionPackPath("assets/node-webcontainer-pack-Ab_12-CD.js")).toBe(true);
    expect(isOptionalNodeExecutionPackPath("assets/execution-runtime-pack-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWorkspaceWorkbenchPath("assets/workspace-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWorkspaceWorkbenchPath("assets/workspace-tree-Ab_12-CD.js")).toBe(false);
    expect(isOptionalTerminalPath("assets/terminal-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/terminal-runtime-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSemanticWorkerPath("assets/semantic.worker-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSemanticWorkerPath("assets/semantic-worker-Ab_12-CD.js")).toBe(false);
    expect(isOptionalModelCatalogPath("assets/client-runtime-Ab_12-CD.js")).toBe(true);
    expect(isOptionalModelCatalogPath("assets/telemetry-Ab_12-CD.js")).toBe(true);
    expect(isOptionalModelCatalogPath("assets/client-Ab_12-CD.js")).toBe(false);
    expect(isDeferredCapabilityPackPath("assets/deferred-capabilities-Ab_12-CD.js")).toBe(true);
    expect(isDeferredCapabilityPackPath("assets/connectivity-Ab_12-CD.js")).toBe(false);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/connectivity-Ab12.js">',
    )).not.toThrow();
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/execution-runtime-pack-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/deferred-capabilities-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/node-webcontainer-pack-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/workspace-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/terminal-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/client-runtime-Ab12.js">',
    )).toThrow(/must not preload/iu);
  });
});

function artifact(path, content) {
  const payload = Buffer.from(content);
  return {
    path,
    bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

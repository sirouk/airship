import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_BUDGETS,
  assertNoSimulatedGitRuntime,
  assertWithinBudget,
  assertUnpromotedWasixAbsent,
  assertExclusiveArtifactClassifications,
  assertOptionalPacksAreNotPreloaded,
  createReleaseManifest,
  inspectPayload,
  isOptionalExecutionPackPath,
  isOptionalExecutionEnginePath,
  isOptionalExecutionSupportPath,
  isOptionalExecutionToolsPath,
  isOptionalWasiPreview1WorkerPath,
  isOptionalNodeExecutionPackPath,
  isOptionalWasixJavaScriptPath,
  isOptionalWasixWasmPath,
  isOptionalAgentRuntimePath,
  isOptionalMultimodalPath,
  isOptionalContextPolicyPath,
  isOptionalAgentToolsPath,
  isOptionalModelCatalogPath,
  isOptionalInferenceProviderPath,
  isOptionalChutesOAuthPath,
  isOptionalExtensionObservationPath,
  isOptionalLocalDeviceVaultPath,
  isOptionalWorkspaceWorkbenchPath,
  isOptionalWorkspaceBindingPath,
  isOptionalWorkspaceCodecPath,
  isOptionalRequestFailurePath,
  isOptionalSourceControlPath,
  isOptionalSourceSelectionPath,
  resolveOptionalSourceSelectionDelivery,
  assertDocumentedBudgetMeasurements,
  MEASUREMENT_JUSTIFIED_BUDGETS,
  SOURCE_SELECTION_STORAGE_KEY,
  isOptionalBrowserGitPath,
  isOptionalSessionLibraryPath,
  isOptionalSessionManifestPath,
  isOptionalFavoriteOrderingPath,
  isOptionalSessionForkPath,
  isOptionalCapabilitiesViewPath,
  isOptionalBrowserCapabilityPath,
  isOptionalMemoryViewPath,
  isOptionalMemorySupportPath,
  isOptionalProofSurfacePath,
  isOptionalEvidenceAcquisitionPath,
  isOptionalTerminalPath,
  isOptionalSemanticWorkerPath,
  isDeferredCapabilityPackPath,
  assertForkContractDocumented,
  serializeReleaseManifest,
} from "./release-gate.mjs";

describe("release gate", () => {
  it("ships zero artifacts and zero bytes for the unpromoted WASIX candidate", () => {
    expect(RELEASE_BUDGETS.optionalWasixJavaScript).toEqual({ raw: 0, gzip: 0 });
    expect(RELEASE_BUDGETS.optionalWasixWasm).toEqual({ raw: 0, gzip: 0 });
    expect(() => assertUnpromotedWasixAbsent("JavaScript candidate", [])).not.toThrow();
    expect(() => assertUnpromotedWasixAbsent("JavaScript candidate", ["assets/wasix-pack-A.js"]))
      .toThrow(/must not contain the unpromoted WASIX JavaScript candidate; found 1 artifacts/u);
    expect(() => assertUnpromotedWasixAbsent("engine WASM", ["assets/wasmer_js_bg-A.wasm"]))
      .toThrow(/must not contain the unpromoted WASIX engine WASM; found 1 artifacts/u);
  });

  it("discloses only the embedding origin required by the WebContainer frame", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="referrer" content="origin" />');
    expect(html).not.toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("keeps disposable loopback storage origins out of production policies", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    for (const policy of [html, headers]) {
      expect(policy).not.toContain("http://127.0.0.1:9900");
      expect(policy).not.toContain("http://localhost:9900");
    }
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

  /*
   * A ceiling is only enforced while both sides of the comparison are byte counts.
   * `undefined > limit` is false, so a caller that loses its measurement retires the
   * ceiling and reports a pass — the failure mode that let a pack Vite had inlined be
   * charged zero bytes. Refusing to answer is the only safe answer.
   */
  it("refuses to adjudicate a budget against anything that is not a byte count", () => {
    for (const measurement of [undefined, null, {}, { raw: 5 }, { raw: 5, gzip: "10" }, { raw: -1, gzip: 0 }, { raw: 1.5, gzip: 0 }]) {
      expect(() => assertWithinBudget("fixture", measurement, { raw: 10, gzip: 10 }), JSON.stringify(measurement ?? null))
        .toThrow(/measurement is not a raw\/gzip byte count/u);
    }
    expect(() => assertWithinBudget("fixture", { raw: 5, gzip: 5 }, { raw: 10 })).toThrow(
      /budget is not a raw\/gzip byte count/u,
    );
    // Zero is a real measurement — only the deliberately empty budgets use it.
    expect(() => assertWithinBudget("fixture", { raw: 0, gzip: 0 }, { raw: 0, gzip: 0 })).not.toThrow();
  });

  /*
   * Source selection is ~650 bytes: Vite may emit it as its own chunk or inline it
   * into the one pack that imports it, and neither is a product fact. The delivery
   * has to be describable without inventing a size — a fabricated `raw: 0, gzip: 0`
   * published a measurement no artifact had *and* made the budget line below
   * unconditionally true, so the module could have grown without bound inside its
   * carrier and this suite would have stayed green.
   */
  it("describes an inlined source-selection store without inventing bytes for it", () => {
    const dedicated = { path: "assets/source-selection-Ab_12-CD.js", payload: Buffer.from("export const store = 1;\n") };

    const split = resolveOptionalSourceSelectionDelivery([dedicated], [dedicated.path]);
    expect(split.path).toBe(dedicated.path);
    expect(split.raw).toBe(dedicated.payload.byteLength);
    expect(split.gzip).toBeGreaterThan(0);
    expect(() => assertWithinBudget("Optional source selection", split, RELEASE_BUDGETS.optionalSourceSelection)).not.toThrow();

    // This object is published verbatim as `measurements.optionalSourceSelection`,
    // so its shape is the reported shape: a carrier, and no size attributed to it.
    const inlined = resolveOptionalSourceSelectionDelivery([], ["assets/repository-admission-Ab_12-CD.js"]);
    expect(inlined).toEqual({ inlinedInto: "assets/repository-admission-Ab_12-CD.js" });
    expect(inlined.path).toBeUndefined();
    expect(inlined.raw).toBeUndefined();
    // The carrier's bytes are governed by the carrier's own class ceiling, so this
    // budget has nothing to weigh — and cannot be talked into weighing nothing.
    expect(() => assertWithinBudget("Optional source selection", inlined, RELEASE_BUDGETS.optionalSourceSelection))
      .toThrow(/measurement is not a raw\/gzip byte count/u);
    // The shape this replaced: a zero cleared every ceiling it was handed.
    expect(() => assertWithinBudget("Optional source selection", { raw: 0, gzip: 0 }, RELEASE_BUDGETS.optionalSourceSelection))
      .not.toThrow();

    expect(() => resolveOptionalSourceSelectionDelivery([dedicated, dedicated], [dedicated.path]))
      .toThrow(/at most one optional source-selection chunk; found 2/u);
    expect(() => resolveOptionalSourceSelectionDelivery([], []))
      .toThrow(/exactly one JavaScript pack; found 0/u);
    expect(() => resolveOptionalSourceSelectionDelivery([], ["assets/a.js", "assets/b.js"]))
      .toThrow(/exactly one JavaScript pack; found 2/u);
  });

  /** The fingerprint the gate hunts for has to be the key the store actually writes. */
  it("fingerprints source selection with the durable key its module persists", () => {
    const store = readFileSync(new URL("../src/git/source-selection.ts", import.meta.url), "utf8");
    expect(store).toContain(`"${SOURCE_SELECTION_STORAGE_KEY}"`);
  });

  /*
   * The budget comments are the only place a reviewer can see what a raise bought,
   * and three ceilings were once raised while their comments still recorded the
   * previous build — one of them saying the gzip ceiling "do[es] not move" directly
   * above the constant that moved it. Hold the file to its own prose.
   */
  it("rejects budget comments that contradict or abandon the ceilings they justify", () => {
    const source = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
    expect(() => assertDocumentedBudgetMeasurements(source)).not.toThrow();
    expect(MEASUREMENT_JUSTIFIED_BUDGETS.length).toBeGreaterThan(0);
    for (const name of MEASUREMENT_JUSTIFIED_BUDGETS) expect(RELEASE_BUDGETS[name]).toBeDefined();

    // A figure the ceiling beside it would reject describes a build nobody shipped.
    expect(() => assertDocumentedBudgetMeasurements(source.replace("20,591 B gzip", "23,591 B gzip")))
      .toThrow(/optionalMemoryView: its comment records 23,591 B gzip, above the 21\.00 KiB gzip ceiling/u);
    expect(() => assertDocumentedBudgetMeasurements(source.replace("74,690 B\n  // raw", "94,690 B\n  // raw")))
      .toThrow(/optionalProofSurface: its comment records 94,690 B raw, above the 88\.00 KiB raw ceiling/u);
    // …and a raise cannot be laundered by deleting the number it contradicts.
    expect(() => assertDocumentedBudgetMeasurements(source.replace("measured on this build: 78,628 B raw / 24,795 B gzip", "weighed at 78,628 B and 24,795 B")))
      .toThrow(/optionalWorkspaceWorkbench: its comment no longer records a measured raw\/gzip pair/u);

    /*
     * The gzip ceilings as the review found them: a whole KiB past the smallest step
     * that clears the measurement recorded beside them, which is transfer budget
     * granted by a comment that said nothing about it. (deferredCapabilities is shown
     * at two steps, because its own ceiling is already the justified second step —
     * the pair moves with it, which is the point: this row has to name the ceiling
     * as it stands or it stops testing anything.) Any step
     * beyond the first has to be paid for with the sentence naming what the tighter one
     * would have left — which is why the raw ceilings beside these pass untouched.
     */
    for (const [name, ceiling, granted] of [
      ["optionalMemoryView", "gzip: 21 * 1024", "gzip: 22 * 1024"],
      ["optionalProofSurface", "gzip: 28 * 1024", "gzip: 29 * 1024"],
      ["optionalWorkspaceWorkbench", "gzip: 25 * 1024", "gzip: 26 * 1024"],
      // AMENDED with the ceiling it names: `deferredCapabilities` gzip moved to
      // 126 KiB when the Connection route stopped interviewing people, and that
      // step is the tightest one above its recorded measurement — so the step
      // this row grants without paying for it is now the one past it.
      ["deferredCapabilities", "gzip: 126 * 1024", "gzip: 127 * 1024"],
    ]) {
      const raised = source.replace(new RegExp(`^  ${name}: .*$`, "mu"), (line) => line.replace(ceiling, granted));
      expect(raised, name).not.toBe(source);
      expect(() => assertDocumentedBudgetMeasurements(raised), name).toThrow(
        new RegExp(`${name}: the [\\d.]+ KiB gzip ceiling is above the smallest whole-KiB step`, "u"),
      );
    }
    expect(() => assertDocumentedBudgetMeasurements(source.replace(/^  optionalMemoryView: .*$/mu, "  optionalMemoryViewX: Object.freeze({ raw: 1, gzip: 1 }),")))
      .toThrow(/optionalMemoryView: named as measurement-justified but no such release budget was found/u);
  });

  it("rejects unknown and multiply owned JavaScript artifacts", () => {
    expect(() => assertExclusiveArtifactClassifications(
      ["assets/core-A.js", "assets/unknown-B.js"],
      [{ name: "core", paths: ["assets/core-A.js"] }],
    )).toThrow(/unclassified: assets\/unknown-B\.js/iu);

    expect(() => assertExclusiveArtifactClassifications(
      ["assets/shared-A.js"],
      [
        { name: "core", paths: ["assets/shared-A.js"] },
        { name: "optional", paths: ["assets/shared-A.js"] },
      ],
    )).toThrow(/multiple classes: assets\/shared-A\.js/iu);

    expect(() => assertExclusiveArtifactClassifications(
      ["assets/core-A.js", "assets/optional-B.js"],
      [
        { name: "core", paths: ["assets/core-A.js"] },
        { name: "optional", paths: ["assets/optional-B.js"] },
      ],
    )).not.toThrow();
  });

  it("keeps the deterministic memory-Git fixture out of production JavaScript", () => {
    expect(() => assertNoSimulatedGitRuntime([
      { path: "assets/workspace-adapter-A.js", payload: Buffer.from("real browser Git") },
    ])).not.toThrow();
    expect(() => assertNoSimulatedGitRuntime([
      { path: "assets/deferred-capabilities-A.js", payload: Buffer.from("airship-memory-git") },
    ])).toThrow(/simulated browser-Git runtime.*deferred-capabilities-A\.js/iu);
  });

  it("recognizes only the hashed execution pack and forbids optional-pack preloads", () => {
    expect(isOptionalExecutionPackPath("assets/execution-runtime-pack-Ab_12-CD.js")).toBe(true);
    expect(isOptionalExecutionPackPath("assets/execution-tools-Ab_12-CD.js")).toBe(false);
    expect(isOptionalExecutionEnginePath("assets/execution-engine-Ab_12-CD.js")).toBe(true);
    expect(isOptionalExecutionEnginePath("assets/execution-runtime-pack-Ab_12-CD.js")).toBe(false);
    expect(isOptionalExecutionSupportPath("assets/runtime-registry-Ab_12-CD.js")).toBe(true);
    expect(isOptionalExecutionSupportPath("assets/runtime-Ab_12-CD.js")).toBe(false);
    expect(isOptionalExecutionToolsPath("assets/execution-tools-Ab_12-CD.js")).toBe(true);
    expect(isOptionalExecutionToolsPath("assets/runtime-registry-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWasiPreview1WorkerPath("assets/wasi-preview1-worker-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWasiPreview1WorkerPath("assets/wasi-preview1-pack-Ab_12-CD.js")).toBe(false);
    expect(isOptionalNodeExecutionPackPath("assets/node-webcontainer-pack-Ab_12-CD.js")).toBe(true);
    expect(isOptionalNodeExecutionPackPath("assets/execution-runtime-pack-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWasixJavaScriptPath("assets/wasix-pack-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWasixJavaScriptPath("assets/wasix-worker-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWasixJavaScriptPath("assets/dist-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWasixJavaScriptPath("assets/index-Ab_12-CD.mjs")).toBe(true);
    expect(isOptionalWasixJavaScriptPath("assets/index-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWasixWasmPath("assets/wasmer_js_bg-Ab_12-CD.wasm")).toBe(true);
    expect(isOptionalWasixWasmPath("assets/wasmer_js_bg-Ab_12-CD.js")).toBe(false);
    expect(isOptionalAgentRuntimePath("assets/agent-Ab_12-CD.js")).toBe(true);
    expect(isOptionalAgentRuntimePath("assets/turn-runtime-Ab_12-CD.js")).toBe(false);
    expect(isOptionalMultimodalPath("assets/multimodal-Ab_12-CD.js")).toBe(true);
    expect(isOptionalMultimodalPath("assets/image-input-Ab_12-CD.js")).toBe(false);
    expect(isOptionalContextPolicyPath("assets/context-policy-Ab_12-CD.js")).toBe(true);
    expect(isOptionalContextPolicyPath("assets/context-selection-Ab_12-CD.js")).toBe(false);
    expect(isOptionalAgentToolsPath("assets/tool-bundle-Ab_12-CD.js")).toBe(true);
    expect(isOptionalAgentToolsPath("assets/client-context-runtime-Ab_12-CD.js")).toBe(true);
    expect(isOptionalAgentToolsPath("assets/context-selection-Ab_12-CD.js")).toBe(true);
    expect(isOptionalAgentToolsPath("assets/repository-admission-Ab_12-CD.js")).toBe(true);
    expect(isOptionalAgentToolsPath("assets/tools-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWorkspaceWorkbenchPath("assets/editor-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWorkspaceWorkbenchPath("assets/workspace-tree-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWorkspaceBindingPath("assets/workspace-binding-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWorkspaceBindingPath("assets/workspace-bind-Ab_12-CD.js")).toBe(false);
    expect(isOptionalWorkspaceCodecPath("assets/content-codec-Ab_12-CD.js")).toBe(true);
    expect(isOptionalWorkspaceCodecPath("assets/content-Ab_12-CD.js")).toBe(false);
    expect(isOptionalRequestFailurePath("assets/request-state-Ab_12-CD.js")).toBe(true);
    expect(isOptionalRequestFailurePath("assets/request-status-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSourceControlPath("assets/sources-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSourceControlPath("assets/source-tree-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSourceSelectionPath("assets/source-selection-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSourceSelectionPath("assets/source-select-Ab_12-CD.js")).toBe(false);
    expect(isOptionalBrowserGitPath("assets/workspace-adapter-Ab_12-CD.js")).toBe(true);
    expect(isOptionalBrowserGitPath("assets/workspace-binding-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSessionLibraryPath("assets/sessions-route-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSessionLibraryPath("assets/session-view-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSessionManifestPath("assets/session-manifest-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSessionManifestPath("assets/sessions-route-Ab_12-CD.js")).toBe(false);
    expect(isOptionalFavoriteOrderingPath("assets/session-pins-Ab_12-CD.js")).toBe(true);
    expect(isOptionalFavoriteOrderingPath("assets/session-manifest-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSessionForkPath("assets/session-fork-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSessionForkPath("assets/fork-context-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSessionForkPath("assets/sessions-route-Ab_12-CD.js")).toBe(false);
    expect(isOptionalCapabilitiesViewPath("assets/capabilities-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalCapabilitiesViewPath("assets/capability-view-Ab_12-CD.js")).toBe(false);
    expect(isOptionalBrowserCapabilityPath("assets/browser-runtime-Ab_12-CD.js")).toBe(true);
    expect(isOptionalBrowserCapabilityPath("assets/runtime-browser-Ab_12-CD.js")).toBe(false);
    expect(isOptionalMemoryViewPath("assets/memory-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalMemoryViewPath("assets/memory-graph-Ab_12-CD.js")).toBe(false);
    expect(isOptionalMemorySupportPath("assets/kind-visual-Ab_12-CD.js")).toBe(true);
    expect(isOptionalMemorySupportPath("assets/kind-visual.css")).toBe(false);
    expect(isOptionalProofSurfacePath("assets/proof-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalProofSurfacePath("assets/provider-client-Ab_12-CD.js")).toBe(true);
    expect(isOptionalProofSurfacePath("assets/client-Ab_12-CD.js")).toBe(true);
    expect(isOptionalProofSurfacePath("assets/client-runtime-Ab_12-CD.js")).toBe(false);
    expect(isOptionalEvidenceAcquisitionPath("assets/evidence-acquisition-queue-Ab_12-CD.js")).toBe(true);
    expect(isOptionalEvidenceAcquisitionPath("assets/workspace-evidence-acquisition-persistence-Ab_12-CD.js")).toBe(true);
    expect(isOptionalEvidenceAcquisitionPath("assets/provider-client-Ab_12-CD.js")).toBe(false);
    expect(isOptionalTerminalPath("assets/terminal-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/manager-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/terminal-dock-state-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/terminal-runtime-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSemanticWorkerPath("assets/semantic.worker-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSemanticWorkerPath("assets/semantic-worker-Ab_12-CD.js")).toBe(false);
    expect(isOptionalModelCatalogPath("assets/client-runtime-Ab_12-CD.js")).toBe(true);
    expect(isOptionalModelCatalogPath("assets/telemetry-Ab_12-CD.js")).toBe(true);
    expect(isOptionalModelCatalogPath("assets/client-Ab_12-CD.js")).toBe(false);
    expect(isOptionalInferenceProviderPath("assets/fabric-Ab_12-CD.js")).toBe(true);
    expect(isOptionalInferenceProviderPath("assets/provider-connections-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalInferenceProviderPath("assets/provider-panel-Ab_12-CD.js")).toBe(false);
    expect(isOptionalChutesOAuthPath("assets/chutes-oauth-Ab_12-CD.js")).toBe(true);
    expect(isOptionalChutesOAuthPath("assets/chutes-oauth-registration-Ab_12-CD.js")).toBe(true);
    expect(isOptionalChutesOAuthPath("assets/openai-Ab_12-CD.js")).toBe(false);
    expect(isOptionalExtensionObservationPath("assets/extension-bridge-Ab_12-CD.js")).toBe(true);
    expect(isOptionalExtensionObservationPath("assets/inference-bridge-pack-Ab_12-CD.js")).toBe(false);
    expect(isOptionalLocalDeviceVaultPath("assets/local-device-vault-setup-Ab_12-CD.js")).toBe(true);
    expect(isOptionalLocalDeviceVaultPath("assets/local-device-keyring-Ab_12-CD.js")).toBe(true);
    expect(isOptionalLocalDeviceVaultPath("assets/local-lab-Ab_12-CD.js")).toBe(true);
    expect(isOptionalLocalDeviceVaultPath("assets/recovery-Ab_12-CD.js")).toBe(true);
    expect(isOptionalLocalDeviceVaultPath("assets/encrypted-envelope-Ab_12-CD.js")).toBe(true);
    expect(isOptionalLocalDeviceVaultPath("assets/local-storage-Ab_12-CD.js")).toBe(false);
    expect(isDeferredCapabilityPackPath("assets/deferred-capabilities-Ab_12-CD.js")).toBe(true);
    expect(isDeferredCapabilityPackPath("assets/load-deferred-capabilities-Ab_12-CD.js")).toBe(true);
    expect(isDeferredCapabilityPackPath("assets/connectivity-Ab_12-CD.js")).toBe(false);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/connectivity-Ab12.js">',
    )).not.toThrow();
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/execution-runtime-pack-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/execution-engine-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/runtime-registry-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/execution-tools-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/wasi-preview1-worker-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/deferred-capabilities-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/load-deferred-capabilities-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/evidence-acquisition-queue-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/extension-bridge-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/node-webcontainer-pack-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/wasix-pack-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/dist-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/index-Ab12.mjs">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/agent-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/multimodal-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/context-policy-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/tool-bundle-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/editor-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/workspace-binding-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/content-codec-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/sources-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/source-selection-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/workspace-adapter-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/sessions-route-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/session-manifest-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/session-pins-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/session-fork-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/capabilities-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/browser-runtime-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/memory-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/kind-visual-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/proof-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/request-state-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/terminal-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/terminal-dock-state-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/client-runtime-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/provider-connections-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/chutes-oauth-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/local-device-keyring-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/encrypted-envelope-Ab12.js">',
    )).toThrow(/must not preload/iu);
  });

  /*
   * The doc and the code have to describe the same fork.
   *
   * `fork()` seals a bounded ancestor-context seed and returns
   * `contextSeeded: true` on every call, while the doc still described
   * branching as unbuilt. Both halves are gated: the vocabulary that asserts a
   * blank slate must be gone, and the four names that make "bounded" checkable
   * must be present — a doc can drop the false claim and still leave the reader
   * with no way to know what the seed carries.
   */
  it("rejects the pre-seed fork contract in the shipped session-library doc", () => {
    const doc = readFileSync(new URL("../docs/SESSION_LIBRARY.md", import.meta.url), "utf8");
    expect(() => assertForkContractDocumented(doc)).not.toThrow();

    expect(() => assertForkContractDocumented(`${doc}\nFork = new identity · empty transcript.`))
      .toThrow(/empty transcript/u);
    expect(() => assertForkContractDocumented(`${doc}\nPress Create clean fork to branch.`))
      .toThrow(/clean fork/u);
    // The exact paragraph the finding was filed against.
    expect(() => assertForkContractDocumented(
      "The source transcript is not copied, summarized, or rewritten. A future protocol can resolve ancestor transcripts for conversational branching.",
    )).toThrow(/transcript that is not copied[\s\S]*future work[\s\S]*never names FORK_CONTEXT_EVENT_TYPE/u);
    // …while the true statement it was a corruption of stays sayable.
    expect(() => assertForkContractDocumented(doc.replace("The source journal is not copied", "The source journal is never copied")))
      .not.toThrow();
    for (const term of [
      "FORK_CONTEXT_EVENT_TYPE",
      "contextSeeded",
      "historyCopied",
      "MAX_FORK_CONTEXT_MESSAGES",
      "MAX_FORK_CONTEXT_BYTES",
    ]) {
      expect(() => assertForkContractDocumented(doc.split(term).join("«redacted»")), term)
        .toThrow(new RegExp(`never names ${term}`, "u"));
    }
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

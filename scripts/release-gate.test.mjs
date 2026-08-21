import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_BUDGETS,
  assertSinglePrimeKernelWorkerArtifact,
  assertNoSimulatedGitRuntime,
  assertWithinBudget,
  assertExclusiveArtifactClassifications,
  assertExactChunkStems,
  assertOptionalPacksAreNotPreloaded,
  createReleaseManifest,
  inspectPayload,
  assertExactExtensionReleaseInventory,
  inspectExtensionArchive,
  isOptionalExecutionPackPath,
  isOptionalExecutionEnginePath,
  isOptionalExecutionSupportPath,
  isOptionalExecutionToolsPath,
  isOptionalWasiPreview1WorkerPath,
  isOptionalNodeExecutionPackPath,
  isOptionalAgentRuntimePath,
  isOptionalMultimodalPath,
  isOptionalContextPolicyPath,
  isOptionalAgentToolsPath,
  isOptionalInferenceProviderPath,
  assertNoRetiredPrimeProviderChunks,
  isOptionalExtensionObservationPath,
  isOptionalLocalDeviceVaultPath,
  isOptionalWorkspaceWorkbenchPath,
  isOptionalWorkspaceBindingPath,
  isOptionalWorkspaceCodecPath,
  isOptionalFileDownloadPath,
  isOptionalRoutePrimitivePath,
  isOptionalRequestFailurePath,
  isOptionalSourceControlPath,
  isOptionalSourceSelectionPath,
  resolveOptionalSourceSelectionDelivery,
  assertDocumentedBudgetMeasurements,
  assertDocumentedMeasurementsMatchBuild,
  assertReleaseGateDocumentationMirrors,
  parseDocumentedBudgets,
  DOCUMENTED_BUDGET_ROWS,
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
  isOptionalSkillsManagerViewPath,
  isOptionalTerminalPath,
  isOptionalSemanticWorkerPath,
  isPrimeKernelWorkerPath,
  isOptionalSemanticPackPath,
  assertOptionalSemanticPackIntegrity,
  parseSemanticPackState,
  isDeferredCapabilityPackPath,
  assertForkContractDocumented,
  serializeReleaseManifest,
  validateBuiltCsp,
} from "./release-gate.mjs";
import {
  EXTENSION_PACKAGE_MEMBERS,
  EXTENSION_RELEASE_FILES,
  createExtensionArchive,
} from "../extension/release-archive.mjs";

describe("release gate", () => {
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

  it("rejects an unsafe first duplicate connect-src in synchronized built output", () => {
    const duplicateConnectSrc = (source) => source.replace(
      "connect-src 'self' https:",
      "connect-src *; connect-src 'self' https:",
    );
    const index = duplicateConnectSrc(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    const headers = duplicateConnectSrc(readFileSync(new URL("../public/_headers", import.meta.url), "utf8"));

    let failure;
    try {
      validateBuiltCsp(index, headers);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(
      "Built CSP directives must be unique because browsers honor the first occurrence:\n"
      + "- Built index CSP contains a duplicate CSP directive: connect-src.\n"
      + "- Built response-header CSP contains a duplicate CSP directive: connect-src.",
    );
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

  it("requires exactly one uniquely suffixed Prime kernel worker artifact", () => {
    const exact = "assets/AbC_123-x.prime-kernel-worker.js";
    expect(isPrimeKernelWorkerPath(exact)).toBe(true);
    expect(isPrimeKernelWorkerPath("assets/prime-kernel-worker-AbC_123-x.js")).toBe(false);
    expect(isPrimeKernelWorkerPath("assets/AbC_123-x.prime-kernel-worker.js?token=secret")).toBe(false);
    expect(assertSinglePrimeKernelWorkerArtifact(["assets/index-a.js", exact])).toBe(exact);
    expect(() => assertSinglePrimeKernelWorkerArtifact(["assets/index-a.js"]))
      .toThrow(/exactly one Prime kernel worker artifact; found 0/u);
    expect(() => assertSinglePrimeKernelWorkerArtifact([
      exact,
      "assets/Other456.prime-kernel-worker.js",
    ])).toThrow(/exactly one Prime kernel worker artifact; found 2/u);
  });

  it("accepts an optional semantic pack only as the complete reviewed byte set", () => {
    const runtime = Buffer.from("runtime");
    const model = Buffer.from("model");
    const manifest = {
      assets: {
        "runtime/transformers.web.js": { bytes: runtime.byteLength, sha256: sha256(runtime) },
        "models/example/model.onnx": { bytes: model.byteLength, sha256: sha256(model) },
      },
    };
    const complete = [
      { path: "semantic-pack/v1/runtime/transformers.web.js", payload: runtime },
      { path: "semantic-pack/v1/models/example/model.onnx", payload: model },
    ];
    expect(assertOptionalSemanticPackIntegrity([], manifest)).toEqual([]);
    expect(() => assertOptionalSemanticPackIntegrity([], manifest, true))
      .toThrow(/declares the optional semantic pack available/u);
    expect(() => assertOptionalSemanticPackIntegrity(complete, manifest, false))
      .toThrow(/declares the optional semantic pack unavailable/u);
    expect(assertOptionalSemanticPackIntegrity(complete, manifest).map(({ path }) => path)).toEqual([
      "semantic-pack/v1/models/example/model.onnx",
      "semantic-pack/v1/runtime/transformers.web.js",
    ]);
    expect(() => assertOptionalSemanticPackIntegrity(complete.slice(0, 1), manifest))
      .toThrow(/missing: semantic-pack\/v1\/models\/example\/model\.onnx/u);
    expect(() => assertOptionalSemanticPackIntegrity([
      complete[0],
      { ...complete[1], payload: Buffer.from("other") },
    ], manifest)).toThrow(/failed its reviewed byte\/hash pin/u);
    expect(() => assertOptionalSemanticPackIntegrity([
      ...complete,
      { path: "semantic-pack/v1/unreviewed.txt", payload: Buffer.from("extra") },
    ], manifest)).toThrow(/unreviewed: semantic-pack\/v1\/unreviewed\.txt/u);
    expect(isOptionalSemanticPackPath("semantic-pack/v1/runtime/transformers.web.js")).toBe(true);
    expect(isOptionalSemanticPackPath("assets/semantic.worker-A.js")).toBe(false);
  });

  it("binds the emitted pack declaration to the reviewed model revision", () => {
    const manifest = { modelRevision: "reviewed", assets: { "model.onnx": { bytes: 1, sha256: "0".repeat(64) } } };
    expect(parseSemanticPackState(Buffer.from(JSON.stringify({
      schema: "airship.semantic-pack-state.v1",
      available: true,
      modelRevision: "reviewed",
    })), manifest)).toEqual({ available: true, modelRevision: "reviewed" });
    expect(() => parseSemanticPackState(Buffer.from(JSON.stringify({
      schema: "airship.semantic-pack-state.v1",
      available: true,
      modelRevision: "other",
    })), manifest)).toThrow(/does not match its reviewed schema and model revision/u);
  });

  it("rejects source maps, inline map directives, and actual credential-shaped values", () => {
    expect(inspectPayload("assets/main.js.map", Buffer.from("{}"))).toContain("production source map");
    expect(inspectPayload("assets/main.js.map.br", Buffer.from("compressed"))).toContain("production source map");
    expect(inspectPayload("assets/main.js", Buffer.from("//# sourceMappingURL=data:application/json;base64,e30="))).toContain(
      "sourceMappingURL directive",
    );
    expect(inspectPayload(`assets/cpk_${"y".repeat(40)}.js`, Buffer.from("export {}"))).toContain(
      "Chutes API key",
    );
    expect(inspectPayload("assets/main.js", Buffer.from('const help = "cak_ or cpk_"'))).toEqual([]);
  });

  it("decompresses exact Companion ZIP members before applying release scans", () => {
    const entries = (background = "export {}") => EXTENSION_PACKAGE_MEMBERS.map((path) => ({
      path,
      payload: Buffer.from(path === "background.js" ? background : "reviewed fixture"),
    }));
    const clean = createExtensionArchive(entries());
    expect(inspectExtensionArchive("extension/releases/fixture.zip", clean)).toEqual([]);

    const synthetic = `AKIA${"Z".repeat(16)}`;
    const hostile = createExtensionArchive(entries(
      `const key = "${synthetic}";\n//# sourceMappingURL=background.js.map\n`,
    ));
    expect(hostile.includes(Buffer.from(synthetic))).toBe(false);
    expect(inspectExtensionArchive("extension/releases/fixture.zip", hostile)).toEqual([
      "background.js: sourceMappingURL directive",
      "background.js: AWS access key",
    ]);

    // A source-map member is not one of the ten reviewed package members.
    const renamed = Buffer.from(clean);
    const from = Buffer.from("popup.js");
    const to = Buffer.from("x.js.map");
    let replacements = 0;
    for (let offset = renamed.indexOf(from); offset >= 0; offset = renamed.indexOf(from, offset + to.length)) {
      to.copy(renamed, offset);
      replacements += 1;
    }
    expect(replacements).toBe(2); // local header and central directory
    expect(() => inspectExtensionArchive("extension/releases/fixture.zip", renamed))
      .toThrow(/member order\/inventory differs/u);

    expect(() => inspectExtensionArchive(
      "extension/releases/fixture.zip",
      Buffer.concat([clean, Buffer.from("unlisted trailing bytes")]),
    )).toThrow(/end signature|exact archive tail/u);
    const corrupt = Buffer.from(clean);
    corrupt[30 + Buffer.byteLength("background.js")] ^= 0xff;
    expect(() => inspectExtensionArchive("extension/releases/fixture.zip", corrupt))
      .toThrow(/invalid compressed data|checksum does not match/u);
  });

  it("requires the exact eight-file Companion release directory", () => {
    const exact = EXTENSION_RELEASE_FILES.map((path) => `extension/releases/${path}`);
    expect(() => assertExactExtensionReleaseInventory(exact)).not.toThrow();
    expect(() => assertExactExtensionReleaseInventory([...exact, "extension/releases/orphan.zip"]))
      .toThrow(/unexpected: orphan\.zip/u);
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
  it("prints only measurements the current release result returns", () => {
    const source = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
    const printer = source.slice(source.indexOf("function printResult("));
    expect(printer).toContain("measurements.optionalPrimePack");
    expect(printer).toContain("measurements.optionalInferenceProviders.raw");
    expect(printer).toContain("measurements.optionalInferenceProviders.gzip");
    expect(printer).not.toMatch(/optionalProofSurface|optionalEvidenceAcquisition|optionalChutesOAuth/u);
  });

  it("rejects budget comments that contradict or abandon the ceilings they justify", () => {
    const source = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
    expect(() => assertDocumentedBudgetMeasurements(source)).not.toThrow();
    expect(MEASUREMENT_JUSTIFIED_BUDGETS.length).toBeGreaterThan(0);
    for (const name of MEASUREMENT_JUSTIFIED_BUDGETS) expect(RELEASE_BUDGETS[name]).toBeDefined();

    // Every ceiling re-measured by the recovery-and-continuation pass must stay
    // under the build comparison. Deriving this assertion from the exported
    // list would let a future omission silently weaken the gate again.
    for (const name of [
      "entryJavaScript",
      "allJavaScriptAndWorkers",
      "firstPartyJavaScriptAndWorkers",
      "optionalVendorRuntimeAggregate",
      "totalJavaScriptAndWorkers",
      "optionalExecutionTools",
      "optionalInferenceProviders",
      "optionalTerminal",
    ]) {
      expect(MEASUREMENT_JUSTIFIED_BUDGETS, name).toContain(name);
    }

    // A figure the ceiling beside it would reject describes a build nobody shipped.
    expect(() => assertDocumentedBudgetMeasurements(source.replace("20,591 B gzip", "23,591 B gzip")))
      .toThrow(/optionalMemoryView: its comment records 23,591 B gzip, above the 21\.00 KiB gzip ceiling/u);
    // …and a raise cannot be laundered by deleting the operative measurement.
    expect(() => assertDocumentedBudgetMeasurements(source.replace(
      "Measured 86,877 B raw / 27,519 B gzip",
      "Weighed 86,877 B and 27,519 B",
    )))
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
      ["optionalWorkspaceWorkbench", "gzip: 28 * 1024", "gzip: 29 * 1024"],
      ["deferredCapabilities", "gzip: 72 * 1024", "gzip: 73 * 1024"],
    ]) {
      const raised = source.replace(new RegExp(`^  ${name}: .*$`, "mu"), (line) => line.replace(ceiling, granted));
      expect(raised, name).not.toBe(source);
      expect(() => assertDocumentedBudgetMeasurements(raised), name).toThrow(
        new RegExp(`${name}: the [\\d.]+ KiB gzip ceiling is above the smallest whole-KiB step`, "u"),
      );
    }
    const falseTripwire = source.replace(
      "63 KiB raw would have left 354 B",
      "63 KiB raw would have left 999 B",
    );
    expect(falseTripwire).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(falseTripwire))
      .toThrow(/optionalMemoryView: .* matching tripwire arithmetic "63 KiB raw would have left 354 B"/u);

    expect(() => assertDocumentedBudgetMeasurements(source.replace(/^  optionalMemoryView: .*$/mu, "  optionalMemoryViewX: Object.freeze({ raw: 1, gzip: 1 }),")))
      .toThrow(/optionalMemoryView: named as measurement-justified but no such release budget was found/u);
  });

  /*
   * Which comment syntax a budget happens to use is a typographic accident, and
   * it was deciding whether the budget was checked at all: the parser read `//`
   * lines only and every other line reset the accumulator, so a ceiling
   * justified in a `/* *\/` block reached the guard as empty prose — no figure
   * to contradict a ceiling, no measurement to be too loose for.
   */
  it("reads a budget justified in a block comment, not only a slash-slash one", () => {
    const source = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
    const entries = parseDocumentedBudgets(source);
    // `optionalConfirmDialog` is documented in block form and states its reading.
    const blockDocumented = entries.find((entry) => entry.name === "optionalConfirmDialog");
    expect(blockDocumented.prose).toContain("Measured");
    expect(blockDocumented.measured.length).toBeGreaterThan(0);
    // …and it is held to the same rule as the slash-slash ones now that it is read.
    expect(() => assertDocumentedBudgetMeasurements(source.replace("Measured 1,010 B raw / 594 B gzip", "Measured 9,010 B raw / 594 B gzip")))
      .toThrow(/optionalConfirmDialog: its comment records 9,010 B raw, above the 2\.00 KiB raw ceiling/u);

    // A comment may still quote another surface's figure — several exist
    // *because* the entry chunk breached its own ceiling, and saying so is the
    // justification. Only what the comment presents as its own measurement is
    // held to the ceiling beside it.
    const overlays = entries.find((entry) => entry.name === "optionalShellOverlays");
    expect(overlays.prose).toContain("110.54 KiB gzip");
    // The entry-chunk figure this comment quotes to explain *why* the overlays
    // were moved out stays excluded; both of this budget's own readings — the
    // original and the surface-repair re-measurement — are counted.
    expect(overlays.figures.map((figure) => figure.text))
      .toEqual(["6.23 KiB", "2.46 KiB", "7,219 B", "2,816 B"]);
  });

  /*
   * Everything above compares a comment to a ceiling, and a ceiling is the one
   * thing a stale-high figure keeps satisfying — which is why
   * `optionalWorkspaceWorkbench`'s own comment records that this guard "did not
   * catch it". Comparing its whole-KiB bucket with the artifact from the same run
   * catches a material overstatement without rejecting harmless environment drift.
   */
  it("refuses a documented measurement that claims a higher whole-KiB bucket than the build", () => {
    const source = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
    const asDocumented = Object.fromEntries(
      MEASUREMENT_JUSTIFIED_BUDGETS.map((name) => {
        const entry = parseDocumentedBudgets(source).find((candidate) => candidate.name === name);
        return [name, Object.fromEntries(["raw", "gzip"].map((role) => {
          const largest = entry.measured.reduce(
            (left, right) => (left && left[role] >= right[role] ? left : right),
            null,
          );
          return [role, largest[role]];
        }))];
      }),
    );
    expect(() => assertDocumentedMeasurementsMatchBuild(source, asDocumented)).not.toThrow();

    /*
     * Supported variants can have crossed maxima: Pages currently wins raw while
     * config-free wins gzip. A gzip claim in a higher bucket must not disappear
     * merely because its paired raw value is nine bytes smaller. Writing this
     * adversarial maximum in KiB also proves its own precision travels with it.
     */
    const crossedMaxima = source.replace(
      "385,247 B raw / 119,150 B gzip",
      "385,247 B raw / 117.68 KiB gzip",
    );
    expect(crossedMaxima).not.toBe(source);
    expect(() => assertDocumentedMeasurementsMatchBuild(crossedMaxima, {
      ...asDocumented,
      entryJavaScript: { raw: 385247, gzip: 119150 },
    })).toThrow(
      /entryJavaScript: its comment claims 117\.68 KiB gzip, but this build measures only 116\.36 KiB \(119150 B\), in a lower whole-KiB budget bucket/u,
    );

    // A legal build-time environment can move a shared aggregate by a handful
    // of bytes. The reading still justifies the same whole-KiB ceiling, so this
    // drift must not reject Docker's supported deployment variants.
    const sameBucketDrift = {
      ...asDocumented,
      optionalMemoryView: { ...asDocumented.optionalMemoryView, gzip: asDocumented.optionalMemoryView.gzip - 1 },
    };
    expect(() => assertDocumentedMeasurementsMatchBuild(source, sameBucketDrift)).not.toThrow();

    // Crossing below the bucket named by the comment is materially different:
    // that stale reading could justify an extra KiB of ceiling no build needs.
    const documentedGzip = asDocumented.optionalMemoryView.gzip;
    const lowerBucket = {
      ...asDocumented,
      optionalMemoryView: { ...asDocumented.optionalMemoryView, gzip: Math.floor(documentedGzip / 1024) * 1024 - 1 },
    };
    expect(() => assertDocumentedMeasurementsMatchBuild(source, lowerBucket))
      .toThrow(/optionalMemoryView: its comment claims .* gzip, but this build measures only .* in a lower whole-KiB budget bucket/u);

    /*
     * Growth is not a failure, and it must not be, or six comments change on
     * every pull request that moves a shared chunk by a byte — which is how a
     * rule gets deleted. Understatement is bracketed from the other side: the
     * tightness rule pulls the ceiling down to one step above the claim, and
     * `assertWithinBudget` then refuses a build that no longer fits under it.
     */
    const grown = Object.fromEntries(
      Object.entries(asDocumented).map(([name, pair]) => [name, { raw: pair.raw + 512, gzip: pair.gzip + 128 }]),
    );
    expect(() => assertDocumentedMeasurementsMatchBuild(source, grown)).not.toThrow();

    /*
     * A figure is held only to the precision it was written at, and same-bucket
     * drift remains harmless at that precision. Crossing into the lower bucket
     * is still material and still fails.
     */
    const coarse = source.replace(/Re-measured 3,396 B raw \/ 1,319 B gzip/u, "Re-measured 3.32 KiB raw / 1.29 KiB gzip");
    expect(coarse).not.toBe(source);
    const withinPrecision = { ...asDocumented, optionalSkillEditor: { raw: 3396, gzip: 1319 } };
    expect(() => assertDocumentedMeasurementsMatchBuild(coarse, withinPrecision)).not.toThrow();
    expect(() => assertDocumentedMeasurementsMatchBuild(coarse, {
      ...withinPrecision,
      optionalSkillEditor: { raw: 3396, gzip: 1219 },
    })).not.toThrow();
    expect(() => assertDocumentedMeasurementsMatchBuild(coarse, {
      ...withinPrecision,
      optionalSkillEditor: { raw: 3396, gzip: 1000 },
    })).toThrow(/optionalSkillEditor: its comment claims 1\.29 KiB gzip, but this build measures only 0\.98 KiB .* lower whole-KiB budget bucket/u);
  });

  it("classifies only the current deferred route, download, and semantic stems", () => {
    expect(isOptionalFileDownloadPath("assets/file-download-AbC_123.js")).toBe(true);
    expect(isOptionalFileDownloadPath("assets/proof-download-AbC_123.js")).toBe(false);
    for (const stem of ["route-header", "tabs", "brand-icons", "phone-viewport", "bm25", "dedup"]) {
      expect(isOptionalRoutePrimitivePath(`assets/${stem}-AbC_123.js`), stem).toBe(true);
    }
    expect(isOptionalRoutePrimitivePath("assets/metric-strip-AbC_123.js")).toBe(false);
    expect(isOptionalRoutePrimitivePath("assets/bm25.js")).toBe(false);
    expect(isOptionalRoutePrimitivePath("assets/bm25-AbC_123.js?stale=1")).toBe(false);
  });

  it("requires exact lazy chunk stems rather than count-only lookalikes", () => {
    const required = ["request-state", "turn-recovery"];
    expect(() => assertExactChunkStems(
      "Request failure",
      ["assets/request-state-A.js", "assets/turn-recovery-B_2.js"],
      required,
    )).not.toThrow();
    expect(() => assertExactChunkStems(
      "Request failure",
      ["assets/request-state-A.js", "assets/request-state-B.js"],
      required,
    )).toThrow(/Request failure chunks do not match the required stems/u);
    expect(() => assertExactChunkStems(
      "Request failure",
      ["assets/request-state-A.js", "assets/turn-recovery.js"],
      required,
    )).toThrow(/Request failure chunks do not match the required stems/u);
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
    expect(isOptionalSkillsManagerViewPath("assets/skills-manager-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSkillsManagerViewPath("assets/skills-view-Ab_12-CD.js")).toBe(false);
    expect(isOptionalTerminalPath("assets/terminal-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/manager-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/terminal-dock-state-Ab_12-CD.js")).toBe(true);
    expect(isOptionalTerminalPath("assets/terminal-runtime-Ab_12-CD.js")).toBe(false);
    expect(isOptionalSemanticWorkerPath("assets/semantic.worker-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSemanticWorkerPath("assets/semantic-worker-Ab_12-CD.js")).toBe(false);
    expect(isOptionalInferenceProviderPath("assets/fabric-Ab_12-CD.js")).toBe(true);
    expect(isOptionalInferenceProviderPath("assets/provider-connections-view-Ab_12-CD.js")).toBe(true);
    // Legacy stems stay recognized so the gate rejects stale Prime provider
    // chunks as members of this family instead of ignoring them.
    expect(isOptionalInferenceProviderPath("assets/openai-Ab_12-CD.js")).toBe(true);
    expect(isOptionalInferenceProviderPath("assets/anthropic-Ab_12-CD.js")).toBe(true);
    expect(isOptionalInferenceProviderPath("assets/openai-completions-Ab_12-CD.js")).toBe(true);
    expect(isOptionalInferenceProviderPath("assets/openai-responses-Ab_12-CD.js")).toBe(true);
    expect(() => assertNoRetiredPrimeProviderChunks([
      "assets/fabric-Ab_12-CD.js",
      "assets/session-route-Ab_12-CD.js",
    ])).not.toThrow();
    expect(() => assertNoRetiredPrimeProviderChunks([
      "assets/anthropic-Ab_12-CD.js",
      "assets/openai-completions-Ab_12-CD.js",
      "assets/openai-responses-Ab_12-CD.js",
    ])).toThrow(/retired Prime provider chunks/u);
    expect(isOptionalInferenceProviderPath("assets/provider-panel-Ab_12-CD.js")).toBe(false);
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
      '<link rel="modulepreload" href="/assets/extension-bridge-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/node-webcontainer-pack-Ab12.js">',
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
      '<link rel="modulepreload" href="/assets/skills-manager-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/kind-visual-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/request-state-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/terminal-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/airship/assets/terminal-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/manager-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/terminal-dock-state-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/provider-connections-view-Ab12.js">',
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
    sha256: sha256(payload),
  };
}

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

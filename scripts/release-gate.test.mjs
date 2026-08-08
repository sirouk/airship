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
  isOptionalProofSurfacePath,
  isOptionalEvidenceAcquisitionPath,
  isOptionalTerminalPath,
  isOptionalSemanticWorkerPath,
  isOptionalSemanticPackPath,
  assertOptionalSemanticPackIntegrity,
  parseSemanticPackState,
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
    // AMENDED: the phone pass raised this ceiling to 89 KiB against a re-measured
    // build, so the message the guard prints names 89.00. The claim is unchanged.
    expect(() => assertDocumentedBudgetMeasurements(source.replace("74,690 B\n  // raw", "94,690 B\n  // raw")))
      .toThrow(/optionalProofSurface: its comment records 94,690 B raw, above the 89\.00 KiB raw ceiling/u);
    // …and a raise cannot be laundered by deleting the number it contradicts.
    // AMENDED to the pair the ceiling now rests on: the guard reads the
    // *largest* pair a comment states, so blanking the older 78,628 B reading
    // stopped proving anything once Source Control's rail added a bigger one
    // above it. The claim is unchanged — remove the operative measurement and
    // the block must stop justifying its ceilings.
    // AMENDED again for the same reason: the editor-theme pass recorded a
    // third, larger pair in this block, and a claim that blanks two of three
    // readings proves nothing while the operative one survives.
    // The current editor-workbench block has three operative readings. Blank
    // all three; leaving any one of them would let the largest pair keep
    // justifying the ceiling.
    expect(() => assertDocumentedBudgetMeasurements(source
      .replace("Re-measured on this build: 87,281 B raw / 27,902 B gzip", "Re-weighed at 87,281 B and 27,902 B")
      .replace("Re-measured on this build: 81,152 B raw / 25,637 B gzip", "Re-weighed at 81,152 B and 25,637 B")
      .replace("Re-measured on this build: 78,628 B raw / 24,795 B gzip", "Re-weighed at 78,628 B and 24,795 B")))
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
      // AMENDED with the ceiling it names, for the same reason the
      // `deferredCapabilities` row below was: 27 KiB is now the tightest step
      // above this chunk's recorded gzip, so the unpaid-for step is the one
      // past it.
      // AMENDED again: the phone pass re-measured this chunk at 27,586 B gzip
      // and its comment now pays for the second step in as many words — "27 KiB
      // gzip would have left 62 bytes". So the ceiling is 28 KiB and the step
      // granted without a sentence behind it is 29.
      ["optionalWorkspaceWorkbench", "gzip: 28 * 1024", "gzip: 29 * 1024"],
      // AMENDED with the ceiling it names: `deferredCapabilities` gzip moved to
      // 128 KiB after the conversation-proof cleanup operation, and the
      // step this row grants without paying for it is now the one past it.
      // AMENDED again: the Vault reclamation machinery (the aged-supersession
      // queue and bounded sweep) re-measured the pack and the budget comment
      // pays for 131 KiB with the 130-Would-have-left-143-B sentence, so the
      // unpaid step is the one past that.
      // AMENDED again: the surface-repair sweep re-measured the pack at
      // 133,743 B gzip. The ceiling did not move — 131 KiB still clears it —
      // but the reading it is measured against did, so the second step this
      // comment already pays for now lands on 132 and the step granted without
      // a sentence behind it is 133.
      ["deferredCapabilities", "gzip: 131 * 1024", "gzip: 133 * 1024"],
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
   * catch it". Comparing against the artifact the same run measures is what can.
   */
  it("refuses a documented measurement that claims more than the build contains", () => {
    const source = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
    const asDocumented = Object.fromEntries(
      MEASUREMENT_JUSTIFIED_BUDGETS.map((name) => {
        const entry = parseDocumentedBudgets(source).find((candidate) => candidate.name === name);
        const largest = entry.measured.reduce((left, right) => (left && left.raw >= right.raw ? left : right), null);
        return [name, { raw: largest.raw, gzip: largest.gzip }];
      }),
    );
    expect(() => assertDocumentedMeasurementsMatchBuild(source, asDocumented)).not.toThrow();

    // One byte over is a stale-high figure. It is the exact shape of the defect:
    // 1,320 B gzip against a 1,319 B build was the only one of the six that
    // claimed more than the build contained on the first run of this check.
    const overstated = { ...asDocumented, optionalMemoryView: { ...asDocumented.optionalMemoryView, gzip: asDocumented.optionalMemoryView.gzip - 1 } };
    expect(() => assertDocumentedMeasurementsMatchBuild(source, overstated))
      .toThrow(/optionalMemoryView: its comment claims .* gzip, but this build measures only/u);

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

    // A budget the run never measured cannot be said to agree with anything.
    const missing = { ...asDocumented };
    delete missing.optionalProofSurface;
    expect(() => assertDocumentedMeasurementsMatchBuild(source, missing))
      .toThrow(/optionalProofSurface: named as measurement-justified, but this run measured no artifact under that name/u);

    /*
     * A figure is held only to the precision it was written at. A comment saying
     * "6.23 KiB raw" claims a hundredth of a KiB and nothing finer, and a check
     * that read it to the byte would push every justification towards raw byte
     * counts — the harder form to read — to satisfy the tool.
     */
    const coarse = source.replace(/Re-measured 3,396 B raw \/ 1,319 B gzip/u, "Re-measured 3.32 KiB raw / 1.29 KiB gzip");
    expect(coarse).not.toBe(source);
    const withinPrecision = { ...asDocumented, optionalSkillEditor: { raw: 3396, gzip: 1319 } };
    expect(() => assertDocumentedMeasurementsMatchBuild(coarse, withinPrecision)).not.toThrow();
    expect(() => assertDocumentedMeasurementsMatchBuild(coarse, { ...withinPrecision, optionalSkillEditor: { raw: 3396, gzip: 1219 } }))
      .toThrow(/optionalSkillEditor: its comment claims 1\.29 KiB gzip, but this build measures only 1\.19 KiB/u);
  });

  /*
   * `docs/RELEASE_GATE.md` calls its budget table a mirror of the executable
   * ceilings and says a reviewer must move both together. Nothing held it to
   * that, and six rows had stopped being true while two described gates the
   * script does not contain.
   */
  it("holds the release-gate document's budget table to the exported ceilings", () => {
    const doc = readFileSync(new URL("../docs/RELEASE_GATE.md", import.meta.url), "utf8");
    expect(() => assertReleaseGateDocumentationMirrors(doc)).not.toThrow();
    for (const { budgets } of DOCUMENTED_BUDGET_ROWS) {
      for (const name of budgets) expect(RELEASE_BUDGETS[name], name).toBeDefined();
    }

    expect(() => assertReleaseGateDocumentationMirrors(doc.replace("| HTML-referenced entry JavaScript | 384 KiB |", "| HTML-referenced entry JavaScript | 383 KiB |")))
      .toThrow(/"HTML-referenced entry JavaScript" raw: the table says 383\.00 KiB for entryJavaScript, the ceiling is 384\.00 KiB/u);
    // A row that names a class the script does not gate is the 640 / 132 KiB
    // "initial load" defect: a reader can argue a raise against it and there is
    // nothing on the other side of the argument.
    expect(() => assertReleaseGateDocumentationMirrors(doc.replace("| Service worker |", "| Initial JavaScript and module preloads | 640 KiB | 132 KiB |\n| Service worker |")))
      .toThrow(/the table row "Initial JavaScript and module preloads" names no ceiling this file exports/u);
    // Dropping a figure from a multi-class row hides whichever class it omitted.
    // AMENDED: the execution-tools ceiling fell to 58 KiB when the dead eager
    // registrar came out, so the row this assertion mutilates is spelled with
    // the number it now carries.
    expect(() => assertReleaseGateDocumentationMirrors(doc.replace("| 32 / 56 / 10 / 58 KiB |", "| 32 / 56 / 10 KiB |")))
      .toThrow(/"Optional execution broker \/ engine \/ support \/ tools" raw: the table states 3 figure\(s\) for 4 ceiling\(s\)/u);
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
    expect(isOptionalSkillsManagerViewPath("assets/skills-manager-view-Ab_12-CD.js")).toBe(true);
    expect(isOptionalSkillsManagerViewPath("assets/skills-view-Ab_12-CD.js")).toBe(false);
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
      '<link rel="modulepreload" href="/assets/skills-manager-view-Ab12.js">',
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
      '<link rel="modulepreload" href="/airship/assets/terminal-view-Ab12.js">',
    )).toThrow(/must not preload/iu);
    expect(() => assertOptionalPacksAreNotPreloaded(
      '<link rel="modulepreload" href="/assets/manager-Ab12.js">',
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
    sha256: sha256(payload),
  };
}

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

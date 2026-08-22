import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PYODIDE_DISTRIBUTION_PINS,
  assertPinnedPyodideDistribution,
  assertEveryStylesheetIsReferenced,
  RELEASE_BUDGETS,
  assertSinglePrimeKernelWorkerArtifact,
  assertNoSimulatedGitRuntime,
  assertStockReleaseExcludesLocalLab,
  LOCAL_LAB_RELEASE_SENTINELS,
  assertWithinBudget,
  assertExclusiveArtifactClassifications,
  assertExactChunkStems,
  assertRequiredFilesAreMeasured,
  assertOptionalPacksAreNotPreloaded,
  createReleaseManifest,
  inspectPayload,
  assertExactDocumentInventory,
  assertExactExtensionReleaseInventory,
  assertFallbackDocumentIsIndex,
  RELEASE_DOCUMENTS,
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
  isBaselineJavaScriptPath,
  isControlledNavigationPath,
  isOptionalRoutePrimitivePath,
  isOptionalRequestFailurePath,
  isOptionalSourceControlPath,
  isOptionalSourceSelectionPath,
  resolveOptionalSourceSelectionDelivery,
  assertDocumentedBudgetMeasurements,
  assertEveryArtifactIsClassified,
  RELEASE_ARTIFACT_CLASSES,
  RELEASE_BUDGET_CLASSES,
  REVIEWED_BUILD_VARIANTS,
  releaseBudgetClass,
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

  /*
   * The keys this product is actually built around. A bring-your-own-provider
   * client whose S3 vault also takes AWS secrets shipped a scanner that knew
   * none of these shapes, so four realistic provider keys appended to the entry
   * chunk passed the gate while the documentation promised they could not.
   */
  it("rejects the provider credential shapes this workbench handles", () => {
    const leaks = [
      ["OpenAI API key", `sk-proj-${"a".repeat(20)}T3BlbkFJ${"b".repeat(20)}`],
      ["OpenAI API key", `sk-${"a".repeat(20)}T3BlbkFJ${"b".repeat(20)}`],
      ["Anthropic API key", `sk-ant-api03-${"c".repeat(40)}`],
      ["Google API key", `AIza${"D".repeat(35)}`],
      ["Google OAuth client secret", `GOCSPX-${"e".repeat(28)}`],
      ["Hugging Face token", `hf_${"f".repeat(34)}`],
      ["AWS secret access key", `aws_secret_access_key = "${"g".repeat(40)}"`],
      ["xAI API key", `xai-${"h".repeat(48)}`],
      ["Anthropic OAuth credential", `sk-ant-oat01-${"i".repeat(40)}`],
      ["OpenRouter API key", `sk-or-v1-${"j".repeat(48)}`],
      ["Groq API key", `gsk_${"k".repeat(48)}`],
      ["Fireworks API key", `fw_${"l".repeat(30)}`],
      ["Perplexity API key", `pplx-${"m".repeat(40)}`],
      ["NVIDIA API key", `nvapi-${"n".repeat(48)}`],
    ];
    for (const [label, value] of leaks) {
      expect(inspectPayload("assets/index-A.js", Buffer.from(`const leaked = ${value};`)), value)
        .toContain(label);
    }

    // Ordinary shipped prose and identifiers are not credentials. `sk-` alone
    // is a documentation string, and a base64-looking word is not a key.
    for (const benign of [
      'const doc = "paste your sk-... key";',
      'const provider = { id: "anthropic", label: "Anthropic" };',
      'const hint = "hf_ tokens start with hf_";',
      'const sample = "AIzaSy";',
    ]) {
      expect(inspectPayload("assets/index-A.js", Buffer.from(benign)), benign).toEqual([]);
    }
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

  const gateSource = () => readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");

  /** Exactly what the gate would measure if every reviewed reading were the truth. */
  const asRecorded = (source) => Object.fromEntries(
    parseDocumentedBudgets(source)
      .filter((entry) => entry.readings.length > 0)
      .map((entry) => [entry.name, Object.fromEntries(["raw", "gzip"].map((role) => [
        role,
        entry.readings.reduce((largest, reading) => Math.max(largest, reading[role]), 0),
      ]))]),
  );

/**
 * The Pyodide bytes as `scripts/pyodide-assets.ts` emits them: the package's
 * own files, with the upstream `sourceMappingURL` trailer stripped from the
 * two `.mjs` ones. Reading them here means the pins are checked against what
 * `npm ci` actually installs, not against a fixture that agrees with itself.
 */
const pyodidePayloads = new Map(PYODIDE_DISTRIBUTION_PINS.map((pin) => {
  const name = pin.path.slice("execution-packs/pyodide/".length);
  const payload = readFileSync(new URL(`../node_modules/pyodide/${name}`, import.meta.url));
  return [pin.path, name.endsWith(".mjs")
    ? Buffer.from(payload.toString("utf8").replace(/\/\/[#@]\s*sourceMappingURL=.*?(?:\r?\n|$)/gu, ""), "utf8")
    : payload];
}));

  /** …plus the one module the bundler folded into its consumer in this build. */
  const asBuilt = (source) => ({
    ...asRecorded(source),
    optionalSourceSelection: { inlinedInto: "assets/repository-admission-VdXZNZ78.js" },
  });

  it("rejects budget comments that contradict or abandon the ceilings they justify", () => {
    const source = gateSource();
    expect(() => assertDocumentedBudgetMeasurements(source)).not.toThrow();

    /*
     * Enforcement is no longer opt-in. It named sixteen of fifty-nine budgets,
     * and an auditor raised a ceiling from 24 KiB to 64 KiB on a 12.5 KiB pack
     * with a green gate because the name was not on the list.
     */
    expect(MEASUREMENT_JUSTIFIED_BUDGETS).toEqual(Object.keys(RELEASE_BUDGETS));
    expect(MEASUREMENT_JUSTIFIED_BUDGETS.length).toBe(59);
    for (const name of Object.keys(RELEASE_BUDGETS)) {
      expect(MEASUREMENT_JUSTIFIED_BUDGETS, name).toContain(name);
    }

    // A figure the ceiling beside it would reject describes a build nobody shipped.
    expect(() => assertDocumentedBudgetMeasurements(
      source.replace("Reviewed reading (Google-Drive-configured): 12,837 B raw / 4,576 B gzip.", "Reviewed reading (Google-Drive-configured): 912,837 B raw / 4,576 B gzip."),
    )).toThrow(/optionalApprovalDock: its reviewed reading of 912,837 B raw is above the 17\.00 KiB raw ceiling/u);

    // …and a raise cannot be laundered by deleting the number it contradicts.
    expect(() => assertDocumentedBudgetMeasurements(source.replaceAll("Reviewed reading (", "Earlier reading (")))
      .toThrow(/optionalApprovalDock: its comment records no "Reviewed reading/u);

    // A reading nobody can rebuild is a number, not a measurement.
    expect(() => assertDocumentedBudgetMeasurements(
      source.replace("Reviewed reading (Google-Drive-configured): 12,837 B raw / 4,576 B gzip.", "Reviewed reading (my laptop): 12,837 B raw / 4,576 B gzip."),
    )).toThrow(/optionalApprovalDock: its comment attributes a reading to my laptop, which is not a reviewed build variant/u);
  });

  /*
   * The two classes, in the file, with the rules that differ between them.
   */
  it("makes every budget declare its class, and holds Class 1 to every reviewed variant", () => {
    const source = gateSource();
    const entries = parseDocumentedBudgets(source);
    expect(entries).toHaveLength(59);
    for (const entry of entries) {
      expect(entry.declaredClass, entry.name).toBe(releaseBudgetClass(entry.name));
    }
    // The four things a person waits for, and nothing else.
    expect(Object.keys(RELEASE_BUDGET_CLASSES).sort()).toEqual([
      "allJavaScriptAndWorkers",
      "entryCss",
      "entryJavaScript",
      "serviceWorker",
    ]);

    expect(() => assertDocumentedBudgetMeasurements(source.replace("Class 1 — startup: the one module a browser", "Class 2 — on demand: the one module a browser")))
      .toThrow(/entryJavaScript: its comment declares Class 2, but RELEASE_BUDGET_CLASSES puts it in Class 1/u);
    expect(() => assertDocumentedBudgetMeasurements(source.replace("Class 2 — on demand: fetched as the shell mounts", "Fetched as the shell mounts")))
      .toThrow(/optionalApprovalDock: its comment does not say which class it is in/u);

    /*
     * The deployment shape this repository's own Pages workflow publishes — a
     * sub-path and a client ID — was measured by nobody, and nothing could
     * notice because no list said what a full set of variants was.
     */
    expect(REVIEWED_BUILD_VARIANTS.map((variant) => variant.name)).toContain("Pages Google-Drive-configured");
    for (const variant of REVIEWED_BUILD_VARIANTS) {
      expect(variant.environment, variant.name).toContain("npm run build:static");
    }
    const droppedFromEntry = source.replace(
      "Reviewed reading (Pages Google-Drive-configured): 385,672 B raw / 119,778 B gzip.\n",
      "",
    );
    expect(droppedFromEntry).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(droppedFromEntry))
      .toThrow(/entryJavaScript: Class 1, so every reviewed variant must be recorded; missing Pages Google-Drive-configured/u);

    // Class 2 states one variant and that is enough; it is not held to five.
    const approvalDock = entries.find((entry) => entry.name === "optionalApprovalDock");
    expect(approvalDock.readings.length).toBeLessThan(REVIEWED_BUILD_VARIANTS.length);
    expect(() => assertDocumentedBudgetMeasurements(source)).not.toThrow();
  });

  /*
   * A Class 1 ceiling is still the smallest whole-KiB step, or one further step
   * against written arithmetic. A Class 2 ceiling is roomy on purpose — and
   * refused above three headrooms, which is the rule that closes the 24-to-64
   * KiB raise a green gate once accepted.
   */
  it("keeps Class 1 tight and refuses a Class 2 ceiling outside its headroom band", () => {
    const source = gateSource();
    const raised = source.replace(
      "  entryJavaScript: Object.freeze({ raw: 378 * 1024, gzip: 118 * 1024 }),",
      "  entryJavaScript: Object.freeze({ raw: 378 * 1024, gzip: 119 * 1024 }),",
    );
    expect(raised).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(raised))
      .toThrow(/entryJavaScript: the 119\.00 KiB gzip ceiling is above the smallest whole-KiB step/u);

    /*
     * Remove the arithmetic that pays for the step this file does take. The
     * entry chunk used to be the example and stopped being one: its readings
     * crossed the 117 KiB gzip line, so 118 KiB is now the smallest step that
     * clears them and no further step is bought. The service worker still buys
     * its gzip step this way — 4 KiB would have left 362 B, under the width of
     * the compressor itself — and its comment states that arithmetic once, so
     * removing the sentence really does remove the claim.
     */
    const untripped = source.replace("4 KiB gzip would have left 362 B", "4 KiB gzip would have left 999 B");
    expect(untripped).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(untripped))
      .toThrow(/serviceWorker: .* record the matching tripwire arithmetic "4 KiB gzip would have left 362 B"/u);

    for (const [ceiling, expected] of [
      ["raw: 64 * 1024", /optionalApprovalDock: the 64\.00 KiB raw ceiling is outside the Class 2 headroom band/u],
      ["raw: 24 * 1024", /optionalApprovalDock: the 24\.00 KiB raw ceiling is outside the Class 2 headroom band/u],
      ["raw: 13 * 1024", /optionalApprovalDock: the 13\.00 KiB raw ceiling is outside the Class 2 headroom band/u],
    ]) {
      const moved = source.replace(
        "  optionalApprovalDock: Object.freeze({ raw: 17 * 1024, gzip: 9 * 1024 }),",
        `  optionalApprovalDock: Object.freeze({ ${ceiling}, gzip: 9 * 1024 }),`,
      );
      expect(moved, ceiling).not.toBe(source);
      expect(() => assertDocumentedBudgetMeasurements(moved), ceiling).toThrow(expected);
    }
  });

  /*
   * Raw bytes are a byte count. Gzip bytes are whatever this machine's deflate
   * produced: Node 22.22.3 and zlib 1.2.12 differ by up to 388 B on one
   * artifact here, and the tightest gzip margin in this file was 35 B.
   */
  it("refuses a gzip ceiling closer to its artifact than a compressor change moves", () => {
    const source = gateSource();
    const shaved = source.replace(
      "  optionalSessionManifest: Object.freeze({ raw: 10 * 1024, gzip: 7 * 1024 }),",
      "  optionalSessionManifest: Object.freeze({ raw: 10 * 1024, gzip: 3 * 1024 }),",
    );
    expect(shaved).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(shaved))
      .toThrow(/optionalSessionManifest: the gzip ceiling leaves the reviewed reading only 33 B, under the 512 B a compressor change moves/u);

    const recorded = asBuilt(source);
    expect(() => assertDocumentedMeasurementsMatchBuild(source, recorded)).not.toThrow();
    expect(() => assertDocumentedMeasurementsMatchBuild(source, {
      ...recorded,
      optionalSessionManifest: { raw: 5831, gzip: 7168 - 300 },
    })).toThrow(/optionalSessionManifest: the gzip ceiling leaves this build only 300 B, under the 512 B/u);
  });

  /*
   * What a ceiling never told anybody: which change spent the headroom.
   */
  it("refuses a reading that jumped without a sentence naming what was added", () => {
    const source = gateSource();
    const grown = source
      .replace(
        "// Reviewed reading (Google-Drive-configured): 12,837 B raw / 4,576 B gzip.",
        "// Reviewed reading (Google-Drive-configured): 16,837 B raw / 4,576 B gzip.",
      )
      .replace(
        "  optionalApprovalDock: Object.freeze({ raw: 17 * 1024, gzip: 9 * 1024 }),",
        "  optionalApprovalDock: Object.freeze({ raw: 21 * 1024, gzip: 9 * 1024 }),",
      );
    expect(grown).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(grown))
      .toThrow(/optionalApprovalDock: this reading is 4,000 B raw above the previous one, past the 3,209 B growth alarm\. Say what was added, as "Grew 4,000 B raw in one change: <what>\."/u);

    // One sentence, and it has to state the bytes it is explaining.
    const wrongFigure = grown.replace(
      "// Previous reading: 12,837 B raw / 4,575 B gzip.",
      "// Previous reading: 12,837 B raw / 4,575 B gzip. Grew 400 B raw in one change: a second decision row and the line that names it.",
    );
    expect(() => assertDocumentedBudgetMeasurements(wrongFigure)).toThrow(/past the 3,209 B growth alarm/u);
    const declared = grown.replace(
      "// Previous reading: 12,837 B raw / 4,575 B gzip.",
      "// Previous reading: 12,837 B raw / 4,575 B gzip. Grew 4,000 B raw in one change: a second decision row and the line that names it.",
    );
    expect(() => assertDocumentedBudgetMeasurements(declared)).not.toThrow();

    // And the ledger cannot be silenced by deleting the line it compares with.
    const forgotten = source.replace("// Previous reading: 12,837 B raw / 4,575 B gzip.", "//");
    expect(forgotten).not.toBe(source);
    expect(() => assertDocumentedBudgetMeasurements(forgotten))
      .toThrow(/optionalApprovalDock: its comment records no "Previous reading:" line/u);

    // The build side names it too, before the reading has been re-taken at all.
    const recorded = asBuilt(source);
    expect(() => assertDocumentedMeasurementsMatchBuild(source, {
      ...recorded,
      optionalApprovalDock: { raw: 12837 + 5000, gzip: 4576 },
    })).toThrow(/optionalApprovalDock: .* Re-take the reading, and say what added 5,000 B raw/u);
  });

  it("reads a budget justified in a block comment, not only a slash-slash one", () => {
    const source = gateSource();
    const entries = parseDocumentedBudgets(source);
    // `optionalConfirmDialog` is documented in block form and states its class.
    const blockDocumented = entries.find((entry) => entry.name === "optionalConfirmDialog");
    expect(blockDocumented.declaredClass).toBe(2);
    expect(blockDocumented.readings.length).toBeGreaterThan(0);
    // …and it is held to the same rule as the slash-slash ones now that it is read.
    expect(() => assertDocumentedBudgetMeasurements(source.replace("Weighed 1,010 B raw / 594 B gzip", "Measured 91,010 B raw / 594 B gzip")))
      .toThrow(/optionalConfirmDialog: its comment records 91,010 B raw, above the 6\.00 KiB raw ceiling/u);

    // A comment may still quote another surface's figure — several exist
    // *because* the entry chunk breached its own ceiling, and saying so is the
    // justification.
    const overlays = entries.find((entry) => entry.name === "optionalShellOverlays");
    expect(overlays.prose).toContain("110.54 KiB gzip");
  });

  /*
   * Everything else compares a comment to a ceiling, and a ceiling is the one
   * thing a stale-high figure keeps satisfying. This is the pass that sees the
   * artifact, and it now sees every budget rather than sixteen of them.
   */
  it("refuses a recorded reading the build contradicts, in both directions", () => {
    const source = gateSource();
    expect(Object.keys(asRecorded(source))).toHaveLength(58); // every budget but the inlinable one
    const recorded = asBuilt(source);
    expect(() => assertDocumentedMeasurementsMatchBuild(source, recorded)).not.toThrow();

    // A budget this run did not measure is a budget nobody is checking.
    const { optionalMemoryView, ...missing } = recorded;
    expect(() => assertDocumentedMeasurementsMatchBuild(source, missing))
      .toThrow(/optionalMemoryView: every ceiling states a measurement, but this run measured no artifact under that name/u);

    // Byte-level drift is not a failure, and must not be.
    const drifted = Object.fromEntries(
      Object.entries(recorded).map(([name, pair]) => [
        name,
        pair.inlinedInto ? pair : { raw: pair.raw - 128, gzip: pair.gzip - 128 },
      ]),
    );
    expect(() => assertDocumentedMeasurementsMatchBuild(source, drifted)).not.toThrow();

    // Growth past the allowance is: the comment reports headroom nobody has.
    expect(() => assertDocumentedMeasurementsMatchBuild(source, {
      ...recorded,
      optionalMemoryView: { raw: recorded.optionalMemoryView.raw + 769, gzip: recorded.optionalMemoryView.gzip },
    })).toThrow(/optionalMemoryView: its comment records at most .* Re-take the reading/u);

    // And so is a comment a whole class of bytes above the build.
    expect(() => assertDocumentedMeasurementsMatchBuild(source, {
      ...recorded,
      optionalMemoryView: { raw: recorded.optionalMemoryView.raw - 769, gzip: recorded.optionalMemoryView.gzip },
    })).toThrow(/optionalMemoryView: its comment claims .* Re-take the reading/u);

    /*
     * Class 1 straddles whole-KiB lines legitimately: the unconfigured Docker
     * build once landed 1 B below a line the Pages build sat above, and judging
     * it by the Pages figure reported a supported deployment as stale.
     */
    const entry = parseDocumentedBudgets(source).find((budget) => budget.name === "entryJavaScript");
    expect(entry.readings.length).toBeGreaterThan(1);
    for (const reading of entry.readings) {
      expect(() => assertDocumentedMeasurementsMatchBuild(source, {
        ...recorded,
        entryJavaScript: { raw: reading.raw, gzip: reading.gzip },
      }), reading.text).not.toThrow();
    }
  });

  /*
   * One gzip ceiling here was held up by nothing but a reading two passes old
   * that had never been re-phrased as history, and no rule could see it because
   * the budget was not on the opt-in list.
   */
  it("refuses a superseded figure that is still phrased as a measurement", () => {
    const source = gateSource();
    const recorded = asBuilt(source);
    const revived = source.replace(
      "// Re-weighed at 240,348 B raw / 72,441 B gzip after legacy execution was",
      "// Re-measured at 240,348 B raw / 72,441 B gzip after legacy execution was",
    );
    expect(revived).not.toBe(source);
    expect(() => assertDocumentedMeasurementsMatchBuild(revived, recorded))
      .toThrow(/optionalPrimePack: a sentence still phrased as a measurement states 240,348 B raw, which is neither this build .* nor any reviewed reading it records/u);

    // The other direction: prose that still claims to measure a smaller chunk.
    const understated = source.replace(
      "* Weighed 1,010 B raw / 594 B gzip",
      "* Measured 1,010 B raw / 594 B gzip",
    );
    expect(understated).not.toBe(source);
    expect(() => assertDocumentedMeasurementsMatchBuild(understated, {
      ...recorded,
      optionalConfirmDialog: { raw: 1010 + 769, gzip: 594 },
    })).toThrow(/optionalConfirmDialog: the largest figure its prose still presents as a measurement is 1,010 B raw/u);
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

  /*
   * A document is anything a browser will render as one. A suffix test for
   * `.html` shipped `evil.htm`, `EVIL.HTML`, `evil.xhtml` and a script-carrying
   * `evil.svg`, each of them same-origin script inside the release worker's
   * scope on a host that serves no headers.
   */
  it("ships only the reviewed documents, whatever they are called", () => {
    expect(() => assertExactDocumentInventory([...RELEASE_DOCUMENTS, "assets/index-A.js", "manifest.webmanifest"]))
      .not.toThrow();
    for (const stray of [
      "legacy-console.html",
      "legacy-console.htm",
      "LEGACY-CONSOLE.HTML",
      "legacy.xhtml",
      "legacy.shtml",
      "assets/evil.svg",
      "sitemap.xml",
      "stray.xht",
      "stray.shtm",
      "stray.svgz",
      "stray.mhtml",
      "stray.xsl",
      "stray.xslt",
      "stray.hta",
      "stray.html.",
    ]) {
      expect(() => assertExactDocumentInventory([...RELEASE_DOCUMENTS, stray]), stray)
        .toThrow(/Release contains unreviewed documents/u);
    }
  });

  /*
   * Being on the allowlist is not a review. `404.html` is created from the
   * index after the build, so only a byte copy of the reviewed index carries
   * the reviewed policy.
   */
  it("requires the fallback document to be the reviewed index", () => {
    const index = { path: "index.html", payload: Buffer.from("<!doctype html><title>Airship</title>") };
    const asMap = (files) => new Map(files.map((file) => [file.path, file]));
    expect(() => assertFallbackDocumentIsIndex(asMap([index]))).not.toThrow();
    expect(() => assertFallbackDocumentIsIndex(asMap([index, { path: "404.html", payload: index.payload }])))
      .not.toThrow();
    expect(() => assertFallbackDocumentIsIndex(asMap([
      index,
      { path: "404.html", payload: Buffer.from("<!doctype html><script>fetch('https://evil.example')</script>") },
    ]))).toThrow(/404\.html must be a byte copy/u);
  });

  it("charges every dynamic import awaited before first render to the baseline", () => {
    const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    const firstRender = main.indexOf("render(<App />");
    expect(firstRender).toBeGreaterThan(0);
    const preRenderDynamicImports = [...main.matchAll(/\bawait\s+import\("([^"]+)"\)/gu)]
      .filter((match) => match.index < firstRender)
      .map((match) => match[1]);
    expect(preRenderDynamicImports).toEqual(["./controlled-navigation"]);

    const entry = { path: "assets/index-A.js" };
    const controlled = { path: "assets/controlled-navigation-B.js" };
    expect(isControlledNavigationPath(controlled.path)).toBe(true);
    expect(isBaselineJavaScriptPath(controlled.path)).toBe(true);
    expect(() => assertRequiredFilesAreMeasured(
      "Required pre-render JavaScript",
      [entry, controlled],
      [entry],
    )).toThrow(/escaped its release measurement: assets\/controlled-navigation-B\.js/u);
    expect(() => assertRequiredFilesAreMeasured(
      "Required pre-render JavaScript",
      [entry, controlled],
      [entry, controlled],
    )).not.toThrow();
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

  it("refuses a release that carries the host-composed loopback lab", () => {
    const clean = [
      { path: "assets/index-A.js", payload: Buffer.from("export const airship = 1;") },
      { path: "assets/deferred-capabilities-A.js", payload: Buffer.from("Google Drive") },
      { path: "assets/local-device-vault-setup-A.js", payload: Buffer.from("Local Device") },
    ];
    expect(() => assertStockReleaseExcludesLocalLab(clean)).not.toThrow();

    // Every sentinel, one at a time, in the artifact class that can carry it.
    for (const [label, sentinel] of LOCAL_LAB_RELEASE_SENTINELS) {
      const planted = typeof sentinel === "string"
        ? [...clean, { path: "assets/index-A.js", payload: Buffer.from(`x${sentinel}y`) }]
        : [...clean, { path: "assets/local-lab-setup-A.js", payload: Buffer.from("x") }];
      expect(() => assertStockReleaseExcludesLocalLab(planted), label)
        .toThrow(/must not contain the host-composed loopback storage lab/iu);
    }

    // The orphan chunk that started this: emitted, referenced by nothing, and
    // shipped anyway. A path match alone has to fail the release.
    expect(() => assertStockReleaseExcludesLocalLab([
      { path: "assets/local-lab-vault-A.js", payload: Buffer.from("") },
    ])).toThrow(/lab chunk/iu);
    expect(() => assertStockReleaseExcludesLocalLab([
      { path: "assets/local-lab-setup-A.css", payload: Buffer.from("") },
    ])).toThrow(/lab chunk/iu);
    // A same-prefixed name that is not the lab must still pass.
    expect(() => assertStockReleaseExcludesLocalLab([
      { path: "assets/local-device-keyring-A.js", payload: Buffer.from("") },
    ])).not.toThrow();
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
  /*
   * A source map is what it contains, not what it is called. `index.js.map.txt`
   * is a complete v3 map with its source contents; it passed every check here
   * and was written into the manifest with a checksum, which reads as review.
   */
  it("rejects a source map payload whatever the file is called", () => {
    const map = Buffer.from(JSON.stringify({
      version: 3,
      file: "index.js",
      sources: ["../src/ui/app.tsx"],
      sourcesContent: ["export const secretIntent = () => 'the unminified original';"],
      names: [],
      mappings: "AAAA,SAAS,CAAC",
    }));
    expect(inspectPayload("assets/index.js.map", map)).toContain("production source map");
    expect(inspectPayload("assets/index.js.map.txt", map))
      .toContain("production source map payload under another name");
    expect(inspectPayload("assets/index.js.map.txt", map)).not.toContain("production source map");
    // And ordinary artifacts are not source maps because they mention a word.
    expect(inspectPayload("assets/index-A.js", Buffer.from('const mappings = { version: 3 };'))).toEqual([]);
    expect(inspectPayload("execution-packs/pyodide/pyodide-lock.json", Buffer.from('{"version":"3","packages":{}}'))).toEqual([]);
  });

  /*
   * Every file, not every document. A release could carry any non-document,
   * non-JavaScript file at all and be inventoried into the manifest with a
   * checksum, which reads as review.
   */
  it("refuses any shipped file no artifact class reviews", () => {
    const shipped = [
      "index.html",
      "404.html",
      "_headers",
      "favicon.svg",
      "manifest.webmanifest",
      "release-manifest.json",
      "semantic-pack-state.json",
      "sw.js",
      "assets/index-DEADBEEF.js",
      "assets/index-DEADBEEF.css",
      "assets/BBgPowaH.prime-kernel-worker.js",
      "assets/tree-sitter-DEADBEEF.wasm",
      "execution-packs/pyodide/pyodide.asm.wasm",
      "semantic-pack/v1/model.onnx",
      "extension/index.html",
      "extension/install.js",
      "extension/releases/SHA256SUMS",
    ];
    expect(() => assertEveryArtifactIsClassified(shipped)).not.toThrow();
    expect(RELEASE_ARTIFACT_CLASSES.length).toBeGreaterThan(0);
    for (const stray of [
      "assets/index.js.map.txt",
      "assets/index-DEADBEEF.js.bak",
      "notes.txt",
      ".env",
      "assets/.DS_Store",
      "backup/index.html",
    ]) {
      expect(() => assertEveryArtifactIsClassified([...shipped, stray]), stray)
        .toThrow(/Release contains files no artifact class reviews/u);
    }
  });

  /*
   * "Pinned" was a version string in `node_modules`, and the ceiling that
   * quoted it summed five paths with 3.2 MB of headroom. So the WASM could be
   * rewritten in place at the same length, a 5 MB file could be added beside
   * it, and a lab literal could be hidden in it — the lab scan skips this
   * directory by name — all with a green gate.
   */
  it("pins the Pyodide distribution by digest, and refuses a sixth file beside it", () => {
    const pinned = PYODIDE_DISTRIBUTION_PINS.map((pin) => ({
      path: pin.path,
      payload: pyodidePayloads.get(pin.path),
    }));
    expect(PYODIDE_DISTRIBUTION_PINS).toHaveLength(5);
    for (const pin of PYODIDE_DISTRIBUTION_PINS) {
      expect(pin.sha256, pin.path).toMatch(/^[0-9a-f]{64}$/u);
      expect(pin.bytes, pin.path).toBeGreaterThan(0);
    }
    expect(() => assertPinnedPyodideDistribution(pinned)).not.toThrow();

    const mutated = pinned.map((file) => (file.path.endsWith(".wasm")
      ? { path: file.path, payload: Buffer.concat([file.payload.subarray(0, 8), Buffer.from("TAMPERED"), file.payload.subarray(16)]) }
      : file));
    expect(() => assertPinnedPyodideDistribution(mutated))
      .toThrow(/pyodide\.asm\.wasm is not the pinned bytes/u);

    expect(() => assertPinnedPyodideDistribution([
      ...pinned,
      { path: "execution-packs/pyodide/payload.bin", payload: Buffer.alloc(4096) },
    ])).toThrow(/unreviewed file in the pinned distribution: execution-packs\/pyodide\/payload\.bin/u);

    expect(() => assertPinnedPyodideDistribution(pinned.slice(1)))
      .toThrow(/missing pinned file: /u);
  });

  /*
   * JavaScript under `assets/` needs exactly one owner and documents have an
   * exact inventory; stylesheets had neither, so a 5 MB `assets/extra.css`
   * shipped with a checksum in the manifest and no ceiling that counted it.
   */
  it("refuses a stylesheet nothing in the build references", () => {
    const entry = { path: "assets/index-DEADBEEF.css", payload: Buffer.from("body{}") };
    const referenced = { path: "assets/memory-view-C0FFEE.css", payload: Buffer.from(".memory{}") };
    const carrier = { path: "assets/memory-view-D00D.js", payload: Buffer.from('import "./memory-view-C0FFEE.css";') };
    const index = { path: "index.html", payload: Buffer.from('<link rel="stylesheet" href="/assets/index-DEADBEEF.css">') };
    const shipped = [entry, referenced, carrier, index];
    expect(() => assertEveryStylesheetIsReferenced(shipped, entry.path)).not.toThrow();

    const stray = { path: "assets/extra.css", payload: Buffer.alloc(5 * 1024 * 1024) };
    expect(() => assertEveryStylesheetIsReferenced([...shipped, stray], entry.path))
      .toThrow(/Release contains stylesheets nothing references: assets\/extra\.css/u);
  });

  /*
   * The mirror ran one way: a row naming no ceiling failed, a ceiling named by
   * no row did not, and twenty-six budgets were absent from the document a
   * reviewer consults.
   */
  it("mirrors every ceiling and its class into the documentation, both ways", () => {
    const doc = readFileSync(new URL("../docs/RELEASE_GATE.md", import.meta.url), "utf8");
    expect(() => assertReleaseGateDocumentationMirrors(doc)).not.toThrow();
    expect(DOCUMENTED_BUDGET_ROWS.flatMap((row) => row.budgets).sort())
      .toEqual(Object.keys(RELEASE_BUDGETS).sort());

    const dropped = doc.replace(/^\| Optional approval dock \|.*$\n/mu, "");
    expect(dropped).not.toBe(doc);
    expect(() => assertReleaseGateDocumentationMirrors(dropped))
      .toThrow(/the table has no row for "Optional approval dock"/u);

    const wrongTier = doc.replace("| Optional approval dock | 2 |", "| Optional approval dock | 1 |");
    expect(wrongTier).not.toBe(doc);
    expect(() => assertReleaseGateDocumentationMirrors(wrongTier))
      .toThrow(/"Optional approval dock" tier: the table says 1, the class is 2/u);

    const wrongCeiling = doc.replace("| Optional approval dock | 2 | 17 KiB |", "| Optional approval dock | 2 | 64 KiB |");
    expect(wrongCeiling).not.toBe(doc);
    expect(() => assertReleaseGateDocumentationMirrors(wrongCeiling))
      .toThrow(/"Optional approval dock" raw: the table says 64\.00 KiB for optionalApprovalDock, the ceiling is 17\.00 KiB/u);

    const noTierColumn = doc.replace("| Class | Tier | Raw ceiling | Gzip ceiling |", "| Class | Raw ceiling | Gzip ceiling |");
    expect(() => assertReleaseGateDocumentationMirrors(noTierColumn))
      .toThrow(/no longer carries a `Tier` column/u);
  });

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

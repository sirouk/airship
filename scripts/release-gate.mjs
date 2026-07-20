import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(root, "dist");

export const RELEASE_MANIFEST_NAME = "release-manifest.json";

export const RELEASE_BUDGETS = Object.freeze({
  entryJavaScript: Object.freeze({ raw: 384 * 1024, gzip: 110 * 1024 }),
  // Trust composition adds ~1.8 KiB gzip to the baseline while the actual
  // entry remains below its stricter 110 KiB limit. Heavy QVL stays deferred.
  allJavaScriptAndWorkers: Object.freeze({ raw: 640 * 1024, gzip: 132 * 1024 }),
  deferredCapabilities: Object.freeze({ raw: 384 * 1024, gzip: 110 * 1024 }),
  // Full-route ceiling, not startup cost: includes the independently loaded
  // Editor, Git, Sessions, Terminal and attestation surfaces.
  totalJavaScriptAndWorkers: Object.freeze({ raw: 1664 * 1024, gzip: 384 * 1024 }),
  // The independently loaded offline shell worker is not application-bundle
  // startup cost. Keep it visible under a dedicated, deliberately small cap.
  serviceWorker: Object.freeze({ raw: 12 * 1024, gzip: 4 * 1024 }),
  optionalExecutionPack: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  optionalNodeExecutionPack: Object.freeze({ raw: 32 * 1024, gzip: 8 * 1024 }),
  // Files/editor shell plus its in-page source-control handoff. Git remains a
  // second lazy pack; this cap covers only the combined Editor route chrome.
  optionalWorkspaceWorkbench: Object.freeze({ raw: 28 * 1024, gzip: 10 * 1024 }),
  optionalSourceControl: Object.freeze({ raw: 48 * 1024, gzip: 14 * 1024 }),
  optionalSessionLibrary: Object.freeze({ raw: 48 * 1024, gzip: 14 * 1024 }),
  // Official xterm.js is isolated behind the Terminal route and is never part
  // of initial navigation or a background capability probe.
  optionalTerminal: Object.freeze({ raw: 384 * 1024, gzip: 100 * 1024 }),
  // Protocol host only. The reviewed Transformers/ORT/model artifacts remain
  // a separately mounted same-origin semantic pack and are never preloaded.
  optionalSemanticWorker: Object.freeze({ raw: 16 * 1024, gzip: 6 * 1024 }),
  // Model catalog + utilization normalization is loaded only when provider
  // discovery opens and is enforced separately from the interactive app.
  optionalModelCatalog: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  optionalDcapQvlJavaScript: Object.freeze({ raw: 32 * 1024, gzip: 8 * 1024 }),
  optionalDcapQvlWasm: Object.freeze({ raw: 1536 * 1024, gzip: 512 * 1024 }),
  optionalPythonPack: Object.freeze({ raw: 16 * 1024 * 1024, gzip: 8 * 1024 * 1024 }),
  entryCss: Object.freeze({ raw: 160 * 1024, gzip: 32 * 1024 }),
  eachWasm: Object.freeze({ raw: 1024 * 1024, gzip: 350 * 1024 }),
  allWasm: Object.freeze({ raw: 1024 * 1024, gzip: 350 * 1024 }),
});

const secretPatterns = Object.freeze([
  ["Chutes client secret", /\bcsc_[A-Za-z0-9_-]{16,}\b/u],
  ["Chutes user credential", /\bcak_[A-Za-z0-9_-]{16,}\b/u],
  ["Chutes inference key", /\bcpk_[A-Za-z0-9_-]{16,}\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["npm token", /\bnpm_[A-Za-z0-9]{24,}\b/u],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["Stripe live secret", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u],
  ["PEM private key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u],
  ["long bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}\b/u],
]);

const sourceMapDirective = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/u;
const PYODIDE_ASSET_PATHS = Object.freeze([
  "execution-packs/pyodide/pyodide.mjs",
  "execution-packs/pyodide/pyodide.asm.mjs",
  "execution-packs/pyodide/pyodide.asm.wasm",
  "execution-packs/pyodide/pyodide-lock.json",
  "execution-packs/pyodide/python_stdlib.zip",
]);

export function inspectPayload(path, payload) {
  const findings = [];
  if (/\.map(?:\.(?:br|gz))?$/u.test(path)) findings.push("production source map");
  const text = `${path}\0${payload.toString("utf8")}`;
  if (sourceMapDirective.test(text)) findings.push("sourceMappingURL directive");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) findings.push(label);
  }
  return Object.freeze(findings);
}

export function createReleaseManifest(artifacts) {
  return Object.freeze({
    schema: "airship.release-manifest.v1",
    hashAlgorithm: "sha256",
    signed: false,
    artifacts: Object.freeze(
      [...artifacts]
        .sort((left, right) => compareText(left.path, right.path))
        .map((artifact) =>
          Object.freeze({
            path: artifact.path,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          }),
        ),
    ),
  });
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function assertWithinBudget(label, measurement, budget) {
  const exceeded = [];
  if (measurement.raw > budget.raw) {
    exceeded.push(`raw ${formatBytes(measurement.raw)} > ${formatBytes(budget.raw)}`);
  }
  if (measurement.gzip > budget.gzip) {
    exceeded.push(`gzip ${formatBytes(measurement.gzip)} > ${formatBytes(budget.gzip)}`);
  }
  if (exceeded.length > 0) throw new Error(`${label} exceeds its release budget: ${exceeded.join(", ")}.`);
}

export async function runReleaseGate(outputDirectory = defaultOutput) {
  const output = resolve(outputDirectory);
  const files = await collectFiles(output);
  const manifestPath = posix.normalize(RELEASE_MANIFEST_NAME);
  const releasableFiles = files.filter((file) => file.path !== manifestPath);
  const failures = [];

  for (const file of releasableFiles) {
    for (const finding of inspectPayload(file.path, file.payload)) {
      failures.push(`${redactSensitiveText(file.path)}: ${finding}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Release payload rejected:\n- ${failures.join("\n- ")}`);
  }

  const required = ["_headers", "favicon.svg", "index.html", "manifest.webmanifest", "sw.js"];
  const fileMap = new Map(releasableFiles.map((file) => [file.path, file]));
  for (const path of required) {
    if (!fileMap.has(path)) throw new Error(`Required static artifact is missing: ${path}.`);
  }

  await validatePublicCopies(output, required.filter((path) => path !== "index.html"));
  const headers = fileMap.get("_headers").payload.toString("utf8");
  const index = fileMap.get("index.html").payload.toString("utf8");
  validateHeaders(headers);
  validateBuiltCsp(index, headers);
  assertOptionalPacksAreNotPreloaded(index);
  validateWebManifest(fileMap.get("manifest.webmanifest").payload.toString("utf8"), index);
  validateServiceWorker(fileMap.get("sw.js").payload.toString("utf8"));

  const entries = parseHtmlEntries(index);
  if (entries.scripts.length !== 1) {
    throw new Error(`Production index must load exactly one module entry; found ${entries.scripts.length}.`);
  }
  if (entries.styles.length !== 1) {
    throw new Error(`Production index must load exactly one stylesheet entry; found ${entries.styles.length}.`);
  }
  const entryJavaScript = requireAsset(fileMap, entries.scripts[0], ".js");
  const initialJavaScriptFiles = [
    entryJavaScript,
    ...entries.modulePreloads.map((url) => requireAsset(fileMap, url, ".js")),
  ].filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index);
  const entryCss = requireAsset(fileMap, entries.styles[0], ".css");
  const pyodideFiles = PYODIDE_ASSET_PATHS.map((path) => requireReleaseFile(fileMap, path));
  const wasmFiles = releasableFiles.filter((file) => file.path.endsWith(".wasm") && !isOptionalPythonPackPath(file.path));
  if (wasmFiles.length === 0) throw new Error("The production build is missing the Chutes crypto WASM artifact.");

  const entryJavaScriptMeasurement = measure(entryJavaScript.payload);
  const initialJavaScriptMeasurement = sumMeasurements(initialJavaScriptFiles.map((file) => measure(file.payload)));
  const entryCssMeasurement = measure(entryCss.payload);
  const serviceWorker = requireReleaseFile(fileMap, "sw.js");
  const serviceWorkerMeasurement = measure(serviceWorker.payload);
  const javaScriptFiles = releasableFiles.filter(
    (file) => (file.path.endsWith(".js") || file.path.endsWith(".mjs"))
      && file.path !== "sw.js"
      && !isOptionalPythonPackPath(file.path),
  );
  const optionalExecutionPacks = javaScriptFiles.filter((file) => isOptionalExecutionPackPath(file.path));
  if (optionalExecutionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution pack; found ${optionalExecutionPacks.length}.`);
  }
  const optionalExecutionPackMeasurement = measure(optionalExecutionPacks[0].payload);
  const optionalNodeExecutionPacks = javaScriptFiles.filter((file) => isOptionalNodeExecutionPackPath(file.path));
  if (optionalNodeExecutionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Node execution pack; found ${optionalNodeExecutionPacks.length}.`);
  }
  const optionalNodeExecutionPackMeasurement = measure(optionalNodeExecutionPacks[0].payload);
  const optionalWorkspaceWorkbenchPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceWorkbenchPath(file.path));
  if (optionalWorkspaceWorkbenchPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Workspace workbench pack; found ${optionalWorkspaceWorkbenchPacks.length}.`);
  }
  const optionalWorkspaceWorkbenchMeasurement = measure(optionalWorkspaceWorkbenchPacks[0].payload);
  const optionalSourceControlPacks = javaScriptFiles.filter((file) => isOptionalSourceControlPath(file.path));
  if (optionalSourceControlPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional source-control pack; found ${optionalSourceControlPacks.length}.`);
  }
  const optionalSourceControlMeasurement = measure(optionalSourceControlPacks[0].payload);
  const optionalSessionLibraryPacks = javaScriptFiles.filter((file) => isOptionalSessionLibraryPath(file.path));
  if (optionalSessionLibraryPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional session-library pack; found ${optionalSessionLibraryPacks.length}.`);
  }
  const optionalSessionLibraryMeasurement = measure(optionalSessionLibraryPacks[0].payload);
  const optionalTerminalPacks = javaScriptFiles.filter((file) => isOptionalTerminalPath(file.path));
  if (optionalTerminalPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Terminal pack; found ${optionalTerminalPacks.length}.`);
  }
  const optionalTerminalMeasurement = measure(optionalTerminalPacks[0].payload);
  const optionalSemanticWorkerPacks = javaScriptFiles.filter((file) => isOptionalSemanticWorkerPath(file.path));
  if (optionalSemanticWorkerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional semantic worker; found ${optionalSemanticWorkerPacks.length}.`);
  }
  const optionalSemanticWorkerMeasurement = measure(optionalSemanticWorkerPacks[0].payload);
  const optionalModelCatalogPacks = javaScriptFiles.filter((file) => isOptionalModelCatalogPath(file.path));
  if (optionalModelCatalogPacks.length !== 2) {
    throw new Error(`Production must contain exactly two optional model-catalog packs; found ${optionalModelCatalogPacks.length}.`);
  }
  const optionalModelCatalogMeasurement = sumMeasurements(optionalModelCatalogPacks.map((file) => measure(file.payload)));
  const optionalDcapQvlPacks = javaScriptFiles.filter((file) => isOptionalDcapQvlPath(file.path));
  if (optionalDcapQvlPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional DCAP QVL JavaScript pack; found ${optionalDcapQvlPacks.length}.`);
  }
  const optionalDcapQvlJavaScriptMeasurement = measure(optionalDcapQvlPacks[0].payload);
  const optionalDcapQvlWasmFiles = wasmFiles.filter((file) => isOptionalDcapQvlWasmPath(file.path));
  if (optionalDcapQvlWasmFiles.length !== 1) {
    throw new Error(`Production must contain exactly one optional DCAP QVL WASM pack; found ${optionalDcapQvlWasmFiles.length}.`);
  }
  const optionalDcapQvlWasmMeasurement = measure(optionalDcapQvlWasmFiles[0].payload);
  const deferredCapabilityPacks = javaScriptFiles.filter((file) => isDeferredCapabilityPackPath(file.path));
  if (deferredCapabilityPacks.length !== 1) {
    throw new Error(`Production must contain exactly one deferred capability pack; found ${deferredCapabilityPacks.length}.`);
  }
  const deferredCapabilityMeasurement = measure(deferredCapabilityPacks[0].payload);
  const optionalPythonPackMeasurement = sumMeasurements(pyodideFiles.map((file) => measure(file.payload)));
  const baselineJavaScriptFiles = javaScriptFiles.filter(
    (file) => !isOptionalExecutionPackPath(file.path)
      && !isOptionalNodeExecutionPackPath(file.path)
      && !isOptionalWorkspaceWorkbenchPath(file.path)
      && !isOptionalSourceControlPath(file.path)
      && !isOptionalSessionLibraryPath(file.path)
      && !isOptionalTerminalPath(file.path)
      && !isOptionalSemanticWorkerPath(file.path)
      && !isOptionalModelCatalogPath(file.path)
      && !isOptionalDcapQvlPath(file.path)
      && !isDeferredCapabilityPackPath(file.path),
  );
  const baselineJavaScriptMeasurement = sumMeasurements(baselineJavaScriptFiles.map((file) => measure(file.payload)));
  const totalJavaScriptMeasurement = sumMeasurements(
    javaScriptFiles.filter((file) => !isOptionalModelCatalogPath(file.path)).map((file) => measure(file.payload)),
  );
  const baselineWasmFiles = wasmFiles.filter((file) => !isOptionalDcapQvlWasmPath(file.path));
  const allWasmMeasurement = sumMeasurements(baselineWasmFiles.map((file) => measure(file.payload)));

  assertWithinBudget("Entry JavaScript", entryJavaScriptMeasurement, RELEASE_BUDGETS.entryJavaScript);
  assertWithinBudget(
    "Baseline JavaScript and workers",
    baselineJavaScriptMeasurement,
    RELEASE_BUDGETS.allJavaScriptAndWorkers,
  );
  assertWithinBudget(
    "Optional execution pack",
    optionalExecutionPackMeasurement,
    RELEASE_BUDGETS.optionalExecutionPack,
  );
  assertWithinBudget(
    "Optional Node execution pack",
    optionalNodeExecutionPackMeasurement,
    RELEASE_BUDGETS.optionalNodeExecutionPack,
  );
  assertWithinBudget(
    "Optional Workspace workbench",
    optionalWorkspaceWorkbenchMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceWorkbench,
  );
  assertWithinBudget("Optional source control", optionalSourceControlMeasurement, RELEASE_BUDGETS.optionalSourceControl);
  assertWithinBudget("Optional session library", optionalSessionLibraryMeasurement, RELEASE_BUDGETS.optionalSessionLibrary);
  assertWithinBudget("Optional Terminal", optionalTerminalMeasurement, RELEASE_BUDGETS.optionalTerminal);
  assertWithinBudget("Optional semantic worker", optionalSemanticWorkerMeasurement, RELEASE_BUDGETS.optionalSemanticWorker);
  assertWithinBudget(
    "Optional model catalog",
    optionalModelCatalogMeasurement,
    RELEASE_BUDGETS.optionalModelCatalog,
  );
  assertWithinBudget(
    "Optional DCAP QVL JavaScript",
    optionalDcapQvlJavaScriptMeasurement,
    RELEASE_BUDGETS.optionalDcapQvlJavaScript,
  );
  assertWithinBudget(
    "Optional DCAP QVL WASM",
    optionalDcapQvlWasmMeasurement,
    RELEASE_BUDGETS.optionalDcapQvlWasm,
  );
  assertWithinBudget(
    "Deferred capability pack",
    deferredCapabilityMeasurement,
    RELEASE_BUDGETS.deferredCapabilities,
  );
  assertWithinBudget(
    "Total JavaScript and workers",
    totalJavaScriptMeasurement,
    RELEASE_BUDGETS.totalJavaScriptAndWorkers,
  );
  assertWithinBudget("Service worker", serviceWorkerMeasurement, RELEASE_BUDGETS.serviceWorker);
  assertWithinBudget("Optional Python pack", optionalPythonPackMeasurement, RELEASE_BUDGETS.optionalPythonPack);
  assertWithinBudget("Entry CSS", entryCssMeasurement, RELEASE_BUDGETS.entryCss);
  for (const wasm of baselineWasmFiles) {
    assertWithinBudget(`WASM ${wasm.path}`, measure(wasm.payload), RELEASE_BUDGETS.eachWasm);
  }
  assertWithinBudget("All WASM", allWasmMeasurement, RELEASE_BUDGETS.allWasm);

  const artifacts = releasableFiles.map((file) => ({
    path: file.path,
    bytes: file.payload.byteLength,
    sha256: createHash("sha256").update(file.payload).digest("hex"),
  }));
  const manifest = createReleaseManifest(artifacts);
  const serialized = serializeReleaseManifest(manifest);
  await writeFile(resolve(output, RELEASE_MANIFEST_NAME), serialized, { encoding: "utf8", mode: 0o644 });
  const written = await readFile(resolve(output, RELEASE_MANIFEST_NAME), "utf8");
  if (written !== serialized) throw new Error("Release manifest changed while it was being written.");

  return Object.freeze({
    manifest,
    manifestPath: resolve(output, RELEASE_MANIFEST_NAME),
    measurements: Object.freeze({
      entryJavaScript: entryJavaScriptMeasurement,
      initialJavaScriptAndPreloads: initialJavaScriptMeasurement,
      allJavaScriptAndWorkers: baselineJavaScriptMeasurement,
      baselineJavaScriptAndWorkers: baselineJavaScriptMeasurement,
      optionalExecutionPack: Object.freeze({ path: optionalExecutionPacks[0].path, ...optionalExecutionPackMeasurement }),
      optionalNodeExecutionPack: Object.freeze({
        path: optionalNodeExecutionPacks[0].path,
        ...optionalNodeExecutionPackMeasurement,
      }),
      optionalWorkspaceWorkbench: Object.freeze({
        path: optionalWorkspaceWorkbenchPacks[0].path,
        ...optionalWorkspaceWorkbenchMeasurement,
      }),
      optionalSourceControl: Object.freeze({
        path: optionalSourceControlPacks[0].path,
        ...optionalSourceControlMeasurement,
      }),
      optionalSessionLibrary: Object.freeze({
        path: optionalSessionLibraryPacks[0].path,
        ...optionalSessionLibraryMeasurement,
      }),
      optionalTerminal: Object.freeze({ path: optionalTerminalPacks[0].path, ...optionalTerminalMeasurement }),
      optionalSemanticWorker: Object.freeze({ path: optionalSemanticWorkerPacks[0].path, ...optionalSemanticWorkerMeasurement }),
      optionalModelCatalog: Object.freeze({
        paths: Object.freeze(optionalModelCatalogPacks.map((file) => file.path)),
        ...optionalModelCatalogMeasurement,
      }),
      optionalDcapQvlJavaScript: Object.freeze({
        path: optionalDcapQvlPacks[0].path,
        ...optionalDcapQvlJavaScriptMeasurement,
      }),
      optionalDcapQvlWasm: Object.freeze({
        path: optionalDcapQvlWasmFiles[0].path,
        ...optionalDcapQvlWasmMeasurement,
      }),
      deferredCapabilities: Object.freeze({
        path: deferredCapabilityPacks[0].path,
        ...deferredCapabilityMeasurement,
      }),
      optionalPythonPack: optionalPythonPackMeasurement,
      totalJavaScriptAndWorkers: totalJavaScriptMeasurement,
      serviceWorker: Object.freeze({ path: serviceWorker.path, ...serviceWorkerMeasurement }),
      entryCss: entryCssMeasurement,
      allWasm: allWasmMeasurement,
      wasm: Object.freeze(wasmFiles.map((file) => Object.freeze({ path: file.path, ...measure(file.payload) }))),
    }),
  });
}

export function isOptionalExecutionPackPath(path) {
  return /^assets\/execution-runtime-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalDcapQvlPath(path) {
  return /^assets\/airship_dcap_qvl-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalDcapQvlWasmPath(path) {
  return /^assets\/airship_dcap_qvl_bg-[A-Za-z0-9_-]+\.wasm$/u.test(path);
}

export function isOptionalNodeExecutionPackPath(path) {
  return /^assets\/node-webcontainer-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceWorkbenchPath(path) {
  return /^assets\/editor-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSourceControlPath(path) {
  return /^assets\/sources-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSessionLibraryPath(path) {
  return /^assets\/sessions-route-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalTerminalPath(path) {
  return /^assets\/terminal-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSemanticWorkerPath(path) {
  return /^assets\/semantic\.worker-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalModelCatalogPath(path) {
  return /^assets\/(?:client-runtime|telemetry)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isDeferredCapabilityPackPath(path) {
  return /^assets\/deferred-capabilities-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalPythonPackPath(path) {
  return path.startsWith("execution-packs/pyodide/");
}

export function assertOptionalPacksAreNotPreloaded(index) {
  if (/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/assets\/(?:deferred-capabilities|execution-runtime-pack|node-webcontainer-pack|editor-view|sources-view|sessions-route|terminal-view|semantic\.worker|client-runtime|telemetry)-/u.test(index)) {
    throw new Error("Production HTML must not preload deferred capability or optional execution packs.");
  }
}

async function collectFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release output contains a symbolic link: ${toPosix(base, absolute)}.`);
    if (info.isDirectory()) {
      files.push(...(await collectFiles(absolute, base)));
      continue;
    }
    if (!info.isFile()) throw new Error(`Release output contains a non-file artifact: ${toPosix(base, absolute)}.`);
    files.push(Object.freeze({ path: toPosix(base, absolute), payload: await readFile(absolute) }));
  }
  return files;
}

async function validatePublicCopies(output, paths) {
  for (const path of paths) {
    const [source, built] = await Promise.all([
      readFile(resolve(root, "public", path)),
      readFile(resolve(output, path)),
    ]);
    if (!source.equals(built)) throw new Error(`Vite changed the reviewed public artifact: ${path}.`);
  }
}

function validateHeaders(headers) {
  const requirements = [
    ["root Content-Security-Policy", /^\s{2}Content-Security-Policy:/mu],
    ["cross-origin embedder isolation", /^\s{2}Cross-Origin-Embedder-Policy:\s*credentialless\s*$/mu],
    ["cross-origin opener isolation", /^\s{2}Cross-Origin-Opener-Policy:\s*same-origin\s*$/mu],
    ["MIME sniffing protection", /^\s{2}X-Content-Type-Options:\s*nosniff\s*$/mu],
    ["immutable hashed assets", /\/assets\/\*[\s\S]*?Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/u],
    ["service-worker revalidation", /\/sw\.js[\s\S]*?Cache-Control:\s*no-cache/u],
    ["root service-worker scope", /\/sw\.js[\s\S]*?Service-Worker-Allowed:\s*\//u],
    ["release-manifest revalidation", /\/release-manifest\.json[\s\S]*?Cache-Control:\s*no-cache/u],
  ];
  for (const [label, pattern] of requirements) {
    if (!pattern.test(headers)) throw new Error(`Static headers are missing ${label}.`);
  }
}

function validateWebManifest(source, index) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error("Web app manifest is not valid JSON.");
  }
  const rootManifest = manifest.id === "/" && manifest.start_url === "/" && manifest.scope === "/";
  const relativeManifest = manifest.id === "." && manifest.start_url === "./" && manifest.scope === "./";
  if (!rootManifest && !relativeManifest) {
    throw new Error("Web app manifest id, start_url, and scope must remain aligned same-origin paths.");
  }
  if (manifest.display !== "standalone") throw new Error("Web app manifest must remain installable in standalone mode.");
  if (
    !Array.isArray(manifest.icons) ||
    manifest.icons.length === 0 ||
    manifest.icons.some((icon) => !icon || !["/favicon.svg", "favicon.svg"].includes(icon.src))
  ) {
    throw new Error("Web app manifest icons must use the reviewed same-origin favicon.");
  }
  if (!/<link\b[^>]*\brel="manifest"[^>]*\bhref="\/(?:[A-Za-z0-9._~-]+\/)*manifest\.webmanifest"[^>]*>/u.test(index)) {
    throw new Error("Built index does not reference the reviewed web app manifest.");
  }
  if (!/<link\b[^>]*\brel="icon"[^>]*\bhref="\/(?:[A-Za-z0-9._~-]+\/)*favicon\.svg"[^>]*>/u.test(index)) {
    throw new Error("Built index does not reference the reviewed same-origin icon.");
  }
}

function validateBuiltCsp(index, headers) {
  const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
  const header = /^\s*Content-Security-Policy:\s*(.+)$/mu.exec(headers)?.[1];
  if (!meta || !header) throw new Error("Built index and headers must both contain a Content-Security-Policy.");
  const metaDirectives = parsePolicy(meta);
  const headerDirectives = parsePolicy(header);
  const comparableHeaders = new Map(headerDirectives);
  comparableHeaders.delete("frame-ancestors");
  if (serializePolicy(metaDirectives) !== serializePolicy(comparableHeaders)) {
    throw new Error("Built index and response-header CSP directives diverge.");
  }
  if (headerDirectives.get("frame-ancestors") !== "'none'") {
    throw new Error("Built response-header CSP must deny all frame ancestors.");
  }
  const connections = metaDirectives.get("connect-src")?.split(/\s+/u) ?? [];
  if (connections.includes("https:") || connections.some((source) => source.includes("*"))) {
    throw new Error("Built connect-src must contain only exact origins.");
  }
}

function parsePolicy(value) {
  return new Map(
    value
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...tokens] = directive.split(/\s+/u);
        return [name, tokens.join(" ")];
      }),
  );
}

function serializePolicy(policy) {
  return [...policy.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => `${name} ${value}`)
    .join(";");
}

function validateServiceWorker(source) {
  const requirements = [
    ["versioned cache", /const CACHE_VERSION = "airship-shell-v\d+";/u],
    ["release-manifest precache", /fetch\((?:"\/release-manifest\.json"|scopedPath\("release-manifest\.json"\))[\s\S]*?manifest\.artifacts[\s\S]*?cache\.addAll\(\[\.\.\.SHELL, \.\.\.new Set\(assets\)\]\)/u],
    ["same-origin boundary", /requestUrl\.origin !== self\.location\.origin/u],
    ["GET-only cache boundary", /event\.request\.method !== "GET"/u],
    ["authorization bypass", /headers\.has\("authorization"\)/u],
    ["range bypass", /headers\.has\("range"\)/u],
    ["network-first navigation", /request\.mode === "navigate"[\s\S]*?fetch\(event\.request\)[\s\S]*?caches\.match\((?:"\/"|BASE_PATH)\)/u],
    ["hashed asset scope", /pathname\.startsWith\((?:"\/assets\/"|scopedPath\("assets\/"\))\)/u],
    ["Set-Cookie exclusion", /!response\.headers\.has\("set-cookie"\)/u],
  ];
  for (const [label, pattern] of requirements) {
    if (!pattern.test(source)) throw new Error(`Service worker is missing its ${label} invariant.`);
  }
  const rootShell = ["/", "/manifest.webmanifest", "/favicon.svg"].every((path) => source.includes(JSON.stringify(path)));
  const scopedShell = /const SHELL = \[BASE_PATH, scopedPath\("manifest\.webmanifest"\), scopedPath\("favicon\.svg"\)\];/u.test(source);
  if (!rootShell && !scopedShell) {
    throw new Error("Service-worker shell is missing its reviewed root or scoped paths.");
  }
}

function parseHtmlEntries(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/gu)].map(
    (match) => match[1],
  );
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gu)].map(
    (match) => match[1],
  );
  const modulePreloads = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"[^>]*>/gu)].map(
    (match) => match[1],
  );
  return { scripts, styles, modulePreloads };
}

function requireAsset(fileMap, url, extension) {
  const match = /^\/(?:[A-Za-z0-9._~-]+\/)*(assets\/[^?#]+)$/u.exec(url);
  if (!match || url.includes("?") || url.includes("#")) {
    throw new Error(`Entry URL is not an immutable same-origin asset: ${url}.`);
  }
  const path = decodeURIComponent(match[1]);
  if (!path.endsWith(extension) || path.includes("..")) throw new Error(`Unexpected entry asset: ${url}.`);
  const file = fileMap.get(path);
  if (!file) throw new Error(`Entry asset does not exist: ${url}.`);
  return file;
}

function requireReleaseFile(fileMap, path) {
  if (path.includes("..") || path.startsWith("/")) throw new Error(`Unexpected release artifact path: ${path}.`);
  const file = fileMap.get(path);
  if (!file) throw new Error(`Required release artifact does not exist: ${path}.`);
  return file;
}

function measure(payload) {
  return Object.freeze({
    raw: payload.byteLength,
    gzip: gzipSync(payload, { level: 9, mtime: 0 }).byteLength,
  });
}

function sumMeasurements(measurements) {
  return Object.freeze(
    measurements.reduce(
      (total, measurement) => ({ raw: total.raw + measurement.raw, gzip: total.gzip + measurement.gzip }),
      { raw: 0, gzip: 0 },
    ),
  );
}

function toPosix(base, path) {
  return relative(base, path).split(sep).join(posix.sep);
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function redactSensitiveText(value) {
  let redacted = value;
  for (const [, pattern] of secretPatterns) {
    redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[redacted-credential]");
  }
  return redacted;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function printResult(result) {
  const { measurements } = result;
  console.log("Release gate passed (manifest is deterministic and explicitly unsigned).");
  console.log(
    `Entry JS ${formatBytes(measurements.entryJavaScript.raw)} raw / ${formatBytes(measurements.entryJavaScript.gzip)} gzip`,
  );
  console.log(
    `Initial JS + preloads ${formatBytes(measurements.initialJavaScriptAndPreloads.raw)} raw / ${formatBytes(measurements.initialJavaScriptAndPreloads.gzip)} gzip`,
  );
  console.log(
    `Baseline JS/workers ${formatBytes(measurements.baselineJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.baselineJavaScriptAndWorkers.gzip)} gzip`,
  );
  console.log(
    `Deferred capability pack ${formatBytes(measurements.deferredCapabilities.raw)} raw / ${formatBytes(measurements.deferredCapabilities.gzip)} gzip`,
  );
  console.log(
    `Optional execution pack ${formatBytes(measurements.optionalExecutionPack.raw)} raw / ${formatBytes(measurements.optionalExecutionPack.gzip)} gzip`,
  );
  console.log(
    `Optional Node execution pack ${formatBytes(measurements.optionalNodeExecutionPack.raw)} raw / ${formatBytes(measurements.optionalNodeExecutionPack.gzip)} gzip`,
  );
  console.log(
    `Optional Workspace workbench ${formatBytes(measurements.optionalWorkspaceWorkbench.raw)} raw / ${formatBytes(measurements.optionalWorkspaceWorkbench.gzip)} gzip`,
  );
  console.log(
    `Optional source control ${formatBytes(measurements.optionalSourceControl.raw)} raw / ${formatBytes(measurements.optionalSourceControl.gzip)} gzip`,
  );
  console.log(
    `Optional session library ${formatBytes(measurements.optionalSessionLibrary.raw)} raw / ${formatBytes(measurements.optionalSessionLibrary.gzip)} gzip`,
  );
  console.log(
    `Optional Python pack ${formatBytes(measurements.optionalPythonPack.raw)} raw / ${formatBytes(measurements.optionalPythonPack.gzip)} gzip`,
  );
  console.log(
    `Total JS/workers ${formatBytes(measurements.totalJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.totalJavaScriptAndWorkers.gzip)} gzip`,
  );
  console.log(`Service worker ${formatBytes(measurements.serviceWorker.raw)} raw / ${formatBytes(measurements.serviceWorker.gzip)} gzip`);
  console.log(`Entry CSS ${formatBytes(measurements.entryCss.raw)} raw / ${formatBytes(measurements.entryCss.gzip)} gzip`);
  for (const wasm of measurements.wasm) {
    console.log(`${wasm.path} ${formatBytes(wasm.raw)} raw / ${formatBytes(wasm.gzip)} gzip`);
  }
  if (measurements.wasm.length > 1) {
    console.log(`All WASM ${formatBytes(measurements.allWasm.raw)} raw / ${formatBytes(measurements.allWasm.gzip)} gzip`);
  }
  console.log(`${result.manifest.artifacts.length} artifacts recorded in ${RELEASE_MANIFEST_NAME}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runReleaseGate(process.argv[2] ? resolve(process.argv[2]) : defaultOutput)
    .then(printResult)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

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
  // This is the first-paint cost on a phone, so it is the one ceiling that does
  // not move: three waves of capability were absorbed by deferring startup
  // weight (the fixture-only in-memory Git backend, reached only through the
  // src/git barrel, and the Chutes account-telemetry client, which now travels
  // with the Billing surface it serves) rather than by raising this number.
  // Measured 405.45 KiB raw / 128.89 KiB gzip.
  allJavaScriptAndWorkers: Object.freeze({ raw: 640 * 1024, gzip: 132 * 1024 }),
  // The Connect surface's live bridge observation and its local-probe results
  // panel travel here. Measured 377.88 KiB raw / 109.51 KiB gzip: 110 KiB gzip
  // would clear that by 0.44%, which is a tripwire rather than the ~0.5%
  // clearance every other cap in this file is set to.
  // Includes the extension-backed ciphertext page backend; the extension
  // protocol itself remains in the separately budgeted inference pack.
  deferredCapabilities: Object.freeze({ raw: 388 * 1024, gzip: 113 * 1024 }),
  // Core plus every optional route except the two independently delivered
  // vendor engines. The former 384 KiB "all routes" meaning became impossible
  // once full isomorphic-git and xterm engines were deliberately installed:
  // they are mutually activated, separately cached, and already individually
  // capped. Keep 384 KiB as the stronger first-party/all-other partition.
  // Local Device custody plus the provider-neutral inference fabric add
  // independently lazy first-party packs. The reviewed installed first-party
  // aggregate now measures 1,394.99 KiB raw / 430.45 KiB gzip: the Git engine's
  // new read/history/tag/stash/merge/remote operations, the Service Worker and
  // Cache Storage probes, and the expanded Capabilities/Memory/Proof route
  // chrome are all first-party and all lazily delivered. Every cap raised in
  // this pass sits at the lowest whole KiB that clears its measurement by at
  // least ~0.5%; a ceiling a few hundred bytes above the build is a tripwire,
  // not a budget, and the former "<5% above measured" allowance was slack.
  // `airship-sh` adds a whole first-party POSIX-sh interpreter — lexer,
  // parser, expansion, arithmetic, globbing, redirection and the workspace
  // utilities it runs — measuring 96.32 KiB raw / 28.75 KiB gzip. It is a new
  // capability rather than growth in an existing one, and it is fetched only
  // when a shell command runs, so the aggregate rises by roughly its size.
  // The Connect surface then began doing two things it previously only
  // described: a live per-page-load extension-bridge handshake whose outcome
  // the Claude and Grok lanes render, and a real Ollama/LM Studio loopback
  // probe behind "Check this machine". Both are lazily delivered, and the
  // bridge client also lost its cross-chunk compression when it became shared.
  // Measured 473.96 KiB gzip against 471.56 before; raw is unchanged.
  // Addressed per-conversation drafts, immutable message forks, a tab-local
  // follow-up queue, and touch/pointer message disclosures add installed chat
  // behavior without moving any individual route or first-paint ceiling.
  // Measured 1,549.33 KiB raw / 477.36 KiB gzip; the gzip ceiling is the
  // smallest whole-KiB step that retains roughly 0.5% tripwire clearance.
  // The Memory route's restored fields, result destinations and shared
  // provenance disclosure add ~4.1 KiB gzip to the installed first-party
  // aggregate and nothing at all to the first-paint set, which is measured
  // byte-identical at 411.63 KiB raw / 131.94 KiB gzip. Measured 487.0 KiB
  // gzip; the ceiling keeps the same ~0.5% tripwire clearance as before.
  firstPartyJavaScriptAndWorkers: Object.freeze({ raw: 1768 * 1024, gzip: 508 * 1024 }),
  // isomorphic-git and xterm are mutually activated vendor engines with their
  // own per-pack caps. The pair now measures 652.23 KiB raw / 180.61 KiB gzip:
  // the browser-Git pack grew (see optionalBrowserGit) and the Terminal pack
  // carries the enlarged in-terminal Git command surface. Both vendor pins are
  // unchanged, so all of the growth is first-party and separately reviewable.
  optionalVendorRuntimeAggregate: Object.freeze({ raw: 656 * 1024, gzip: 182 * 1024 }),
  // Absolute installed bundle backstop. It includes first-party/routes, both
  // vendor engines, model catalog chunks, and the service worker. Static
  // Pyodide assets remain governed by their separate pack cap below.
  // Genuine linked worktrees add an isolated worktree administration overlay
  // while retaining one shared object/ref database. The installed aggregate now
  // measures 2,047.22 KiB raw / 611.06 KiB gzip. The 2 MiB raw backstop is a
  // deliberate round product statement and is NOT raised here: it still fits,
  // with under 1 KiB to spare, and it — not the gzip figure — is what the next
  // installed capability has to argue against. Only gzip moves, to 612 KiB;
  // 611 KiB would have left 32 bytes, and a ceiling that cannot survive a
  // minifier rename is not a ceiling. Startup and every per-route pack ceiling
  // remain independently enforced.
  // Raised twice: once for the airship-sh pack, once for provider OAuth plus
  // the extension-bridge transport. The original 2 MiB raw figure was a
  // deliberate product statement; a real in-browser shell and real provider
  // sign-in are deliberate product decisions that supersede it. Both additions
  // are lazily loaded and contribute nothing to first paint, which is why the
  // startup cap below has not moved.
  // Raised a third time, for the Connect surface doing what it had only said:
  // consuming a real extension-bridge handshake per page load and issuing a
  // real loopback probe for the local model servers. Measured 2,189.23 KiB raw
  // / 654.58 KiB gzip; neither addition touches first paint, which is why the
  // startup cap below still has not moved.
  // The same chat milestone measures the complete installed bundle at
  // 2,202.99 KiB raw / 658.38 KiB gzip. These are the smallest even-KiB
  // ceilings that preserve roughly 0.5% clearance; startup stays separately
  // fixed at 640/132 KiB raw/gzip above.
  // The Memory route milestone above carries through to the installed total:
  // measured 663.25 KiB gzip, raw unchanged inside its ceiling. First paint is
  // untouched and stays separately fixed at 640/132 KiB raw/gzip below.
  totalJavaScriptAndWorkers: Object.freeze({ raw: 2264 * 1024, gzip: 684 * 1024 }),
  // The independently loaded offline shell worker is not application-bundle
  // startup cost. Keep it visible under a dedicated, deliberately small cap.
  serviceWorker: Object.freeze({ raw: 12 * 1024, gzip: 4 * 1024 }),
  // Browser-aware guidance on the static Companion install hub. This is not
  // app startup code, but it is executable release payload and therefore gets
  // its own tiny ceiling instead of disappearing into an aggregate.
  companionInstallScript: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  optionalExecutionPack: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  // The stable broker is tiny; Worker/WASI/Pyodide implementation follows as
  // a second-level chunk only when runtime inspection or execution begins.
  // The broker now also registers `airship-sh` and describes its capability,
  // which is what pushed this chunk past 12 KiB gzip. The interpreter itself
  // stays in its own pack below; only the registration travels here.
  optionalExecutionEngine: Object.freeze({ raw: 56 * 1024, gzip: 14 * 1024 }),
  optionalExecutionSupport: Object.freeze({ raw: 8 * 1024, gzip: 3 * 1024 }),
  // Pinned browser_wasi_shim plus Airship's bounded virtual-filesystem Worker.
  // It is fetched only when the precompiled WASI adapter executes a command.
  optionalWasiPreview1Worker: Object.freeze({ raw: 32 * 1024, gzip: 8 * 1024 }),
  // Page-local dependency reuse, full-source preflight, single-flight
  // activation, cancellation cleanup, and real npm readiness evidence make
  // install → build reliable in one conversation. The pack remains a
  // second-level lazy download and measures 26.14 KiB raw / 9.78 KiB gzip;
  // 11 KiB is the smallest whole-KiB ceiling with useful tripwire room.
  optionalNodeExecutionPack: Object.freeze({ raw: 32 * 1024, gzip: 11 * 1024 }),
  // `airship-sh`, the first-party POSIX-sh interpreter: lexer, parser,
  // expansion, arithmetic, globbing, redirection, job control, and the
  // workspace utilities it executes. It is the universal shell tier, so it
  // needs no Worker, no downloaded pack, and no cross-origin isolation — but
  // it is fetched only when a shell command actually runs, never at startup.
  optionalShellPack: Object.freeze({ raw: 100 * 1024, gzip: 30 * 1024 }),
  // The browser-Git client and the Git operations module that split out beside
  // it, both moved off first paint. Measured together at 16.44 KiB raw /
  // 3.95 KiB gzip; capped at the next whole step above that sum.
  optionalBrowserGitClient: Object.freeze({ raw: 18 * 1024, gzip: 5 * 1024 }),
  // The model-backed tool-action reviewer, fetched at adjudication time.
  optionalApprovalReviewer: Object.freeze({ raw: 6 * 1024, gzip: 2 * 1024 }),
  // Shared route chrome fetched with any route, never at first paint.
  optionalRoutePrimitives: Object.freeze({ raw: 24 * 1024, gzip: 8 * 1024 }),
  // Slash-command parser, registry, planner and completer.
  optionalSlashCommands: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  // The research WASIX candidate is intentionally absent from production
  // until its bidirectional workspace/output promotion probe passes.
  optionalWasixJavaScript: Object.freeze({ raw: 0, gzip: 0 }),
  optionalWasixWasm: Object.freeze({ raw: 0, gzip: 0 }),
  // The full inspect-act-verify loop is fetched on the first sent turn. The
  // shell keeps only immutable session-manifest construction on its boot path.
  optionalAgentRuntime: Object.freeze({ raw: 48 * 1024, gzip: 14 * 1024 }),
  // The registry, local retrieval broker and repository admission logic load
  // together when an agent-capable workspace is first constructed.
  optionalAgentTools: Object.freeze({ raw: 128 * 1024, gzip: 36 * 1024 }),
  // Files/editor shell plus its in-page source-control handoff. Git remains a
  // second lazy pack; this cap covers only the combined Editor route chrome.
  // The workbench gained the behaviour its measured defects needed: a tree
  // filter with an honest shown/total count, a keyboard-operable rail
  // separator, a per-route identity, an orientation surface on the empty pane,
  // a merged file strip, and a modal that traps focus and closes on Escape.
  // The shared `<Tabs>`, `<RouteHeader>` and `<Popover>` primitives it adopted
  // are their own lazy chunks and are not counted here; first paint is
  // unchanged, because this pack is fetched only when the route opens.
  // Measured 32.84 KiB raw / 11.25 KiB gzip.
  optionalWorkspaceWorkbench: Object.freeze({ raw: 34 * 1024, gzip: 11 * 1024 + 512 }),
  optionalWorkspaceBinding: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  optionalWorkspaceCodec: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  optionalSourceControl: Object.freeze({ raw: 48 * 1024, gzip: 14 * 1024 }),
  optionalSourceSelection: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  // Full standards-compatible Git engine. It is loaded once during browser
  // runtime boot, never preloaded with the shell, and remains independently
  // cacheable from the lightweight Source Control presentation pack.
  // The adapter includes real log/show/tag/stash/merge/restore/reset/remote
  // operations, per-operation abort checks, and remote-origin admission.
  // isomorphic-git's broad CommonJS SHA-1 fallback is replaced at build time
  // by Airship's byte-view-only equivalent; modern Web Crypto remains the
  // preferred path and legacy/pack hashing remains available. The reviewed
  // pack measures 256.78 KiB raw / 77.72 KiB gzip.
  optionalBrowserGit: Object.freeze({ raw: 276 * 1024, gzip: 83 * 1024 }),
  optionalSessionLibrary: Object.freeze({ raw: 48 * 1024, gzip: 14 * 1024 }),
  // The route now renders the per-primitive probe detail and states the
  // adaptive policy in terms of what each number actually sizes, which is why
  // it crossed 3 KiB gzip at all: measured 8,884 B raw / 3,115 B gzip. Both
  // ceilings step in half-KiB rather than whole-KiB units, because rounding a
  // 3 KiB presentation route up to 4 KiB would hand it a third more room than
  // its growth ever asked for.
  optionalCapabilitiesView: Object.freeze({ raw: 9 * 1024, gzip: 3 * 1024 + 512 }),
  // Hardware/browser feature detection is requested after the shell starts so
  // it can select the strongest runtime without inflating the HTML preload set.
  // The Service Worker and Cache Storage probes push the raw pack to a measured
  // 16.95 KiB, held under a half-KiB step for the same reason as the route
  // above; gzip stays at 5.49 KiB, well under its unchanged ceiling.
  optionalBrowserCapabilities: Object.freeze({ raw: 17 * 1024 + 512, gzip: 6 * 1024 }),
  // Graph derivation and relationship controls load only on Memory/Context.
  // Raised once, deliberately, from 36 KiB / 12 KiB to a measured 42.61 KiB raw
  // / 14.79 KiB gzip. What the +2.8 KiB gzip bought, all of it lazily fetched
  // and none of it in the startup set: a destination and a human title on every
  // result; nine fields the federated search already computed and the view was
  // discarding (recordedAt, sequence, eventId, textDigest, createdAt,
  // profileRevisionAtCreation, createdInSessionId, denseScore, lexicalScore);
  // the per-group `ranking` / `legacyQuarantined` / `duplicatesSuppressed`
  // contracts, which rendered nowhere; the shared provenance disclosure that
  // makes those digests copyable instead of decorative; and a zero-result panel
  // that states what each corpus actually searched. The 132 KiB startup ceiling
  // is untouched — this route has always been fetched on navigation.
  optionalMemoryView: Object.freeze({ raw: 45 * 1024, gzip: 15 * 1024 + 512 }),
  // Small shared node-shape vocabulary split out by Vite because both the
  // Memory route and deferred graph renderer consume it.
  optionalMemorySupport: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  // Proof presentation and privacy-safe receipt serialization are fetched only
  // when the user opens the comprehensive Proof surface.
  // The claim rail (`proof-inspector`) and the one fail-closed receipt rule it
  // renders (`seal-states`) joined this pack when they stopped being defined
  // inside `app.tsx`. Nothing was added to the product: 1.69 KiB gzip of
  // first-paint weight moved out of `allJavaScriptAndWorkers` and landed here,
  // behind a panel that cannot render until a turn has produced a receipt.
  // That is the trade this file has taken three times before, and it is the
  // only ceiling that moved in this change. Measured 72.20 KiB raw /
  // 22.63 KiB gzip.
  optionalProofSurface: Object.freeze({ raw: 73 * 1024, gzip: 23 * 1024 }),
  // Official xterm.js is isolated behind the Terminal route and is never part
  // of initial navigation or a background capability probe.
  optionalTerminal: Object.freeze({ raw: 384 * 1024, gzip: 100 * 1024 }),
  // Protocol host only. The reviewed Transformers/ORT/model artifacts remain
  // a separately mounted same-origin semantic pack and are never preloaded.
  optionalSemanticWorker: Object.freeze({ raw: 16 * 1024, gzip: 6 * 1024 }),
  // Model catalog + utilization normalization is loaded only when provider
  // discovery opens and is enforced separately from the interactive app.
  optionalModelCatalog: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  // Multi-provider connection UI, page-lifetime provider fabric, credential-
  // free route contracts, and cloud transport adapters load with the
  // Connection route/runtime bootstrap. They are deliberately absent from the
  // HTML preload graph.
  // Raised once for genuinely new capability rather than growth in an existing
  // one: three provider OAuth grant shapes (paste-code PKCE, RFC 8628 device
  // code, refresh) plus the extension-bridge transport client. Measured
  // 116.14 KiB raw / 34.62 KiB gzip; these are the next whole steps above it.
  // The gzip step moved again for a split, not for new code: the bridge client
  // is now shared between the provider transports and the Connect surface's
  // presence observation, so it compresses as its own 10.65 KiB chunk instead
  // of inside the session route. Raw is unchanged at a measured 116.74 KiB;
  // only the lost cross-chunk compression is new, at 35.59 KiB gzip.
  // Includes the shared page-side companion protocol client used by both the
  // live Providers observation and the opt-in ciphertext cache backend.
  optionalInferenceProviders: Object.freeze({ raw: 124 * 1024, gzip: 38 * 1024 }),
  // Local Device setup and its OPFS/IndexedDB key-custody runtime load only
  // after the user selects that Vault provider.
  optionalLocalDeviceVault: Object.freeze({ raw: 60 * 1024, gzip: 19 * 1024 }),
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

/** A researched runtime that failed promotion must contribute zero release artifacts. */
export function assertUnpromotedWasixAbsent(kind, paths) {
  if (paths.length !== 0) {
    throw new Error(`Production must not contain the unpromoted WASIX ${kind}; found ${paths.length} artifacts.`);
  }
}

/** Every emitted bundled JavaScript artifact has one, and only one, owner. */
export function assertExclusiveArtifactClassifications(paths, classifications) {
  const claims = new Map(paths.map((path) => [path, []]));
  for (const classification of classifications) {
    const uniquePaths = new Set(classification.paths);
    for (const path of uniquePaths) {
      const owners = claims.get(path);
      if (owners) owners.push(classification.name);
    }
  }
  const unclassified = [];
  const multiplyClassified = [];
  for (const [path, owners] of claims) {
    if (owners.length === 0) unclassified.push(path);
    if (owners.length > 1) multiplyClassified.push(`${path} (${owners.join(", ")})`);
  }
  if (unclassified.length || multiplyClassified.length) {
    const failures = [
      ...unclassified.map((path) => `unclassified: ${path}`),
      ...multiplyClassified.map((path) => `multiple classes: ${path}`),
    ];
    throw new Error(`JavaScript artifact classification failed:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * The in-memory Git adapter is a deterministic test fixture, not a production
 * runtime. Keep a literal sentinel in that adapter and fail the release if a
 * production JavaScript graph accidentally imports it again.
 */
export function assertNoSimulatedGitRuntime(files) {
  const sentinel = Buffer.from("airship-memory-git");
  const offenders = files
    .filter((file) => file.payload.includes(sentinel))
    .map((file) => file.path);
  if (offenders.length > 0) {
    throw new Error(
      `Production must not contain the simulated browser-Git runtime; found ${offenders.join(", ")}.`,
    );
  }
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

  const required = [
    "_headers",
    "favicon.svg",
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "extension/index.html",
    "extension/install.css",
    "extension/install.js",
    "extension/privacy.html",
    "extension/releases/release.json",
    "extension/releases/SHA256SUMS",
    "extension/releases/airship-companion-chromium-development.zip",
    "extension/releases/airship-companion-chromium-release.zip",
    "extension/releases/airship-companion-firefox-development.zip",
    "extension/releases/airship-companion-firefox-release.zip",
    "extension/releases/airship-companion-safari-development.zip",
    "extension/releases/airship-companion-safari-release.zip",
  ];
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
  assertNoSimulatedGitRuntime(javaScriptFiles);
  const optionalExecutionPacks = javaScriptFiles.filter((file) => isOptionalExecutionPackPath(file.path));
  if (optionalExecutionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution pack; found ${optionalExecutionPacks.length}.`);
  }
  const optionalExecutionPackMeasurement = measure(optionalExecutionPacks[0].payload);
  const optionalExecutionEnginePacks = javaScriptFiles.filter((file) => isOptionalExecutionEnginePath(file.path));
  if (optionalExecutionEnginePacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution engine; found ${optionalExecutionEnginePacks.length}.`);
  }
  const optionalExecutionEngineMeasurement = measure(optionalExecutionEnginePacks[0].payload);
  const optionalExecutionSupportPacks = javaScriptFiles.filter((file) => isOptionalExecutionSupportPath(file.path));
  if (optionalExecutionSupportPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution support chunk; found ${optionalExecutionSupportPacks.length}.`);
  }
  const optionalExecutionSupportMeasurement = measure(optionalExecutionSupportPacks[0].payload);
  const optionalWasiPreview1WorkerPacks = javaScriptFiles.filter((file) => isOptionalWasiPreview1WorkerPath(file.path));
  if (optionalWasiPreview1WorkerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional WASI Preview 1 Worker; found ${optionalWasiPreview1WorkerPacks.length}.`);
  }
  const optionalWasiPreview1WorkerMeasurement = measure(optionalWasiPreview1WorkerPacks[0].payload);
  const optionalNodeExecutionPacks = javaScriptFiles.filter((file) => isOptionalNodeExecutionPackPath(file.path));
  if (optionalNodeExecutionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Node execution pack; found ${optionalNodeExecutionPacks.length}.`);
  }
  const optionalNodeExecutionPackMeasurement = measure(optionalNodeExecutionPacks[0].payload);
  // The interpreter may split into more than one chunk; the budget governs
  // their sum, because a user who runs one shell command fetches all of them.
  const optionalShellPacks = javaScriptFiles.filter((file) => isOptionalShellPackPath(file.path));
  if (optionalShellPacks.length === 0) {
    throw new Error("Production must contain the first-party airship-sh shell pack; found none.");
  }
  const optionalShellPackMeasurement = sumMeasurements(optionalShellPacks.map((file) => measure(file.payload)));
  const optionalWasixJavaScriptPacks = javaScriptFiles.filter((file) => isOptionalWasixJavaScriptPath(file.path));
  assertUnpromotedWasixAbsent("JavaScript candidate", optionalWasixJavaScriptPacks.map((file) => file.path));
  const optionalWasixJavaScriptMeasurement = sumMeasurements(
    optionalWasixJavaScriptPacks.map((file) => measure(file.payload)),
  );
  const optionalAgentRuntimePacks = javaScriptFiles.filter((file) => isOptionalAgentRuntimePath(file.path));
  if (optionalAgentRuntimePacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional agent runtime; found ${optionalAgentRuntimePacks.length}.`);
  }
  const optionalAgentRuntimeMeasurement = measure(optionalAgentRuntimePacks[0].payload);
  const optionalAgentToolPacks = javaScriptFiles.filter((file) => isOptionalAgentToolsPath(file.path));
  if (optionalAgentToolPacks.length !== 4) {
    throw new Error(`Production must contain exactly four optional agent-tool chunks; found ${optionalAgentToolPacks.length}.`);
  }
  const optionalAgentToolsMeasurement = sumMeasurements(optionalAgentToolPacks.map((file) => measure(file.payload)));
  const optionalWorkspaceWorkbenchPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceWorkbenchPath(file.path));
  if (optionalWorkspaceWorkbenchPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Workspace workbench pack; found ${optionalWorkspaceWorkbenchPacks.length}.`);
  }
  const optionalWorkspaceWorkbenchMeasurement = measure(optionalWorkspaceWorkbenchPacks[0].payload);
  const optionalWorkspaceBindingPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceBindingPath(file.path));
  if (optionalWorkspaceBindingPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional workspace-binding chunk; found ${optionalWorkspaceBindingPacks.length}.`);
  }
  const optionalWorkspaceBindingMeasurement = measure(optionalWorkspaceBindingPacks[0].payload);
  const optionalWorkspaceCodecPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceCodecPath(file.path));
  if (optionalWorkspaceCodecPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional workspace codec; found ${optionalWorkspaceCodecPacks.length}.`);
  }
  const optionalWorkspaceCodecMeasurement = measure(optionalWorkspaceCodecPacks[0].payload);
  const optionalSourceControlPacks = javaScriptFiles.filter((file) => isOptionalSourceControlPath(file.path));
  if (optionalSourceControlPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional source-control pack; found ${optionalSourceControlPacks.length}.`);
  }
  const optionalSourceControlMeasurement = measure(optionalSourceControlPacks[0].payload);
  const optionalSourceSelectionPacks = javaScriptFiles.filter((file) => isOptionalSourceSelectionPath(file.path));
  if (optionalSourceSelectionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional source-selection chunk; found ${optionalSourceSelectionPacks.length}.`);
  }
  const optionalSourceSelectionMeasurement = measure(optionalSourceSelectionPacks[0].payload);
  const optionalBrowserGitPacks = javaScriptFiles.filter((file) => isOptionalBrowserGitPath(file.path));
  if (optionalBrowserGitPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional browser-Git engine pack; found ${optionalBrowserGitPacks.length}.`);
  }
  const optionalBrowserGitMeasurement = measure(optionalBrowserGitPacks[0].payload);
  // The Git client left the startup chunk with the adapter it is always awaited
  // beside; it is measured with the engine rather than against first paint.
  const optionalBrowserGitClientPacks = javaScriptFiles.filter((file) => isOptionalBrowserGitClientPath(file.path));
  if (optionalBrowserGitClientPacks.length === 0) {
    throw new Error("Production must contain the optional browser-Git client pack; found none.");
  }
  // The pack may split across more than one chunk; the budget governs their sum
  // because opening the Workspace fetches all of them together.
  const optionalBrowserGitClientMeasurement = sumMeasurements(optionalBrowserGitClientPacks.map((file) => measure(file.payload)));
  // The model-backed safety reviewer runs only when a governed tool action
  // needs adjudicating, so it is not first-paint cost.
  const optionalApprovalReviewerPacks = javaScriptFiles.filter((file) => isOptionalApprovalReviewerPath(file.path));
  if (optionalApprovalReviewerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional approval-reviewer pack; found ${optionalApprovalReviewerPacks.length}.`);
  }
  const optionalApprovalReviewerMeasurement = measure(optionalApprovalReviewerPacks[0].payload);
  const optionalSlashCommandPacks = javaScriptFiles.filter((file) => isOptionalSlashCommandPath(file.path));
  if (optionalSlashCommandPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional slash-command pack; found ${optionalSlashCommandPacks.length}.`);
  }
  const optionalSlashCommandMeasurement = measure(optionalSlashCommandPacks[0].payload);
  const optionalRoutePrimitivePacks = javaScriptFiles.filter((file) => isOptionalRoutePrimitivePath(file.path));
  if (optionalRoutePrimitivePacks.length === 0) {
    throw new Error("Production must contain the shared route-primitive pack; found none.");
  }
  const optionalRoutePrimitiveMeasurement = sumMeasurements(optionalRoutePrimitivePacks.map((file) => measure(file.payload)));
  const optionalSessionLibraryPacks = javaScriptFiles.filter((file) => isOptionalSessionLibraryPath(file.path));
  if (optionalSessionLibraryPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional session-library pack; found ${optionalSessionLibraryPacks.length}.`);
  }
  const optionalSessionLibraryMeasurement = measure(optionalSessionLibraryPacks[0].payload);
  const optionalCapabilitiesViewPacks = javaScriptFiles.filter((file) => isOptionalCapabilitiesViewPath(file.path));
  if (optionalCapabilitiesViewPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Capabilities view; found ${optionalCapabilitiesViewPacks.length}.`);
  }
  const optionalCapabilitiesViewMeasurement = measure(optionalCapabilitiesViewPacks[0].payload);
  const optionalBrowserCapabilityPacks = javaScriptFiles.filter((file) => isOptionalBrowserCapabilityPath(file.path));
  if (optionalBrowserCapabilityPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional browser-capability pack; found ${optionalBrowserCapabilityPacks.length}.`);
  }
  const optionalBrowserCapabilityMeasurement = measure(optionalBrowserCapabilityPacks[0].payload);
  const optionalMemoryViewPacks = javaScriptFiles.filter((file) => isOptionalMemoryViewPath(file.path));
  if (optionalMemoryViewPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Memory view; found ${optionalMemoryViewPacks.length}.`);
  }
  const optionalMemoryViewMeasurement = measure(optionalMemoryViewPacks[0].payload);
  const optionalMemorySupportPacks = javaScriptFiles.filter((file) => isOptionalMemorySupportPath(file.path));
  if (optionalMemorySupportPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Memory support chunk; found ${optionalMemorySupportPacks.length}.`);
  }
  const optionalMemorySupportMeasurement = measure(optionalMemorySupportPacks[0].payload);
  const optionalProofSurfacePacks = javaScriptFiles.filter((file) => isOptionalProofSurfacePath(file.path));
  if (optionalProofSurfacePacks.length !== 5) {
    throw new Error(`Production must contain exactly five optional Proof-surface chunks; found ${optionalProofSurfacePacks.length}.`);
  }
  const optionalProofSurfaceMeasurement = sumMeasurements(optionalProofSurfacePacks.map((file) => measure(file.payload)));
  const optionalTerminalPacks = javaScriptFiles.filter((file) => isOptionalTerminalPath(file.path));
  if (optionalTerminalPacks.length !== 2) {
    throw new Error(`Production must contain exactly two optional Terminal packs; found ${optionalTerminalPacks.length}.`);
  }
  const optionalTerminalMeasurement = sumMeasurements(optionalTerminalPacks.map((file) => measure(file.payload)));
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
  // Six since the extension-bridge client became shared: the Connect surface
  // observes bridge presence with the same client the provider transports use,
  // so Rollup emits it once instead of embedding it in the session route.
  const optionalInferenceProviderPacks = javaScriptFiles.filter((file) => isOptionalInferenceProviderPath(file.path));
  if (optionalInferenceProviderPacks.length !== 6) {
    throw new Error(`Production must contain exactly six optional inference-provider packs; found ${optionalInferenceProviderPacks.length}.`);
  }
  const optionalInferenceProviderMeasurement = sumMeasurements(
    optionalInferenceProviderPacks.map((file) => measure(file.payload)),
  );
  const optionalLocalDeviceVaultPacks = javaScriptFiles.filter((file) => isOptionalLocalDeviceVaultPath(file.path));
  if (optionalLocalDeviceVaultPacks.length !== 5) {
    throw new Error(`Production must contain exactly five optional local-storage provider packs; found ${optionalLocalDeviceVaultPacks.length}.`);
  }
  const optionalLocalDeviceVaultMeasurement = sumMeasurements(
    optionalLocalDeviceVaultPacks.map((file) => measure(file.payload)),
  );
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
  const optionalWasixWasmFiles = wasmFiles.filter((file) => isOptionalWasixWasmPath(file.path));
  assertUnpromotedWasixAbsent("engine WASM", optionalWasixWasmFiles.map((file) => file.path));
  const optionalWasixWasmMeasurement = sumMeasurements(optionalWasixWasmFiles.map((file) => measure(file.payload)));
  const deferredCapabilityPacks = javaScriptFiles.filter((file) => isDeferredCapabilityPackPath(file.path));
  if (deferredCapabilityPacks.length !== 1) {
    throw new Error(`Production must contain exactly one deferred capability pack; found ${deferredCapabilityPacks.length}.`);
  }
  const deferredCapabilityMeasurement = measure(deferredCapabilityPacks[0].payload);
  const optionalPythonPackMeasurement = sumMeasurements(pyodideFiles.map((file) => measure(file.payload)));
  const baselineJavaScriptFiles = javaScriptFiles.filter(
    (file) => !isOptionalExecutionPackPath(file.path)
      && !isOptionalExecutionEnginePath(file.path)
      && !isOptionalExecutionSupportPath(file.path)
      && !isOptionalWasiPreview1WorkerPath(file.path)
      && !isOptionalNodeExecutionPackPath(file.path)
      && !isOptionalShellPackPath(file.path)
      && !isOptionalWasixJavaScriptPath(file.path)
      && !isOptionalAgentRuntimePath(file.path)
      && !isOptionalAgentToolsPath(file.path)
      && !isOptionalWorkspaceWorkbenchPath(file.path)
      && !isOptionalWorkspaceBindingPath(file.path)
      && !isOptionalWorkspaceCodecPath(file.path)
      && !isOptionalSourceControlPath(file.path)
      && !isOptionalSourceSelectionPath(file.path)
      && !isOptionalBrowserGitPath(file.path)
      && !isOptionalBrowserGitClientPath(file.path)
      && !isOptionalApprovalReviewerPath(file.path)
      && !isOptionalRoutePrimitivePath(file.path)
      && !isOptionalSlashCommandPath(file.path)
      && !isOptionalSessionLibraryPath(file.path)
      && !isOptionalCapabilitiesViewPath(file.path)
      && !isOptionalBrowserCapabilityPath(file.path)
      && !isOptionalMemoryViewPath(file.path)
      && !isOptionalMemorySupportPath(file.path)
      && !isOptionalProofSurfacePath(file.path)
      && !isOptionalTerminalPath(file.path)
      && !isOptionalSemanticWorkerPath(file.path)
      && !isOptionalModelCatalogPath(file.path)
      && !isOptionalInferenceProviderPath(file.path)
      && !isOptionalLocalDeviceVaultPath(file.path)
      && !isOptionalDcapQvlPath(file.path)
      && !isDeferredCapabilityPackPath(file.path)
      && !isCompanionInstallScriptPath(file.path),
  );
  const baselineJavaScriptMeasurement = sumMeasurements(baselineJavaScriptFiles.map((file) => measure(file.payload)));
  const vendorRuntimeFiles = [...optionalBrowserGitPacks, ...optionalTerminalPacks];
  const optionalVendorRuntimeMeasurement = sumMeasurements(vendorRuntimeFiles.map((file) => measure(file.payload)));
  const firstPartyJavaScriptFiles = [
    serviceWorker,
    ...javaScriptFiles.filter(
      (file) => !isOptionalBrowserGitPath(file.path)
        && !isOptionalTerminalPath(file.path)
        && !isCompanionInstallScriptPath(file.path),
    ),
  ];
  const firstPartyJavaScriptMeasurement = sumMeasurements(firstPartyJavaScriptFiles.map((file) => measure(file.payload)));
  const installedJavaScriptFiles = [
    serviceWorker,
    ...javaScriptFiles.filter((file) => !isCompanionInstallScriptPath(file.path)),
  ];
  const totalJavaScriptMeasurement = sumMeasurements(installedJavaScriptFiles.map((file) => measure(file.payload)));
  const companionInstallScripts = javaScriptFiles.filter((file) => isCompanionInstallScriptPath(file.path));
  if (companionInstallScripts.length !== 1) {
    throw new Error(`Production must contain exactly one Companion install script; found ${companionInstallScripts.length}.`);
  }
  const companionInstallScriptMeasurement = measure(companionInstallScripts[0].payload);

  assertExclusiveArtifactClassifications(
    [serviceWorker, ...javaScriptFiles].map((file) => file.path),
    [
      { name: "core-entry-and-preloads", paths: initialJavaScriptFiles.map((file) => file.path) },
      { name: "service-worker", paths: [serviceWorker.path] },
      { name: "deferred-capabilities", paths: deferredCapabilityPacks.map((file) => file.path) },
      { name: "execution-broker", paths: optionalExecutionPacks.map((file) => file.path) },
      { name: "execution-engine", paths: optionalExecutionEnginePacks.map((file) => file.path) },
      { name: "execution-support", paths: optionalExecutionSupportPacks.map((file) => file.path) },
      { name: "wasi-preview1-worker", paths: optionalWasiPreview1WorkerPacks.map((file) => file.path) },
      { name: "node-runtime", paths: optionalNodeExecutionPacks.map((file) => file.path) },
      { name: "airship-shell", paths: optionalShellPacks.map((file) => file.path) },
      { name: "wasix-runtime", paths: optionalWasixJavaScriptPacks.map((file) => file.path) },
      { name: "agent-runtime", paths: optionalAgentRuntimePacks.map((file) => file.path) },
      { name: "agent-tools", paths: optionalAgentToolPacks.map((file) => file.path) },
      { name: "workspace-workbench", paths: optionalWorkspaceWorkbenchPacks.map((file) => file.path) },
      { name: "workspace-binding", paths: optionalWorkspaceBindingPacks.map((file) => file.path) },
      { name: "workspace-codec", paths: optionalWorkspaceCodecPacks.map((file) => file.path) },
      { name: "source-control", paths: optionalSourceControlPacks.map((file) => file.path) },
      { name: "source-selection", paths: optionalSourceSelectionPacks.map((file) => file.path) },
      { name: "browser-git-vendor", paths: optionalBrowserGitPacks.map((file) => file.path) },
      { name: "browser-git-client", paths: optionalBrowserGitClientPacks.map((file) => file.path) },
      { name: "approval-reviewer", paths: optionalApprovalReviewerPacks.map((file) => file.path) },
      { name: "route-primitives", paths: optionalRoutePrimitivePacks.map((file) => file.path) },
      { name: "slash-commands", paths: optionalSlashCommandPacks.map((file) => file.path) },
      { name: "session-library", paths: optionalSessionLibraryPacks.map((file) => file.path) },
      { name: "capabilities-view", paths: optionalCapabilitiesViewPacks.map((file) => file.path) },
      { name: "browser-capabilities", paths: optionalBrowserCapabilityPacks.map((file) => file.path) },
      { name: "memory-view", paths: optionalMemoryViewPacks.map((file) => file.path) },
      { name: "memory-support", paths: optionalMemorySupportPacks.map((file) => file.path) },
      { name: "proof-surface", paths: optionalProofSurfacePacks.map((file) => file.path) },
      { name: "terminal-vendor", paths: optionalTerminalPacks.map((file) => file.path) },
      { name: "semantic-worker", paths: optionalSemanticWorkerPacks.map((file) => file.path) },
      { name: "model-catalog", paths: optionalModelCatalogPacks.map((file) => file.path) },
      { name: "inference-providers", paths: optionalInferenceProviderPacks.map((file) => file.path) },
      { name: "local-device-vault", paths: optionalLocalDeviceVaultPacks.map((file) => file.path) },
      { name: "dcap-qvl", paths: optionalDcapQvlPacks.map((file) => file.path) },
      { name: "companion-install", paths: companionInstallScripts.map((file) => file.path) },
    ],
  );
  const baselineWasmFiles = wasmFiles.filter(
    (file) => !isOptionalDcapQvlWasmPath(file.path) && !isOptionalWasixWasmPath(file.path),
  );
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
    "Optional execution engine",
    optionalExecutionEngineMeasurement,
    RELEASE_BUDGETS.optionalExecutionEngine,
  );
  assertWithinBudget(
    "Optional execution support",
    optionalExecutionSupportMeasurement,
    RELEASE_BUDGETS.optionalExecutionSupport,
  );
  assertWithinBudget(
    "Optional WASI Preview 1 Worker",
    optionalWasiPreview1WorkerMeasurement,
    RELEASE_BUDGETS.optionalWasiPreview1Worker,
  );
  assertWithinBudget(
    "Optional Node execution pack",
    optionalNodeExecutionPackMeasurement,
    RELEASE_BUDGETS.optionalNodeExecutionPack,
  );
  assertWithinBudget("Optional airship-sh shell pack", optionalShellPackMeasurement, RELEASE_BUDGETS.optionalShellPack);
  assertWithinBudget(
    "Optional WASIX JavaScript",
    optionalWasixJavaScriptMeasurement,
    RELEASE_BUDGETS.optionalWasixJavaScript,
  );
  assertWithinBudget("Optional WASIX engine WASM", optionalWasixWasmMeasurement, RELEASE_BUDGETS.optionalWasixWasm);
  assertWithinBudget("Optional agent runtime", optionalAgentRuntimeMeasurement, RELEASE_BUDGETS.optionalAgentRuntime);
  assertWithinBudget("Optional agent tools", optionalAgentToolsMeasurement, RELEASE_BUDGETS.optionalAgentTools);
  assertWithinBudget(
    "Optional Workspace workbench",
    optionalWorkspaceWorkbenchMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceWorkbench,
  );
  assertWithinBudget(
    "Optional workspace binding",
    optionalWorkspaceBindingMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceBinding,
  );
  assertWithinBudget(
    "Optional workspace codec",
    optionalWorkspaceCodecMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceCodec,
  );
  assertWithinBudget("Optional source control", optionalSourceControlMeasurement, RELEASE_BUDGETS.optionalSourceControl);
  assertWithinBudget("Optional source selection", optionalSourceSelectionMeasurement, RELEASE_BUDGETS.optionalSourceSelection);
  assertWithinBudget("Optional browser Git", optionalBrowserGitMeasurement, RELEASE_BUDGETS.optionalBrowserGit);
  assertWithinBudget("Optional browser-Git client", optionalBrowserGitClientMeasurement, RELEASE_BUDGETS.optionalBrowserGitClient);
  assertWithinBudget("Optional approval reviewer", optionalApprovalReviewerMeasurement, RELEASE_BUDGETS.optionalApprovalReviewer);
  assertWithinBudget("Optional route primitives", optionalRoutePrimitiveMeasurement, RELEASE_BUDGETS.optionalRoutePrimitives);
  assertWithinBudget("Optional slash commands", optionalSlashCommandMeasurement, RELEASE_BUDGETS.optionalSlashCommands);
  assertWithinBudget("Optional session library", optionalSessionLibraryMeasurement, RELEASE_BUDGETS.optionalSessionLibrary);
  assertWithinBudget("Optional Capabilities view", optionalCapabilitiesViewMeasurement, RELEASE_BUDGETS.optionalCapabilitiesView);
  assertWithinBudget(
    "Optional browser capabilities",
    optionalBrowserCapabilityMeasurement,
    RELEASE_BUDGETS.optionalBrowserCapabilities,
  );
  assertWithinBudget("Optional Memory view", optionalMemoryViewMeasurement, RELEASE_BUDGETS.optionalMemoryView);
  assertWithinBudget("Optional Memory support", optionalMemorySupportMeasurement, RELEASE_BUDGETS.optionalMemorySupport);
  assertWithinBudget("Optional Proof surface", optionalProofSurfaceMeasurement, RELEASE_BUDGETS.optionalProofSurface);
  assertWithinBudget("Optional Terminal", optionalTerminalMeasurement, RELEASE_BUDGETS.optionalTerminal);
  assertWithinBudget("Optional semantic worker", optionalSemanticWorkerMeasurement, RELEASE_BUDGETS.optionalSemanticWorker);
  assertWithinBudget(
    "Optional model catalog",
    optionalModelCatalogMeasurement,
    RELEASE_BUDGETS.optionalModelCatalog,
  );
  assertWithinBudget(
    "Optional inference providers",
    optionalInferenceProviderMeasurement,
    RELEASE_BUDGETS.optionalInferenceProviders,
  );
  assertWithinBudget(
    "Optional Local Device Vault",
    optionalLocalDeviceVaultMeasurement,
    RELEASE_BUDGETS.optionalLocalDeviceVault,
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
    "First-party JavaScript and workers",
    firstPartyJavaScriptMeasurement,
    RELEASE_BUDGETS.firstPartyJavaScriptAndWorkers,
  );
  assertWithinBudget(
    "Optional vendor runtime aggregate",
    optionalVendorRuntimeMeasurement,
    RELEASE_BUDGETS.optionalVendorRuntimeAggregate,
  );
  assertWithinBudget(
    "Total JavaScript and workers",
    totalJavaScriptMeasurement,
    RELEASE_BUDGETS.totalJavaScriptAndWorkers,
  );
  assertWithinBudget("Service worker", serviceWorkerMeasurement, RELEASE_BUDGETS.serviceWorker);
  assertWithinBudget(
    "Companion install script",
    companionInstallScriptMeasurement,
    RELEASE_BUDGETS.companionInstallScript,
  );
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
      optionalExecutionEngine: Object.freeze({
        path: optionalExecutionEnginePacks[0].path,
        ...optionalExecutionEngineMeasurement,
      }),
      optionalExecutionSupport: Object.freeze({
        path: optionalExecutionSupportPacks[0].path,
        ...optionalExecutionSupportMeasurement,
      }),
      optionalWasiPreview1Worker: Object.freeze({
        path: optionalWasiPreview1WorkerPacks[0].path,
        ...optionalWasiPreview1WorkerMeasurement,
      }),
      optionalNodeExecutionPack: Object.freeze({
        path: optionalNodeExecutionPacks[0].path,
        ...optionalNodeExecutionPackMeasurement,
      }),
      optionalWasixJavaScript: Object.freeze({
        paths: Object.freeze(optionalWasixJavaScriptPacks.map((file) => file.path)),
        ...optionalWasixJavaScriptMeasurement,
      }),
      optionalWasixWasm: Object.freeze({
        paths: Object.freeze(optionalWasixWasmFiles.map((file) => file.path)),
        ...optionalWasixWasmMeasurement,
      }),
      optionalAgentRuntime: Object.freeze({
        path: optionalAgentRuntimePacks[0].path,
        ...optionalAgentRuntimeMeasurement,
      }),
      optionalAgentTools: Object.freeze({
        paths: Object.freeze(optionalAgentToolPacks.map((file) => file.path)),
        ...optionalAgentToolsMeasurement,
      }),
      optionalWorkspaceWorkbench: Object.freeze({
        path: optionalWorkspaceWorkbenchPacks[0].path,
        ...optionalWorkspaceWorkbenchMeasurement,
      }),
      optionalWorkspaceBinding: Object.freeze({
        path: optionalWorkspaceBindingPacks[0].path,
        ...optionalWorkspaceBindingMeasurement,
      }),
      optionalWorkspaceCodec: Object.freeze({
        path: optionalWorkspaceCodecPacks[0].path,
        ...optionalWorkspaceCodecMeasurement,
      }),
      optionalSourceControl: Object.freeze({
        path: optionalSourceControlPacks[0].path,
        ...optionalSourceControlMeasurement,
      }),
      optionalSourceSelection: Object.freeze({
        path: optionalSourceSelectionPacks[0].path,
        ...optionalSourceSelectionMeasurement,
      }),
      optionalBrowserGit: Object.freeze({
        path: optionalBrowserGitPacks[0].path,
        ...optionalBrowserGitMeasurement,
      }),
      optionalSessionLibrary: Object.freeze({
        path: optionalSessionLibraryPacks[0].path,
        ...optionalSessionLibraryMeasurement,
      }),
      optionalCapabilitiesView: Object.freeze({
        path: optionalCapabilitiesViewPacks[0].path,
        ...optionalCapabilitiesViewMeasurement,
      }),
      optionalBrowserCapabilities: Object.freeze({
        path: optionalBrowserCapabilityPacks[0].path,
        ...optionalBrowserCapabilityMeasurement,
      }),
      optionalMemoryView: Object.freeze({ path: optionalMemoryViewPacks[0].path, ...optionalMemoryViewMeasurement }),
      optionalMemorySupport: Object.freeze({
        path: optionalMemorySupportPacks[0].path,
        ...optionalMemorySupportMeasurement,
      }),
      optionalProofSurface: Object.freeze({
        paths: Object.freeze(optionalProofSurfacePacks.map((file) => file.path)),
        ...optionalProofSurfaceMeasurement,
      }),
      optionalTerminal: Object.freeze({
        paths: Object.freeze(optionalTerminalPacks.map((file) => file.path)),
        ...optionalTerminalMeasurement,
      }),
      optionalSemanticWorker: Object.freeze({ path: optionalSemanticWorkerPacks[0].path, ...optionalSemanticWorkerMeasurement }),
      optionalModelCatalog: Object.freeze({
        paths: Object.freeze(optionalModelCatalogPacks.map((file) => file.path)),
        ...optionalModelCatalogMeasurement,
      }),
      optionalInferenceProviders: Object.freeze({
        paths: Object.freeze(optionalInferenceProviderPacks.map((file) => file.path)),
        ...optionalInferenceProviderMeasurement,
      }),
      optionalLocalDeviceVault: Object.freeze({
        paths: Object.freeze(optionalLocalDeviceVaultPacks.map((file) => file.path)),
        ...optionalLocalDeviceVaultMeasurement,
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
      firstPartyJavaScriptAndWorkers: firstPartyJavaScriptMeasurement,
      optionalVendorRuntimeAggregate: optionalVendorRuntimeMeasurement,
      totalJavaScriptAndWorkers: totalJavaScriptMeasurement,
      serviceWorker: Object.freeze({ path: serviceWorker.path, ...serviceWorkerMeasurement }),
      companionInstallScript: Object.freeze({
        path: companionInstallScripts[0].path,
        ...companionInstallScriptMeasurement,
      }),
      entryCss: entryCssMeasurement,
      allWasm: allWasmMeasurement,
      wasm: Object.freeze(wasmFiles.map((file) => Object.freeze({ path: file.path, ...measure(file.payload) }))),
    }),
  });
}

export function isOptionalExecutionPackPath(path) {
  return /^assets\/execution-runtime-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isCompanionInstallScriptPath(path) {
  return path === "extension/install.js";
}

export function isOptionalExecutionEnginePath(path) {
  return /^assets\/execution-engine-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalExecutionSupportPath(path) {
  return /^assets\/runtime-registry-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWasiPreview1WorkerPath(path) {
  return /^assets\/wasi-preview1-worker-[A-Za-z0-9_-]+\.js$/u.test(path);
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

export function isOptionalShellPackPath(path) {
  return /^assets\/airship-shell-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWasixJavaScriptPath(path) {
  return /^assets\/(?:wasix-pack|wasix-worker|dist)-[A-Za-z0-9_-]+\.js$/u.test(path)
    || /^assets\/index-[A-Za-z0-9_-]+\.mjs$/u.test(path);
}

export function isOptionalWasixWasmPath(path) {
  return /^assets\/wasmer_js_bg-[A-Za-z0-9_-]+\.wasm$/u.test(path);
}

export function isOptionalAgentRuntimePath(path) {
  return /^assets\/agent-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalAgentToolsPath(path) {
  return /^assets\/(?:tool-bundle|client-context-runtime|context-selection|repository-admission)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceWorkbenchPath(path) {
  return /^assets\/editor-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceBindingPath(path) {
  return /^assets\/workspace-binding-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceCodecPath(path) {
  return /^assets\/content-codec-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSourceControlPath(path) {
  return /^assets\/sources-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSourceSelectionPath(path) {
  return /^assets\/source-selection-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The shared route chrome — header, tab strip and metric strip. Every route
 * fetches it, no route is first paint, so it is measured as one optional pack
 * rather than against the startup budget or against any single route.
 */
/**
 * Slash commands: the parser, registry, planner and completer. Reachable only
 * once a runtime exists and a person types `/`, so it is not startup cost.
 */
export function isOptionalSlashCommandPath(path) {
  return /^assets\/commands-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalRoutePrimitivePath(path) {
  return /^assets\/(?:route-header|tabs|metric-strip)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalApprovalReviewerPath(path) {
  return /^assets\/model-reviewer-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalBrowserGitClientPath(path) {
  return /^assets\/browser-git-client-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalBrowserGitPath(path) {
  return /^assets\/workspace-adapter-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSessionLibraryPath(path) {
  return /^assets\/sessions-route-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalCapabilitiesViewPath(path) {
  return /^assets\/capabilities-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalBrowserCapabilityPath(path) {
  return /^assets\/browser-runtime-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalMemoryViewPath(path) {
  return /^assets\/memory-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalMemorySupportPath(path) {
  return /^assets\/kind-visual-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalProofSurfacePath(path) {
  // `proof-inspector` and `seal-states` are the claim rail and the one
  // fail-closed receipt rule it renders. They left the entry chunk when the
  // rail stopped being defined inside `app.tsx`: neither can draw anything
  // until a turn has produced a receipt, so neither belongs in first paint.
  return /^assets\/(?:proof-view-[A-Za-z0-9_-]+|proof-inspector-[A-Za-z0-9_-]+|seal-states-[A-Za-z0-9_-]+|provider-client-[A-Za-z0-9_-]+|client-(?!runtime-|context-)[A-Za-z0-9_-]+)\.js$/u.test(path);
}

export function isOptionalTerminalPath(path) {
  return /^assets\/(?:terminal-view|manager)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSemanticWorkerPath(path) {
  return /^assets\/semantic\.worker-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalModelCatalogPath(path) {
  return /^assets\/(?:client-runtime|telemetry)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalInferenceProviderPath(path) {
  return /^assets\/(?:fabric|openai|provider-connections-view|providers|session-route|inference-bridge-pack)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalLocalDeviceVaultPath(path) {
  return /^assets\/(?:local-device-vault-setup|local-device-keyring|local-lab|recovery|encrypted-envelope)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isDeferredCapabilityPackPath(path) {
  return /^assets\/deferred-capabilities-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalPythonPackPath(path) {
  return path.startsWith("execution-packs/pyodide/");
}

export function assertOptionalPacksAreNotPreloaded(index) {
  if (/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/assets\/(?:deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|wasi-preview1-worker|node-webcontainer-pack|wasix-pack|wasix-worker|dist|index|agent|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|capabilities-view|browser-runtime|memory-view|kind-visual|proof-view|client|terminal-view|semantic\.worker|client-runtime|telemetry|fabric|openai|provider-connections-view|providers|session-route|local-device-vault-setup|local-device-keyring|local-lab|recovery|encrypted-envelope)-/u.test(index)) {
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
    ["release-coupled cache", /searchParams\.get\("revision"\)[\s\S]*?const CACHE_VERSION = `\$\{CACHE_PREFIX\}\$\{RELEASE_REVISION\}`;/u],
    ["scoped cache cleanup", /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_VERSION/u],
    ["release-manifest precache", /fetch\((?:"\/release-manifest\.json"|scopedPath\("release-manifest\.json"\))[\s\S]*?manifest\.artifacts[\s\S]*?cache\.addAll\(\[\.\.\.SHELL, \.\.\.new Set\(assets\)\]\)/u],
    ["same-origin boundary", /requestUrl\.origin !== self\.location\.origin/u],
    ["GET-only cache boundary", /event\.request\.method !== "GET"/u],
    ["authorization bypass", /headers\.has\("authorization"\)/u],
    ["range bypass", /headers\.has\("range"\)/u],
    ["network-first navigation", /request\.mode === "navigate"[\s\S]*?fetch\(event\.request\)[\s\S]*?caches\.match\((?:"\/"|BASE_PATH)\)/u],
    ["first-document control", /self\.clients\.claim\(\)/u],
    ["static-host navigation wrapping", /return isolatedNavigationResponse\(response\)/u],
    ["static-host embedder isolation", /"Cross-Origin-Embedder-Policy":\s*"credentialless"/u],
    ["static-host opener isolation", /"Cross-Origin-Opener-Policy":\s*"same-origin"/u],
    ["hashed asset scope", /pathname\.startsWith\((?:"\/assets\/"|scopedPath\("assets\/"\))\)/u],
    ["optional semantic pack cache", /pathname\.startsWith\((?:"\/semantic-pack\/v1\/"|scopedPath\("semantic-pack\/v1\/"\))\)/u],
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
    `Optional execution engine ${formatBytes(measurements.optionalExecutionEngine.raw)} raw / ${formatBytes(measurements.optionalExecutionEngine.gzip)} gzip`,
  );
  console.log(
    `Optional WASI Preview 1 Worker ${formatBytes(measurements.optionalWasiPreview1Worker.raw)} raw / ${formatBytes(measurements.optionalWasiPreview1Worker.gzip)} gzip`,
  );
  console.log(
    `Optional Node execution pack ${formatBytes(measurements.optionalNodeExecutionPack.raw)} raw / ${formatBytes(measurements.optionalNodeExecutionPack.gzip)} gzip`,
  );
  console.log(
    `Unpromoted WASIX JavaScript shipped ${formatBytes(measurements.optionalWasixJavaScript.raw)} raw / ${formatBytes(measurements.optionalWasixJavaScript.gzip)} gzip`,
  );
  console.log(
    `Unpromoted WASIX engine shipped ${formatBytes(measurements.optionalWasixWasm.raw)} raw / ${formatBytes(measurements.optionalWasixWasm.gzip)} gzip`,
  );
  console.log(
    `Optional agent runtime ${formatBytes(measurements.optionalAgentRuntime.raw)} raw / ${formatBytes(measurements.optionalAgentRuntime.gzip)} gzip`,
  );
  console.log(
    `Optional agent tools ${formatBytes(measurements.optionalAgentTools.raw)} raw / ${formatBytes(measurements.optionalAgentTools.gzip)} gzip`,
  );
  console.log(
    `Optional Workspace workbench ${formatBytes(measurements.optionalWorkspaceWorkbench.raw)} raw / ${formatBytes(measurements.optionalWorkspaceWorkbench.gzip)} gzip`,
  );
  console.log(
    `Optional source control ${formatBytes(measurements.optionalSourceControl.raw)} raw / ${formatBytes(measurements.optionalSourceControl.gzip)} gzip`,
  );
  console.log(
    `Optional browser Git ${formatBytes(measurements.optionalBrowserGit.raw)} raw / ${formatBytes(measurements.optionalBrowserGit.gzip)} gzip`,
  );
  console.log(
    `Optional session library ${formatBytes(measurements.optionalSessionLibrary.raw)} raw / ${formatBytes(measurements.optionalSessionLibrary.gzip)} gzip`,
  );
  console.log(
    `Optional Memory view ${formatBytes(measurements.optionalMemoryView.raw)} raw / ${formatBytes(measurements.optionalMemoryView.gzip)} gzip`,
  );
  console.log(
    `Optional Memory support ${formatBytes(measurements.optionalMemorySupport.raw)} raw / ${formatBytes(measurements.optionalMemorySupport.gzip)} gzip`,
  );
  console.log(
    `Optional Proof surface ${formatBytes(measurements.optionalProofSurface.raw)} raw / ${formatBytes(measurements.optionalProofSurface.gzip)} gzip`,
  );
  console.log(
    `Optional Python pack ${formatBytes(measurements.optionalPythonPack.raw)} raw / ${formatBytes(measurements.optionalPythonPack.gzip)} gzip`,
  );
  console.log(
    `First-party/all-other JS ${formatBytes(measurements.firstPartyJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.firstPartyJavaScriptAndWorkers.gzip)} gzip`,
  );
  console.log(
    `Vendor runtime aggregate ${formatBytes(measurements.optionalVendorRuntimeAggregate.raw)} raw / ${formatBytes(measurements.optionalVendorRuntimeAggregate.gzip)} gzip`,
  );
  console.log(
    `Installed bundled JS/workers ${formatBytes(measurements.totalJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.totalJavaScriptAndWorkers.gzip)} gzip`,
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

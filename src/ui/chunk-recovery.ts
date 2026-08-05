/**
 * Re-fetching a route chunk whose first fetch failed.
 *
 * Measured defect: three presses of "Retry loading Memory" with the network
 * restored issued **zero** network requests, and leaving the route and coming
 * back issued zero more — the card, and the route, stayed dead for the life of
 * the tab. The loader was not at fault: `deferredChunkAttempt` re-ran it every
 * time. A module URL that has once failed to fetch is recorded as failed in
 * the document's module map, so every later `import()` of the same specifier
 * rejects from memory without touching the network. The retry verb could not
 * succeed, whatever the network was doing.
 *
 * The only way back to the network is a URL the map has not seen. A failed
 * attempt records the asset URLs Vite's preload helper appended for it — which
 * are exactly this chunk's own file and its stylesheet — and a retry re-imports
 * the chunk under a fresh query. Its static imports still resolve to the
 * original URLs, so a dependency that already loaded is reused rather than
 * duplicated.
 *
 * The limit is stated rather than hidden: when a chunk's *dependencies* also
 * failed, re-importing the entry still fails on them, and the route reports the
 * same honest failure it does today. This recovers the single-asset case, which
 * is the one a person meets when one request is dropped.
 */

/** Distinguishes the retry fetch from the poisoned one; ignored by any host. */
const RETRY_PARAMETER = "airship-chunk-retry";

/** Monotonic per document, so a third attempt is not served the second's URL. */
let generation = 0;

/** Asset URLs a named chunk's failed attempt appended, keyed by chunk name. */
const failedAssets = new Map<string, readonly string[]>();

/** Entry URL captured on the first failure, before a person asks to retry. */
const failedEntries = new Map<string, string>();

/** Modules recovered under a fresh URL, so one retry makes one instance. */
const recovered = new Map<string, Promise<unknown>>();

function assetHrefs(): string[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"], link[rel="stylesheet"]')]
    .map((link) => link.href);
}

function bust(href: string, stamp: number): string {
  const url = new URL(href, document.baseURI);
  url.searchParams.set(RETRY_PARAMETER, String(stamp));
  return url.href;
}

/**
 * The chunk's own script among the assets its attempt appended.
 *
 * Vite names an async chunk after the module it was split from, which is the
 * same convention the release gate classifies assets by, so the caller's name
 * identifies the entry without depending on the order of the dep table.
 */
export function entryAsset(name: string, assets: readonly string[]): string | undefined {
  /*
   * `name` then exactly one content hash. A bare prefix test would accept
   * `memory-view-…` for `memory` and import a different module while reporting
   * it as this route; splitting on the last `-` instead is what actually broke
   * in the browser, because a base64url hash contains `-` of its own
   * (`memory-view-CmB-cEIq.js`), so the recovery silently found no entry and
   * the retry stayed dead. The hash width is the build's, asserted by the same
   * `[A-Za-z0-9_-]` alphabet the release gate classifies assets with.
   */
  const built = new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}-[A-Za-z0-9_-]{8}\\.js$`, "u");
  return assets.find((href) => built.test((href.split("/").pop() ?? "").split("?")[0]!));
}

function restyle(href: string, stamp: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.crossOrigin = "";
    link.href = bust(href, stamp);
    link.addEventListener("load", () => resolve());
    // A route that came back without its stylesheet would be a worse answer
    // than the failure card: unstyled, and claiming to have recovered.
    link.addEventListener("error", () => reject(new Error(`Unable to reload CSS for ${href}`)));
    document.head.appendChild(link);
  });
}

/**
 * Load a deferred chunk so that a later attempt can actually reach the network.
 *
 * `name` is both the registry key and the built chunk's file-name stem.
 */
export async function loadRetryableChunk<T>(
  name: string,
  load: () => Promise<T>,
  developmentEntry?: string,
): Promise<T> {
  const already = recovered.get(name);
  if (already) return await already as T;
  const before = new Set(assetHrefs());
  try {
    return await load();
  } catch (error) {
    const added = assetHrefs().filter((href) => !before.has(href));
    const previous = failedAssets.get(name) ?? [];
    const assets = added.length ? added : previous;
    if (assets.length) failedAssets.set(name, assets);
    const previousEntry = failedEntries.get(name);
    const discoveredEntry = entryAsset(name, assets) ?? developmentEntry;
    if (discoveredEntry) failedEntries.set(name, discoveredEntry);
    // The first failure is reported as it happened. Re-fetching immediately
    // would only re-run the request that just failed under a different URL, and
    // the person has not asked for a retry yet.
    const entry = previousEntry;
    if (!entry) throw error;
    const stamp = ++generation;
    const attempt = (async () => {
      for (const href of assets) {
        if (href.split("?")[0]!.endsWith(".css")) await restyle(href, stamp);
      }
      return await import(/* @vite-ignore */ bust(entry, stamp)) as T;
    })();
    recovered.set(name, attempt);
    // A recovery that fails must not be replayed as this chunk's answer: the
    // next press starts from the loader again.
    attempt.catch(() => recovered.delete(name));
    return await attempt;
  }
}

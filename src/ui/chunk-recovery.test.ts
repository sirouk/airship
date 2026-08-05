import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { entryAsset } from "./chunk-recovery";

const [source, appSource] = await Promise.all([
  readFile(new URL("./chunk-recovery.ts", import.meta.url), "utf8"),
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
]);

/**
 * The measured defect this module exists for: three presses of "Retry loading
 * Memory" with the network restored issued zero requests, because a module URL
 * that has failed once is recorded as failed in the document's module map. The
 * loader was re-running correctly; the platform refused to re-fetch.
 */
describe("deferred chunk recovery", () => {
  it("finds the chunk's own script among the assets its failed attempt appended", () => {
    const assets = [
      "http://host/assets/message-parts-DuKDgNYw.js",
      "http://host/assets/memory-view-CAy6ulDE.js",
      "http://host/assets/memory-view-BR_l5oM7.css",
    ];
    expect(entryAsset("memory-view", assets)).toBe("http://host/assets/memory-view-CAy6ulDE.js");
  });

  /*
   * The build hash is base64url, so it contains `-` of its own. Splitting the
   * file name on its last `-` looked right against `memory-view-CAy6ulDE.js`
   * and found no entry at all against the very next build's
   * `memory-view-CmB-cEIq.js` — measured in the browser as a retry that went
   * back to issuing zero requests.
   */
  it("reads a hash that contains a dash", () => {
    expect(entryAsset("memory-view", ["http://host/assets/memory-view-CmB-cEIq.js"]))
      .toBe("http://host/assets/memory-view-CmB-cEIq.js");
  });

  it("never mistakes the chunk's stylesheet for the module to import", () => {
    expect(entryAsset("memory-view", ["http://host/assets/memory-view-BR_l5oM7.css"])).toBeUndefined();
  });

  it("never mistakes a differently named neighbour for the chunk", () => {
    // `memory-view-support-…` is a different chunk; the stem must match the
    // whole name up to the content hash, or a retry would import the wrong
    // module and report it as the route.
    expect(entryAsset("memory", ["http://host/assets/memory-view-CAy6ulDE.js"])).toBeUndefined();
  });

  it("reports the first failure rather than immediately re-requesting the URL that just failed", () => {
    // The retry is a person's decision. Re-fetching inside the same rejection
    // would spend a second request on a network that has just proved it cannot
    // serve the first, and would report a second failure for one attempt.
    expect(source).toContain("const entry = previousEntry;");
  });

  it("captures a development-server entry without treating the first failure as a retry", () => {
    expect(source).toContain("const discoveredEntry = entryAsset(name, assets) ?? developmentEntry;");
    expect(source).toContain("if (discoveredEntry) failedEntries.set(name, discoveredEntry);");
    expect(appSource).toContain('developmentChunkEntry("approval-dock.tsx")');
  });

  it("restores the chunk's stylesheet before importing it, so a recovered route is never unstyled", () => {
    expect(source).toContain('if (href.split("?")[0]!.endsWith(".css")) await restyle(href, stamp);');
    expect(source).toContain("Unable to reload CSS for");
  });

  it("does not replay a failed recovery as the chunk's answer", () => {
    expect(source).toContain("attempt.catch(() => recovered.delete(name));");
  });

  it("is what the Memory route loads through, since that is the failure it was measured on", () => {
    expect(appSource).toContain('"memory-view",\n      () => import("./memory-view"),');
  });

  it("also owns the deferred Skills route's retry path", () => {
    expect(appSource).toContain('"skills-manager-view",\n      () => import("./skills-manager-view"),');
    expect(appSource).toContain('developmentChunkEntry("skills-manager-view.tsx")');
  });
});

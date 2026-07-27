import { describe, expect, it } from "vitest";
import {
  EXTENSION_TARGETS,
  FIREFOX_MIN_VERSION,
  SAFARI_MIN_VERSION,
  buildManifest,
} from "./manifest";
import { EXTENSION_VERSION, callerAllowlist, callerMatchPatterns, destinationMatchPatterns } from "./policy";

describe("manifests", () => {
  it("derives content-script matches and host permissions from the enforced allowlists", () => {
    for (const target of EXTENSION_TARGETS) {
      const manifest = buildManifest(target, "release");
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.version).toBe(EXTENSION_VERSION);
      expect(manifest.host_permissions).toEqual([...destinationMatchPatterns()]);
      const scripts = manifest.content_scripts as readonly Readonly<Record<string, unknown>>[];
      expect(scripts[0]?.matches).toEqual([...callerMatchPatterns(callerAllowlist("release"))]);
      expect(scripts[0]?.all_frames).toBe(false);
      expect(scripts[0]?.run_at).toBe("document_start");
      // externally_connectable is Chromium-only and would be a second, weaker
      // door into the worker.
      expect(manifest).not.toHaveProperty("externally_connectable");
      expect(JSON.stringify(manifest)).not.toContain("externally_connectable");
    }
  });

  it("marks a development build and carries the loopback origins only there", () => {
    const development = buildManifest("chromium", "development");
    expect(development.name).toContain("development");
    const scripts = development.content_scripts as readonly Readonly<Record<string, unknown>>[];
    expect(scripts[0]?.matches).toContain("http://localhost:4173/*");
    const release = buildManifest("chromium", "release");
    expect(JSON.stringify(release.content_scripts)).not.toContain("localhost");
  });

  it("asks each browser only for the mechanism that browser actually has", () => {
    const chromium = buildManifest("chromium", "release");
    expect(chromium.background).toEqual({ service_worker: "background.js" });
    expect(chromium.permissions).toEqual(["declarativeNetRequestWithHostAccess", "unlimitedStorage"]);

    const firefox = buildManifest("firefox", "release");
    // An MV3 event page, non-persistent by definition; `persistent` is not a
    // valid Gecko MV3 key and must not appear.
    expect(firefox.background).toEqual({ scripts: ["background.js"] });
    expect(firefox.permissions).toEqual(["webRequest", "webRequestBlocking", "unlimitedStorage"]);
    expect(firefox.browser_specific_settings).toMatchObject({
      gecko: { id: expect.any(String), strict_min_version: FIREFOX_MIN_VERSION },
    });

    // Safari has no header-rewrite mechanism at all, so it asks for none and
    // the worker will report the Anthropic OAuth hosts as unavailable.
    const safari = buildManifest("safari", "release");
    expect(safari.background).toEqual({ scripts: ["background.js"], persistent: false });
    expect(safari).not.toHaveProperty("permissions");
    expect(safari.browser_specific_settings).toEqual({
      safari: { strict_min_version: SAFARI_MIN_VERSION },
    });
    // A rewrite permission Safari cannot honour would be a request the user is
    // asked to grant for a capability that does not exist.
    expect(JSON.stringify(safari)).not.toContain("declarativeNetRequest");
    expect(JSON.stringify(safari)).not.toContain("webRequest");
  });

  it("declares a minimum engine version matching what the bundle is compiled for", () => {
    // build.mjs compiles firefox128 and safari16.4. A manifest that claimed an
    // older engine would install where the syntax does not parse.
    expect(FIREFOX_MIN_VERSION).toBe("128.0");
    expect(SAFARI_MIN_VERSION).toBe("16.4");
    expect(buildManifest("chromium", "release").minimum_chrome_version).toBe("116");
  });
});

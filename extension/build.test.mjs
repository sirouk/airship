import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHANNELS, SYNTAX_TARGETS, TARGETS, buildExtension, verifyBundle } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = resolve(here, "build", ".test");

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("extension build", () => {
  it("produces a loadable Chromium MV3 build from the shared source tree", async () => {
    const result = await buildExtension({
      target: "chromium",
      channel: "release",
      outDir: resolve(scratch, "chromium"),
    });
    expect(result.manifest.manifest_version).toBe(3);
    expect(result.artifacts.map((artifact) => artifact.file)).toEqual([
      "background.js",
      "content-script.js",
    ]);
    expect(result.artifacts.every((artifact) => artifact.bytes > 0)).toBe(true);

    const manifest = JSON.parse(await readFile(resolve(scratch, "chromium", "manifest.json"), "utf8"));
    expect(manifest.content_scripts[0].matches).toEqual(["https://sirouk.github.io/airship/*"]);
    expect(manifest.host_permissions).toContain("https://platform.claude.com/v1/oauth/*");

    const background = await readFile(resolve(scratch, "chromium", "background.js"), "utf8");
    // The allowlists must be compiled into the artifact, not fetched.
    expect(background).toContain("https://platform.claude.com/v1/oauth/");
    expect(background).toContain("https://sirouk.github.io");
    expect(background).not.toContain("localhost:4173");
    expect(verifyBundle("background.js", background)).toEqual([]);
  });

  it("compiles the development caller allowlist only into a development build", async () => {
    await buildExtension({
      target: "firefox",
      channel: "development",
      outDir: resolve(scratch, "firefox-development"),
    });
    const manifest = JSON.parse(
      await readFile(resolve(scratch, "firefox-development", "manifest.json"), "utf8"),
    );
    expect(manifest.background).toEqual({ scripts: ["background.js"] });
    expect(manifest.content_scripts[0].matches).toContain("http://localhost:4173/*");
    const content = await readFile(resolve(scratch, "firefox-development", "content-script.js"), "utf8");
    expect(content).toContain("http://localhost:4173");
  });

  it("produces a Safari-shaped build from the same source tree", async () => {
    const result = await buildExtension({
      target: "safari",
      channel: "release",
      outDir: resolve(scratch, "safari"),
    });
    const manifest = JSON.parse(await readFile(resolve(scratch, "safari", "manifest.json"), "utf8"));
    // A non-persistent background page, not a service worker, and no rewrite
    // permission — Safari has no mechanism to honour one.
    expect(manifest.background).toEqual({ scripts: ["background.js"], persistent: false });
    expect(manifest.permissions).toBeUndefined();
    // The declared engine minimum and the compiled syntax target are the same
    // release, so the manifest cannot admit a Safari the bundle will not parse.
    expect(manifest.browser_specific_settings.safari.strict_min_version).toBe("16.4");
    expect(SYNTAX_TARGETS.safari).toEqual(["safari16.4"]);
    expect(result.artifacts.every((artifact) => artifact.bytes > 0)).toBe(true);

    const background = await readFile(resolve(scratch, "safari", "background.js"), "utf8");
    expect(background).toContain("https://api.x.ai/v1/");
    expect(background).not.toContain("localhost:4173");
    expect(verifyBundle("background.js", background)).toEqual([]);
  });

  it("compiles each target at the engine version its manifest declares", async () => {
    const chromium = await buildExtension({
      target: "chromium",
      channel: "release",
      outDir: resolve(scratch, "chromium-versions"),
    });
    expect(chromium.manifest.minimum_chrome_version).toBe("116");
    expect(SYNTAX_TARGETS.chromium).toEqual(["chrome116"]);

    const firefox = await buildExtension({
      target: "firefox",
      channel: "release",
      outDir: resolve(scratch, "firefox-versions"),
    });
    expect(firefox.manifest.browser_specific_settings.gecko.strict_min_version).toBe("128.0");
    expect(SYNTAX_TARGETS.firefox).toEqual(["firefox128"]);
  });

  it("fails closed on an unknown target or channel", async () => {
    await expect(buildExtension({ target: "netscape", channel: "release" })).rejects.toThrow();
    await expect(buildExtension({ target: "chromium", channel: "beta" })).rejects.toThrow();
    expect([...TARGETS]).toEqual(["chromium", "firefox", "safari"]);
    expect([...CHANNELS]).toEqual(["release", "development"]);
  });

  it("rejects a bundle that reached for storage, logging or another door", () => {
    expect(verifyBundle("x.js", "chrome.storage.local.set({})"))
      .toEqual([expect.stringContaining("storage")]);
    expect(verifyBundle("x.js", "console.log(headers)")).toEqual([expect.stringContaining("console")]);
    expect(verifyBundle("x.js", "\"externally_connectable\""))
      .toEqual([expect.stringContaining("externally_connectable")]);
    expect(verifyBundle("x.js", "const relay = 1;")).toEqual([]);
  });
});

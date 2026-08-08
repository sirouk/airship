import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyLocalDevelopmentPolicy,
  DEVELOPMENT_OPTIMIZE_ENTRIES,
  DEVELOPMENT_WATCH_IGNORES,
  resolveAirshipModulePreloadDependencies,
  rewriteLocalExtensionHubRequest,
} from "./vite.config";

describe("local development CSP", () => {
  it("adds only the reviewed loopback S3 origins and leaves every other directive alone", () => {
    const source = "style-src 'self'; connect-src 'self' https://api.chutes.ai;";
    const transformed = applyLocalDevelopmentPolicy(source);
    expect(transformed).toBe(
      "style-src 'self'; connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 https://api.chutes.ai;",
    );
  });

  it("widens the policy the application actually ships, not a synthetic one", () => {
    // The removed style-src rewrite passed for as long as it did because the
    // case above fed it a hand-written string. Read the real document, so a
    // reworded directive is a red test rather than a rewrite that silently
    // matches nothing.
    const html = readFileSync("index.html", "utf8");
    expect(applyLocalDevelopmentPolicy(html)).toContain(
      "connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 https://api.chutes.ai",
    );
  });

  it("does not widen unrelated or already-missing directives", () => {
    expect(applyLocalDevelopmentPolicy("default-src 'self';")).toBe("default-src 'self';");
  });

  it("keeps generated browser-test and build artifacts outside the live reload graph", () => {
    expect(DEVELOPMENT_WATCH_IGNORES).toEqual(expect.arrayContaining([
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.airship-lab/**",
      "**/dist/**",
    ]));
    expect(DEVELOPMENT_WATCH_IGNORES).not.toContain("**/src/**");
    expect(Object.isFrozen(DEVELOPMENT_WATCH_IGNORES)).toBe(true);
  });

  it("scans only the web application HTML entry for development dependencies", () => {
    expect(DEVELOPMENT_OPTIMIZE_ENTRIES).toEqual(["index.html"]);
    expect(Object.isFrozen(DEVELOPMENT_OPTIMIZE_ENTRIES)).toBe(true);
  });

  it("serves the Companion installer at the natural development hub path", () => {
    expect(rewriteLocalExtensionHubRequest("/extension/", "/")).toBe("/extension/index.html");
    expect(rewriteLocalExtensionHubRequest("/extension?source=connect", "/"))
      .toBe("/extension/index.html?source=connect");
    expect(rewriteLocalExtensionHubRequest("/airship/extension/", "/airship/"))
      .toBe("/airship/extension/index.html");
    expect(rewriteLocalExtensionHubRequest("/extension/privacy.html", "/"))
      .toBe("/extension/privacy.html");
  });

  it("keeps optional packs out of HTML preloads without disabling just-in-time dynamic preloads", () => {
    const dependencies = [
      "assets/core-shared-abc.js",
      "assets/workspace-adapter-def.js",
      "assets/local-device-keyring-ghi.js",
      "assets/provider-connections-view-jkl.js",
      "assets/skills-manager-view-mno.js",
    ];
    expect(resolveAirshipModulePreloadDependencies("index.html", dependencies, {
      hostId: "index.html",
      hostType: "html",
    })).toEqual(["assets/core-shared-abc.js"]);
    expect(resolveAirshipModulePreloadDependencies("assets/index.js", dependencies, {
      hostId: "assets/index.js",
      hostType: "js",
    })).toBe(dependencies);
  });
});

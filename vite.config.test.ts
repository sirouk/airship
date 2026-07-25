import { describe, expect, it } from "vitest";
import {
  applyLocalDevelopmentPolicy,
  DEVELOPMENT_WATCH_IGNORES,
  resolveAirshipModulePreloadDependencies,
} from "./vite.config";

describe("local development CSP", () => {
  it("adds only the reviewed loopback S3 origins and development style exception", () => {
    const source = "style-src 'self'; connect-src 'self' https://api.chutes.ai;";
    const transformed = applyLocalDevelopmentPolicy(source);
    expect(transformed).toBe(
      "style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 https://api.chutes.ai;",
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

  it("keeps optional packs out of HTML preloads without disabling just-in-time dynamic preloads", () => {
    const dependencies = [
      "assets/core-shared-abc.js",
      "assets/workspace-adapter-def.js",
      "assets/local-device-keyring-ghi.js",
      "assets/provider-connections-view-jkl.js",
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

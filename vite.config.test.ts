import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LOCAL_LAB_ABSENT_MODULE,
  LOCAL_LAB_ONLY_MODULES,
  applyLocalDevelopmentPolicy,
  DEVELOPMENT_OPTIMIZE_ENTRIES,
  DEVELOPMENT_WATCH_IGNORES,
  isLocalLabOnlyModule,
  isPrimeKernelWorkerRequest,
  PRIME_KERNEL_WORKER_ASSET_SUFFIX,
  PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
  PRIME_KERNEL_WORKER_RESPONSE_HEADERS,
  resolveAirshipModulePreloadDependencies,
  resolveAirshipWorkerEntryFileName,
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
      "connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 https:",
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


describe("host-composed loopback lab", () => {
  /*
   * A stock build externalizes these four so the bundler emits no chunk for
   * them. Suffix matching has to be exact: `local-lab-live.ts` is the live test
   * harness and `local-lab.test.ts` is its unit test, and externalizing either
   * would break a suite rather than shrink a bundle.
   */
  it("names exactly the modules a stock build must not contain", () => {
    expect([...LOCAL_LAB_ONLY_MODULES]).toEqual([
      "/src/storage/s3-object-store.ts",
      "/src/ui/local-lab-setup.tsx",
      "/src/ui/local-lab-vault.ts",
      "/src/vault/local-lab.ts",
    ]);
    expect(Object.isFrozen(LOCAL_LAB_ONLY_MODULES)).toBe(true);
    expect(LOCAL_LAB_ABSENT_MODULE).toBe("airship:local-lab-is-not-in-this-build");
  });

  it("matches a resolved lab module and nothing that merely looks like one", () => {
    for (const id of [
      "/repo/src/vault/local-lab.ts",
      "/repo/src/ui/local-lab-setup.tsx?used",
      "C:\\repo\\src\\ui\\local-lab-vault.ts",
      "/repo/src/storage/s3-object-store.ts",
    ]) {
      expect(isLocalLabOnlyModule(id), id).toBe(true);
    }
    for (const id of [
      "/repo/src/vault/local-lab-live.ts",
      "/repo/src/vault/local-lab.test.ts",
      "/repo/src/ui/local-lab-namespace.test.ts",
      "/repo/src/vault/local-device.ts",
      "/repo/src/storage/local-device-object-store.ts",
      "/repo/node_modules/evil/src/vault/local-lab.ts.js",
    ]) {
      expect(isLocalLabOnlyModule(id), id).toBe(false);
    }
  });
});

describe("Prime kernel worker asset", () => {
  it("keeps the Vite content hash and a base-independent dedicated suffix", () => {
    expect(resolveAirshipWorkerEntryFileName({ name: "prime-kernel-worker" }))
      .toBe("assets/[hash].prime-kernel-worker.js");
    expect(resolveAirshipWorkerEntryFileName({ name: "semantic.worker" }))
      .toBe("assets/[name]-[hash].js");
    expect(PRIME_KERNEL_WORKER_ASSET_SUFFIX).toBe(".prime-kernel-worker.js");
  });

  it("recognizes only the worker source route or hashed asset below the configured base", () => {
    expect(isPrimeKernelWorkerRequest(
      "/src/prime/kernel/prime-kernel-worker.ts?worker_file&type=module",
      "/",
    )).toBe(true);
    expect(isPrimeKernelWorkerRequest(
      "/airship/assets/AbC_123-x.prime-kernel-worker.js",
      "/airship/",
    )).toBe(true);

    expect(isPrimeKernelWorkerRequest(
      "/assets/AbC_123-x.prime-kernel-worker.js",
      "/airship/",
    )).toBe(false);
    expect(isPrimeKernelWorkerRequest(
      "/airship/assets/prime-kernel-worker-AbC_123.js",
      "/airship/",
    )).toBe(false);
    expect(isPrimeKernelWorkerRequest(
      "https://attacker.example/airship/assets/AbC_123.prime-kernel-worker.js",
      "/airship/",
    )).toBe(false);
    expect(isPrimeKernelWorkerRequest(
      "/src/prime/kernel/prime-kernel-worker.ts?type=module&worker_file",
      "/",
    )).toBe(false);
    expect(isPrimeKernelWorkerRequest(
      "/src/prime/kernel/prime-kernel-worker.ts?worker_file&type=module&extra=1",
      "/",
    )).toBe(false);
    expect(isPrimeKernelWorkerRequest(
      "/airship/assets/AbC_123-x.prime-kernel-worker.js?token=secret",
      "/airship/",
    )).toBe(false);
  });

  it("uses the exact worker-only policy and response-header set", () => {
    expect(PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
    );
    expect(PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY).not.toContain("'self'");
    expect(PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY).not.toContain("trusted-types");
    expect(PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY).not.toContain("base-uri");
    expect(PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY).not.toContain("object-src");
    expect(PRIME_KERNEL_WORKER_RESPONSE_HEADERS).toEqual({
      "Content-Security-Policy": PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    expect(readFileSync("index.html", "utf8")).not.toContain("script-src 'self' 'unsafe-eval'");
  });
});

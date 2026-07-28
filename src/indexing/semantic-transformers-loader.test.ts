import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyOrtAcceleration,
  boundedOrtThreadCount,
  installOrtThreadWorkerPolicy,
  ortPowerPreference,
  ortRuntimeBinariesNamedBy,
  ortSpawnsThreadWorkers,
  pinOrtRuntimePaths,
  semanticPackAssetPaths,
  semanticPackBytes,
  unpinnedOrtRuntimeBinaries,
  MAX_ORT_THREADS,
  REQUIRED_ORT_RUNTIME_BINARIES,
  type OrtBackendEnv,
  type ScriptUrlPolicyHost,
} from "./semantic-transformers-loader";
import artifactManifest from "./semantic-artifact-manifest.json";

/**
 * Transformers.js publishes `env.backends.onnx` as a shallow copy of the ONNX
 * Runtime env, so this fixture reproduces that exact shape: the nested records
 * are shared with the runtime, the outer object is not.
 */
function transformersEnv(): Readonly<{ runtime: OrtBackendEnv; exposed: OrtBackendEnv }> {
  const runtime: OrtBackendEnv = { wasm: { wasmPaths: "cdn/" }, webgpu: { powerPreference: "high-performance" } };
  return { runtime, exposed: { ...runtime } };
}

describe("ONNX Runtime acceleration policy", () => {
  it("reaches the runtime env that actually reads the flags, not the copy alone", () => {
    const { runtime, exposed } = transformersEnv();
    applyOrtAcceleration(exposed, { backend: "wasm", powerPreference: "low-power", wasmThreads: 5 });
    expect(runtime.wasm?.numThreads).toBe(5);
  });

  it("overrides the pack's hard-coded high-performance adapter preference on the WebGPU rung", () => {
    const { runtime, exposed } = transformersEnv();
    applyOrtAcceleration(exposed, { backend: "webgpu", powerPreference: "low-power", wasmThreads: 2 });
    expect(runtime.webgpu?.powerPreference).toBe("low-power");
  });

  it("keeps the pack's own preference when the policy expresses none, instead of downgrading on non-evidence", () => {
    const { runtime, exposed } = transformersEnv();
    applyOrtAcceleration(exposed, { backend: "webgpu", powerPreference: "default" });
    // "default" means the battery/save-data signals said nothing. Deleting the
    // reviewed pin here would hand a multi-GPU host to its integrated adapter
    // on no evidence at all.
    expect(runtime.webgpu?.powerPreference).toBe("high-performance");
    // ORT itself still rejects the literal "default", so nothing may write it.
    expect(ortPowerPreference("default")).toBeUndefined();
    expect(ortPowerPreference("high-performance")).toBe("high-performance");
    expect(ortPowerPreference()).toBeUndefined();
  });

  it("leaves the adapter preference alone when no policy was observed or the rung is WASM", () => {
    const withoutPolicy = transformersEnv();
    applyOrtAcceleration(withoutPolicy.exposed, { backend: "webgpu", wasmThreads: 3 });
    expect(withoutPolicy.runtime.webgpu?.powerPreference).toBe("high-performance");

    const wasmRung = transformersEnv();
    applyOrtAcceleration(wasmRung.exposed, { backend: "wasm", powerPreference: "low-power" });
    expect(wasmRung.runtime.webgpu?.powerPreference).toBe("high-performance");
  });

  it("bounds the thread request and ignores a non-finite count", () => {
    const high = transformersEnv();
    applyOrtAcceleration(high.exposed, { backend: "wasm", wasmThreads: 64 });
    expect(high.runtime.wasm?.numThreads).toBe(8);

    const invalid = transformersEnv();
    applyOrtAcceleration(invalid.exposed, { backend: "wasm", wasmThreads: Number.NaN });
    expect(invalid.runtime.wasm?.numThreads).toBeUndefined();
  });
});

describe("semantic pack byte accounting", () => {
  it("names every pinned asset of a backend exactly once", () => {
    for (const backend of ["webgpu", "wasm"] as const) {
      const paths = semanticPackAssetPaths(backend);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(artifactManifest.assets[path]).toBeDefined();
      expect(Object.isFrozen(paths)).toBe(true);
    }
    expect(semanticPackAssetPaths("webgpu")).toContain("models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_q4f16.onnx");
    expect(semanticPackAssetPaths("wasm")).toContain("models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_quantized.onnx");
  });

  it("totals the exact reviewed byte counts, so a manifest edit cannot pass unreviewed", () => {
    // Hardcoded on purpose. Recomputing the same reduce over the same manifest
    // could not fail for any implementation that sums the same list, which
    // pins nothing: these two numbers are the reviewed download cost, and any
    // artifact change must be re-stated here to pass. Both rungs now share the
    // single asyncify ORT binary (22,819,905 B) the pinned bundle actually
    // loads, so the two totals differ only by the model dtype.
    expect(semanticPackBytes("webgpu")).toBe(57_685_767);
    expect(semanticPackBytes("wasm")).toBe(49_248_081);
    expect(semanticPackBytes("webgpu") - semanticPackBytes("wasm")).toBe(
      artifactManifest.assets["models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_q4f16.onnx"].bytes
      - artifactManifest.assets["models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_quantized.onnx"].bytes,
    );
  });
});

describe("pinned ONNX Runtime binaries", () => {
  /**
   * A shallow copy of a nested record, exactly as transformers.js publishes it.
   * A pin that replaces `onnx.wasm` writes only to this copy and never reaches
   * the runtime, which is how the previous jsdelivr wasmPaths survived.
   */
  it("writes wasmPaths through the shallow copy into the record ORT reads", () => {
    const { runtime, exposed } = transformersEnv();
    pinOrtRuntimePaths(exposed, "/semantic-pack/v1/runtime/");
    expect(runtime.wasm?.wasmPaths).toBe("/semantic-pack/v1/runtime/");
  });

  /**
   * The exact artifact the pack publishes, proven identical to the manifest pin
   * before anything is derived from it. Reading node_modules would otherwise
   * prove nothing about the file a browser actually receives.
   */
  function pinnedOrtBundleSource(): string {
    const path = "runtime/ort.webgpu.bundle.min.mjs";
    const bytes = readFileSync(`node_modules/onnxruntime-web/dist/${path.slice("runtime/".length)}`);
    expect(bytes.byteLength).toBe(artifactManifest.assets[path].bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifactManifest.assets[path].sha256);
    return bytes.toString("utf8");
  }

  it("pins every ORT binary the bundle itself names, derived from the bundle", () => {
    // Derived, never listed: the previous hand-kept list said .jsep/plain and
    // survived ONNX Runtime's rename to .asyncify, so the pack verified 38 MiB
    // of files the runtime never loads while the two it does load were absent
    // and could only come from the CDN the CSP blocks.
    const named = ortRuntimeBinariesNamedBy(pinnedOrtBundleSource());
    expect(named.length).toBeGreaterThan(0);
    for (const path of named) expect(artifactManifest.assets).toHaveProperty(path);
    // Every rung imports the same asyncify factory and binary, so both must
    // fetch and hash them before ORT does.
    for (const backend of ["webgpu", "wasm"] as const) {
      for (const path of named) expect(semanticPackAssetPaths(backend)).toContain(path);
    }
    // The loader's compile-time constant cannot read the bundle at runtime, so
    // this is what keeps it equal to the artifact.
    expect([...REQUIRED_ORT_RUNTIME_BINARIES].sort()).toEqual(named);
    expect(unpinnedOrtRuntimeBinaries()).toEqual([]);
  });

  it("counts a Worker name as a name, not as a fetched artifact", () => {
    // `ort-wasm-proxy-worker` appears verbatim in the same bundle; pinning it
    // would demand a file onnxruntime-web does not publish.
    expect(ortRuntimeBinariesNamedBy(pinnedOrtBundleSource())).not.toContain("runtime/ort-wasm-proxy-worker");
    expect(ortRuntimeBinariesNamedBy('name="ort-wasm-proxy-worker";locateFile("ort-wasm-x.wasm")')).toEqual([
      "runtime/ort-wasm-x.wasm",
    ]);
  });

  it("drops the binaries the pinned bundle never names", () => {
    // Removing these is the other half of the fix: they were 37.9 MiB of
    // download and SHA-256 work for files ORT does not load under this pin.
    for (const dead of [
      "runtime/ort-wasm-simd-threaded.mjs",
      "runtime/ort-wasm-simd-threaded.wasm",
      "runtime/ort-wasm-simd-threaded.jsep.mjs",
      "runtime/ort-wasm-simd-threaded.jsep.wasm",
    ]) {
      expect(artifactManifest.assets).not.toHaveProperty(dead);
      expect(ortRuntimeBinariesNamedBy(pinnedOrtBundleSource())).not.toContain(dead);
    }
  });

  it("still names the Worker constructor the pinned ORT factory reaches", () => {
    // The whole Trusted Types allowance below exists for this one line of
    // onnxruntime-web. If a future ORT stops constructing its own Workers, the
    // default policy and the CSP entry should go with it.
    const factory = readFileSync("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", "utf8");
    expect(factory).toContain("new Worker(new URL(import.meta.url)");
  });
});

describe("ONNX Runtime thread workers under Trusted Types", () => {
  function trustedTypesHost(): {
    host: ScriptUrlPolicyHost;
    created: { name: string; createScriptURL(value: string): string }[];
    allow: boolean;
  } {
    const created: { name: string; createScriptURL(value: string): string }[] = [];
    const state = {
      allow: true,
      created,
      host: {
        location: { href: "https://airship.example/index.html" },
        trustedTypes: {
          createPolicy(name: string, rules: Readonly<{ createScriptURL(value: string): string }>) {
            if (!state.allow) throw new TypeError(`Failed to create a TrustedTypePolicy named '${name}'`);
            created.push({ name, createScriptURL: rules.createScriptURL });
            return rules;
          },
        },
      } satisfies ScriptUrlPolicyHost,
    };
    return state;
  }

  it("predicts the worker spawn from the two conditions ORT itself applies", () => {
    // Not isolated: ORT overwrites any request with 1 and spawns nothing.
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: false })).toBe(false);
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: false, wasmThreads: 8 })).toBe(false);
    // Isolated and unspecified: ORT picks min(4, ceil(cores / 2)) for itself,
    // which is the case the pack would otherwise miss entirely.
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: true })).toBe(true);
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: true, wasmThreads: Number.NaN })).toBe(true);
    // Isolated and explicitly single-threaded: no worker, so no policy.
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: true, wasmThreads: 1 })).toBe(false);
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: true, wasmThreads: 0 })).toBe(false);
    expect(ortSpawnsThreadWorkers({ crossOriginIsolated: true, wasmThreads: 2 })).toBe(true);
  });

  it("installs exactly one default policy and reuses it across both backend attempts", () => {
    const { host, created } = trustedTypesHost();
    installOrtThreadWorkerPolicy(host);
    installOrtThreadWorkerPolicy(host);
    expect(created).toHaveLength(1);
    // The name is load-bearing: only "default" is consulted for a raw string
    // reaching a sink inside code Airship does not own.
    expect(created[0].name).toBe("default");
  });

  it("refuses every script URL outside the pinned pack runtime", () => {
    const { host, created } = trustedTypesHost();
    installOrtThreadWorkerPolicy(host);
    const { createScriptURL } = created[0];
    expect(createScriptURL("/semantic-pack/v1/runtime/ort-wasm-simd-threaded.asyncify.mjs"))
      .toBe("https://airship.example/semantic-pack/v1/runtime/ort-wasm-simd-threaded.asyncify.mjs");
    for (const refused of [
      "/assets/index.js",
      "/semantic-pack/v1/models/mixedbread-ai/mxbai-embed-xsmall-v1/config.json",
      "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs",
      "/semantic-pack/v1/runtime/../../../assets/index.js",
      "blob:https://airship.example/9a1f",
      "data:text/javascript,globalThis.x=1",
    ]) {
      expect(() => createScriptURL(refused)).toThrow(/outside the pinned semantic pack runtime/u);
    }
  });

  it("names the CSP directive when the default policy is not allowed", () => {
    const state = trustedTypesHost();
    state.allow = false;
    expect(() => installOrtThreadWorkerPolicy(state.host)).toThrow(/trusted-types directive did not allow/u);
    // Refused, not remembered: a later attempt must try again rather than
    // proceed as if the policy existed.
    state.allow = true;
    installOrtThreadWorkerPolicy(state.host);
    expect(state.created).toHaveLength(1);
  });

  it("does nothing where Trusted Types are not enforced", () => {
    // Firefox and Safari expose no factory; there is no sink to satisfy and
    // creating nothing is the correct outcome, not a swallowed failure.
    expect(() => installOrtThreadWorkerPolicy({ location: { href: "https://airship.example/" } })).not.toThrow();
  });

  it("keeps the CSP that makes the policy creatable and the pack same-origin", () => {
    for (const file of ["index.html", "public/_headers"]) {
      const policy = readFileSync(file, "utf8");
      expect(policy).toMatch(/trusted-types default /u);
      expect(policy).toContain("require-trusted-types-for 'script'");
      // The pack is same-origin precisely so no CDN needs a connect-src grant.
      expect(policy).not.toContain("cdn.jsdelivr.net");
    }
  });

  it("bounds the thread count it will ever hand ORT", () => {
    expect(boundedOrtThreadCount(64)).toBe(MAX_ORT_THREADS);
    expect(boundedOrtThreadCount(-3)).toBe(1);
    expect(boundedOrtThreadCount(2.9)).toBe(2);
  });
});

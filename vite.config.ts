import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { localChutesOAuthBridge } from "./scripts/local-chutes-oauth-bridge";
import { airshipPyodideAssets } from "./scripts/pyodide-assets";
import { airshipSemanticPackAssets } from "./scripts/semantic-pack-assets";

export function applyLocalDevelopmentPolicy(html: string): string {
  return html
    .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
    .replace(
      "connect-src 'self' ",
      "connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 ",
    );
}

export function resolvePublicBasePath(value: string | undefined): string {
  const candidate = value?.trim() || "/";
  if (!candidate.startsWith("/") || candidate.includes("?") || candidate.includes("#")) {
    throw new TypeError("AIRSHIP_PUBLIC_BASE_PATH must be an absolute URL path.");
  }
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}

export default defineConfig({
  base: resolvePublicBasePath(process.env.AIRSHIP_PUBLIC_BASE_PATH),
  plugins: [
    preact(),
    airshipPyodideAssets(),
    airshipSemanticPackAssets(),
    localChutesOAuthBridge(),
    {
      name: "airship-local-development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        // Vite's development-only CSS HMR client injects <style> elements.
        // The loopback origins are the disposable MinIO lab only. The source
        // and production response remain on the reviewed strict policy.
        return applyLocalDevelopmentPolicy(html);
      },
    },
  ],
  build: {
    target: "es2022",
    // Source maps are not shipped from the static client. Same-origin source
    // disclosure materially enlarges the blast radius of a release compromise.
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    // Credential and recovery-key surfaces are loopback-only by default.
    // Deliberate LAN testing must use the explicit package script.
    host: "127.0.0.1",
    headers: {
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  worker: {
    format: "es",
  },
});

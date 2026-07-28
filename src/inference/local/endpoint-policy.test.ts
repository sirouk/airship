import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_MODEL_ORIGINS,
  LocalProviderError,
  resolveLocalEndpoint,
} from "./endpoint-policy";

describe("local model endpoint policy", () => {
  it("permits loopback defaults and rejects embedded authority or paths", () => {
    expect(resolveLocalEndpoint("http://127.0.0.1:11434").loopback).toBe(true);
    expect(resolveLocalEndpoint("http://localhost:1234").url.origin).toBe("http://localhost:1234");
    expect(() => resolveLocalEndpoint("http://[::1]:11434")).toThrow("local-model allowlist");
    expect(() => resolveLocalEndpoint("http://token@localhost:1234")).toThrow(LocalProviderError);
    expect(resolveLocalEndpoint("http://localhost:1234/v1").url.origin).toBe("http://localhost:1234");
    expect(() => resolveLocalEndpoint("http://localhost:1234/other")).toThrow("exact /v1");
    expect(() => resolveLocalEndpoint("http://localhost:7777")).toThrow("local-model allowlist");
  });

  it("rejects private-LAN and public hosts even if obsolete broadening flags are supplied", () => {
    const obsoleteBroadeningAttempt = {
      allowPrivateNetwork: true,
      allowedOrigins: ["https://models.local:11434"],
      pageUrl: "http://127.0.0.1:4173/",
    } as const;
    expect(() => resolveLocalEndpoint(
      "https://models.local:11434",
      obsoleteBroadeningAttempt,
    )).toThrow("Private-LAN and public hosts are not supported");
    expect(() => resolveLocalEndpoint("http://192.168.1.8:11434")).toThrow(
      "Private-LAN and public hosts are not supported",
    );
    expect(() => resolveLocalEndpoint("https://models.example.com")).toThrow(
      "Private-LAN and public hosts are not supported",
    );
    // docs/LOCAL_MODEL_PROVIDERS.md promises the rejection names the exact
    // origin that was refused, for this branch as well as the allowlist one.
    for (const [endpoint, origin] of [
      ["https://models.local:11434", "https://models.local:11434"],
      ["http://192.168.1.8:11434", "http://192.168.1.8:11434"],
      ["https://models.example.com", "https://models.example.com"],
      ["http://[fd00::1]:11434", "http://[fd00::1]:11434"],
    ] as const) {
      expect(() => resolveLocalEndpoint(endpoint)).toThrow(origin);
    }
  });

  it("accepts each alternate loopback port a second local service is commonly moved to", () => {
    expect(resolveLocalEndpoint("http://127.0.0.1:11435").url.origin).toBe("http://127.0.0.1:11435");
    expect(resolveLocalEndpoint("http://localhost:1236").url.origin).toBe("http://localhost:1236");
    expect(() => resolveLocalEndpoint("http://127.0.0.1:11437")).toThrow("local-model allowlist");
  });

  it("checks one flat origin set rather than a per-provider port partition", () => {
    /*
     * docs/LOCAL_MODEL_PROVIDERS.md groups the ports by the service that
     * usually occupies them. That grouping is prose: the resolver takes no
     * provider argument, so every allowlisted origin is legal for every
     * provider, and the doc must not claim otherwise.
     */
    expect(DEFAULT_LOCAL_MODEL_ORIGINS).toHaveLength(12);
    for (const origin of DEFAULT_LOCAL_MODEL_ORIGINS) {
      expect(resolveLocalEndpoint(origin).url.origin).toBe(origin);
    }
    // An Ollama-default port and an LM Studio-default port are interchangeable.
    expect(resolveLocalEndpoint("http://127.0.0.1:1234").url.origin).toBe("http://127.0.0.1:1234");
    expect(resolveLocalEndpoint("http://localhost:11434").url.origin).toBe("http://localhost:11434");
  });

  it("keeps every allowlisted origin reachable under the shipped connect-src policies", async () => {
    // A widened allowlist that the CSP does not also grant would fail as an
    // opaque browser error rather than as Airship's own honest diagnostic.
    const root = new URL("../../../", import.meta.url);
    const [index, headers] = await Promise.all([
      readFile(new URL("index.html", root), "utf8"),
      readFile(new URL("public/_headers", root), "utf8"),
    ]);
    for (const policy of [index, headers]) {
      const connectSrc = /connect-src ([^;"]+)/u.exec(policy)?.[1]?.split(/\s+/u) ?? [];
      expect(connectSrc.length).toBeGreaterThan(0);
      for (const origin of DEFAULT_LOCAL_MODEL_ORIGINS) {
        expect(connectSrc).toContain(origin);
      }
    }
  });

  it("labels the browser-dependent HTTPS-to-HTTP loopback path without blocking it", () => {
    const endpoint = resolveLocalEndpoint("http://127.0.0.1:11434", {
      pageUrl: "https://airship.example/",
    });
    expect(endpoint.diagnostics).toEqual([
      expect.objectContaining({
        code: "mixed-content",
        severity: "info",
        blocking: false,
      }),
    ]);
  });
});

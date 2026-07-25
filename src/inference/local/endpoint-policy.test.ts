import { describe, expect, it } from "vitest";
import { LocalProviderError, resolveLocalEndpoint } from "./endpoint-policy";

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

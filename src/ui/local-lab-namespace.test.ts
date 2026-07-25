import { describe, expect, it } from "vitest";
import { isLoopbackAirshipLocation, localLabVaultConfiguration } from "./app";

describe("local lab browser namespace isolation", () => {
  it("allows baked MinIO auto-connect only on loopback", () => {
    expect(isLoopbackAirshipLocation({ hostname: "localhost" })).toBe(true);
    expect(isLoopbackAirshipLocation({ hostname: "127.0.0.1" })).toBe(true);
    expect(isLoopbackAirshipLocation({ hostname: "[::1]" })).toBe(true);
    expect(isLoopbackAirshipLocation({ hostname: "airship.example" })).toBe(false);
  });

  it("accepts only a bounded e2e namespace on loopback", () => {
    expect(localLabVaultConfiguration({
      hostname: "127.0.0.1",
      search: "?airshipLabNamespace=airship-live-v2%2Fe2e%2Fgithub-import-42",
    } as Location).namespace).toBe("airship-live-v2/e2e/github-import-42");
    expect(() => localLabVaultConfiguration({
      hostname: "airship.example",
      search: "?airshipLabNamespace=airship-live-v2%2Fe2e%2Fother",
    } as Location)).toThrow(/exact loopback/iu);
    expect(localLabVaultConfiguration({
      hostname: "localhost",
      search: "?airshipLabNamespace=..%2Flocal-user",
    } as Location).namespace).toBe("airship-live-v2/local-user");
  });
});

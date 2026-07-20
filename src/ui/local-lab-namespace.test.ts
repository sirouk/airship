import { describe, expect, it } from "vitest";
import { localLabVaultConfiguration } from "./app";

describe("local lab browser namespace isolation", () => {
  it("accepts only a bounded e2e namespace on loopback", () => {
    expect(localLabVaultConfiguration({
      hostname: "127.0.0.1",
      search: "?airshipLabNamespace=airship-live-v2%2Fe2e%2Fgithub-import-42",
    } as Location).namespace).toBe("airship-live-v2/e2e/github-import-42");
    expect(localLabVaultConfiguration({
      hostname: "airship.example",
      search: "?airshipLabNamespace=airship-live-v2%2Fe2e%2Fother",
    } as Location).namespace).toBe("airship-live-v2/local-user");
    expect(localLabVaultConfiguration({
      hostname: "localhost",
      search: "?airshipLabNamespace=..%2Flocal-user",
    } as Location).namespace).toBe("airship-live-v2/local-user");
  });
});

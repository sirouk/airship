import { describe, expect, it } from "vitest";
import type { InferenceRequest, InferenceTransport } from "../core/contracts";
import { CredentialUnavailableTransport, withoutCredential } from "./credential-unavailable";

describe("credential-unavailable inference transport", () => {
  it("retains only semantic runtime identity and cannot delegate to the credential-bearing transport", async () => {
    let delegated = false;
    const credentialBearing: InferenceTransport & { apiKey: string } = {
      id: "chutes-e2ee-v1",
      posture: "encrypted-attested",
      apiKey: "cpk_memory-only",
      async *stream() {
        delegated = true;
        yield { type: "completed", finishReason: "stop" } as const;
      },
    };

    const suspended = withoutCredential(credentialBearing);

    expect(suspended).toBeInstanceOf(CredentialUnavailableTransport);
    expect(suspended).not.toBe(credentialBearing);
    expect(suspended).toMatchObject({ id: "chutes-e2ee-v1", posture: "encrypted-attested" });
    expect("apiKey" in suspended).toBe(false);

    const request = {} as InferenceRequest;
    const iterator = suspended.stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("memory-only credential is reconnected");
    expect(delegated).toBe(false);
  });
});

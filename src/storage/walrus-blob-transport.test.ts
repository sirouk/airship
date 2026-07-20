import { describe, expect, it, vi } from "vitest";
import { WalrusBlobTransport } from "./walrus-blob-transport";

const blobId = "qz3UMQnlefrg6oa2U7m7psusAtLd5VTPoUo6hZtpwx4";

describe("WalrusBlobTransport", () => {
  it("uploads ciphertext with a constrained grant and preserves the publisher receipt", async () => {
    const issueUploadGrant = vi.fn(async () => ({
      authorization: "short-lived-token",
      grantId: "grant-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer short-lived-token");
      return Response.json({
        alreadyCertified: {
          blobId,
          event: { txDigest: "transaction" },
          endEpoch: 32,
        },
      });
    });
    const transport = new WalrusBlobTransport({
      publisherUrl: "https://publisher.example",
      aggregatorUrls: ["https://aggregator.example"],
      grantIssuer: { issueUploadGrant },
      fetchImplementation,
    });

    const receipt = await transport.uploadCiphertext(new TextEncoder().encode("encrypted"), { epochs: 5 });

    expect(receipt).toMatchObject({ blobId, created: false, endEpoch: 32, eventTxDigest: "transaction", grantId: "grant-1" });
    expect(receipt.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(issueUploadGrant).toHaveBeenCalledWith(expect.objectContaining({ ciphertextBytes: 9, epochs: 5 }));
  });

  it("requires exact range semantics and fails over to another aggregator", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("one.example")) return new Response("unavailable", { status: 503 });
      return new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: { "Content-Range": "bytes 1-2/4", "Content-Length": "2" },
      });
    });
    const transport = new WalrusBlobTransport({
      publisherUrl: "https://publisher.example",
      aggregatorUrls: ["https://one.example", "https://two.example"],
      fetchImplementation,
    });

    const result = await transport.readRange(blobId, 1, 3);

    expect([...result.bytes]).toEqual([2, 3]);
    expect(result.totalSize).toBe(4);
    expect(result.aggregator).toContain("two.example");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects whole-blob responses to a range request", async () => {
    const transport = new WalrusBlobTransport({
      publisherUrl: "https://publisher.example",
      aggregatorUrls: ["https://aggregator.example"],
      fetchImplementation: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });

    await expect(transport.readRange(blobId, 0, 2)).rejects.toThrow("ignored the byte range");
  });

  it("does not accept insecure remote endpoints or malformed blob IDs", async () => {
    expect(
      () =>
        new WalrusBlobTransport({
          publisherUrl: "http://publisher.example",
          aggregatorUrls: ["https://aggregator.example"],
        }),
    ).toThrow("HTTPS");

    const transport = new WalrusBlobTransport({
      publisherUrl: "http://localhost:9001",
      aggregatorUrls: ["http://localhost:9000"],
    });
    await expect(transport.readBlob("../not-a-blob")).rejects.toThrow("blob ID");
  });
});

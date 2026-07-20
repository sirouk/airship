import { describe, expect, it, vi } from "vitest";
import {
  S3ObjectStore,
  S3StorageError,
  signS3Request,
  type S3TemporaryCredentials,
} from "./s3-object-store";

const credentials: S3TemporaryCredentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const temporaryCredentials: S3TemporaryCredentials = {
  ...credentials,
  sessionToken: "temporary-session-token",
  expiration: "2013-05-24T01:00:00.000Z",
};

describe("S3 SigV4", () => {
  it("matches the official AWS ListObjects signature example", async () => {
    const signed = await signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      region: "us-east-1",
      credentials,
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now: new Date("2013-05-24T00:00:00.000Z"),
    });

    expect(signed.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("sorts encoded query parameters by ASCII bytes", async () => {
    const url = new URL("https://examplebucket.s3.amazonaws.com/");
    url.searchParams.set("*", "star value");
    url.searchParams.set("-", "dash value");
    const signed = await signS3Request({
      method: "GET",
      url,
      region: "us-east-1",
      credentials,
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now: new Date("2013-05-24T00:00:00.000Z"),
    });

    expect(signed.canonicalRequest.split("\n")[2]).toBe("%2A=star%20value&-=dash%20value");
  });
});

describe("S3ObjectStore", () => {
  it("binds the ambient browser fetch receiver", async () => {
    const originalFetch = globalThis.fetch;
    const browserLikeFetch = vi.fn(async function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    globalThis.fetch = browserLikeFetch;
    try {
      const store = new S3ObjectStore({
        endpoint: "https://s3.example",
        region: "auto",
        bucket: "bucket",
        credentialProvider: { async getCredentials() { return temporaryCredentials; } },
        now: () => new Date("2013-05-24T00:00:00.000Z"),
      });

      await expect(store.get("object")).resolves.toBeUndefined();
      expect(browserLikeFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("performs exact signed ranges and requires exposed ETags", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("range")).toBe("bytes=4-6");
      expect(headers.get("authorization")).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 206,
        headers: { "Content-Range": "bytes 4-6/10", ETag: '"range-etag"' },
      });
    });
    const store = makeStore(fetchImplementation);

    const result = await store.getRange("experts/page.bin", 4, 7);

    expect(result).toMatchObject({ start: 4, endExclusive: 7, totalSize: 10, etag: "range-etag" });
    expect([...result!.bytes]).toEqual([4, 5, 6]);
  });

  it("uses conditional writes for immutable objects and mutable roots", async () => {
    const requests: Headers[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      requests.push(new Headers(init?.headers));
      return new Response(null, { status: 200, headers: { ETag: requests.length === 1 ? '"created"' : '"updated"' } });
    });
    const store = makeStore(fetchImplementation);

    await expect(store.putIfAbsent("objects/a", new Uint8Array([1]))).resolves.toEqual({ etag: "created", created: true });
    await expect(store.compareAndSwap("root", "created", new Uint8Array([2]))).resolves.toEqual({ etag: "updated", updated: true });

    expect(requests[0]!.get("if-none-match")).toBe("*");
    expect(requests[1]!.get("if-match")).toBe('"created"');
    expect(requests[1]!.get("authorization")).toContain("if-match");
  });

  it("paginates and decodes ListObjectsV2 inside its configured prefix", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const second = url.searchParams.get("continuation-token") === "next-token";
      return new Response(
        second
          ? listXml(false, "vault/workspaces/a&amp;b", "etag-2", 9)
          : listXml(true, "vault/workspaces/first", "etag-1", 4, "next-token"),
        { headers: { "Content-Type": "application/xml" } },
      );
    });
    const store = makeStore(fetchImplementation);

    const result = await store.list("workspaces/");

    expect(result.map((item) => item.key)).toEqual(["workspaces/first", "workspaces/a&b"]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects ignored ranges and stale temporary credentials", async () => {
    const ignored = makeStore(async () => new Response(new Uint8Array([1]), { status: 200, headers: { ETag: '"x"' } }));
    await expect(ignored.getRange("page", 0, 1)).rejects.toThrow("ignored");

    const stale = new S3ObjectStore({
      endpoint: "https://s3.example",
      region: "auto",
      bucket: "bucket",
      credentialProvider: {
        async getCredentials() {
          return { ...credentials, sessionToken: "temporary-session-token", expiration: "2013-05-24T00:00:20.000Z" };
        },
      },
      now: () => new Date("2013-05-24T00:00:00.000Z"),
      fetchImplementation: async () => new Response(),
    });
    await expect(stale.get("object")).rejects.toThrow("expired");
  });

  it("confines logical keys and preserves encoded special characters", async () => {
    const urls: URL[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      urls.push(new URL(String(input)));
      return new Response(null, { status: 404 });
    });
    const store = makeStore(fetchImplementation);

    for (const key of ["../outside", "a/../outside", "/absolute", "a//alias", "a\\alias"]) {
      await expect(store.get(key)).rejects.toThrow(/invalid|relative/u);
    }
    await expect(store.get("spaces and %/snowman-☃")).resolves.toBeUndefined();

    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toBe("/bucket/vault/spaces%20and%20%25/snowman-%E2%98%83");
  });

  it("refuses permanent credentials unless an explicit development escape hatch is enabled", async () => {
    const options = {
      endpoint: "http://localhost:9000",
      region: "auto",
      bucket: "bucket",
      credentialProvider: { async getCredentials() { return credentials; } },
      now: () => new Date("2013-05-24T00:00:00.000Z"),
      fetchImplementation: async () => new Response(null, { status: 404 }),
    };
    await expect(new S3ObjectStore(options).get("object")).rejects.toThrow("permanent credentials");
    await expect(
      new S3ObjectStore({ ...options, allowPermanentCredentialsForDevelopment: true }).get("object"),
    ).resolves.toBeUndefined();
  });

  it("distinguishes definite precondition failures from retryable 409 conflicts", async () => {
    let attempts = 0;
    const conflict = makeStore(async () => {
      attempts += 1;
      return new Response("<Error><Code>ConditionalRequestConflict</Code></Error>", {
        status: 409,
        headers: { "Retry-After": "0" },
      });
    });
    const error = await conflict.putIfAbsent("object", new Uint8Array([1])).catch((caught: unknown) => caught);
    expect(attempts).toBe(3);
    expect(error).toBeInstanceOf(S3StorageError);
    expect((error as S3StorageError).details).toMatchObject({ retryable: true, commitState: "not-committed", status: 409 });

    const precondition = makeStore(async () => new Response(null, { status: 412 }));
    await expect(precondition.putIfAbsent("object", new Uint8Array([1]))).resolves.toEqual({
      created: false,
      reason: "exists",
      currentEtag: undefined,
    });
    await expect(precondition.compareAndSwap("object", "old", new Uint8Array([2]))).resolves.toEqual({
      updated: false,
      reason: "precondition-failed",
      currentEtag: undefined,
    });
  });

  it("rejects list results outside the exact requested prefix and malformed pagination", async () => {
    const escaped = makeStore(async () => new Response(listXml(false, "vault/adjacent/object", "etag", 1)));
    await expect(escaped.list("workspaces/")).rejects.toThrow("requested namespace");

    const malformed = makeStore(async () => new Response("<ListBucketResult></ListBucketResult>"));
    await expect(malformed.list("")).rejects.toThrow("exactly one truncation marker");

    const duplicate = makeStore(async () => new Response(`<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>vault/workspaces/same</Key><ETag>&quot;e1&quot;</ETag><Size>1</Size></Contents>
      <Contents><Key>vault/workspaces/same</Key><ETag>&quot;e1&quot;</ETag><Size>1</Size></Contents>
    </ListBucketResult>`));
    await expect(duplicate.list("workspaces/")).rejects.toThrow("repeated");

    const encodedEntity = makeStore(async () => new Response(listXml(false, "vault/workspaces/&amp;#65;", "etag", 1)));
    await expect(encodedEntity.list("workspaces/")).resolves.toMatchObject([{ key: "workspaces/&#65;" }]);
  });

  it("rejects unsafe virtual-host and oversized namespace configurations", async () => {
    expect(() => new S3ObjectStore({
      endpoint: "https://s3.example",
      region: "auto",
      bucket: "dotted.bucket",
      forcePathStyle: false,
      credentialProvider: { async getCredentials() { return temporaryCredentials; } },
    })).toThrow("dotted bucket");

    const store = makeStore(async () => new Response(null, { status: 404 }));
    await expect(store.get("x".repeat(1_025))).rejects.toThrow("key limit");
  });

  it("retries bounded idempotent reads without retrying ambiguous writes", async () => {
    let reads = 0;
    const readStore = makeStore(async () => {
      reads += 1;
      return reads === 1
        ? new Response("busy", { status: 503, headers: { "Retry-After": "0" } })
        : new Response(new Uint8Array([7]), { status: 200, headers: { ETag: '"read-etag"' } });
    });
    await expect(readStore.get("object")).resolves.toMatchObject({ etag: "read-etag" });
    expect(reads).toBe(2);

    let writes = 0;
    const writeStore = makeStore(async () => {
      writes += 1;
      throw new TypeError("network ended after upload");
    });
    const error = await writeStore.putIfAbsent("object", new Uint8Array([1])).catch((caught: unknown) => caught);
    expect(writes).toBe(1);
    expect((error as S3StorageError).details.commitState).toBe("unknown");
  });
});

function makeStore(fetchImplementation: typeof fetch): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: "https://s3.example",
    region: "auto",
    bucket: "bucket",
    prefix: "vault",
    credentialProvider: { async getCredentials() { return temporaryCredentials; } },
    now: () => new Date("2013-05-24T00:00:00.000Z"),
    fetchImplementation,
  });
}

function listXml(truncated: boolean, key: string, etag: string, size: number, token?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>${truncated}</IsTruncated>
  ${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}
  <Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;${etag}&quot;</ETag><Size>${size}</Size></Contents>
</ListBucketResult>`;
}

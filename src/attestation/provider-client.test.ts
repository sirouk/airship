import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../core/hash";
import { bytesToBase64, hexToBytes, sha256Hex } from "./encoding";
import {
  AttestationEvidenceClientError,
  ChutesAttestationEvidenceClient,
  exportChutesEndpointEvidenceRecord,
  validatePublishedTeePolicies,
} from "./provider-client";
import {
  TDX_QUOTE_PREFIX_BYTES,
  TDX_REPORT_DATA_OFFSET,
  TDX_SIGNATURE_LENGTH_OFFSET,
} from "./tdx";
import type { TdxRuntimeMeasurements } from "./provider-types";
import type { AttestationVerifierPorts } from "./types";

const INSTANCE_ID = "instance-1";
const OTHER_INSTANCE_ID = "instance-2";
const CHUTE_ID = "chute-1";
const TOKEN = "cak_ephemeral-secret-never-recorded";
const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const NONCE = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");
const E2E_PUBLIC_KEY = bytesToBase64(Uint8Array.from({ length: 1184 }, (_, index) => index % 251));
const OTHER_E2E_PUBLIC_KEY = bytesToBase64(Uint8Array.from({ length: 1184 }, (_, index) => (index + 7) % 251));
const CERTIFICATE = bytesToBase64(Uint8Array.of(0x30, 0x00));
const MEASUREMENTS: TdxRuntimeMeasurements = {
  mrtd: "11".repeat(48),
  rtmr0: "22".repeat(48),
  rtmr1: "33".repeat(48),
  rtmr2: "44".repeat(48),
  rtmr3: "55".repeat(48),
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChutesAttestationEvidenceClient", () => {
  it("acquires exact authenticated instance evidence without retaining the bearer", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const getBearerToken = vi.fn(() => TOKEN);
    const client = authenticatedClient({
      getBearerToken,
      fetch: vi.fn(async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return jsonResponse(evidenceBody(quote));
      }) as typeof fetch,
    });

    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });

    expect(requestUrl).toBe(`https://api.example.test/instances/${INSTANCE_ID}/evidence?nonce=${NONCE}`);
    expect(requestInit).toMatchObject({
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(record).toMatchObject({
      verdict: "evidence-only",
      subject: {
        instanceId: INSTANCE_ID,
        e2ePublicKey: E2E_PUBLIC_KEY,
        e2ePublicKeyDigest: await sha256(E2E_PUBLIC_KEY),
      },
      acquisition: { authorization: "bearer", cache: "network" },
      binding: { state: "matched" },
      claims: {
        cpuTee: { state: "unverified" },
        modelArtifact: { state: "unavailable" },
        conversation: { state: "unavailable" },
      },
    });
    expect(record.evidence.quoteBytes).toBe(TDX_QUOTE_PREFIX_BYTES);
    expect(record.evidence.certificateBytes).toBe(2);
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(getBearerToken).toHaveBeenCalledTimes(1);
  });

  it("normalizes quote-v5 evidence and claims without downgrading it to quote-v4", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS, 5);
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse(evidenceBody(quote))) as typeof fetch,
    });

    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });

    expect(record.evidence.quote).toMatchObject({
      format: "intel-tdx-quote-v5",
      version: 5,
      attestationKeyType: 2,
    });
    expect(record.binding.state).toBe("matched");
    expect(record.claims.cpuTee.state).toBe("unverified");
  });

  it("retains Chutes key type 3 as supported evidence but never claims verifier success", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, undefined, 4, 3);
    const verifier = vi.fn(async () => ({
      status: "unavailable" as const,
      summary: "Attestation key type 3 is verifier-unsupported.",
    }));
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse(evidenceBody(quote))) as typeof fetch,
      verifierPorts: { dcap: { id: "test-qvl", version: "1", verify: verifier } },
    });

    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });

    expect(record.evidence.quote.attestationKeyType).toBe(3);
    expect(record.claims.cpuTee).toMatchObject({
      state: "unavailable",
      summary: "Attestation key type 3 is verifier-unsupported.",
    });
    expect(record.verdict).toBe("evidence-only");
  });

  it("selects the exact instance from anonymous chute evidence and never sends authorization", async () => {
    const targetQuote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const otherQuote = await buildQuote(NONCE, OTHER_E2E_PUBLIC_KEY);
    let requestInit: RequestInit | undefined;
    const client = publicClient(vi.fn(async (_input, init) => {
      requestInit = init;
      return jsonResponse({
        evidence: [
          evidenceBody(otherQuote, OTHER_INSTANCE_ID),
          evidenceBody(targetQuote, INSTANCE_ID),
        ],
        failed_instance_ids: [],
      });
    }) as typeof fetch);

    const record = await client.get({
      chuteId: CHUTE_ID,
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });

    expect(record.acquisition.endpoint).toBe("chute-evidence");
    expect(record.acquisition.authorization).toBe("public");
    expect(record.subject.instanceId).toBe(INSTANCE_ID);
    expect(new Headers(requestInit?.headers).has("authorization")).toBe(false);
  });

  it("fails closed when chute evidence omits, duplicates, or fails the exact subject", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const cases: Array<{ body: unknown; code: string }> = [
      {
        body: { evidence: [], failed_instance_ids: [INSTANCE_ID] },
        code: "evidence-unavailable",
      },
      {
        body: { evidence: [], failed_instance_ids: [] },
        code: "subject-not-found",
      },
      {
        body: {
          evidence: [evidenceBody(quote), evidenceBody(quote)],
          failed_instance_ids: [],
        },
        code: "invalid-response",
      },
      {
        body: { evidence: [evidenceBody(quote)], failed_instance_ids: [], surprise: true },
        code: "invalid-response",
      },
    ];
    for (const entry of cases) {
      const client = publicClient(vi.fn(async () => jsonResponse(entry.body)) as typeof fetch);
      await expect(client.get({
        chuteId: CHUTE_ID,
        instanceId: INSTANCE_ID,
        e2ePublicKey: E2E_PUBLIC_KEY,
        includePublishedPolicy: false,
      })).rejects.toMatchObject({ code: entry.code });
    }
  });

  it("retains mismatched evidence for diagnosis but marks it rejected", async () => {
    const quote = await buildQuote("ff".repeat(32), E2E_PUBLIC_KEY);
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse(evidenceBody(quote))) as typeof fetch,
    });
    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    expect(record.verdict).toBe("rejected");
    expect(record.binding.state).toBe("failed");
    expect(record.claims.nonceFreshness.state).toBe("failed");
    expect(record.claims.endpointKey.state).toBe("failed");
    expect(record.claims.cpuTee.state).toBe("unverified");
  });

  it("compares runtime measurements while refusing to promote quote authenticity", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === "/servers/tee/measurements"
        ? jsonResponse([policyBody(MEASUREMENTS)])
        : jsonResponse(evidenceBody(quote)),
    );
    const client = authenticatedClient({ fetch: fetchMock as typeof fetch });
    const record = await client.get({ instanceId: INSTANCE_ID, e2ePublicKey: E2E_PUBLIC_KEY });

    expect(record.publishedPolicy).toMatchObject({
      state: "matched",
      policyCount: 1,
      matches: [{ version: "1.3.0", name: "8xh200", gpuCount: 8 }],
    });
    expect(record.claims.runtimePolicy.state).toBe("matched");
    expect(record.claims.cpuTee.state).toBe("unverified");
    expect(record.verdict).toBe("evidence-only");
    expect(record.warnings.join(" ")).toContain("not a separately signed transparency artifact");
  });

  it("attributes a verified CPU claim to the verifier port that produced it", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS);
    const client = new ChutesAttestationEvidenceClient({
      apiBase: "https://api.example.test",
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname === "/servers/tee/measurements"
          ? jsonResponse([policyBody(MEASUREMENTS)])
          : jsonResponse(evidenceBody(quote)),
      ) as typeof fetch,
      authorization: {
        kind: "oauth",
        cachePartition: "qvl-attribution",
        getBearerToken: () => TOKEN,
      },
      verifierPorts: {
        dcap: {
          id: "intel-dcap-qvl-wasm",
          version: "dcap-qvl/0.5.2",
          verify: vi.fn(async () => ({
            status: "verified" as const,
            summary: "Full local QVL passed.",
            signatureVerified: true as const,
            tcbVerified: true as const,
            policyVerified: true as const,
            debugDisabled: true as const,
            policyDigest: "sha256:collateral",
          })),
        },
      },
      randomValues: deterministicRandom,
      now: () => NOW,
    });

    const record = await client.get({ instanceId: INSTANCE_ID, e2ePublicKey: E2E_PUBLIC_KEY });

    expect(record.claims.cpuTee).toMatchObject({
      state: "verified",
      verifier: "intel-dcap-qvl-wasm@dcap-qvl/0.5.2",
    });
  });

  it("promotes a bound GPU batch only when an independent NVIDIA verifier completes", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const binding = await sha256Hex(`${NONCE}${E2E_PUBLIC_KEY}`);
    const gpu = boundGpuEvidence(binding);
    const verify = vi.fn(async () => ({
      status: "verified" as const,
      summary: "NVIDIA signed EAT, nonce, RIM, revocation, and confidential mode passed.",
      allDevicesVerified: true as const,
      confidentialComputeVerified: true as const,
      bindingVerified: true as const,
      policyDigest: "sha256:nvidia-policy",
    }));
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse({
        ...evidenceBody(quote),
        gpu_evidence: [gpu],
      })) as typeof fetch,
      verifierPorts: {
        nvidia: { id: "nvidia-signed-eat", version: "1", verify },
      },
    });

    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });

    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: INSTANCE_ID,
      expectedBindingDigestHex: binding,
      gpuEvidence: [gpu],
    }), expect.any(AbortSignal));
    expect(record.claims.gpuTee).toMatchObject({
      state: "verified",
      verifier: "nvidia-signed-eat@1",
    });
    expect(record.warnings.join(" ")).toContain("complete GPU verdict");
  });

  it("does not blame the NVIDIA verifier for a batch whose binding never reached it", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const verify = vi.fn(async () => ({
      status: "verified" as const,
      summary: "NVIDIA signed EAT, nonce, RIM, revocation, and confidential mode passed.",
      allDevicesVerified: true as const,
      confidentialComputeVerified: true as const,
      bindingVerified: true as const,
      policyDigest: "sha256:nvidia-policy",
    }));
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse({
        ...evidenceBody(quote),
        gpu_evidence: [boundGpuEvidence("aa".repeat(32))],
      })) as typeof fetch,
      verifierPorts: {
        nvidia: { id: "nvidia-signed-eat", version: "1", verify },
      },
    });

    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });

    expect(verify).not.toHaveBeenCalled();
    expect(record.claims.gpuTee.state).toBe("failed");
    expect(record.warnings.join(" ")).not.toContain("did not return a usable result");
  });

  it("rejects a quote that does not match any current published runtime policy", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS);
    const different = { ...MEASUREMENTS, rtmr3: "66".repeat(48) };
    const client = authenticatedClient({
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname === "/servers/tee/measurements"
          ? jsonResponse([policyBody(different)])
          : jsonResponse(evidenceBody(quote)),
      ) as typeof fetch,
    });
    const record = await client.get({ instanceId: INSTANCE_ID, e2ePublicKey: E2E_PUBLIC_KEY });
    expect(record.publishedPolicy?.state).toBe("failed");
    expect(record.claims.runtimePolicy.state).toBe("failed");
    expect(record.verdict).toBe("rejected");
  });

  it("does not fail open or reuse stale policy when the policy feed is invalid", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS);
    const client = authenticatedClient({
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname === "/servers/tee/measurements"
          ? jsonResponse([{ ...policyBody(MEASUREMENTS), unsigned_extra: true }])
          : jsonResponse(evidenceBody(quote)),
      ) as typeof fetch,
    });
    const record = await client.get({ instanceId: INSTANCE_ID, e2ePublicKey: E2E_PUBLIC_KEY });
    expect(record.publishedPolicy).toBeUndefined();
    expect(record.claims.runtimePolicy.state).toBe("unavailable");
    expect(record.warnings).toContain("Published measurement policy was unavailable; no stale policy was used.");
  });

  it("keeps valid evidence when the optional published-policy request times out", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS);
    const client = authenticatedClient({
      timeoutMs: 5,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname !== "/servers/tee/measurements") {
          return jsonResponse(evidenceBody(quote));
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as typeof fetch,
    });

    const record = await client.get({ instanceId: INSTANCE_ID, e2ePublicKey: E2E_PUBLIC_KEY });

    expect(record.binding.state).toBe("matched");
    expect(record.claims.runtimePolicy.state).toBe("unavailable");
    expect(record.verdict).toBe("evidence-only");
    expect(record.warnings).toContain("Published measurement policy was unavailable; no stale policy was used.");
  });

  it("still propagates explicit caller cancellation while optional policy is pending", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY, MEASUREMENTS);
    let markPolicyStarted!: () => void;
    const policyStarted = new Promise<void>((resolve) => { markPolicyStarted = resolve; });
    const client = authenticatedClient({
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname !== "/servers/tee/measurements") {
          return jsonResponse(evidenceBody(quote));
        }
        markPolicyStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const acquisition = client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      signal: controller.signal,
    });
    await policyStarted;

    controller.abort();

    await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds a verifier that ignores cancellation instead of hanging evidence acquisition", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    let markVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => { markVerifierStarted = resolve; });
    const verifier = vi.fn(async () => {
      markVerifierStarted();
      return await new Promise<never>(() => undefined);
    });
    const client = authenticatedClient({
      timeoutMs: 50,
      fetch: vi.fn(async () => jsonResponse(evidenceBody(quote))) as typeof fetch,
      verifierPorts: { dcap: { id: "hung-qvl", version: "1", verify: verifier } },
    });
    const acquisition = client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    await verifierStarted;
    expect(verifier).toHaveBeenCalledOnce();

    await expect(acquisition).rejects.toMatchObject({
      code: "timeout",
      message: "Chutes attestation evidence verification timed out.",
    });
  });

  it("bounds an evidence fetch implementation that ignores cancellation", async () => {
    const client = authenticatedClient({
      timeoutMs: 25,
      fetch: vi.fn(async () => await new Promise<Response>(() => undefined)) as typeof fetch,
    });

    await expect(client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    })).rejects.toMatchObject({
      code: "timeout",
      message: "Chutes attestation evidence request timed out.",
    });
  });

  it("bounds an evidence response body that stops making progress", async () => {
    const client = authenticatedClient({
      timeoutMs: 25,
      fetch: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start() { /* deliberately never enqueue or close */ },
      }), { headers: { "content-type": "application/json" } })) as typeof fetch,
    });

    await expect(client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    })).rejects.toMatchObject({
      code: "timeout",
      message: "Chutes attestation evidence request timed out.",
    });
  });

  it("deduplicates a subject, isolates caller abort, and serves only fresh memory evidence", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const client = authenticatedClient({ fetch: fetchMock as typeof fetch });
    const firstController = new AbortController();
    const first = client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
      signal: firstController.signal,
    });
    const second = client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false);
    resolveFetch(jsonResponse(evidenceBody(quote)));
    await expect(second).resolves.toMatchObject({ acquisition: { cache: "network" } });
    await expect(client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    })).resolves.toMatchObject({ acquisition: { cache: "memory" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses latest-refresh-wins cancellation for the exact subject", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const pending: Array<{ init?: RequestInit; resolve: (response: Response) => void }> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ init, resolve });
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    );
    const client = authenticatedClient({ fetch: fetchMock as typeof fetch });
    const first = client.refresh({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = client.refresh({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve(jsonResponse(evidenceBody(quote)));
    await expect(second).resolves.toMatchObject({ binding: { state: "matched" } });
  });

  it("maps an unreadable cross-origin response without pretending to distinguish CORS from network failure", async () => {
    vi.stubGlobal("location", { origin: "http://localhost:4173" });
    const client = publicClient(vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch);
    await expect(client.get({
      chuteId: CHUTE_ID,
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    })).rejects.toMatchObject({
      code: "cross-origin-unreadable",
      message: expect.stringContaining("CORS authorization or the network path"),
    });
  });

  it("maps authorization failures without retaining provider bodies or bearer material", async () => {
    for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
      const client = authenticatedClient({
        fetch: vi.fn(async () => new Response(`provider detail ${TOKEN}`, {
          status,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      });
      let caught: unknown;
      try {
        await client.get({
          instanceId: INSTANCE_ID,
          e2ePublicKey: E2E_PUBLIC_KEY,
          includePublishedPolicy: false,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code, context: { status } });
      expect(JSON.stringify(caught)).not.toContain(TOKEN);
      expect((caught as Error).message).not.toContain("provider detail");
    }

    const getterFailure = authenticatedClient({
      fetch: vi.fn() as typeof fetch,
      getBearerToken: () => { throw new Error(TOKEN); },
    });
    let caught: unknown;
    try {
      await getterFailure.get({
        instanceId: INSTANCE_ID,
        e2ePublicKey: E2E_PUBLIC_KEY,
        includePublishedPolicy: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "invalid-input" });
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(caught)).not.toContain(TOKEN);
  });

  it("bounds evidence responses and declines to cache records beyond the byte budget", async () => {
    const oversized = new ChutesAttestationEvidenceClient({
      apiBase: "https://api.example.test",
      fetch: vi.fn(async () => new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "65",
        },
      })) as typeof fetch,
      authorization: {
        kind: "api-key",
        cachePartition: "bounded-account",
        getBearerToken: () => TOKEN,
      },
      maxResponseBytes: 64,
      randomValues: deterministicRandom,
      now: () => NOW,
    });
    await expect(oversized.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    })).rejects.toMatchObject({ code: "response-too-large" });

    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const fetchMock = vi.fn(async () => jsonResponse(evidenceBody(quote)));
    const uncached = new ChutesAttestationEvidenceClient({
      apiBase: "https://api.example.test",
      fetch: fetchMock as typeof fetch,
      authorization: {
        kind: "api-key",
        cachePartition: "tiny-cache-account",
        getBearerToken: () => TOKEN,
      },
      maxCacheBytes: 1,
      randomValues: deterministicRandom,
      now: () => NOW,
    });
    const args = {
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    } as const;
    await uncached.get(args);
    await uncached.get(args);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let an abort-ignoring superseded fetch overwrite the latest cache", async () => {
    const oldQuote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const newQuote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const client = authenticatedClient({ fetch: fetchMock as typeof fetch });
    const args = {
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    } as const;
    const oldRefresh = client.refresh(args);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const latestRefresh = client.refresh(args);
    await expect(oldRefresh).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1](jsonResponse(evidenceBodyWithMarker(newQuote, "latest")));
    const latest = await latestRefresh;
    pending[0](jsonResponse(evidenceBodyWithMarker(oldQuote, "stale")));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const cached = await client.get(args);
    expect(cached.acquisition.cache).toBe("memory");
    expect(cached.evidence.payloadDigest).toBe(latest.evidence.payloadDigest);
    expect(JSON.stringify(cached.evidence.gpu.payloads)).toContain("latest");
    expect(JSON.stringify(cached.evidence.gpu.payloads)).not.toContain("stale");
  });

  it("partitions memory evidence by immutable connection revision", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const fetchMock = vi.fn(async () => jsonResponse(evidenceBody(quote)));
    const makeClient = (cachePartition: string) => new ChutesAttestationEvidenceClient({
      apiBase: "https://api.example.test",
      fetch: fetchMock as typeof fetch,
      authorization: {
        kind: "oauth",
        cachePartition,
        getBearerToken: () => TOKEN,
      },
      randomValues: deterministicRandom,
      now: () => NOW,
    });
    const args = {
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    } as const;
    const accountA = makeClient("account-a-revision-1");
    const accountB = makeClient("account-b-revision-1");
    await accountA.get(args);
    await accountA.get(args);
    await accountB.get(args);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts expired raw evidence without waiting for another read and clears timers on dispose", async () => {
    vi.useFakeTimers();
    let now = 0;
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const client = new ChutesAttestationEvidenceClient({
      apiBase: "https://api.example.test",
      fetch: vi.fn(async () => jsonResponse(evidenceBody(quote))) as typeof fetch,
      authorization: {
        kind: "oauth",
        cachePartition: "expiry-account",
        getBearerToken: () => TOKEN,
      },
      cacheTtlMs: 100,
      randomValues: deterministicRandom,
      now: () => now,
    });
    await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    expect(client.memoryStats().evidenceEntries).toBe(1);
    expect(client.memoryStats().evidenceBytes).toBeGreaterThan(0);
    now = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.memoryStats()).toMatchObject({ evidenceEntries: 0, evidenceBytes: 0 });
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("redacts raw proof artifacts from portable export unless explicitly requested", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse(evidenceBody(quote))) as typeof fetch,
    });
    const record = await client.get({
      instanceId: INSTANCE_ID,
      e2ePublicKey: E2E_PUBLIC_KEY,
      includePublishedPolicy: false,
    });
    const standard = exportChutesEndpointEvidenceRecord(record);
    expect(standard).toContain("omitted-by-default");
    expect(standard).not.toContain(record.evidence.quote.base64);
    expect(standard).not.toContain("test-gpu-evidence");
    expect(standard).not.toContain(E2E_PUBLIC_KEY);
    expect(standard).not.toContain(NONCE);
    expect(standard).not.toContain(record.binding.expectedDigestHex);
    expect(standard).toContain(record.subject.e2ePublicKeyDigest);
    expect(standard).not.toContain(TOKEN);
    const raw = exportChutesEndpointEvidenceRecord(record, { includeRawEvidence: true });
    expect(raw).toContain(record.evidence.quote.base64);
    expect(raw).toContain("test-gpu-evidence");
    expect(raw).not.toContain(TOKEN);
  });
});

describe("authenticated E2E discovery and App snapshot", () => {
  it("discards invocation nonce values, caches by connection partition, and resolves the exact instance", async () => {
    const quote = await buildQuote(NONCE, E2E_PUBLIC_KEY);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/e2e/instances/")) return jsonResponse(discoveryBody());
      if (path.startsWith("/instances/")) return jsonResponse(evidenceBody(quote));
      throw new Error(`unexpected path ${path}`);
    });
    const client = authenticatedClient({ fetch: fetchMock as typeof fetch });
    const snapshot = await client.inspect({
      chuteId: CHUTE_ID,
      instanceId: INSTANCE_ID,
      includePublishedPolicy: false,
    });

    expect(snapshot).toMatchObject({
      status: "evidence",
      requestedInstanceId: INSTANCE_ID,
      discovery: {
        cache: "network",
        endpoints: [{ instanceId: INSTANCE_ID, discardedInvocationNonceCount: 2 }],
      },
      record: { subject: { instanceId: INSTANCE_ID } },
    });
    expect(JSON.stringify(snapshot)).not.toContain("one_time_nonce_value");
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    const cached = await client.discover(CHUTE_ID);
    expect(cached.cache).toBe("memory");
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.startsWith("/e2e/instances/"))).toHaveLength(1);
  });

  it("never substitutes a different discovered instance for the receipt subject", async () => {
    const client = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse(discoveryBody(OTHER_INSTANCE_ID, OTHER_E2E_PUBLIC_KEY))) as typeof fetch,
    });
    const snapshot = await client.inspect({
      chuteId: CHUTE_ID,
      instanceId: INSTANCE_ID,
      includePublishedPolicy: false,
    });
    expect(snapshot).toMatchObject({
      status: "unavailable",
      unavailable: {
        code: "subject-not-found",
        message: expect.stringContaining("no substitute instance was accepted"),
      },
    });
  });

  it("surfaces the current discovery-success/evidence-forbidden contract without a hidden fallback", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/e2e/instances/")) return jsonResponse(discoveryBody());
      return new Response("scope denied", { status: 403, headers: { "content-type": "text/plain" } });
    });
    const client = authenticatedClient({ fetch: fetchMock as typeof fetch });
    const snapshot = await client.inspect({
      chuteId: CHUTE_ID,
      instanceId: INSTANCE_ID,
      includePublishedPolicy: false,
    });
    expect(snapshot).toMatchObject({
      status: "unavailable",
      discovery: { endpoints: [{ instanceId: INSTANCE_ID }] },
      unavailable: { code: "forbidden", status: 403 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let abort-ignoring discovery overwrite a newer endpoint lease", async () => {
    const pending: Array<(response: Response) => void> = [];
    const client = authenticatedClient({
      fetch: vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch,
    });
    const oldRefresh = client.discover(CHUTE_ID, { forceRefresh: true });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const latestRefresh = client.discover(CHUTE_ID, { forceRefresh: true });
    await expect(oldRefresh).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1](jsonResponse(discoveryBody(INSTANCE_ID, E2E_PUBLIC_KEY)));
    const latest = await latestRefresh;
    pending[0](jsonResponse(discoveryBody(OTHER_INSTANCE_ID, OTHER_E2E_PUBLIC_KEY)));
    const cached = await client.discover(CHUTE_ID);
    expect(cached.cache).toBe("memory");
    expect(cached.endpoints).toEqual(latest.endpoints);
    expect(cached.endpoints[0]?.instanceId).toBe(INSTANCE_ID);
  });

  it("rejects malformed discovery and an already-expired provider nonce window", async () => {
    const malformed = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse({ ...discoveryBody(), surprise: true })) as typeof fetch,
    });
    await expect(malformed.discover(CHUTE_ID)).rejects.toMatchObject({ code: "invalid-response" });

    const expired = authenticatedClient({
      fetch: vi.fn(async () => jsonResponse({
        ...discoveryBody(),
        nonce_expires_at: Math.floor(NOW / 1_000) - 1,
      })) as typeof fetch,
    });
    await expect(expired.discover(CHUTE_ID)).rejects.toMatchObject({
      code: "invalid-response",
      message: expect.stringContaining("already-expired"),
    });
  });

  it("bounds discovery and keeps invalid client configuration out of provider-unavailable snapshots", async () => {
    const bounded = new ChutesAttestationEvidenceClient({
      apiBase: "https://api.example.test",
      fetch: vi.fn(async () => new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "65" },
      })) as typeof fetch,
      authorization: {
        kind: "oauth",
        cachePartition: "bounded-discovery",
        getBearerToken: () => TOKEN,
      },
      maxDiscoveryResponseBytes: 64,
      now: () => NOW,
    });
    await expect(bounded.discover(CHUTE_ID)).rejects.toMatchObject({ code: "response-too-large" });

    const unauthenticated = publicClient(vi.fn() as typeof fetch);
    await expect(unauthenticated.inspect({
      chuteId: CHUTE_ID,
      instanceId: INSTANCE_ID,
    })).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("published TEE policy validator", () => {
  it("normalizes the exact live schema and rejects extra fields and malformed measurements", () => {
    const valid = validatePublishedTeePolicies([policyBody(MEASUREMENTS)]);
    expect(valid[0]).toMatchObject({ mrtd: MEASUREMENTS.mrtd, gpuCount: 8 });
    expect(() => validatePublishedTeePolicies([{ ...policyBody(MEASUREMENTS), extra: true }]))
      .toThrow("unexpected field");
    expect(() => validatePublishedTeePolicies([{
      ...policyBody(MEASUREMENTS),
      mrtd: "00",
    }])).toThrow("48-byte hexadecimal");
  });
});

function authenticatedClient(overrides: {
  fetch: typeof fetch;
  getBearerToken?: () => string;
  timeoutMs?: number;
  verifierPorts?: AttestationVerifierPorts;
}): ChutesAttestationEvidenceClient {
  return new ChutesAttestationEvidenceClient({
    apiBase: "https://api.example.test",
    fetch: overrides.fetch,
    authorization: {
      kind: "oauth",
      cachePartition: "connection-revision-1",
      getBearerToken: overrides.getBearerToken ?? (() => TOKEN),
    },
    randomValues: deterministicRandom,
    now: () => NOW,
    timeoutMs: overrides.timeoutMs,
    verifierPorts: overrides.verifierPorts,
  });
}

function publicClient(fetchImpl: typeof fetch): ChutesAttestationEvidenceClient {
  return new ChutesAttestationEvidenceClient({
    apiBase: "https://api.example.test",
    fetch: fetchImpl,
    randomValues: deterministicRandom,
    now: () => NOW,
  });
}

async function buildQuote(
  nonce: string,
  e2ePublicKey: string,
  measurements?: TdxRuntimeMeasurements,
  version: 4 | 5 = 4,
  attestationKeyType: 2 | 3 = 2,
): Promise<string> {
  const bodyOffset = version === 5 ? 54 : 48;
  const signatureLengthOffset = bodyOffset + 584;
  const bytes = new Uint8Array(signatureLengthOffset + 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, version, true);
  view.setUint16(2, attestationKeyType, true);
  view.setUint32(4, 0x81, true);
  if (version === 5) {
    view.setUint16(48, 2, true);
    view.setUint32(50, 584, true);
  }
  view.setUint32(signatureLengthOffset, 0, true);
  if (measurements) {
    bytes.set(hexToBytes(measurements.mrtd), bodyOffset + 136);
    bytes.set(hexToBytes(measurements.rtmr0), bodyOffset + 328);
    bytes.set(hexToBytes(measurements.rtmr1), bodyOffset + 376);
    bytes.set(hexToBytes(measurements.rtmr2), bodyOffset + 424);
    bytes.set(hexToBytes(measurements.rtmr3), bodyOffset + 472);
  }
  bytes.set(hexToBytes(await sha256Hex(`${nonce}${e2ePublicKey}`)), bodyOffset + 520);
  return bytesToBase64(bytes);
}

function evidenceBody(quote: string, instanceId = INSTANCE_ID) {
  return {
    quote,
    gpu_evidence: [{ arch: "HOPPER", evidence: "test-gpu-evidence" }],
    instance_id: instanceId,
    certificate: CERTIFICATE,
  };
}

function evidenceBodyWithMarker(quote: string, marker: string) {
  return {
    ...evidenceBody(quote),
    gpu_evidence: [{ arch: "HOPPER", evidence: marker }],
  };
}

function boundGpuEvidence(binding: string) {
  const evidence = new Uint8Array(87);
  evidence.set([0x11, 0xe0, 0x01, 0xff]);
  evidence.set(hexToBytes(binding), 4);
  return {
    arch: "BLACKWELL",
    certificate: CERTIFICATE,
    evidence: bytesToBase64(evidence),
  };
}

function discoveryBody(instanceId = INSTANCE_ID, e2ePublicKey = E2E_PUBLIC_KEY) {
  return {
    instances: [{
      instance_id: instanceId,
      e2e_pubkey: e2ePublicKey,
      nonces: ["one_time_nonce_value_0001", "one_time_nonce_value_0002"],
    }],
    nonce_expires_in: 60,
    nonce_expires_at: Math.floor(NOW / 1_000) + 60,
  };
}

function policyBody(measurements: TdxRuntimeMeasurements) {
  return {
    version: "1.3.0",
    name: "8xh200",
    mrtd: measurements.mrtd.toUpperCase(),
    boot_rtmrs: {
      RTMR0: measurements.rtmr0.toUpperCase(),
      RTMR1: measurements.rtmr1.toUpperCase(),
      RTMR2: measurements.rtmr2.toUpperCase(),
      RTMR3: "00".repeat(48),
    },
    runtime_rtmrs: {
      RTMR0: measurements.rtmr0.toUpperCase(),
      RTMR1: measurements.rtmr1.toUpperCase(),
      RTMR2: measurements.rtmr2.toUpperCase(),
      RTMR3: measurements.rtmr3.toUpperCase(),
    },
    expected_gpus: ["h200"],
    gpu_count: 8,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function deterministicRandom(target: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) target[index] = index;
}

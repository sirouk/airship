import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionManifest, runTurn } from "../../core/agent";
import type { InferenceEvent, InferenceRequest, JsonValue } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { auditSessionHistory } from "../../core/session-audit";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import type {
  AttestationGate,
  AttestationGateResult,
  AttestationSubject,
  VerifiedEndpointReceipt,
} from "./attestation";
import type {
  ChutesE2eeCrypto,
  E2eeRequestCryptoContext,
  E2eeStreamCryptoContext,
} from "./crypto";
import { ChutesTransportError } from "./errors";
import { ChutesInferenceTransport, type FetchLike } from "./transport";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChutesInferenceTransport", () => {
  it("keeps public model discovery anonymous and proves protected endpoint access before invocation", async () => {
    const fetch = sequenceFetch([modelResponse(), instanceResponse(["nonce-a"])]);
    const transport = new ChutesInferenceTransport({ apiKey: "cak_memory-only", fetch, attestationMode: "optional" });

    await expect(transport.verifyModelAccess("confidential-model")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/v1\/models$/u);
    expect(header(fetch.mock.calls[0]![1], "Authorization")).toBeUndefined();
    expect(String(fetch.mock.calls[1]![0])).toMatch(/\/e2e\/instances\/chute-a$/u);
    expect(header(fetch.mock.calls[1]![1], "Authorization")).toBe("Bearer cak_memory-only");
    expect(invokeCalls(fetch)).toHaveLength(0);
  });

  it("irreversibly rejects a retained transport reference after its credential is revoked", async () => {
    let credentialReads = 0;
    const fetch = sequenceFetch([modelResponse()]);
    const transport = new ChutesInferenceTransport({
      apiKey: () => {
        credentialReads += 1;
        return "cak_memory-only";
      },
      fetch,
      attestationMode: "optional",
    });

    await expect(transport.listModels()).resolves.toHaveLength(1);
    transport.revokeCredential();
    transport.revokeCredential();

    await expect(transport.listModels()).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(transport.verifyModelAccess("confidential-model")).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(
      collect(transport.stream(baseRequest(), new AbortController().signal)),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(credentialReads).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight model read when credential authority is revoked", async () => {
    let resolveModels!: (response: Response) => void;
    let modelSignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>((_input, init) => {
      modelSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveModels = resolve;
      });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      attestationMode: "optional",
    });
    const pending = transport.listModels();

    await vi.waitFor(() => expect(modelSignal).toBeDefined());
    transport.revokeCredential();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(modelSignal?.aborted).toBe(true);
    resolveModels(modelResponse());
  });

  it("cancels an in-flight encrypted invocation when credential authority is revoked", async () => {
    const crypto = new MockCrypto({});
    let resolveInvoke!: (response: Response) => void;
    let invokeSignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return Promise.resolve(modelResponse());
      if (url.includes("/e2e/instances/")) {
        return Promise.resolve(instanceResponse(["nonce-a"]));
      }
      invokeSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveInvoke = resolve;
      });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto,
      attestationMode: "optional",
    });
    const pending = collect(
      transport.stream(baseRequest(), new AbortController().signal),
    );

    await vi.waitFor(() => expect(invokeSignal).toBeDefined());
    transport.revokeCredential();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(invokeSignal?.aborted).toBe(true);
    expect(crypto.requests[0]?.freeCalls).toBe(1);
    resolveInvoke(new Response(null, { status: 499 }));
  });

  it("labels protected endpoint authorization failures at their exact boundary", async () => {
    const fetch = sequenceFetch([modelResponse(), jsonResponse({ detail: "forbidden" }, 403)]);
    const transport = new ChutesInferenceTransport({ apiKey: "cak_memory-only", fetch, attestationMode: "optional" });

    await expect(transport.verifyModelAccess("confidential-model")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
      operation: "instance-discovery",
    });
  });

  it("requires explicit confidential_compute instead of trusting a -TEE suffix", async () => {
    const fetch = sequenceFetch([
      jsonResponse({
        data: [
          { id: "fake-TEE", chute_id: "fake", confidential_compute: false },
          {
            id: "real-confidential",
            chute_id: "real",
            confidential_compute: true,
            input_modalities: ["text", "image"],
          },
          { id: "missing-flag", chute_id: "missing" },
        ],
      }),
    ]);
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, attestationMode: "optional" });

    await expect(transport.listModels()).resolves.toEqual([
      {
        id: "real-confidential",
        chuteId: "real",
        confidentialCompute: true,
        inputModalities: ["text", "image"],
      },
    ]);
  });

  it("fails closed when image capability metadata is absent or unsupported", async () => {
    const missing = new ChutesInferenceTransport({
      apiKey: "key",
      fetch: sequenceFetch([modelResponse(null)]),
      attestationMode: "optional",
    });
    await expect(collect(missing.stream(baseRequest(true), new AbortController().signal))).rejects.toMatchObject({
      code: "MODEL_CAPABILITY_UNVERIFIED",
    });

    const textOnly = new ChutesInferenceTransport({
      apiKey: "key",
      fetch: sequenceFetch([modelResponse(["text"])]),
      attestationMode: "optional",
    });
    await expect(collect(textOnly.stream(baseRequest(true), new AbortController().signal))).rejects.toMatchObject({
      code: "MODEL_INPUT_UNSUPPORTED",
    });
  });

  it("fails required attestation before crypto or invoke", async () => {
    const crypto = new MockCrypto({});
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
    ]);
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "ATTESTATION_REQUIRED",
    });
    expect(crypto.requests).toHaveLength(0);
    expect(invokeCalls(fetch)).toHaveLength(0);
  });

  it("rejects a receipt for a different instance/key before invoke", async () => {
    const crypto = new MockCrypto({});
    const gate: AttestationGate = {
      verifyEndpoint: vi.fn(async (subject) => ({ receipt: verifiedReceipt({ ...subject, instanceId: "other" }) })),
    };
    const fetch = sequenceFetch([modelResponse(), instanceResponse(["nonce-a"])]);
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto, attestationGate: gate });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "ATTESTATION_FAILED",
    });
    expect(crypto.requests).toHaveLength(0);
    expect(invokeCalls(fetch)).toHaveLength(0);
  });

  it("rejects an otherwise matching endpoint receipt outside the freshness window", async () => {
    const crypto = new MockCrypto({});
    const gate: AttestationGate = {
      verifyEndpoint: vi.fn(async (subject) => ({ receipt: {
        ...verifiedReceipt(subject),
        verifiedAt: "2026-07-18T11:00:00.000Z",
        expiresAt: "2026-07-18T13:00:00.000Z",
      } })),
    };
    const fetch = sequenceFetch([modelResponse(), instanceResponse(["nonce-a"])]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationGate: gate,
      maxAttestationAgeMs: 60_000,
      now: () => Date.parse("2026-07-18T12:00:00.000Z"),
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "ATTESTATION_FAILED",
    });
    expect(crypto.requests).toHaveLength(0);
    expect(invokeCalls(fetch)).toHaveLength(0);
  });

  it("streams text and assembled tool calls, serializes canonical input, and emits conservative receipt claims", async () => {
    const crypto = new MockCrypto({
      text: inner({ choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }] }),
      toolA: inner({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_", type: "function", function: { name: "look", arguments: '{"q":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      toolB: inner({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "1", function: { name: "up", arguments: '"airship"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      usage: inner({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "text" }),
        outer({ e2e: "toolA" }),
        outer({ e2e: "toolB" }),
        outer({ e2e: "usage" }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
      now: () => Date.parse("2026-07-18T12:00:00.000Z"),
    });

    const events = await collect(transport.stream(baseRequest(true), new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hello " },
      { type: "usage", inputTokens: 12, outputTokens: 4 },
      { type: "tool-call", call: { id: "call_1", name: "lookup", arguments: { q: "airship" } } },
      expect.objectContaining({
        type: "completed",
        finishReason: "tool-calls",
        receipt: expect.objectContaining({
          proofLevel: "encrypted",
          posture: "encrypted-unattested",
          provider: "chutes",
          instanceId: "instance-a",
          model: "confidential-model",
          claims: expect.objectContaining({
            endpointKey: expect.objectContaining({ status: "unavailable" }),
            model: expect.objectContaining({ status: "unavailable" }),
            conversation: expect.objectContaining({
              status: "partial",
              verifier: "airship-client",
            }),
          }),
          bindings: expect.objectContaining({
            requestCiphertextDigest: expect.stringMatching(/^sha256:/u),
            responseCiphertextDigest: expect.stringMatching(/^sha256:/u),
          }),
        }),
      }),
    ]);

    const payload = JSON.parse(crypto.requests[0].payloadJson) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "confidential-model",
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look something up",
            parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          },
        },
      ],
    });
    expect(payload.messages).toEqual([
      { role: "system", content: "You are Airship." },
      {
        role: "user",
        content: [
          { type: "text", text: "start" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "old-call", type: "function", function: { name: "lookup", arguments: '{"q":"old"}' } },
        ],
      },
      { role: "tool", content: "old result", tool_call_id: "old-call" },
    ]);
    expect(crypto.requests[0].freeCalls).toBe(1);
    expect(crypto.streams[0].finishCalls).toBe(1);
    expect(crypto.streams[0].freeCalls).toBe(1);
  });

  it("commits authenticated response ciphertext order without retaining the transcript", async () => {
    const emptyDelta = inner({ choices: [{ index: 0, delta: {}, finish_reason: null }] });
    const stop = inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const responseCommitment = async (records: readonly string[]) => {
      const crypto = new MockCrypto({ a: emptyDelta, b: emptyDelta, stop });
      const transport = new ChutesInferenceTransport({
        apiKey: "key",
        fetch: sequenceFetch([
          modelResponse(),
          instanceResponse(["nonce-a"]),
          streamResponse([
            outer({ e2e_init: "init" }),
            ...records.map((record) => outer({ e2e: record })),
            outer({ e2e: "stop" }),
            "data: [DONE]\n\n",
          ]),
        ]),
        crypto,
        attestationMode: "optional",
      });
      const completed = (await collect(
        transport.stream(baseRequest(), new AbortController().signal),
      )).at(-1);
      if (completed?.type !== "completed") throw new Error("fixture did not complete");
      if (!completed.receipt) throw new Error("fixture did not emit a receipt");
      return completed.receipt.bindings.responseCiphertextDigest;
    };

    const ordered = await responseCommitment(["a", "b"]);
    const repeated = await responseCommitment(["a", "b"]);
    const reordered = await responseCommitment(["b", "a"]);

    expect(ordered).toMatch(/^sha256:/u);
    expect(repeated).toBe(ordered);
    expect(reordered).not.toBe(ordered);
  });

  it("assembles deployed Chutes inner SSE lines across separately authenticated delimiters", async () => {
    const completion = JSON.stringify({
      choices: [{ index: 0, delta: { content: "framing fixed" }, finish_reason: "stop" }],
    });
    const crypto = new MockCrypto({
      heartbeat: ": heartbeat\n",
      heartbeatDelimiter: "\n",
      dataLine: `data: ${completion}\n`,
      dataDelimiter: "\n",
      doneLine: "data: [DONE]\n",
      doneDelimiter: "\n",
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "heartbeat" }),
        outer({ e2e: "heartbeatDelimiter" }),
        outer({ e2e: "dataLine" }),
        outer({ e2e: "dataDelimiter" }),
        outer({ e2e: "doneLine" }),
        outer({ e2e: "doneDelimiter" }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).resolves.toEqual([
      { type: "text-delta", text: "framing fixed" },
      expect.objectContaining({ type: "completed", finishReason: "stop" }),
    ]);
    expect(crypto.streams[0].chunks_decrypted).toBe(6);
  });

  it("accepts the Chutes v1 reference-client shape of directly authenticated JSON records", async () => {
    const crypto = new MockCrypto({
      first: JSON.stringify({
        choices: [{ index: 0, delta: { content: "direct " }, finish_reason: null }],
      }),
      terminal: JSON.stringify({
        choices: [{ index: 0, delta: { content: "json" }, finish_reason: "stop" }],
      }),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "first" }),
        outer({ e2e: "terminal" }),
        // The Chutes reference client treats response EOF as completion. The
        // authenticated finish_reason keeps this fail-closed for partial JSON.
      ]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).resolves.toEqual([
      { type: "text-delta", text: "direct " },
      { type: "text-delta", text: "json" },
      expect.objectContaining({ type: "completed", finishReason: "stop" }),
    ]);
  });

  it("assembles a directly authenticated JSON object split across arbitrary encrypted records", async () => {
    const completion = JSON.stringify({
      choices: [{ index: 0, delta: { content: "fragmented" }, finish_reason: "stop" }],
    });
    const midpoint = Math.floor(completion.length / 2);
    const crypto = new MockCrypto({
      left: completion.slice(0, midpoint),
      right: completion.slice(midpoint),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "left" }),
        outer({ e2e: "right" }),
      ]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).resolves.toEqual([
      { type: "text-delta", text: "fragmented" },
      expect.objectContaining({ type: "completed", finishReason: "stop" }),
    ]);
  });

  it("assembles multiple directly authenticated JSON objects coalesced into one encrypted record", async () => {
    const first = JSON.stringify({
      choices: [{ index: 0, delta: { content: "coalesced { in string } " }, finish_reason: null }],
    });
    const terminal = JSON.stringify({
      choices: [{ index: 0, delta: { content: "records" }, finish_reason: "stop" }],
    });
    const crypto = new MockCrypto({ combined: `  ${first}\n${terminal}\n` });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "combined" }),
      ]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).resolves.toEqual([
      { type: "text-delta", text: "coalesced { in string } " },
      { type: "text-delta", text: "records" },
      expect.objectContaining({ type: "completed", finishReason: "stop" }),
    ]);
  });

  it("rejects EOF after authenticated JSON without a terminal finish reason", async () => {
    const crypto = new MockCrypto({
      partial: JSON.stringify({
        choices: [{ index: 0, delta: { content: "not terminal" }, finish_reason: null }],
      }),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([outer({ e2e_init: "init" }), outer({ e2e: "partial" })]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "STREAM_TRUNCATED",
    });
  });

  it("does not let an unauthenticated outer completion marker finalize a blank response", async () => {
    const crypto = new MockCrypto({
      partial: inner({
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      }),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "partial" }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "STREAM_TRUNCATED",
      message: "Chutes stream ended without an authenticated OpenAI finish reason.",
    });
  });

  it("emits endpoint-attested claims without upgrading model or transcript claims", async () => {
    const crypto = new MockCrypto({ stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
    const gate: AttestationGate = {
      verifyEndpoint: vi.fn(async (subject) => ({ receipt: verifiedReceipt(subject) })),
    };
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([outer({ e2e_init: "init" }), outer({ e2e: "stop" }), "data: [DONE]\n\n"]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationGate: gate,
      now: () => Date.parse("2026-07-18T12:00:00.000Z"),
    });

    const events = await collect(transport.stream(baseRequest(), new AbortController().signal));
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: "completed",
      receipt: {
        proofLevel: "attested-endpoint",
        posture: "encrypted-attested",
        claims: {
          endpointKey: { status: "verified" },
          freshness: { status: "verified" },
          model: { status: "unavailable" },
          conversation: { status: "partial", verifier: "airship-client" },
        },
      },
    });
  });

  it("retains bounded gate evaluation in optional receipts without proof-level promotion", async () => {
    const crypto = new MockCrypto({ stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
    const gate: AttestationGate = {
      verifyEndpoint: vi.fn(async (): Promise<AttestationGateResult> => ({
        unavailableReason: "CPU verification remained partial.",
        evaluation: {
          checkedAt: "2026-07-18T12:00:00.000Z",
          freshness: { status: "partial", summary: "Nonce matched locally.", verifier: "airship-structural-check/v1" },
          endpointKey: { status: "partial", summary: "Endpoint key matched locally.", verifier: "airship-structural-check/v1" },
          cpuTee: { status: "partial", summary: "DCAP collateral was incomplete.", verifier: "intel-dcap-webcrypto/v1" },
          gpuTee: { status: "failed", summary: "GPU verification failed.", verifier: "nvidia-gpu-webcrypto/v1" },
          runtimePolicy: { status: "partial", summary: "Runtime measurements matched.", verifier: "airship-structural-check/v1", policyDigest: "sha256:policy" },
          evidenceDigest: "sha256:evidence",
          evidenceFormat: "chutes-tee-instance-evidence/v1",
        },
      })),
    };
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([outer({ e2e_init: "init" }), outer({ e2e: "stop" }), "data: [DONE]\n\n"]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
      attestationGate: gate,
    });

    const completed = (await collect(transport.stream(baseRequest(), new AbortController().signal))).at(-1);
    expect(completed).toMatchObject({
      type: "completed",
      receipt: {
        proofLevel: "encrypted",
        posture: "encrypted-unattested",
        claims: {
          freshness: { status: "partial" },
          endpointKey: { status: "partial" },
          cpuTee: { status: "partial" },
          gpuTee: { status: "failed" },
          model: { status: "partial", policyDigest: "sha256:policy" },
          conversation: { status: "partial", verifier: "airship-client" },
        },
        bindings: { evidenceDigest: "sha256:evidence" },
      },
    });
    expect(JSON.stringify(completed)).not.toContain("quote");
    expect(JSON.stringify(completed)).not.toContain("public-key-a");
  });

  it("still fails before invoke in required mode when the gate returns evaluation only", async () => {
    const crypto = new MockCrypto({});
    const gate: AttestationGate = {
      verifyEndpoint: vi.fn(async (): Promise<AttestationGateResult> => ({
        unavailableReason: "CPU verification remained partial.",
        evaluation: {
          checkedAt: "2026-07-18T12:00:00.000Z",
          freshness: { status: "partial", summary: "Matched." },
          endpointKey: { status: "partial", summary: "Matched." },
          cpuTee: { status: "partial", summary: "Partial." },
          gpuTee: { status: "unavailable", summary: "Unavailable." },
          runtimePolicy: { status: "partial", summary: "Matched." },
        },
      })),
    };
    const fetch = sequenceFetch([modelResponse(), instanceResponse(["nonce-a"])]);
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto, attestationGate: gate });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "ATTESTATION_FAILED",
      message: "CPU verification remained partial.",
    });
    expect(crypto.requests).toHaveLength(0);
    expect(invokeCalls(fetch)).toHaveLength(0);
  });

  it("client-binds a Chutes receipt to the canonical journal request and plaintext response", async () => {
    const crypto = new MockCrypto({
      text: inner({ choices: [{ index: 0, delta: { content: "Airship is ready." }, finish_reason: null }] }),
      stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "text" }),
        outer({ e2e: "stop" }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const gate: AttestationGate = {
      verifyEndpoint: vi.fn(async (subject) => ({ receipt: verifiedReceipt(subject) })),
    };
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationGate: gate,
      now: () => Date.parse("2026-07-18T12:00:00.000Z"),
    });
    const tools = new ToolRegistry();
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({
      systemPrompt: "You are Airship.",
      providerId: transport.id,
      model: "confidential-model",
      tools: tools.definitions(),
      workspaceId: "memory://receipt-audit-fixture",
      securityPosture: transport.posture,
    });
    const session = await journal.createSession("Receipt audit fixture", manifest);

    const result = await runTurn({
      sessionId: session.id,
      content: "Summarize Airship.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    const auditedSession = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    const inferenceStarted = events.find((event) => event.type === "inference.started")!;
    const assistantCompleted = events.find((event) => event.type === "assistant.completed")!;

    expect(result.receipt).toMatchObject({
      proofLevel: "attested-endpoint",
      posture: "encrypted-attested",
      claims: {
        endpointKey: { status: "verified" },
        conversation: { status: "partial", verifier: "airship-client" },
      },
      bindings: {
        algorithm: "SHA-256",
        requestCiphertextDigest: expect.stringMatching(/^sha256:/u),
        responseCiphertextDigest: expect.stringMatching(/^sha256:/u),
        evidenceDigest: "sha256:evidence",
        requestDigest: (inferenceStarted.payload as { requestDigest: string }).requestDigest,
        responseDigest: (assistantCompleted.payload as { responseDigest: string }).responseDigest,
      },
      evidence: { format: "mock", payload: { quote: "verified" } },
    });

    const clean = await auditSessionHistory({ session: auditedSession, events });
    expect(clean.findings).toEqual([]);
    expect(clean.status).toBe("verified");
    expect(clean.checks.receiptBindings).toBe(true);

    const requestMutation = structuredClone(events);
    const requested = requestMutation.find((event) => event.type === "turn.requested")!;
    (requested.payload as { content: string }).content = "Summarize Airship!";
    const requestReport = await auditSessionHistory({ session: auditedSession, events: requestMutation });
    expect(requestReport.status).toBe("invalid");
    expect(requestReport.findings.map((finding) => finding.code)).toContain("INFERENCE_REQUEST_DIGEST_MISMATCH");

    const responseMutation = structuredClone(events);
    const completed = responseMutation.find((event) => event.type === "assistant.completed")!;
    ((completed.payload as { message: { content: string } }).message).content = "Airship is ready!";
    const responseReport = await auditSessionHistory({ session: auditedSession, events: responseMutation });
    expect(responseReport.status).toBe("invalid");
    expect(responseReport.findings.map((finding) => finding.code)).toContain("RESPONSE_DIGEST_MISMATCH");
  });

  it("retries exactly once only for a recognized pre-inference nonce rejection", async () => {
    const crypto = new MockCrypto({ stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      jsonResponse({ code: "NONCE_EXPIRED" }, 403),
      instanceResponse(["nonce-b"]),
      streamResponse([outer({ e2e_init: "init" }), outer({ e2e: "stop" }), "data: [DONE]\n\n"]),
    ]);
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto, attestationMode: "optional" });

    await collect(transport.stream(baseRequest(), new AbortController().signal));
    expect(invokeCalls(fetch).map((call) => header(call[1], "X-E2E-Nonce"))).toEqual(["nonce-a", "nonce-b"]);
    expect(crypto.requests).toHaveLength(2);
    expect(crypto.requests.every((context) => context.freeCalls === 1)).toBe(true);
  });

  it("does not retry arbitrary 403 responses", async () => {
    const crypto = new MockCrypto({});
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      jsonResponse({ code: "FORBIDDEN" }, 403),
    ]);
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto, attestationMode: "optional" });

    await expect(collect(transport.stream(baseRequest(), new AbortController().signal))).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
    });
    expect(invokeCalls(fetch)).toHaveLength(1);
  });

  it("deduplicates discovery and gives concurrent requests distinct one-use nonces", async () => {
    const crypto = new MockCrypto({ stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
    let modelCalls = 0;
    let discoveryCalls = 0;
    const fetch = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        modelCalls += 1;
        return modelResponse();
      }
      if (url.includes("/e2e/instances/")) {
        discoveryCalls += 1;
        await Promise.resolve();
        return instanceResponse(["nonce-a", "nonce-b"]);
      }
      return streamResponse([outer({ e2e_init: "init" }), outer({ e2e: "stop" }), "data: [DONE]\n\n"]);
    });
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto, attestationMode: "optional" });

    await Promise.all([
      collect(transport.stream({ ...baseRequest(), requestId: "r1", turnId: "t1" }, new AbortController().signal)),
      collect(transport.stream({ ...baseRequest(), requestId: "r2", turnId: "t2" }, new AbortController().signal)),
    ]);
    expect(modelCalls).toBe(1);
    expect(discoveryCalls).toBe(1);
    expect(invokeCalls(fetch).map((call) => header(call[1], "X-E2E-Nonce")).sort()).toEqual([
      "nonce-a",
      "nonce-b",
    ]);
  });

  it("isolates model-catalog caller cancellation from another shared waiter", async () => {
    let resolveModels!: (response: Response) => void;
    let sharedSignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>((_input, init) => {
      sharedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveModels = resolve; });
    });
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, attestationMode: "optional" });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = transport.listModels(firstController.signal);
    const second = transport.listModels(secondController.signal);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    firstController.abort();

    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sharedSignal?.aborted).toBe(false);
    resolveModels(modelResponse());
    await expect(second).resolves.toMatchObject([{ confidentialCompute: true }]);
  });

  it("isolates E2EE-discovery caller cancellation from another shared waiter", async () => {
    const crypto = new MockCrypto({ stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
    let resolveDiscovery!: (response: Response) => void;
    let discoverySignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return Promise.resolve(modelResponse());
      if (url.includes("/e2e/instances/")) {
        discoverySignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveDiscovery = resolve; });
      }
      return Promise.resolve(streamResponse([
        outer({ e2e_init: "init" }),
        outer({ e2e: "stop" }),
        "data: [DONE]\n\n",
      ]));
    });
    const transport = new ChutesInferenceTransport({ apiKey: "key", fetch, crypto, attestationMode: "optional" });
    await transport.listModels();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = collect(transport.stream({ ...baseRequest(), requestId: "r1", turnId: "t1" }, firstController.signal));
    const second = collect(transport.stream({ ...baseRequest(), requestId: "r2", turnId: "t2" }, secondController.signal));

    await vi.waitFor(() => expect(discoverySignal).toBeDefined());
    await Promise.resolve();
    firstController.abort();

    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect(discoverySignal?.aborted).toBe(false);
    resolveDiscovery(instanceResponse(["nonce-a", "nonce-b"]));
    await expect(second).resolves.toEqual(expect.arrayContaining([{ type: "completed", finishReason: "stop", receipt: expect.any(Object) }]));
  });

  it("fails closed instead of evicting a still-live used nonce from its bounded ledger", async () => {
    const crypto = new MockCrypto({ stop: inner({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a", "nonce-b"]),
      streamResponse([outer({ e2e_init: "init" }), outer({ e2e: "stop" }), "data: [DONE]\n\n"]),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
      maxUsedNonces: 1,
    });

    await collect(transport.stream(baseRequest(), new AbortController().signal));
    await expect(
      collect(
        transport.stream(
          { ...baseRequest(), requestId: "request-2", turnId: "turn-2" },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "NONCE_CACHE_EXHAUSTED" });
    expect(invokeCalls(fetch)).toHaveLength(1);
  });

  it("cancels a body read when the stream stalls", async () => {
    const crypto = new MockCrypto({});
    const hanging = new ReadableStream<Uint8Array>({ start() {} });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      new Response(hanging, { status: 200 }),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
      streamStallTimeoutMs: 20,
      totalTimeoutMs: 1_000,
    });

    const pending = collect(transport.stream(baseRequest(), new AbortController().signal));
    await expect(pending).rejects.toMatchObject({ code: "STREAM_STALLED" });
    expect(crypto.requests[0].freeCalls).toBe(1);
  });

  it("records a durable failed turn when an authenticated response stalls", async () => {
    const crypto = new MockCrypto({});
    let nonce = 0;
    // Answered by route rather than by a fixed sequence: a stall is a carriage
    // failure the retry wrapper may re-open the stream for, and this asserts
    // the durable record the turn ends with however many attempts it takes.
    const fetch = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return modelResponse();
      if (url.includes("/e2e/instances/")) {
        nonce += 1;
        return instanceResponse([`nonce-${nonce}`]);
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
      streamStallTimeoutMs: 20,
      totalTimeoutMs: 1_000,
    });
    const tools = new ToolRegistry();
    const journal = new EventJournal(new MemoryJournalBackend());
    const session = await journal.createSession("Stall audit fixture", await createSessionManifest({
      systemPrompt: "You are Airship.",
      providerId: transport.id,
      model: "confidential-model",
      tools: tools.definitions(),
      workspaceId: "memory://stall-audit-fixture",
      securityPosture: transport.posture,
    }));

    await expect(runTurn({
      sessionId: session.id,
      content: "Respond once.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "STREAM_STALLED" });

    const events = await journal.readEvents(session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.requested",
      "inference.started",
      "turn.failed",
    ]);
    expect(events.at(-1)?.payload).toEqual({ error: "Chutes response stream stopped making progress." });
  });

  it("does not leave a completed turn open when response cancellation never settles", async () => {
    const crypto = new MockCrypto({
      stop: inner({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }),
    });
    const never = new Promise<void>(() => undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          outer({ e2e_init: "init" }),
          outer({ e2e: "stop" }),
          "data: [DONE]\n\n",
        ].join("")));
      },
      cancel: vi.fn(() => never),
    });
    const fetch = sequenceFetch([
      modelResponse(),
      instanceResponse(["nonce-a"]),
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const transport = new ChutesInferenceTransport({
      apiKey: "key",
      fetch,
      crypto,
      attestationMode: "optional",
      totalTimeoutMs: 1_000,
    });

    await expect(Promise.race([
      collect(transport.stream(baseRequest(), new AbortController().signal)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn remained busy")), 100)),
    ])).resolves.toEqual([
      { type: "text-delta", text: "done" },
      expect.objectContaining({ type: "completed", finishReason: "stop" }),
    ]);
    expect(crypto.requests[0].freeCalls).toBe(1);
    expect(crypto.streams[0].freeCalls).toBe(1);
  });
});

/**
 * `invokeJson` exists so embeddings do not get a second crypto path.
 *
 * The transport already posts a sealed body to `/e2e/invoke` with `X-Chute-Id`
 * naming the target and `X-E2E-Path` naming the path inside it. An embedding
 * request is that machinery aimed elsewhere and not streamed — so these pin the
 * two things that differ (the path, and `X-E2E-Stream`) and the several things
 * that must not (the sealing, the nonce, the bearer, the cleanup).
 */
describe("ChutesInferenceTransport.invokeJson", () => {
  it("seals a payload to an arbitrary chute and path and decrypts the non-streamed answer", async () => {
    const crypto = new MockCrypto({});
    const fetch = vi.fn<FetchLike>(async (input) => {
      if (String(input).includes("/e2e/instances/")) return instanceResponse(["nonce-a"]);
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    const answer = await transport.invokeJson({
      chuteId: "chute-embed",
      path: "/v1/embeddings",
      payload: { model: "Some/Model", input: ["hello"] },
    });

    // MockRequestContext.decrypt_response answers "{}".
    expect(answer).toEqual({});
    // Model discovery is never consulted: an embedding chute is absent from
    // `llm.chutes.ai/v1/models`, so requiring it there would make this
    // permanently impossible.
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/v1/models"))).toBe(false);
    expect(String(fetch.mock.calls[0]![0])).toContain("/e2e/instances/chute-embed");

    const [, init] = invokeCalls(fetch)[0]!;
    expect(header(init, "X-Chute-Id")).toBe("chute-embed");
    expect(header(init, "X-E2E-Path")).toBe("/v1/embeddings");
    // Not `"true"`, which used to be written into the request literal. An
    // embeddings response is one frame, not a stream.
    expect(header(init, "X-E2E-Stream")).toBe("false");
    expect(header(init, "X-E2E-Nonce")).toBe("nonce-a");
    expect(header(init, "Authorization")).toBe("Bearer cak_memory-only");
    // The plaintext was handed to the crypto, never to fetch.
    expect(crypto.requests[0]?.payloadJson).toBe(JSON.stringify({ model: "Some/Model", input: ["hello"] }));
    expect(crypto.requests[0]?.e2ePublicKey).toBe("public-key-a");
    expect(crypto.requests[0]?.freeCalls).toBe(1);
  });

  it("refuses to invoke without a leading-slash path", async () => {
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch: vi.fn<FetchLike>(),
      crypto: new MockCrypto({}),
      attestationMode: "optional",
    });
    await expect(transport.invokeJson({ chuteId: "c", path: "v1/embeddings", payload: {} }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  /*
   * The 429 the owner saw on this route while the same key and model answered
   * 200 on `llm.chutes.ai`.
   *
   * Measured against real Chutes, the body is
   * `{"detail":"Instance is at maximum capacity, try again later"}` — one
   * *instance* is full, not the credential and not the chute. The shared
   * gateway load-balances a completion across siblings; `/e2e/invoke` cannot,
   * because the body is sealed to the one instance the nonce was issued
   * against. So the re-routing has to happen client-side or it does not happen
   * at all, and for a long time it did not: this transport threw on the first
   * 429 while an idle sibling sat one lease away.
   */
  it("re-routes a saturated instance to a sibling instead of failing the turn", async () => {
    const seen: string[] = [];
    const fetch = vi.fn<FetchLike>(async (input, init) => {
      if (String(input).includes("/e2e/instances/")) {
        return jsonResponse({
          nonce_expires_in: 55,
          instances: [
            { instance_id: "instance-full", e2e_pubkey: "public-key-a", nonces: ["nonce-a"] },
            { instance_id: "instance-free", e2e_pubkey: "public-key-b", nonces: ["nonce-b"] },
          ],
        });
      }
      const instanceId = header(init, "X-Instance-Id") ?? "";
      seen.push(instanceId);
      if (instanceId === "instance-full") return jsonResponse({ detail: "Instance is at maximum capacity, try again later" }, 429);
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto: new MockCrypto({}),
      attestationMode: "optional",
    });

    // MockRequestContext.decrypt_response answers "{}"; the point here is that
    // it resolves at all rather than throwing on the first 429.
    await expect(transport.invokeJson({ chuteId: "chute-embed", path: "/v1/embeddings", payload: {} }))
      .resolves.toEqual({});

    // The saturated instance is tried once and then avoided; the answer comes
    // from the sibling. Retrying the same instance would be the bug this fixes.
    expect(seen).toEqual(["instance-full", "instance-free"]);
  });

  it("reports a capacity wait, not a fault, once every instance is full", async () => {
    const fetch = vi.fn<FetchLike>(async (input) => {
      if (String(input).includes("/e2e/instances/")) {
        return jsonResponse({
          nonce_expires_in: 55,
          instances: [
            { instance_id: "instance-a", e2e_pubkey: "public-key-a", nonces: ["nonce-a1", "nonce-a2"] },
            { instance_id: "instance-b", e2e_pubkey: "public-key-b", nonces: ["nonce-b1", "nonce-b2"] },
          ],
        });
      }
      return jsonResponse({ detail: "Instance is at maximum capacity, try again later" }, 429);
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto: new MockCrypto({}),
      attestationMode: "optional",
    });

    const failure = await transport
      .invokeJson({ chuteId: "chute-embed", path: "/v1/embeddings", payload: {} })
      .then(() => undefined, (error: unknown) => error as ChutesTransportError);

    expect(failure).toMatchObject({ code: "HTTP_ERROR", status: 429, operation: "invoke" });
    // The message must still explain why this route behaves differently from
    // the shared gateway, or the next reader concludes the credential is bad.
    expect(failure?.message).toContain("cannot be re-routed");
    expect(failure?.message).toContain("capacity wait rather than a fault");
    // Bounded. Every attempt spends a nonce and a full seal, so a saturated
    // chute must not turn into an unbounded retry storm.
    expect(invokeCalls(fetch).length).toBeLessThanOrEqual(3);
    expect(invokeCalls(fetch).length).toBeGreaterThan(1);
  });

  /*
   * The one safe nonce retry is promised independently of the instance budget,
   * and taking the retry off that budget is what makes the promise true. When
   * the rejection lands on the last instance attempt the `continue` used to
   * spend the budget instead: three invokes went out, the retry never did, and
   * the operator was told "Chutes rejected a fresh E2EE nonce twice" about a
   * single rejection — which sends them to debug nonce issuance rather than the
   * instance capacity that consumed the first two attempts.
   */
  it("spends the safe nonce retry after the instance budget is used up on 429s", async () => {
    let discovery = 0;
    const invoked: string[] = [];
    const fetch = vi.fn<FetchLike>(async (input, init) => {
      if (String(input).includes("/e2e/instances/")) {
        discovery += 1;
        // Fresh nonces every round: a lease this session already spent is
        // skipped, and the point here is the attempt budget, not the ledger.
        return jsonResponse({
          nonce_expires_in: 55,
          instances: ["a", "b", "c"].map((id) => ({
            instance_id: `instance-${id}`,
            e2e_pubkey: `public-key-${id}`,
            nonces: [`${id}-${discovery}`],
          })),
        });
      }
      const instanceId = header(init, "X-Instance-Id") ?? "";
      invoked.push(instanceId);
      if (instanceId !== "instance-c") {
        return jsonResponse({ detail: "Instance is at maximum capacity, try again later" }, 429);
      }
      // The third attempt reaches an instance with room, and the gateway
      // refuses its freshly issued nonce — the recoverable failure.
      return invoked.filter((seen) => seen === "instance-c").length === 1
        ? jsonResponse({ code: "NONCE_EXPIRED" }, 403)
        : new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto: new MockCrypto({}),
      attestationMode: "optional",
    });

    await expect(transport.invokeJson({ chuteId: "chute-embed", path: "/v1/embeddings", payload: {} }))
      .resolves.toEqual({});
    // Two re-routes and then the retry, which is a fourth seal by design: the
    // budget counts instances, and the nonce retry is not one of them.
    expect(invoked).toEqual(["instance-a", "instance-b", "instance-c", "instance-c"]);
  });

  /*
   * Discovery answering from a cache is not a hypothetical: `/e2e/instances`
   * re-issues a nonce pool this session has already spent, `consumeLease` skips
   * every lease in it, and the lease loop used to answer by flying the same
   * authenticated round trip again — for the whole five-minute request
   * lifetime, hammering the instance endpoint on the way. A capacity dead end
   * has to be reported, not waited out.
   */
  it("stops discovering instead of spinning when a chute re-issues spent nonces", async () => {
    let discoveryCalls = 0;
    const fetch = vi.fn<FetchLike>(async (input) => {
      if (String(input).includes("/e2e/instances/")) {
        discoveryCalls += 1;
        // Stands in for the request lifetime, which was the only thing that
        // ended the old loop. Reaching it means the bound is gone again.
        if (discoveryCalls > 8) throw new Error("unbounded E2EE instance discovery");
        return instanceResponse(["nonce-a"]);
      }
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto: new MockCrypto({}),
      attestationMode: "optional",
    });

    // The first turn spends the only nonce the chute ever issues.
    await expect(transport.invokeJson({ chuteId: "chute-embed", path: "/v1/embeddings", payload: {} }))
      .resolves.toEqual({});
    const afterFirstTurn = discoveryCalls;

    const failure = await transport
      .invokeJson({ chuteId: "chute-embed", path: "/v1/embeddings", payload: {} })
      .then(() => undefined, (error: unknown) => error as ChutesTransportError);

    expect(failure).toMatchObject({ code: "HTTP_ERROR", status: 429, operation: "invoke" });
    // Bounded by the per-request instance budget. Nothing was invoked at all,
    // because no lease was ever drawn.
    expect(discoveryCalls - afterFirstTurn).toBeLessThanOrEqual(3);
    expect(invokeCalls(fetch)).toHaveLength(1);
  });

  it("frees the sealed request context when the encrypted answer is unreadable", async () => {
    const crypto = new MockCrypto({});
    const fetch = vi.fn<FetchLike>(async (input) => {
      if (String(input).includes("/e2e/instances/")) return instanceResponse(["nonce-a"]);
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto,
      attestationMode: "optional",
    });
    // MockRequestContext answers "{}", so make the parse fail by having the
    // context return something that is not JSON.
    vi.spyOn(MockRequestContext.prototype, "decrypt_response").mockReturnValue("not json");

    await expect(transport.invokeJson({ chuteId: "c", path: "/v1/embeddings", payload: {} }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(crypto.requests[0]?.freeCalls).toBe(1);
  });
});

/**
 * A pool of eight leases used to be eight nonces from the *first* instance,
 * because filling ran instance-by-instance until it was full. On
 * `llm.chutes.ai` that is invisible — a completion goes wherever there is room.
 * On `/e2e/invoke` it is not: the body is sealed to one instance's key and the
 * request names that instance, so eight consecutive turns hammered one endpoint
 * while its siblings idled.
 */
describe("E2EE lease distribution", () => {
  it("spreads a lease pool across the instances instead of draining the first", async () => {
    const crypto = new MockCrypto({});
    const instances = jsonResponse({
      nonce_expires_in: 55,
      instances: [
        { instance_id: "instance-a", e2e_pubkey: "public-key-a", nonces: ["a1", "a2", "a3", "a4"] },
        { instance_id: "instance-b", e2e_pubkey: "public-key-b", nonces: ["b1", "b2", "b3", "b4"] },
      ],
    });
    const fetch = vi.fn<FetchLike>(async (input) => {
      if (String(input).includes("/e2e/instances/")) return instances;
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const transport = new ChutesInferenceTransport({
      apiKey: "cak_memory-only",
      fetch,
      crypto,
      attestationMode: "optional",
    });

    for (let call = 0; call < 4; call += 1) {
      await transport.invokeJson({ chuteId: "chute-embed", path: "/v1/embeddings", payload: { call } });
    }

    const targeted = invokeCalls(fetch).map(([, init]) => header(init, "X-Instance-Id"));
    expect(targeted).toEqual(["instance-a", "instance-b", "instance-a", "instance-b"]);
    // One discovery served all four: the pool was not exhausted by one instance.
    expect(fetch.mock.calls.filter(([input]) => String(input).includes("/e2e/instances/"))).toHaveLength(1);
  });
});

function baseRequest(withImage = false): InferenceRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    model: "confidential-model",
    systemPrompt: "You are Airship.",
    idempotencyKey: "idem-1",
    messages: [
      {
        role: "user",
        content: "start",
        ...(withImage ? {
          images: [{
            type: "image" as const,
            name: "diagram.png",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,AQID",
            sizeBytes: 3,
          }],
        } : {}),
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "old-call", name: "lookup", arguments: { q: "old" } }],
      },
      { role: "tool", content: "old result", toolCallId: "old-call" },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look something up",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        effect: "network",
      },
    ],
  };
}

class MockCrypto implements ChutesE2eeCrypto {
  readonly requests: MockRequestContext[] = [];
  readonly streams: MockStreamContext[] = [];

  constructor(readonly decrypted: Record<string, string>) {}

  async buildRequest(e2ePublicKeyBase64: string, payloadJson: string) {
    const context = new MockRequestContext(this, e2ePublicKeyBase64, payloadJson);
    this.requests.push(context);
    return context;
  }
}

class MockRequestContext implements E2eeRequestCryptoContext {
  freeCalls = 0;
  consumed = false;
  blob_taken = false;

  constructor(
    private readonly owner: MockCrypto,
    readonly e2ePublicKey: string,
    readonly payloadJson: string,
  ) {}

  take_blob() {
    if (this.blob_taken) throw new Error("already taken");
    this.blob_taken = true;
    return new Uint8Array([1, 2, this.owner.requests.length + 3]);
  }

  decrypt_response(_responseBlob: Uint8Array) {
    this.consumed = true;
    return "{}";
  }

  open_stream(streamInitBase64: string) {
    if (streamInitBase64 !== "init") throw new Error("bad init");
    this.consumed = true;
    const stream = new MockStreamContext(this.owner.decrypted);
    this.owner.streams.push(stream);
    return stream;
  }

  free() {
    this.freeCalls += 1;
  }
}

class MockStreamContext implements E2eeStreamCryptoContext {
  freeCalls = 0;
  finishCalls = 0;
  finished = false;
  chunks_decrypted = 0;

  constructor(private readonly decrypted: Record<string, string>) {}

  decrypt_chunk(encryptedChunkBase64: string) {
    const value = this.decrypted[encryptedChunkBase64];
    if (value === undefined) throw new Error(`no mock plaintext for ${encryptedChunkBase64}`);
    this.chunks_decrypted += 1;
    return value;
  }

  finish() {
    this.finishCalls += 1;
    this.finished = true;
  }

  free() {
    this.freeCalls += 1;
  }
}

function modelResponse(inputModalities: readonly string[] | null = ["text", "image"]) {
  return jsonResponse({
    data: [{
      id: "confidential-model",
      chute_id: "chute-a",
      confidential_compute: true,
      ...(inputModalities !== null ? { input_modalities: inputModalities } : {}),
    }],
  });
}

function instanceResponse(nonces: string[]) {
  return jsonResponse({
    nonce_expires_in: 55,
    instances: [
      { instance_id: "instance-a", e2e_pubkey: "public-key-a", nonces },
    ],
  });
}

function verifiedReceipt(subject: AttestationSubject): VerifiedEndpointReceipt {
  return {
    version: 1,
    status: "verified",
    provider: "chutes",
    chuteId: subject.chuteId,
    instanceId: subject.instanceId,
    e2ePublicKey: subject.e2ePublicKey,
    verifiedAt: "2026-07-18T11:59:00.000Z",
    expiresAt: "2026-07-18T12:04:00.000Z",
    verifier: "mock-attestation",
    verifierVersion: "1",
    evidence: { format: "mock", payload: { quote: "verified" }, digest: "sha256:evidence" },
  };
}

function inner(body: JsonValue) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function outer(body: JsonValue) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function streamResponse(records: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) {
          const midpoint = Math.max(1, Math.floor(record.length / 2));
          controller.enqueue(encoder.encode(record.slice(0, midpoint)));
          controller.enqueue(encoder.encode(record.slice(midpoint)));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sequenceFetch(responses: Response[]) {
  return vi.fn<FetchLike>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  });
}

function invokeCalls(fetch: ReturnType<typeof vi.fn<FetchLike>>) {
  return fetch.mock.calls.filter(([input]) => String(input).endsWith("/e2e/invoke"));
}

function header(init: RequestInit | undefined, name: string) {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

async function collect(stream: AsyncIterable<InferenceEvent>) {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

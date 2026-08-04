import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  SecurityPosture,
} from "../../core/contracts";
import { randomUuid } from "../../core/id";
import {
  emptyClaims,
  type ConversationReceipt,
  type ReceiptClaim,
  type VerificationRecord,
} from "../../receipts/types";
import {
  type AttestationGate,
  type AttestationMode,
  type AttestationOutcome,
  type AttestationSubject,
  validateEndpointReceipt,
} from "./attestation";
import { AuthenticatedOpenAiStream } from "./authenticated-stream";
import {
  type ChutesE2eeCrypto,
  type E2eeRequestCryptoContext,
  type E2eeStreamCryptoContext,
  WasmChutesE2eeCrypto,
} from "./crypto";
import {
  ChutesTransportError,
  type ChutesTransportOperation,
  cancelledError,
  errorFromAbortSignal,
  normalizeTransportError,
} from "./errors";
import { OpenAiStreamAssembler, buildOpenAiPayload, isRecord } from "./openai";
import { BoundedSseParser, type SseMessage } from "./sse";
import { parseChutesInvocationTelemetry, type ChutesInvocationTelemetry } from "./telemetry";

export type ChutesModel = {
  id: string;
  chuteId: string;
  confidentialCompute: true;
  /** Present only when the canonical `/v1/models` record supplied a valid list. */
  inputModalities?: readonly string[];
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ChutesTransportOptions = {
  apiKey: string | (() => string | Promise<string>);
  fetch?: FetchLike;
  apiBase?: string;
  llmBase?: string;
  inferencePath?: string;
  crypto?: ChutesE2eeCrypto;
  attestationMode?: AttestationMode;
  attestationGate?: AttestationGate;
  totalTimeoutMs?: number;
  streamStallTimeoutMs?: number;
  modelCacheTtlMs?: number;
  maxAttestationAgeMs?: number;
  attestationClockSkewMs?: number;
  maxJsonResponseBytes?: number;
  maxInvokeResponseBytes?: number;
  maxErrorBodyBytes?: number;
  maxSseEventChars?: number;
  maxInstances?: number;
  maxNoncesPerInstance?: number;
  maxCachedNonces?: number;
  maxUsedNonces?: number;
  maxInstanceAttempts?: number;
  maxNonceTtlMs?: number;
  nonceSafetyMs?: number;
  maxToolCalls?: number;
  maxToolArgumentsChars?: number;
  now?: () => number;
  onInvocationTelemetry?: (telemetry: ChutesInvocationTelemetry) => void;
};

type ResolvedOptions = {
  apiBase: string;
  llmBase: string;
  inferencePath: string;
  attestationMode: AttestationMode;
  totalTimeoutMs: number;
  streamStallTimeoutMs: number;
  modelCacheTtlMs: number;
  maxAttestationAgeMs: number;
  attestationClockSkewMs: number;
  maxJsonResponseBytes: number;
  maxInvokeResponseBytes: number;
  maxErrorBodyBytes: number;
  maxSseEventChars: number;
  maxInstances: number;
  maxNoncesPerInstance: number;
  maxCachedNonces: number;
  maxUsedNonces: number;
  maxInstanceAttempts: number;
  maxNonceTtlMs: number;
  nonceSafetyMs: number;
  maxToolCalls: number;
  maxToolArgumentsChars: number;
};

type InstanceLease = {
  chuteId: string;
  instanceId: string;
  e2ePublicKey: string;
  nonce: string;
  expiresAt: number;
};

type CachedModels = { expiresAt: number; models: ChutesModel[] };

type SharedFlight<T> = {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
};

const DEFAULTS: ResolvedOptions = {
  apiBase: "https://api.chutes.ai",
  llmBase: "https://llm.chutes.ai",
  inferencePath: "/v1/chat/completions",
  attestationMode: "required",
  totalTimeoutMs: 300_000,
  streamStallTimeoutMs: 30_000,
  modelCacheTtlMs: 300_000,
  maxAttestationAgeMs: 300_000,
  attestationClockSkewMs: 30_000,
  maxJsonResponseBytes: 2 * 1024 * 1024,
  // A non-streamed E2EE answer is one opaque frame, and the largest one Airship
  // asks for is a batch of embeddings: 64 vectors × 4096 float32 rendered as
  // JSON is several megabytes before gzip. The catalog bound above is sized for
  // metadata and would refuse a legitimate embedding batch, so the encrypted
  // invoke frame gets its own ceiling. It stays well under the WASM's own 64 MiB
  // frame and plaintext limits (`crates/chutes-e2ee-wasm/src/lib.rs`).
  maxInvokeResponseBytes: 16 * 1024 * 1024,
  maxErrorBodyBytes: 32 * 1024,
  maxSseEventChars: 6 * 1024 * 1024,
  maxInstances: 64,
  maxNoncesPerInstance: 32,
  maxCachedNonces: 8,
  maxUsedNonces: 2_048,
  /*
   * How many distinct instances one sealed request may be re-routed across
   * before a 429 is reported as a capacity wait.
   *
   * Three, because each attempt spends a nonce and costs a full seal, and
   * because the failure this covers is a saturated *instance* rather than a
   * saturated chute — if three siblings are all full the chute genuinely has no
   * room and a fourth seal buys a slower error rather than an answer.
   */
  maxInstanceAttempts: 3,
  maxNonceTtlMs: 120_000,
  nonceSafetyMs: 5_000,
  maxToolCalls: 128,
  maxToolArgumentsChars: 4 * 1024 * 1024,
};

const SAFE_NONCE_CODES = new Set([
  "E2E_NONCE_REJECTED",
  "INVALID_NONCE",
  "NONCE_ALREADY_USED",
  "NONCE_EXPIRED",
  "NONCE_REJECTED",
]);
const SAFE_NONCE_MESSAGES = new Set([
  "invalid nonce",
  "nonce already used",
  "nonce expired",
  "nonce rejected",
]);

export class ChutesInferenceTransport implements InferenceTransport {
  readonly id = "chutes-e2ee-v1";
  readonly posture: Extract<SecurityPosture, "encrypted-attested" | "encrypted-unattested">;

  private apiKeySource: ChutesTransportOptions["apiKey"];
  private readonly fetchImpl: FetchLike;
  private readonly crypto: ChutesE2eeCrypto;
  private gate?: AttestationGate;
  private readonly options: ResolvedOptions;
  private readonly now: () => number;
  private readonly onInvocationTelemetry?: (telemetry: ChutesInvocationTelemetry) => void;
  private readonly credentialRevocation = new AbortController();
  private readonly modelCaches = new Map<string, CachedModels>();
  private readonly pendingModels = new Map<string, SharedFlight<ChutesModel[]>>();
  private readonly leasePools = new Map<string, InstanceLease[]>();
  private readonly pendingDiscovery = new Map<string, SharedFlight<void>>();
  private readonly usedNonces = new Map<string, number>();
  private readonly attestationCache = new Map<string, AttestationOutcome>();

  constructor(options: ChutesTransportOptions) {
    this.apiKeySource = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.crypto = options.crypto ?? new WasmChutesE2eeCrypto();
    this.gate = options.attestationGate;
    this.now = options.now ?? Date.now;
    this.onInvocationTelemetry = options.onInvocationTelemetry;
    this.options = resolveOptions(options);
    this.posture =
      this.options.attestationMode === "required" ? "encrypted-attested" : "encrypted-unattested";
  }

  /**
   * Irreversibly release the page-memory credential authority and cancel every
   * in-flight operation. Retained transport references cannot borrow the old
   * key after disconnect.
   */
  revokeCredential(reason: unknown = new DOMException("Chutes credential was released.", "AbortError")): void {
    if (this.credentialRevocation.signal.aborted) return;
    const error = cancelledError(reason);
    this.credentialRevocation.abort(error);
    this.apiKeySource = "";
    this.gate = undefined;
    this.modelCaches.clear();
    this.pendingModels.clear();
    this.leasePools.clear();
    this.pendingDiscovery.clear();
    this.usedNonces.clear();
    this.attestationCache.clear();
  }

  async listModels(signal: AbortSignal = new AbortController().signal): Promise<ChutesModel[]> {
    const linked = linkAbortSignals(signal, this.credentialRevocation.signal);
    try {
      throwIfAborted(linked.signal);
      const apiKey = await abortable(this.resolveApiKey(), linked.signal);
      const authScope = await sha256Local(apiKey);
      return await this.getModels(authScope, linked.signal);
    } finally {
      linked.dispose();
    }
  }

  /** Prove protected E2E endpoint access without spending a nonce or invoking. */
  async verifyModelAccess(
    modelId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const linked = linkAbortSignals(signal, this.credentialRevocation.signal);
    try {
      throwIfAborted(linked.signal);
      const apiKey = await abortable(this.resolveApiKey(), linked.signal);
      const authScope = await sha256Local(apiKey);
      const models = await this.getModels(authScope, linked.signal);
      const model = models.find((candidate) => candidate.id === modelId);
      if (!model) {
        throw new ChutesTransportError(
          "MODEL_NOT_CONFIDENTIAL",
          `Model ${modelId} is not explicitly marked confidential_compute by Chutes discovery.`,
          { operation: "model-discovery" },
        );
      }
      await this.fetchAndPoolLeases(
        apiKey,
        model.chuteId,
        `${authScope}:${model.chuteId}`,
        linked.signal,
      );
    } finally {
      linked.dispose();
    }
  }

  /**
   * One non-streamed encrypted call into an arbitrary path inside a chute.
   *
   * `stream()` is this same machinery pointed at `/v1/chat/completions` with the
   * streaming iterator attached. Embeddings are not streamed and are not chat,
   * but they are the *same* sealed request to the *same* `/e2e/invoke` against
   * the *same* instance public key — so they get the transport's crypto, its
   * nonce ledger, its attestation gate and its bounded reads rather than a
   * second implementation of any of them.
   *
   * `chuteId` and `path` are supplied by the caller because the model catalog
   * this transport reads (`llm.chutes.ai/v1/models`) lists chat deployments
   * only: an embedding chute is absent from it, and inventing a name for one
   * here would hardcode what the management API already publishes.
   */
  async invokeJson(
    request: Readonly<{ chuteId: string; path: string; payload: unknown }>,
    parentSignal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    const linked = linkAbortSignals(parentSignal, this.credentialRevocation.signal);
    const lifetime = new RequestLifetime(linked.signal, this.options.totalTimeoutMs);
    let requestContext: E2eeRequestCryptoContext | undefined;
    try {
      const signal = lifetime.signal;
      throwIfAborted(signal);
      if (!request.path.startsWith("/")) {
        throw new ChutesTransportError("INVALID_RESPONSE", "An E2EE invoke path must start with '/'.");
      }
      const apiKey = await abortable(this.resolveApiKey(), signal);
      const authScope = await sha256Local(apiKey);
      const invoked = await this.postEncrypted({
        apiKey,
        authScope,
        chuteId: request.chuteId,
        path: request.path,
        payloadJson: JSON.stringify(request.payload),
        streamed: false,
        signal,
      });
      requestContext = invoked.requestContext;
      const frame = await readBytesBounded(
        invoked.response,
        this.options.maxInvokeResponseBytes,
        signal,
      );
      // The response secret is consumed by this call whether or not it
      // authenticates, which is the WASM's rule and not a convention here.
      const plaintext = requestContext.decrypt_response(frame);
      frame.fill(0);
      try {
        return JSON.parse(plaintext) as unknown;
      } catch (error) {
        throw new ChutesTransportError(
          "INVALID_RESPONSE",
          "The authenticated Chutes E2EE response was not valid JSON.",
          { cause: error },
        );
      }
    } catch (error) {
      throw normalizeTransportError(error, lifetime.signal);
    } finally {
      if (requestContext) safeFreeRequest(requestContext);
      lifetime.dispose();
      linked.dispose();
    }
  }

  /**
   * Acquire a lease, check its attestation, seal the payload to that instance's
   * public key and POST it to `/e2e/invoke`.
   *
   * Shared by the streaming and non-streaming callers so there is exactly one
   * place where a nonce is spent, one place where the ciphertext is zeroed, and
   * one definition of what a safe nonce-rejection retry is. The only difference
   * between the two is `X-E2E-Stream`, which used to be the string `"true"`
   * written into the request literal.
   */
  private async postEncrypted(args: Readonly<{
    apiKey: string;
    authScope: string;
    chuteId: string;
    path: string;
    payloadJson: string;
    streamed: boolean;
    signal: AbortSignal;
  }>): Promise<{
    response: Response;
    requestContext: E2eeRequestCryptoContext;
    lease: InstanceLease;
    attestation: AttestationOutcome;
    requestCiphertextDigest: string;
  }> {
    const { apiKey, authScope, chuteId, path, payloadJson, streamed, signal } = args;
    const poolKey = `${authScope}:${chuteId}`;
    // Held here rather than inside the attempt so that *any* exit other than a
    // returned response — an abort mid-flight included — still frees the WASM
    // context. Ownership transfers to the caller only on the success return.
    let requestContext: E2eeRequestCryptoContext | undefined;

    /*
     * Instances that answered 429 for *this* request.
     *
     * `/e2e/invoke` is pinned to `X-Instance-Id` because the payload is sealed
     * to that instance's public key, so the gateway cannot shed a saturated
     * request to a sibling the way `llm.chutes.ai` sheds a completion. That
     * re-routing has to happen here or it does not happen at all — which is why
     * the same key and model answered 200 on the chat gateway and 429 here.
     *
     * Retrying is safe precisely because 429 means the instance refused before
     * running anything: no inference happened, nothing was billed, and the
     * sealed body never reached a model. The retry spends a *different* nonce
     * against a *different* instance; it is a new request, not a replay.
     */
    const saturated = new Set<string>();
    /** One safe retry for a nonce rejection, independent of the instance budget. */
    let nonceRetried = false;

    try {
      for (let attempt = 1; attempt <= this.options.maxInstanceAttempts; attempt += 1) {
        const lease = await this.acquireLease(apiKey, chuteId, poolKey, signal, saturated);
        if (!lease) {
          throw new ChutesTransportError(
            "HTTP_ERROR",
            `Chutes E2EE invoke failed with HTTP 429: every instance of chute ${chuteId} that this session could reach is at capacity (tried ${saturated.size}). Encrypted inference is pinned to one instance per request and cannot be re-routed the way an unencrypted completion can, so this is a capacity wait rather than a fault.`,
            { status: 429, operation: "invoke" },
          );
        }
        const attestation = await this.checkAttestation(lease, signal);

        requestContext = await abortable(
          this.crypto.buildRequest(lease.e2ePublicKey, payloadJson),
          signal,
        );
        const encryptedBody = requestContext.take_blob();
        const requestCiphertextDigest = await sha256Local(encryptedBody);
        let response: Response;
        try {
          response = await abortable(
            this.fetchImpl(`${this.options.apiBase}/e2e/invoke`, {
              method: "POST",
              mode: "cors",
              credentials: "omit",
              signal,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/octet-stream",
                "X-Chute-Id": chuteId,
                "X-Instance-Id": lease.instanceId,
                "X-E2E-Nonce": lease.nonce,
                "X-E2E-Path": path,
                "X-E2E-Stream": streamed ? "true" : "false",
              },
              body: encryptedBody as unknown as BodyInit,
            }),
            signal,
          );
        } finally {
          encryptedBody.fill(0);
        }

        const invocationTelemetry = parseChutesInvocationTelemetry(response.headers, this.now());
        if (invocationTelemetry && this.onInvocationTelemetry) {
          try {
            this.onInvocationTelemetry(invocationTelemetry);
          } catch {
            // Account telemetry is advisory and must never break an inference turn.
          }
        }

        if (response.ok) {
          const owned = requestContext;
          requestContext = undefined;
          return { response, requestContext: owned, lease, attestation, requestCiphertextDigest };
        }

        const errorBody = await readTextBounded(response, this.options.maxErrorBodyBytes, signal);
        safeFreeRequest(requestContext);
        requestContext = undefined;
        if (isSafeNonceRejection(response, errorBody)) {
          // Counted on its own, not off the attempt index. The attempt budget
          // is now wider than two so a saturated instance can be re-routed
          // around, and a nonce rejection must still get exactly one safe
          // retry — reusing `attempt` here would silently widen it too.
          if (!nonceRetried) {
            nonceRetried = true;
            this.leasePools.delete(poolKey);
            continue;
          }
          throw new ChutesTransportError(
            "NONCE_REJECTED",
            "Chutes rejected a freshly discovered E2EE nonce after one safe retry.",
            { status: response.status, detail: errorBody.slice(0, 500) },
          );
        }
        if (response.status === 429) {
          // Not a fault and not a rate limit on the credential: this one
          // instance is full. Re-route by leasing a different one, which is the
          // job `llm.chutes.ai` does for unencrypted completions and that
          // nothing can do for a payload sealed to a specific instance.
          saturated.add(lease.instanceId);
          this.leasePools.delete(poolKey);
          if (attempt < this.options.maxInstanceAttempts) continue;
          throw new ChutesTransportError(
            "HTTP_ERROR",
            `Chutes E2EE invoke failed with HTTP 429 on ${saturated.size} instance(s) of chute ${chuteId}, most recently ${lease.instanceId}. Encrypted inference is pinned to one instance per request and cannot be re-routed the way an unencrypted completion can, so this is a capacity wait rather than a fault.`,
            { status: 429, detail: errorBody.slice(0, 500), operation: "invoke" },
          );
        }
        throw httpError("invoke", "Chutes E2EE invoke", response.status, errorBody);
      }

      throw new ChutesTransportError("NONCE_REJECTED", "Chutes rejected a fresh E2EE nonce twice.");
    } finally {
      if (requestContext) safeFreeRequest(requestContext);
    }
  }

  async *stream(request: InferenceRequest, parentSignal: AbortSignal): AsyncIterable<InferenceEvent> {
    const linked = linkAbortSignals(parentSignal, this.credentialRevocation.signal);
    const lifetime = new RequestLifetime(linked.signal, this.options.totalTimeoutMs);
    let requestContext: E2eeRequestCryptoContext | undefined;
    let streamContext: E2eeStreamCryptoContext | undefined;
    let stall: StallTimer | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const signal = lifetime.signal;
      throwIfAborted(signal);
      const apiKey = await abortable(this.resolveApiKey(), signal);
      const authScope = await sha256Local(apiKey);
      const models = await this.getModels(authScope, signal);
      const model = models.find((candidate) => candidate.id === request.model);
      if (!model) {
        throw new ChutesTransportError(
          "MODEL_NOT_CONFIDENTIAL",
          `Model ${request.model} is not explicitly marked confidential_compute by Chutes discovery.`,
        );
      }

      if (requestHasImages(request)) {
        if (!model.inputModalities) {
          throw new ChutesTransportError(
            "MODEL_CAPABILITY_UNVERIFIED",
            `Chutes discovery did not provide trustworthy input_modalities for ${request.model}.`,
          );
        }
        if (!model.inputModalities.includes("image")) {
          throw new ChutesTransportError(
            "MODEL_INPUT_UNSUPPORTED",
            `Model ${request.model} does not declare image input support.`,
          );
        }
      }

      const payloadJson = JSON.stringify(buildOpenAiPayload(request));
      const invoked = await this.postEncrypted({
        apiKey,
        authScope,
        chuteId: model.chuteId,
        path: this.options.inferencePath,
        payloadJson,
        streamed: true,
        signal,
      });
      requestContext = invoked.requestContext;
      const response = invoked.response;
      const attestation: AttestationOutcome = invoked.attestation;
      const requestCiphertextDigest: string | undefined = invoked.requestCiphertextDigest;
      const invokedLease: InstanceLease | undefined = invoked.lease;

      if (!response.body) {
        throw new ChutesTransportError("INVALID_RESPONSE", "Chutes streaming response has no body.");
      }

      const assembler = new OpenAiStreamAssembler({
        maxToolCalls: this.options.maxToolCalls,
        maxToolArgumentsChars: this.options.maxToolArgumentsChars,
      });
      const outerParser = new BoundedSseParser(this.options.maxSseEventChars);
      // Chutes authenticates arbitrary upstream body chunks, not complete SSE
      // events. In deployed streams a data line and its blank delimiter are
      // commonly two independently encrypted records, so their authenticated
      // plaintext must feed one persistent inner parser in arrival order.
      const authenticatedStream = new AuthenticatedOpenAiStream(
        assembler,
        this.options.maxSseEventChars,
      );
      const decoder = new TextDecoder();
      const responseCiphertextCommitment = new CiphertextTranscriptCommitment();
      let sawDone = false;
      let streamOpened = false;
      reader = response.body.getReader();
      stall = new StallTimer(lifetime, this.options.streamStallTimeoutMs);
      stall.arm();

      while (!sawDone) {
        const { value, done } = await abortable(reader.read(), signal);
        if (done) break;
        stall.noteProgress();
        const messages = outerParser.push(decoder.decode(value, { stream: true }));
        for (const outer of messages) {
          const result = this.processOuterMessage(
            outer,
            requestContext,
            streamContext,
            authenticatedStream,
          );
          if (result.authenticatedCiphertext !== undefined) {
            await responseCiphertextCommitment.append(result.authenticatedCiphertext);
          }
          if (result.requestConsumed && requestContext) {
            safeFreeRequest(requestContext);
            requestContext = undefined;
          }
          if (result.streamContext) {
            streamContext = result.streamContext;
            streamOpened = true;
          }
          if (result.done) {
            requireAuthenticatedTerminalChoice(assembler);
            sawDone = true;
          }
          for (const event of result.events) {
            stall.pause();
            yield event;
            stall.arm();
          }
          if (sawDone) break;
        }
      }

      if (!sawDone) {
        const finalMessages = outerParser.push(decoder.decode(), true);
        for (const outer of finalMessages) {
          const result = this.processOuterMessage(
            outer,
            requestContext,
            streamContext,
            authenticatedStream,
          );
          if (result.authenticatedCiphertext !== undefined) {
            await responseCiphertextCommitment.append(result.authenticatedCiphertext);
          }
          if (result.requestConsumed && requestContext) {
            safeFreeRequest(requestContext);
            requestContext = undefined;
          }
          if (result.streamContext) {
            streamContext = result.streamContext;
            streamOpened = true;
          }
          if (result.done) {
            requireAuthenticatedTerminalChoice(assembler);
            sawDone = true;
          }
          for (const event of result.events) {
            stall.pause();
            yield event;
            stall.arm();
          }
        }
      }

      if (!sawDone && streamOpened) {
        const innerFinal = authenticatedStream.finish();
        // Some Chutes iterators terminate after an authenticated OpenAI
        // finish_reason without emitting the optional [DONE] sentinel. EOF is
        // not cryptographic proof of completeness in v1, but the authenticated
        // terminal choice is sufficient for correct client completion.
        if (innerFinal.done) requireAuthenticatedTerminalChoice(assembler);
        if (assembler.hasFinishReason) sawDone = true;
        for (const event of innerFinal.events) {
          stall.pause();
          yield event;
          stall.arm();
        }
      }

      if (!streamOpened) {
        throw new ChutesTransportError("STREAM_TRUNCATED", "Chutes stream ended before E2EE initialization.");
      }
      if (!sawDone) {
        throw new ChutesTransportError(
          "STREAM_TRUNCATED",
          "Chutes stream ended without its v1 outer completion marker.",
        );
      }

      const final = assembler.finalize();
      for (const call of final.toolCalls) {
        stall.pause();
        yield { type: "tool-call", call };
        stall.arm();
      }
      const endpointKeyDigest = invokedLease
        ? await sha256Local(invokedLease.e2ePublicKey)
        : undefined;
      const receipt = createConversationReceipt({
        request,
        model,
        instanceId: invokedLease?.instanceId,
        endpointKeyDigest,
        requestCiphertextDigest,
        responseCiphertextDigest: responseCiphertextCommitment.digest(),
        attestation,
        nowMs: this.now(),
      });
      stall.pause();
      yield { type: "completed", finishReason: final.finishReason, receipt };
    } catch (error) {
      throw normalizeTransportError(error, lifetime.signal);
    } finally {
      stall?.stop();
      if (reader) cancelReaderWithoutBlocking(reader);
      if (streamContext) {
        try {
          streamContext.finish();
        } catch {
          // Freeing the opaque context below remains mandatory.
        }
        safeFreeStream(streamContext);
      }
      if (requestContext) safeFreeRequest(requestContext);
      lifetime.dispose();
      linked.dispose();
    }
  }

  private processOuterMessage(
    outer: SseMessage,
    requestContext: E2eeRequestCryptoContext | undefined,
    currentStream: E2eeStreamCryptoContext | undefined,
    authenticatedStream: AuthenticatedOpenAiStream,
  ): {
    events: InferenceEvent[];
    done: boolean;
    requestConsumed: boolean;
    streamContext?: E2eeStreamCryptoContext;
    authenticatedCiphertext?: string;
  } {
    if (outer.data.trim() === "[DONE]") {
      const innerFinal = authenticatedStream.finish();
      return { events: innerFinal.events, done: true, requestConsumed: false };
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(outer.data);
    } catch (error) {
      throw new ChutesTransportError("INVALID_SSE", "Chutes outer SSE data is not valid JSON.", {
        cause: error,
      });
    }
    if (!isRecord(envelope)) return { events: [], done: false, requestConsumed: false };

    if (typeof envelope.e2e_init === "string") {
      if (!requestContext || currentStream) {
        throw new ChutesTransportError("INVALID_RESPONSE", "Chutes sent a duplicate or misplaced E2EE init.");
      }
      const streamContext = requestContext.open_stream(envelope.e2e_init);
      return { events: [], done: false, requestConsumed: true, streamContext };
    }
    if (typeof envelope.e2e === "string") {
      if (!currentStream) {
        throw new ChutesTransportError("INVALID_RESPONSE", "Chutes sent an encrypted chunk before E2EE init.");
      }
      const plaintext = currentStream.decrypt_chunk(envelope.e2e);
      const inner = authenticatedStream.push(plaintext);
      return { ...inner, requestConsumed: false, authenticatedCiphertext: envelope.e2e };
    }
    if (envelope.e2e_error !== undefined) {
      throw new ChutesTransportError(
        "REMOTE_ERROR",
        "Chutes reported an error outside the encrypted stream.",
        { detail: safeDetail(envelope.e2e_error) },
      );
    }
    // Outer usage/heartbeat events are intentionally ignored because they are
    // not authenticated by the v1 stream key.
    return { events: [], done: false, requestConsumed: false };
  }

  private async resolveApiKey() {
    throwIfAborted(this.credentialRevocation.signal);
    const value =
      typeof this.apiKeySource === "function" ? await this.apiKeySource() : this.apiKeySource;
    throwIfAborted(this.credentialRevocation.signal);
    const key = value.trim();
    if (!key) throw new ChutesTransportError("HTTP_ERROR", "A Chutes API key is required.");
    return key;
  }

  private async getModels(authScope: string, signal: AbortSignal) {
    const cached = this.modelCaches.get(authScope);
    if (cached && cached.expiresAt > this.now()) return cached.models.slice();

    let flight = this.pendingModels.get(authScope);
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, promise: Promise.resolve([]), waiters: 0, settled: false };
      const created = flight;
      created.promise = this.fetchModels(controller.signal).finally(() => {
        created.settled = true;
        if (this.pendingModels.get(authScope) === created) this.pendingModels.delete(authScope);
      });
      this.pendingModels.set(authScope, created);
    }
    flight.waiters += 1;
    try {
      const models = await abortable(flight.promise, signal);
      this.modelCaches.set(authScope, {
        expiresAt: this.now() + this.options.modelCacheTtlMs,
        models,
      });
      return models.slice();
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(cancelledError());
      }
    }
  }

  private async fetchModels(signal: AbortSignal): Promise<ChutesModel[]> {
    const response = await abortable(
      this.fetchImpl(`${this.options.llmBase}/v1/models`, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        signal,
      }),
      signal,
    );
    if (!response.ok) {
      const detail = await readTextBounded(response, this.options.maxErrorBodyBytes, signal);
      throw httpError("model-discovery", "Chutes model discovery", response.status, detail);
    }
    const body = await readJsonBounded(response, this.options.maxJsonResponseBytes, signal);
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new ChutesTransportError("INVALID_RESPONSE", "Chutes model discovery has no data array.");
    }
    if (body.data.length > 10_000) {
      throw new ChutesTransportError("RESPONSE_TOO_LARGE", "Chutes returned too many model records.");
    }

    const models: ChutesModel[] = [];
    const seen = new Set<string>();
    for (const value of body.data) {
      if (!isRecord(value) || value.confidential_compute !== true) continue;
      if (
        typeof value.id !== "string" ||
        !value.id ||
        value.id.length > 512 ||
        typeof value.chute_id !== "string" ||
        !value.chute_id ||
        value.chute_id.length > 256 ||
        seen.has(value.id)
      ) {
        continue;
      }
      seen.add(value.id);
      const inputModalities = parseInputModalities(value.input_modalities);
      models.push({
        id: value.id,
        chuteId: value.chute_id,
        confidentialCompute: true,
        ...(inputModalities ? { inputModalities } : {}),
      });
    }
    models.sort((left, right) => left.id.localeCompare(right.id));
    return models;
  }

  /**
   * A lease on an instance that is not in `avoid`.
   *
   * `avoid` carries the instances that have already answered 429 for this
   * request. Returns `undefined` — rather than looping — once a fresh discovery
   * round has failed to produce an unavoided lease, because at that point every
   * instance the chute has is either saturated or already tried, and spinning
   * would turn a capacity refusal into a hang.
   */
  private async acquireLease(
    apiKey: string,
    chuteId: string,
    poolKey: string,
    signal: AbortSignal,
    avoid?: ReadonlySet<string>,
  ): Promise<InstanceLease | undefined> {
    let discovered = false;
    for (;;) {
      this.pruneNonces(poolKey);
      const lease = this.consumeLease(poolKey, avoid);
      if (lease) return lease;
      // One discovery round is the whole budget when instances are being
      // avoided: discovery re-reads the same instance list, so a second round
      // cannot produce an instance the first did not.
      if (discovered && avoid?.size) return undefined;
      discovered = true;

      let flight = this.pendingDiscovery.get(poolKey);
      if (!flight) {
        const controller = new AbortController();
        flight = { controller, promise: Promise.resolve(), waiters: 0, settled: false };
        const created = flight;
        created.promise = this.fetchAndPoolLeases(apiKey, chuteId, poolKey, controller.signal).finally(() => {
          created.settled = true;
          if (this.pendingDiscovery.get(poolKey) === created) this.pendingDiscovery.delete(poolKey);
        });
        this.pendingDiscovery.set(poolKey, created);
      }
      flight.waiters += 1;
      try {
        await abortable(flight.promise, signal);
      } finally {
        flight.waiters -= 1;
        if (flight.waiters === 0 && !flight.settled) {
          flight.controller.abort(cancelledError());
        }
      }
    }
  }

  private async fetchAndPoolLeases(
    apiKey: string,
    chuteId: string,
    poolKey: string,
    signal: AbortSignal,
  ) {
    const response = await abortable(
      this.fetchImpl(`${this.options.apiBase}/e2e/instances/${encodeURIComponent(chuteId)}`, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      signal,
    );
    if (!response.ok) {
      const detail = await readTextBounded(response, this.options.maxErrorBodyBytes, signal);
      throw httpError("instance-discovery", "Chutes E2EE instance discovery", response.status, detail);
    }
    const body = await readJsonBounded(response, this.options.maxJsonResponseBytes, signal);
    if (!isRecord(body) || !Array.isArray(body.instances)) {
      throw new ChutesTransportError("INVALID_RESPONSE", "Chutes instance discovery has no instances array.");
    }
    if (body.instances.length > this.options.maxInstances) {
      throw new ChutesTransportError("RESPONSE_TOO_LARGE", "Chutes returned too many E2EE instances.");
    }

    const ttlSeconds =
      typeof body.nonce_expires_in === "number" && Number.isFinite(body.nonce_expires_in)
        ? body.nonce_expires_in
        : 55;
    const ttlMs = Math.min(this.options.maxNonceTtlMs, Math.max(1_000, ttlSeconds * 1_000));
    const expiresAt = this.now() + Math.max(1_000, ttlMs - this.options.nonceSafetyMs);
    /*
     * Leases are taken a nonce at a time across the instances, not instance by
     * instance until the pool is full.
     *
     * The pool holds up to `maxCachedNonces` (8) and an instance may offer up to
     * `maxNoncesPerInstance` (32), so filling depth-first meant every lease in
     * the pool named the *first* instance: eight consecutive encrypted
     * invocations aimed at one endpoint while its siblings sat idle. That is
     * invisible on `llm.chutes.ai`, which routes a completion to whichever
     * instance is free, and it is not invisible on `/e2e/invoke`, which is
     * pinned to `X-Instance-Id` because the payload is sealed to that
     * instance's public key. Concentrating a session's whole burst on one
     * endpoint is a way to earn a 429 that the unencrypted path would not.
     */
    const perInstance: InstanceLease[][] = [];
    for (const rawInstance of body.instances) {
      if (!isRecord(rawInstance)) continue;
      const instanceId = rawInstance.instance_id;
      const e2ePublicKey = rawInstance.e2e_pubkey;
      const nonces = rawInstance.nonces;
      if (
        typeof instanceId !== "string" ||
        !instanceId ||
        instanceId.length > 256 ||
        typeof e2ePublicKey !== "string" ||
        !e2ePublicKey ||
        e2ePublicKey.length > 2_048 ||
        !Array.isArray(nonces) ||
        nonces.length > this.options.maxNoncesPerInstance
      ) {
        continue;
      }
      const usable: InstanceLease[] = [];
      for (const nonce of nonces) {
        if (typeof nonce !== "string" || !nonce || nonce.length > 1_024) continue;
        usable.push({ chuteId, instanceId, e2ePublicKey, nonce, expiresAt });
      }
      if (usable.length) perInstance.push(usable);
    }

    const leases: InstanceLease[] = [];
    for (let round = 0; leases.length < this.options.maxCachedNonces; round += 1) {
      let placed = false;
      for (const instanceLeases of perInstance) {
        const lease = instanceLeases[round];
        if (!lease) continue;
        leases.push(lease);
        placed = true;
        if (leases.length >= this.options.maxCachedNonces) break;
      }
      if (!placed) break;
    }
    if (!leases.length) {
      throw new ChutesTransportError("NO_E2EE_INSTANCE", "Chutes returned no bounded E2EE nonce leases.");
    }
    this.leasePools.set(poolKey, leases);
  }

  /**
   * Take one unspent, unexpired lease, optionally skipping named instances.
   *
   * A skipped lease is *deferred*, not consumed: its nonce is still good, and
   * the instance it belongs to is only saturated for this request. Dropping it
   * would spend the pool down every time one instance was busy, which is the
   * opposite of what the interleaving above is for.
   */
  private consumeLease(poolKey: string, avoid?: ReadonlySet<string>): InstanceLease | undefined {
    const pool = this.leasePools.get(poolKey);
    const deferred: InstanceLease[] = [];
    const restore = () => {
      if (!deferred.length) return;
      const current = this.leasePools.get(poolKey);
      if (current) current.unshift(...deferred);
      else this.leasePools.set(poolKey, deferred);
    };
    while (pool?.length) {
      const lease = pool.shift() as InstanceLease;
      const nonceKey = `${poolKey}:${lease.instanceId}:${lease.nonce}`;
      if (lease.expiresAt <= this.now() || this.usedNonces.has(nonceKey)) continue;
      if (avoid?.has(lease.instanceId)) {
        deferred.push(lease);
        continue;
      }
      if (this.usedNonces.size >= this.options.maxUsedNonces) {
        restore();
        throw new ChutesTransportError(
          "NONCE_CACHE_EXHAUSTED",
          "The bounded live nonce-use ledger is full; refusing to risk a v1 nonce reuse.",
        );
      }
      this.usedNonces.set(nonceKey, lease.expiresAt);
      restore();
      if (!this.leasePools.get(poolKey)?.length) this.leasePools.delete(poolKey);
      return lease;
    }
    restore();
    if (!this.leasePools.get(poolKey)?.length) this.leasePools.delete(poolKey);
    return undefined;
  }

  private pruneNonces(poolKey: string) {
    const now = this.now();
    const pool = this.leasePools.get(poolKey)?.filter((lease) => lease.expiresAt > now) ?? [];
    if (pool.length) this.leasePools.set(poolKey, pool);
    else this.leasePools.delete(poolKey);
    for (const [key, expiresAt] of this.usedNonces) {
      if (expiresAt <= now) this.usedNonces.delete(key);
    }
  }

  private async checkAttestation(lease: InstanceLease, signal: AbortSignal): Promise<AttestationOutcome> {
    const subject: AttestationSubject = {
      provider: "chutes",
      chuteId: lease.chuteId,
      instanceId: lease.instanceId,
      e2ePublicKey: lease.e2ePublicKey,
    };
    const cacheKey = attestationKey(subject);
    const cached = this.attestationCache.get(cacheKey);
    const cachedProblem = validateEndpointReceipt(
      cached?.receipt,
      subject,
      this.now(),
      this.options.maxAttestationAgeMs,
      this.options.attestationClockSkewMs,
    );
    if (!cachedProblem && cached?.receipt) return cached;
    if (cached) this.attestationCache.delete(cacheKey);

    if (!this.gate) {
      return this.attestationUnavailable(
        "No AttestationGate is configured.",
        undefined,
        "ATTESTATION_REQUIRED",
      );
    }
    let gateResult;
    try {
      gateResult = await abortable(this.gate.verifyEndpoint(subject, signal), signal);
    } catch (error) {
      if (signal.aborted) throw errorFromAbortSignal(signal);
      return this.attestationUnavailable(
        `The attestation verifier failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
        error,
        "ATTESTATION_FAILED",
      );
    }
    const receipt = gateResult.receipt;
    const problem = validateEndpointReceipt(
      receipt,
      subject,
      this.now(),
      this.options.maxAttestationAgeMs,
      this.options.attestationClockSkewMs,
    );
    if (problem || !receipt) {
      return this.attestationUnavailable(
        gateResult.unavailableReason ?? problem ?? "Attestation failed.",
        undefined,
        "ATTESTATION_FAILED",
        gateResult.evaluation,
      );
    }
    const outcome = { receipt, ...(gateResult.evaluation ? { evaluation: gateResult.evaluation } : {}) };
    this.attestationCache.set(cacheKey, outcome);
    return outcome;
  }

  private attestationUnavailable(
    reason: string,
    cause?: unknown,
    code: "ATTESTATION_REQUIRED" | "ATTESTATION_FAILED" = "ATTESTATION_FAILED",
    evaluation?: AttestationOutcome["evaluation"],
  ): AttestationOutcome {
    if (this.options.attestationMode === "required") {
      throw new ChutesTransportError(code, reason, { cause });
    }
    return { unavailableReason: reason, ...(evaluation ? { evaluation } : {}) };
  }
}

function requestHasImages(request: InferenceRequest): boolean {
  return request.messages.some((message) => Boolean(message.images?.length));
}

function parseInputModalities(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const modalities: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const modality = item.trim().toLowerCase();
    if (!modality || modality.length > 64) return undefined;
    if (!seen.has(modality)) {
      seen.add(modality);
      modalities.push(modality);
    }
  }
  return Object.freeze(modalities);
}

function resolveOptions(options: ChutesTransportOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...DEFAULTS,
    ...pickDefined(options, Object.keys(DEFAULTS) as (keyof ResolvedOptions)[]),
    apiBase: normalizeBase(options.apiBase ?? DEFAULTS.apiBase),
    llmBase: normalizeBase(options.llmBase ?? DEFAULTS.llmBase),
    inferencePath: options.inferencePath ?? DEFAULTS.inferencePath,
    attestationMode: options.attestationMode ?? DEFAULTS.attestationMode,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (!resolved.inferencePath.startsWith("/")) throw new TypeError("inferencePath must start with '/'");
  return resolved;
}

function pickDefined<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function normalizeBase(value: string) {
  return value.replace(/\/+$/, "");
}

class RequestLifetime {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly onParentAbort: () => void;
  private readonly parent: AbortSignal;

  constructor(parent: AbortSignal, timeoutMs: number) {
    this.parent = parent;
    this.onParentAbort = () => this.abort(cancelledError(parent.reason));
    if (parent.aborted) this.onParentAbort();
    else parent.addEventListener("abort", this.onParentAbort, { once: true });
    this.timeout = setTimeout(
      () => this.abort(new ChutesTransportError("TIMEOUT", "Chutes inference exceeded its lifetime limit.")),
      timeoutMs,
    );
  }

  abort(reason: ChutesTransportError) {
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  dispose() {
    clearTimeout(this.timeout);
    this.parent.removeEventListener("abort", this.onParentAbort);
  }
}

class StallTimer {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly lifetime: RequestLifetime,
    private readonly timeoutMs: number,
  ) {}

  arm() {
    this.stop();
    this.timer = setTimeout(
      () =>
        this.lifetime.abort(
          new ChutesTransportError("STREAM_STALLED", "Chutes response stream stopped making progress."),
        ),
      this.timeoutMs,
    );
  }

  noteProgress() {
    this.arm();
  }

  pause() {
    this.stop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function linkAbortSignals(
  caller: AbortSignal,
  authority: AbortSignal,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  const forwardCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(caller.reason ?? new DOMException("Inference request was cancelled.", "AbortError"));
    }
  };
  const forwardAuthority = () => {
    if (!controller.signal.aborted) {
      controller.abort(authority.reason ?? new DOMException("Inference credential was released.", "AbortError"));
    }
  };
  if (caller.aborted) forwardCaller();
  else caller.addEventListener("abort", forwardCaller, { once: true });
  if (authority.aborted) forwardAuthority();
  else authority.addEventListener("abort", forwardAuthority, { once: true });
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      caller.removeEventListener("abort", forwardCaller);
      authority.removeEventListener("abort", forwardAuthority);
    },
  });
}

async function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(errorFromAbortSignal(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw errorFromAbortSignal(signal);
}

async function readJsonBounded(response: Response, maxBytes: number, signal: AbortSignal) {
  const text = await readTextBounded(response, maxBytes, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ChutesTransportError("INVALID_RESPONSE", "Chutes returned invalid JSON.", { cause: error });
  }
}

async function readTextBounded(response: Response, maxBytes: number, signal: AbortSignal) {
  const bytes = await readBytesBounded(response, maxBytes, signal);
  return new TextDecoder().decode(bytes);
}

async function readBytesBounded(response: Response, maxBytes: number, signal: AbortSignal) {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ChutesTransportError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes.`);
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ChutesTransportError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    cancelReaderWithoutBlocking(reader);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Stream cancellation is best-effort cleanup and must never hold a completed
 * or failed inference turn open. A custom/body stream may legally return a
 * cancellation promise that never settles; awaiting it would leave the async
 * iterator, agent turn, and composer busy forever after a terminal event.
 */
function cancelReaderWithoutBlocking(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Some custom readers throw synchronously during cancellation.
  }
  try {
    reader.releaseLock();
  } catch {
    // A browser may retain a pending read while cancellation propagates.
  }
}

function isSafeNonceRejection(response: Response, body: string) {
  if (response.status !== 403) return false;
  const headerCode = response.headers.get("x-chutes-error-code")?.trim().toUpperCase();
  if (headerCode && SAFE_NONCE_CODES.has(headerCode)) return true;

  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const directCode = typeof parsed.code === "string" ? parsed.code : undefined;
      const nestedCode =
        isRecord(parsed.error) && typeof parsed.error.code === "string" ? parsed.error.code : undefined;
      const code = (directCode ?? nestedCode)?.trim().toUpperCase();
      if (code && SAFE_NONCE_CODES.has(code)) return true;
    }
  } catch {
    // Exact text fallbacks below retain compatibility with the current endpoint.
  }
  return SAFE_NONCE_MESSAGES.has(body.trim().toLowerCase());
}

function httpError(
  operation: ChutesTransportOperation,
  label: string,
  status: number,
  body: string,
) {
  return new ChutesTransportError("HTTP_ERROR", `${label} failed with HTTP ${status}.`, {
    status,
    detail: body.slice(0, 500),
    operation,
  });
}

function attestationKey(subject: AttestationSubject) {
  return JSON.stringify([subject.chuteId, subject.instanceId, subject.e2ePublicKey]);
}

function safeFreeRequest(context: E2eeRequestCryptoContext) {
  try {
    context.free();
  } catch {
    // wasm-bindgen free is best-effort during exceptional cleanup.
  }
}

function safeFreeStream(context: E2eeStreamCryptoContext) {
  try {
    context.free();
  } catch {
    // wasm-bindgen free is best-effort during exceptional cleanup.
  }
}

function safeDetail(value: unknown) {
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "unserializable remote error";
  }
}

function requireAuthenticatedTerminalChoice(assembler: OpenAiStreamAssembler): void {
  if (!assembler.hasFinishReason) {
    throw new ChutesTransportError(
      "STREAM_TRUNCATED",
      "Chutes stream ended without an authenticated OpenAI finish reason.",
    );
  }
}

function createConversationReceipt(args: {
  request: InferenceRequest;
  model: ChutesModel;
  instanceId?: string;
  endpointKeyDigest?: string;
  requestCiphertextDigest?: string;
  responseCiphertextDigest?: string;
  attestation: AttestationOutcome;
  nowMs: number;
}): ConversationReceipt {
  const now = new Date(args.nowMs).toISOString();
  const claims = emptyClaims();
  claims.encryption = {
    status: "partial",
    summary:
      "Airship locally encrypted the request and authenticated response chunks with Chutes E2EE v1; this is client evidence, not an enclave transcript signature.",
    verifier: "airship-client",
    checkedAt: now,
  };
  claims.model = {
    status: "unavailable",
    summary: "Chutes model discovery selected this model, but no model-artifact proof is present.",
  };
  claims.conversation = args.requestCiphertextDigest && args.responseCiphertextDigest
    ? {
        status: "partial",
        summary:
          "Airship locally committed the request ciphertext and every authenticated response-ciphertext record. This is a client hash-chain binding, not an enclave-signed transcript.",
        verifier: "airship-client",
        checkedAt: now,
        details: {
          commitment: "airship-chutes-e2e-response-sha256-chain-v1",
          authority: "local-client",
        },
      }
    : {
        status: "unavailable",
        summary: "Chutes E2EE v1 provides no enclave-signed transcript or authenticated final record.",
      };

  const verifications: VerificationRecord[] = [
    {
      verifier: "airship-client",
      version: "1",
      checkedAt: now,
      status: "partial",
      claim: "encryption",
      detail: "Local v1 encryption and per-record authentication; routing metadata remains outside AEAD.",
    },
  ];
  if (claims.conversation.status === "partial") {
    verifications.push({
      verifier: "airship-client",
      version: "1",
      checkedAt: now,
      status: "partial",
      claim: "conversation",
      detail:
        "Local request-ciphertext digest plus a domain-separated SHA-256 chain over authenticated response-ciphertext records; no external signer.",
    });
  }
  const verified = args.attestation.receipt;
  const evaluated = args.attestation.evaluation;
  if (evaluated) {
    claims.freshness = copyClaim(evaluated.freshness);
    claims.endpointKey = copyClaim(evaluated.endpointKey);
    claims.cpuTee = copyClaim(evaluated.cpuTee);
    claims.gpuTee = copyClaim(evaluated.gpuTee);
    claims.model = {
      ...copyClaim(evaluated.runtimePolicy),
      summary: `${evaluated.runtimePolicy.summary} This runtime-policy result does not prove the selected model artifact or weights.`,
    };
    for (const [claim, value] of [
      ["freshness", evaluated.freshness],
      ["endpointKey", evaluated.endpointKey],
      ["cpuTee", evaluated.cpuTee],
      ["gpuTee", evaluated.gpuTee],
      ["model", evaluated.runtimePolicy],
    ] as const) {
      if (!value.verifier) continue;
      if (verified && claim !== "model") continue;
      verifications.push({
        verifier: value.verifier,
        version: "1",
        checkedAt: value.checkedAt ?? evaluated.checkedAt,
        status: value.status,
        claim,
        ...(value.policyDigest ? { policyDigest: value.policyDigest } : {}),
        detail: claim === "model"
          ? "Runtime policy evaluation only; no model-artifact proof."
          : "Invocation-time endpoint evidence evaluation; no conversation proof.",
      });
    }
  }
  if (verified) {
    claims.freshness = {
      status: "verified",
      summary: "The endpoint receipt was within its verifier and Airship freshness windows.",
      verifier: verified.verifier,
      policyDigest: verified.policyDigest,
      checkedAt: verified.verifiedAt,
    };
    claims.endpointKey = {
      status: "verified",
      summary: "A fresh verifier receipt bound the exact Chutes chute, instance, and E2EE public key.",
      verifier: verified.verifier,
      policyDigest: verified.policyDigest,
      checkedAt: verified.verifiedAt,
    };
    if (verified.cpuTee) claims.cpuTee = copyClaim(verified.cpuTee);
    if (verified.gpuTee) claims.gpuTee = copyClaim(verified.gpuTee);
    verifications.push({
      verifier: verified.verifier,
      version: verified.verifierVersion,
      checkedAt: verified.verifiedAt,
      status: "verified",
      claim: "endpointKey",
      policyDigest: verified.policyDigest,
      detail: "Exact endpoint-key binding; does not imply model or conversation proof.",
    });
  } else {
    if (!evaluated) {
      claims.endpointKey = {
        status: "unavailable",
        summary: args.attestation.unavailableReason ?? "No verified endpoint-key receipt is present.",
      };
    }
  }

  return {
    version: 1,
    receiptId: `urn:airship:receipt:${randomUuid()}`,
    sessionId: args.request.sessionId,
    turnId: args.request.turnId,
    createdAt: now,
    proofLevel: verified ? "attested-endpoint" : "encrypted",
    posture: verified ? "encrypted-attested" : "encrypted-unattested",
    provider: "chutes",
    instanceId: args.instanceId,
    model: args.model.id,
    claims,
    bindings: {
      algorithm: "SHA-256",
      endpointKeyDigest: args.endpointKeyDigest,
      requestCiphertextDigest: args.requestCiphertextDigest,
      responseCiphertextDigest: args.responseCiphertextDigest,
      evidenceDigest: evaluated?.evidenceDigest ?? verified?.evidence?.digest,
    },
    evidence: verified?.evidence
      ? { format: verified.evidence.format, payload: verified.evidence.payload }
      : undefined,
    verifications,
  };
}

function copyClaim(claim: ReceiptClaim): ReceiptClaim {
  return {
    ...claim,
    details: claim.details === undefined ? undefined : cloneJson(claim.details),
  };
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function sha256Local(value: string | Uint8Array) {
  return formatSha256(await sha256Bytes(
    typeof value === "string" ? CIPHERTEXT_ENCODER.encode(value) : value,
  ));
}

const CIPHERTEXT_ENCODER = new TextEncoder();
const RESPONSE_COMMITMENT_DOMAIN =
  CIPHERTEXT_ENCODER.encode("airship:chutes:e2e-response:sha256-chain:v1");

/**
 * A constant-memory commitment to the exact authenticated `e2e` records.
 *
 * WebCrypto intentionally has no streaming digest API. Hashing each
 * length-delimited record into a domain-separated SHA-256 chain avoids
 * retaining an unbounded encrypted response while still making order,
 * boundaries, duplication, and omission part of the commitment. A record is
 * appended only after the WASM E2EE context has authenticated and decrypted it.
 */
class CiphertextTranscriptCommitment {
  private state: Uint8Array | undefined;
  private records = 0;

  async append(ciphertext: string): Promise<void> {
    const encoded = CIPHERTEXT_ENCODER.encode(ciphertext);
    if (!this.state) {
      this.state = await sha256Bytes(RESPONSE_COMMITMENT_DOMAIN);
    }
    if (this.records >= 0xffff_ffff || encoded.byteLength > 0xffff_ffff) {
      throw new ChutesTransportError(
        "RESPONSE_TOO_LARGE",
        "Chutes returned too many encrypted response records to commit safely.",
      );
    }
    const frame = new Uint8Array(this.state.byteLength + 8 + encoded.byteLength);
    frame.set(this.state, 0);
    const header = new DataView(frame.buffer, this.state.byteLength, 8);
    header.setUint32(0, this.records, false);
    header.setUint32(4, encoded.byteLength, false);
    frame.set(encoded, this.state.byteLength + 8);
    this.state = await sha256Bytes(frame);
    this.records += 1;
  }

  digest(): string | undefined {
    return this.records > 0 && this.state ? formatSha256(this.state) : undefined;
  }
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
}

function formatSha256(digest: Uint8Array): string {
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha256:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

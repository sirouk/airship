export type ChutesTransportErrorCode =
  | "CANCELLED"
  | "TIMEOUT"
  | "STREAM_STALLED"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "MODEL_NOT_CONFIDENTIAL"
  | "MODEL_CAPABILITY_UNVERIFIED"
  | "MODEL_INPUT_UNSUPPORTED"
  | "NO_E2EE_INSTANCE"
  | "NONCE_CACHE_EXHAUSTED"
  | "NONCE_REJECTED"
  | "ATTESTATION_REQUIRED"
  | "ATTESTATION_FAILED"
  | "CRYPTO_ERROR"
  | "SSE_LIMIT"
  | "INVALID_SSE"
  | "STREAM_TRUNCATED"
  | "REMOTE_ERROR"
  | "INVALID_TOOL_CALL";

export type ChutesTransportOperation =
  | "model-discovery"
  | "instance-discovery"
  | "attestation"
  | "invoke";

export class ChutesTransportError extends Error {
  readonly code: ChutesTransportErrorCode;
  readonly status?: number;
  readonly detail?: string;
  readonly operation?: ChutesTransportOperation;

  constructor(
    code: ChutesTransportErrorCode,
    message: string,
    options: { status?: number; detail?: string; operation?: ChutesTransportOperation; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ChutesTransportError";
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.operation = options.operation;
  }
}

export function cancelledError(reason?: unknown) {
  return new ChutesTransportError("CANCELLED", "Chutes inference was cancelled.", { cause: reason });
}

export function errorFromAbortSignal(signal: AbortSignal): ChutesTransportError {
  return signal.reason instanceof ChutesTransportError ? signal.reason : cancelledError(signal.reason);
}

export function normalizeTransportError(error: unknown, signal?: AbortSignal): ChutesTransportError {
  if (error instanceof ChutesTransportError) return error;
  if (signal?.aborted) return errorFromAbortSignal(signal);

  if (isWasmCryptoError(error)) {
    return new ChutesTransportError("CRYPTO_ERROR", error.message, {
      cause: error,
      detail: error.code,
    });
  }
  if (error instanceof Error) {
    return new ChutesTransportError("NETWORK_ERROR", error.message || "Chutes network operation failed.", {
      cause: error,
    });
  }
  return new ChutesTransportError("NETWORK_ERROR", "Chutes network operation failed.", {
    cause: error,
  });
}

function isWasmCryptoError(value: unknown): value is Error & { code: string } {
  return (
    value instanceof Error &&
    value.name === "ChutesE2eeError" &&
    typeof (value as Error & { code?: unknown }).code === "string"
  );
}

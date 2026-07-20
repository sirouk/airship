export type RequestFailureKind = "offline" | "unreachable" | "credential" | "provider" | "unknown";

export type RequestFailure = Readonly<{ kind: RequestFailureKind; message: string }>;

type RequestLikeError = Readonly<{
  code?: unknown;
  status?: unknown;
  operation?: unknown;
  message?: unknown;
  cause?: unknown;
}>;

export function mapRequestFailure(input: Readonly<{ online: boolean; code?: string; status?: number; operation?: string }>): RequestFailure {
  if (!input.online) return { kind: "offline", message: "Offline · remote requests paused; local work remains available." };
  if (/ATTESTATION_REQUIRED|ATTESTATION_FAILED/iu.test(input.code ?? "")) {
    return { kind: "provider", message: "TEE evidence failed. Open Proof." };
  }
  if (/NONCE_REJECTED|INVALID_NONCE|NONCE_EXPIRED/iu.test(input.code ?? "")) {
    return { kind: "provider", message: "E2EE nonce rejected. No plaintext sent; retry." };
  }
  if (input.status === 401 || input.status === 403 || /AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN/iu.test(input.code ?? "")) {
    if (input.operation === "instance-discovery") {
      return { kind: "credential", message: "Endpoint discovery denied. Reconnect with chutes:invoke or an API key." };
    }
    if (input.operation === "invoke") {
      return { kind: "credential", message: "Encrypted inference denied. Reconnect, then check account and model access." };
    }
    if (input.operation === "model-discovery") {
      return { kind: "provider", message: "Public model catalog unavailable; retry later." };
    }
    return { kind: "credential", message: "Remote session rejected. Reconnect or switch API keys." };
  }
  if ((input.status ?? 0) >= 500) return { kind: "provider", message: "Chutes is unavailable. Local state was kept; retry later." };
  if (/STREAM_STALLED/iu.test(input.code ?? "")) return { kind: "unreachable", message: "Chutes stopped streaming. The partial response was kept; retry the turn." };
  if (/NETWORK|FETCH|TIMEOUT|UNREACHABLE/iu.test(input.code ?? "")) return { kind: "unreachable", message: "Provider unreachable. Check connectivity and retry; local state was kept." };
  if (/STREAM_TRUNCATED|INVALID_SSE|INVALID_RESPONSE|REMOTE_ERROR/iu.test(input.code ?? "")) return { kind: "provider", message: "Chutes returned an incomplete response. The partial response was kept; retry the turn." };
  return { kind: "unknown", message: "Request failed. Local state was kept; no remote success is assumed." };
}

/** Normalize provider, fetch, and domain failures without leaking raw response bodies. */
export function mapUnknownRequestFailure(error: unknown, online: boolean): RequestFailure {
  const value = typeof error === "object" && error !== null ? error as RequestLikeError : undefined;
  const cause = typeof value?.cause === "object" && value.cause !== null ? value.cause as RequestLikeError : undefined;
  const status = numericStatus(value?.status) ?? numericStatus(cause?.status);
  const operation = stringValue(value?.operation) ?? stringValue(cause?.operation);
  const code = [value?.code, cause?.code, error instanceof TypeError ? "NETWORK_ERROR" : undefined]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .slice(0, 512);
  return mapRequestFailure({ online, ...(code ? { code } : {}), ...(status === undefined ? {} : { status }), ...(operation ? { operation } : {}) });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 ? value : undefined;
}

function numericStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

export function observationState(observedAt: string, thresholdMs: number, now = Date.now()): Readonly<{ stale: boolean; label: string }> {
  const value = Date.parse(observedAt);
  const stale = !Number.isFinite(value) || now - value > thresholdMs;
  const time = Number.isFinite(value) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value) : "unknown time";
  return { stale, label: `${stale ? "Observed" : "Verified"} · ${time}` };
}

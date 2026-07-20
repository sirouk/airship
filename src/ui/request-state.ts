export type RequestFailureKind = "offline" | "unreachable" | "credential" | "provider" | "unknown";

export type RequestFailure = Readonly<{ kind: RequestFailureKind; message: string }>;

type RequestLikeError = Readonly<{ code?: unknown; status?: unknown; message?: unknown; cause?: unknown }>;

export function mapRequestFailure(input: Readonly<{ online: boolean; code?: string; status?: number }>): RequestFailure {
  if (!input.online) return { kind: "offline", message: "Offline · remote requests paused; local work remains available." };
  if (input.status === 401 || input.status === 403 || /AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN/iu.test(input.code ?? "")) {
    return { kind: "credential", message: "Chutes rejected this credential or its scopes. Reconnect with another credential." };
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
  const code = [value?.code, cause?.code, value?.message, cause?.message]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .slice(0, 512);
  return mapRequestFailure({ online, ...(code ? { code } : {}), ...(status === undefined ? {} : { status }) });
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

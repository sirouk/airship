export type RequestFailureKind =
  | "offline"
  | "unreachable"
  | "credential"
  | "rate-limit"
  | "billing"
  | "provider"
  | "unknown";

export type RequestFailure = Readonly<{ kind: RequestFailureKind; message: string }>;

type RequestLikeError = Readonly<{
  code?: unknown;
  status?: unknown;
  operation?: unknown;
  message?: unknown;
  cause?: unknown;
}>;

/**
 * The sentence a turn dies with, in the two registers the product already owns.
 *
 * This rendered as "TEE evidence failed. Open Proof." — an acronym the build
 * expands nowhere. Grepping all of `src` for "trusted execution",
 * "confidential comput" and "end-to-end encrypt" returned one hit, a label on
 * the Proof route, so a first-time user meeting this under a failed turn on a
 * phone had a verb, a destination, and three letters they could not resolve
 * anywhere in the product. `trust-language.ts`'s `claimLanguage` already models
 * the fix for this exact claim — a plain primary beside a technical secondary,
 * `["Protected CPU runtime", "CPU TEE"]` — so the plain word leads and the
 * acronym stays in apposition for the reader who is searching for it. The word
 * is "protected-runtime" rather than either claim's own primary because
 * ATTESTATION_FAILED covers the CPU and the accelerator lanes at once.
 *
 * Declared here rather than inline so the test can hold it against
 * `claimLanguage` without importing this module's whole failure table into the
 * shell's chunk graph.
 */
export const TEE_EVIDENCE_FAILURE = "Protected-runtime (TEE) evidence failed. Open Proof.";

export function mapRequestFailure(input: Readonly<{ online: boolean; code?: string; status?: number; operation?: string }>): RequestFailure {
  if (!input.online) return { kind: "offline", message: "Offline · remote requests paused; local work remains available." };
  if (/ATTESTATION_REQUIRED|ATTESTATION_FAILED/iu.test(input.code ?? "")) {
    return { kind: "provider", message: TEE_EVIDENCE_FAILURE };
  }
  if (/NONCE_REJECTED|INVALID_NONCE|NONCE_EXPIRED/iu.test(input.code ?? "")) {
    return { kind: "provider", message: "E2EE nonce rejected. No plaintext sent; retry." };
  }
  /*
   * The two limits a person actually reaches, before the branch that blames
   * their credential for both.
   *
   * Neither a 429 nor a spent balance had a row in this table, so both fell
   * through to "Request failed. Local state was kept" — a sentence that names
   * no cause and offers no remedy, for the two failures whose remedies are the
   * most specific in the product (wait; top up). A live 429 is a measured case,
   * not a hypothetical one (`docs/design-review/journey-complaints.md`).
   *
   * Worse, a provider that answers an exhausted balance with 403 was caught by
   * the credential branch below and told to "Reconnect or switch API keys": a
   * working credential, retyped, for a billing fact. Both are matched ahead of
   * that branch for exactly that reason, and the billing sentence says out loud
   * that the credential is not the problem.
   */
  if (input.status === 429 || /RATE[_-]?LIMIT|TOO[_-]?MANY[_-]?REQUESTS|THROTTL/iu.test(input.code ?? "")) {
    return { kind: "rate-limit", message: "Rate limit reached. Wait a moment and retry; local state was kept." };
  }
  if (input.status === 402 || /INSUFFICIENT[_-]?(?:BALANCE|CREDIT|FUNDS)|PAYMENT[_-]?REQUIRED|NO[_-]?BALANCE|OUT[_-]?OF[_-]?CREDIT/iu.test(input.code ?? "")) {
    return { kind: "billing", message: "Out of credit. Your credential still works; top up in Account, then retry." };
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

/**
 * Freshness is not a rung, so it may not borrow a rung word.
 *
 * This said "Verified · <time>" for any reading inside the budget, and `stale`
 * on the line below is the whole test: is the timestamp younger than
 * `thresholdMs`. Nothing was checked by anyone. One route away, Airship's own
 * legend defines the word it was spending — "Verified" means "The named
 * authority checked this exact claim and it held" (attestations-view.tsx) —
 * and the Account route rendered it as visible page text next to a reading that
 * is `accepted` when any ONE of four sources answered, so three endpoints could
 * have returned 403 under the word "Verified".
 *
 * "Read" states exactly what happened and claims nothing about who agreed.
 */
export function observationState(observedAt: string, thresholdMs: number, now = Date.now()): Readonly<{ stale: boolean; label: string }> {
  const value = Date.parse(observedAt);
  const stale = !Number.isFinite(value) || now - value > thresholdMs;
  const time = Number.isFinite(value) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value) : "unknown time";
  return { stale, label: `${stale ? "Observed" : "Read"} · ${time}` };
}

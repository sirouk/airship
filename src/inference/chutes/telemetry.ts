export type ChutesRateLimit = number | "unlimited";

export type ChutesInvocationTelemetry = Readonly<{
  capturedAt: string;
  invocationId?: string;
  quota?: Readonly<{
    total?: number;
    used?: number;
    remaining?: number;
  }>;
  rateLimit?: Readonly<{
    user?: ChutesRateLimit;
    chute?: number;
  }>;
  invoiceBilling?: boolean;
}>;

/**
 * Normalize the small, CORS-exposed account snapshot attached to an invocation.
 * Missing or malformed values are omitted; this never guesses account state.
 */
export function parseChutesInvocationTelemetry(
  headers: Pick<Headers, "get">,
  now = Date.now(),
): ChutesInvocationTelemetry | undefined {
  const total = nonNegativeNumber(headers.get("X-Chutes-Quota-Total"));
  const used = nonNegativeNumber(headers.get("X-Chutes-Quota-Used"));
  const remaining = nonNegativeNumber(headers.get("X-Chutes-Quota-Remaining"));
  const userRateLimit = rateLimit(headers.get("X-Chutes-RL-User"));
  const chuteRateLimit = nonNegativeNumber(headers.get("X-Chutes-RL-Chute"));
  const invocationId = clean(headers.get("X-Chutes-InvocationID"));
  const invoiceHeader = clean(headers.get("X-Chutes-Invoice-Billing"));
  const invoiceBilling = invoiceHeader === "true" ? true : invoiceHeader === "false" ? false : undefined;

  const quota = total !== undefined || used !== undefined || remaining !== undefined
    ? Object.freeze({
      ...(total !== undefined ? { total } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
    })
    : undefined;
  const rate = userRateLimit !== undefined || chuteRateLimit !== undefined
    ? Object.freeze({
      ...(userRateLimit !== undefined ? { user: userRateLimit } : {}),
      ...(chuteRateLimit !== undefined ? { chute: chuteRateLimit } : {}),
    })
    : undefined;

  if (!quota && !rate && !invocationId && invoiceBilling === undefined) return undefined;
  return Object.freeze({
    capturedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    ...(invocationId ? { invocationId } : {}),
    ...(quota ? { quota } : {}),
    ...(rate ? { rateLimit: rate } : {}),
    ...(invoiceBilling !== undefined ? { invoiceBilling } : {}),
  });
}

function nonNegativeNumber(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function rateLimit(value: string | null): ChutesRateLimit | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "inf" || normalized === "infinity" || normalized === "unlimited") return "unlimited";
  return nonNegativeNumber(normalized);
}

function clean(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

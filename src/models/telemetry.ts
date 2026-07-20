import type { ModelOperationalTelemetry } from "./types";

const MAX_RECORDS = 5_000;
const MAX_COUNT = 1_000_000_000_000;
const FRESH_MS = 15 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

class TelemetryPayloadError extends Error {
  readonly name = "CatalogPayloadError";
  constructor(readonly code: "invalid-payload" | "response-too-large", message: string) {
    super(message);
  }
}

export type ParsedUtilization = Readonly<{
  chuteId: string;
  telemetry: ModelOperationalTelemetry;
}>;

export type ParsedUtilizationCatalog = Readonly<{
  entries: readonly ParsedUtilization[];
  records: number;
  skipped: number;
}>;

export function parseUtilizationCatalog(
  value: unknown,
  referenceTimeMs = Date.now(),
): ParsedUtilizationCatalog {
  if (!Array.isArray(value)) {
    throw new TelemetryPayloadError("invalid-payload", "Chutes utilization payload must be an array.");
  }
  if (value.length > MAX_RECORDS) {
    throw new TelemetryPayloadError("response-too-large", `Chutes utilization exceeds ${MAX_RECORDS} records.`);
  }
  const entries: ParsedUtilization[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of value) {
    const entry = parseEntry(item, referenceTimeMs);
    if (!entry || seen.has(entry.chuteId)) { skipped += 1; continue; }
    seen.add(entry.chuteId);
    entries.push(entry);
  }
  entries.sort((left, right) => left.chuteId < right.chuteId ? -1 : left.chuteId > right.chuteId ? 1 : 0);
  return Object.freeze({ entries: Object.freeze(entries), records: value.length, skipped });
}

function parseEntry(value: unknown, referenceTimeMs: number): ParsedUtilization | undefined {
  if (!record(value)) return undefined;
  const chuteId = text(value.chute_id, 256);
  const timestamp = text(value.timestamp, 64);
  const observedMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!chuteId || !Number.isFinite(observedMs)) return undefined;
  const observedAt = new Date(observedMs).toISOString();
  const telemetry: ModelOperationalTelemetry = Object.freeze({
    observedAt,
    freshness: !Number.isFinite(referenceTimeMs) || observedMs > referenceTimeMs + FUTURE_TOLERANCE_MS
      ? "future" : referenceTimeMs - observedMs <= FRESH_MS ? "fresh" : "stale",
    utilization: Object.freeze(values(value, {
      current: ["utilization_current", 1], fiveMinutes: ["utilization_5m", 1],
      fifteenMinutes: ["utilization_15m", 1], oneHour: ["utilization_1h", 1],
    })),
    rateLimitRatio: Object.freeze(values(value, {
      fiveMinutes: ["rate_limit_ratio_5m", 1], fifteenMinutes: ["rate_limit_ratio_15m", 1],
      oneHour: ["rate_limit_ratio_1h", 1],
    })),
    requests: Object.freeze(values(value, {
      fiveMinutes: ["total_requests_5m", MAX_COUNT], fifteenMinutes: ["total_requests_15m", MAX_COUNT],
      oneHour: ["total_requests_1h", MAX_COUNT],
    })),
    instances: Object.freeze({
      ...values(value, {
        active: ["active_instance_count", MAX_COUNT], total: ["total_instance_count", MAX_COUNT],
        target: ["target_count", MAX_COUNT], scaleAllowance: ["scale_allowance", MAX_COUNT],
      }),
      ...(typeof value.scalable === "boolean" ? { scalable: value.scalable } : {}),
    }),
  });
  return Object.freeze({ chuteId, telemetry });
}

function values(
  source: Record<string, unknown>,
  fields: Record<string, readonly [string, number]>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [target, [name, max]] of Object.entries(fields)) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max) result[target] = value;
  }
  return result;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  const result = value.trim();
  return result && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

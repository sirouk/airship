import type {
  ChutesAccountIssue,
  ChutesAccountSnapshot,
  ChutesAccountSource,
  ChutesQuotaSummary,
  ChutesSubscriptionSummary,
  ChutesUsageSummary,
} from "./client";

export type BillingDatumStatus = "verified" | "unknown" | "unavailable" | "loading";
export type BillingDatumTone = "neutral" | "good" | "warning" | "danger";

export type BillingDatum<T> = Readonly<{
  status: BillingDatumStatus;
  tone: BillingDatumTone;
  detail: string;
  value?: T;
}>;

export function billingDatumLabel(status: BillingDatumStatus): string {
  if (status === "loading") return "Loading…";
  if (status === "unavailable") return "Unavailable";
  return "Unknown";
}

export function balanceDatum(snapshot: ChutesAccountSnapshot | undefined, loading: boolean): BillingDatum<number> {
  const balance = snapshot?.account?.balance;
  if (balance !== undefined) {
    return Object.freeze({
      status: "verified",
      tone: balance > 0 ? "good" : "danger",
      detail: "Effective USD balance reported by the Chutes account endpoint.",
      value: balance,
    });
  }
  return absentDatum(snapshot, loading, "account", snapshot?.account
    ? "The account response did not include an effective balance."
    : "Balance data was not present in the account snapshot.");
}

export function subscriptionDatum(
  snapshot: ChutesAccountSnapshot | undefined,
  loading: boolean,
): BillingDatum<ChutesSubscriptionSummary> {
  if (snapshot?.subscription) {
    return Object.freeze({
      status: "verified",
      tone: "neutral",
      detail: snapshot.subscription.active
        ? "Subscription state was reported by Chutes."
        : "Chutes reported no active subscription; payment mode is not inferred.",
      value: snapshot.subscription,
    });
  }
  return absentDatum(snapshot, loading, "subscription", "Subscription state was not present in the account snapshot.");
}

export function usageDatum(
  snapshot: ChutesAccountSnapshot | undefined,
  loading: boolean,
): BillingDatum<ChutesUsageSummary> {
  if (snapshot?.usage) {
    return Object.freeze({
      status: "verified",
      tone: "neutral",
      detail: "Usage totals were computed from the records returned for the requested UTC range.",
      value: snapshot.usage,
    });
  }
  return absentDatum(snapshot, loading, "usage", "Usage data was not present in the account snapshot.");
}

export function quotaDatum(
  snapshot: ChutesAccountSnapshot | undefined,
  loading: boolean,
): BillingDatum<ChutesQuotaSummary> {
  if (snapshot?.quotas) {
    if (snapshot.quotas.entries.length === 0) {
      return Object.freeze({
        status: "unknown",
        tone: "neutral",
        detail: "Chutes returned no quota records. An empty response is not treated as unlimited.",
        value: snapshot.quotas,
      });
    }
    return Object.freeze({
      status: "verified",
      tone: "neutral",
      detail: "Quota values were reported explicitly by Chutes.",
      value: snapshot.quotas,
    });
  }
  return absentDatum(snapshot, loading, "quotas", "Quota data was not present in the account snapshot.");
}

function absentDatum<T>(
  snapshot: ChutesAccountSnapshot | undefined,
  loading: boolean,
  source: ChutesAccountSource,
  missingDetail: string,
): BillingDatum<T> {
  const issue = sourceIssue(snapshot, source);
  if (issue) {
    return Object.freeze({ status: "unavailable", tone: "neutral", detail: issue.message });
  }
  if (loading) {
    return Object.freeze({ status: "loading", tone: "neutral", detail: `${sourceLabel(source)} telemetry is loading.` });
  }
  return Object.freeze({ status: "unknown", tone: "neutral", detail: missingDetail });
}

function sourceIssue(
  snapshot: ChutesAccountSnapshot | undefined,
  source: ChutesAccountSource,
): ChutesAccountIssue | undefined {
  return snapshot?.issues.find((issue) => issue.source === source);
}

function sourceLabel(source: ChutesAccountSource): string {
  return source === "quotas" ? "Quota" : source[0]!.toUpperCase() + source.slice(1);
}

import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  ChutesAccountSnapshot,
  ChutesSubscriptionWindow,
  ChutesUsageEntry,
} from "../billing/client";
import {
  balanceDatum,
  billingDatumLabel,
  quotaDatum,
  subscriptionDatum,
  usageDatum,
  type BillingDatumStatus,
} from "../billing/honesty";
import type { ChutesInvocationTelemetry } from "../inference/chutes";
import { OFFLINE_INLINE_REASON } from "./connectivity";
import { Icon } from "./icons";
import { mapUnknownRequestFailure, observationState } from "./request-state";

export type BillingCredentialKind = "oauth" | "api-key" | "unknown";

export function BillingView({
  accountReadable,
  online,
  credentialKind,
  credentialRevision,
  invocationTelemetry,
  loadSnapshot,
  onOpenAccess,
}: {
  accountReadable: boolean;
  online: boolean;
  credentialKind?: BillingCredentialKind;
  credentialRevision: number;
  invocationTelemetry?: ChutesInvocationTelemetry;
  loadSnapshot: (signal: AbortSignal) => Promise<ChutesAccountSnapshot>;
  onOpenAccess: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChutesAccountSnapshot>();
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!accountReadable) {
      setSnapshot(undefined);
      setFatalError(undefined);
      setLoading(false);
      return;
    }
    if (!online) {
      setFatalError(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setFatalError(undefined);
    void loadSnapshot(controller.signal).then(
      (next) => setSnapshot(next),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setFatalError(mapUnknownRequestFailure(error, online).message);
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [accountReadable, credentialRevision, online, refresh]);

  const usageEntries = useMemo(
    () => [...(snapshot?.usage?.entries ?? [])].sort((left, right) => left.bucket.localeCompare(right.bucket)),
    [snapshot?.usage?.entries],
  );
  const balanceState = balanceDatum(snapshot, loading);
  const subscriptionState = subscriptionDatum(snapshot, loading);
  const usageState = usageDatum(snapshot, loading);
  const quotaState = quotaDatum(snapshot, loading);
  const observed = snapshot ? observationState(snapshot.fetchedAt, 5 * 60_000) : undefined;

  return (
    <section class="work-view billing-view">
      <header class="page-heading billing-heading">
        <span class="eyebrow">Direct user-scoped Chutes telemetry</span>
        <h1>Account standing</h1>
        <p>See balance, provider-reported charges, subscription runway, and live limits directly from Chutes.</p>
      </header>

      <div class="panel billing-toolbar">
        <div>
          <span class={accountReadable ? "account-state ready" : "account-state"}><span />{accountReadable ? "User-scoped credential connected" : "Account telemetry unavailable"}</span>
          <small class={observed?.stale ? "billing-observation stale" : "billing-observation"}>{observed?.label ?? credentialMessage(credentialKind)}{loading && snapshot ? " · updating" : ""}</small>
        </div>
        <div>
          {online
            ? <a class="small-button" href="https://chutes.ai/app/settings/billing" target="_blank" rel="noreferrer">Manage at Chutes ↗</a>
            : <span class="small-button is-disabled" aria-disabled="true">Manage at Chutes ↗</span>}
          {accountReadable ? <button class="small-button" type="button" disabled={loading || !online} onClick={() => setRefresh((value) => value + 1)}>{loading ? "Refreshing…" : "Refresh"}</button> : null}
        </div>
      </div>

      {!online ? (
        <div class="billing-alert warning connectivity-pause" role="status" aria-live="polite">
          <Icon name="warning" />
          <div><strong>Account reads paused</strong><span>{OFFLINE_INLINE_REASON} Any values below are the last observation held in page memory.</span></div>
        </div>
      ) : null}
      {fatalError ? <div class="billing-alert error" role="alert"><Icon name="warning" /><div><strong>Account read failed</strong><span>{fatalError}</span></div></div> : null}

      {!accountReadable ? (
        <div class="panel billing-gate">
          <span class="billing-gate-mark"><Icon name="lock" size={22} /></span>
          <div>
            <span class="eyebrow">User-scoped token required</span>
            <h2>Connect your Chutes account</h2>
            <p>Connect with scoped Chutes sign-in or a direct API-key session. The credential remains held only in page memory.</p>
            <button class="primary billing-gate-action" type="button" onClick={onOpenAccess}>Connect Chutes</button>
            <details class="billing-gate-preview">
              <summary>What becomes available</summary>
              <p>Balance, subscription runway, charged usage, token totals, quota configuration, and live invocation headroom.</p>
            </details>
          </div>
        </div>
      ) : null}

      {accountReadable ? <>{snapshot?.issues.length ? (
        <div class="billing-alert warning" role="status">
          <Icon name="warning" />
          <div><strong>Partial account snapshot</strong>{snapshot.issues.map((issue) => <span key={`${issue.source}:${issue.code}`}>{issue.message}</span>)}</div>
        </div>
      ) : null}

      <div class="billing-metrics" aria-label="Account summary">
        <BillingMetric
          label="Available Chutes balance"
          value={balanceState.value === undefined ? billingDatumLabel(balanceState.status) : formatUsd(balanceState.value)}
          detail={balanceState.detail}
          tone={balanceState.tone}
        />
        <BillingMetric
          label="Subscription"
          value={subscriptionState.value
            ? subscriptionState.value.active
              ? subscriptionState.value.monthlyPrice === undefined ? "Active" : `${formatUsd(subscriptionState.value.monthlyPrice)} / mo`
              : "Inactive"
            : billingDatumLabel(subscriptionState.status)}
          detail={subscriptionDetail(subscriptionState)}
          tone={subscriptionState.tone}
        />
        <BillingMetric
          label="Charged this UTC month"
          value={usageState.value ? formatUsd(usageState.value.totalCost) : billingDatumLabel(usageState.status)}
          detail={usageState.value ? `${formatCompact(usageState.value.totalRequests)} charged requests in this range` : usageState.detail}
          tone={usageState.tone}
        />
        <BillingMetric
          label="Tokens this UTC month"
          value={usageState.value ? formatCompact(usageState.value.inputTokens + usageState.value.outputTokens) : billingDatumLabel(usageState.status)}
          detail={usageState.value ? `${formatCompact(usageState.value.inputTokens)} in · ${formatCompact(usageState.value.outputTokens)} out` : usageState.detail}
          tone={usageState.tone}
        />
      </div>

      {balanceState.status === "verified" && balanceState.value !== undefined && balanceState.value <= 0 ? (
        <div class="billing-alert warning funding-required" role="status">
          <Icon name="billing" />
          <div><strong>No available balance</strong><span>Inference beyond covered allowance may pause until the provider reports funds.</span></div>
          {online ? <a class="small-button" href="https://chutes.ai/app/settings/billing" target="_blank" rel="noreferrer">Add funds at Chutes ↗</a> : <span class="small-button is-disabled" aria-disabled="true">Add funds at Chutes ↗</span>}
        </div>
      ) : null}

      <div class="runway-grid">
        <RunwayCard
          eyebrow="Burst protection"
          title="Fixed four-hour UTC bucket"
          window={subscriptionState.value?.fourHour}
          inactive={subscriptionState.status === "verified" && subscriptionState.value?.active === false}
          sourceStatus={subscriptionState.status}
          sourceDetail={subscriptionState.detail}
        />
        <RunwayCard
          eyebrow="Covered plan usage"
          title="Subscription cycle"
          window={subscriptionState.value?.monthly}
          inactive={subscriptionState.status === "verified" && subscriptionState.value?.active === false}
          sourceStatus={subscriptionState.status}
          sourceDetail={subscriptionState.detail}
        />
        <LiveTelemetryCard telemetry={invocationTelemetry} />
      </div>

      <div class="billing-detail-grid">
        <section class="panel usage-panel">
          <div class="panel-heading"><span>Actual charged usage</span><span>{usageState.value ? `${formatDate(usageState.value.rangeStart)} → ${formatDate(usageState.value.rangeEnd)}` : billingDatumLabel(usageState.status)}</span></div>
          {usageEntries.length ? <UsageBars entries={usageEntries} /> : <div class="billing-empty"><Icon name="billing" /><strong>{usageEmptyTitle(usageState.status)}</strong><p>{usageState.status === "verified" ? "Chutes returned no usage records for this requested range; activity outside the response is not inferred." : usageState.detail}</p></div>}
          {usageEntries.length ? (
            <div class="usage-ledger" role="table" aria-label="Recent account usage">
              <div class="usage-ledger-head" role="row"><span>Date</span><span>Requests</span><span>Tokens</span><span>Charged</span></div>
              {[...usageEntries].reverse().slice(0, 10).map((entry) => (
                <div class="usage-ledger-row" role="row" key={`${entry.bucket}:${entry.chuteId ?? "all"}`}>
                  <span>{formatBucket(entry.bucket)}</span>
                  <span>{formatCompact(entry.requests)}</span>
                  <span>{formatCompact(entry.inputTokens + entry.outputTokens)}</span>
                  <strong>{formatUsd(entry.cost)}</strong>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section class="panel quota-panel">
          <div class="panel-heading"><span>Configured quotas</span><span>{quotaState.status === "verified" && quotaState.value ? `${quotaState.value.rawCount} record${quotaState.value.rawCount === 1 ? "" : "s"}` : billingDatumLabel(quotaState.status)}</span></div>
          {quotaState.status === "verified" && quotaState.value?.entries.length ? (
            <div class="quota-list">
              {quotaState.value.entries.slice(0, 10).map((quota, index) => (
                <div key={`${quota.chuteId ?? "default"}:${index}`}>
                  <span>{quota.chuteId ?? "Default"}</span>
                  <strong>{quota.quota === "unlimited" ? "Unlimited" : formatCompact(quota.quota)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div class="billing-empty compact"><Icon name="context" /><strong>{quotaEmptyTitle(quotaState.status)}</strong><p>{quotaState.detail} Per-invocation headers remain a separate live observation.</p></div>
          )}
          <div class="quota-note"><Icon name="proof" size={16} /><p>These values are unsigned account telemetry, not attestation receipts. Invocation quota headers are a pre-invocation observation.</p></div>
        </section>
      </div>
      </> : null}
    </section>
  );
}

function BillingMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "good" | "warning" | "danger" }) {
  return <div class={`panel billing-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function RunwayCard({
  eyebrow,
  title,
  window,
  inactive,
  sourceStatus,
  sourceDetail,
}: {
  eyebrow: string;
  title: string;
  window?: ChutesSubscriptionWindow;
  inactive: boolean;
  sourceStatus: BillingDatumStatus;
  sourceDetail: string;
}) {
  const uncapped = window?.uncapped === true;
  const usage = window?.usage;
  const cap = window?.cap;
  const percent = usage !== undefined && cap !== undefined && cap > 0 ? Math.min(100, (usage / cap) * 100) : undefined;
  const tone = percent === undefined ? "" : percent >= 100 ? "danger" : percent >= 80 ? "warning" : "good";
  return (
    <section class={`panel runway-card${tone ? ` ${tone}` : ""}`}>
      <span class="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {inactive ? <div class="runway-empty">Chutes reported no active subscription</div> : sourceStatus !== "verified" ? <div class="runway-empty">{sourceDetail}</div> : !window ? <div class="runway-empty">Window data unavailable</div> : (
        <>
          <div class="runway-value"><strong>{usage === undefined ? "Unknown" : formatUsd(usage)}</strong><span>{uncapped ? "used · explicitly uncapped" : cap === undefined ? "used · cap unavailable" : `of ${formatUsd(cap)} covered`}</span></div>
          <span class="runway-track" aria-label={percent === undefined ? "Usage percentage unavailable" : `${Math.round(percent)} percent used`}><span style={{ width: `${percent ?? 0}%` }} /></span>
          <div class="runway-foot"><span>{window.remaining === undefined ? (uncapped ? "No fixed cycle cap" : "Remaining unavailable") : `${formatUsd(window.remaining)} remaining`}</span><span>{window.resetAt ? `Resets ${formatDateTime(window.resetAt)}` : "Reset unavailable"}</span></div>
          {cap !== undefined && usage !== undefined && usage >= cap ? <p>Covered allowance is exhausted. Overflow capability depends on verified balance and provider billing policy.</p> : null}
        </>
      )}
    </section>
  );
}

function LiveTelemetryCard({ telemetry }: { telemetry?: ChutesInvocationTelemetry }) {
  const quota = telemetry?.quota;
  const rate = telemetry?.rateLimit;
  return (
    <section class="panel runway-card live-telemetry">
      <span class="eyebrow">Latest invocation</span>
      <h2>Live headroom</h2>
      {!telemetry ? <div class="runway-empty">Run a Chutes turn to observe headers</div> : (
        <dl>
          <div><dt>Quota remaining</dt><dd>{quota?.remaining === undefined ? "—" : formatCompact(quota.remaining)}{quota?.total === undefined ? "" : ` / ${formatCompact(quota.total)}`}</dd></div>
          <div><dt>User rate limit</dt><dd>{rate?.user === undefined ? "—" : rate.user === "unlimited" ? "Unlimited" : formatCompact(rate.user)}</dd></div>
          <div><dt>Chute rate limit</dt><dd>{rate?.chute === undefined ? "Unavailable" : formatCompact(rate.chute)}</dd></div>
          <div><dt>Observed</dt><dd>{formatDateTime(telemetry.capturedAt)}</dd></div>
        </dl>
      )}
    </section>
  );
}

function UsageBars({ entries }: { entries: ChutesUsageEntry[] }) {
  const recent = entries.slice(-64);
  const max = Math.max(...recent.map((entry) => entry.cost), 0);
  return (
    <div class="usage-bars" role="img" aria-label="Actual charged usage by hourly bucket">
      {recent.map((entry) => {
        const percent = max > 0 ? Math.max(3, (entry.cost / max) * 100) : 0;
        return <span key={`${entry.bucket}:${entry.chuteId ?? "all"}`} style={{ height: `${percent}%` }} title={`${formatBucket(entry.bucket)} · ${formatUsd(entry.cost)} · ${entry.requests} requests`} />;
      })}
    </div>
  );
}

function credentialMessage(kind?: BillingCredentialKind): string {
  if (kind === "api-key") return "Reading account standing with your cpk_ credential";
  if (kind === "unknown") return "The active credential is not a recognized OAuth user token";
  return "No user-scoped OAuth token is held in page memory";
}

function subscriptionDetail(state: ReturnType<typeof subscriptionDatum>): string {
  const subscription = state.value;
  if (!subscription || !subscription.active) return state.detail;
  if (subscription.custom === true) return "Custom subscription reported by Chutes.";
  if (subscription.custom === false) return "Public-model covered usage plan reported by Chutes.";
  return "Active subscription reported; plan type was not included.";
}

function usageEmptyTitle(status: BillingDatumStatus): string {
  if (status === "loading") return "Loading usage…";
  if (status === "unavailable") return "Usage unavailable";
  if (status === "unknown") return "Usage unknown";
  return "No usage records returned";
}

function quotaEmptyTitle(status: BillingDatumStatus): string {
  if (status === "loading") return "Loading quota data…";
  if (status === "unavailable") return "Quota data unavailable";
  return "Quota status unknown";
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatDateTime(value: string): string {
  const parsed = Date.parse(value.endsWith("Z") || /[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`);
  if (Number.isNaN(parsed)) return "Unavailable";
  return new Date(parsed).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function formatDate(value: string): string {
  const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(parsed)) return "unknown";
  return new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatBucket(value: string): string {
  const parsed = Date.parse(value.endsWith("Z") || /[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`);
  if (Number.isNaN(parsed)) return "Unknown bucket";
  return new Date(parsed).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", timeZoneName: "short" });
}

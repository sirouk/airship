import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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
import "./billing-view.css";
import { OFFLINE_INLINE_REASON } from "./connectivity";
import { Icon } from "./icons";
import { Metric, MetricStrip, metricQuantity } from "./metric-strip";
import { Popover } from "./popover";
import { mapUnknownRequestFailure, observationState } from "./request-state";
import { RouteHeader } from "./route-header";
import { Seal } from "./seal";

export type BillingCredentialKind = "oauth" | "api-key" | "unknown";

export type BillingProviderId = "chutes" | "openai" | "anthropic" | "xai";
export type BillingProviderConnectionState = "connected" | "not-connected" | "unavailable";

export type BillingProviderObservation = Readonly<
  | { status: "observed"; value: string; detail?: string; observedAt?: string }
  | { status: "not-provided"; detail?: string }
  | { status: "unavailable"; detail?: string }
>;

export type BillingProviderAccountLink = Readonly<
  | { status: "observed"; href: string; label?: string }
  | { status: "not-provided"; detail?: string }
  | { status: "unavailable"; detail?: string }
>;

/**
 * Presentation-only provider inventory. It deliberately has no credential,
 * token, scope, endpoint, or raw-header field; the Account route never gains
 * authority to call another provider by receiving this value.
 */
export type BillingProviderInventoryEntry = Readonly<{
  providerId: BillingProviderId;
  state: BillingProviderConnectionState;
  connectionDetail?: string;
  quota?: BillingProviderObservation;
  usage?: BillingProviderObservation;
  reset?: BillingProviderObservation;
  accountLink?: BillingProviderAccountLink;
  observedAt?: string;
}>;

export type BillingProviderDefinition = Readonly<{
  id: BillingProviderId;
  label: "Chutes" | "OpenAI" | "Anthropic" | "xAI";
}>;

export const BILLING_PROVIDERS: readonly BillingProviderDefinition[] = Object.freeze([
  Object.freeze({ id: "chutes", label: "Chutes" }),
  Object.freeze({ id: "openai", label: "OpenAI" }),
  Object.freeze({ id: "anthropic", label: "Anthropic" }),
  Object.freeze({ id: "xai", label: "xAI" }),
]);

export type ChutesAccountIdentityPresentation = Readonly<{
  username: string;
  userId: string;
}>;

export function chutesAccountIdentityPresentation(
  snapshot: ChutesAccountSnapshot | undefined,
  loading: boolean,
): ChutesAccountIdentityPresentation {
  const absent = loading && !snapshot ? "Loading…" : snapshot?.account ? "Not provided" : "Unavailable";
  return Object.freeze({
    username: boundedDisplayText(snapshot?.account?.username, 256) ?? absent,
    userId: boundedDisplayText(snapshot?.account?.userId, 512) ?? absent,
  });
}

export function billingProviderDatumLabel(
  observation: BillingProviderObservation | undefined,
  connectionState: BillingProviderConnectionState,
): string {
  if (observation?.status === "observed") {
    return boundedDisplayText(observation.value, 512) ?? "Unavailable";
  }
  if (observation?.status === "not-provided") return "Not provided";
  if (observation?.status === "unavailable") return "Unavailable";
  return connectionState === "connected" ? "Not provided" : "Unavailable";
}

export function resolveBillingProviderInventory(
  entries: readonly BillingProviderInventoryEntry[] | undefined,
  chutesConnected: boolean,
): readonly BillingProviderInventoryEntry[] {
  const supplied = new Map<BillingProviderId, BillingProviderInventoryEntry>();
  for (const entry of entries ?? []) {
    if (!BILLING_PROVIDERS.some((provider) => provider.id === entry.providerId) || supplied.has(entry.providerId)) continue;
    supplied.set(entry.providerId, entry);
  }
  return Object.freeze(BILLING_PROVIDERS.map((provider) => {
    const entry = supplied.get(provider.id);
    return Object.freeze({
      providerId: provider.id,
      state: provider.id === "chutes"
        ? chutesConnected ? "connected" as const : "not-connected" as const
        : entry?.state ?? "unavailable" as const,
      ...(entry?.connectionDetail ? { connectionDetail: entry.connectionDetail } : {}),
      ...(entry?.quota ? { quota: entry.quota } : {}),
      ...(entry?.usage ? { usage: entry.usage } : {}),
      ...(entry?.reset ? { reset: entry.reset } : {}),
      ...(entry?.accountLink ? { accountLink: entry.accountLink } : {}),
      ...(entry?.observedAt ? { observedAt: entry.observedAt } : {}),
    });
  }));
}

/** The em dash a metric shows when nothing has been read. It is not a zero. */
const NOT_READ = "—";

export function BillingView({
  accountReadable,
  online,
  credentialKind,
  credentialRevision,
  invocationTelemetry,
  providerInventory,
  loadSnapshot,
  onOpenAccess,
}: {
  accountReadable: boolean;
  online: boolean;
  credentialKind?: BillingCredentialKind;
  credentialRevision: number;
  invocationTelemetry?: ChutesInvocationTelemetry;
  providerInventory?: readonly BillingProviderInventoryEntry[];
  loadSnapshot: (signal: AbortSignal) => Promise<ChutesAccountSnapshot>;
  onOpenAccess: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChutesAccountSnapshot>();
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<BillingProviderId>("chutes");
  /**
   * The bucket the reader is pointing at, in either representation.
   *
   * The strip and the ledger print the same ten buckets with no relation
   * between them, so a bar was unreadable and a row was unplaceable. One piece
   * of state binds them: the chart and the table are two views of one
   * selection, not two tables.
   */
  const [highlight, setHighlight] = useState<string>();

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
  const subscriptionInactive = subscriptionState.status === "verified" && subscriptionState.value?.active === false;
  const quota = invocationTelemetry?.quota;
  const providers = useMemo(
    () => resolveBillingProviderInventory(providerInventory, accountReadable),
    [providerInventory, accountReadable],
  );
  const selectedInventory = providers.find((provider) => provider.providerId === selectedProvider)!;
  const selectedDefinition = BILLING_PROVIDERS.find((provider) => provider.id === selectedProvider)!;
  const chutesIdentity = chutesAccountIdentityPresentation(snapshot, loading);

  return (
    <section class="work-view billing-view">
      <RouteHeader
        routeId="account"
        density="tool"
        title="Account standing"
        eyebrow="Chutes telemetry and provider inventory"
        description="Review rich Chutes account telemetry and credential-free observations supplied for other connected providers."
        status={selectedProvider === "chutes" && accountReadable ? (
          /* The 64px `.billing-toolbar` band held one status line and one
             external link. The status line is this chip — a real seal state
             rather than a grey dot, with the freshness reading and the
             credential sentence in full inside it. */
          <Popover
            class="billing-credential-chip"
            heading="Account telemetry"
            label={`Account telemetry. ${observed?.stale ? "Stale observation" : "Connected"}. Opens the credential kind and when this reading was taken.`}
            trigger={<Seal state={observed?.stale ? "stale" : "verified"} density="chip" label={observed?.stale ? "Stale reading" : "Connected"} />}
          >
            <p><strong>User-scoped credential connected</strong></p>
            <p>{observed?.label ?? credentialMessage(credentialKind)}{loading && snapshot ? " · updating" : ""}</p>
            <p>{credentialMessage(credentialKind)}</p>
          </Popover>
        ) : null}
        actions={selectedProvider === "chutes" && accountReadable ? (
          <>
            {online
              ? <a class="small-button" href="https://chutes.ai/app/settings/billing" target="_blank" rel="noreferrer">Manage at Chutes ↗</a>
              : <span class="small-button is-disabled" aria-disabled="true">Manage at Chutes ↗</span>}
            <button class="small-button" type="button" disabled={loading || !online} onClick={() => setRefresh((value) => value + 1)}>{loading ? "Refreshing…" : "Refresh"}</button>
          </>
        ) : null}
      />

      <BillingProviderTabs
        providers={providers}
        selected={selectedProvider}
        onSelect={setSelectedProvider}
      />

      {selectedProvider === "chutes" ? <div
        class="billing-provider-panel"
        id="billing-provider-panel-chutes"
        role="tabpanel"
        aria-labelledby="billing-provider-tab-chutes"
      >
      {!online ? (
        <div class="billing-alert warning connectivity-pause" role="status" aria-live="polite">
          <Icon name="warning" />
          <div><strong>Account reads paused</strong><span>{OFFLINE_INLINE_REASON} Any values below are the last observation held in page memory.</span></div>
        </div>
      ) : null}
      {fatalError ? <div class="billing-alert error" role="alert"><Icon name="warning" /><div><strong>Account read failed</strong><span>{fatalError}</span></div></div> : null}

      {!accountReadable ? (
        /*
         * Not-yet-connected is a default, not a fault.
         *
         * This branch used to state one fact five times — a grey dot reading
         * "Account telemetry unavailable", an eyebrow "USER-SCOPED TOKEN
         * REQUIRED", a heading, and two near-verbatim page-memory sentences
         * 110px apart — in Airship's own failure grammar. The sentence that
         * carries the credential contract is kept word for word; what goes is
         * the repetition and the alarm.
         */
        <div class="billing-gate panel">
          <span class="billing-gate-mark"><Icon name="lock" size={22} /></span>
          <div>
            <h2>Not connected yet</h2>
            <p>Connect with scoped Chutes sign-in or a direct API-key session. The credential remains held only in page memory.</p>
            <div class="billing-gate-actions">
              <button class="primary billing-gate-action" type="button" onClick={onOpenAccess}>Connect Chutes</button>
              {online
                ? <a class="billing-gate-link" href="https://chutes.ai/app/settings/billing" target="_blank" rel="noreferrer">Manage at Chutes ↗</a>
                : <span class="billing-gate-link is-disabled" aria-disabled="true">Manage at Chutes ↗</span>}
            </div>
          </div>
          {/* `What becomes available` promised a list in prose that the header
              had already promised in different words. The same six things are
              named here as the labelled shape they arrive in, each holding an
              em dash — which states the non-claim rather than describing it. */}
          <div class="billing-gate-preview">
            <MetricStrip label="What becomes available" class="billing-metric-strip">
              <Metric label="Available Chutes balance" value={metricQuantity(NOT_READ)} />
              <Metric label="Subscription" value={metricQuantity(NOT_READ)} />
              <Metric label="Charged this UTC month" value={metricQuantity(NOT_READ)} />
              <Metric label="Tokens this UTC month" value={metricQuantity(NOT_READ)} />
              <Metric label="Live headroom" value={metricQuantity(NOT_READ)} caption="quota configuration and per-invocation headroom" />
            </MetricStrip>
            <p class="billing-gate-preview-note">Nothing is read from Chutes until you connect.</p>
          </div>
        </div>
      ) : null}

      {accountReadable ? <>{snapshot?.issues.length ? (
        <div class="billing-alert warning" role="status">
          <Icon name="warning" />
          <div><strong>Partial account snapshot</strong>{snapshot.issues.map((issue) => <span key={`${issue.source}:${issue.code}`}>{issue.message}</span>)}</div>
        </div>
      ) : null}

      <section class="panel billing-account-identity" aria-label="Connected Chutes account identity">
        <div class="panel-heading"><span>Connected Chutes account</span><span>{observed?.label ?? "Account observation unavailable"}</span></div>
        <dl>
          <div><dt>Username</dt><dd>{chutesIdentity.username}</dd></div>
          <div><dt>User ID</dt><dd>{chutesIdentity.userId}</dd></div>
        </dl>
      </section>

      <MetricStrip label="Account summary" class="billing-metric-strip">
        <Metric
          label="Available Chutes balance"
          value={metricQuantity(balanceState.value === undefined ? billingDatumLabel(balanceState.status) : formatUsd(balanceState.value, "headline"))}
          caption={balanceState.value === undefined
            ? balanceState.detail
            /* The wallet reads as money at two places; the four-decimal figure
               the endpoint actually returned is never lost, it is stated here
               in full. */
            : `${balanceState.detail} Exactly ${formatUsd(balanceState.value, "ledger")}.`}
        />
        <Metric
          label="Subscription"
          value={metricQuantity(subscriptionState.value
            ? subscriptionState.value.active
              ? subscriptionState.value.monthlyPrice === undefined ? "Active" : `${formatUsd(subscriptionState.value.monthlyPrice, "headline")} / mo`
              : "Inactive"
            : billingDatumLabel(subscriptionState.status))}
          caption={subscriptionDetail(subscriptionState)}
        />
        <Metric
          label="Charged this UTC month"
          value={metricQuantity(usageState.value ? formatUsd(usageState.value.totalCost, "headline") : billingDatumLabel(usageState.status))}
          caption={usageState.value ? `${formatCompact(usageState.value.totalRequests)} charged requests in this range` : usageState.detail}
        />
        <Metric
          label="Tokens this UTC month"
          value={metricQuantity(usageState.value ? formatCompact(usageState.value.inputTokens + usageState.value.outputTokens) : billingDatumLabel(usageState.status))}
          caption={usageState.value ? `${formatCompact(usageState.value.inputTokens)} in · ${formatCompact(usageState.value.outputTokens)} out` : usageState.detail}
        />
        {/* Live headroom is not a subscription fact and no longer sits in a grid
            gated on one. It is a figure, so it is a metric. */}
        <Metric
          label="Live headroom"
          value={metricQuantity(quota?.remaining === undefined
            ? NOT_READ
            : `${formatCompact(quota.remaining)}${quota.total === undefined ? "" : ` / ${formatCompact(quota.total)}`}`)}
          caption={invocationTelemetry ? `observed ${formatDateTime(invocationTelemetry.capturedAt)}` : "Run a Chutes turn to observe headers"}
        />
      </MetricStrip>

      {/* The other three header facts stay visible rather than moving into a
          tooltip on the tile above. */}
      <p class="billing-headroom-facts">
        <span>Latest invocation</span>
        <span>User rate limit {invocationTelemetry?.rateLimit?.user === undefined ? NOT_READ : invocationTelemetry.rateLimit.user === "unlimited" ? "Unlimited" : formatCompact(invocationTelemetry.rateLimit.user)}</span>
        {/* Both limits are absent for the same reason — the header was not on
            the last invocation. "Unavailable" asserted that Chutes has no such
            figure; the em dash states the non-claim the other three cells
            already state. One absence, one word. */}
        <span>Chute rate limit {invocationTelemetry?.rateLimit?.chute === undefined ? NOT_READ : formatCompact(invocationTelemetry.rateLimit.chute)}</span>
        <span>Observed {invocationTelemetry ? formatDateTime(invocationTelemetry.capturedAt) : NOT_READ}</span>
      </p>

      {balanceState.status === "verified" && balanceState.value !== undefined && balanceState.value <= 0 ? (
        <div class="billing-alert warning funding-required" role="status">
          <Icon name="billing" />
          <div><strong>No available balance</strong><span>Inference beyond covered allowance may pause until the provider reports funds.</span></div>
          {online ? <a class="small-button" href="https://chutes.ai/app/settings/billing" target="_blank" rel="noreferrer">Add funds at Chutes ↗</a> : <span class="small-button is-disabled" aria-disabled="true">Add funds at Chutes ↗</span>}
        </div>
      ) : null}

      {/*
        * For an account with no plan — the common case — the runway triptych
        * was 205px (26% of a 900px viewport) of three empty cards printing
        * "Chutes reported no active subscription" three times inside 200px. The
        * windows fact is stated once here; the provider's own sentence stays on
        * the Subscription metric above, where the datum lives.
        */}
      {subscriptionInactive ? (
        <div class="runway-inactive panel">
          <Seal state="none" density="chip" label="Subscription · Inactive" />
          <p>Burst and cycle windows are not published for inactive plans.</p>
          {online
            ? <a class="small-button" href="https://chutes.ai/app/settings/billing" target="_blank" rel="noreferrer">Add a plan at Chutes ↗</a>
            : <span class="small-button is-disabled" aria-disabled="true">Add a plan at Chutes ↗</span>}
        </div>
      ) : (
        <div class="runway-grid">
          <RunwayCard
            eyebrow="Burst protection"
            title="Fixed four-hour UTC bucket"
            window={subscriptionState.value?.fourHour}
            inactive={false}
            sourceStatus={subscriptionState.status}
            sourceDetail={subscriptionState.detail}
          />
          <RunwayCard
            eyebrow="Covered plan usage"
            title="Subscription cycle"
            window={subscriptionState.value?.monthly}
            inactive={false}
            sourceStatus={subscriptionState.status}
            sourceDetail={subscriptionState.detail}
          />
        </div>
      )}

      <div class="billing-detail-grid">
        <section class="panel usage-panel">
          <div class="panel-heading">
            <span>Actual charged usage</span>
            <span>{usageState.value ? `${formatDate(usageState.value.rangeStart)} → ${formatDate(usageState.value.rangeEnd)}` : billingDatumLabel(usageState.status)}</span>
          </div>
          {usageEntries.length ? <UsageChart entries={usageEntries} highlight={highlight} onHighlight={setHighlight} /> : <div class="billing-empty"><Icon name="billing" /><strong>{usageEmptyTitle(usageState.status)}</strong><p>{usageState.status === "verified" ? "Chutes returned no usage records for this requested range; activity outside the response is not inferred." : usageState.detail}</p></div>}
          {usageEntries.length ? (
            <div class="usage-ledger" role="table" aria-label="Recent account usage">
              <div class="usage-ledger-head" role="row"><span>Date</span><span>Requests</span><span>Tokens</span><span>Charged</span></div>
              {[...usageEntries].reverse().slice(0, 10).map((entry) => (
                <div
                  class="usage-ledger-row"
                  role="row"
                  key={`${entry.bucket}:${entry.chuteId ?? "all"}`}
                  data-highlight={entry.bucket === highlight ? "true" : undefined}
                  onPointerEnter={() => setHighlight(entry.bucket)}
                  onPointerLeave={() => setHighlight(undefined)}
                >
                  <span>{formatBucket(entry.bucket)}</span>
                  <span>{formatCompact(entry.requests)}</span>
                  <span>{formatCompact(entry.inputTokens + entry.outputTokens)}</span>
                  <strong>{formatUsd(entry.cost, "ledger")}</strong>
                </div>
              ))}
              {/* The table capped at ten rows and said so nowhere. */}
              <p class="usage-ledger-foot">Showing the {Math.min(10, usageEntries.length)} most recent of {usageEntries.length} bucket{usageEntries.length === 1 ? "" : "s"}.</p>
            </div>
          ) : null}
        </section>

        <section class="panel quota-panel">
          <div class="panel-heading"><span>Configured quotas</span><span>{quotaState.status === "verified" && quotaState.value ? `${quotaState.value.rawCount} record${quotaState.value.rawCount === 1 ? "" : "s"}` : billingDatumLabel(quotaState.status)}</span></div>
          {quotaState.status === "verified" && quotaState.value?.entries.length ? (
            <div class="quota-list">
              {quotaState.value.entries.slice(0, 10).map((quotaEntry, index) => (
                <div key={`${quotaEntry.chuteId ?? "default"}:${index}`}>
                  <span>{quotaEntry.chuteId ?? "Default"}</span>
                  <strong>{quotaEntry.quota === "unlimited" ? "Unlimited" : formatCompact(quotaEntry.quota)}</strong>
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
      </div> : (
        <BillingProviderInventoryPanel
          provider={selectedDefinition}
          inventory={selectedInventory}
        />
      )}
    </section>
  );
}

function BillingProviderTabs({
  providers,
  selected,
  onSelect,
}: {
  providers: readonly BillingProviderInventoryEntry[];
  selected: BillingProviderId;
  onSelect: (provider: BillingProviderId) => void;
}) {
  const tablist = useRef<HTMLDivElement>(null);

  function selectAt(index: number) {
    const next = providers[(index + providers.length) % providers.length];
    if (!next) return;
    onSelect(next.providerId);
    tablist.current
      ?.querySelector<HTMLButtonElement>(`#billing-provider-tab-${next.providerId}`)
      ?.focus();
  }

  return (
    <div
      class="billing-provider-tabs"
      ref={tablist}
      role="tablist"
      aria-label="Account providers"
      onKeyDown={(event) => {
        const current = providers.findIndex((provider) => provider.providerId === selected);
        if (event.key === "ArrowRight") { event.preventDefault(); selectAt(current + 1); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); selectAt(current - 1); }
        else if (event.key === "Home") { event.preventDefault(); selectAt(0); }
        else if (event.key === "End") { event.preventDefault(); selectAt(providers.length - 1); }
      }}
    >
      {providers.map((inventory) => {
        const provider = BILLING_PROVIDERS.find((candidate) => candidate.id === inventory.providerId)!;
        const active = provider.id === selected;
        return (
          <button
            class="billing-provider-tab"
            id={`billing-provider-tab-${provider.id}`}
            key={provider.id}
            type="button"
            role="tab"
            aria-controls={`billing-provider-panel-${provider.id}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-state={inventory.state}
            onClick={() => onSelect(provider.id)}
          >
            <strong>{provider.label}</strong>
            <span>{providerConnectionLabel(inventory.state)}</span>
          </button>
        );
      })}
    </div>
  );
}

function BillingProviderInventoryPanel({
  provider,
  inventory,
}: {
  provider: BillingProviderDefinition;
  inventory: BillingProviderInventoryEntry;
}) {
  const accountLink = safeBillingProviderAccountLink(inventory.accountLink);
  const connectionDetail = boundedDisplayText(inventory.connectionDetail, 768) ?? (
    inventory.state === "connected"
      ? "Connected state was supplied by the host. This view did not call the provider API."
      : inventory.state === "not-connected"
        ? "No connected account is currently represented in this inventory."
        : "Connection state was not supplied to this view."
  );
  const accountLinkStatus = inventory.accountLink?.status === "not-provided"
    ? "Not provided"
    : inventory.accountLink?.status === "unavailable"
      ? "Unavailable"
      : inventory.accountLink?.status === "observed"
        ? "Unavailable"
        : inventory.state === "connected" ? "Not provided" : "Unavailable";
  const observedAt = inventory.observedAt
    ? formatDateTime(inventory.observedAt)
    : inventory.state === "connected" ? "Not provided" : "Unavailable";

  return (
    <section
      class="panel billing-provider-inventory"
      id={`billing-provider-panel-${provider.id}`}
      role="tabpanel"
      aria-labelledby={`billing-provider-tab-${provider.id}`}
    >
      <header class="billing-provider-inventory__header">
        <div>
          <span class="eyebrow">Provider account inventory</span>
          <h2>{provider.label}</h2>
        </div>
        <span class="billing-provider-state" data-state={inventory.state}>{providerConnectionLabel(inventory.state)}</span>
      </header>
      <p class="billing-provider-inventory__detail">{connectionDetail}</p>

      <dl class="billing-provider-data">
        <ProviderInventoryDatum label="Quota" observation={inventory.quota} connectionState={inventory.state} />
        <ProviderInventoryDatum label="Usage" observation={inventory.usage} connectionState={inventory.state} />
        <ProviderInventoryDatum label="Reset" observation={inventory.reset} connectionState={inventory.state} />
        <div>
          <dt>Account management</dt>
          <dd>{accountLink
            ? <a href={accountLink.href} target="_blank" rel="noreferrer">{accountLink.label} ↗</a>
            : accountLinkStatus}</dd>
          {inventory.accountLink && "detail" in inventory.accountLink && boundedDisplayText(inventory.accountLink.detail, 512)
            ? <small>{boundedDisplayText(inventory.accountLink.detail, 512)}</small>
            : null}
        </div>
      </dl>

      <p class="billing-provider-observed"><span>Inventory observed</span><strong>{observedAt}</strong></p>
    </section>
  );
}

function ProviderInventoryDatum({
  label,
  observation,
  connectionState,
}: {
  label: string;
  observation?: BillingProviderObservation;
  connectionState: BillingProviderConnectionState;
}) {
  const detail = observation && "detail" in observation
    ? boundedDisplayText(observation.detail, 512)
    : undefined;
  const observedAt = observation?.status === "observed" && observation.observedAt
    ? formatDateTime(observation.observedAt)
    : undefined;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{billingProviderDatumLabel(observation, connectionState)}</dd>
      {detail ? <small>{detail}</small> : observedAt ? <small>Observed {observedAt}</small> : null}
    </div>
  );
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
          <div class="runway-value"><strong>{usage === undefined ? "Unknown" : formatUsd(usage, "ledger")}</strong><span>{uncapped ? "used · explicitly uncapped" : cap === undefined ? "used · cap unavailable" : `of ${formatUsd(cap, "ledger")} covered`}</span></div>
          <span class="runway-track" aria-label={percent === undefined ? "Usage percentage unavailable" : `${Math.round(percent)} percent used`}><span style={{ width: `${percent ?? 0}%` }} /></span>
          <div class="runway-foot"><span>{window.remaining === undefined ? (uncapped ? "No fixed cycle cap" : "Remaining unavailable") : `${formatUsd(window.remaining, "ledger")} remaining`}</span><span>{window.resetAt ? `Resets ${formatDateTime(window.resetAt)}` : "Reset unavailable"}</span></div>
          {cap !== undefined && usage !== undefined && usage >= cap ? <p>Covered allowance is exhausted. Overflow capability depends on verified balance and provider billing policy.</p> : null}
        </>
      )}
    </section>
  );
}

/**
 * The usage strip, with the two things a chart has to have to be one.
 *
 * It rendered up to 64 bars with no scale, no baseline and a `Math.max(3, …)`
 * floor that drew fourteen different buckets as identical stubs — a chart that
 * misrepresents its own data at the low end. It was also `role="img"` with the
 * per-bar figures reachable only by hovering, which a keyboard cannot do. Each
 * bar is now a button carrying exactly the string that used to be its `title`.
 */
export function UsageChart({ entries, highlight, onHighlight }: {
  entries: readonly ChutesUsageEntry[];
  highlight?: string;
  onHighlight?: (bucket: string | undefined) => void;
}) {
  const recent = entries.slice(-64);
  const max = Math.max(...recent.map((entry) => entry.cost), 0);
  const first = recent[0];
  const middle = recent[Math.floor((recent.length - 1) / 2)];
  const last = recent[recent.length - 1];
  const strip = useRef<HTMLDivElement>(null);
  // Roving tabindex: 64 bars must not become 64 tab stops between the chart
  // and the table under it. One stop enters the group; the arrows walk it.
  const [active, setActive] = useState(0);

  function move(next: number) {
    const index = Math.max(0, Math.min(recent.length - 1, next));
    setActive(index);
    onHighlight?.(recent[index]?.bucket);
    strip.current?.querySelectorAll<HTMLButtonElement>(".usage-bar")[index]?.focus();
  }

  return (
    <div class="usage-chart">
      <div class="usage-chart__scale" aria-hidden="true">
        <span>{formatUsd(max, "headline")}</span>
        <span>$0</span>
      </div>
      <div
        class="usage-bars"
        ref={strip}
        role="group"
        aria-label="Actual charged usage by hourly bucket"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") { event.preventDefault(); move(active + 1); }
          else if (event.key === "ArrowLeft") { event.preventDefault(); move(active - 1); }
          else if (event.key === "Home") { event.preventDefault(); move(0); }
          else if (event.key === "End") { event.preventDefault(); move(recent.length - 1); }
        }}
      >
        {recent.map((entry, index) => {
          // A one-percent floor keeps a non-zero bucket visible without
          // flattening fourteen different values into the same stub.
          const percent = max > 0 ? Math.max(1, (entry.cost / max) * 100) : 0;
          const label = `${formatBucket(entry.bucket)} · ${formatUsd(entry.cost, "ledger")} · ${entry.requests} requests`;
          return (
            <button
              class="usage-bar"
              type="button"
              key={`${entry.bucket}:${entry.chuteId ?? "all"}`}
              aria-label={label}
              title={label}
              tabIndex={index === active ? 0 : -1}
              data-highlight={entry.bucket === highlight ? "true" : undefined}
              onFocus={() => { setActive(index); onHighlight?.(entry.bucket); }}
              onPointerEnter={() => onHighlight?.(entry.bucket)}
              onPointerLeave={() => onHighlight?.(undefined)}
            >
              <span style={{ height: `${percent}%` }} />
            </button>
          );
        })}
      </div>
      <div class="usage-chart__axis" aria-hidden="true">
        <span>{first ? formatDate(first.bucket) : ""}</span>
        <span>{middle ? formatDate(middle.bucket) : ""}</span>
        <span>{last ? formatDate(last.bucket) : ""}</span>
      </div>
    </div>
  );
}

function credentialMessage(kind?: BillingCredentialKind): string {
  if (kind === "api-key") return "Reading account standing with your cpk_ credential";
  if (kind === "unknown") return "The active credential is not a recognized OAuth user token";
  // Stating "no OAuth token is held" while an OAuth token is what is holding
  // this route open was a false sentence waiting for a slow response to show
  // it. The absence sentence is now only said when the credential is absent.
  if (kind === "oauth") return "Reading account standing with your scoped Chutes user token";
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

function providerConnectionLabel(state: BillingProviderConnectionState): string {
  if (state === "connected") return "Connected";
  if (state === "not-connected") return "Not connected";
  return "Unavailable";
}

export function safeBillingProviderAccountLink(
  link: BillingProviderAccountLink | undefined,
): Readonly<{ href: string; label: string }> | undefined {
  if (link?.status !== "observed") return undefined;
  const href = boundedDisplayText(link.href, 2_048);
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    return Object.freeze({
      href,
      label: boundedDisplayText(link.label, 128) ?? "Manage account",
    });
  } catch {
    return undefined;
  }
}

function boundedDisplayText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxLength);
}

/**
 * Two money formats, because a wallet and a ledger are two different reads.
 *
 * One formatter with `maximumFractionDigits: 4` rendered the balance as
 * `$46.2054` — a token price, not a balance — and produced `$0.2871`, `$0.08`,
 * `$0.0823` in adjacent ledger rows, so nothing aligned on the decimal point.
 * `headline` rounds for reading; `ledger` pads to a fixed width for scanning.
 * The exact figure is never lost: the balance metric prints it in its caption.
 */
export function formatUsd(value: number, mode: "headline" | "ledger"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: mode === "ledger" ? 4 : 2,
    maximumFractionDigits: mode === "ledger" ? 4 : 2,
  }).format(value);
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

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  ChutesAccountSnapshot,
  ChutesSubscriptionWindow,
  ChutesUsageEntry,
  ChutesUsageSummary,
} from "../billing/client";
import {
  balanceDatum,
  billingDatumLabel,
  quotaDatum,
  subscriptionDatum,
  usageDatum,
  USAGE_BOUNDED_READ_NOTE,
  type BillingDatumStatus,
} from "../billing/honesty";
import type { ChutesInvocationTelemetry } from "../inference/chutes";
import "./billing-view.css";
import { BrandLogo, type BrandLogoName } from "./brand-icons";
import { installEgressRecorder } from "./connect/egress-record";
import { OFFLINE_INLINE_REASON } from "./connectivity";
import { Icon } from "./icons";
import { formatInstant } from "./instant-format";
import { Metric, MetricStrip, metricQuantity } from "./metric-strip";
import { destinationLabel } from "./navigation-model";
import { formatCompactCount, formatCount, formatUsd } from "./number-format";
import { Popover } from "./popover";
import { mapUnknownRequestFailure, observationState } from "./request-state";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import { nextTabId } from "./tabs";

export type BillingCredentialKind = "oauth" | "api-key" | "unknown";

export type BillingProviderId = "chutes" | "openai" | "anthropic" | "xai";
/**
 * `rejected` is a fourth state because "a credential is held" and "the provider
 * took it" are two facts, and the tab strip is the only place the second one is
 * readable from another provider's panel. Collapsing it into `not-connected`
 * would deny the held credential; collapsing it into `connected` is the defect.
 */
export type BillingProviderConnectionState = "connected" | "not-connected" | "rejected" | "unavailable";

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
  /**
   * Who the host observed this provider to be authenticated as — a display
   * identity only, and modelled as an observation like every other field here.
   * Without a slot for it the panel could only be silent about identity, which
   * is unavailable-by-omission: a host that did observe one had nowhere to put
   * it, and a reader could not tell the two apart.
   */
  identity?: BillingProviderObservation;
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

/**
 * The mark that sits beside a provider's name.
 *
 * A four-row tab strip of pure text made a reader parse three similar words to
 * find the one they wanted; a silhouette is recognised before it is read. The
 * map is exhaustive over `BillingProviderId`, so adding a provider without
 * giving it a mark does not compile — which is the only way this stays a
 * property of the provider list rather than of one component that remembered.
 */
export const BILLING_PROVIDER_ICONS: Readonly<Record<BillingProviderId, BrandLogoName>> = Object.freeze({
  chutes: "chutes",
  openai: "openai",
  anthropic: "anthropic",
  xai: "xai",
});

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

/**
 * Whether Chutes accepted the credential — which is a different question from
 * how old the reading is.
 */
export type ChutesAccountAcceptance = "accepted" | "rejected" | "refused";

/**
 * Acceptance, read from what the sources actually returned.
 *
 * The header chip used to bind to `fetchedAt`, which this client stamps whether
 * or not a single source answered, so four consecutive 401s rendered
 * "Connected · Verified" over an empty page. Freshness cannot carry acceptance:
 * a snapshot's age says when the attempt happened, not that it succeeded.
 *
 * A source that returned a value is proof the credential was accepted, so any
 * value at all keeps the reading "accepted" and the existing partial grammar —
 * a scope-shaped 403 on one endpoint beside three good reads is a partial
 * snapshot, not a rejected credential. Only when nothing was read does the
 * refusal status matter, and then it separates an authorization refusal from a
 * transient fault so the panel never blames a credential for a 503.
 */
export function chutesAccountAcceptance(snapshot: ChutesAccountSnapshot): ChutesAccountAcceptance {
  if (snapshot.account ?? snapshot.subscription ?? snapshot.usage ?? snapshot.quotas) return "accepted";
  return snapshot.issues.some((issue) => issue.status === 401 || issue.status === 403) ? "rejected" : "refused";
}

/**
 * The header chip, which may only say "Connected" once something was read.
 *
 * `acceptance` is undefined before the first snapshot resolves; the age-driven
 * stale/verified split is preserved for every reading that produced a value.
 */
export function chutesAccountChip(
  acceptance: ChutesAccountAcceptance | undefined,
  stale: boolean,
): Readonly<{ state: SealState; label: string; headline: string }> {
  if (acceptance === "rejected") {
    return Object.freeze({
      state: "none" as const,
      label: "Credential not accepted",
      headline: "Chutes refused this credential",
    });
  }
  if (acceptance === "refused") {
    return Object.freeze({
      state: "none" as const,
      label: "No account data read",
      headline: "No account source returned a value",
    });
  }
  return Object.freeze({
    state: stale ? "stale" as const : "verified" as const,
    label: stale ? "Stale reading" : "Connected",
    headline: "User-scoped credential connected",
  });
}

/**
 * The freshness line, worded for what actually happened.
 *
 * `observationState` says "Read · <time>", which is a claim about the age of an
 * answer. When no source answered there is no answer to be fresh, and the only
 * true word for that timestamp is when the attempt was made — otherwise the
 * popover restates, in its body, the exact conflation the chip above it was
 * changed to stop making.
 *
 * "Verified" stays in the alternation. It is no longer produced — the rung word
 * was removed from `observationState` — but a stored label from a build that
 * did produce it must still be rewritten to "Attempted" rather than kept.
 */
export function accountReadingLine(
  acceptance: ChutesAccountAcceptance | undefined,
  observedLabel: string | undefined,
): string | undefined {
  if (observedLabel === undefined) return undefined;
  if (acceptance === undefined || acceptance === "accepted") return observedLabel;
  return observedLabel.replace(/^(?:Verified|Observed|Read)/u, "Attempted");
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

/**
 * The tab strip, which outlives every other statement about Chutes on this
 * route.
 *
 * The header chip and the refusal alert are both rendered only while the Chutes
 * panel is selected (`selectedProvider === "chutes"` gates the `status` slot and
 * the whole panel). Select OpenAI and the tab label is the *only* thing left on
 * screen saying anything about the Chutes connection — so if it reads
 * "Connected" over four 401s, the fix that landed on the chip has simply moved
 * the false sentence one element to the left. `chutesConnected` answers "is a
 * credential held in page memory", which stays true of a rejected one; the tab
 * has to state acceptance too, and it is the only surface that can.
 *
 * Only `rejected` demotes the tab. A `refused` reading (every source 5xx) is a
 * transient fault, not a verdict on the credential, and calling it "Not
 * accepted" would blame the credential for the provider being down.
 */
export function resolveBillingProviderInventory(
  entries: readonly BillingProviderInventoryEntry[] | undefined,
  chutesConnected: boolean,
  chutesAcceptance?: ChutesAccountAcceptance,
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
        ? !chutesConnected
          ? "not-connected" as const
          : chutesAcceptance === "rejected" ? "rejected" as const : "connected" as const
        : entry?.state ?? "unavailable" as const,
      ...(entry?.connectionDetail ? { connectionDetail: entry.connectionDetail } : {}),
      ...(entry?.identity ? { identity: entry.identity } : {}),
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

/**
 * The heading's own words, kept — one rung down.
 *
 * The `<h1>` read `Account standing` while the rail row, the command palette,
 * the Trust hub tab and the More sheet that all lead here read `Account`. The
 * title now comes from `destinationLabel("billing")` and `standing` moves into
 * the eyebrow, where it still tells a reader which sense of "account" this
 * route means: the balance and the runway, not the identity.
 */
const ACCOUNT_ROUTE_EYEBROW = "Account standing · Chutes telemetry and provider inventory";

/**
 * Why this route lists four providers while Connection offers more ways in.
 *
 * Measured one click apart: `#connection` reads "No model connected · 5 ready
 * to connect" and `#account` shows four provider rows. Neither number is wrong
 * — Connection counts ways to connect, and a model server running on this
 * machine is one of them and has no account at all — but nothing said so, so
 * the two surfaces read as disagreeing about how many providers exist. The rule
 * is stated instead of a second number being printed, because two numbers in
 * two files is how they came to disagree in the first place.
 */
const ACCOUNT_PROVIDER_SCOPE_NOTE = "These are the providers that have an account to read. Connection offers more ways to connect than appear here — a model server running on this machine has no account, and nothing about it is billed or read.";

/** How long a snapshot reads as fresh before the chip demotes it to an observation. */
const OBSERVATION_FRESHNESS_BUDGET_MS = 5 * 60_000;

/**
 * The bound, stated on the figure it bounds.
 *
 * "Charged this UTC month" is a claim about a month; the client reads one page.
 * When that page came back full the two are not the same number, and the metric
 * must not present the smaller one as the month. The sentence is the client's,
 * not this view's, so the caption and the datum detail say the same thing.
 */
function boundedUsageSuffix(usage: ChutesUsageSummary): string {
  return usage.truncated ? ` · ${USAGE_BOUNDED_READ_NOTE}` : "";
}

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
  /*
   * When the freshness reading was last taken. The observed chip flips from
   * "Verified" to "Observed" at a pure clock threshold, and nothing
   * re-renders an idle route at a threshold — so one timeout per snapshot
   * wakes the view at exactly fetchedAt + budget. A second timer is never
   * needed: a stale reading only goes fresh again when a new snapshot
   * replaces the old one, which re-arms this effect.
   */
  const [observedNow, setObservedNow] = useState(() => Date.now());

  /*
   * Declared before the loader below so the account read is recorded as
   * Airship sends it — with its method and whether it carried the credential —
   * rather than only as an anonymous line in the browser's resource timeline.
   * The record is read on Connection; this route is one of the two that fills
   * it, and installing is idempotent.
   */
  useEffect(() => {
    installEgressRecorder();
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const fetchedAt = Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(fetchedAt)) return;
    const remaining = fetchedAt + OBSERVATION_FRESHNESS_BUDGET_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setObservedNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

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
  const observed = snapshot ? observationState(snapshot.fetchedAt, OBSERVATION_FRESHNESS_BUDGET_MS, observedNow) : undefined;
  const acceptance = snapshot ? chutesAccountAcceptance(snapshot) : undefined;
  const chip = chutesAccountChip(acceptance, observed?.stale === true);
  const subscriptionInactive = subscriptionState.status === "verified" && subscriptionState.value?.active === false;
  const quota = invocationTelemetry?.quota;
  const providers = useMemo(
    () => resolveBillingProviderInventory(providerInventory, accountReadable, acceptance),
    [providerInventory, accountReadable, acceptance],
  );
  const selectedInventory = providers.find((provider) => provider.providerId === selectedProvider)!;
  const selectedDefinition = BILLING_PROVIDERS.find((provider) => provider.id === selectedProvider)!;
  const chutesIdentity = chutesAccountIdentityPresentation(snapshot, loading);

  return (
    <section class="work-view billing-view">
      <RouteHeader
        routeId="account"
        density="tool"
        title={destinationLabel("billing")}
        eyebrow={ACCOUNT_ROUTE_EYEBROW}
        description="Review rich Chutes account telemetry and credential-free observations supplied for other connected providers."
        status={selectedProvider === "chutes" && accountReadable ? (
          /* The 64px `.billing-toolbar` band held one status line and one
             external link. The status line is this chip — a real seal state
             rather than a grey dot, with the freshness reading and the
             credential sentence in full inside it. */
          <Popover
            class="billing-credential-chip"
            heading="Account telemetry"
            label={`Account telemetry. ${chip.label}. Opens the credential kind and when this reading was taken.`}
            trigger={<Seal state={chip.state} density="chip" label={chip.label} />}
          >
            <p><strong>{chip.headline}</strong></p>
            <p>{accountReadingLine(acceptance, observed?.label) ?? credentialMessage(credentialKind)}{loading && snapshot ? " · updating" : ""}</p>
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

      <p class="billing-provider-scope">
        {ACCOUNT_PROVIDER_SCOPE_NOTE}{" "}
        <button class="small-button" type="button" onClick={onOpenAccess}>Open Connection</button>
      </p>

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
            {/* Method-agnostic on purpose. Naming sign-in here duplicated a
                fact only Connection computes — whether this build can run the
                OAuth exchange at all — so a build without it promised a route
                one press later it had to withdraw. The credential contract, the
                part Account does own, is unchanged word for word. */}
            <p>Connect a Chutes credential to read account telemetry. The credential remains held only in page memory.</p>
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
        /*
         * Two degraded rungs, because "some of it failed" and "none of it was
         * read" are not the same event. The alert grammar had only the first,
         * so a snapshot in which every source was refused announced itself as
         * partial — a word that promises the rest of the page holds telemetry.
         */
        acceptance === "accepted" ? (
          <div class="billing-alert warning" role="status">
            <Icon name="warning" />
            <div><strong>Partial account snapshot</strong>{snapshot.issues.map((issue) => <span key={`${issue.source}:${issue.code}`}>{issue.message}</span>)}</div>
          </div>
        ) : (
          <div class="billing-alert error" role="alert">
            <Icon name="warning" />
            <div>
              <strong>Account read refused</strong>
              <span>{acceptance === "rejected"
                ? "Chutes did not accept this credential: every account source refused it as unauthorized."
                : "No account source returned a value, so nothing below has been read."}</span>
              {snapshot.issues.map((issue) => <span key={`${issue.source}:${issue.code}`}>{issue.message}</span>)}
              <button class="small-button" type="button" onClick={onOpenAccess}>Review connection</button>
            </div>
          </div>
        )
      ) : null}

      <section class="panel billing-account-identity" aria-label="Connected Chutes account identity">
        <div class="panel-heading"><span>Connected Chutes account</span><span>{accountReadingLine(acceptance, observed?.label) ?? "Account observation unavailable"}</span></div>
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
          caption={usageState.value ? `${formatCompactCount(usageState.value.totalRequests)} charged requests in this range${boundedUsageSuffix(usageState.value)}` : usageState.detail}
        />
        <Metric
          label="Tokens this UTC month"
          value={metricQuantity(usageState.value ? formatCompactCount(usageState.value.inputTokens + usageState.value.outputTokens) : billingDatumLabel(usageState.status))}
          caption={usageState.value ? `${formatCompactCount(usageState.value.inputTokens)} in · ${formatCompactCount(usageState.value.outputTokens)} out${boundedUsageSuffix(usageState.value)}` : usageState.detail}
        />
        {/* Live headroom is not a subscription fact and no longer sits in a grid
            gated on one. It is a figure, so it is a metric. */}
        <Metric
          label="Live headroom"
          value={metricQuantity(quota?.remaining === undefined
            ? NOT_READ
            : `${formatCompactCount(quota.remaining)}${quota.total === undefined ? "" : ` / ${formatCompactCount(quota.total)}`}`)}
          caption={invocationTelemetry ? `observed ${formatInstant(invocationTelemetry.capturedAt, "minute")}` : "Run a Chutes turn to observe headers"}
        />
      </MetricStrip>

      {/* The other three header facts stay visible rather than moving into a
          tooltip on the tile above. */}
      <p class="billing-headroom-facts">
        <span>Latest invocation</span>
        <span>User rate limit {invocationTelemetry?.rateLimit?.user === undefined ? NOT_READ : invocationTelemetry.rateLimit.user === "unlimited" ? "Unlimited" : formatCompactCount(invocationTelemetry.rateLimit.user)}</span>
        {/* Both limits are absent for the same reason — the header was not on
            the last invocation. "Unavailable" asserted that Chutes has no such
            figure; the em dash states the non-claim the other three cells
            already state. One absence, one word. */}
        <span>Chute rate limit {invocationTelemetry?.rateLimit?.chute === undefined ? NOT_READ : formatCompactCount(invocationTelemetry.rateLimit.chute)}</span>
        <span>Observed {invocationTelemetry ? formatInstant(invocationTelemetry.capturedAt, "minute") : NOT_READ}</span>
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
            <span>{usageState.value ? `${formatInstant(usageState.value.rangeStart, "day", "UTC")} → ${formatInstant(usageState.value.rangeEnd, "day", "UTC")}` : billingDatumLabel(usageState.status)}</span>
          </div>
          {usageEntries.length ? <UsageChart entries={usageEntries} highlight={highlight} onHighlight={setHighlight} /> : <div class="billing-empty"><Icon name="billing" /><strong>{usageEmptyTitle(usageState.status)}</strong><p>{usageState.status === "verified" ? "Chutes returned no usage records for this requested range; activity outside the response is not inferred." : usageState.detail}</p></div>}
          {usageEntries.length ? (
            <>
            <div
              class="usage-ledger"
              role="table"
              aria-label="Recent account usage"
              aria-describedby="usage-ledger-bound"
            >
              {/* `role="table"` on the container declared a table whose rows had
                  no cells in them: the generic spans stayed generic, so the
                  ledger reached the accessibility tree as four rows of nothing.
                  The roles are what make the header/cell association real, and
                  they are what carries the Tokens value on a phone, where it is
                  restacked onto its own sub-line rather than deleted. */}
              <div class="usage-ledger-head" role="row"><span role="columnheader">Date</span><span role="columnheader">Requests</span><span role="columnheader">Tokens</span><span role="columnheader">Charged</span></div>
              {[...usageEntries].reverse().slice(0, PANEL_ROW_CAP).map((entry) => (
                <div
                  class="usage-ledger-row"
                  role="row"
                  key={`${entry.bucket}:${entry.chuteId ?? "all"}`}
                  data-highlight={entry.bucket === highlight ? "true" : undefined}
                  onPointerEnter={() => setHighlight(entry.bucket)}
                  onPointerLeave={() => setHighlight(undefined)}
                >
                  <span role="cell">{formatInstant(entry.bucket, "minute")}</span>
                  <span role="cell">{formatCompactCount(entry.requests)}</span>
                  <span role="cell">{formatCompactCount(entry.inputTokens + entry.outputTokens)}</span>
                  <strong role="cell">{formatUsd(entry.cost, "ledger")}</strong>
                </div>
              ))}
            </div>
            {/* The table capped at ten rows and said so nowhere. The sentence
                stays visually attached but sits outside `role="table"`: a
                non-row child of a table is not in the table's content model, so
                inside the container this was the one line AT would never
                reach — the cap disclosure, deleted by the markup that was added
                to make the rows real. `aria-describedby` keeps the association
                the DOM nesting used to imply. */}
            <p class="usage-ledger-foot" id="usage-ledger-bound">{boundedRowNote(usageEntries.length, "most recent", "bucket")}</p>
            </>
          ) : null}
        </section>

        <section class="panel quota-panel">
          <div class="panel-heading"><span>Configured quotas</span><span>{quotaState.status === "verified" && quotaState.value ? `${quotaState.value.rawCount} record${quotaState.value.rawCount === 1 ? "" : "s"}` : billingDatumLabel(quotaState.status)}</span></div>
          {quotaState.status === "verified" && quotaState.value?.entries.length ? (
            <>
            {/* The heading counts every record Chutes returned and the list drew
                the first ten of them, silently: with 24 configured quotas this
                panel read "24 records" above exactly 10 rows, and nothing on
                the route said which 14 spend limits were withheld. The ledger
                one panel to the left had already been given this sentence; it
                is the same class and the same grammar, because a second shape
                for "this list is bounded" is how the two drift.
                `aria-describedby` only when the sentence exists — a dangling
                id is a described-by that describes nothing. */}
            <div
              class="quota-list"
              {...(quotaState.value.entries.length > PANEL_ROW_CAP ? { "aria-describedby": "quota-list-bound" } : {})}
            >
              {quotaState.value.entries.slice(0, PANEL_ROW_CAP).map((quotaEntry, index) => (
                <div key={`${quotaEntry.chuteId ?? "default"}:${index}`}>
                  <span>{quotaEntry.chuteId ?? "Default"}</span>
                  <strong>{quotaEntry.quota === "unlimited" ? "Unlimited" : formatCompactCount(quotaEntry.quota)}</strong>
                </div>
              ))}
            </div>
            {quotaState.value.entries.length > PANEL_ROW_CAP ? (
              <p class="usage-ledger-foot" id="quota-list-bound">{boundedRowNote(quotaState.value.entries.length, "first", "quota record")}</p>
            ) : null}
            </>
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

  /*
   * The movement rule is `tabs.tsx`'s `nextTabId`, not a fourth copy of it.
   *
   * This strip shipped its own ←/→/Home/End ladder with its own wrap-around,
   * which is how a strip drifts from the other three the day the contract
   * changes — a Home/End rule that starts respecting disabled tabs would have
   * reached every tablist except this one. `Tabs` itself is still not adoptable
   * here because each tab is two lines, provider name over connection state,
   * and `TabItem` has no shape for that.
   */
  const moveSelection = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const items = providers.map(({ providerId }) => ({
      id: providerId,
      label: BILLING_PROVIDERS.find((candidate) => candidate.id === providerId)?.label ?? providerId,
    }));
    const next = providers.find((provider) => provider.providerId === nextTabId(items, selected, event.key));
    if (!next) return;
    event.preventDefault();
    onSelect(next.providerId);
    tablist.current
      ?.querySelector<HTMLButtonElement>(`#billing-provider-tab-${next.providerId}`)
      ?.focus();
  };

  return (
    <div
      class="billing-provider-tabs"
      ref={tablist}
      role="tablist"
      aria-label="Account providers"
      onKeyDown={moveSelection}
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
            <strong><BrandLogo name={BILLING_PROVIDER_ICONS[provider.id]} size={16} />{provider.label}</strong>
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
  /*
   * Why this panel is empty, rather than the fact that it is.
   *
   * Account is a global destination beside Vault and Connection and lists four
   * providers, and only the Chutes panel could ever hold anything: the other
   * three said "Connection state was not supplied to this view" and "Unavailable"
   * four times, which reads as a feature that has not loaded. It is not. Airship
   * reads account telemetry from Chutes and calls no other provider's account
   * API from the browser, so the honest panel states the rule and stops the
   * reader waiting for numbers that are never coming.
   */
  const telemetryRule = provider.id === "chutes"
    ? ""
    : ` Airship reads account telemetry from Chutes only: it made no ${provider.label} account request from this browser, so the rows below are unread rather than empty.`;
  const connectionDetail = boundedDisplayText(inventory.connectionDetail, 768) ?? (
    inventory.state === "connected"
      ? `Connected state was supplied by the host. This view did not call the provider API.${telemetryRule}`
      : inventory.state === "not-connected"
        ? `No connected account is currently represented in this inventory.${telemetryRule}`
        : inventory.state === "rejected"
          ? "A credential is held for this provider and the provider refused it. Nothing below was read."
          : `Connection state was not supplied to this view.${telemetryRule}`
  );
  const accountLinkStatus = inventory.accountLink?.status === "not-provided"
    ? "Not provided"
    : inventory.accountLink?.status === "unavailable"
      ? "Unavailable"
      : inventory.accountLink?.status === "observed"
        ? "Unavailable"
        : inventory.state === "connected" ? "Not provided" : "Unavailable";
  const observedAt = inventory.observedAt
    ? formatInstant(inventory.observedAt, "minute")
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
          <h2><BrandLogo name={BILLING_PROVIDER_ICONS[provider.id]} size={20} />{provider.label}</h2>
        </div>
        <span class="billing-provider-state" data-state={inventory.state}>{providerConnectionLabel(inventory.state)}</span>
      </header>
      <p class="billing-provider-inventory__detail">{connectionDetail}</p>

      <dl class="billing-provider-data">
        {/* Identity first: the Chutes panel opens with who you are connected as,
            and a provider tab that cannot answer that question should say so in
            the same place rather than by leaving the row out. */}
        <ProviderInventoryDatum label="Authenticated identity" observation={inventory.identity} connectionState={inventory.state} />
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
    ? formatInstant(observation.observedAt, "minute")
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
          {/* The bar is a redrawing of the two figures above and below it, and
              its `aria-label` was discarded regardless — a bare span computes as
              generic, which ARIA forbids naming. Marked as the decoration it is;
              the used/covered line and the remaining line carry the fact. */}
          <span class="runway-track" aria-hidden="true"><span style={{ width: `${percent ?? 0}%` }} /></span>
          <div class="runway-foot"><span>{window.remaining === undefined ? (uncapped ? "No fixed cycle cap" : "Remaining unavailable") : `${formatUsd(window.remaining, "ledger")} remaining`}</span><span>{window.resetAt ? `Resets ${formatInstant(window.resetAt, "minute")}` : "Reset unavailable"}</span></div>
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
          // `${entry.requests}` was the route's third number grammar: the same
          // count the table two rows down prints grouped read `12345` here.
          const label = `${formatInstant(entry.bucket, "minute")} · ${formatUsd(entry.cost, "ledger")} · ${formatCount(entry.requests)} requests`;
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
        <span>{first ? formatInstant(first.bucket, "day") : ""}</span>
        <span>{middle ? formatInstant(middle.bucket, "day") : ""}</span>
        <span>{last ? formatInstant(last.bucket, "day") : ""}</span>
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
  if (state === "rejected") return "Not accepted";
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
 * How many rows either detail panel draws before it has to say so.
 *
 * The number was typed four times across two panels, and the quota panel typed
 * only one of the four — the `slice`, with no sentence — so it printed "24
 * records" over ten rows. One reference cannot drift from itself.
 */
export const PANEL_ROW_CAP = 10;

/**
 * "This list is bounded", in one grammar for both panels.
 *
 * Two panels sit side by side on this route and both cap at `PANEL_ROW_CAP`.
 * Written twice they were already diverging — one had the sentence, one had
 * nothing — and the next divergence would have been the wording. `order` is a
 * real difference, not a variant: the ledger shows the newest buckets and the
 * quota list shows the response's own order, and a reader who is missing rows
 * must be told which end they are missing.
 */
export function boundedRowNote(total: number, order: "most recent" | "first", noun: string): string {
  const shown = formatCount(Math.min(PANEL_ROW_CAP, total));
  // "the first 10" and "the 10 most recent" are where English puts the count
  // for each ordering; the ledger's existing sentence and All conversations'
  // "Showing the first N of M conversations" are both preserved word for word —
  // including its grouping, which this sentence used to drop.
  const lead = order === "first" ? `first ${shown}` : `${shown} most recent`;
  return `Showing the ${lead} of ${formatCount(total)} ${noun}${total === 1 ? "" : "s"}.`;
}


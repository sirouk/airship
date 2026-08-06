import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { reconnectMethodTab, type AccessReconnectIntent } from "../access-intent";
import { BrandLogo, type BrandLogoName } from "../brand-icons";
import { Icon } from "../icons";
import { Seal } from "../seal";
import { nextTabId } from "../tabs";
import {
  companionFacts,
  describeConnectLanes,
  type ConnectLane,
  type ConnectLaneId,
  type ConnectLaneInput,
  type ConnectLaneStatus,
} from "./connect-lanes";
import { bridgeSummary } from "./extension-bridge-presence";
import {
  isSubmittableCode,
  MAX_PASTED_INPUT_CHARS,
  readAuthorizationCode,
} from "./authorization-code-paste";
import "./connect-surface.css";

/**
 * One calm surface for connecting a model.
 *
 * Every lane is present at all times — including once something is already
 * connected, because more than one provider may be held at once — in one
 * vocabulary, with one glyph family, ordered so the routes that work lead. A
 * lane that cannot be connected renders the reason and the working alternative
 * rather than a control that errors.
 */

/**
 * What one loopback probe actually found. There is no "unknown" arm: the panel
 * renders a result only after a request was issued and answered or refused.
 */
export type LocalProviderProbeResult =
  | Readonly<{ id: string; label: string; outcome: "answered"; detail: string }>
  | Readonly<{ id: string; label: string; outcome: "silent"; reason: string }>;

export type ConnectSurfaceProps = Readonly<{
  input: ConnectLaneInput;
  /** A validated conversation return instruction from the Connection URL. */
  reconnectIntent?: AccessReconnectIntent;
  /**
   * Chutes credential controls. The connection view owns the credential
   * lifecycle, so this surface owns only where they sit and what is said
   * around them.
   */
  chutesPanel: ComponentChildren;
  /** Opens the vendor tab. Resolves once the tab has been opened, not signed in. */
  onStartCodexSignIn?: () => Promise<void>;
  /** Completes the paste-back exchange. Rejects with a sentence a person can read. */
  onSubmitCodexCode?: (code: string, state?: string) => Promise<void>;
  /** Moves to the browser-direct provider list, which holds the API-key paths. */
  onOpenDirectProviders?: (provider?: "openai" | "anthropic" | "xai") => void;
  /** Published extension install page, when this build has one. */
  extensionInstallUrl?: string;
  /**
   * Issues the real loopback probe behind "Check this machine". Without it the
   * lane says so rather than rendering a button that only scrolls: the copy
   * beside it promises 127.0.0.1 is contacted when the button is pressed, and
   * a control that does not do what the sentence above it says is a defect.
   */
  onCheckLocalProviders?: () => Promise<readonly LocalProviderProbeResult[]>;
}>;

/*
 * Vendors carry their real brand marks here; the lanes that have no vendor
 * logo keep the stroke set. A mark is recognised before it is read, and a
 * padlock next to "Chutes" taught the reading of one company for the look of
 * four.
 */
const LANE_BRANDS: Partial<Readonly<Record<ConnectLaneId, BrandLogoName>>> = Object.freeze({
  chutes: "chutes",
  codex: "openai",
  claude: "anthropic",
  grok: "xai",
});
const LANE_ICONS: Partial<Readonly<Record<ConnectLaneId, "lock" | "model" | "attestation" | "terminal">>> = Object.freeze({
  local: "terminal",
  companion: "attestation",
});

/**
 * Method sub-labels, short enough to fit the tab at `--fs-micro` and never
 * ellipsise. The long form is `status.label`, which stays in full on the lane's
 * own seal and inside the panel, so nothing here is the only carrier.
 */
/** The switch's two tabs, in strip order, for the shared movement rule. */
const CONNECTION_METHOD_TABS = Object.freeze([
  Object.freeze({ id: "oauth", label: "OAuth" }),
  Object.freeze({ id: "api-key", label: "API key" }),
]);

const METHOD_SUBLABELS: Readonly<Record<ConnectLaneStatus["kind"], string>> = Object.freeze({
  connected: "Connected",
  ready: "Primary",
  checking: "Checking",
  "needs-extension": "Needs the extension",
  "extension-unavailable": "Not in this browser",
  offline: "Offline",
  unavailable: "Not available here",
});

/**
 * Which method a lane opens on: the one that can actually work.
 *
 * Three of five lanes used to open onto a hardcoded OAuth tab whose own
 * sub-label said the route was impossible. The OAuth tab stays present and
 * selectable — that is where the honest reason lives — it simply stops being
 * the default when it cannot be used.
 */
export function initialConnectMethod(oauthStatus: ConnectLaneStatus): "oauth" | "api-key" {
  return oauthStatus.kind === "ready" || oauthStatus.kind === "connected" ? "oauth" : "api-key";
}

export function ConnectSurface({
  input,
  chutesPanel,
  onStartCodexSignIn,
  onSubmitCodexCode,
  onOpenDirectProviders,
  extensionInstallUrl,
  onCheckLocalProviders,
  reconnectIntent,
}: ConnectSurfaceProps) {
  const lanes = describeConnectLanes(input);
  // This surface deliberately survives a connection. The heading below promises
  // "one, or several at once", and a person who has just connected one provider
  // is the most likely person to add a second — so returning null here once any
  // lane reported `connected` both contradicted the copy and made the lane
  // model's own connected state unreachable. It also called the hook below
  // after an early return, which is a hook-order violation the moment the first
  // provider connects.
  /*
   * At most one lane opens itself, and only the one a new arrival needs.
   *
   * The rule used to be "the first lane that is not connected", which reads as
   * helpfulness and behaves as an interrogation: connect Chutes and the surface
   * immediately unfolded OpenAI at you; dismiss that and it unfolded Anthropic.
   * Every one of those panels is a vendor asking for a credential nobody went
   * looking for, and a person who has just connected has finished, not started.
   *
   * The exception is the path that has no alternative: with no Chutes
   * connection yet there is nothing else on this route to be doing, so that one
   * lane may start open. Once it is connected, nothing opens by itself — the
   * whole list is still there, one press away, in the order the lane model
   * already ranks it.
   */
  const chutesLane = lanes.find((entry) => entry.id === "chutes");
  const leadLane = chutesLane && chutesLane.status.kind !== "connected" ? chutesLane.id : undefined;
  /*
   * `"none"` is a choice, not the absence of one. Without it, closing the lane
   * that opened itself set the state back to "no choice yet" and the default
   * immediately reopened it — a disclosure that could not be closed.
   */
  const [chosenLane, setChosenLane] = useState<ConnectLaneId | "none" | undefined>(() => reconnectIntent?.lane);
  useEffect(() => {
    if (reconnectIntent?.lane) setChosenLane(reconnectIntent.lane);
  }, [reconnectIntent?.lane, reconnectIntent?.returnSessionId]);
  const openLane = chosenLane ?? leadLane;
  const laneList = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!openLane || openLane === "none") return;
    const frame = requestAnimationFrame(() => {
      const lane = laneList.current?.querySelector<HTMLElement>(`[data-lane="${openLane}"]`);
      if (!lane) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      lane.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [openLane]);

  return (
    <section class="connect-surface" aria-label="Providers">
      <ul ref={laneList} class="connect-lane-list">
        {lanes.map((lane) => (
          <ConnectLaneCard
            key={lane.id}
            lane={lane}
            open={openLane === lane.id}
            onToggle={() => setChosenLane(openLane === lane.id ? "none" : lane.id)}
          >
            {lane.id === "chutes" ? chutesPanel : null}
            {lane.id === "codex" ? (
              <CloudMethodPanel
                provider="openai"
                initialMethod={reconnectIntent?.lane === lane.id ? reconnectMethodTab(reconnectIntent.method) : undefined}
                oauthLabel="Sign in with ChatGPT"
                oauthStatus={lane.oauthStatus ?? lane.status}
                onOpenDirectProviders={onOpenDirectProviders}
                oauthPanel={() => (lane.oauthStatus ?? lane.status).kind === "ready" ? (
                  <CodexPanel onStart={onStartCodexSignIn} onSubmit={onSubmitCodexCode} />
                ) : null}
              />
            ) : null}
            {lane.id === "claude" || lane.id === "grok" ? (
              <CloudMethodPanel
                provider={lane.id === "claude" ? "anthropic" : "xai"}
                initialMethod={reconnectIntent?.lane === lane.id ? reconnectMethodTab(reconnectIntent.method) : undefined}
                oauthLabel={lane.id === "claude" ? "Sign in with Anthropic" : "Sign in with xAI"}
                oauthStatus={lane.oauthStatus ?? lane.status}
                onOpenDirectProviders={onOpenDirectProviders}
                oauthPanel={({ useApiKey }) => (
                  <ExtensionPanel
                    oauthStatus={lane.oauthStatus ?? lane.status}
                    providerLabel={lane.title}
                    bridgeLine={bridgeSummary(input.bridge)}
                    installUrl={extensionInstallUrl}
                    onUseApiKey={useApiKey}
                  />
                )}
              />
            ) : null}
            {lane.id === "local" ? (
              <LocalPanel
                onCheck={onCheckLocalProviders}
                onOpenDirectProviders={onOpenDirectProviders}
              />
            ) : null}
            {lane.id === "companion" ? (
              <CompanionPanel
                observation={input.bridge}
                host={input.host}
                installUrl={extensionInstallUrl}
              />
            ) : null}
          </ConnectLaneCard>
        ))}
      </ul>
    </section>
  );
}

type CloudProviderId = "openai" | "anthropic" | "xai";

/**
 * The Companion's body — every word the 219px/415px card carried, one rung down.
 *
 * The three readings stay a `<dl>` so `dt`/`dd` remain machine-readable and
 * screen-reader-addressable; they simply stop being a 50px boxed grid of "Not
 * observed / Not active / Not active" rendered above the providers a person
 * came here to connect. When the extension *is* answering, the same three
 * readings are also promoted onto the collapsed row, so a truthful positive
 * state is observable without opening anything.
 */
function CompanionPanel({
  observation,
  host,
  installUrl,
}: Readonly<{
  observation: ConnectLaneInput["bridge"];
  host: ConnectLaneInput["host"];
  installUrl?: string;
}>) {
  const available = observation?.state === "available";
  const hostDetail = host.kind === "installable"
    ? "This browser can load the Airship Companion."
    : host.reason;

  return (
    <div class="connect-companion">
      <dl class="connect-companion__facts">
        {companionFacts(observation).map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <p class="connect-companion__host">{hostDetail}</p>
      {installUrl ? (
        <a
          class={available ? "connect-companion__link" : "primary"}
          href={installUrl}
          target="_blank"
          rel="noreferrer"
        >
          {available ? "Downloads & setup ↗" : "Get the extension ↗"}
        </a>
      ) : null}
    </div>
  );
}

function CloudMethodPanel({
  provider,
  initialMethod,
  oauthLabel,
  oauthStatus,
  onOpenDirectProviders,
  oauthPanel,
}: Readonly<{
  provider: CloudProviderId;
  initialMethod?: "oauth" | "api-key";
  oauthLabel: string;
  oauthStatus: ConnectLaneStatus;
  onOpenDirectProviders?: (provider?: CloudProviderId) => void;
  /**
   * The OAuth tabpanel's contents, given a way back to the key tab.
   *
   * A function rather than children because a caller may legitimately have no
   * control to render — and this panel has to know that, so it can render the
   * reason instead of a heading above nothing.
   */
  oauthPanel: (helpers: Readonly<{ useApiKey: () => void }>) => ComponentChildren;
}>) {
  const [method, setMethod] = useState<"oauth" | "api-key">(() => initialMethod ?? initialConnectMethod(oauthStatus));
  const oauthPanelId = useId();
  const keyPanelId = useId();
  const providerLabel = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "xAI";
  const useApiKey = () => setMethod("api-key");
  // The OAuth panel renders a heading only when there is something under it.
  // This is the measured OpenAI dead end: a bold "Sign in with ChatGPT" was the
  // last thing in the lane because `CodexPanel` returns null for a non-ready
  // status, and that status's own `detail` sentence rendered nowhere at all.
  const rendered = oauthPanel({ useApiKey });
  const oauthActionable = rendered !== null && rendered !== undefined && rendered !== false;
  useEffect(() => {
    if (initialMethod) setMethod(initialMethod);
  }, [initialMethod]);

  return (
    <div class="connect-method">
      {/* Two buttons carrying `role="tab"` owe the whole tablist contract, not
          only its look: one tab in the tab order and ←/→/Home/End moving
          selection and focus. The movement rule is `tabs.tsx`'s, so there is
          still one implementation of it — enforced, not asserted:
          `tablist-contract.test.ts` fails any strip that reimplements it. */}
      <div
        class="connect-method__switch"
        role="tablist"
        aria-label={`${providerLabel} connection method`}
        onKeyDown={(event) => {
          const next = nextTabId(CONNECTION_METHOD_TABS, method, event.key);
          if (next === undefined) return;
          event.preventDefault();
          setMethod(next === "oauth" ? "oauth" : "api-key");
          const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
          tabs[CONNECTION_METHOD_TABS.findIndex((item) => item.id === next)]?.focus();
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={method === "oauth"}
          aria-controls={oauthPanelId}
          tabIndex={method === "oauth" ? 0 : -1}
          onClick={() => setMethod("oauth")}
        >
          <span>OAuth</span>
          <small>{METHOD_SUBLABELS[oauthStatus.kind]}</small>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "api-key"}
          aria-controls={keyPanelId}
          tabIndex={method === "api-key" ? 0 : -1}
          onClick={() => setMethod("api-key")}
        >
          <span>API key</span>
          <small>Page memory</small>
        </button>
      </div>
      <div id={oauthPanelId} role="tabpanel" hidden={method !== "oauth"}>
        {oauthActionable ? <p class="connect-method__title">{oauthLabel}</p> : null}
        {oauthActionable ? rendered : (
          <div class="connect-method__blocked">
            <p><Icon name="warning" size={16} />{oauthStatus.detail}</p>
            <button type="button" onClick={useApiKey}>Use an API key</button>
          </div>
        )}
      </div>
      <div id={keyPanelId} role="tabpanel" hidden={method !== "api-key"} aria-label={`Use a ${providerLabel} API key`}>
        <div class="connect-method__key">
          {/*
            The heading is the tabpanel's accessible name rather than a fourth
            visible rendering of two words that are already on screen: the lane
            header says the provider 60px above, and the tab a person just
            pressed is literally labelled `API key`.
          */}
          <p>The key is held only in this page’s memory and is released when the connection is cleared or the page closes.</p>
          <button
            type="button"
            class="primary"
            disabled={!onOpenDirectProviders}
            onClick={() => onOpenDirectProviders?.(provider)}
          >
            Configure API key
          </button>
          <p class="connect-lane__boundary">
            <Icon name="lock" size={15} />
            This is an explicit browser-direct compatibility path. Airship never embeds a provider secret.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConnectLaneCard({
  lane,
  open,
  onToggle,
  children,
}: Readonly<{
  lane: ConnectLane;
  open: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}>) {
  const panelId = useId();
  const titleId = useId();
  return (
    // `data-state` is the lane's own state and `data-oauth-state` is its
    // sign-in leg's. They are different claims now that a lane is described at
    // its own altitude — OpenAI's key route is ready while its ChatGPT sign-in
    // is not — so both are readable rather than one standing in for the other.
    <li
      class="connect-lane"
      data-lane={lane.id}
      data-state={lane.status.kind}
      data-oauth-state={lane.oauthStatus?.kind}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        class="connect-lane__header"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        {LANE_BRANDS[lane.id]
          ? <BrandLogo name={LANE_BRANDS[lane.id]!} size={20} />
          : <Icon name={LANE_ICONS[lane.id]!} size={20} />}
        {/* One row, one baseline. The qualifier is a different fact from the
            title, never the title again, so the pair earns its 44px. */}
        <span class="connect-lane__identity">
          <strong id={titleId}>{lane.title}</strong>
          <small>{lane.vendor}</small>
        </span>
        {lane.facts ? (
          <span class="connect-lane__facts">
            {lane.facts.map((fact) => (
              <span key={fact.label} title={`${fact.label}: ${fact.value}`}>{fact.value}</span>
            ))}
          </span>
        ) : null}
        <span class="connect-lane__seal-row">
          <Seal state={lane.seal} label={lane.status.label} compact />
        </span>
        <span class="connect-lane__chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="connect-lane__body" id={panelId} role="region" aria-labelledby={titleId} hidden={!open}>
        <p class="connect-lane__summary">{lane.summary}</p>
        <p class="connect-lane__detail">{lane.status.detail}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * The paste-back step, written so a normal person succeeds.
 *
 * The vendor's redirect lands on a loopback address nothing is listening on, so
 * the browser shows a connection error. That is stated before the tab is opened
 * — an unexplained error page is the single most likely place for this feature
 * to feel broken — and the field reads whatever is pasted while it is typed.
 */
function CodexPanel({
  onStart,
  onSubmit,
}: Readonly<{
  onStart?: () => Promise<void>;
  onSubmit?: (code: string, state?: string) => Promise<void>;
}>) {
  const fieldId = useId();
  const readingId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  // Whether this panel may render at all is the caller's decision, so that a
  // lane which cannot start sign-in renders the reason rather than nothing.
  const reading = readAuthorizationCode(raw);
  const submittable = isSubmittableCode(reading);

  return (
    <div class="connect-paste">
      <ol class="connect-paste__steps">
        <li>
          <strong>Approve Airship at OpenAI.</strong>
          <span>Opens in a new tab. Airship never sees your ChatGPT password.</span>
          <button
            type="button"
            class="primary"
            disabled={busy || !onStart}
            onClick={() => {
              setFailure(undefined);
              void onStart?.()
                .then(() => requestAnimationFrame(() => field.current?.focus()))
                .catch((caught: unknown) => setFailure(readableFailure(caught)));
            }}
          >
            Sign in with ChatGPT
          </button>
        </li>
        <li>
          <strong>Expect an error page. It is the right page.</strong>
          <span>
            When you approve, OpenAI sends the browser to an address on your own
            machine that nothing is listening on, so you will see something like
            “This site can’t be reached”. Your one-time code is in that page’s
            address bar, not in the page.
          </span>
          <p class="connect-paste__example" role="group" aria-label="Example of the address to copy">
            <span>http://localhost:1455/auth/callback?</span>
            <mark>code=ac_1a2b3c…</mark>
            <span>&amp;state=…</span>
          </p>
        </li>
        <li>
          <strong>Paste that whole address here.</strong>
          <span>Airship reads the code out of it. A bare code works too.</span>
          <label class="connect-paste__field" for={fieldId}>
            <span>Address from the error page</span>
            <input
              ref={field}
              id={fieldId}
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              maxLength={MAX_PASTED_INPUT_CHARS}
              placeholder="http://localhost:1455/auth/callback?code=…"
              aria-describedby={readingId}
              aria-invalid={reading.kind === "rejected"}
              disabled={busy}
              value={raw}
              onInput={(event) => {
                setFailure(undefined);
                setRaw(event.currentTarget.value);
              }}
            />
          </label>
          {/*
            The live region carries only the classification sentence, which
            changes when the reading changes rather than on every keystroke.
            The code preview is deliberately outside it so a screen reader is
            not re-interrupted while a long value is pasted character by
            character.
          */}
          <p
            id={readingId}
            class={`connect-paste__reading ${reading.kind}`}
            role="status"
            aria-live="polite"
          >
            {reading.kind === "empty"
              ? "Nothing pasted yet."
              : reading.kind === "accepted"
                ? reading.confirmation
                : reading.message}
          </p>
          {reading.kind === "accepted" ? (
            <p class="connect-paste__preview">
              Code <code>{reading.preview}</code>
              {reading.state ? " · state returned by OpenAI" : " · no state returned"}
            </p>
          ) : null}
          <button
            type="button"
            class="primary"
            disabled={busy || !submittable || !onSubmit}
            onClick={() => {
              if (!submittable || !onSubmit) return;
              setBusy(true);
              setFailure(undefined);
              void onSubmit(reading.code, reading.state)
                .then(() => setRaw(""))
                .catch((caught: unknown) => {
                  setFailure(readableFailure(caught));
                  requestAnimationFrame(() => field.current?.focus());
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Exchanging the code…" : "Finish connecting Codex"}
          </button>
        </li>
      </ol>
      {failure ? <p class="connect-lane__failure" role="alert"><Icon name="warning" size={16} />{failure}</p> : null}
      <p class="connect-lane__boundary">
        <Icon name="lock" size={15} />
        The token is exchanged straight from this page and stays in page memory
        for this tab. Nothing is written to the vault or to storage.
      </p>
    </div>
  );
}

function ExtensionPanel({
  oauthStatus,
  providerLabel,
  bridgeLine,
  installUrl,
  onUseApiKey,
}: Readonly<{
  oauthStatus: ConnectLaneStatus;
  providerLabel: string;
  bridgeLine: string;
  installUrl?: string;
  /** Switches to the key tab beside this one, which is where the field is. */
  onUseApiKey: () => void;
}>) {
  const alternative = oauthStatus.kind === "needs-extension" || oauthStatus.kind === "extension-unavailable"
    ? oauthStatus.alternative
    : undefined;

  return (
    <div class="connect-extension">
      <p class="connect-extension__observation">
        <Icon name="proof" size={15} />
        {bridgeLine}
      </p>
      {oauthStatus.kind === "ready" ? (
        <p class="connect-extension__ready">
          <Icon name="proof" size={15} />
          The extension transport can carry {providerLabel} in this tab. Airship
          will only offer account authorization when the corresponding flow
          controller is live; no client secret is embedded in the extension.
        </p>
      ) : null}
      {oauthStatus.kind === "checking" ? (
        <p class="connect-extension__unpublished">Checking the extension in this tab before offering account authorization.</p>
      ) : null}
      {oauthStatus.kind === "unavailable" || oauthStatus.kind === "offline" ? (
        <p class="connect-extension__unpublished">{oauthStatus.detail}</p>
      ) : null}
      {oauthStatus.kind === "needs-extension" ? (
        <div class="connect-extension__install">
          {installUrl ? (
            <a class="primary" href={installUrl} target="_blank" rel="noreferrer">Add the Airship extension ↗</a>
          ) : (
            <p class="connect-extension__unpublished">
              This build has no published install page yet, so Airship will not
              send you to one that may not exist.
            </p>
          )}
        </div>
      ) : null}
      <details class="connect-extension__boundary">
        <summary>What the extension is allowed to do</summary>
        <ul>
          <li>It reaches a fixed list of vendor addresses compiled into it. Nothing else, and no address supplied by this page.</li>
          <li>Every request it carries is sent with cookies omitted, so it can never ride a session you are already signed into.</li>
          <li>It forwards only the headers these protocols need and drops the rest.</li>
          <li>It stores no token. Its optional local cache accepts only encrypted Airship pages, is bounded, and can be cleared from the extension popup.</li>
          <li>Hashing and vector ranking can run in its background context to keep work off the interface thread; Airship does not call that a hardware boost.</li>
          <li>Request size, response size, deadline and concurrency are all bounded.</li>
        </ul>
        <p>Installing it changes what Airship can reach, not what Airship can prove. Traffic still ends at the vendor under the vendor’s own TLS.</p>
      </details>
      {alternative ? (
        <div class="connect-extension__alternative">
          <p>{alternative}</p>
          <button type="button" onClick={onUseApiKey}>Use an API key</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Local lane, where the button is the probe — and the bind.
 *
 * "Check this machine" issues the same loopback request the provider fabric
 * uses, and a server that answers is connected in this tab, not merely
 * listed: the same press commits the fabric connection the provider rows
 * below charge one press each for. The copy must name that consequence,
 * because a check that silently binds is not a check.
 */
function LocalPanel({
  onCheck,
  onOpenDirectProviders,
}: Readonly<{
  onCheck?: () => Promise<readonly LocalProviderProbeResult[]>;
  onOpenDirectProviders?: () => void;
}>) {
  const resultsId = useId();
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<readonly LocalProviderProbeResult[]>();
  const [failure, setFailure] = useState<string>();

  return (
    <div class="connect-local">
      <p>
        Airship checks <code>127.0.0.1:11434</code> for Ollama and
        {" "}<code>127.0.0.1:1234</code> for LM Studio, and connects anything
        that answers — only when you press Check. Your browser and the local
        service both have to allow this page.</p>
      <details class="connect-local__requirements">
        <summary>LM Studio Local Server requirements — the four settings the check needs</summary>
        <ol>
          <li>Open LM Studio and load a model (Developer tab), so it is ready to serve.</li>
          <li>Start the Local Server on port <code>1234</code> (Developer → Local Server → Start Server).</li>
          <li>Under Server Settings, turn <strong>Serve on Local Network</strong> on.</li>
          <li>Under Server Settings, turn <strong>Enable CORS</strong> on — without it the browser refuses the page’s requests.</li>
        </ol>
        <p>The loaded model then answers locally at <code>http://127.0.0.1:1234</code>. Ollama needs only its server running at <code>127.0.0.1:11434</code>.</p>
      </details>
      {onCheck ? (
        <button
          type="button"
          class="primary"
          disabled={checking}
          aria-describedby={resultsId}
          onClick={() => {
            setChecking(true);
            setFailure(undefined);
            setResults(undefined);
            void onCheck()
              .then((next) => setResults(next))
              .catch((caught: unknown) => setFailure(readableFailure(caught)))
              .finally(() => setChecking(false));
          }}
        >
          {checking ? "Checking 127.0.0.1…" : "Check this machine"}
        </button>
      ) : (
        <p class="connect-local__unwired">
          This build wires no loopback probe into this lane, so nothing here can
          check your machine. The local model servers below connect directly.
        </p>
      )}
      <div id={resultsId} class="connect-local__results" role="status" aria-live="polite">
        {checking ? <p>Contacting the loopback addresses above. Nothing else is contacted.</p> : null}
        {results ? (
          <ul>
            {results.map((result) => (
              <li key={result.id} data-outcome={result.outcome}>
                <strong>{result.label}</strong>
                <span>{result.outcome === "answered" ? result.detail : result.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {results?.some((result) => result.outcome === "answered") ? (
          <p class="connect-local__next-step">When a server answers, Airship keeps every model returned by its live catalog. Choose the model you want in Chat or below under <strong>Provider fabric</strong>; only that model is checked before a conversation starts.</p>
        ) : null}
      </div>
      {failure ? <p class="connect-lane__failure" role="alert"><Icon name="warning" size={16} />{failure}</p> : null}
      {onOpenDirectProviders ? (
        <button type="button" onClick={() => onOpenDirectProviders()}>Open Airship local provider setup</button>
      ) : null}
    </div>
  );
}

/** Never surfaces a raw thrown value; an unnamed failure is still a failure. */
export function readableFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw) return "The connection did not complete, and nothing was changed.";
  return raw.length > 320 ? `${raw.slice(0, 317)}…` : raw;
}

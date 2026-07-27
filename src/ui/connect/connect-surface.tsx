import type { ComponentChildren } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import { Icon } from "../icons";
import { Seal } from "../seal";
import {
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

const LANE_ICONS: Readonly<Record<ConnectLaneId, "lock" | "model" | "attestation" | "terminal">> = Object.freeze({
  chutes: "lock",
  codex: "model",
  claude: "model",
  grok: "model",
  local: "terminal",
});

export function ConnectSurface({
  input,
  chutesPanel,
  onStartCodexSignIn,
  onSubmitCodexCode,
  onOpenDirectProviders,
  extensionInstallUrl,
  onCheckLocalProviders,
}: ConnectSurfaceProps) {
  const lanes = describeConnectLanes(input);
  // This surface deliberately survives a connection. The heading below promises
  // "one, or several at once", and a person who has just connected one provider
  // is the most likely person to add a second — so returning null here once any
  // lane reported `connected` both contradicted the copy and made the lane
  // model's own connected state unreachable. It also called the hook below
  // after an early return, which is a hook-order violation the moment the first
  // provider connects.
  const leadLane = lanes.find((entry) => entry.status.kind !== "connected")?.id ?? lanes[0]?.id;
  const [chosenLane, setChosenLane] = useState<ConnectLaneId>();
  // Until someone chooses, the open lane follows the best available route, so
  // a cold visitor lands already inside a path that works.
  const openLane = chosenLane ?? leadLane;

  return (
    <section class="connect-surface" aria-labelledby="connect-surface-title">
      <header class="connect-surface__heading">
        <div>
          <span>One, or several at once</span>
          <h2 id="connect-surface-title">Providers</h2>
          <p>Everything else in Airship — workspace, editor, terminal and Git — already works without this. Only chat needs a model, and connecting one never closes the others.</p>
        </div>
      </header>

      <CompanionOverview
        observation={input.bridge}
        host={input.host}
        installUrl={extensionInstallUrl}
      />

      <ul class="connect-lane-list">
        {lanes.map((lane) => (
          <ConnectLaneCard
            key={lane.id}
            lane={lane}
            open={openLane === lane.id}
            onToggle={() => setChosenLane(openLane === lane.id ? undefined : lane.id)}
          >
            {lane.id === "chutes" ? chutesPanel : null}
            {lane.id === "codex" ? (
              <CloudMethodPanel
                provider="openai"
                oauthLabel="Sign in with ChatGPT"
                oauthStatus={lane.oauthStatus ?? lane.status}
                onOpenDirectProviders={onOpenDirectProviders}
              >
                <CodexPanel
                  status={lane.oauthStatus ?? lane.status}
                  onStart={onStartCodexSignIn}
                  onSubmit={onSubmitCodexCode}
                />
              </CloudMethodPanel>
            ) : null}
            {lane.id === "claude" || lane.id === "grok" ? (
              <CloudMethodPanel
                provider={lane.id === "claude" ? "anthropic" : "xai"}
                oauthLabel={lane.id === "claude" ? "Sign in with Anthropic" : "Sign in with xAI"}
                oauthStatus={lane.oauthStatus ?? lane.status}
                onOpenDirectProviders={onOpenDirectProviders}
              >
                <ExtensionPanel
                  oauthStatus={lane.oauthStatus ?? lane.status}
                  providerLabel={lane.title}
                  bridgeLine={bridgeSummary(input.bridge)}
                  installUrl={extensionInstallUrl}
                  onOpenDirectProviders={onOpenDirectProviders}
                />
              </CloudMethodPanel>
            ) : null}
            {lane.id === "local" ? (
              <LocalPanel
                onCheck={onCheckLocalProviders}
                onOpenDirectProviders={onOpenDirectProviders}
              />
            ) : null}
          </ConnectLaneCard>
        ))}
      </ul>
    </section>
  );
}

type CloudProviderId = "openai" | "anthropic" | "xai";

function CompanionOverview({
  observation,
  host,
  installUrl,
}: Readonly<{
  observation: ConnectLaneInput["bridge"];
  host: ConnectLaneInput["host"];
  installUrl?: string;
}>) {
  const available = observation?.state === "available";
  const storage = observation?.companion?.storage;
  const compute = observation?.companion?.compute;
  const status = !observation
    ? "Checking this tab"
    : available
      ? `Extension ${observation.extensionVersion ?? ""} connected`.trim()
      : "Extension not detected";
  const hostDetail = host.kind === "installable"
    ? "This browser can load the Airship Companion."
    : host.reason;

  return (
    <section class="companion-overview" aria-labelledby="companion-overview-title">
      <div class="companion-overview__heading">
        <span class={`companion-overview__dot ${available ? "ready" : "idle"}`} aria-hidden="true" />
        <div>
          <strong id="companion-overview-title">Airship Companion</strong>
          <small>{status}</small>
        </div>
        {installUrl ? (
          <a
            class={available ? "companion-overview__link" : "primary"}
            href={installUrl}
            target="_blank"
            rel="noreferrer"
          >
            {available ? "Downloads & setup ↗" : "Get the extension ↗"}
          </a>
        ) : null}
      </div>
      <p>
        Adds a reviewed provider relay, opt-in encrypted local cache, and bounded
        background hash/vector work. Provider account authorization is offered
        only when Airship also has a supported provider grant flow.
      </p>
      <dl class="companion-overview__facts">
        <div>
          <dt>Provider relay</dt>
          <dd>{available ? `${observation.providers.length} route${observation.providers.length === 1 ? "" : "s"} live` : "Not observed"}</dd>
        </div>
        <div>
          <dt>Encrypted cache</dt>
          <dd>{storage?.state === "available" ? (storage.enabled ? `${storage.records ?? 0} page${storage.records === 1 ? "" : "s"}` : "Available · off") : "Not active"}</dd>
        </div>
        <div>
          <dt>Background compute</dt>
          <dd>{compute?.state === "available" ? "Hash + vector ranking" : "Not active"}</dd>
        </div>
      </dl>
      {!available ? <small class="companion-overview__host">{hostDetail}</small> : null}
    </section>
  );
}

function CloudMethodPanel({
  provider,
  oauthLabel,
  oauthStatus,
  onOpenDirectProviders,
  children,
}: Readonly<{
  provider: CloudProviderId;
  oauthLabel: string;
  oauthStatus: ConnectLaneStatus;
  onOpenDirectProviders?: (provider?: CloudProviderId) => void;
  children: ComponentChildren;
}>) {
  const [method, setMethod] = useState<"oauth" | "api-key">("oauth");
  const oauthPanelId = useId();
  const keyPanelId = useId();
  const providerLabel = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "xAI";

  return (
    <div class="connect-method">
      <div class="connect-method__switch" role="tablist" aria-label={`${providerLabel} connection method`}>
        <button
          type="button"
          role="tab"
          aria-selected={method === "oauth"}
          aria-controls={oauthPanelId}
          onClick={() => setMethod("oauth")}
        >
          <span>OAuth</span>
          <small>{oauthStatus.kind === "ready" ? "Primary" : oauthStatus.label}</small>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "api-key"}
          aria-controls={keyPanelId}
          onClick={() => setMethod("api-key")}
        >
          <span>API key</span>
          <small>Page memory</small>
        </button>
      </div>
      <div id={oauthPanelId} role="tabpanel" hidden={method !== "oauth"}>
        <p class="connect-method__title">{oauthLabel}</p>
        {children}
      </div>
      <div id={keyPanelId} role="tabpanel" hidden={method !== "api-key"}>
        <div class="connect-method__key">
          <div>
            <strong>Use a {providerLabel} API key</strong>
            <p>The key is held only in this page’s memory and is released when the connection is cleared or the page closes.</p>
          </div>
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
    <li class="connect-lane" data-lane={lane.id} data-state={lane.status.kind} data-open={open ? "true" : "false"}>
      <button
        type="button"
        class="connect-lane__header"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <Icon name={LANE_ICONS[lane.id]} size={20} />
        <span class="connect-lane__identity">
          <strong id={titleId}>{lane.title}</strong>
          <small>{lane.vendor}</small>
        </span>
        <Seal state={lane.seal} label={lane.status.label} compact />
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
  status,
  onStart,
  onSubmit,
}: Readonly<{
  status: ConnectLaneStatus;
  onStart?: () => Promise<void>;
  onSubmit?: (code: string, state?: string) => Promise<void>;
}>) {
  const fieldId = useId();
  const readingId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const connectable = status.kind === "ready";
  const reading = readAuthorizationCode(raw);
  const submittable = isSubmittableCode(reading);

  if (!connectable) return null;

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
          <p class="connect-paste__example" aria-label="Example of the address to copy">
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
  onOpenDirectProviders,
}: Readonly<{
  oauthStatus: ConnectLaneStatus;
  providerLabel: string;
  bridgeLine: string;
  installUrl?: string;
  onOpenDirectProviders?: (provider?: CloudProviderId) => void;
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
          {onOpenDirectProviders ? (
            <button
              type="button"
              onClick={() => onOpenDirectProviders(providerLabel === "Anthropic" ? "anthropic" : "xai")}
            >
              Configure API key
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Local lane, where the button is the probe.
 *
 * "Check this machine" issues the same loopback request the provider fabric
 * uses, and the panel renders only what came back — an answer with its model
 * count, or a refusal with the reason the browser gave. Nothing is claimed
 * before the button is pressed, and nothing is inferred after it.
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
        {" "}<code>127.0.0.1:1234</code> for LM Studio, and only when you press
        Check. Your browser and the local service both have to allow this page.
      </p>
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
      </div>
      {failure ? <p class="connect-lane__failure" role="alert"><Icon name="warning" size={16} />{failure}</p> : null}
      {onOpenDirectProviders ? (
        <button type="button" onClick={onOpenDirectProviders}>Open the local model server settings</button>
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

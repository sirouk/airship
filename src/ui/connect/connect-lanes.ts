import type { SealState } from "../seal";
import { CONNECT_LANE_IDS, type ConnectLaneId } from "../access-intent";
import {
  bridgeCarriesProvider,
  bridgeRefusalReason,
  bridgeSummary,
  type ExtensionBridgeObservation,
  type ExtensionBridgeProviderId,
  type HostExtensionSupport,
} from "./extension-bridge-presence";

/**
 * The connect surface as one resolved model.
 *
 * Every string a person reads about whether a provider can be connected is
 * derived here, from observations, so the surface cannot say "recommended"
 * beside a control that errors — the failure the human review measured at ~0%
 * conversion. One vocabulary, one glyph family, one ordering rule.
 *
 * The summary is derived too, and for the same reason: it is read one line
 * above the status, so a lane whose status says "sign-in is unavailable" must
 * not carry a summary that offers sign-in. A lane never advertises an action
 * this build cannot perform, wherever the sentence sits.
 */

/**
 * The consequence, said once — and now held once.
 *
 * access-view.tsx declared this exact sentence as its own constant, with a
 * comment explaining that two spellings of one fact is the sprawl this package
 * exists to remove, and the lane row three files away still carried a retyped
 * copy of the literal. They agreed only by coincidence: the drift the comment
 * names — one of the two picking up a contraction — was a single edit away, on
 * the phone where the lane row and the panel that repeats it are stacked 40px
 * apart. It lives here because the lane is the lower module: access-view
 * already imports this file, so this direction is the one that has no cycle.
 */
export const SIGN_IN_UNAVAILABLE = "Chutes sign-in is not available in this build.";

export { CONNECT_LANE_IDS, type ConnectLaneId } from "../access-intent";

/**
 * Lane states, in the order a person should try them.
 *
 * `needs-extension` and `extension-unavailable` are separate because the honest
 * next step differs: one is "install something", the other is "this browser
 * cannot, here is what does work".
 */
export type ConnectLaneStatus =
  | Readonly<{ kind: "connected"; label: string; detail: string }>
  | Readonly<{ kind: "ready"; label: string; detail: string }>
  | Readonly<{ kind: "checking"; label: string; detail: string }>
  | Readonly<{ kind: "needs-extension"; label: string; detail: string; alternative?: string }>
  | Readonly<{ kind: "extension-unavailable"; label: string; detail: string; alternative?: string }>
  | Readonly<{ kind: "offline"; label: string; detail: string }>
  | Readonly<{ kind: "unavailable"; label: string; detail: string }>;

/**
 * A `dt`/`dd` pair a lane can show without being opened.
 *
 * Only used where the value is an observation rather than a default: the
 * Companion's relay/cache/compute readings are promoted onto its collapsed row
 * when the extension is actually answering, because a truthful positive state
 * that needs a click to see is a state nobody sees.
 */
export type ConnectLaneFact = Readonly<{ label: string; value: string }>;

export type ConnectLane = Readonly<{
  id: ConnectLaneId;
  /** The product name a person recognises, not the vendor's API name. */
  title: string;
  /**
   * The qualifier rendered on the same baseline as the title.
   *
   * Never the title again: a lane whose qualifier repeats its own name spends a
   * whole row saying nothing, which is what `Chutes` over `Chutes` did.
   */
  vendor: string;
  /** One line describing this lane in the state it is actually in. */
  summary: string;
  status: ConnectLaneStatus;
  /** Account-sign-in status when the provider also has a working key route. */
  oauthStatus?: ConnectLaneStatus;
  /** Rendered glyph state, from the app's single seal family. */
  seal: SealState;
  /** Observed values worth showing before the lane is opened. */
  facts?: readonly ConnectLaneFact[];
}>;

export type ConnectLaneInput = Readonly<{
  online: boolean;
  chutes: Readonly<{
    connected: boolean;
    /** Whether the hosted sign-in exchange is configured in this build. */
    signInAvailable: boolean;
    /** Named cause when it is not. Required by the fail-closed rule. */
    signInUnavailableReason?: string;
  }>;
  codex: Readonly<{
    connected: boolean;
    available: boolean;
    unavailableReason?: string;
  }>;
  claude: Readonly<{ connected: boolean; signInAvailable?: boolean }>;
  grok: Readonly<{ connected: boolean; signInAvailable?: boolean }>;
  /**
   * The live per-page-load handshake outcome, consumed from the bridge
   * package. `undefined` while that observation is still in flight — never a
   * stand-in for "no extension", which only a settled observation may say.
   */
  bridge: ExtensionBridgeObservation | undefined;
  host: HostExtensionSupport;
  /**
   * Where the extension can actually be added from, when this build publishes
   * such a page. Absent is the honest default: "Add the Airship extension" is
   * an instruction, and an instruction with nowhere to go cannot be followed.
   */
  extensionInstallUrl?: string;
  local: Readonly<{ connected: readonly string[] }>;
}>;

/*
 * Only the sign-in-available arm carries this, and deliberately: that arm opens
 * on the OAuth tab, so the key field — and the verbatim copy of this sentence
 * that sits under it — is not rendered. Where the key panel *is* the open one,
 * repeating it here is a second rendering of a sentence 150px below.
 */
const CHUTES_KEY_SENTENCE = "Chutes personal keys start with cpk_.";
/*
 * The lane's defining sentence, promoted out of every summary arm and into the
 * header qualifier, where it is legible while the lane is *closed*. It used to
 * be prefixed onto four summaries and the qualifier was the word "Chutes" under
 * the title "Chutes" — one string said four times, one said twice, and the
 * thing the lane is for said nowhere a closed lane could show it.
 */
const CHUTES_LANE_QUALIFIER = "Encrypted inference with per-turn evidence";
const IN_THIS_TAB = "Connected in page memory for this tab.";
const NO_INSTALL_PAGE = "This embedding did not configure the Airship Companion install hub.";
const COMPANION_TITLE = "Airship Companion";

/** Lower sorts first. Anything a person can act on now outranks anything else. */
const STATUS_RANK: Readonly<Record<ConnectLaneStatus["kind"], number>> = Object.freeze({
  connected: 0,
  ready: 1,
  checking: 2,
  "needs-extension": 3,
  "extension-unavailable": 4,
  offline: 5,
  unavailable: 5,
});

const SEAL_FOR_STATUS: Readonly<Record<ConnectLaneStatus["kind"], SealState>> = Object.freeze({
  connected: "verified",
  ready: "none",
  checking: "checking",
  "needs-extension": "attention",
  "extension-unavailable": "attention",
  offline: "stale",
  unavailable: "attention",
});

export function sealForConnectLane(status: ConnectLaneStatus): SealState {
  return SEAL_FOR_STATUS[status.kind];
}

/** What one lane says about itself, resolved together so the two cannot disagree. */
type LaneCopy = Readonly<{ summary: string; status: ConnectLaneStatus }>;

/**
 * Resolves every lane and orders them so the working paths lead.
 *
 * The sort is stable within a rank, so the canonical order in
 * `CONNECT_LANE_IDS` still decides ties and the surface does not reshuffle
 * itself between renders for reasons a person cannot see.
 */
export function describeConnectLanes(input: ConnectLaneInput): readonly ConnectLane[] {
  const providers: readonly ConnectLane[] = Object.freeze([
    lane("chutes", "Chutes", CHUTES_LANE_QUALIFIER, chutesLane(input)),
    codexProviderLane(input),
    bridgeProviderLane("claude", "Anthropic", "Claude account or API", input, "anthropic"),
    bridgeProviderLane("grok", "xAI", "Grok account or API", input, "xai"),
    lane("local", "Ollama & LM Studio", "This machine", localLane(input)),
  ]);
  return Object.freeze([
    ...providers
      .map((value, index) => Object.freeze({ value, index }))
      .sort((a, b) => (STATUS_RANK[a.value.status.kind] - STATUS_RANK[b.value.status.kind]) || (a.index - b.index))
      .map(({ value }) => value),
    /*
     * The Companion is pinned last rather than ranked, and deliberately: it is
     * the only row that connects nothing. Ranking it would let "extension
     * detected" outrank every provider on the page a person opened to connect a
     * provider — which is the 219px-desktop / 415px-phone advert this row
     * replaces, in the same vocabulary as everything around it.
     */
    companionLane(input),
  ]);
}

/**
 * What the count chip above the lane list says, and it can only say what is.
 *
 * Derived from the same resolved lanes the list renders, so the number and the
 * rows can never disagree the way a separately-computed `0 connections` badge
 * did while a connection was live.
 */
export function connectLaneCountLabel(lanes: readonly ConnectLane[]): string {
  const countable = connectableLanes(lanes);
  const connected = countable.filter((entry) => entry.status.kind === "connected");
  const ready = countable.filter((entry) => entry.status.kind === "ready").length;
  // "5 ready" beside "No model connected" reads as five models standing by.
  // The count is of ways in, so it says so: a bare adjective with no noun is
  // the one shape this label cannot afford.
  if (connected.length === 0) return `No model connected · ${String(ready)} ready to connect`;
  if (connected.length === 1) return `${connected[0]!.title} connected · ${String(ready)} more ready to connect`;
  return `${String(connected.length)} connected · ${String(ready)} more ready to connect`;
}

/** The seal beside that count: connected is the only verified state here. */
export function connectLaneCountSeal(lanes: readonly ConnectLane[]): SealState {
  return connectableLanes(lanes).some((entry) => entry.status.kind === "connected") ? "verified" : "none";
}

/**
 * The lanes a count of connections is allowed to be taken over.
 *
 * The Companion connects nothing — that is why `describeConnectLanes` pins it
 * last instead of ranking it — but its status goes `connected` the moment the
 * bridge handshake answers, and both readers above were counting it. With the
 * extension installed and no provider set up, the chip read "Airship Companion
 * connected · 4 more ready to connect" under a verified seal while all five
 * provider rows below said they were not connected. One predicate rather than
 * the id literal twice, so the number and the seal cannot drift apart.
 */
function connectableLanes(lanes: readonly ConnectLane[]): readonly ConnectLane[] {
  return lanes.filter((entry) => entry.id !== "companion");
}

function lane(id: ConnectLaneId, title: string, vendor: string, copy: LaneCopy): ConnectLane {
  return Object.freeze({
    id,
    title,
    vendor,
    summary: copy.summary,
    status: copy.status,
    seal: sealForConnectLane(copy.status),
  });
}

function bridgeProviderLane(
  id: "claude" | "grok",
  title: string,
  vendor: string,
  input: ConnectLaneInput,
  provider: ExtensionBridgeProviderId,
): ConnectLane {
  const oauth = bridgeLane(input, provider);
  const connected = provider === "anthropic" ? input.claude.connected : input.grok.connected;
  const status: ConnectLaneStatus = connected
    ? oauth.status
    : !input.online
      ? offline(title)
      : Object.freeze({
          kind: "ready" as const,
          label: oauth.status.kind === "ready" ? "OAuth or API key" : "API key ready",
          detail: oauth.status.kind === "ready"
            ? `${title} account sign-in is available, and a page-memory API key is available as an alternative.`
            : `A page-memory ${title} API key works without the extension. Account sign-in has a separate availability check below.`,
        });
  return Object.freeze({
    id,
    title,
    vendor,
    summary: connected
      ? oauth.summary
      : `${title} models through account sign-in or a page-memory API key.`,
    status,
    oauthStatus: oauth.status,
    seal: sealForConnectLane(status),
  });
}

function copy(summary: string, status: ConnectLaneStatus): LaneCopy {
  return Object.freeze({ summary, status: Object.freeze(status) });
}

function chutesLane(input: ConnectLaneInput): LaneCopy {
  if (input.chutes.connected) {
    return copy(IN_THIS_TAB, {
      kind: "connected",
      label: "Connected",
      detail: "Chutes is connected in page memory for this tab.",
    });
  }
  if (!input.online) {
    const status = offline("Chutes");
    return copy(status.detail, status);
  }
  if (input.chutes.signInAvailable) {
    return copy("Sign in, or paste an API key.", {
      kind: "ready",
      label: "Sign in or use a key",
      detail: `Sign in with your Chutes account, or paste a key. ${CHUTES_KEY_SENTENCE}`,
    });
  }
  /*
   * The recommended-but-broken button is the measured terminal drop-off for a
   * cold visitor. When the sign-in exchange is not configured in this build the
   * lane is still `ready`, because the key path genuinely works — but neither
   * the summary nor the detail may offer sign-in as a route.
   *
   * The detail is the cause and nothing else. It used to append two sentences
   * that both render elsewhere in the same open lane: the offer of the key
   * route is the summary one line above, and `CHUTES_KEY_SENTENCE` is under the
   * field itself — which in this arm is the *open* panel, because the key tab is
   * the default whenever sign-in cannot work. On a phone those two sentences
   * were 54px of restatement between a person and the field they came for.
   */
  return copy("Paste an API key to connect.", {
    kind: "ready",
    label: "Use an API key",
    detail: input.chutes.signInUnavailableReason ?? SIGN_IN_UNAVAILABLE,
  });
}

/**
 * OpenAI, described at the altitude of the lane rather than of its OAuth leg.
 *
 * `Not available here` was true of Codex sign-in and false of the lane: an
 * OpenAI API key connects from this page, and `STATUS_RANK.unavailable` sorted
 * that working route dead last. The sign-in state is not softened — it moves to
 * `oauthStatus`, which is where the method tab and its panel read from, and
 * where it is true. This is the same shape `bridgeProviderLane` already uses.
 */
function codexProviderLane(input: ConnectLaneInput): ConnectLane {
  const oauth = codexLane(input);
  const laneStatus: ConnectLaneStatus = input.codex.connected || input.codex.available || !input.online
    ? oauth.status
    : Object.freeze({
        kind: "ready" as const,
        label: "API key only",
        detail: "A page-memory OpenAI API key works without an account sign-in. The ChatGPT sign-in route has its own availability check below.",
      });
  return Object.freeze({
    id: "codex" as const,
    title: "OpenAI",
    vendor: "Codex account or API",
    summary: laneStatus === oauth.status
      ? oauth.summary
      : "OpenAI models through a page-memory API key. This build carries no ChatGPT sign-in.",
    status: laneStatus,
    oauthStatus: oauth.status,
    seal: sealForConnectLane(laneStatus),
  });
}

function codexLane(input: ConnectLaneInput): LaneCopy {
  const paste = "Sign in with your ChatGPT account. You finish by pasting one code back.";
  if (input.codex.connected) {
    return copy(`OpenAI models through your ChatGPT account. ${IN_THIS_TAB}`, {
      kind: "connected",
      label: "Connected",
      detail: "Codex is connected in page memory for this tab.",
    });
  }
  if (!input.online) return copy(paste, offline("Codex"));
  if (!input.codex.available) {
    return copy("OpenAI models. This build carries no ChatGPT sign-in, so there is no account route here.", {
      kind: "unavailable",
      label: "Not available here",
      detail: input.codex.unavailableReason ?? "Codex sign-in is not configured in this build.",
    });
  }
  return copy(paste, {
    kind: "ready",
    label: "Sign in",
    detail: "Opens OpenAI in a new tab. The page you land on afterwards will look like an error — that is expected, and the code you need is in its address bar.",
  });
}

/**
 * The Companion, as a row in the same list and the same vocabulary.
 *
 * Its state is read from the live handshake only. `undefined` is `checking`,
 * never "not installed": absence of an answer is not an answer, and the row
 * that says so must say so while the probe is still in flight.
 */
function companionLane(input: ConnectLaneInput): ConnectLane {
  const observation = input.bridge;
  const available = observation?.state === "available";
  const status = companionStatus(input);
  return Object.freeze({
    id: "companion" as const,
    title: COMPANION_TITLE,
    vendor: companionQualifier(input),
    summary: "Adds a reviewed provider relay, opt-in encrypted local cache, and bounded background hash/vector work. Provider account authorization is offered only when Airship also has a supported provider grant flow.",
    status,
    seal: sealForConnectLane(status),
    // Promoted onto the collapsed row only when the extension is answering:
    // three cells reading "Not observed / Not active / Not active" are the
    // negation the closed row's own qualifier already states.
    ...(available ? { facts: companionFacts(observation) } : {}),
  });
}

function companionQualifier(input: ConnectLaneInput): string {
  const observation = input.bridge;
  if (!observation) return "Checking this tab";
  if (observation.state === "available") {
    return observation.extensionVersion ? `Extension ${observation.extensionVersion}` : "Extension connected";
  }
  // The two not-here cases are different facts and keep different words: one
  // browser cannot load an extension at all, the other could but Airship has
  // not published one for it. Collapsing them would blame the browser for a
  // gap that is Airship's.
  if (input.host.kind === "cannot-host") return "Not possible in this browser";
  if (input.host.kind === "not-published") return "Not published for this browser";
  return input.extensionInstallUrl ? "Not installed" : "No install page in this build";
}

function companionStatus(input: ConnectLaneInput): ConnectLaneStatus {
  const observation = input.bridge;
  if (!observation) {
    return Object.freeze({
      kind: "checking" as const,
      label: "Checking",
      detail: bridgeSummary(observation),
    });
  }
  if (observation.state === "available") {
    return Object.freeze({
      kind: "connected" as const,
      label: "Connected",
      detail: bridgeSummary(observation),
    });
  }
  const hostDetail = input.host.kind === "installable"
    ? "This browser can load the Airship Companion."
    : input.host.reason;
  if (input.host.kind === "installable" && input.extensionInstallUrl) {
    return Object.freeze({
      kind: "needs-extension" as const,
      label: "Get the extension",
      detail: `${bridgeSummary(observation)} ${hostDetail}`,
    });
  }
  return Object.freeze({
    kind: "extension-unavailable" as const,
    label: input.host.kind === "installable"
      ? "Unavailable here"
      : input.host.kind === "cannot-host" ? "Not supported" : "Not published here",
    detail: `${bridgeSummary(observation)} ${input.host.kind === "installable" ? NO_INSTALL_PAGE : hostDetail}`,
  });
}

/** The three readings, with the exact value strings the `<dl>` grid carried. */
export function companionFacts(observation: ExtensionBridgeObservation | undefined): readonly ConnectLaneFact[] {
  const available = observation?.state === "available";
  const storage = observation?.companion?.storage;
  const compute = observation?.companion?.compute;
  const routes = available ? observation.providers.length : 0;
  return Object.freeze([
    Object.freeze({
      label: "Provider relay",
      value: available ? `${String(routes)} route${routes === 1 ? "" : "s"} live` : "Not observed",
    }),
    Object.freeze({
      label: "Encrypted cache",
      value: storage?.state === "available"
        ? (storage.enabled ? `${String(storage.records ?? 0)} page${storage.records === 1 ? "" : "s"}` : "Available · off")
        : "Not active",
    }),
    Object.freeze({
      label: "Background compute",
      value: compute?.state === "available" ? "Hash + vector ranking" : "Not active",
    }),
  ]);
}

function bridgeLane(
  input: ConnectLaneInput,
  provider: ExtensionBridgeProviderId,
): LaneCopy {
  const anthropic = provider === "anthropic";
  const name = anthropic ? "Claude" : "Grok";
  const vendor = anthropic ? "Anthropic" : "xAI";
  /*
   * Both vendors have a browser-direct API-key adapter in the provider fabric
   * and a `connect-src` entry for their inference host, so both lanes owe a
   * person that route. Only the *sign-in* leg is bridged.
   */
  const alternative = `An ${vendor} API key connects straight from this page and needs no extension.`;
  const connected = anthropic ? input.claude.connected : input.grok.connected;
  const models = `${vendor} models.`;

  if (connected) {
    return copy(`${models} ${IN_THIS_TAB}`, {
      kind: "connected",
      label: "Connected",
      detail: `${name} is connected in page memory for this tab.`,
    });
  }
  if (!input.bridge) {
    return copy(`${models} Airship is looking for the extension that carries ${vendor} sign-in.`, {
      kind: "checking",
      label: "Checking",
      detail: "Looking for the Airship extension in this tab.",
    });
  }
  if (bridgeCarriesProvider(input.bridge, provider)) {
    if (!input.online) return copy(models, offline(name));
    const controllerAvailable = anthropic
      ? input.claude.signInAvailable === true
      : input.grok.signInAvailable === true;
    if (!controllerAvailable) {
      return copy(`${models} The extension transport is ready, but this build has no account-flow controller for ${vendor}.`, {
        kind: "unavailable",
        label: "OAuth flow unavailable",
        detail: `The extension answered and can carry ${name}, but Airship cannot start and commit a ${vendor} account grant in this build. Use a page-memory ${vendor} API key instead.`,
      });
    }
    return copy(`${models} Sign in with your ${vendor} account — the extension in this tab carries it.`, {
      kind: "ready",
      label: "Sign in",
      detail: `The Airship extension is answering in this tab and will carry ${name}.`,
    });
  }

  const summary = `${models} Account sign-in needs the Airship extension; an API key does not.`;
  const why = `${vendor} does not let a browser page read its sign-in replies, so Airship needs the extension to carry them.`;
  if (input.bridge.state === "available") {
    const refusal = bridgeRefusalReason(input.bridge, provider);
    return copy(summary, {
      kind: "needs-extension",
      label: "Extension update needed",
      detail: `The Airship extension answered${input.bridge.extensionVersion ? ` (version ${input.bridge.extensionVersion})` : ""} but does not carry ${name}.${refusal ? ` It named the cause: ${refusal}` : ""}`,
      alternative,
    });
  }
  const host = input.host;
  if (host.kind === "installable" && input.extensionInstallUrl) {
    return copy(summary, { kind: "needs-extension", label: "Add the Airship extension", detail: why, alternative });
  }
  return copy(summary, {
    kind: "extension-unavailable",
    label: host.kind === "cannot-host" ? "Not possible in this browser" : "Extension not published here",
    detail: `${why} ${host.kind === "installable" ? NO_INSTALL_PAGE : host.reason}`,
    alternative,
  });
}

function localLane(input: ConnectLaneInput): LaneCopy {
  const models = "A model server you host yourself. No account, and nothing leaves this computer.";
  if (input.local.connected.length > 0) {
    return copy(`${models} ${IN_THIS_TAB}`, {
      kind: "connected",
      label: "Connected",
      detail: `${input.local.connected.join(" and ")} answered on this machine's loopback interface.`,
    });
  }
  /*
   * Nothing is probed until asked, so this lane must never read "detected".
   * "Ready" here means "Airship can look", not "a server is there".
   */
  return copy(models, {
    kind: "ready",
    label: "Check this machine",
    detail: "Airship has not looked yet. Checking contacts 127.0.0.1 only, and only when you ask.",
  });
}

function offline(name: string): ConnectLaneStatus {
  return Object.freeze({
    kind: "offline",
    label: "Offline",
    detail: `This browser reports no network, so ${name} cannot be reached. Nothing was changed.`,
  });
}

import type { SealState } from "../seal";
import {
  bridgeCarriesProvider,
  bridgeRefusalReason,
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

export const CONNECT_LANE_IDS = Object.freeze([
  "chutes",
  "codex",
  "claude",
  "grok",
  "local",
] as const);

export type ConnectLaneId = (typeof CONNECT_LANE_IDS)[number];

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

export type ConnectLane = Readonly<{
  id: ConnectLaneId;
  /** The product name a person recognises, not the vendor's API name. */
  title: string;
  vendor: string;
  /** One line describing this lane in the state it is actually in. */
  summary: string;
  status: ConnectLaneStatus;
  /** Account-sign-in status when the provider also has a working key route. */
  oauthStatus?: ConnectLaneStatus;
  /** Rendered glyph state, from the app's single seal family. */
  seal: SealState;
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

const CHUTES_KEY_SENTENCE = "Chutes personal keys start with cpk_.";
const CHUTES_LANE = "Encrypted inference with per-turn evidence.";
const IN_THIS_TAB = "Connected in page memory for this tab.";
const NO_INSTALL_PAGE = "This embedding did not configure the Airship Companion install hub.";

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
  const lanes: readonly ConnectLane[] = Object.freeze([
    lane("chutes", "Chutes", "Chutes", chutesLane(input)),
    lane("codex", "OpenAI", "Codex account or API", codexLane(input)),
    bridgeProviderLane("claude", "Anthropic", "Claude account or API", input, "anthropic"),
    bridgeProviderLane("grok", "xAI", "Grok account or API", input, "xai"),
    lane("local", "Ollama & LM Studio", "This machine", localLane(input)),
  ]);
  return Object.freeze(
    lanes
      .map((value, index) => Object.freeze({ value, index }))
      .sort((a, b) => (STATUS_RANK[a.value.status.kind] - STATUS_RANK[b.value.status.kind]) || (a.index - b.index))
      .map(({ value }) => value),
  );
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
    return copy(`${CHUTES_LANE} ${IN_THIS_TAB}`, {
      kind: "connected",
      label: "Connected",
      detail: "Chutes is connected in page memory for this tab.",
    });
  }
  if (!input.online) return copy(CHUTES_LANE, offline("Chutes"));
  if (input.chutes.signInAvailable) {
    return copy(`${CHUTES_LANE} Sign in, or paste an API key.`, {
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
   */
  return copy(`${CHUTES_LANE} Paste an API key to connect.`, {
    kind: "ready",
    label: "Use an API key",
    detail: `${input.chutes.signInUnavailableReason ?? "Chutes sign-in is not available in this build."} You can connect with a Chutes API key instead. ${CHUTES_KEY_SENTENCE}`,
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

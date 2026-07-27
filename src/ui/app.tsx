import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  AttestationEvidenceClientErrorCode,
  ChutesAttestationEvidenceClient,
} from "../attestation/provider-client";
import type {
  ChutesEndpointAttestationSnapshot,
  ChutesEndpointEvidenceRecord,
} from "../attestation/provider-types";
import { ApprovalBroker } from "../approvals/broker";
import { approvalProvenance, createApprovalModePolicy, type ApprovalMode } from "../approvals/modes";
import { SwitchableApprovalPolicy } from "../approvals/switchable-policy";
import { reviewToolActionWithModel } from "../approvals/model-reviewer";
import {
  DISCONNECTED_CHUTES_CONNECTION,
  isChutesConnected,
  parseChutesCredential,
  withChutesModel,
  withVerifiedInvocation,
  type ActiveChutesConnection,
  type ChutesConnection,
} from "../auth/connection";
import {
  CHUTES_ACTIVE_REGISTRATION,
  chutesOAuthLocationState,
  consumeChutesAuthorizationCallback,
  createChutesAuthorizationRequest,
  exchangeChutesAuthorizationCode,
  requireLocalChutesOAuthBridge,
  refreshChutesOAuthToken,
  type ChutesOAuthTokenSet,
  type ChutesPkceAttempt,
} from "../auth/chutes-oauth";
import type { BrowserRuntimeCapabilityReport } from "../capabilities/browser-runtime";
import {
  completeSlashCommand,
  createSlashCommandRegistry,
  planSlashCommand,
  type SlashCommandPlan,
  type SlashCommandRegistry,
  type SlashCompletion,
} from "../commands";
import { createSessionManifest } from "../core/session-manifest";
import type { InferenceTransport, SecurityPosture, SessionManifest } from "../core/contracts";
import type { InferenceDirectoryPromptDefinition } from "../core/operating-charter";
import { createSessionContextPolicy, sessionContextPoliciesMatch } from "../core/context-policy";
import { prepareCanonicalImageInputs } from "../core/multimodal";
import { EventJournal, type DurableEvent, type SessionRecord } from "../core/journal";
import { randomUuid } from "../core/id";
import { loadBrowserGit } from "../load-browser-git";
import { runTurn } from "../load-agent-runtime";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import { inspectBrowserExecutionTier } from "../load-execution-runtime";
import { MemoryJournalBackend } from "../core/memory-journal";
import type { SessionAuditReport } from "../core/session-audit";
import { DemoInferenceTransport } from "../inference/demo";
import { withoutCredential } from "../inference/credential-unavailable";
import type {
  ActivatedInferenceRoute,
  BrowserInferenceFabric,
} from "../inference/fabric";
import type {
  InspectInferenceConnectionsTool,
  InferenceAvailabilityConnection,
  InferenceAvailabilitySnapshot,
  InferenceModelDescriptor,
} from "../inference/providers";
// Import the concrete modules, never the "../git" barrel: the barrel also
// re-exports the in-memory adapter, and that retained graph edge is enough to
// pull a fixture-only Git backend into the startup chunk.
import { BrowserGitClient } from "../git/client";
import type { GitOperation, GitOperationDescriptor } from "../git/types";
import type { WorkspaceGitRepositorySeed } from "../git/workspace-adapter";
import type { ChutesInferenceTransport, ChutesInvocationTelemetry } from "../inference/chutes";
import { modelInputModalityCapability, modelPopularitySignal, sortModels, type AirshipModel } from "../models";
import type { ExecutionCapability } from "../execution/runtime-registry";
import { archiveProfileRevision, createBuiltInProfileCatalog, managedProfileRevisions, type ProfileCatalog } from "../profiles/catalog";
import {
  MemoryProfileCatalogStore,
  type ProfileCatalogCheckpoint,
  type ProfileCatalogStore,
} from "../profiles/persistence";
import {
  createGlobalSkillSettings,
  createProfileRevision,
  resolveProfileSilo,
  resolveProfileForSession,
  themeCssVariables,
  type ProfileRevision,
  type SkillMode,
  type ThemeManifest,
} from "../profiles/domain";
import type { ConversationReceipt } from "../receipts/types";
import {
  READY_SESSION_LIFECYCLE,
  SessionLibrary,
  advanceSessionLifecycle,
  type ActiveSessionRuntime,
  type SessionForkResult,
  type SessionLibraryDetail,
  type SessionLifecycle,
  type SessionListItem,
} from "../sessions";
import {
  createAirshipToolRegistry,
  createVaultAwareAirshipToolRegistry,
  createVaultBackedAirshipToolRegistry,
} from "../tools/airship-tools";
import type { FederatedMemoryResult } from "../tools/federated-memory";
import {
  VaultCoordinator,
  isGoogleDriveConfiguration,
  type DurableStateRuntime,
  type ReadyVaultRuntime,
  type VaultSnapshot,
} from "../vault/coordinator";
import type { LocalDeviceWorkspaceKey } from "../storage/local-device-keyring";
import {
  type LocalDeviceVaultHandle,
  type LocalDeviceVaultStatus,
} from "../vault/local-device";
import { isWorkspaceControlPlanePath, type WorkspaceEntry, type WorkspaceFile, type WorkspacePort } from "../workspace/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { composeClaimStack, type ClaimStackFact, type ClaimStackItem } from "./claim-stack-model";
import { ApprovalDock } from "./approval-dock";
import { attestationRecordIdForReceipt, sessionAttestationReceipts } from "./attestation-history";
import type { AttestationRefreshTarget } from "./attestations-view";
import { Icon, type IconName } from "./icons";
import type {
  LocalDeviceActivationReason,
  LocalDeviceAtomicRestoreRequest,
} from "./local-device-vault-setup";
import { chatHash, chatSessionIdFromHash } from "./chat-route";
import { MenuSelect } from "./menu-select";
import { MobileNavigation } from "./mobile-navigation";
import { ModelControl } from "./model-control";
import { CANONICAL_DESTINATIONS, navigationHashForView, navigationViewFromHash, type CanonicalDestinationId, type NavigationView } from "./navigation-model";
import {
  CommandPalette,
  PreferencesDialog,
  PwaUpdateBanner,
  TrustPostureSheet,
  TrustHubTabs,
  ViewErrorBoundary,
  applyPreferenceOverrides,
  approvalModeLabel,
  buildPaletteEntries,
  loadPreferenceOverrides,
  loadRecentSessionPaletteSources,
  savePreferenceOverrides,
  useBeforeUnloadGuard,
  useGlobalNavigationJumps,
  useGlobalPaletteShortcut,
  usePwaUpdate,
  useVisualViewport,
  worstTrustAxis,
  type PreferenceOverrides,
  type VaultBackend,
  type TrustAxis,
} from "./platform-shell";
import {
  proofHash,
  proofSelectionForReceipt,
  proofSelectionForSession,
  proofSelectionFromHash,
  proofSectionFromHash,
  resolveProofReceipt,
  type ProofSection,
  type ProofSelection,
} from "./proof-route";
import { Seal, sealStateForProofStatus, type SealState } from "./seal";
import { useScrollEdges } from "./scroll-affordance";
import { enabledSlashSelection, firstEnabledSlashIndex, moveSlashSelection } from "./slash-menu-state";
import type { SourcesImportRequest } from "./sources-view";
import { releaseVaultAuthority, transitionVaultProvider } from "./vault-provider-transition";
import {
  ASSISTANT_MESSAGE_ESTIMATE,
  USER_MESSAGE_ESTIMATE,
} from "./chat/height-index";
import {
  messagePartFactsFromDurableEvents,
  messagePartsFromDurableEvents,
  messagePlainText,
  reduceMessagePartFact,
  type MessagePart,
} from "./chat/message-parts";
import { MessagePartsView } from "./chat/message-parts-view";
import { capabilityTierDetail, capabilityTierLabel } from "./chat/capability-tier";
import { useWindowedTranscript } from "./chat/use-windowed-transcript";
import { composerAttachments, userMessageParts, type ComposerAttachment } from "./chat/composer-state";
import { MOBILE_SHELL_MEDIA_QUERY, shouldClaimComposerFocus } from "./chat/composer-focus";
import { originatingPromptForRow } from "./chat/retry-prompt";
import { recoverPartialTurn } from "./chat/turn-recovery";
import { claimThreadDraftHydration, readThreadDraft, writeThreadDraft } from "./chat/thread-draft";
import { appendThreadQueueItem, removeThreadQueueItem } from "./chat/thread-queue";
import {
  refreshCompletedTurnWorkspace,
  releaseComposerAndReloadSession,
} from "./chat/turn-housekeeping";
import { StreamingMessageSlot, TranscriptStreamStore } from "./chat/streaming-slot";
import { isNearLastRealCard, preferredJumpBehavior, scrollToLastRealCard } from "./chat/transcript-anchor";
import { TabPresenceNote } from "./tab-presence";
import { ProfileThemeSwatch } from "./profile-theme-swatch";
import { PostureChip } from "./posture-chip";
import { DurabilityIndicator, durabilityLabel } from "./durability-indicator";
import { mapUnknownRequestFailure } from "./request-state";
import { claimExpiry, claimLanguage, postureLabel, proofLevelLabel, proofStatusLabel, rankedReceiptVerdict, relativeEvidenceAge } from "./trust-language";
import { RouteSkeleton } from "./route-skeleton";
import type { LocalProviderProbeResult } from "./connect/connect-surface";
import {
  OFFLINE_INLINE_REASON,
  OFFLINE_RUNTIME_DETAIL,
  OFFLINE_RUNTIME_LABEL,
  observeConnectivity,
  readOnlineState,
  remoteComposerBlocked,
} from "./connectivity";

type View = NavigationView;
type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Immutable public projection of durable message/tool facts. */
  parts?: readonly MessagePart[];
  status?: string;
  /** Page-memory output while one model-invoked execution tool is running. */
  liveToolOutput?: Readonly<{
    operationId: string;
    stream: "stdout" | "stderr" | "combined";
    text: string;
  }>;
  receipt?: ConversationReceipt;
  error?: boolean;
  /** Original user prompt retained for explicit retry/edit recovery. */
  originatingPrompt?: string;
  /** Page-memory image handles retained only so retry/edit can preserve the exact request. */
  originatingAttachments?: readonly ComposerAttachment[];
  sourcePoint?: Readonly<{ sequence: number; digest: string }>;
  history?: Readonly<{
    turnStatus: "completed" | "failed" | "cancelled" | "incomplete";
    providerContext: "included" | "excluded";
  }>;
};

type QueuedComposerItem = Readonly<{
  id: string;
  prompt: string;
  attachments: readonly ComposerAttachment[];
}>;

/** The conversation rail is intentionally a light index, rather than a
 * miniature session inspector.  It carries just enough local metadata to let
 * a person re-find a thread without exposing runtime pins or proof state. */
type RecentConversation = Readonly<{
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  open(): void;
}>;

type RecentConversationCacheEntry = Readonly<{ preview: string; updatedAt: string }>;

type Runtime = {
  workspace: WorkspacePort;
  workspaceId: string;
  journal: EventJournal;
  profiles: ProfileCatalogStore;
  transport: InferenceTransport;
  model: string;
  /**
   * Credential-free, immutable identity of the exact inference authority used
   * when a session is created. Historical/demo sessions may omit this.
   */
  inferenceBinding?: SessionManifest["inferenceBinding"];
  /** Credential-free, live model roster injected into each new session pin. */
  inferenceDirectory?: () => InferenceDirectoryPromptDefinition;
  contextPolicy?: SessionManifest["contextPolicy"];
  contextMode?: "memory-only" | "encrypted-ranged" | "local-fallback";
  tools: Awaited<ReturnType<typeof createAirshipToolRegistry>>;
};

type ChutesAvailabilityAuthority = Readonly<{
  connection: ActiveChutesConnection;
  connectionId: string;
  generation: number;
  models: readonly AirshipModel[];
}>;

/**
 * The loopback model servers the Connect surface's Local lane may contact, and
 * nothing else: the endpoints are the fabric's compiled-in defaults, restated
 * here only so the result line can name the address that was actually tried.
 */
const LOCAL_MODEL_SERVERS = Object.freeze([
  Object.freeze({ kind: "ollama" as const, label: "Ollama", endpoint: "127.0.0.1:11434" }),
  Object.freeze({ kind: "lm-studio" as const, label: "LM Studio", endpoint: "127.0.0.1:1234" }),
]);

/** Wall clock for the whole two-server check. A refused port answers far sooner. */
const LOCAL_PROBE_DEADLINE_MS = 15_000;

const EMPTY_INFERENCE_AVAILABILITY: InferenceAvailabilitySnapshot = Object.freeze({
  version: 1,
  capturedAt: "1970-01-01T00:00:00.000Z",
  connections: Object.freeze([]),
  omittedConnections: 0,
});

type DurableAdoptionDescriptor = Readonly<{
  ready: DurableStateRuntime;
  workspaceId: string;
  label: string;
  kind: "cloud" | "local-device";
  source: "migrate-active" | "target-authoritative";
}>;

type OAuthCallbackStatus = { kind: "verified" | "blocked" | "error"; message: string };
type AttestationsScreenComponent = typeof import("./attestations-view").AttestationsView;
type EditorScreenComponent = typeof import("./editor-view").EditorView;
type TerminalScreenComponent = typeof import("./terminal-view").TerminalView;
type CapabilitiesScreenComponent = typeof import("./capabilities-view").CapabilitiesView;
type MemoryScreenComponent = typeof import("./memory-view").MemoryView;
type GoogleDriveSetupComponent = typeof import("./google-drive-setup").GoogleDriveSetup;
type LocalLabSetupComponent = typeof import("./local-lab-setup").LocalLabSetup;
type LocalDeviceVaultSetupComponent = typeof import("./local-device-vault-setup").LocalDeviceVaultSetup;
type SessionsScreenComponent = typeof import("./sessions-route").SessionsView;
type VaultScreenComponent = typeof import("./vault-view").VaultView;
type AccessScreenComponent = typeof import("./access-view").AccessView;
type ProviderConnectionsScreenComponent = typeof import("./provider-connections-view").ProviderConnectionsView;
type BillingScreenComponent = typeof import("./billing-view").BillingView;
type ProofScreenComponent = typeof import("./proof-view").ProofView;
const WORKSPACE_EDITOR_BYTE_LIMIT = 128 * 1024;
class MountedAttestationError extends Error {
  readonly name = "AttestationEvidenceClientError";

  constructor(
    readonly code: AttestationEvidenceClientErrorCode,
    message: string,
    readonly context: Readonly<{ retryable?: boolean; status?: number }> = {},
  ) {
    super(message);
  }
}
type AttestationAcquisitionFailure = Readonly<{
  label: string;
  scope: "connection" | "endpoint" | "receipt";
  receiptId?: string;
  instanceId?: string;
  endpointKeyDigest?: string;
}>;
type ProfileEditorDraft = {
  profileId: string;
  name: string;
  description: string;
  systemPrompt: string;
  themeId: string;
  workspaceBinding: "active-workspace" | "workspace-id";
  workspaceId: string;
  memoryScope: "session" | "profile" | "workspace";
  approvalMode: "ask-first" | "auto-approve" | "full-access";
  minimumPosture: SecurityPosture;
};

const CHUTES_OAUTH_ATTEMPT_KEY = "airship.chutes.oauth-attempt.v1";

/**
 * Baked loopback MinIO vault (compose.local-lab.yaml). The "local-lab" storage
 * preference auto-connects this; flip Preferences → Storage to "Ephemeral" to
 * run fully in page memory even while this S3 is available. Dev-only; the fixed
 * key keeps the throwaway local vault decryptable across reloads.
 */
const LOCAL_LAB_VAULT = Object.freeze({
  endpoint: "http://127.0.0.1:9900",
  region: "us-east-1",
  bucket: "airship-dev",
  namespace: "airship-live-v2/local-user",
  accessKeyId: "airship-vault-probe",
  secretAccessKey: "airship-vault-probe-only-2026",
});
const LOCAL_LAB_TEST_NAMESPACE_PARAMETER = "airshipLabNamespace";
const LOCAL_DEVICE_PARTITION = "airship-workspace-v1";

export function isLoopbackAirshipLocation(location?: Pick<Location, "hostname">): boolean {
  const hostname = location?.hostname.trim().toLocaleLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Keep automated browser work out of the operator's visible local-user vault. */
export function localLabVaultConfiguration(location?: Pick<Location, "hostname" | "search">) {
  if (!location || !isLoopbackAirshipLocation(location)) {
    throw new TypeError("Baked MinIO configuration is available only on an exact loopback Airship origin.");
  }
  const candidate = new URLSearchParams(location.search).get(LOCAL_LAB_TEST_NAMESPACE_PARAMETER) ?? "";
  if (!/^airship-live-v2\/e2e\/[a-z0-9][a-z0-9-]{0,80}$/u.test(candidate)) return LOCAL_LAB_VAULT;
  return Object.freeze({ ...LOCAL_LAB_VAULT, namespace: candidate });
}
const LOCAL_LAB_DEV_KEY = Object.freeze([
  0xa1, 0x25, 0x7f, 0x0c, 0x93, 0x4e, 0xd8, 0x62, 0x1b, 0xf4, 0x30, 0xa9, 0x57, 0x8e, 0x6d, 0x14,
  0xc2, 0x0b, 0x9a, 0x46, 0xe3, 0x71, 0x58, 0xbd, 0x2f, 0x84, 0xd0, 0x6a, 0x39, 0xf7, 0x1c, 0x50,
]);

const navigationIcons: Readonly<Record<CanonicalDestinationId, IconName>> = Object.freeze({
  chat: "chat", workspace: "workspace", memory: "memory",
  profiles: "profiles", vault: "cloud", attestations: "attestation", proof: "proof", access: "access",
});
const navigation = CANONICAL_DESTINATIONS.map((item) => Object.freeze({ ...item, icon: navigationIcons[item.id] }));

const welcomeMessage: UiMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "The edge runtime is ready. The workspace, editor, terminal and browser-owned Git already work in this tab with no account. Real model-backed chat needs a provider; until you connect one, the composer uses a deterministic local demo.",
};

const PROFILE_DRAFT_DISCARD_PROMPT = "Discard unsaved profile edits?";

/**
 * Entry points for a fresh transcript.
 *
 * A card that cannot work without inference must not render while nothing is
 * connected: every disconnected card here goes somewhere that already works,
 * rather than prefilling a prompt whose only possible answer is the demo
 * responder's canned sentence.
 */
type StarterCard = Readonly<{
  title: string;
  hint: string;
  action:
    | Readonly<{ kind: "prompt"; prompt: string }>
    | Readonly<{ kind: "route"; view: NavigationView }>;
}>;

const CONNECTED_STARTERS: readonly StarterCard[] = Object.freeze([
  Object.freeze({
    title: "Explain my trust posture",
    hint: "What's encrypted, attested, and still unverified",
    action: Object.freeze({
      kind: "prompt" as const,
      prompt: "Walk me through this session's current security posture: what is encrypted, what is attested, and what remains unverified.",
    }),
  }),
  Object.freeze({
    title: "Inspect this workspace",
    hint: "Read README.md and get oriented",
    action: Object.freeze({
      kind: "prompt" as const,
      prompt: "Inspect README.md and the workspace, then summarize what this project is and suggest a sensible first task.",
    }),
  }),
  Object.freeze({
    title: "What can run here?",
    hint: "Available browser execution runtimes",
    action: Object.freeze({
      kind: "prompt" as const,
      prompt: "What execution runtimes are available in this browser right now, and what needs activation before you can run code?",
    }),
  }),
]);

const DISCONNECTED_STARTERS: readonly StarterCard[] = Object.freeze([
  Object.freeze({
    title: "Open a terminal",
    hint: "Real processes in this tab, no account",
    action: Object.freeze({ kind: "route" as const, view: "terminal" as const }),
  }),
  Object.freeze({
    title: "Browse the workspace",
    hint: "Files, the editor and browser-owned Git",
    action: Object.freeze({ kind: "route" as const, view: "workspace" as const }),
  }),
  Object.freeze({
    title: "Connect a model",
    hint: "Only chat needs this",
    action: Object.freeze({ kind: "route" as const, view: "access" as const }),
  }),
]);

function uiMessageKey(message: UiMessage): string {
  return message.id;
}

function uiMessageRevision(message: UiMessage): string {
  return [
    message.content.length,
    message.content.slice(-32),
    message.parts?.map(messagePartRevision).join("|") ?? "",
    message.status ?? "",
    message.receipt?.receiptId ?? "",
    message.error ? "error" : "ok",
  ].join(":");
}

function messagePartRevision(part: MessagePart): string {
  const state = part.kind === "tool-call" || part.kind === "tool-result" || part.kind === "attachment"
    ? part.status
    : part.kind === "error"
      ? `${part.code ?? "error"}:${part.retryable ? "retry" : "terminal"}`
      : "";
  return `${part.id}:${String(part.endSequence)}:${state}`;
}

function uiMessageEstimate(message: UiMessage): number {
  return message.role === "assistant" ? ASSISTANT_MESSAGE_ESTIMATE : USER_MESSAGE_ESTIMATE;
}

async function loadRecentConversations(
  library: SessionLibrary,
  open: (sessionId: string) => void,
  signal: AbortSignal,
  profileId: string,
  cache: Map<string, RecentConversationCacheEntry>,
): Promise<readonly RecentConversation[]> {
  const page = await library.list({ sort: "updated-desc", limit: 10, profileId }, signal);
  if (signal.aborted) return Object.freeze([]);
  const conversations = await Promise.all(page.items.map(async (item) => recentConversationFor(item, library, open, signal, cache)));
  if (signal.aborted) return Object.freeze([]);
  return Object.freeze(conversations);
}

async function recentConversationFor(
  item: SessionListItem,
  library: SessionLibrary,
  open: (sessionId: string) => void,
  signal: AbortSignal,
  cache: Map<string, RecentConversationCacheEntry>,
): Promise<RecentConversation> {
  const cached = cache.get(item.id);
  let preview = cached?.updatedAt === item.updatedAt ? cached.preview : undefined;
  if (!preview) {
    preview = "No messages yet";
    try {
      const detail = await library.inspect(item.id, undefined, signal);
      const lastMessage = detail.transcript.messages.at(-1);
      if (lastMessage) preview = conversationPreview(lastMessage.content, lastMessage.role);
    } catch (error) {
      if (signal.aborted) throw error;
      // The index should stay useful even if an old record cannot be materialized.
      preview = "Conversation ready";
    }
    cache.set(item.id, Object.freeze({ preview, updatedAt: item.updatedAt }));
  }
  return Object.freeze({ id: item.id, title: item.title, preview, updatedAt: item.updatedAt, open: () => open(item.id) });
}

function conversationPreview(value: string, role: "user" | "assistant"): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean) return role === "assistant" ? "Airship replied" : "You sent a message";
  const prefix = role === "assistant" ? "Airship: " : "You: ";
  const maximum = 72 - prefix.length;
  return `${prefix}${clean.length > maximum ? `${clean.slice(0, Math.max(1, maximum - 1))}…` : clean}`;
}

function formatConversationTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" },
  ).format(date);
}

export function App() {
  const [view, setView] = useState<View>(() => readViewHash());
  const [online, setOnline] = useState(() => readOnlineState(
    typeof navigator === "undefined" ? undefined : navigator,
  ));
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [trustSheetOpen, setTrustSheetOpen] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [preferences, setPreferences] = useState<PreferenceOverrides>(loadPreferenceOverrides);
  const [catalog, setCatalog] = useState<ProfileCatalog>();
  const [profileId, setProfileId] = useState("general");
  const [profileHubScope, setProfileHubScope] = useState("global");
  const [sessionId, setSessionId] = useState<string>();
  const [activeSessionRecord, setActiveSessionRecord] = useState<SessionRecord>();
  const [chatRouteRequest, setChatRouteRequest] = useState<string | undefined>(() =>
    typeof window === "undefined" ? undefined : chatSessionIdFromHash(window.location.hash)
  );
  const [sessionLibrary, setSessionLibrary] = useState<SessionLibrary>();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [chatNavExpanded, setChatNavExpanded] = useState(true);
  const [profileNavExpanded, setProfileNavExpanded] = useState(true);
  const [recentPaletteSessions, setRecentPaletteSessions] = useState<readonly Readonly<{ id: string; title: string; open(): void }>[]>([]);
  const [recentProfileConversations, setRecentProfileConversations] = useState<readonly RecentConversation[]>([]);
  const [proofSelection, setProofSelection] = useState<ProofSelection | undefined>(() =>
    typeof window === "undefined" ? undefined : proofSelectionFromHash(window.location.hash)
  );
  const [proofSection, setProofSection] = useState<ProofSection>(() =>
    typeof window === "undefined" ? "summary" : proofSectionFromHash(window.location.hash)
  );
  const [gitClient, setGitClient] = useState<BrowserGitClient>();
  const [messages, setMessages] = useState<UiMessage[]>([welcomeMessage]);
  const [unreadTurnCount, setUnreadTurnCount] = useState(0);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [composerNotice, setComposerNotice] = useState<string>();
  const [messageQueue, setMessageQueue] = useState<readonly QueuedComposerItem[]>([]);
  const [slashRegistry, setSlashRegistry] = useState<SlashCommandRegistry>();
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashMenuDismissedFor, setSlashMenuDismissedFor] = useState<string>();
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile>();
  const [busy, setBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState("Starting local kernel");
  const [eventCount, setEventCount] = useState(0);
  const [connection, setConnection] = useState<ChutesConnection>(DISCONNECTED_CHUTES_CONNECTION);
  const [availableModels, setAvailableModels] = useState<readonly AirshipModel[]>([]);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<ConversationReceipt>();
  const [sessionLifecycle, setSessionLifecycle] = useState<SessionLifecycle>(READY_SESSION_LIFECYCLE);
  const [transcriptBoundary, setTranscriptBoundary] = useState<Readonly<{
    omittedMessages: number;
    shortened: boolean;
  }>>();
  const [transcriptLeadingHeight, setTranscriptLeadingHeight] = useState(0);
  const [transcriptDetached, setTranscriptDetached] = useState(false);
  const [invocationTelemetry, setInvocationTelemetry] = useState<ChutesInvocationTelemetry>();
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [oauthCallbackStatus, setOauthCallbackStatus] = useState<OAuthCallbackStatus>();
  const [oauthBootstrapRevision, setOauthBootstrapRevision] = useState(0);
  const [oauthTokenRevision, setOauthTokenRevision] = useState(0);
  const [attestationRecords, setAttestationRecords] = useState<readonly ChutesEndpointEvidenceRecord[]>([]);
  const [attestationFailure, setAttestationFailure] = useState<AttestationAcquisitionFailure>();
  const [attestationNow, setAttestationNow] = useState(() => Date.now());
  const [selectedAttestationRecordId, setSelectedAttestationRecordId] = useState<string>();
  const [AttestationsScreen, setAttestationsScreen] = useState<AttestationsScreenComponent>();
  const [attestationsViewError, setAttestationsViewError] = useState<string>();
  const [EditorScreen, setEditorScreen] = useState<EditorScreenComponent>();
  const [editorViewError, setEditorViewError] = useState<string>();
  const [TerminalScreen, setTerminalScreen] = useState<TerminalScreenComponent>();
  const [terminalViewError, setTerminalViewError] = useState<string>();
  const [CapabilitiesScreen, setCapabilitiesScreen] = useState<CapabilitiesScreenComponent>();
  const [capabilitiesViewError, setCapabilitiesViewError] = useState<string>();
  const [MemoryScreen, setMemoryScreen] = useState<MemoryScreenComponent>();
  const [memoryViewError, setMemoryViewError] = useState<string>();
  const [GoogleDriveSetupScreen, setGoogleDriveSetupScreen] = useState<GoogleDriveSetupComponent>();
  const [LocalLabSetupScreen, setLocalLabSetupScreen] = useState<LocalLabSetupComponent>();
  const [LocalDeviceVaultSetupScreen, setLocalDeviceVaultSetupScreen] = useState<LocalDeviceVaultSetupComponent>();
  const [SessionsScreen, setSessionsScreen] = useState<SessionsScreenComponent>();
  const [VaultScreen, setVaultScreen] = useState<VaultScreenComponent>();
  const [vaultViewError, setVaultViewError] = useState<string>();
  const [AccessScreen, setAccessScreen] = useState<AccessScreenComponent>();
  const [ProviderConnectionsScreen, setProviderConnectionsScreen] = useState<ProviderConnectionsScreenComponent>();
  const [accessViewError, setAccessViewError] = useState<string>();
  const [BillingScreen, setBillingScreen] = useState<BillingScreenComponent>();
  const [billingViewError, setBillingViewError] = useState<string>();
  const [ProofScreen, setProofScreen] = useState<ProofScreenComponent>();
  const [proofViewError, setProofViewError] = useState<string>();
  const runtime = useRef<Runtime>();
  const catalogCheckpoint = useRef<ProfileCatalogCheckpoint>();
  const catalogMutationTail = useRef<Promise<void>>(Promise.resolve());
  const workspaceOpenRequest = useRef(0);
  const inferenceRouteChanging = useRef(false);
  const approvalBroker = useMemo(() => new ApprovalBroker(), []);
  const transcriptStreams = useMemo(() => new TranscriptStreamStore(), []);
  /** A conversation pin wins over global preferences; historical sessions stay semantically intact. */
  const activeApprovalMode = activeSessionRecord?.manifest.profile?.version === 2
    ? activeSessionRecord.manifest.profile.approvalMode
    : preferences.approvalMode;
  const approvalModePolicy = useMemo(() => createApprovalModePolicy({
    mode: activeApprovalMode,
    broker: approvalBroker,
    safetyReview: async (tool, argumentsValue, context) => {
      const active = runtime.current;
      if (!active) return { verdict: "indeterminate", reason: "No active inference runtime is available." };
      return reviewToolActionWithModel({
        transport: active.transport,
        model: active.model,
        tool,
        argumentsValue,
        context,
      });
    },
  }), [approvalBroker, activeApprovalMode]);
  const approvalPolicyController = useMemo(() => new SwitchableApprovalPolicy(approvalModePolicy), []);
  approvalPolicyController.replace(approvalModePolicy);
  const approvalPolicy = approvalPolicyController;
  const previousApprovalMode = useRef(activeApprovalMode);
  const vault = useMemo(() => new VaultCoordinator(), []);
  const [vaultSnapshot, setVaultSnapshot] = useState<VaultSnapshot>(() => vault.snapshot);
  const [vaultSetupOpen, setVaultSetupOpen] = useState(false);
  const [vaultProviderSwitching, setVaultProviderSwitching] = useState(false);
  const vaultProviderSwitchingRef = useRef(false);
  const activeDurableAuthority = useRef<DurableAdoptionDescriptor>();
  const localDeviceHandle = useRef<LocalDeviceVaultHandle>();
  const [localDeviceStatus, setLocalDeviceStatus] = useState<LocalDeviceVaultStatus>();
  const [localDeviceBusy, setLocalDeviceBusy] = useState(false);
  const localDeviceAutoOpenOwner = useRef(0);
  const [localDeviceError, setLocalDeviceError] = useState<string>();
  const [driveReauthorizing, setDriveReauthorizing] = useState(false);
  const driveReauthorizingRef = useRef(false);
  const [vaultContextPublishing, setVaultContextPublishing] = useState(false);
  const [vaultContextPublicationMessage, setVaultContextPublicationMessage] = useState<string>();
  const vaultContextPublication = useRef<AbortController>();
  const oauthTokens = useRef<ChutesOAuthTokenSet>();
  const pendingOAuthCredential = useRef<string>();
  const accountCredential = useRef<string>();
  const providerCredential = useRef<string>();
  const chutesTransport = useRef<ChutesInferenceTransport>();
  const chutesConnectionId = useRef<string>();
  const chutesConnectionGeneration = useRef(0);
  const chutesAuthorityRevision = useRef(0);
  const chutesAvailability = useRef<ChutesAvailabilityAuthority>();
  const [activeExternalRoute, setActiveExternalRoute] = useState<ActivatedInferenceRoute>();
  const activeExternalRouteRef = useRef<ActivatedInferenceRoute>();
  const inferenceFabric = useRef<BrowserInferenceFabric>();
  const [providerFabricRevision, setProviderFabricRevision] = useState(0);
  const providerAvailabilityTool = useRef<InspectInferenceConnectionsTool>();
  const attestationClient = useRef<ChutesAttestationEvidenceClient>();
  const attestationOperation = useRef(0);
  const activeTurn = useRef<AbortController>();
  const localCommandAdmission = useRef(false);
  const activePrompt = useRef<string>();
  const activeSessionIdentity = useRef<string>();
  const queuedMessagesBySession = useRef(new Map<string, readonly QueuedComposerItem[]>());
  const queuedDispatch = useRef(false);
  const draftHydrationIdentity = useRef<string>();
  const preserveComposerForDraftIdentity = useRef<string>();
  const chatRouteOpening = useRef<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcriptElement = useRef<HTMLDivElement>(null);
  const transcriptBoundaryElement = useRef<HTMLDivElement>(null);
  const transcriptPinned = useRef(true);
  const transcriptEntryAlignment = useRef(true);
  const attachmentPreviewUrls = useRef(new Set<string>());
  const recentConversationPreviewCache = useRef(new Map<string, RecentConversationCacheEntry>());
  const mainRegion = useRef<HTMLElement>(null);
  const primaryNav = useRef<HTMLElement>(null);
  const pendingDelta = useRef<{ messageId: string; text: string }>();
  const pendingDeltaFrame = useRef<number>();
  const profileOperation = useRef(0);
  const sessionNavigationChanging = useRef(false);
  const catalogAuthorityChanging = useRef(false);
  const vaultAdoptionBusy = useRef(false);
  const ephemeralAdoptionBusy = useRef(false);
  const profileDraftDirty = useRef(false);
  const currentView = useRef<View>(view);
  currentView.current = view;
  const searchMemoryForUi = useMemo(() => async (query: string, signal: AbortSignal): Promise<FederatedMemoryResult> => {
    const active = runtime.current;
    const authoritySessionId = activeSessionIdentity.current ?? sessionId;
    if (!active || !authoritySessionId) throw new Error("The active accountable session is not ready.");
    const tool = active.tools.get("search_memory");
    if (!tool || tool.definition.effect !== "read") throw new Error("Federated memory search is not installed in this agent runtime.");
    const operationId = `memory-ui-${randomUuid()}`;
    const response = await tool.execute({ query, limitPerGroup: 8 }, {
      sessionId: authoritySessionId,
      turnId: operationId,
      operationId,
      signal,
    });
    if (response.isError) throw new Error(response.content || "Federated memory search failed safely.");
    return JSON.parse(response.content) as FederatedMemoryResult;
  }, [sessionId]);

  useGlobalPaletteShortcut(() => setPaletteOpen((open) => !open));
  useGlobalNavigationJumps(navigatePrimary);
  useBeforeUnloadGuard(busy || Boolean(sessionId));
  useVisualViewport();
  useEffect(() => () => {
    for (const url of attachmentPreviewUrls.current) URL.revokeObjectURL(url);
    attachmentPreviewUrls.current.clear();
  }, []);
  useEffect(() => {
    const connectionId = chutesConnectionId.current;
    if (!isChutesConnected(connection) || !connectionId) {
      chutesAvailability.current = undefined;
      return;
    }
    chutesAvailability.current = Object.freeze({
      connection,
      connectionId,
      generation: Math.max(1, chutesConnectionGeneration.current),
      models: Object.freeze(availableModels.slice()),
    });
  }, [connection, availableModels]);
  const pwaUpdate = usePwaUpdate();
  const providerAvailability = useMemo(
    () => combinedInferenceAvailability(
      inferenceFabric.current?.availability(activeExternalRoute?.pin)
        ?? EMPTY_INFERENCE_AVAILABILITY,
      chutesAvailability.current,
      activeSessionRecord?.manifest.inferenceBinding ?? runtime.current?.inferenceBinding,
    ),
    [providerFabricRevision, activeExternalRoute, connection, availableModels, activeSessionRecord],
  );

  const activeProfile = catalog?.profiles.find((profile) => profile.profileId === profileId);
  const activeProfileRef = useRef<ProfileRevision>();
  activeProfileRef.current = activeProfile;
  const activeTheme = activeProfile
    ? catalog?.themes.find((theme) => theme.themeId === activeProfile.theme.themeId && theme.digest === activeProfile.theme.digest)
    : undefined;
  /** True once the boot screen has been replaced by the real shell chrome. */
  const shellMounted = Boolean(catalog && activeProfile && activeTheme);
  const chutesConnected = isChutesConnected(connection);
  const activeInferenceBinding = activeSessionRecord?.manifest.inferenceBinding
    ?? runtime.current?.inferenceBinding;
  const activeChutesAuthorityId = chutesConnectionId.current;
  const activeChutesConnection = chutesConnected
    && Boolean(activeChutesAuthorityId)
    && activeInferenceBinding !== undefined
    && activeInferenceBinding?.connectionId === activeChutesAuthorityId
    && activeInferenceBinding.connectionGeneration === Math.max(1, chutesConnectionGeneration.current)
    && activeInferenceBinding.providerId === "chutes"
    && activeInferenceBinding.providerLabel === "Chutes"
    && activeInferenceBinding.providerRevision === 1
    && activeInferenceBinding.authMethod === (connection.kind === "chutes-oauth" ? "oauth-pkce" : "api-key")
    && activeInferenceBinding.transportBoundary === "e2ee-attestable"
    && activeInferenceBinding.modelId === connection.model;
  const activeExternalResolution = activeExternalRoute && inferenceFabric.current
    ? inferenceFabric.current.resolve(activeExternalRoute.pin)
    : undefined;
  /*
   * Which providers hold a live page-memory connection, read from the fabric
   * this render. `providerFabricRevision` is the fabric's own change signal, so
   * a released connection stops being claimed on the very next render. Before
   * the fabric loads this is empty, which can only under-claim.
   */
  const connectedInferenceProviderIds = useMemo(
    () => (inferenceFabric.current?.list() ?? []).map((entry) => entry.provider.id),
    [providerFabricRevision, Boolean(inferenceFabric.current)],
  );
  const pinnedExternalRoute = activeExternalRoute
    && activeInferenceBinding
    && inferenceBindingsMatch(activeInferenceBinding, coreInferenceBinding(activeExternalRoute))
      ? activeExternalRoute
      : undefined;
  const activeExternalConnection = pinnedExternalRoute
    && activeExternalResolution?.state === "ready"
      ? pinnedExternalRoute
      : undefined;
  const inferenceConnected = Boolean(activeChutesConnection || activeExternalConnection);
  const activeChutesModel = chutesConnected
    ? availableModels.find((model) => model.id === connection.model)
    : undefined;
  const activeExternalModel = activeExternalConnection?.models.find((model) =>
    model.id === activeInferenceBinding?.modelId
  );
  const inferenceStatusLabel = activeChutesConnection
    ? `Chutes · ${compactModelLabel(activeChutesModel?.id ?? connection.model)}`
    : activeExternalConnection
      ? `${activeExternalConnection.pin.provider.label} · ${compactModelLabel(activeExternalModel?.label ?? activeExternalConnection.pin.model.id)}`
      : pinnedExternalRoute
        ? `${pinnedExternalRoute.pin.provider.label} · disconnected`
        : activeInferenceBinding?.providerId === "chutes"
          ? "Chutes · disconnected"
          : "Connect a model";
  const inferenceStatusDetail = activeChutesConnection
    ? `${connection.model} · ${connection.invokeAuthorization === "verified" ? "encrypted invocation verified" : "encrypted invocation ready; permission not tested yet"}`
    : activeExternalConnection
      ? `${activeExternalConnection.pin.model.id} · invocation checked · ${inferenceBoundaryLabel(activeExternalConnection.pin.provider.transportBoundary)}`
      : pinnedExternalRoute && activeExternalResolution && activeExternalResolution.state !== "ready"
        ? `${pinnedExternalRoute.pin.model.id} remains pinned to this conversation. ${activeExternalResolution.detail}`
        : activeInferenceBinding?.providerId === "chutes"
          ? `${activeInferenceBinding.modelId} remains as a read-only pin. Reconnecting Chutes starts a new pinned conversation.`
          : "Connect Chutes, another cloud provider, Ollama, or LM Studio. Local slash commands remain available without inference.";
  const imageInputCapability = activeChutesConnection && activeChutesModel
    ? modelInputModalityCapability(activeChutesModel, "image")
    : activeExternalModel
      ? providerModelCapability(activeExternalModel, "image-input")
      : "unsupported";
  const activeRemoteInference = activeInferenceBinding?.transportBoundary === "e2ee-attestable"
    || activeInferenceBinding?.transportBoundary === "provider-tls";
  const sessionRuntime = activeSessionRecord && runtime.current
    ? activeSessionRuntime(runtime.current, activeSessionRecord)
    : undefined;
  const slashCompletions = useMemo(
    () => slashRegistry ? completeSlashCommand(input, slashRegistry, { limit: 10 }) : [],
    [input, slashRegistry],
  );
  const paletteEntries = useMemo(() => buildPaletteEntries({
    navigate: navigatePrimary,
    openPreferences: () => setPreferencesOpen(true),
    commands: slashRegistry?.descriptors(),
    sessions: recentPaletteSessions,
    runCommand: (command) => {
      setInput(command);
      navigate("chat");
      requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
    },
  }), [slashRegistry, lastReceipt, sessionId, recentPaletteSessions]);
  const slashMenuOpen = slashCompletions.length > 0 && !busy && slashMenuDismissedFor !== input;
  const composerPlan = useMemo(
    () => input.trim() && slashRegistry ? planSlashCommand(input.trim(), slashRegistry) : undefined,
    [input, slashRegistry],
  );
  const composerOfflineBlocked = remoteComposerBlocked(
    online,
    Boolean(inferenceConnected && activeRemoteInference),
    Boolean(composerPlan && composerPlan.kind !== "chat"),
  );
  const composerUsesDemo = !inferenceConnected && (!composerPlan || composerPlan.kind === "chat");
  const windowedTranscript = useWindowedTranscript({
    items: messages,
    scrollContainerRef: transcriptElement,
    getKey: uiMessageKey,
    getRevision: uiMessageRevision,
    estimateHeight: uiMessageEstimate,
    leadingOffset: transcriptLeadingHeight,
  });
  const inPageReceipts = useMemo(
    () => messages.flatMap((message) => message.receipt ? [message.receipt] : []),
    [messages],
  );

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const inputRow = element.closest<HTMLElement>(".composer-input-row");
    const fit = () => {
      const style = getComputedStyle(element);
      const minimum = parseFloat(style.minHeight) || 52;
      const maximum = parseFloat(style.maxHeight) || 180;
      element.style.height = `${minimum}px`;
      if (!input) {
        inputRow?.removeAttribute("data-multiline");
        element.style.overflowY = "hidden";
        return;
      }
      // Measure against the full composer width before deciding whether the
      // footer needs its own row. This avoids a narrow inline toolbar making a
      // short prompt oscillate between compact and multiline layouts.
      inputRow?.toggleAttribute("data-multiline", Boolean(input));
      let natural = element.scrollHeight;
      if (natural <= minimum + 1) {
        inputRow?.removeAttribute("data-multiline");
        natural = element.scrollHeight;
      }
      element.style.height = `${Math.min(maximum, Math.max(minimum, natural))}px`;
      element.style.overflowY = natural > maximum ? "auto" : "hidden";
    };
    fit();
    const resizeTargets = [window, window.visualViewport];
    resizeTargets.forEach((target) => target?.addEventListener("resize", fit));
    return () => {
      resizeTargets.forEach((target) => target?.removeEventListener("resize", fit));
    };
  }, [input]);

  useEffect(() => setSlashSelection(Math.max(0, firstEnabledSlashIndex(slashCompletions))), [input, slashCompletions]);
  useEffect(() => observeConnectivity(window, navigator, setOnline), []);
  useEffect(() => {
    if (!sessionLibrary) { setRecentPaletteSessions([]); return; }
    const controller = new AbortController();
    void loadRecentSessionPaletteSources(
      sessionLibrary,
      (targetSessionId) => { void openPaletteSession(targetSessionId); },
      controller.signal,
    ).then(setRecentPaletteSessions).catch((error) => {
      if (!controller.signal.aborted) setRuntimeStatus(error instanceof Error ? error.message : "Recent sessions are unavailable.");
    });
    return () => controller.abort();
  }, [sessionLibrary, sessionRevision]);
  useEffect(() => {
    if (
      view !== "chat"
      || !chatRouteRequest
      || !sessionLibrary
      || !sessionRuntime
      || !catalog
      || busy
      || chatRouteOpening.current === chatRouteRequest
    ) return;
    if (sessionId === chatRouteRequest) {
      setChatRouteRequest(undefined);
      return;
    }
    const requestedSessionId = chatRouteRequest;
    chatRouteOpening.current = requestedSessionId;
    void sessionLibrary.inspect(requestedSessionId, sessionRuntime)
      .then((detail) => resumeLibrarySession(detail))
      .then(() => {
        setChatRouteRequest((current) => current === requestedSessionId ? undefined : current);
        setComposerNotice(undefined);
      })
      .catch((error) => {
        // Keep the URL intact: a durable conversation can become available
        // after its Vault or exact inference connection is restored.
        setComposerNotice(
          error instanceof Error
            ? `This conversation link is not available in the current runtime: ${error.message}`
            : "This conversation link is not available in the current runtime. Connect its Vault and exact inference provider, then retry.",
        );
      })
      .finally(() => {
        if (chatRouteOpening.current === requestedSessionId) chatRouteOpening.current = undefined;
      });
  }, [busy, catalog, chatRouteRequest, sessionId, sessionLibrary, sessionRuntime, view]);
  useEffect(() => {
    if (view !== "chat" || chatRouteRequest || !sessionId) return;
    // A hash navigation can land between this effect being scheduled and
    // committed. Do not let a stale chat render rewrite a newer route such as
    // #sessions back to its canonical conversation URL.
    if (navigationViewFromHash(window.location.hash) !== "chat") return;
    const target = chatHash(sessionId);
    if (window.location.hash !== target) {
      window.history.replaceState({ view: "chat", sessionId }, "", target);
    }
  }, [chatRouteRequest, sessionId, view]);
  useEffect(() => {
    if (!sessionLibrary || !profileId) { setRecentProfileConversations([]); return; }
    const controller = new AbortController();
    void loadRecentConversations(
      sessionLibrary,
      (targetSessionId) => { void openPaletteSession(targetSessionId); },
      controller.signal,
      profileId,
      recentConversationPreviewCache.current,
    ).then(setRecentProfileConversations).catch((error) => {
      if (!controller.signal.aborted) setRuntimeStatus(error instanceof Error ? error.message : "Recent conversations are unavailable.");
    });
    return () => controller.abort();
  }, [sessionLibrary, sessionRevision, profileId]);
  useEffect(() => {
    if (!slashMenuOpen) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`slash-option-${slashSelection}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [slashMenuOpen, slashSelection]);
  useEffect(() => {
    const element = transcriptBoundaryElement.current;
    if (!element || !transcriptBoundary) {
      setTranscriptLeadingHeight(0);
      return;
    }
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const style = getComputedStyle(element);
      setTranscriptLeadingHeight(
        element.getBoundingClientRect().height +
        Number.parseFloat(style.marginTop || "0") +
        Number.parseFloat(style.marginBottom || "0"),
      );
    };
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(measure);
    };
    scheduleMeasure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [transcriptBoundary]);
  useEffect(() => {
    transcriptPinned.current = true;
    transcriptEntryAlignment.current = true;
    setTranscriptDetached(false);
  }, [sessionId]);
  useEffect(() => {
    const draftSessionId = chatRouteRequest ?? sessionId;
    if (!draftSessionId) return;
    const hydration = claimThreadDraftHydration(
      draftHydrationIdentity,
      draftSessionId,
      preserveComposerForDraftIdentity.current,
    );
    if (hydration === "unchanged") return;
    if (hydration === "preserve") {
      preserveComposerForDraftIdentity.current = undefined;
      return;
    }
    try {
      setInput(readThreadDraft(draftSessionId, sessionStorage));
    } catch {
      setInput("");
    }
    setAttachments([]);
  }, [chatRouteRequest, sessionId]);
  useEffect(() => {
    const draftSessionId = chatRouteRequest ?? sessionId;
    if (!draftSessionId) return;
    const timer = window.setTimeout(() => {
      try {
        writeThreadDraft(draftSessionId, input, sessionStorage);
      } catch {
        // Draft persistence is optional; the live composer remains authoritative.
      }
    }, 160);
    return () => window.clearTimeout(timer);
  }, [chatRouteRequest, input, sessionId]);
  useEffect(() => {
    if (
      !sessionId
      || busy
      || queuedDispatch.current
      || messageQueue.length === 0
      || inferenceRouteChanging.current
      || sessionNavigationChanging.current
    ) return;
    const next = messageQueue[0]!;
    queuedDispatch.current = true;
    void sendMessage(next.prompt, next.attachments, {
      onAdmitted: () => removeQueuedMessage(sessionId, next.id),
    }).finally(() => {
      queuedDispatch.current = false;
    });
  }, [busy, messageQueue, sessionId]);
  useEffect(() => {
    if (view === "chat") transcriptEntryAlignment.current = true;
  }, [view]);
  useEffect(() => {
    if (view !== "chat" || !transcriptPinned.current) return;
    const frame = requestAnimationFrame(() => {
      const element = transcriptElement.current;
      if (element) {
        scrollToLastRealCard(element, "auto", transcriptEntryAlignment.current ? "start-if-oversized" : "end");
        transcriptEntryAlignment.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, transcriptLeadingHeight, view, windowedTranscript.totalHeight]);
  const proofTargetId = proofSelection?.sessionId ?? sessionId;
  const proofReceipt = resolveProofReceipt(
    inPageReceipts,
    proofSelection,
    proofTargetId === sessionId ? lastReceipt : undefined,
  );
  const attestationSeal = describeAttestationSeal({
    connected: activeChutesConnection,
    proofPolicy: activeChutesConnection && connection.posture === "encrypted-attested" ? "strict" : "record",
    receipt: lastReceipt,
    records: attestationRecords,
    failure: attestationFailure,
    now: attestationNow,
  });
  const connectivitySeal = online ? undefined : {
    state: "attention" as const,
    label: OFFLINE_RUNTIME_LABEL,
    detail: OFFLINE_RUNTIME_DETAIL,
  };
  const localDeviceRuntimeAdopted = Boolean(
    localDeviceStatus
    && runtime.current?.workspaceId.startsWith("vault+local-device://"),
  );
  const cloudVaultRuntimeAdopted = vaultSnapshot.phase === "ready"
    && runtime.current?.workspaceId.startsWith("vault+") === true
    && !runtime.current?.workspaceId.startsWith("vault+local-device://");
  const localS3VaultRuntimeAdopted = cloudVaultRuntimeAdopted
    && vaultSnapshot.phase === "ready"
    && !isGoogleDriveConfiguration(vaultSnapshot.config)
    && vaultSnapshot.config.mode === "local-development";
  const vaultRuntimeAdopted = localDeviceRuntimeAdopted || cloudVaultRuntimeAdopted;
  const trustAxes: readonly TrustAxis[] = Object.freeze([
    { id: "local", label: online ? "Browser / Edge runtime" : OFFLINE_RUNTIME_LABEL, state: online ? "none" : "attention", detail: online ? "The agent kernel executes in this browser." : OFFLINE_RUNTIME_DETAIL, view: "proof" },
    {
      id: "vault",
      label: localDeviceRuntimeAdopted
        ? "Local Device Vault active"
        : localS3VaultRuntimeAdopted
          ? "Local S3 Vault active"
          : cloudVaultRuntimeAdopted
          ? "Cloud Vault active"
          : preferences.vaultBackend === "local-device"
            ? localDeviceBusy ? "Opening Local Device Vault" : "Local Device setup"
            : vaultSnapshot.phase === "ready" ? "Vault adoption pending" : vaultSnapshot.phase === "probing" ? "Vault testing" : vaultSnapshot.phase === "configured" ? "Vault configured" : vaultSnapshot.phase === "degraded" ? "Vault blocked" : "Ephemeral",
      state: vaultRuntimeAdopted
        ? "verified"
        : localDeviceBusy || vaultSnapshot.phase === "ready" || vaultSnapshot.phase === "probing"
          ? "checking"
          : vaultSnapshot.phase === "configured"
            ? "asserted"
            : vaultSnapshot.phase === "degraded" || Boolean(localDeviceError)
              ? "failed"
              : "none",
      detail: localDeviceRuntimeAdopted
        ? "Workspace, journal, profiles, Git objects, and context state are encrypted and persistent in this browser profile. No cloud synchronization is active."
        : localS3VaultRuntimeAdopted
          ? "This page uses the tested client-encrypted local S3 workspace, journal, and profile adapters. No remote cloud synchronization is active."
        : cloudVaultRuntimeAdopted
          ? "This page uses the tested client-encrypted cloud workspace, journal, and profile adapters; cross-device convergence is not certified."
          : localDeviceError ?? (vaultSnapshot.phase === "ready"
            ? "The storage contract passed, but this active runtime is still page-memory until adoption completes."
            : vaultSnapshot.message),
      view: "vault",
    },
    { id: "e2ee", label: inferenceStatusLabel, state: activeChutesConnection ? (connection.invokeAuthorization === "verified" ? "verified" : "asserted") : activeExternalConnection ? "asserted" : "none", detail: inferenceStatusDetail, view: "access" },
    { id: "attestation", label: attestationSeal.label, state: attestationSeal.state, detail: attestationSeal.detail, view: "proof" },
  ]);
  const mobilePostureSeal = worstTrustAxis(trustAxes) ?? trustAxes[0]!;
  const attestationReceipts = useMemo(() => sessionAttestationReceipts({
    messages,
    sessionId,
    selectedRecordId: selectedAttestationRecordId,
  }), [messages, sessionId, selectedAttestationRecordId]);

  function activateSession(session: SessionRecord): void {
    // Update the identity fence synchronously. An aborted prior turn can still
    // deliver its final durable signal before Preact commits the next render.
    activeSessionIdentity.current = session.id;
    setSessionId(session.id);
    setActiveSessionRecord(session);
    setMessageQueue(queuedMessagesBySession.current.get(session.id) ?? []);
  }

  useEffect(() => () => {
    approvalBroker.denyAll();
    vaultContextPublication.current?.abort(new DOMException("Airship is closing.", "AbortError"));
    attestationOperation.current += 1;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    providerCredential.current = undefined;
  }, [approvalBroker]);

  // A capability request is a real modal: the shell chrome behind it must go
  // inert, or Tab and assistive tech reach controls the scrim claims are gone.
  useEffect(
    () => approvalBroker.subscribe((state) => setApprovalPending(state.pending.length > 0)),
    [approvalBroker],
  );

  useEffect(() => {
    if (previousApprovalMode.current === activeApprovalMode) return;
    previousApprovalMode.current = activeApprovalMode;
    // A pending prompt belongs to the policy that created it. Never let a
    // preference change reinterpret that outstanding decision under a new mode.
    approvalBroker.denyAll();
  }, [approvalBroker, activeApprovalMode]);

  useEffect(() => {
    const unsubscribe = vault.subscribe(setVaultSnapshot);
    return () => {
      unsubscribe();
      vault.disconnect();
      localDeviceHandle.current?.close();
      localDeviceHandle.current = undefined;
    };
  }, [vault]);

  // Local-lab backend auto-connects the baked MinIO vault. Google Drive waits
  // for an explicit user gesture; ephemeral remains entirely page-memory.
  // ephemeral (page memory only) when Preferences → Storage is "Ephemeral".
  useEffect(() => {
    if (preferences.vaultBackend !== "local-lab") return;
    if (!online || vault.snapshot.phase !== "disconnected") return;
    if (!isLoopbackAirshipLocation(window.location)) {
      setRuntimeStatus("Loopback MinIO auto-connect is disabled on this deployment; configure an S3-compatible provider explicitly in Vault.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [{ createLocalLabConfigureRequest }, { WorkspaceRootKey }] = await Promise.all([
          import("../vault/local-lab"),
          import("../storage/encrypted-envelope"),
        ]);
        const workspaceKey = await WorkspaceRootKey.import(Uint8Array.from(LOCAL_LAB_DEV_KEY));
        const request = createLocalLabConfigureRequest({
          ...localLabVaultConfiguration(window.location),
          workspaceKey,
          recoveryKeySavedAcknowledged: true,
          ownLoopbackServiceAcknowledged: true,
        });
        if (cancelled) return;
        vault.configure(request);
        setRuntimeStatus("Connecting local MinIO vault");
        const result = await vault.probe({ acknowledgeImmutableProbeObjects: true });
        if (cancelled) return;
        setRuntimeStatus(result.phase === "ready"
          ? "Local vault contract passed; adoption pending"
          : result.phase === "degraded"
            ? `Local vault blocked: ${result.diagnostic.publicMessage}`
            : `Local vault not adopted: ${result.message}`);
      } catch (error) {
        if (!cancelled) setRuntimeStatus(error instanceof Error
          ? `Local vault auto-connect failed: ${error.message}`
          : "Local vault auto-connect failed; running ephemeral");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.vaultBackend, online]);

  // Local Device is a durable, offline authority. Reopen only an explicitly
  // enrolled non-extractable key; missing custody enters the recovery ceremony
  // instead of silently creating a second storage authority.
  useEffect(() => {
    if (
      preferences.vaultBackend !== "local-device"
      || !runtime.current
      || !catalog
      || !activeProfile
      || !gitClient
      || vaultProviderSwitchingRef.current
      || vaultAdoptionBusy.current
      || runtime.current.workspaceId.startsWith("vault+local-device://")
    ) return;
    let cancelled = false;
    const owner = ++localDeviceAutoOpenOwner.current;
    vaultAdoptionBusy.current = true;
    setLocalDeviceBusy(true);
    setLocalDeviceError(undefined);
    void import("../storage/local-device-keyring")
      .then(({ openLocalDeviceWorkspaceKey }) =>
        openLocalDeviceWorkspaceKey({ partition: LOCAL_DEVICE_PARTITION })
      )
      .then(async (key) => {
        if (cancelled) return;
        if (!key) {
          setVaultSetupOpen(true);
          setRuntimeStatus("Local Device Vault needs a saved recovery key before first use");
          return;
        }
        await activateLocalDeviceWorkspace(key);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "The Local Device Vault could not be opened safely.";
        setLocalDeviceError(message);
        setRuntimeStatus(`Local Device Vault blocked: ${message}`);
      })
      .finally(() => {
        if (localDeviceAutoOpenOwner.current !== owner) return;
        setLocalDeviceBusy(false);
        vaultAdoptionBusy.current = false;
      });
    return () => {
      cancelled = true;
      if (localDeviceAutoOpenOwner.current !== owner) return;
      localDeviceAutoOpenOwner.current += 1;
      vaultAdoptionBusy.current = false;
      setLocalDeviceBusy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.vaultBackend, catalog, activeProfile, gitClient, vaultProviderSwitching]);

  // Readiness is not durability until the verified adapters replace the active
  // page-memory runtime. This effect waits for both halves, then adopts once.
  useEffect(() => {
    if (
      (preferences.vaultBackend !== "google-drive" && preferences.vaultBackend !== "local-lab") ||
      vaultSnapshot.phase !== "ready" ||
      !runtime.current ||
      runtime.current.workspaceId.startsWith("vault+") ||
      !catalog ||
      !activeProfile ||
      !gitClient ||
      vaultAdoptionBusy.current
    ) return;
    vaultAdoptionBusy.current = true;
    void adoptReadyVaultRuntime(vaultSnapshot, vault.readyRuntime())
      .catch((error) => setRuntimeStatus(error instanceof Error
        ? `Local vault adoption failed: ${error.message}`
        : "Local vault adoption failed safely"))
      .finally(() => { vaultAdoptionBusy.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.vaultBackend, vaultSnapshot, catalog, activeProfile, gitClient]);

  // Ephemeral is an explicit operating mode. If an encrypted vault is active, copy
  // the live state into fresh page-memory adapters before dropping credentials.
  useEffect(() => {
    if (preferences.vaultBackend !== "ephemeral" || ephemeralAdoptionBusy.current) return;
    if (!runtime.current?.workspaceId.startsWith("vault+")) {
      if (vault.snapshot.phase !== "disconnected") vault.disconnect();
      return;
    }
    if (!catalog || !activeProfile || !gitClient) return;
    ephemeralAdoptionBusy.current = true;
    void adoptEphemeralRuntime()
      .catch((error) => setRuntimeStatus(error instanceof Error
        ? `Ephemeral mode transition failed: ${error.message}`
        : "Ephemeral mode transition failed safely"))
      .finally(() => { ephemeralAdoptionBusy.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.vaultBackend, catalog, activeProfile, gitClient]);

  useEffect(() => {
    if (attestationRecords.length === 0) return;
    setAttestationNow(Date.now());
    const timer = window.setInterval(() => setAttestationNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [attestationRecords.length]);

  useEffect(() => {
    setSelectedAttestationRecordId(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (view !== "proof" || proofSection !== "attestations" || AttestationsScreen) return;
    let current = true;
    setAttestationsViewError(undefined);
    void loadDeferredCapabilities()
      .then((module) => {
        if (current) setAttestationsScreen(() => module.AttestationsView);
      })
      .catch(() => {
        if (current) setAttestationsViewError("The attestation interface chunk could not be loaded. No trust claim changed.");
      });
    return () => { current = false; };
  }, [view, proofSection, AttestationsScreen]);

  useEffect(() => {
    if (view !== "proof" || ProofScreen) return;
    let current = true;
    setProofViewError(undefined);
    void import("./proof-view").then((module) => {
      if (current) setProofScreen(() => module.ProofView);
    }).catch(() => {
      if (current) setProofViewError("The Proof interface could not be loaded. No receipt, evidence, or journal state changed.");
    });
    return () => { current = false; };
  }, [view, ProofScreen]);

  useEffect(() => {
    if ((view !== "sessions" || SessionsScreen) && (view !== "vault" || VaultScreen)) return;
    let current = true;
    if (view === "vault") setVaultViewError(undefined);
    void import("./sessions-route").then((module) => {
      if (!current) return;
      if (view === "sessions") setSessionsScreen(() => module.SessionsView);
      if (view === "vault") setVaultScreen(() => module.VaultView);
    }).catch(() => {
      if (!current) return;
      if (view === "sessions") setRuntimeStatus("Session library interface could not be loaded");
      if (view === "vault") setVaultViewError("The Vault interface could not be loaded. No provider, key, or runtime state changed.");
    });
    return () => { current = false; };
  }, [view, SessionsScreen, VaultScreen]);

  useEffect(() => {
    if (view !== "vault" || (GoogleDriveSetupScreen && LocalLabSetupScreen)) return;
    let current = true;
    void loadDeferredCapabilities().then((module) => {
      if (current) {
        setGoogleDriveSetupScreen(() => module.GoogleDriveSetup);
        setLocalLabSetupScreen(() => module.LocalLabSetup);
      }
    }).catch(() => {
      if (current) setRuntimeStatus("Google Drive setup could not be loaded; no vault state changed");
    });
    return () => { current = false; };
  }, [view, GoogleDriveSetupScreen, LocalLabSetupScreen]);

  useEffect(() => {
    if (
      view !== "vault"
      || preferences.vaultBackend !== "local-device"
      || LocalDeviceVaultSetupScreen
    ) return;
    let current = true;
    void import("./local-device-vault-setup").then((module) => {
      if (current) setLocalDeviceVaultSetupScreen(() => module.LocalDeviceVaultSetup);
    }).catch(() => {
      if (current) setVaultViewError(
        "The Local Device Vault controls could not be loaded. No key, backup, or storage authority changed.",
      );
    });
    return () => { current = false; };
  }, [view, preferences.vaultBackend, LocalDeviceVaultSetupScreen]);

  useEffect(() => {
    if ((view !== "access" || AccessScreen) && (view !== "billing" || BillingScreen)) return;
    let current = true;
    if (view === "access") setAccessViewError(undefined);
    if (view === "billing") setBillingViewError(undefined);
    void loadDeferredCapabilities().then((module) => {
      if (!current) return;
      if (view === "access") setAccessScreen(() => module.AccessView);
      if (view === "billing") setBillingScreen(() => module.BillingView);
    }).catch(() => {
      if (!current) return;
      if (view === "access") setAccessViewError("The Connection interface could not be loaded. No credential or session state changed.");
      if (view === "billing") setBillingViewError("The Account interface could not be loaded. No credential or billing state changed.");
    });
    return () => { current = false; };
  }, [view, AccessScreen, BillingScreen]);

  useEffect(() => {
    if (view !== "access" || ProviderConnectionsScreen) return;
    let current = true;
    void import("./provider-connections-view").then((module) => {
      if (current) setProviderConnectionsScreen(() => module.ProviderConnectionsView);
    }).catch(() => {
      if (current) setAccessViewError("The provider fabric could not be loaded. Existing Chutes and conversation state were not changed.");
    });
    return () => { current = false; };
  }, [view, ProviderConnectionsScreen]);

  useEffect(() => {
    if ((view !== "workspace" && view !== "editor") || EditorScreen) return;
    let current = true;
    setEditorViewError(undefined);
    void import("./editor-view").then((module) => {
      if (current) setEditorScreen(() => module.EditorView);
    }).catch(() => {
      if (current) setEditorViewError("The Workspace Editor chunk could not be loaded. No file or Git state changed.");
    });
    return () => { current = false; };
  }, [view, EditorScreen]);

  useEffect(() => {
    if (view !== "terminal" || TerminalScreen) return;
    let current = true;
    setTerminalViewError(undefined);
    void import("./terminal-view").then((module) => {
      if (current) setTerminalScreen(() => module.TerminalView);
    }).catch(() => {
      if (current) setTerminalViewError("The browser terminal chunk could not be loaded. No process or workspace state changed.");
    });
    return () => { current = false; };
  }, [view, TerminalScreen]);

  useEffect(() => {
    if (view !== "capabilities" || CapabilitiesScreen) return;
    let current = true;
    setCapabilitiesViewError(undefined);
    void import("./capabilities-view").then((module) => {
      if (current) setCapabilitiesScreen(() => module.CapabilitiesView);
    }).catch(() => {
      if (current) setCapabilitiesViewError("The runtime capability interface could not be loaded. No runtime was activated or changed.");
    });
    return () => { current = false; };
  }, [view, CapabilitiesScreen]);

  useEffect(() => {
    if ((view !== "memory" && view !== "context") || MemoryScreen) return;
    let current = true;
    setMemoryViewError(undefined);
    void import("./memory-view").then((module) => {
      if (current) setMemoryScreen(() => module.MemoryView);
    }).catch(() => {
      if (current) setMemoryViewError("The private Memory interface could not be loaded. No index or workspace state changed.");
    });
    return () => { current = false; };
  }, [view, MemoryScreen]);

  // When the Proof evidence section opens on a live connection with no evidence yet,
  // probe + verify a currently-live endpoint so the ledger shows real state
  // (verified/failed) instead of an empty "no records" panel.
  useEffect(() => {
    if (view !== "proof" || proofSection !== "attestations" || !chutesConnected || !attestationClient.current) return;
    if (attestationRecords.length > 0) return;
    const controller = new AbortController();
    void probeCurrentEndpoint(controller.signal).catch(() => {
      // failure state is surfaced by probeCurrentEndpoint/acquireEndpointAttestation
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, proofSection, chutesConnected, credentialRevision]);

  function confirmProfileDraftDiscard(): boolean {
    const allowed = !profileDraftDirty.current || window.confirm(PROFILE_DRAFT_DISCARD_PROMPT);
    // The accepted transition unmounts or retargets the editor immediately.
    // Clear synchronously so hashchange/popstate cannot ask a second time
    // before Preact runs the ProfileManagerView cleanup.
    if (allowed) profileDraftDirty.current = false;
    return allowed;
  }

  function mayNavigateFromProfileDraft(next: View): boolean {
    return currentView.current !== "profiles"
      || next === "profiles"
      || confirmProfileDraftDiscard();
  }

  function openProfileManager(profileIdToOpen?: string): boolean {
    if (
      currentView.current === "profiles"
      && profileIdToOpen !== undefined
      && profileIdToOpen !== profileHubScope
      && !confirmProfileDraftDiscard()
    ) return false;
    if (profileIdToOpen !== undefined) setProfileHubScope(profileIdToOpen);
    navigate("profiles");
    return true;
  }

  function navigate(next: View, targetHash?: string): boolean {
    if (!mayNavigateFromProfileDraft(next)) return false;
    const resolvedTargetHash = targetHash
      ?? (next === "chat"
        ? chatHash(activeSessionIdentity.current ?? sessionId)
        : navigationHashForView(next));
    setMobileMoreOpen(false);
    setView(next);
    if (next === "chat") setChatRouteRequest(chatSessionIdFromHash(resolvedTargetHash));
    if (next !== "proof") {
      setProofSelection(undefined);
      setProofSection("summary");
    }
    if (window.location.hash !== resolvedTargetHash) {
      window.history.pushState(
        next === "chat" ? { view: next, sessionId: chatSessionIdFromHash(resolvedTargetHash) } : { view: next },
        "",
        resolvedTargetHash,
      );
    }
    return true;
  }

  function navigatePrimary(next: View) {
    if (next === "proof") {
      openSessionProof();
      return;
    }
    navigate(next);
  }

  async function openPaletteSession(targetSessionId: string): Promise<void> {
    if (!sessionLibrary || !sessionRuntime) { navigate("sessions"); return; }
    try {
      const detail = await sessionLibrary.inspect(targetSessionId, sessionRuntime);
      await resumeLibrarySession(detail);
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : "The recent session could not be opened.");
      navigate("sessions");
    }
  }

  function openReceiptAttestation(receipt: ConversationReceipt): void {
    if (receipt.sessionId === sessionId) {
      setSelectedAttestationRecordId(attestationRecordIdForReceipt(receipt));
    }
    const selection = proofSelectionForReceipt(receipt);
    setProofSelection(selection);
    setProofSection("attestations");
    navigate("proof", proofHash(selection, "attestations"));
  }

  async function startOAuthSignIn(): Promise<void> {
    if (!online) throw new Error(OFFLINE_INLINE_REASON);
    if (!CHUTES_ACTIVE_REGISTRATION.configured) {
      throw new Error(CHUTES_ACTIVE_REGISTRATION.configurationError ?? "Chutes sign-in is not configured for this build.");
    }
    const locationState = chutesOAuthLocationState(CHUTES_ACTIVE_REGISTRATION.homepageUrl, window.location.href);
    if (!locationState.available) throw new Error(locationState.reason);
    if (import.meta.env.DEV) await requireLocalChutesOAuthBridge();
    pendingOAuthCredential.current = undefined;
    setOauthCallbackStatus(undefined);
    const request = await createChutesAuthorizationRequest({
      clientId: CHUTES_ACTIVE_REGISTRATION.clientId,
      registration: CHUTES_ACTIVE_REGISTRATION,
    });
    try {
      sessionStorage.setItem(CHUTES_OAUTH_ATTEMPT_KEY, JSON.stringify(request.attempt));
    } catch {
      throw new Error("This browser denied the tab-local PKCE state needed for Chutes sign-in. Allow session storage for this Airship origin and retry.");
    }
    window.location.assign(request.url.href);
  }

  function currentOAuthBearer(): string {
    const tokenSet = oauthTokens.current;
    if (!tokenSet || tokenSet.expiresAt <= Date.now() + 5_000) {
      throw new Error("The memory-only Chutes OAuth session is unavailable or expired.");
    }
    return tokenSet.accessToken;
  }

  function takePendingOAuthCredential(): string | undefined {
    const credential = pendingOAuthCredential.current;
    pendingOAuthCredential.current = undefined;
    return credential;
  }

  function clearPendingDelta(messageId: string) {
    if (pendingDelta.current?.messageId === messageId) pendingDelta.current = undefined;
    if (pendingDeltaFrame.current !== undefined) {
      cancelAnimationFrame(pendingDeltaFrame.current);
      pendingDeltaFrame.current = undefined;
    }
    transcriptStreams.clear(messageId);
  }

  function queueTextDelta(messageId: string, text: string) {
    const current = pendingDelta.current;
    pendingDelta.current = current?.messageId === messageId
      ? { messageId, text: current.text + text }
      : { messageId, text };
    if (pendingDeltaFrame.current !== undefined) return;
    pendingDeltaFrame.current = requestAnimationFrame(() => {
      const buffered = pendingDelta.current;
      pendingDelta.current = undefined;
      pendingDeltaFrame.current = undefined;
      if (!buffered) return;
      transcriptStreams.append(buffered.messageId, buffered.text);
    });
  }

  function requireProviderAvailabilityTool(): InspectInferenceConnectionsTool {
    const tool = providerAvailabilityTool.current;
    if (!tool) throw new Error("The inference connection directory is still starting.");
    return tool;
  }

  useEffect(() => {
    let disposed = false;
    let unsubscribeProviderFabric: (() => void) | undefined;
    void (async () => {
      const nextCatalog = await createBuiltInProfileCatalog();
      const profile = nextCatalog.profiles.find((candidate) => candidate.profileId === "general") ?? nextCatalog.profiles[0];
      if (!profile) throw new Error("Airship has no built-in agent profile.");
      const workspace = new MemoryWorkspace();
      const [{ WorkspaceGitAdapter, AIRSHIP_BOOTSTRAP_FILES }, { browserInferenceFabric }, { InspectInferenceConnectionsTool }] = await Promise.all([
        loadBrowserGit(),
        import("../inference/fabric"),
        import("../inference/providers"),
      ]);
      const { readme, architecture, retrieval } = AIRSHIP_BOOTSTRAP_FILES;
      await workspace.write("README.md", readme);
      await workspace.write("docs/architecture.md", architecture);
      await workspace.write("notes/retrieval.md", retrieval);
      inferenceFabric.current = browserInferenceFabric;
      const availabilityTool = new InspectInferenceConnectionsTool({
        providers: browserInferenceFabric.providers,
        connections: browserInferenceFabric.connections,
        models: browserInferenceFabric.models,
        activeSession: () => activeExternalRouteRef.current?.pin,
        project: (snapshot) => combinedInferenceAvailability(
          snapshot,
          chutesAvailability.current,
          runtime.current?.inferenceBinding,
        ),
      });
      providerAvailabilityTool.current = availabilityTool;
      unsubscribeProviderFabric = browserInferenceFabric.subscribe(() => {
        if (!disposed) setProviderFabricRevision((value) => value + 1);
      });
      const gitAdapter = await WorkspaceGitAdapter.open(workspace, [{
        id: "airship-workspace",
        name: "Airship Workspace",
        worktreePath: "/workspace",
        files: { "README.md": "# Private workspace\n\nInitial browser repository snapshot." },
        workingFiles: {
          "README.md": readme,
          "docs/architecture.md": architecture,
          "notes/retrieval.md": retrieval,
        },
      }]);
      const nextGitClient = new BrowserGitClient(gitAdapter);
      const journal = new EventJournal(new MemoryJournalBackend());
      const tools = await createAirshipToolRegistry({
        workspace,
        journal,
        git: nextGitClient,
        additionalTools: [availabilityTool],
      });
      const commands = createSlashCommandRegistry({ tools });
      const profiles = new MemoryProfileCatalogStore();
      const initialCatalog = (await profiles.initialize(nextCatalog)).checkpoint;
      const nextRuntime: Runtime = {
        workspace,
        workspaceId: "memory://airship-page",
        profiles,
        tools,
        journal,
        transport: new DemoInferenceTransport(),
        model: "airship/demo-v1",
        inferenceDirectory: () => inferenceDirectoryFromAvailability(
          combinedInferenceAvailability(
            browserInferenceFabric.availability(activeExternalRouteRef.current?.pin),
            chutesAvailability.current,
            runtime.current?.inferenceBinding,
          ),
        ),
      };
      runtime.current = nextRuntime;
      setSlashRegistry(commands);
      const nextSession = await createProfileSession(nextRuntime, profile, nextCatalog);
      if (disposed) return;
      publishCatalogCheckpoint(initialCatalog);
      setProfileId(profile.profileId);
      activateSession(nextSession);
      setSessionLibrary(new SessionLibrary(nextRuntime.journal));
      setGitClient(nextGitClient);
      setSessionRevision(1);
      setEventCount(nextSession.headSequence);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      await refreshWorkspaceState(workspace, setFiles, setWorkspaceFiles);
      setRuntimeStatus("Local kernel ready");
    })().catch((error) => {
      if (disposed) return;
      setRuntimeStatus(error instanceof Error ? `Local kernel failed to initialize: ${error.message}` : "Local kernel failed to initialize");
      setMessages([{ id: randomUuid(), role: "assistant", error: true, content: error instanceof Error ? error.message : String(error) }]);
    });
    return () => {
      disposed = true;
      unsubscribeProviderFabric?.();
      activeTurn.current?.abort();
      if (pendingDeltaFrame.current !== undefined) cancelAnimationFrame(pendingDeltaFrame.current);
    };
  }, []);

  useEffect(() => {
    if (!activeTheme) return;
    applyTheme(activeTheme);
    // Profile themes establish defaults; global Preferences are the final,
    // non-profile override layer and must remain authoritative after a switch.
    applyPreferenceOverrides(preferences);
    savePreferenceOverrides(preferences);
  }, [activeTheme, preferences]);

  useEffect(() => {
    if (window.location.pathname !== `${import.meta.env.BASE_URL}auth/chutes/callback`) return;
    let disposed = false;
    const callbackSearch = window.location.search;
    let rawAttempt: string | null;
    try {
      rawAttempt = sessionStorage.getItem(CHUTES_OAUTH_ATTEMPT_KEY);
      sessionStorage.removeItem(CHUTES_OAUTH_ATTEMPT_KEY);
    } catch {
      window.history.replaceState({ view: "access" }, "", `${import.meta.env.BASE_URL}#connection`);
      setView("access");
      setOauthCallbackStatus({
        kind: "error",
        message: "This browser denied the tab-local PKCE state needed to finish Chutes sign-in. Allow session storage and start again.",
      });
      return;
    }
    window.history.replaceState({ view: "access" }, "", `${import.meta.env.BASE_URL}#connection`);
    setView("access");
    setOauthCallbackStatus({ kind: "blocked", message: "Exchanging the one-time authorization code directly with Chutes…" });
    void (async () => {
      try {
        if (!rawAttempt) throw new Error("No matching Chutes authorization attempt was found in this tab.");
        const attempt = parsePkceAttempt(rawAttempt);
        const callback = consumeChutesAuthorizationCallback({ search: callbackSearch, attempt });
        const tokenSet = await exchangeChutesAuthorizationCode({
          callback,
          clientId: CHUTES_ACTIVE_REGISTRATION.clientId,
          registration: CHUTES_ACTIVE_REGISTRATION,
        });
        if (disposed) return;
        oauthTokens.current = tokenSet;
        pendingOAuthCredential.current = tokenSet.accessToken;
        setOauthTokenRevision((value) => value + 1);
        setOauthBootstrapRevision((value) => value + 1);
        setOauthCallbackStatus({
          kind: "verified",
          message: "Chutes sign-in complete with S256 PKCE. Finish below: choose a model, confirm the required endpoint-proof policy, then select Finish: verify & connect. No API key is needed.",
        });
      } catch (error) {
        if (disposed) return;
        oauthTokens.current = undefined;
        pendingOAuthCredential.current = undefined;
        setOauthCallbackStatus({ kind: "error", message: oauthPublicClientError(error) });
      }
    })();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const updateFromHistory = () => {
      const next = readViewHash();
      if (!mayNavigateFromProfileDraft(next)) {
        const restoredHash = currentView.current === "chat"
          ? chatHash(activeSessionIdentity.current)
          : navigationHashForView(currentView.current);
        window.history.pushState({ view: currentView.current }, "", restoredHash);
        return;
      }
      const requestedChatSession = next === "chat" ? chatSessionIdFromHash(window.location.hash) : undefined;
      setMobileMoreOpen(false);
      const nextProofSelection = next === "proof" ? proofSelectionFromHash(window.location.hash) : undefined;
      const nextProofSection = next === "proof" ? proofSectionFromHash(window.location.hash) : "summary";
      setView(next);
      setChatRouteRequest(requestedChatSession);
      setProofSelection(nextProofSelection);
      setProofSection(nextProofSection);
      const canonicalHash = next === "proof"
        ? proofHash(nextProofSelection, nextProofSection)
        : next === "chat"
          ? requestedChatSession
            ? chatHash(requestedChatSession)
            : chatHash(activeSessionIdentity.current)
          : navigationHashForView(next);
      if (window.location.hash !== canonicalHash) window.history.replaceState({ view: next }, "", canonicalHash);
    };
    window.addEventListener("hashchange", updateFromHistory);
    window.addEventListener("popstate", updateFromHistory);
    updateFromHistory();
    return () => {
      window.removeEventListener("hashchange", updateFromHistory);
      window.removeEventListener("popstate", updateFromHistory);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_SHELL_MEDIA_QUERY);
    const closeAboveMobile = () => {
      if (!media.matches) setMobileMoreOpen(false);
    };
    media.addEventListener("change", closeAboveMobile);
    return () => media.removeEventListener("change", closeAboveMobile);
  }, []);

  useEffect(() => {
    if (connection.kind !== "chutes-oauth") return;
    const tokenSet = oauthTokens.current;
    if (!tokenSet?.refreshToken) return;
    const controller = new AbortController();
    let disposed = false;
    const refreshAt = Math.max(0, tokenSet.expiresAt - Date.now() - 60_000);
    const timer = window.setTimeout(() => {
      void refreshChutesOAuthToken({
        clientId: CHUTES_ACTIVE_REGISTRATION.clientId,
        refreshToken: tokenSet.refreshToken!,
        signal: controller.signal,
        registration: CHUTES_ACTIVE_REGISTRATION,
      }).then((next) => {
        if (disposed) return;
        oauthTokens.current = next;
        accountCredential.current = next.accessToken;
        providerCredential.current = next.accessToken;
        setOauthTokenRevision((value) => value + 1);
        setCredentialRevision((value) => value + 1);
        setOauthCallbackStatus({
          kind: "verified",
          message: "The memory-only Chutes session rotated successfully.",
        });
      }).catch((error) => {
        if (disposed || controller.signal.aborted) return;
        setOauthCallbackStatus({ kind: "error", message: oauthPublicClientError(error) });
        releaseChutesAuthority("Chutes OAuth rotation failed · reconnect inference; this conversation remains intact");
      });
    }, refreshAt);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort(new DOMException("OAuth refresh schedule changed.", "AbortError"));
    };
  }, [connection.kind, oauthTokenRevision]);

  useEffect(() => {
    const label = navigation.find((item) => item.id === view)?.label ?? "Agent";
    document.title = unreadTurnCount > 0 ? `(${String(unreadTurnCount)}) Airship — ${label}` : `Airship — ${label}`;
  }, [unreadTurnCount, view]);

  useEffect(() => {
    mainRegion.current?.focus({ preventScroll: true });
    if (view === "chat" && !document.hidden) setUnreadTurnCount(0);
  }, [view]);

  // The rail is a real scroll container at common laptop heights. Re-bind when
  // a disclosure changes its content height so the fade cannot go stale.
  useScrollEdges(primaryNav, `${String(chatNavExpanded)}:${String(profileNavExpanded)}:${String(recentProfileConversations.length)}:${view}`);

  // The composer is 35 tab stops from <body> and is the most-used control in
  // the product. Claim it once the chat stage is actually mounted — the boot
  // screen renders first, so `view` alone never observes the composer — and
  // only while nothing else owns focus. Known consequence: the g-prefix
  // navigation chords stay inert until the user leaves the composer, because
  // `useGlobalNavigationJumps` correctly refuses to steal keys from a text
  // field. Command Center (Cmd/Ctrl+K) is unaffected.
  useEffect(() => {
    if (!shellMounted) return;
    if (!shouldClaimComposerFocus({
      chatView: view === "chat",
      overlayOpen: mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen || approvalPending,
      narrowViewport: window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches,
      focusAtDocumentRoot: document.activeElement === null || document.activeElement === document.body,
    })) return;
    const frame = requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [shellMounted, view, mobileMoreOpen, paletteOpen, preferencesOpen, trustSheetOpen, approvalPending]);

  useEffect(() => {
    const reconcileVisibility = () => {
      if (!document.hidden && currentView.current === "chat") setUnreadTurnCount(0);
    };
    document.addEventListener("visibilitychange", reconcileVisibility);
    return () => document.removeEventListener("visibilitychange", reconcileVisibility);
  }, []);

  function announceCompletedTurnAwayFromChat(): void {
    if (currentView.current !== "chat" || document.hidden) {
      setUnreadTurnCount((count) => Math.min(99, count + 1));
    }
  }

  function publishCatalogCheckpoint(next: ProfileCatalogCheckpoint): void {
    catalogCheckpoint.current = next;
    setCatalog(next.catalog);
  }

  function profileCatalogAuthorityLabel(): string {
    return runtime.current?.profiles.durability === "encrypted-vault"
      ? "the encrypted Vault"
      : "page memory";
  }

  async function mutateProfileCatalog(
    mutation: (current: ProfileCatalog) => ProfileCatalog | Promise<ProfileCatalog>,
  ): Promise<ProfileCatalogCheckpoint> {
    if (catalogAuthorityChanging.current) {
      throw new Error("Profile storage authority is changing. Retry after the Vault transition completes.");
    }
    const operation = catalogMutationTail.current.then(async () => {
      if (catalogAuthorityChanging.current) {
        throw new Error("Profile storage authority is changing. Retry after the Vault transition completes.");
      }
      const active = runtime.current;
      const expected = catalogCheckpoint.current;
      if (!active || !expected) throw new Error("The profile catalog authority is not ready.");
      const next = await mutation(expected.catalog);
      if (next === expected.catalog) return expected;
      const committed = await active.profiles.commit(expected, next);
      if (runtime.current?.profiles !== active.profiles) {
        throw new Error("Profile storage authority changed before the revision could be published.");
      }
      publishCatalogCheckpoint(committed);
      return committed;
    });
    catalogMutationTail.current = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function changeProfile(nextId: string, force = false) {
    if (!runtime.current || !catalog || (!force && nextId === profileId)) return;
    if (inferenceRouteChanging.current || sessionNavigationChanging.current) {
      throw new Error("Wait for the current session or inference route change before switching profiles.");
    }
    sessionNavigationChanging.current = true;
    const operation = ++profileOperation.current;
    try {
      activeTurn.current?.abort();
      setRuntimeStatus("Forking pinned session");
      let profile: ProfileRevision | undefined;
      let nextSession: SessionRecord | undefined;
      await mutateProfileCatalog(async (current) => {
        const selected = current.profiles.find((candidate) => candidate.profileId === nextId);
        if (!selected) throw new Error(`Unknown profile: ${nextId}`);
        const active = runtime.current;
        if (!active) throw new Error("The active browser runtime is not ready.");
        profile = await bindProfileToRuntime(selected, active);
        const next = profile === selected ? current : replaceProfile(current, profile);
        nextSession = await createProfileSession(active, profile, next);
        return next;
      });
      if (!profile || !nextSession) throw new Error("The profile session was not created.");
      if (operation !== profileOperation.current) return;
      setProfileId(nextId);
      activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{ ...welcomeMessage, id: randomUuid(), content: `${profile.name} profile loaded in a new pinned session. ${welcomeMessage.content}` }]);
      setEventCount(1);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setRuntimeStatus("Local kernel ready");
    } finally {
      sessionNavigationChanging.current = false;
    }
  }

  async function createConversation(title?: string) {
    if (
      busy
      || !runtime.current
      || !activeProfile
      || !catalog
      || inferenceRouteChanging.current
      || sessionNavigationChanging.current
    ) return;
    const active = runtime.current;
    sessionNavigationChanging.current = true;
    try {
      const created = await createProfileSession(active, activeProfile, catalog, title);
      if (runtime.current !== active) throw new Error("The inference or storage authority changed before the conversation was created.");
      activateSession(created);
      setMessages([{ ...welcomeMessage, id: randomUuid(), content: `${created.title} is a new isolated conversation. ${welcomeMessage.content}` }]);
      setEventCount(created.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setSessionRevision((value) => value + 1);
      setRuntimeStatus("New conversation ready");
      navigate("chat");
    } finally {
      sessionNavigationChanging.current = false;
    }
  }

  async function runSlashPlan(plan: Exclude<SlashCommandPlan, { kind: "chat" }>, source: string): Promise<void> {
    if (plan.kind === "invalid") {
      appendLocalExchange(source, plan.message, true);
      return;
    }
    if (plan.kind === "disabled") {
      appendLocalExchange(source, `${plan.command.usage}\n\nUnavailable: ${plan.reason}`, true);
      return;
    }
    if (plan.kind === "builtin") {
      await runSlashBuiltin(plan, source);
      return;
    }
    await runSlashTool(plan, source);
  }

  async function runSlashBuiltin(
    plan: Extract<SlashCommandPlan, { kind: "builtin" }>,
    source: string,
  ): Promise<void> {
    if (!runtime.current || !slashRegistry) return;
    const action = plan.action;
    if (action.type === "help") {
      const descriptor = action.command ? slashRegistry.resolve(action.command) : undefined;
      const response = descriptor
        ? `${descriptor.usage}\n\n${descriptor.summary}${descriptor.availability.enabled ? "" : `\nUnavailable: ${descriptor.availability.reason}`}`
        : slashRegistry.descriptors().map((command) => `${command.usage} — ${command.summary}`).join("\n");
      appendLocalExchange(source, response || "No slash commands are authorized for this profile.");
      return;
    }
    if (action.type === "sessions.list") {
      const sessions = await runtime.current.journal.listSessions();
      appendLocalExchange(source, sessions.length
        ? sessions.map((session) => `${session.id === sessionId ? "•" : "○"} ${session.title} · ${session.id.slice(0, 8)} · ${session.manifest.model}`).join("\n")
        : "No sessions are available in this page runtime.");
      return;
    }
    if (action.type === "sessions.create") {
      await createConversation(action.title);
      return;
    }
    if (action.type === "sessions.activate") {
      if (!sessionLibrary || !sessionRuntime) throw new Error("The session library is unavailable.");
      await resumeLibrarySession(await sessionLibrary.inspect(action.sessionId, sessionRuntime));
      return;
    }
    if (action.type === "sessions.fork") {
      if (!sessionLibrary || !activeSessionRecord) throw new Error("The active session cannot be forked.");
      const sourceId = action.sessionId ?? activeSessionRecord.id;
      const sourceSession = await runtime.current.journal.getSession(sourceId);
      if (!sourceSession) throw new Error("The requested source session is unavailable.");
      const result = await sessionLibrary.fork(sourceId, {
        title: `${sourceSession.title} · fork`.slice(0, 240),
        expectedSourceHead: { sequence: sourceSession.headSequence, digest: sourceSession.headDigest },
      });
      await activateForkedSession(result);
      return;
    }
    if (action.type === "models.list") {
      const query = action.query?.toLowerCase();
      const activeModels = activeChutesConnection
        ? availableModels.map((model) => model.id)
        : activeExternalRoute?.models.map((model) => model.id) ?? [runtime.current.model];
      const modelIds = activeModels
        .filter((model) => !query || model.toLowerCase().includes(query));
      appendLocalExchange(source, modelIds.length
        ? [
            `Connection: ${activeInferenceBinding?.providerLabel ?? "local demo"} / ${activeInferenceBinding?.connectionId ?? "built-in"}`,
            ...modelIds.map((model) => `${model === runtime.current?.model ? "•" : "○"} ${model}`),
          ].join("\n")
        : "No matching model is available.");
      return;
    }
    if (action.type === "models.select") {
      if (activeChutesConnection) await switchChutesModel(action.modelId);
      else if (activeExternalRoute) await switchExternalModel(action.modelId);
      else throw new Error("Connect an inference provider before selecting a model.");
    }
  }

  async function runSlashTool(
    plan: Extract<SlashCommandPlan, { kind: "tool" }>,
    source: string,
  ): Promise<void> {
    if (!runtime.current || !sessionId || busy) return;
    const commandRuntime = runtime.current;
    const commandSessionId = sessionId;
    const turnId = `local-command-${randomUuid()}`;
    const operationId = `tool-${randomUuid()}`;
    const assistantId = randomUuid();
    const controller = new AbortController();
    activeTurn.current = controller;
    setBusy(true);
    setRuntimeStatus(`Reviewing local /${plan.command.name}`);
    setMessages((current) => [
      ...current,
      { id: randomUuid(), role: "user", content: source, history: { turnStatus: "completed", providerContext: "excluded" } },
      { id: assistantId, role: "assistant", content: "", status: "Awaiting local tool policy", history: { turnStatus: "incomplete", providerContext: "excluded" } },
    ]);
    const append = async (drafts: Parameters<EventJournal["append"]>[1]) => {
      const events = await commandRuntime.journal.append(commandSessionId, drafts);
      if (activeSessionIdentity.current === commandSessionId) {
        setEventCount((count) => count + events.length);
        setSessionRevision((value) => value + events.length);
      }
    };
    try {
      const commandSession = await commandRuntime.journal.getSession(commandSessionId);
      if (!commandSession) throw new Error("The pinned session disappeared before the local command could run.");
      await append([{
        type: "local.command.requested",
        turnId,
        operationId,
        payload: { content: source, toolName: plan.toolName, arguments: plan.arguments },
      }]);
      let liveOutput = "";
      const context = {
        sessionId: commandSessionId,
        turnId,
        operationId,
        capabilityTier: commandSession.manifest.capabilityTier,
        signal: controller.signal,
        onOutput(chunk: Readonly<{ stream: "stdout" | "stderr" | "combined"; text: string }>) {
          liveOutput = `${liveOutput}${chunk.text}`.slice(-32_768);
          if (activeSessionIdentity.current !== commandSessionId) return;
          setMessages((current) => current.map((message) => message.id === assistantId
            ? { ...message, content: liveOutput, status: `Streaming ${plan.toolName} · ${chunk.stream}` }
            : message));
        },
      };
      const decision = await commandRuntime.tools.review(plan.toolName, plan.arguments, context, approvalPolicy);
      const provenance = approvalProvenance(approvalPolicy, context);
      if (decision !== "allow") {
        const denied = activeApprovalMode === "auto-approve"
          ? `Permission denied for local /${plan.command.name}. No tool effect ran; the separate safety review received only bounded metadata with private payload fields withheld.`
          : `Permission denied for local /${plan.command.name}. No tool effect ran, and nothing was sent to the model.`;
        await append([{ type: "local.command.denied", turnId, operationId, payload: { content: denied, toolName: plan.toolName, approval: provenance ?? null } }]);
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, content: denied, status: undefined, error: true, history: { turnStatus: "completed", providerContext: "excluded" } }
          : message));
        return;
      }
      await append([{ type: "local.command.approved", turnId, operationId, payload: { toolName: plan.toolName, approval: provenance ?? null } }]);
      setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, status: `Running ${plan.toolName} locally` } : message));
      const result = await commandRuntime.tools.executeApproved(plan.toolName, plan.arguments, context);
      await append([{
        type: "local.command.completed",
        turnId,
        operationId,
        payload: { content: result.content, toolName: plan.toolName, isError: result.isError ?? false, metadata: result.metadata ?? null },
      }]);
      if (activeSessionIdentity.current === commandSessionId) {
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, content: boundedTranscriptContent(result.content), status: "Local result · excluded from model context", error: result.isError, history: { turnStatus: "completed", providerContext: "excluded" } }
          : message));
        await refreshWorkspaceState(commandRuntime.workspace, setFiles, setWorkspaceFiles);
        setRuntimeStatus(activeApprovalMode === "auto-approve"
          ? "Local command complete after separate metadata-only safety review"
          : "Local command complete; no model request made");
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled ? "Local command stopped before completion." : error instanceof Error ? error.message : String(error);
      try {
        await append([{ type: "local.command.failed", turnId, operationId, payload: { content: message, toolName: plan.toolName, cancelled } }]);
      } catch {
        // Preserve the original review/execute failure when journal completion also fails.
      }
      if (activeSessionIdentity.current === commandSessionId) {
        setMessages((current) => current.map((item) => item.id === assistantId
          ? { ...item, content: message, status: undefined, error: true, history: { turnStatus: cancelled ? "cancelled" : "failed", providerContext: "excluded" } }
          : item));
        setRuntimeStatus(cancelled ? "Local command stopped" : "Local command failed safely");
      }
    } finally {
      if (activeTurn.current === controller) activeTurn.current = undefined;
      const updated = await commandRuntime.journal.getSession(commandSessionId);
      if (updated && activeSessionIdentity.current === commandSessionId) setActiveSessionRecord(updated);
      setBusy(false);
    }
  }

  function appendLocalExchange(source: string, response: string, error = false): void {
    setMessages((current) => [
      ...current,
      { id: randomUuid(), role: "user", content: source, history: { turnStatus: "completed", providerContext: "excluded" } },
      { id: randomUuid(), role: "assistant", content: boundedTranscriptContent(response), error, status: "Local command · excluded from model context", history: { turnStatus: error ? "failed" : "completed", providerContext: "excluded" } },
    ]);
  }

  function acceptSlashCompletion(completion: SlashCompletion): void {
    if (completion.disabledReason) return;
    setSlashMenuDismissedFor(undefined);
    setInput(insertSlashCompletion(input, completion));
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function addComposerFiles(filesToAdd: readonly File[]): void {
    const images = filesToAdd.filter((file) => file.type.toLowerCase().startsWith("image/"));
    const rejected = filesToAdd.length - images.length;
    const remaining = Math.max(0, 8 - attachments.length);
    const next = composerAttachments(images.slice(0, remaining), randomUuid, (file) => {
      if (typeof URL.createObjectURL !== "function") return undefined;
      const url = URL.createObjectURL(file);
      attachmentPreviewUrls.current.add(url);
      return url;
    });
    setAttachments((current) => Object.freeze([...current, ...next].slice(0, 8)));
    if (rejected > 0) {
      setComposerNotice(`${rejected} non-image attachment${rejected === 1 ? " was" : "s were"} not added. This milestone sends bounded image inputs.`);
      return;
    }
    setComposerNotice(imageInputCapability === "supported"
      ? `${next.length} image${next.length === 1 ? " is" : "s are"} ready for inline encrypted vision inference.`
      : inferenceConnected
        ? "Choose a model whose provider or local-discovery record explicitly includes image input before sending."
        : "Connect a vision-capable inference model before sending this image.");
  }

  async function branchFromMessage(message: UiMessage): Promise<void> {
    if (!sessionLibrary || !activeSessionRecord) {
      setComposerNotice("Conversation branching will be available when the local session journal is ready.");
      return;
    }
    try {
      const result = await sessionLibrary.fork(activeSessionRecord.id, {
        title: `${activeSessionRecord.title} · fork`.slice(0, 240),
        expectedSourceHead: { sequence: activeSessionRecord.headSequence, digest: activeSessionRecord.headDigest },
        ...(message.sourcePoint ? { sourcePoint: message.sourcePoint } : {}),
      });
      // This fork intentionally restores the selected message into the new
      // composer. Do not let the ordinary empty-draft hydration overwrite it
      // after Preact commits the new addressed session identity.
      preserveComposerForDraftIdentity.current = result.session.id;
      await activateForkedSession(result);
      setInput(message.originatingPrompt ?? message.content);
      setAttachments(message.originatingAttachments ?? []);
      setComposerNotice(undefined);
      setRuntimeStatus("Pinned fork created; review the restored prompt before sending");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The source conversation changed before its branch could be committed.";
      setComposerNotice(`Conversation branch was not created: ${detail}`);
      setRuntimeStatus("Conversation branch could not be created");
    }
  }

  function publishMessageQueue(
    targetSessionId: string,
    update: (current: readonly QueuedComposerItem[]) => readonly QueuedComposerItem[],
  ): void {
    const next = Object.freeze([...update(queuedMessagesBySession.current.get(targetSessionId) ?? [])]);
    if (next.length) queuedMessagesBySession.current.set(targetSessionId, next);
    else queuedMessagesBySession.current.delete(targetSessionId);
    if (activeSessionIdentity.current === targetSessionId) setMessageQueue(next);
  }

  function removeQueuedMessage(targetSessionId: string, queuedMessageId: string): void {
    publishMessageQueue(targetSessionId, (current) => removeThreadQueueItem(current, queuedMessageId));
  }

  function discardQueuedMessage(targetSessionId: string, item: QueuedComposerItem): void {
    for (const attachment of item.attachments) {
      if (!attachment.previewUrl || !attachmentPreviewUrls.current.has(attachment.previewUrl)) continue;
      URL.revokeObjectURL(attachment.previewUrl);
      attachmentPreviewUrls.current.delete(attachment.previewUrl);
    }
    removeQueuedMessage(targetSessionId, item.id);
  }

  function enqueueCurrentComposer(): void {
    const prompt = input.trim();
    if (!prompt || !sessionId) return;
    const item: QueuedComposerItem = Object.freeze({
      id: randomUuid(),
      prompt,
      attachments: Object.freeze([...attachments]),
    });
    publishMessageQueue(sessionId, (current) => appendThreadQueueItem(current, item));
    setInput("");
    setAttachments([]);
    setComposerNotice(`Queued for this conversation · ${String(messageQueue.length + 1)} waiting`);
  }

  function editQueuedMessage(item: QueuedComposerItem): void {
    if (!sessionId) return;
    removeQueuedMessage(sessionId, item.id);
    setInput(item.prompt);
    setAttachments(item.attachments);
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function sendQueuedMessageNow(item: QueuedComposerItem): void {
    if (!sessionId || busy) return;
    queuedDispatch.current = true;
    void sendMessage(item.prompt, item.attachments, {
      onAdmitted: () => removeQueuedMessage(sessionId, item.id),
    }).finally(() => {
      queuedDispatch.current = false;
    });
  }

  async function sendMessage(
    retryPrompt?: string,
    retryAttachments: readonly ComposerAttachment[] = [],
    queue?: Readonly<{ onAdmitted(): void }>,
  ) {
    let content = (retryPrompt ?? input).trim();
    if (
      !content
      || !runtime.current
      || !sessionId
      || busy
      || activeTurn.current
      || localCommandAdmission.current
      || inferenceRouteChanging.current
      || catalogAuthorityChanging.current
      || vaultProviderSwitchingRef.current
      || localDeviceBusy
    ) return;
    if (slashRegistry) {
      const slashPlan = planSlashCommand(content, slashRegistry);
      if (slashPlan.kind !== "chat") {
        // Local built-ins do not all create an AbortController. Keep a separate
        // synchronous admission lock so duplicate click/key events in one
        // render cannot create two sessions, forks, or local transcript rows.
        localCommandAdmission.current = true;
        setInput("");
        try {
          await runSlashPlan(slashPlan, content);
        } catch (error) {
          appendLocalExchange(content, error instanceof Error ? error.message : String(error), true);
        } finally {
          localCommandAdmission.current = false;
        }
        requestAnimationFrame(() => textarea.current?.focus());
        return;
      }
      content = slashPlan.content.trim();
      if (!content) return;
    }
    const turnSessionId = sessionId;
    const turnRuntime = runtime.current;
    const turnTransport = turnRuntime.transport;
    const externalPreflight = turnRuntime.inferenceBinding
      && turnRuntime.inferenceBinding.providerId !== "chutes"
      ? resolveExternalInferencePreflight(
          turnRuntime.inferenceBinding,
          activeExternalRouteRef.current,
          inferenceFabric.current,
        )
      : undefined;
    if (externalPreflight && externalPreflight.state !== "ready") {
      setComposerNotice(`${externalPreflight.detail} This conversation remains read-only; reconnecting or selecting another model starts a new pinned conversation. Your prompt remains here.`);
      setRuntimeStatus("Pinned inference route unavailable · prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    if (turnRuntime.inferenceBinding && !inferenceConnected) {
      setComposerNotice("This conversation is permanently pinned to a released inference generation and remains read-only. Reconnect in Connection to start a new pinned conversation; your prompt, messages, journal, and workspace remain here.");
      setRuntimeStatus("Remote inference disconnected · prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    if (!online && turnRuntime.inferenceBinding?.transportBoundary !== "loopback-local") {
      setRuntimeStatus("Offline · remote inference paused; prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    const outgoingAttachments = retryPrompt ? retryAttachments : attachments;
    if (outgoingAttachments.length > 0 && imageInputCapability !== "supported") {
      setComposerNotice(inferenceConnected
        ? imageInputCapability === "unknown"
          ? "Airship cannot verify image support from this model's catalog record. Choose a model with explicit image input."
          : `${turnRuntime.model} is text-only. Choose a vision-capable model; the image remains in this page.`
        : "Connect a vision-capable model; the image remains in this page.");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    // Claim the turn before the first asynchronous preprocessing or journal
    // operation. State-driven button disabling is not an admission lock: two
    // key/click events can run in the same render and otherwise append two
    // concurrent turns to one immutable session head.
    const controller = new AbortController();
    activeTurn.current = controller;
    activePrompt.current = content;
    setBusy(true);
    setRuntimeStatus("Preparing turn");
    const releasePreflight = () => {
      if (activeTurn.current === controller) activeTurn.current = undefined;
      if (activePrompt.current === content) activePrompt.current = undefined;
      setBusy(false);
    };
    let images: Awaited<ReturnType<typeof prepareCanonicalImageInputs>> | undefined = undefined;
    try {
      images = outgoingAttachments.length
        ? await prepareCanonicalImageInputs(outgoingAttachments.map((attachment) => attachment.file))
        : undefined;
      controller.signal.throwIfAborted();
    } catch (error) {
      releasePreflight();
      setComposerNotice(controller.signal.aborted
        ? "Turn stopped before inference; your prompt remains in the composer."
        : error instanceof Error ? error.message : "The selected image could not be prepared safely.");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    if (
      !retryPrompt
      && activeSessionRecord?.id === turnSessionId
      && activeSessionRecord.headSequence === 1
      && activeProfile
      && activeSessionRecord.title === `${activeProfile.name} conversation`
    ) {
      try {
        const renamed = await turnRuntime.journal.renameSession(
          turnSessionId,
          conversationTitleFromPrompt(content),
          controller.signal,
        );
        if (activeSessionIdentity.current === turnSessionId) {
          setActiveSessionRecord(renamed);
          setEventCount((count) => count + 1);
          setSessionRevision((value) => value + 1);
        }
      } catch {
        // Titling is presentational. A storage race must never prevent the turn.
      }
    }
    if (controller.signal.aborted) {
      releasePreflight();
      setRuntimeStatus("Turn stopped before submission");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    if (
      turnRuntime.inferenceBinding
      && turnRuntime.inferenceBinding.providerId !== "chutes"
    ) {
      try {
        const route = activeExternalRouteRef.current;
        const fabric = inferenceFabric.current;
        if (
          !route
          || !fabric
          || !inferenceBindingsMatch(turnRuntime.inferenceBinding, coreInferenceBinding(route))
          || fabric.preflight(route.pin).transport !== turnTransport
        ) {
          throw new Error("The exact page-memory inference route is no longer available.");
        }
      } catch (error) {
        releasePreflight();
        setComposerNotice(
          `${error instanceof Error ? error.message : "Inference route preflight failed."} `
          + "This conversation is now read-only; reconnecting or choosing another route starts a new pinned conversation. Your prompt and attachments remain here.",
        );
        setRuntimeStatus("Pinned inference route unavailable · prompt preserved");
        requestAnimationFrame(() => textarea.current?.focus());
        return;
      }
    }
    queue?.onAdmitted();
    if (retryPrompt === undefined) {
      setInput("");
      setAttachments([]);
    }
    setComposerNotice(undefined);
    setBusy(true);
    setRuntimeStatus("Persisting turn intent");
    const userMessage: UiMessage = {
      id: randomUuid(),
      role: "user",
      content,
      parts: outgoingAttachments.length ? userMessageParts(content, outgoingAttachments) : undefined,
      originatingPrompt: content,
      originatingAttachments: outgoingAttachments,
    };
    const userMessageId = userMessage.id;
    const assistantId = randomUuid();
    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        status: "Queued",
        originatingPrompt: content,
        originatingAttachments: outgoingAttachments,
      },
    ]);
    try {
      const result = await runTurn({
        sessionId: turnSessionId,
        content,
        ...(images?.length ? { images } : {}),
        transport: turnTransport,
        tools: turnRuntime.tools,
        journal: turnRuntime.journal,
        approvalPolicy,
        signal: controller.signal,
        maxSteps: 32,
        onSignal(signal) {
          if (signal.type === "durable") {
            const reachedAssistantBoundary = signal.events.some((event) => event.type === "assistant.completed");
            if (reachedAssistantBoundary) clearPendingDelta(assistantId);
            setSessionRevision((value) => value + signal.events.length);
            if (activeSessionIdentity.current === turnSessionId) {
              const scopedEvents = signal.events.filter((event) => event.sessionId === turnSessionId);
              setEventCount((count) => count + scopedEvents.length);
              setSessionLifecycle((current) => advanceSessionLifecycle(current, scopedEvents));
              const facts = messagePartFactsFromDurableEvents(scopedEvents);
              if (facts.length > 0) {
                setMessages((current) => current.map((message) => message.id === assistantId
                  ? {
                      ...message,
                      parts: facts.reduce(reduceMessagePartFact, message.parts ?? []),
                    }
                  : message));
              }
            }
          }
          if (signal.type === "status" && activeSessionIdentity.current === turnSessionId) {
            setRuntimeStatus(signal.status);
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, status: humanStatus(signal.status) } : message,
              ),
            );
          }
          if (signal.type === "text-delta" && activeSessionIdentity.current === turnSessionId) {
            queueTextDelta(assistantId, signal.text);
          }
          if (signal.type === "tool-output" && activeSessionIdentity.current === turnSessionId) {
            setMessages((current) => current.map((message) => {
              if (message.id !== assistantId) return message;
              const prior = message.liveToolOutput?.operationId === signal.operationId
                ? message.liveToolOutput.text
                : "";
              return {
                ...message,
                liveToolOutput: {
                  operationId: signal.operationId,
                  stream: signal.stream,
                  text: `${prior}${signal.text}`.slice(-32_768),
                },
              };
            }));
          }
        },
      });
      clearPendingDelta(assistantId);
      if (activeSessionIdentity.current === turnSessionId) {
        const requestEvent = result.events.find((event) => event.type === "turn.requested" && event.turnId === result.turnId);
        const terminalEvent = result.events.filter((event) => event.turnId === result.turnId && (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled")).at(-1);
        setMessages((current) =>
          current.map((message) =>
            message.id === userMessageId && requestEvent
              ? { ...message, sourcePoint: { sequence: requestEvent.sequence - 1, digest: requestEvent.previousDigest } }
              : message.id === assistantId
              ? {
                  ...message,
                  content: result.content,
                  parts: messagePartsFromDurableEvents(result.events, { turnId: result.turnId }),
                  receipt: result.receipt,
                  status: undefined,
                  liveToolOutput: undefined,
                  ...(terminalEvent?.type === "turn.completed"
                    ? { sourcePoint: { sequence: terminalEvent.sequence, digest: terminalEvent.digest } }
                    : requestEvent ? { sourcePoint: { sequence: requestEvent.sequence - 1, digest: requestEvent.previousDigest } } : {}),
                }
              : message,
          ),
        );
        setLastReceipt(result.receipt);
        announceCompletedTurnAwayFromChat();
        if (turnTransport.id === "chutes-e2ee-v1") {
          setConnection((current) => isChutesConnected(current) ? withVerifiedInvocation(current) : current);
          void acquireReceiptAttestation(result.receipt, undefined, false).catch(() => {
            // The evidence client records a bounded public failure state. A failed
            // background pull never changes the completed turn or its receipt.
          });
        }
      }
      const workspaceRefreshWarning = await refreshCompletedTurnWorkspace(() =>
        refreshWorkspaceState(turnRuntime.workspace, setFiles, setWorkspaceFiles)
      );
      if (activeSessionIdentity.current === turnSessionId) {
        setRuntimeStatus(workspaceRefreshWarning
          ? `Turn complete · workspace refresh delayed: ${workspaceRefreshWarning}`
          : "Local kernel ready");
      }
    } catch (error) {
      const pending = `${transcriptStreams.read(assistantId)}${pendingDelta.current?.messageId === assistantId ? pendingDelta.current.text : ""}`;
      clearPendingDelta(assistantId);
      const cancelled = controller.signal.aborted;
      if (activeSessionIdentity.current === turnSessionId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: "",
                  parts: recoverPartialTurn(message.parts ?? [], "", pending, cancelled),
                  status: undefined,
                  liveToolOutput: undefined,
                  error: true,
                }
              : message,
          ),
        );
        setRuntimeStatus(cancelled ? "Turn stopped" : mapUnknownRequestFailure(error, online).message);
      }
    } finally {
      if (activeTurn.current === controller) activeTurn.current = undefined;
      if (activePrompt.current === content) activePrompt.current = undefined;
      releaseComposerAndReloadSession({
        release: () => setBusy(false),
        load: () => turnRuntime.journal.getSession(turnSessionId),
        accept: () => activeSessionIdentity.current === turnSessionId,
        apply: (updatedSession) => {
          setActiveSessionRecord((current) =>
            !current || updatedSession.headSequence >= current.headSequence ? updatedSession : current
          );
        },
      });
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  function stopTurn() {
    if (activePrompt.current) setInput(activePrompt.current);
    activeTurn.current?.abort(new DOMException("Stopped by user", "AbortError"));
  }

  async function activateLocalDeviceWorkspace(
    key: LocalDeviceWorkspaceKey,
    reason: LocalDeviceActivationReason = "opened",
  ): Promise<void> {
    const existing = localDeviceHandle.current;
    if (
      existing
      && runtime.current?.workspaceId === `vault+local-device://${LOCAL_DEVICE_PARTITION}`
    ) return;
    setLocalDeviceBusy(true);
    setLocalDeviceError(undefined);
    let handle: LocalDeviceVaultHandle | undefined;
    try {
      const { openLocalDeviceVault } = await loadDeferredCapabilities();
      handle = await openLocalDeviceVault({
        partition: LOCAL_DEVICE_PARTITION,
        workspaceKey: key.key,
        disposition: key.vaultDisposition,
        displayName: "Airship on this device",
      });
      await adoptDurableRuntime({
        ready: handle.runtime,
        workspaceId: `vault+local-device://${LOCAL_DEVICE_PARTITION}`,
        label: "Encrypted Local Device vault",
        kind: "local-device",
        source: reason === "restored" ? "target-authoritative" : "migrate-active",
      });
      existing?.close();
      localDeviceHandle.current = handle;
      setLocalDeviceStatus(handle.status);
      setLocalDeviceError(undefined);
      setVaultSetupOpen(false);
    } catch (error) {
      handle?.close();
      setLocalDeviceError(error instanceof Error ? error.message : "The Local Device Vault could not be activated safely.");
      throw error;
    } finally {
      setLocalDeviceBusy(false);
    }
  }

  async function exportLocalDeviceBackup(): Promise<Uint8Array> {
    const handle = localDeviceHandle.current;
    if (!handle) throw new Error("Open the Local Device Vault before exporting a backup.");
    return handle.exportEncryptedBackup();
  }

  async function requestLocalDevicePersistence(): Promise<"granted" | "not-granted" | "unsupported"> {
    const handle = localDeviceHandle.current;
    if (!handle) throw new Error("Open the Local Device Vault before requesting persistence.");
    const persistence = await handle.requestPersistentStorage();
    setLocalDeviceStatus((current) => current ? Object.freeze({
      ...current,
      readiness: Object.freeze({
        ...current.readiness,
        persistence: persistence === "granted"
          ? "origin-private-persisted"
          : current.readiness.persistence,
        persistedPermission: persistence === "granted"
          ? "granted"
          : persistence === "not-granted"
            ? "not-granted"
            : "unknown",
        warning: persistence === "granted"
          ? undefined
          : persistence === "unsupported"
            ? "This browser cannot grant durable origin storage; export an encrypted backup."
            : "The browser may evict this origin under storage pressure; export an encrypted backup.",
      }),
    }) : current);
    return persistence;
  }

  async function restoreLocalDeviceBackup(
    request: LocalDeviceAtomicRestoreRequest,
  ): Promise<Readonly<{ restored: number }>> {
    if (request.partition !== LOCAL_DEVICE_PARTITION) {
      throw new Error("The selected backup targets a different Local Device Vault partition.");
    }
    if (vaultProviderSwitchingRef.current || inferenceRouteChanging.current) {
      throw new Error("Wait for the current storage or inference transition before restoring a backup.");
    }
    vaultProviderSwitchingRef.current = true;
    setVaultProviderSwitching(true);
    setLocalDeviceBusy(true);
    setLocalDeviceError(undefined);
    setRuntimeStatus("Verifying encrypted backup before atomic restore");
    const handle = localDeviceHandle.current;
    let handleClosed = false;
    try {
      const turn = activeTurn.current;
      turn?.abort(new DOMException("Local Device Vault restore started.", "AbortError"));
      const publication = vaultContextPublication.current;
      publication?.abort(new DOMException("Local Device Vault restore started.", "AbortError"));
      await waitForOperationRelease(
        () => (turn === undefined || activeTurn.current !== turn)
          && (publication === undefined || vaultContextPublication.current !== publication),
        "Airship is still stopping active workspace work. Retry the restore after it settles.",
      );

      if (handle) {
      const { quiesceBrowserTerminalWorkspace } = await import("../terminal/manager");
        if (runtime.current) {
          await quiesceBrowserTerminalWorkspace(
            runtime.current.workspace,
            "The Local Device Vault is being restored. Reopen this terminal after the restored workspace activates.",
          );
        }
        await handle.closeAndWait();
        handleClosed = true;
        localDeviceHandle.current = undefined;
        setLocalDeviceStatus(undefined);
        activeDurableAuthority.current = undefined;
      }
      const { restoreLocalDeviceVaultBackup } = await loadDeferredCapabilities();
      const result = await restoreLocalDeviceVaultBackup({
        partition: request.partition,
        workspaceKey: request.workspaceKey,
        disposition: request.disposition,
        backup: request.backup,
        signal: request.signal,
      });
      setRuntimeStatus(`Encrypted backup restored · ${String(result.restored)} objects verified`);
      return Object.freeze(result);
    } catch (error) {
      // Restore is authenticated and atomic. If replacement did not commit,
      // reopen the prior authority so the page never remains bound to a closed
      // storage adapter.
      if (handleClosed && request.disposition === "open-existing") {
        const reopened = Object.freeze({
          key: request.workspaceKey,
          vaultDisposition: "open-existing" as const,
          created: false,
          custody: "origin-private-non-extractable" as const,
        });
        await activateLocalDeviceWorkspace(reopened, "restored");
      }
      throw error;
    } finally {
      vaultProviderSwitchingRef.current = false;
      setVaultProviderSwitching(false);
      setLocalDeviceBusy(false);
    }
  }

  async function openFile(path: string) {
    const request = ++workspaceOpenRequest.current;
    const activeWorkspace = runtime.current?.workspace;
    const file = activeWorkspace
      ? await readWorkspaceFileBounded(activeWorkspace, path, WORKSPACE_EDITOR_BYTE_LIMIT)
      : undefined;
    if (request !== workspaceOpenRequest.current || runtime.current?.workspace !== activeWorkspace) return;
    setSelectedFile(file);
  }

  async function inspectExecutionCapabilities(): Promise<readonly ExecutionCapability[]> {
    const active = runtime.current;
    if (!active || !sessionId) throw new Error("The active browser runtime is not ready.");
    const tool = active.tools.get("inspect_execution_runtimes");
    if (!tool || tool.definition.effect !== "read") throw new Error("Runtime inspection is not installed in this agent profile.");
    const controller = new AbortController();
    const result = await tool.execute({}, {
      sessionId,
      turnId: `human-capabilities-${randomUuid()}`,
      operationId: `runtime-inspect-${randomUuid()}`,
      signal: controller.signal,
    });
    if (result.isError) throw new Error(result.content || "Runtime inspection failed safely.");
    const parsed = JSON.parse(result.content) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Runtime inspection returned an invalid capability list.");
    return Object.freeze(parsed as ExecutionCapability[]);
  }

  async function inspectBrowserCapabilities(): Promise<BrowserRuntimeCapabilityReport> {
    const { getBrowserCapabilityRegistry } = await import("../capabilities/browser-runtime");
    return getBrowserCapabilityRegistry().refresh(true);
  }

  function openCapabilityCommand(command: string): void {
    setInput(command);
    navigate("chat");
    requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
  }

  async function reviewGitOperation(
    operation: GitOperation,
    descriptor: GitOperationDescriptor,
  ): Promise<"allow" | "deny"> {
    if (!descriptor.approvalRequired) return "allow";
    const controller = new AbortController();
    return approvalPolicy.review(
      {
        name: `git_${operation.kind}`,
        description: `${descriptor.summary}. ${descriptor.dataLeavesDevice ? "Data may leave this device." : "No remote operation is implied."}`,
        effect: descriptor.brokerEffect,
        inputSchema: { type: "object" },
      },
      descriptor.arguments,
      {
        sessionId: sessionId ?? "airship-ui",
        turnId: `human-git-${randomUuid()}`,
        operationId: `git-${randomUuid()}`,
        signal: controller.signal,
      },
    );
  }

  async function reviewSourceImport(request: SourcesImportRequest): Promise<"allow" | "deny"> {
    const controller = new AbortController();
    return approvalPolicy.review(
      {
        name: "github_snapshot_import",
        description: "Read a bounded public GitHub snapshot directly in this browser, then write its text files into the selected workspace and local Git adapter.",
        effect: "network",
        inputSchema: { type: "object" },
      },
      {
        repository: request.repository,
        ref: request.ref ?? "default branch",
        destination: request.destination,
        services: ["api.github.com", "raw.githubusercontent.com"],
        history: "not-imported",
        maximumFiles: 2_000,
        maximumTextBytes: 33_554_432,
      },
      {
        sessionId: sessionId ?? "airship-ui",
        turnId: `human-source-${randomUuid()}`,
        operationId: `source-${randomUuid()}`,
        signal: controller.signal,
      },
    );
  }

  async function probeVault(): Promise<void> {
    if (!online) {
      setRuntimeStatus("Offline · remote vault probe paused");
      return;
    }
    const snapshot = vault.snapshot;
    if (snapshot.phase === "disconnected" || snapshot.phase === "probing") return;
    const controller = new AbortController();
    const decision = await approvalPolicy.review(
      {
        name: "vault_live_conformance",
        description: "Run bounded live object-store contract checks. This creates immutable encrypted probe objects that require provider lifecycle or out-of-band cleanup.",
        effect: "network",
        inputSchema: { type: "object" },
      },
      {
        endpoint: snapshot.config.endpoint,
        provider: isGoogleDriveConfiguration(snapshot.config) ? "google-drive" : "s3",
        location: isGoogleDriveConfiguration(snapshot.config) ? snapshot.config.workspaceName : snapshot.config.bucket,
        namespace: snapshot.config.namespace,
        immutableProbeObjects: true,
        cleanup: "provider-lifecycle-or-out-of-band",
        dataSynchronization: "not-evaluated",
      },
      {
        sessionId: sessionId ?? "airship-ui",
        turnId: `human-vault-${randomUuid()}`,
        operationId: `vault-probe-${randomUuid()}`,
        signal: controller.signal,
      },
    );
    if (decision !== "allow") {
      setRuntimeStatus("Vault probe denied; no readiness claim changed");
      return;
    }
    setRuntimeStatus("Testing the direct cloud and encrypted-state path");
    try {
      const result = await vault.probe({ acknowledgeImmutableProbeObjects: true });
      if (result.phase === "ready") {
        setRuntimeStatus("Vault storage contract passed; adoption pending");
      } else {
        setRuntimeStatus("Vault probe did not establish readiness");
      }
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? `Vault adoption stopped: ${error.message}` : "Vault adoption stopped safely");
    }
  }

  async function adoptReadyVaultRuntime(
    snapshot: Extract<VaultSnapshot, { phase: "ready" }>,
    ready: ReadyVaultRuntime,
  ): Promise<void> {
    const workspaceId = isGoogleDriveConfiguration(snapshot.config)
      ? `vault+gdrive://${snapshot.config.workspaceFolderId}/${snapshot.config.namespace}`
      : `vault+s3://${snapshot.config.bucket}/${snapshot.config.namespace}`;
    await adoptDurableRuntime({
      ready,
      workspaceId,
      label: isGoogleDriveConfiguration(snapshot.config)
        ? "Encrypted Google Drive vault"
        : "Encrypted S3 vault",
      kind: "cloud",
      source: "migrate-active",
    });
  }

  async function adoptDurableRuntime(
    authority: DurableAdoptionDescriptor,
  ): Promise<void> {
    if (catalogAuthorityChanging.current) throw new Error("Another profile storage transition is already active.");
    catalogAuthorityChanging.current = true;
    try {
      await catalogMutationTail.current;
      await adoptDurableRuntimeExclusive(authority);
    } finally {
      catalogAuthorityChanging.current = false;
    }
  }

  async function adoptDurableRuntimeExclusive(
    authority: DurableAdoptionDescriptor,
  ): Promise<void> {
    const { ready, workspaceId } = authority;
    const prior = runtime.current;
    const priorCheckpoint = catalogCheckpoint.current;
    if (!prior || !priorCheckpoint || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for vault adoption.");
    }
    activeTurn.current?.abort(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus(authority.kind === "local-device"
      ? "Opening encrypted device state"
      : "Migrating workspace and sessions into encrypted cloud objects");
    const [{ migrateJournalState, migrateProfileCatalogState, migrateWorkspaceState }, { quiesceBrowserTerminalWorkspace }] = await Promise.all([
      loadDeferredCapabilities(),
      import("../terminal/manager"),
    ]);
    const targetAuthoritative = authority.source === "target-authoritative";
    if (!targetAuthoritative) {
      await quiesceBrowserTerminalWorkspace(
        prior.workspace,
        "Storage authority changed to an encrypted Vault. Restart this terminal against the adopted workspace.",
      );
    }
    const [{ WorkspaceGitAdapter }, pristineBootstrap] = await Promise.all([
      loadBrowserGit(),
      targetAuthoritative ? Promise.resolve(true) : isPristineBootstrapRuntime(prior),
    ]);
    const targetCatalog = targetAuthoritative
      ? await ready.profiles.load()
      : undefined;
    const catalogMigration = targetCatalog
      ? Object.freeze({
          checkpoint: targetCatalog,
          disposition: "adopted-existing" as const,
        })
      : await migrateProfileCatalogState(
          priorCheckpoint,
          ready.profiles,
          {
            sourceIsBootstrap: targetAuthoritative
              || (pristineBootstrap && priorCheckpoint.generation === 1),
          },
        );
    const adoptedCatalog = catalogMigration.checkpoint.catalog;
    const adoptedProfiles = managedProfiles(adoptedCatalog);
    const selectedProfile = adoptedProfiles.find((candidate) => candidate.profileId === activeProfile.profileId)
      ?? adoptedProfiles.find((candidate) => candidate.profileId === "general")
      ?? adoptedProfiles[0];
    if (!selectedProfile) throw new Error("The encrypted Vault profile catalog has no profile available for new work.");
    // A freshly opened page contains deterministic sample state only. An
    // existing encrypted vault is authoritative; release-copy changes must not
    // be mistaken for user conflicts or create a throwaway session on reload.
    // Any real workspace edit or journal event disables this shortcut.
    if (!targetAuthoritative) {
      const targetHasUserWorkspace = (await ready.workspace.list()).some((entry) => !isWorkspaceControlPlanePath(entry.path));
      if (!pristineBootstrap || !targetHasUserWorkspace) {
        await migrateWorkspaceState(prior.workspace, ready.workspace);
      }
      if (!pristineBootstrap) await migrateJournalState(prior.journal, ready.journal);
    }

    const nextGitClient = new BrowserGitClient(await WorkspaceGitAdapter.open(
      ready.workspace,
      () => existingWorkspaceFallbackSeed(ready.workspace),
    ));
    const journal = new EventJournal(ready.journal);
    const vaultTools = await createVaultAwareAirshipToolRegistry({
      workspace: ready.workspace,
      workspaceId,
      journal,
      git: nextGitClient,
      contextFabric: ready.contextFabric,
      additionalTools: [requireProviderAvailabilityTool()],
    });
    const tools = vaultTools.tools;
    const nextRuntime: Runtime = {
      ...prior,
      workspace: ready.workspace,
      workspaceId,
      journal,
      profiles: ready.profiles,
      contextMode: vaultTools.contextMode,
      tools,
    };
    const profile = await bindProfileToRuntime(selectedProfile, nextRuntime);
    const nextCatalog = profile === selectedProfile ? adoptedCatalog : replaceProfile(adoptedCatalog, profile);
    const nextCatalogCheckpoint = nextCatalog === adoptedCatalog
      ? catalogMigration.checkpoint
      : await ready.profiles.commit(catalogMigration.checkpoint, nextCatalog);
    const library = new SessionLibrary(journal);
    const resumableSession = pristineBootstrap
      ? await latestCompatibleProfileSession(nextRuntime, profile, nextCatalog)
      : undefined;
    const nextSession = resumableSession ?? await createProfileSession(
      nextRuntime,
      profile,
      nextCatalog,
      `${profile.name} · encrypted vault`,
    );
    let resumedPresentation: Readonly<{
      messages: readonly UiMessage[];
      lastReceipt?: ConversationReceipt;
      lifecycle: SessionLifecycle;
      boundary?: Readonly<{ omittedMessages: number; shortened: boolean }>;
    }> | undefined;
    if (resumableSession) {
      const detail = await library.inspect(
        resumableSession.id,
        activeSessionRuntime(nextRuntime, resumableSession),
      );
      if (detail.compatibility?.action !== "resume") {
        throw new Error("The latest encrypted session no longer matches the adopted runtime.");
      }
      const events = await journal.readEvents(resumableSession.id);
      const { auditSessionHistory, presentSessionMessages } = await loadDeferredCapabilities();
      const audit = await auditSessionHistory({ session: resumableSession, events });
      if (audit.status !== "verified") {
        throw new Error("The latest encrypted session failed its digest/protocol audit and was not resumed.");
      }
      const presentation = presentSessionMessages({
        session: resumableSession,
        audit,
        events: boundedSessionPresentationEvents(events),
        receipts: detail.transcript.receipts,
        history: detail.transcript.messages.flatMap((message) => message.turnId ? [{
          turnId: message.turnId,
          turnStatus: message.turnStatus,
          providerContext: message.providerContext,
        }] : []),
      });
      const messages = presentation.rows.map((row, index) => {
        const originatingPrompt = originatingPromptForRow(presentation.rows, index);
        return {
          id: row.id,
          role: row.role,
          content: messagePlainText(row.parts),
          parts: row.parts,
          ...(row.receipt ? { receipt: row.receipt } : {}),
          ...(originatingPrompt ? { originatingPrompt } : {}),
          history: { turnStatus: row.turnStatus, providerContext: row.providerContext },
          sourcePoint: row.sourcePoint,
        } satisfies UiMessage;
      });
      const lastPresentationReceipt = presentation.rows
        .flatMap((row) => row.receipt ? [row.receipt] : [])
        .at(-1);
      resumedPresentation = Object.freeze({
        messages: Object.freeze(messages),
        ...(lastPresentationReceipt ? { lastReceipt: lastPresentationReceipt } : {}),
        lifecycle: detail.transcript.lifecycle,
        ...(detail.transcript.truncated ? {
          boundary: Object.freeze({
            omittedMessages: detail.transcript.omittedMessages,
            shortened: detail.transcript.messages.some((message) => message.truncated),
          }),
        } : {}),
      });
    }

    runtime.current = nextRuntime;
    activeDurableAuthority.current = authority;
    setGitClient(nextGitClient);
    setSlashRegistry(createSlashCommandRegistry({ tools }));
    setSessionLibrary(library);
    publishCatalogCheckpoint(nextCatalogCheckpoint);
    setProfileId(profile.profileId);
    activateSession(nextSession);
    setMessages(resumedPresentation?.messages.length
      ? [...resumedPresentation.messages]
      : [{
          ...welcomeMessage,
          id: randomUuid(),
          content: resumableSession
            ? `Resumed ${resumableSession.title} from the encrypted Vault. ${welcomeMessage.content}`
            : authority.kind === "local-device"
              ? "The encrypted Local Device Vault is active. This new pinned session writes workspace files, explicit memories, task state, and session events as encrypted browser-managed objects that remain available offline."
              : "The verified Vault contract is now active. This new pinned session writes workspace files, explicit memories, task state, and session events as client-encrypted cloud objects; the previous page-memory sessions were migrated and remain separately inspectable.",
        }]);
    setEventCount(nextSession.headSequence);
    setSessionRevision((value) => value + 1);
    setLastReceipt(resumedPresentation?.lastReceipt);
    setSessionLifecycle(resumedPresentation?.lifecycle ?? READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(resumedPresentation?.boundary);
    let workspaceRefreshDeferred = false;
    try {
      await refreshWorkspaceState(ready.workspace, setFiles, setWorkspaceFiles);
    } catch {
      workspaceRefreshDeferred = true;
      setFiles([]);
      setWorkspaceFiles([]);
    }
    const contextLabel = vaultTools.contextMode === "encrypted-ranged"
      ? "encrypted ranged context active"
      : "local context fallback";
    setVaultContextPublicationMessage(vaultTools.contextMode === "encrypted-ranged"
      ? "A matching encrypted context generation was adopted without uploading new shards."
      : "No matching encrypted generation was found. Turns continue with the on-device index until you publish one.");
    setRuntimeStatus(resumableSession
      ? `${authority.label} active · audited session resumed · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`
      : `${authority.label} active · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`);
  }

  async function publishEncryptedContextIndex(): Promise<void> {
    if (vaultContextPublication.current || vaultContextPublishing) return;
    if (busy || activeTurn.current) {
      setVaultContextPublicationMessage("Finish or stop the active turn before publishing a context generation.");
      return;
    }
    const active = runtime.current;
    const authority = activeDurableAuthority.current;
    if (
      !active
      || !active.workspaceId.startsWith("vault+")
      || !gitClient
      || !authority
      || authority.workspaceId !== active.workspaceId
    ) {
      setVaultContextPublicationMessage("Adopt a verified encrypted Vault before publishing context shards.");
      return;
    }
    const ready = authority.ready;
    const controller = new AbortController();
    vaultContextPublication.current = controller;
    setVaultContextPublishing(true);
    setVaultContextPublicationMessage("Building the current on-device generation and encrypting its derived shards…");
    setRuntimeStatus("Publishing explicitly approved encrypted context shards");
    try {
      const published = await createVaultBackedAirshipToolRegistry({
        workspace: active.workspace,
        workspaceId: active.workspaceId,
        journal: active.journal,
        git: gitClient,
        contextFabric: ready.contextFabric,
        publicationPolicy: "explicit-user-approved",
        additionalTools: [requireProviderAvailabilityTool()],
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (
        runtime.current !== active ||
        activeDurableAuthority.current !== authority
      ) {
        throw new DOMException("Vault authority changed while context shards were publishing.", "AbortError");
      }
      if (!published.context) {
        setVaultContextPublicationMessage("There are no indexable workspace chunks to publish. The on-device index remains active.");
        setRuntimeStatus("Context publication skipped · no indexable workspace chunks");
        return;
      }
      runtime.current = {
        ...active,
        tools: published.tools,
        contextMode: published.contextMode,
      };
      setSlashRegistry(createSlashCommandRegistry({ tools: published.tools }));
      setVaultContextPublicationMessage("Encrypted context generation published. Matching turns now fetch selected authenticated ranges from the Vault.");
      setRuntimeStatus("Encrypted ranged context published and available");
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      setVaultContextPublicationMessage(cancelled
        ? "Context publication stopped. The prior turn provider remains active."
        : error instanceof Error
          ? `Context publication failed: ${error.message}`
          : "Context publication failed safely. The prior turn provider remains active.");
      setRuntimeStatus(cancelled ? "Context publication stopped" : "Context publication failed safely");
    } finally {
      if (vaultContextPublication.current === controller) vaultContextPublication.current = undefined;
      setVaultContextPublishing(false);
    }
  }

  async function adoptEphemeralRuntime(): Promise<void> {
    if (catalogAuthorityChanging.current) throw new Error("Another profile storage transition is already active.");
    catalogAuthorityChanging.current = true;
    try {
      await catalogMutationTail.current;
      await adoptEphemeralRuntimeExclusive();
    } finally {
      catalogAuthorityChanging.current = false;
    }
  }

  async function adoptEphemeralRuntimeExclusive(): Promise<void> {
    const prior = runtime.current;
    const priorCheckpoint = catalogCheckpoint.current;
    if (!prior || !priorCheckpoint || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for an ephemeral transition.");
    }
    if (!prior.workspaceId.startsWith("vault+")) {
      vault.disconnect();
      return;
    }
    activeTurn.current?.abort(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus("Moving the active encrypted state into page memory");
    const [{ migrateJournalState, migrateWorkspaceState }, { quiesceBrowserTerminalWorkspace }] = await Promise.all([
      loadDeferredCapabilities(),
      import("../terminal/manager"),
    ]);
    await quiesceBrowserTerminalWorkspace(
      prior.workspace,
      "Storage authority changed to page memory. Restart this terminal against the adopted workspace.",
    );
    const workspace = new MemoryWorkspace();
    const journalBackend = new MemoryJournalBackend();
    await migrateWorkspaceState(prior.workspace, workspace);
    await migrateJournalState(prior.journal, journalBackend);

    const { WorkspaceGitAdapter } = await loadBrowserGit();
    const nextGitClient = new BrowserGitClient(await WorkspaceGitAdapter.open(
      workspace,
      () => existingWorkspaceFallbackSeed(workspace),
    ));
    const journal = new EventJournal(journalBackend);
    const tools = await createAirshipToolRegistry({
      workspace,
      journal,
      git: nextGitClient,
      additionalTools: [requireProviderAvailabilityTool()],
    });
    const profiles = new MemoryProfileCatalogStore();
    const copiedCatalog = (await profiles.initialize(priorCheckpoint.catalog)).checkpoint;
    const nextRuntime: Runtime = {
      ...prior,
      workspace,
      workspaceId: "memory://airship-page",
      journal,
      profiles,
      tools,
    };
    const profile = await bindProfileToRuntime(activeProfile, nextRuntime);
    const nextCatalog = profile === activeProfile ? copiedCatalog.catalog : replaceProfile(copiedCatalog.catalog, profile);
    const nextCatalogCheckpoint = nextCatalog === copiedCatalog.catalog
      ? copiedCatalog
      : await profiles.commit(copiedCatalog, nextCatalog);
    const nextSession = await createProfileSession(nextRuntime, profile, nextCatalog, `${profile.name} · ephemeral`);

    runtime.current = nextRuntime;
    activeDurableAuthority.current = undefined;
    setGitClient(nextGitClient);
    setSlashRegistry(createSlashCommandRegistry({ tools }));
    setSessionLibrary(new SessionLibrary(journal));
    publishCatalogCheckpoint(nextCatalogCheckpoint);
    setProfileId(profile.profileId);
    activateSession(nextSession);
    setSessionRevision((value) => value + 1);
    setMessages([{
      ...welcomeMessage,
      id: randomUuid(),
      content: "Ephemeral mode is active. The current workspace and session history were copied into page memory, and the Vault connection was closed. New changes are not synced.",
    }]);
    setEventCount(nextSession.headSequence);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    let workspaceRefreshDeferred = false;
    try {
      await refreshWorkspaceState(workspace, setFiles, setWorkspaceFiles);
    } catch {
      workspaceRefreshDeferred = true;
      setFiles([]);
      setWorkspaceFiles([]);
    }
    if (prior.workspaceId.startsWith("vault+local-device://")) {
      localDeviceHandle.current?.close();
      localDeviceHandle.current = undefined;
      setLocalDeviceStatus(undefined);
    }
    vault.disconnect();
    setRuntimeStatus(workspaceRefreshDeferred
      ? "Ephemeral mode · page memory only · file view refresh due"
      : "Ephemeral mode · page memory only");
  }

  async function changeVaultProvider(next: VaultBackend): Promise<void> {
    if (vaultProviderSwitchingRef.current || next === preferences.vaultBackend) return;
    if (inferenceRouteChanging.current) {
      setRuntimeStatus("Finish the current inference route change before switching storage");
      return;
    }
    vaultContextPublication.current?.abort(new DOMException("Vault provider is changing.", "AbortError"));
    vaultProviderSwitchingRef.current = true;
    setVaultProviderSwitching(true);
    setVaultSetupOpen(false);
    setRuntimeStatus("Safely releasing the current vault provider");
    try {
      await transitionVaultProvider({
        current: preferences.vaultBackend,
        next,
        runtimeUsesVault: () => runtime.current?.workspaceId.startsWith("vault+") === true,
        adoptEphemeralRuntime,
        disconnectAuthority: () => vault.disconnect(),
        commitPreference: (provider) => setPreferences((current) => Object.freeze({ ...current, vaultBackend: provider })),
      });
      setVaultSetupOpen(next !== "ephemeral");
      setRuntimeStatus(next === "google-drive"
        ? "Google Drive selected · connect your workspace"
        : next === "local-lab"
          ? "S3-compatible storage selected · configure the provider"
          : next === "local-device"
            ? "Local Device selected · opening encrypted offline workspace"
            : "Ephemeral mode · page memory only");
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : "Vault provider switch stopped safely");
    } finally {
      vaultProviderSwitchingRef.current = false;
      setVaultProviderSwitching(false);
    }
  }

  async function disconnectVaultSafely(): Promise<void> {
    if (vaultProviderSwitchingRef.current) return;
    if (inferenceRouteChanging.current) {
      setRuntimeStatus("Finish the current inference route change before disconnecting storage");
      return;
    }
    vaultContextPublication.current?.abort(new DOMException("Vault is disconnecting.", "AbortError"));
    vaultProviderSwitchingRef.current = true;
    setVaultProviderSwitching(true);
    setRuntimeStatus("Moving active Vault state into page memory");
    try {
      await releaseVaultAuthority({
        runtimeUsesVault: () => runtime.current?.workspaceId.startsWith("vault+") === true,
        adoptEphemeralRuntime,
        disconnectAuthority: () => vault.disconnect(),
      });
      setVaultSetupOpen(preferences.vaultBackend !== "ephemeral");
      setRuntimeStatus("Vault disconnected · active workspace continues in page memory");
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : "Vault disconnect stopped safely");
    } finally {
      vaultProviderSwitchingRef.current = false;
      setVaultProviderSwitching(false);
    }
  }

  async function reauthorizeGoogleDriveVault(): Promise<void> {
    if (driveReauthorizingRef.current) return;
    driveReauthorizingRef.current = true;
    setDriveReauthorizing(true);
    setRuntimeStatus("Waiting for Google to renew page-memory Drive access");
    try {
      await vault.reauthorizeGoogleDrive();
      setRuntimeStatus("Google Drive access renewed · verifying the live encrypted contract");
      await probeVault();
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : "Google Drive reauthorization stopped safely");
    } finally {
      driveReauthorizingRef.current = false;
      setDriveReauthorizing(false);
    }
  }

  async function installAttestationEvidenceClient(
    credential: string,
    credentialKind: ActiveChutesConnection["credentialKind"],
  ): Promise<void> {
    const operation = ++attestationOperation.current;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    providerCredential.current = credential;
    setAttestationRecords([]);
    setAttestationFailure(undefined);
    try {
      const {
        ChutesAttestationEvidenceClient: EvidenceClient,
        createIntelDcapQvlVerifierPort,
      } = await loadDeferredCapabilities();
      if (operation !== attestationOperation.current) return;
      const cachePartition = `connection-${randomUuid()}`;
      attestationClient.current = new EvidenceClient({
        authorization: {
          kind: credentialKind === "oauth-user-token" ? "oauth" : "api-key",
          cachePartition,
          getBearerToken(signal) {
            if (signal.aborted) throw signal.reason ?? new DOMException("Attestation acquisition cancelled.", "AbortError");
            const current = providerCredential.current;
            if (!current) throw new Error("The memory-only Chutes credential was cleared.");
            return current;
          },
        },
        // Complete Intel DCAP QVL runs locally in deferred WASM. When QVL or
        // collateral is unavailable, its compact verifier preserves an exact
        // partial diagnosis and never promotes the claim.
        verifierPorts: { dcap: createIntelDcapQvlVerifierPort() },
      });
    } catch {
      if (operation !== attestationOperation.current) return;
      providerCredential.current = undefined;
      setAttestationFailure({ label: "Evidence client unavailable", scope: "connection" });
    }
  }

  function clearAttestationEvidence(preservePresentation = false): void {
    attestationOperation.current += 1;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    providerCredential.current = undefined;
    if (!preservePresentation) {
      setAttestationRecords([]);
      setAttestationFailure(undefined);
    }
  }

  async function acquireEndpointAttestation(args: {
    chuteId: string;
    instanceId: string;
    signal?: AbortSignal;
    forceRefresh: boolean;
    failureTarget?: Omit<AttestationAcquisitionFailure, "label">;
  }): Promise<void> {
    const client = attestationClient.current;
    if (!client || !providerCredential.current) {
      throw new MountedAttestationError(
        "invalid-input",
        "Connect a memory-only Chutes credential before acquiring endpoint evidence.",
      );
    }
    const operation = ++attestationOperation.current;
    let snapshot = await client.inspect({
      chuteId: args.chuteId,
      instanceId: args.instanceId,
      evidenceRoute: "instance",
      includePublishedPolicy: true,
      forceRefresh: args.forceRefresh,
      signal: args.signal,
    });
    if (
      snapshot.status === "unavailable" &&
      (snapshot.unavailable?.code === "forbidden" || snapshot.unavailable?.code === "unauthorized") &&
      !args.signal?.aborted
    ) {
      // The authenticated per-instance route can still reject a caller at its
      // handler-level ownership/shared/public check. Public hosted chutes permit
      // a batch evidence read; selection still requires the exact authenticated
      // discovery instance and key. Reuse the first discovery snapshot so a
      // second random bounded subset cannot create a false "unavailable" result.
      snapshot = await client.inspect({
        chuteId: args.chuteId,
        instanceId: args.instanceId,
        evidenceRoute: "public-chute",
        includePublishedPolicy: true,
        forceRefresh: false,
        signal: args.signal,
      });
    }
    if (args.signal?.aborted || operation !== attestationOperation.current) return;
    if (snapshot.status !== "evidence" || !snapshot.record) {
      const error = attestationSnapshotError(snapshot);
      setAttestationFailure({
        label: attestationFailureLabel(error.code),
        ...(args.failureTarget ?? { scope: "endpoint", instanceId: args.instanceId }),
      });
      throw error;
    }
    const viewRecord = endpointEvidenceForView(snapshot.record);
    setAttestationRecords((current) => Object.freeze([
      viewRecord,
      ...current.filter((record) => record.recordId !== viewRecord.recordId),
    ].slice(0, 8)));
    setAttestationFailure(undefined);
  }

  /**
   * Pull + verify fresh evidence for a currently-live instance of the connected
   * chute. Unlike a receipt refresh, this needs no prior turn: it discovers an
   * active endpoint and attests it as endpoint-evidence (never a retroactive
   * conversation upgrade). This is what makes "Refresh evidence" work cold.
   */
  async function probeCurrentEndpoint(signal?: AbortSignal): Promise<void> {
    const client = attestationClient.current;
    if (!client || !providerCredential.current || !isChutesConnected(connection)) return;
    const model = availableModels.find((candidate) => candidate.id === connection.model);
    if (!model) {
      setAttestationFailure({ label: "Endpoint model unavailable", scope: "connection" });
      return;
    }
    let discovery;
    try {
      discovery = await client.discover(model.chuteId, { signal, forceRefresh: true });
    } catch (error) {
      if (!signal?.aborted) setAttestationFailure({ label: "Endpoint discovery failed", scope: "endpoint" });
      throw error;
    }
    const endpoint = discovery.endpoints[0];
    if (!endpoint) {
      setAttestationFailure({ label: "No live endpoint is currently discoverable", scope: "endpoint" });
      return;
    }
    // forceRefresh:false so inspect() reuses the discovery subset we just pulled
    // above — otherwise it re-discovers a different random subset that may not
    // contain this instance, and refuses to substitute → false rejection.
    await acquireEndpointAttestation({
      chuteId: model.chuteId,
      instanceId: endpoint.instanceId,
      forceRefresh: false,
      signal,
      failureTarget: { scope: "endpoint", instanceId: endpoint.instanceId },
    });
  }

  async function acquireReceiptAttestation(
    receipt: ConversationReceipt,
    signal: AbortSignal | undefined,
    forceRefresh: boolean,
  ): Promise<void> {
    if (!isChutesReceiptProvider(receipt.provider) || !receipt.instanceId || !receipt.model) {
      throw new MountedAttestationError(
        "invalid-input",
        "The selected receipt does not name an exact Chutes model and instance.",
      );
    }
    const model = availableModels.find((candidate) => candidate.id === receipt.model);
    if (!model) {
      throw new MountedAttestationError(
        "subject-not-found",
        "The exact receipt model is unavailable in the active authoritative model snapshot.",
        { retryable: true },
      );
    }
    await acquireEndpointAttestation({
      chuteId: model.chuteId,
      instanceId: receipt.instanceId,
      signal,
      forceRefresh,
      failureTarget: {
        scope: "receipt",
        receiptId: receipt.receiptId,
        instanceId: receipt.instanceId,
        ...(receipt.bindings.endpointKeyDigest ? { endpointKeyDigest: receipt.bindings.endpointKeyDigest } : {}),
      },
    });
  }

  async function refreshAttestation(target: AttestationRefreshTarget, signal: AbortSignal): Promise<void> {
    if (!online) throw new Error(OFFLINE_INLINE_REASON);
    if (target.kind === "conversation-receipt") {
      await acquireReceiptAttestation(target.receipt, signal, true);
      return;
    }
    const chuteId = target.record.subject.chuteId;
    if (!chuteId) {
      throw new MountedAttestationError(
        "invalid-input",
        "The selected endpoint record does not identify its Chutes chute.",
      );
    }
    await acquireEndpointAttestation({
      chuteId,
      instanceId: target.record.subject.instanceId,
      signal,
      forceRefresh: true,
      failureTarget: {
        scope: "endpoint",
        instanceId: target.record.subject.instanceId,
        endpointKeyDigest: target.record.subject.e2ePublicKeyDigest,
      },
    });
  }

  async function runInferenceRouteTransition<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (inferenceRouteChanging.current) {
      throw new Error("Another inference route is already being activated.");
    }
    if (
      vaultProviderSwitchingRef.current
      || catalogAuthorityChanging.current
      || localDeviceBusy
    ) {
      throw new Error("Wait for the active storage transition before changing inference.");
    }
    if (sessionNavigationChanging.current) {
      throw new Error("A conversation or profile transition is still being committed.");
    }
    inferenceRouteChanging.current = true;
    setModelSwitching(true);
    try {
      return await operation();
    } finally {
      inferenceRouteChanging.current = false;
      setModelSwitching(false);
    }
  }

  async function connectChutes(
    transport: ChutesInferenceTransport,
    model: AirshipModel,
    models: readonly AirshipModel[],
    credential: string,
    connectionMetadata: ActiveChutesConnection,
  ) {
    const routeProfile = activeProfileRef.current;
    if (!runtime.current || !routeProfile || !catalog) throw new Error("The local runtime is not ready.");
    const parsedCredential = parseChutesCredential(credential);
    if (
      connectionMetadata.model !== model.id ||
      connectionMetadata.credentialKind !== parsedCredential.kind ||
      connectionMetadata.posture !== transport.posture ||
      !models.some((candidate) => candidate.id === model.id)
    ) {
      throw new Error("The selected model, transport posture, and credential metadata do not form one connection.");
    }
    const priorRuntime = runtime.current;
    const priorChutesTransport = chutesTransport.current;
    const expectedChutesAuthorityRevision = chutesAuthorityRevision.current;
    return runInferenceRouteTransition(async () => {
      activeTurn.current?.abort(new DOMException("Inference route is changing.", "AbortError"));
      setRuntimeStatus("Pinning encrypted Chutes session");
      const nextGeneration = chutesConnectionGeneration.current + 1;
      const nextConnectionId = `chutes-${randomUuid()}`;
      const binding = Object.freeze({
        version: 1 as const,
        connectionId: nextConnectionId,
        connectionGeneration: nextGeneration,
        providerId: "chutes",
        providerLabel: "Chutes",
        providerRevision: 1,
        authMethod: parsedCredential.kind === "oauth-user-token" ? "oauth-pkce" as const : "api-key" as const,
        transportBoundary: "e2ee-attestable" as const,
        modelId: model.id,
        boundAt: new Date().toISOString(),
      });
      const committedRuntime: Runtime = {
        ...priorRuntime,
        transport,
        model: model.id,
        inferenceBinding: binding,
        contextPolicy: contextPolicyForModel(model),
      };
      const nextAvailability = Object.freeze({
        connection: connectionMetadata,
        connectionId: nextConnectionId,
        generation: nextGeneration,
        models: Object.freeze(models.slice()),
      });
      const candidateRuntime: Runtime = {
        ...committedRuntime,
        inferenceDirectory: () => inferenceDirectoryFromAvailability(
          combinedInferenceAvailability(
            inferenceFabric.current?.availability() ?? EMPTY_INFERENCE_AVAILABILITY,
            nextAvailability,
            binding,
          ),
        ),
      };
      let nextSession: SessionRecord | undefined;
      let nextProfile: ProfileRevision | undefined;
      await mutateProfileCatalog(async (current) => {
        const selected = current.profiles.find((candidate) => candidate.profileId === routeProfile.profileId);
        if (!selected || runtime.current !== priorRuntime) {
          throw new Error("The active profile or browser runtime changed while the connection was being pinned.");
        }
        nextProfile = await bindProfileToRuntime(selected, candidateRuntime);
        const next = nextProfile === selected ? current : replaceProfile(current, nextProfile);
        nextSession = await createProfileSession(candidateRuntime, nextProfile, next);
        return next;
      });
      if (!nextProfile || !nextSession) throw new Error("The encrypted Chutes session was not created.");
      if (
        runtime.current !== priorRuntime
        || chutesAuthorityRevision.current !== expectedChutesAuthorityRevision
      ) {
        throw new Error("The Chutes credential authority changed before the new session could commit.");
      }

      runtime.current = committedRuntime;
      chutesAvailability.current = nextAvailability;
      accountCredential.current = credential;
      chutesTransport.current = transport;
      chutesConnectionId.current = nextConnectionId;
      chutesConnectionGeneration.current = nextGeneration;
      const committedAuthorityRevision = expectedChutesAuthorityRevision + 1;
      chutesAuthorityRevision.current = committedAuthorityRevision;
      if (priorChutesTransport && priorChutesTransport !== transport) {
        priorChutesTransport.revokeCredential(
          new DOMException("A replacement Chutes credential was activated.", "AbortError"),
        );
      }
      activeExternalRouteRef.current = undefined;
      setActiveExternalRoute(undefined);
      activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([
        {
          ...welcomeMessage,
          id: randomUuid(),
          content: connectionMetadata.posture === "encrypted-attested"
            ? `Connected to ${model.id} through Chutes E2EE v1 with a fail-closed proof gate. Before each encrypted invocation, Airship must locally accept fresh endpoint evidence and its key binding. Turn receipts show the evidence actually established; this connection policy alone is not proof.`
            : `Connected to ${model.id} through Chutes E2EE v1 with the verify-and-record evidence policy. Payloads use E2EE; endpoint evidence is acquired and evaluated after completed invocations. Missing or partial verifier evidence stays visibly unverified and does not block encrypted chat.`,
        },
      ]);
      setEventCount(1);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      await installAttestationEvidenceClient(credential, connectionMetadata.credentialKind);
      if (
        chutesAuthorityRevision.current !== committedAuthorityRevision
        || chutesTransport.current !== transport
        || chutesConnectionId.current !== nextConnectionId
        || runtime.current !== committedRuntime
      ) {
        throw new Error("The Chutes credential authority was released while connection setup was finishing.");
      }
      setAvailableModels(Object.freeze(models.slice()));
      setCredentialRevision((value) => value + 1);
      setInvocationTelemetry(undefined);
      setConnection(connectionMetadata);
      setRuntimeStatus(connectionMetadata.posture === "encrypted-attested"
        ? "Encrypted session ready · endpoint proof required on every turn"
        : "Encrypted session ready · endpoint evidence recorded after completed turns");
      navigate("chat");
    });
  }

  function releaseChutesAuthority(status: string): void {
    chutesAuthorityRevision.current += 1;
    const active = runtime.current;
    const releasedTransport = chutesTransport.current;
    const releasesActiveRoute = active?.inferenceBinding?.providerId === "chutes"
      && active.transport.id === "chutes-e2ee-v1";
    if (releasesActiveRoute && active) {
      activeTurn.current?.abort(new DOMException("Remote inference credential was released.", "AbortError"));
      // Preserve the provider/model/posture pin used to interpret this immutable
      // conversation, while ensuring a direct API key cannot remain captured by
      // the old transport. Reconnection performs the next semantic rebind.
      active.transport = withoutCredential(active.transport);
    }
    oauthTokens.current = undefined;
    pendingOAuthCredential.current = undefined;
    accountCredential.current = undefined;
    chutesTransport.current = undefined;
    chutesConnectionId.current = undefined;
    chutesAvailability.current = undefined;
    clearAttestationEvidence(true);
    setAvailableModels([]);
    setCredentialRevision((value) => value + 1);
    setOauthTokenRevision((value) => value + 1);
    setInvocationTelemetry(undefined);
    setConnection(DISCONNECTED_CHUTES_CONNECTION);
    releasedTransport?.revokeCredential(
      new DOMException("Chutes connection was released from page memory.", "AbortError"),
    );
    if (releasesActiveRoute) {
      setComposerNotice("Remote inference is disconnected. This conversation remains readable and pinned to the released authority; reconnecting starts a new conversation.");
      setRuntimeStatus(status);
    } else {
      setRuntimeStatus("Chutes connection released · active conversation unchanged");
    }
  }

  async function disconnectChutes() {
    if (inferenceRouteChanging.current) {
      throw new Error("Wait for the current inference route change before clearing Chutes.");
    }
    setOauthCallbackStatus(undefined);
    releaseChutesAuthority("Inference disconnected · conversation retained");
  }

  async function switchChutesModel(modelId: string): Promise<void> {
    const routeProfile = activeProfileRef.current;
    if (!runtime.current || !routeProfile || !catalog || !isChutesConnected(connection)) {
      throw new Error("Connect Chutes before selecting a remote model.");
    }
    const model = availableModels.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("The selected model is not in the active authoritative Chutes catalog snapshot.");
    if (model.id === connection.model && activeChutesConnection) return;
    const transport = chutesTransport.current;
    const connectionId = chutesConnectionId.current;
    const expectedAuthorityRevision = chutesAuthorityRevision.current;
    if (!transport) {
      throw new Error("The Chutes credential transport is no longer in page memory. Reconnect before creating a new Chutes session.");
    }
    if (!connectionId) {
      throw new Error("The Chutes connection authority is no longer in page memory. Reconnect before creating a new session.");
    }

    const priorRuntime = runtime.current;
    return runInferenceRouteTransition(async () => {
      setRuntimeStatus("Forking a model-pinned session");
      activeTurn.current?.abort(new DOMException("Inference model is changing.", "AbortError"));
      await transport.verifyModelAccess(model.id);
      if (runtime.current !== priorRuntime) {
        throw new Error("The browser runtime changed while Chutes model access was being checked.");
      }
      const nextConnection = withChutesModel(connection, model.id);
      const binding = Object.freeze({
        version: 1 as const,
        connectionId,
        connectionGeneration: Math.max(1, chutesConnectionGeneration.current),
        providerId: "chutes",
        providerLabel: "Chutes",
        providerRevision: 1,
        authMethod: connection.kind === "chutes-oauth" ? "oauth-pkce" as const : "api-key" as const,
        transportBoundary: "e2ee-attestable" as const,
        modelId: model.id,
        boundAt: new Date().toISOString(),
      });
      const committedRuntime: Runtime = {
        ...priorRuntime,
        transport,
        model: model.id,
        inferenceBinding: binding,
        contextPolicy: contextPolicyForModel(model),
      };
      const nextAvailability = Object.freeze({
        connection: nextConnection,
        connectionId,
        generation: Math.max(1, chutesConnectionGeneration.current),
        models: Object.freeze(availableModels.slice()),
      });
      const candidateRuntime: Runtime = {
        ...committedRuntime,
        inferenceDirectory: () => inferenceDirectoryFromAvailability(
          combinedInferenceAvailability(
            inferenceFabric.current?.availability() ?? EMPTY_INFERENCE_AVAILABILITY,
            nextAvailability,
            binding,
          ),
        ),
      };
      let nextSession: SessionRecord | undefined;
      let nextProfile: ProfileRevision | undefined;
      await mutateProfileCatalog(async (current) => {
        const selected = current.profiles.find((candidate) => candidate.profileId === routeProfile.profileId);
        if (!selected || runtime.current !== priorRuntime) {
          throw new Error("The active profile or browser runtime changed while the model was being pinned.");
        }
        nextProfile = await bindProfileToRuntime(selected, candidateRuntime);
        const next = nextProfile === selected ? current : replaceProfile(current, nextProfile);
        nextSession = await createProfileSession(candidateRuntime, nextProfile, next);
        return next;
      });
      if (!nextProfile || !nextSession) throw new Error("The model-pinned session was not created.");
      if (
        runtime.current !== priorRuntime
        || chutesAuthorityRevision.current !== expectedAuthorityRevision
        || chutesTransport.current !== transport
        || chutesConnectionId.current !== connectionId
        || chutesConnectionGeneration.current !== binding.connectionGeneration
      ) {
        throw new Error("The Chutes credential authority changed before the model switch could commit.");
      }

      runtime.current = committedRuntime;
      chutesAvailability.current = nextAvailability;
      activeExternalRouteRef.current = undefined;
      setActiveExternalRoute(undefined);
      activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        content: `${model.id} is active in a new pinned session. The prior session and its receipt chain were not rewritten.`,
      }]);
      setEventCount(1);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      attestationOperation.current += 1;
      attestationClient.current?.cancel();
      attestationClient.current?.clear();
      setAttestationRecords([]);
      setAttestationFailure(undefined);
      setInvocationTelemetry(undefined);
      setConnection(nextConnection);
      setRuntimeStatus(connection.posture === "encrypted-attested"
        ? "Encrypted session ready · endpoint proof required on next turn"
        : "Encrypted session ready · endpoint evidence recorded after the next completed turn");
    });
  }

  async function activateExternalInference(
    route: ActivatedInferenceRoute,
    transitionAlreadyClaimed = false,
  ): Promise<void> {
    const routeProfile = activeProfileRef.current;
    if (!runtime.current || !routeProfile || !catalog) throw new Error("The local runtime is not ready.");
    if (
      route.pin.model.connectionId !== route.pin.connection.id
      || route.pin.model.connectionGeneration !== route.pin.connection.generation
      || route.pin.model.providerId !== route.pin.provider.id
    ) {
      throw new Error("The provider, credential generation, and model do not form one immutable route.");
    }
    const priorRuntime = runtime.current;
    const expectedChutesAuthorityRevision = chutesAuthorityRevision.current;
    const activate = async () => {
      const fabric = inferenceFabric.current;
      if (!fabric || fabric.preflight(route.pin).transport !== route.transport) {
        throw new Error("The selected inference route changed before its session could be pinned.");
      }
      activeTurn.current?.abort(new DOMException("Inference route is changing.", "AbortError"));
      setRuntimeStatus(`Creating a ${route.pin.provider.label} session`);
      const binding = coreInferenceBinding(route);
      const committedRuntime: Runtime = {
        ...priorRuntime,
        transport: route.transport,
        model: route.pin.model.id,
        inferenceBinding: binding,
        contextPolicy: contextPolicyForProviderModel(route.pin.model),
      };
      const stagedChutesAvailability = chutesAvailability.current;
      const candidateRuntime: Runtime = {
        ...committedRuntime,
        inferenceDirectory: () => inferenceDirectoryFromAvailability(
          combinedInferenceAvailability(
            fabric.availability(route.pin),
            stagedChutesAvailability,
            binding,
          ),
        ),
      };
      let nextSession: SessionRecord | undefined;
      let nextProfile: ProfileRevision | undefined;
      await mutateProfileCatalog(async (current) => {
        const selected = current.profiles.find((candidate) => candidate.profileId === routeProfile.profileId);
        if (!selected || runtime.current !== priorRuntime) {
          throw new Error("The active profile or browser runtime changed while the provider was being pinned.");
        }
        nextProfile = await bindProfileToRuntime(selected, candidateRuntime);
        const next = nextProfile === selected ? current : replaceProfile(current, nextProfile);
        nextSession = await createProfileSession(candidateRuntime, nextProfile, next);
        return next;
      });
      if (!nextProfile || !nextSession) throw new Error("The provider-pinned session was not created.");
      if (
        runtime.current !== priorRuntime
        || chutesAuthorityRevision.current !== expectedChutesAuthorityRevision
        || fabric.preflight(route.pin).transport !== route.transport
      ) {
        throw new Error("The inference connection directory changed before activation committed.");
      }

      runtime.current = committedRuntime;
      activeExternalRouteRef.current = route;
      setActiveExternalRoute(route);
      activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        content: `${route.pin.provider.label}/${route.pin.model.id} is active in a new immutable session through ${inferenceBoundaryLabel(route.pin.provider.transportBoundary)}. Its connection generation and model are pinned; existing conversations were not retargeted.`,
      }]);
      setEventCount(1);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setRuntimeStatus(`${route.pin.provider.label} session ready · invocation checked`);
      navigate("chat");
    };
    return transitionAlreadyClaimed
      ? activate()
      : runInferenceRouteTransition(activate);
  }

  async function switchExternalModel(modelId: string): Promise<void> {
    const current = activeExternalRoute;
    if (!current) throw new Error("Connect a cloud or local provider before selecting its model.");
    if (current.pin.model.id === modelId) return;
    return runInferenceRouteTransition(async () => {
      const fabric = inferenceFabric.current;
      if (!fabric) throw new Error("The inference connection directory is still starting.");
      const route = await fabric.activate(
        current.pin.connection.id,
        modelId,
      );
      await activateExternalInference(route, true);
    });
  }

  async function disconnectExternalInference(connectionId: string): Promise<void> {
    if (inferenceRouteChanging.current) {
      throw new Error("Wait for the current inference route change before disconnecting this provider.");
    }
    const fabric = inferenceFabric.current;
    if (!fabric) throw new Error("The inference connection directory is still starting.");
    const activeRoute = activeExternalRouteRef.current;
    const disconnectsActive = activeRoute?.pin.connection.id === connectionId;
    if (disconnectsActive) {
      activeTurn.current?.abort(new DOMException("Inference connection was disconnected.", "AbortError"));
    }
    if (!fabric.disconnect(connectionId)) {
      throw new Error("This inference connection is already disconnected.");
    }
    setProviderFabricRevision((value) => value + 1);
    if (disconnectsActive) {
      setComposerNotice(
        "This conversation remains pinned and readable, but its page-memory inference connection was released. Reconnect or select another connection for a new conversation.",
      );
      setRuntimeStatus("Pinned inference disconnected · conversation retained");
    } else {
      setRuntimeStatus("Inference connection released from page memory");
    }
  }

  /**
   * The Local lane's "Check this machine" button, wired to the same loopback
   * connect the provider fabric uses.
   *
   * The lane's copy promises that 127.0.0.1 is contacted only when this runs,
   * so this must issue the request rather than describe one: each server is
   * either answered, with the roster it returned, or refused, with the cause
   * the browser gave. A server already held in page memory is reported as such
   * without a second connect, which would otherwise reserve a duplicate
   * connection id for a provider that is plainly already there.
   */
  async function checkLocalModelServers(): Promise<readonly LocalProviderProbeResult[]> {
    const fabric = inferenceFabric.current;
    if (!fabric) throw new Error("The inference connection directory is still starting, so nothing on this machine was contacted.");
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new DOMException("The local model-server check exceeded its deadline.", "TimeoutError")),
      LOCAL_PROBE_DEADLINE_MS,
    );
    try {
      const results: LocalProviderProbeResult[] = [];
      for (const server of LOCAL_MODEL_SERVERS) {
        const held = fabric.list().find((entry) => entry.provider.id === server.kind);
        if (held) {
          results.push(Object.freeze({
            id: server.kind,
            label: server.label,
            outcome: "answered" as const,
            detail: `Already connected in this tab · ${modelCountLabel(held.models.length)}.`,
          }));
          continue;
        }
        try {
          const connected = await fabric.connectLocal({ kind: server.kind, signal: controller.signal });
          results.push(Object.freeze({
            id: server.kind,
            label: server.label,
            outcome: "answered" as const,
            detail: `Answered on ${server.endpoint} · ${modelCountLabel(connected.models.length)}.`,
          }));
        } catch (caught) {
          // A refusal by one server says nothing about the other, so the loop
          // continues; a deadline abort is not a refusal and stops everything.
          controller.signal.throwIfAborted();
          results.push(Object.freeze({
            id: server.kind,
            label: server.label,
            outcome: "silent" as const,
            reason: `${server.endpoint} did not answer: ${localProbeCause(caught)}`,
          }));
        }
      }
      return Object.freeze(results);
    } finally {
      clearTimeout(deadline);
    }
  }

  async function saveProfileRevision(draft: ProfileEditorDraft): Promise<ProfileRevision> {
    let savedProfileId = draft.profileId;
    const committed = await mutateProfileCatalog(async (currentCatalog) => {
      const current = currentCatalog.profiles.find((profile) => profile.profileId === draft.profileId);
      const theme = currentCatalog.themes.find((candidate) => candidate.themeId === draft.themeId);
      if (!current || !theme) throw new Error("The selected profile or theme no longer exists.");
      savedProfileId = current.profileId;
      const revision = await createProfileRevision({
        profileId: current.profileId,
        parentRevision: current.revision,
        name: draft.name,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        providerId: current.providerId,
        model: current.model,
        minimumPosture: draft.minimumPosture,
        workspaceBinding: draft.workspaceBinding === "workspace-id"
          ? { kind: "workspace-id", workspaceId: draft.workspaceId }
          : { kind: "active-workspace" },
        memoryScope: draft.memoryScope,
        approvalMode: draft.approvalMode,
        theme: { themeId: theme.themeId, digest: theme.digest },
        skillModes: current.skillModes,
        createdAt: new Date().toISOString(),
      });
      return replaceProfile(currentCatalog, revision);
    });
    const revision = committed.catalog.profiles.find((candidate) => candidate.profileId === savedProfileId);
    if (!revision) throw new Error("The committed profile revision could not be resolved.");
    setRuntimeStatus(savedProfileId === profileId
      ? `Profile revised in ${profileCatalogAuthorityLabel()}; active session remains pinned`
      : `Profile revision saved in ${profileCatalogAuthorityLabel()}`);
    return revision;
  }

  async function changeActiveApprovalMode(nextMode: ApprovalMode): Promise<void> {
    if (nextMode === activeApprovalMode) return;
    if (
      busy
      || !runtime.current
      || !catalog
      || !activeSessionRecord
      || inferenceRouteChanging.current
      || sessionNavigationChanging.current
    ) {
      setComposerNotice("Stop the active turn and wait for model or storage changes before changing this conversation's approval policy.");
      return;
    }
    const active = runtime.current;
    sessionNavigationChanging.current = true;
    try {
      let revisedProfile: ProfileRevision | undefined;
      const committed = await mutateProfileCatalog(async (current) => {
        const profile = current.profiles.find((candidate) => candidate.profileId === profileId);
        if (!profile) throw new Error("The active profile is no longer available.");
        revisedProfile = await createProfileRevision({
          ...profile,
          parentRevision: profile.revision,
          approvalMode: nextMode,
          createdAt: new Date().toISOString(),
        });
        return replaceProfile(current, revisedProfile);
      });
      if (!revisedProfile) throw new Error("The approval profile revision was not created.");
      // Commit the profile revision before creating the session that pins it.
      // A catalog failure therefore cannot leave an orphan journal session
      // referring to a profile revision that never became authoritative.
      const nextSession = await createProfileSession(
        active,
        revisedProfile,
        committed.catalog,
        `${activeSessionRecord.title} · ${approvalModeLabel(nextMode)}`.slice(0, 240),
      );
      if (runtime.current !== active) throw new Error("The runtime changed before the approval policy could become active.");
      setProfileId(revisedProfile.profileId);
      activateSession(nextSession);
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        content: `Approval policy changed to ${approvalModeLabel(nextMode)} in this new pinned conversation. The previous conversation remains unchanged and addressable from its URL and conversation history.`,
      }]);
      setEventCount(nextSession.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setSessionRevision((value) => value + 1);
      setComposerNotice(undefined);
      setRuntimeStatus(`${approvalModeLabel(nextMode)} active · new pinned conversation`);
      navigate("chat", chatHash(nextSession.id));
    } catch (error) {
      setComposerNotice(error instanceof Error ? error.message : "The approval policy could not be changed.");
    } finally {
      sessionNavigationChanging.current = false;
    }
  }

  async function forkProfile(source: ProfileRevision): Promise<ProfileRevision> {
    const profileId = `${slugIdentifier(source.name)}-${randomUuid().slice(0, 6).toLowerCase()}`;
    const committed = await mutateProfileCatalog(async (current) => {
      const latest = current.profiles.find((candidate) => candidate.profileId === source.profileId);
      if (!latest) throw new Error("The source profile no longer exists.");
      const fork = await createProfileRevision({
        profileId,
        parentRevision: latest.revision,
        name: `${latest.name} Copy`,
        description: latest.description,
        systemPrompt: latest.systemPrompt,
        providerId: latest.providerId,
        model: latest.model,
        minimumPosture: latest.minimumPosture,
        workspaceBinding: latest.workspaceBinding,
        memoryScope: latest.memoryScope,
        approvalMode: latest.approvalMode,
        theme: latest.theme,
        skillModes: latest.skillModes,
        createdAt: new Date().toISOString(),
      });
      return Object.freeze({ ...current, profiles: Object.freeze([...current.profiles, fork]) });
    });
    const fork = committed.catalog.profiles.find((candidate) => candidate.profileId === profileId);
    if (!fork) throw new Error("The committed profile fork could not be resolved.");
    setRuntimeStatus(`Profile forked in ${profileCatalogAuthorityLabel()}`);
    return fork;
  }

  async function deleteProfile(profileIdToDelete: string, replacementProfileId?: string): Promise<void> {
    if (!catalog) throw new Error("The profile catalog is not ready.");
    const managed = managedProfiles(catalog);
    if (managed.length <= 1) throw new Error("Airship must retain at least one profile.");
    if (!managed.some((profile) => profile.profileId === profileIdToDelete)) throw new Error("The selected profile is already archived or no longer exists.");
    if (profileIdToDelete === profileId) {
      if (!replacementProfileId || replacementProfileId === profileIdToDelete) throw new Error("Choose a replacement profile before deleting the active profile.");
      await changeProfile(replacementProfileId, true);
    }
    await mutateProfileCatalog((current) => archiveProfileRevision(current, profileIdToDelete));
    setRuntimeStatus("Profile archived from new work; historical conversations retain their pinned manifest and receipts");
  }

  async function setGlobalSkill(skillId: string, enabled: boolean): Promise<void> {
    await mutateProfileCatalog((current) => Object.freeze({
      ...current,
      globalSkills: createGlobalSkillSettings({ ...current.globalSkills, [skillId]: enabled }),
    }));
    setRuntimeStatus("Global skill policy revised; existing sessions remain pinned");
  }

  async function setProfileSkill(profileIdToEdit: string, skillId: string, mode: SkillMode) {
    await mutateProfileCatalog(async (current) => {
      const profile = current.profiles.find((candidate) => candidate.profileId === profileIdToEdit);
      if (!profile) throw new Error("The selected profile no longer exists.");
      const revision = await createProfileRevision({
        ...profile,
        parentRevision: profile.revision,
        skillModes: { ...profile.skillModes, [skillId]: mode },
        createdAt: new Date().toISOString(),
      });
      return replaceProfile(current, revision);
    });
    setRuntimeStatus("Profile skill policy revised; existing sessions remain pinned");
  }

  async function loadBillingSnapshot(signal: AbortSignal) {
    if (!online) throw new Error(OFFLINE_INLINE_REASON);
    const credential = accountCredential.current;
    if (!credential || !isChutesConnected(connection)) {
      throw new Error("A connected Chutes credential is required for account telemetry.");
    }
    // Account telemetry travels with the Billing surface in the deferred pack;
    // the shell must not carry the Chutes account client on its boot path.
    const { loadChutesAccountSnapshot } = await loadDeferredCapabilities();
    return loadChutesAccountSnapshot({ credential, signal });
  }

  async function loadAuditedSessionSnapshot(targetSessionId: string): Promise<Readonly<{
    report: SessionAuditReport;
    session: SessionRecord;
    events: readonly DurableEvent[];
  }>> {
    const activeRuntime = runtime.current;
    if (!activeRuntime) throw new Error("The local runtime is not ready.");
    const [{ auditSessionHistory }, session, events] = await Promise.all([
      loadDeferredCapabilities(),
      activeRuntime.journal.getSession(targetSessionId),
      activeRuntime.journal.readEvents(targetSessionId),
    ]);
    if (!session) throw new Error("The active session is no longer available in this page runtime.");
    return Object.freeze({
      report: await auditSessionHistory({ session, events }),
      session,
      events: boundedSessionPresentationEvents(events),
    });
  }

  async function loadSessionAudit(targetSessionId: string): Promise<SessionAuditReport> {
    return (await loadAuditedSessionSnapshot(targetSessionId)).report;
  }

  async function resumeLibrarySession(detail: SessionLibraryDetail): Promise<void> {
    if (busy) throw new Error("Stop the active turn before resuming another session.");
    if (inferenceRouteChanging.current || sessionNavigationChanging.current) {
      throw new Error("Wait for the current session or inference route transition before resuming.");
    }
    if (!sessionLibrary || !sessionRuntime || !catalog) throw new Error("The session runtime is not ready.");
    sessionNavigationChanging.current = true;
    try {
      const fresh = await sessionLibrary.inspect(detail.session.id, sessionRuntime);
      if (fresh.compatibility?.action !== "resume") {
        throw new Error(fresh.compatibility?.label ?? "The session no longer matches the active runtime.");
      }
      const audited = await loadAuditedSessionSnapshot(fresh.session.id);
      if (audited.report.status !== "verified") {
        throw new Error("The session failed the full digest/protocol audit and remains quarantined from resume.");
      }
      if (
        audited.session.headSequence !== fresh.session.headSequence ||
        audited.session.headDigest !== fresh.session.headDigest
      ) {
        throw new Error("The session changed between inspection and audit. Retry resume against the new immutable head.");
      }
      const pinnedProfile = fresh.session.manifest.profile;
      if (pinnedProfile) {
        const profile = catalog.profiles.find((candidate) =>
          candidate.profileId === pinnedProfile.profileId && candidate.revision === pinnedProfile.profileRevision,
        );
        if (!profile) throw new Error("The exact profile revision pinned by this session is unavailable; create a fork instead.");
        setProfileId(profile.profileId);
      }
      const { presentSessionMessages } = await loadDeferredCapabilities();
      const presentation = presentSessionMessages({
        session: audited.session,
        audit: audited.report,
        events: audited.events,
        receipts: fresh.transcript.receipts,
        history: fresh.transcript.messages.flatMap((message) => message.turnId ? [{
          turnId: message.turnId,
          turnStatus: message.turnStatus,
          providerContext: message.providerContext,
        }] : []),
      });
      activateSession(audited.session);
      setMessages(presentation.rows.length > 0
        ? presentation.rows.map((row, index) => {
            const originatingPrompt = originatingPromptForRow(presentation.rows, index);
            return {
              id: row.id,
              role: row.role,
              content: messagePlainText(row.parts),
              parts: row.parts,
              ...(row.receipt ? { receipt: row.receipt } : {}),
              ...(originatingPrompt ? { originatingPrompt } : {}),
              history: {
                turnStatus: row.turnStatus,
                providerContext: row.providerContext,
              },
              sourcePoint: row.sourcePoint,
            };
          })
        : [{ ...welcomeMessage, id: randomUuid(), content: `Resumed ${fresh.session.title}. ${welcomeMessage.content}` }]);
      setEventCount(fresh.session.headSequence);
      setLastReceipt(presentation.rows.flatMap((row) => row.receipt ? [row.receipt] : []).at(-1));
      setSessionLifecycle(fresh.transcript.lifecycle);
      setTranscriptBoundary(fresh.transcript.truncated ? {
        omittedMessages: fresh.transcript.omittedMessages,
        shortened: fresh.transcript.messages.some((message) => message.truncated),
      } : undefined);
      setProofSelection(undefined);
      setSessionRevision((value) => value + 1);
      setRuntimeStatus("Audited session resumed");
      navigate("chat");
    } finally {
      sessionNavigationChanging.current = false;
    }
  }

  async function activateForkedSession(result: SessionForkResult): Promise<void> {
    if (inferenceRouteChanging.current) {
      throw new Error("The inference route changed before this fork could become active.");
    }
    activateSession(result.session);
    setMessages([{ ...welcomeMessage, id: randomUuid(), content: `${result.session.title} is a clean immutable fork. ${welcomeMessage.content}` }]);
    setEventCount(result.session.headSequence);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    setProofSelection(undefined);
    setSessionRevision((value) => value + 1);
    setRuntimeStatus("Clean session fork active");
    navigate("chat");
  }

  function openSessionProof(targetSessionId = sessionId) {
    const selection = targetSessionId && lastReceipt?.sessionId === targetSessionId
      ? proofSelectionForReceipt(lastReceipt)
      : proofSelectionForSession(targetSessionId);
    setProofSelection(selection);
    setProofSection("summary");
    navigate("proof", proofHash(selection));
  }

  function openAttestationEvidence(targetSessionId = sessionId): void {
    const selection = targetSessionId && lastReceipt?.sessionId === targetSessionId
      ? proofSelectionForReceipt(lastReceipt)
      : proofSelectionForSession(targetSessionId);
    setProofSelection(selection);
    setProofSection("attestations");
    navigate("proof", proofHash(selection, "attestations"));
  }

  function openReceiptProof(receipt: ConversationReceipt): void {
    const selection = proofSelectionForReceipt(receipt);
    setProofSelection(selection);
    setProofSection("summary");
    navigate("proof", proofHash(selection));
  }

  if (!catalog || !activeProfile || !activeTheme) {
    return <BootScreen status={runtimeStatus} />;
  }
  const platformOverlayOpen = mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen || approvalPending;
  const vaultTrustAxis = trustAxes.find((axis) => axis.id === "vault")!;
  const sessionDurability = localDeviceRuntimeAdopted
    ? {
        state: "local" as const,
        detail: "This session journal and workspace write encrypted objects to browser-managed storage on this device. No cloud synchronization is active.",
      }
    : cloudVaultRuntimeAdopted && vaultSnapshot.phase === "ready"
    ? {
        state: "synced" as const,
        detail: `This session journal and workspace write client-encrypted objects directly to ${isGoogleDriveConfiguration(vaultSnapshot.config) ? vaultSnapshot.config.workspaceName : vaultSnapshot.config.bucket}.`,
      }
    : {
        state: "ephemeral" as const,
        detail: vaultSnapshot.phase === "ready"
          ? "The cloud object-store contract is verified, but this active runtime has not adopted it; this session remains in page memory."
          : "This session journal exists only in page memory. Nothing is synced.",
      };

  return (
    <div class="app-shell" data-connectivity={online ? "online" : "offline"}>
      {/* Tabbing from the document start otherwise crosses the whole rail, the
          recent-conversation list and the profile switcher — 35 stops — before
          reaching the composer, the highest-frequency control in the product.
          These are buttons, not `href="#..."` anchors: the shell routes on the
          location hash, so an in-page anchor would navigate the application. */}
      <div class="skip-links" inert={platformOverlayOpen} aria-hidden={platformOverlayOpen || undefined}>
        <button
          class="skip-link"
          type="button"
          onClick={() => mainRegion.current?.focus({ preventScroll: true })}
        >Skip to conversation</button>
        {view === "chat" ? (
          <button
            class="skip-link"
            type="button"
            onClick={() => textarea.current?.focus({ preventScroll: true })}
          >Skip to composer</button>
        ) : null}
      </div>
      <header class="topbar" inert={platformOverlayOpen} aria-hidden={platformOverlayOpen || undefined}>
        <button class="brand" type="button" onClick={() => navigate("chat")} aria-label="Open session">
          <Seal class="brand-seal" state="asserted" label="Airship mark" detail="Airship edge runtime" size={25} compact />
          <span class="brand-name">Airship</span>
          <span class="edition">edge runtime</span>
        </button>
        <TabPresenceNote />
        <div class="topbar-center" aria-label="Runtime state">
          <StatusSeal state="none" origin="local" label="Browser / Edge runtime" detail="The agent kernel is executing in this browser; no remote proof is implied." onClick={() => openSessionProof()} />
          <StatusSeal
            state={vaultTrustAxis.state}
            label={vaultTrustAxis.label}
            detail={vaultTrustAxis.detail}
            onClick={() => navigate("vault")}
          />
          <StatusSeal
            state={activeChutesConnection
              ? (connection.invokeAuthorization === "verified" ? "verified" : "asserted")
              : activeExternalConnection ? "asserted" : "none"}
            label={inferenceStatusLabel}
            detail={inferenceStatusDetail}
            action={!inferenceConnected}
            onClick={() => navigate("access")}
          />
          {activeChutesConnection || lastReceipt || attestationRecords.length > 0 || attestationFailure ? (
            <StatusSeal
              state={attestationSeal.state}
              label={attestationSeal.label}
              detail={attestationSeal.detail}
              onClick={() => openAttestationEvidence()}
            />
          ) : null}
          {connectivitySeal ? (
            <StatusSeal
              state={connectivitySeal.state}
              origin="local"
              label={connectivitySeal.label}
              detail={connectivitySeal.detail}
              onClick={() => navigate("access")}
            />
          ) : null}
        </div>
        <div class="topbar-actions">
          {!inferenceConnected ? (
            <button class="mobile-inference-action" type="button" aria-label="Connect a model" onClick={() => navigate("access")}>Connect</button>
          ) : null}
          {inferenceConnected ? (
            <button
              class="mobile-trust-chip"
              type="button"
              onClick={() => setTrustSheetOpen(true)}
              aria-label={`Open runtime trust details. Weakest claim: ${mobilePostureSeal.label}`}
            >
              <Seal
                state={mobilePostureSeal.state}
                acting={mobilePostureSeal.state === "checking"}
                label={mobilePostureSeal.label}
                detail={mobilePostureSeal.detail}
                size={16}
                compact
              />
            </button>
          ) : null}
          <MenuSelect
            className="compact-profile-menu"
            compact
            ariaLabel="Agent profile"
            value={profileId}
            disabled={busy}
            options={managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name }))}
            leading={(option) => <span class="profile-monogram" aria-hidden="true">{profileMonogram(option.label)}</span>}
            onChange={(nextId) => void changeProfile(nextId)}
          />
          <span class="runtime-line" title={runtimeStatus}><span class="pulse-dot" /><span class="runtime-line__text">{runtimeStatus}</span></span>
          <span class="sr-only" role="status" aria-live="polite">{runtimeStatus}</span>
          <button class="icon-button" type="button" aria-label="Open command palette" title="Command palette · ⌘K" onClick={() => setPaletteOpen(true)}>
            <span aria-hidden="true">⌘</span>
          </button>
          <button class="icon-button" type="button" aria-label="Open Preferences" onClick={() => setPreferencesOpen(true)}>
            <Icon name="model" />
          </button>
          <button class="icon-button" type="button" aria-label="Open proof" onClick={() => openSessionProof()}>
            <Icon name="proof" />
          </button>
        </div>
      </header>

      <aside class="sidebar" inert={platformOverlayOpen} aria-hidden={platformOverlayOpen || undefined}>
        <nav ref={primaryNav} class="primary-nav" aria-label="Primary">
          {(["Work", "Agent", "Trust"] as const).map((group) => (
            <div class="nav-group" key={group}>
              <span class="nav-group-label">{group}</span>
              {navigation.filter((item) => item.group === group).map((item) => {
                const active = view === item.id;
                const childActive = item.nested.some((nested) => nested.id === view);
                if (item.id === "chat") {
                  const recent = recentProfileConversations.slice(0, 10);
                  return <div class="chat-nav-section" key={item.id}>
                    <div class="chat-nav-primary">
                      <button
                        class={active ? "nav-item active" : childActive ? "nav-item has-active-child" : "nav-item"}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        data-scope={item.scope}
                        title="Open active conversation"
                        onClick={() => navigatePrimary("chat")}
                      >
                        <Icon name={item.icon} />
                        <span>Chat</span>
                        {unreadTurnCount > 0 ? <span class="nav-turn-badge" aria-label={`${String(unreadTurnCount)} completed turn${unreadTurnCount === 1 ? "" : "s"}`}>{unreadTurnCount}</span> : null}
                      </button>
                      <button
                        class="chat-nav-disclosure"
                        type="button"
                        aria-label={`${chatNavExpanded ? "Collapse" : "Expand"} recent conversations`}
                        aria-expanded={chatNavExpanded}
                        aria-controls="airship-recent-conversations"
                      onClick={() => setChatNavExpanded((expanded) => !expanded)}
                      ><span aria-hidden="true">›</span></button>
                      <button class="chat-nav-new" type="button" aria-label="New conversation" title="New conversation" disabled={busy} onClick={() => void createConversation()}><span aria-hidden="true">+</span></button>
                    </div>
                    {chatNavExpanded ? <div id="airship-recent-conversations" class="recent-conversations" aria-label="Recent conversations">
                      {recent.map((session) => <button
                        key={session.id}
                        class={session.id === sessionId ? "recent-conversation recent-conversation--thread active" : "recent-conversation recent-conversation--thread"}
                        type="button"
                        title={session.title}
                        aria-current={session.id === sessionId ? "page" : undefined}
                        onClick={session.open}
                      >
                        <span class="recent-conversation__mark" aria-hidden="true">{session.id === sessionId ? "●" : "○"}</span>
                        <span class="recent-conversation__copy">
                          <strong>{session.title}</strong>
                          <small>{session.preview}</small>
                        </span>
                        <time dateTime={session.updatedAt}>{formatConversationTime(session.updatedAt)}</time>
                      </button>)}
                      <button class={view === "sessions" ? "nav-item nav-item--nested active" : "nav-item nav-item--nested"} type="button" aria-current={view === "sessions" ? "page" : undefined} onClick={() => navigate("sessions")}>
                        <span class="nav-nested-marker" aria-hidden="true">↳</span><span>All conversations</span>
                      </button>
                    </div> : null}
                  </div>;
                }
                if (item.id === "profiles") {
                  const profileOptions = managedProfiles(catalog);
                  return <div class="chat-nav-section profile-nav-section" key={item.id}>
                    <div class="chat-nav-primary profile-nav-primary">
                      <button class={active ? "nav-item active" : childActive ? "nav-item has-active-child" : "nav-item"} type="button" aria-current={active ? "page" : undefined} data-scope={item.scope} title="Open profile manager" onClick={() => { setProfileNavExpanded(true); navigatePrimary("profiles"); }}><Icon name={item.icon} /><span>Profiles</span></button>
                      <button class="chat-nav-disclosure" type="button" aria-label={`${profileNavExpanded ? "Collapse" : "Expand"} profiles`} aria-expanded={profileNavExpanded} aria-controls="airship-profile-navigation" onClick={() => setProfileNavExpanded((expanded) => !expanded)}><span aria-hidden="true">›</span></button>
                    </div>
                    {profileNavExpanded ? <div id="airship-profile-navigation" class="recent-conversations profile-navigation" aria-label="Profiles">
                      {profileOptions.map((profile) => <button key={profile.profileId} class={profile.profileId === profileId ? "recent-conversation active" : "recent-conversation"} type="button" title={`Open ${profile.name} in the profile manager`} onClick={() => { openProfileManager(profile.profileId); }}><span class="profile-monogram" aria-hidden="true">{profileMonogram(profile.name)}</span><span>{profile.name}</span></button>)}
                    </div> : null}
                  </div>;
                }
                return [
                <button
                  key={item.id}
                  class={active ? "nav-item active" : childActive ? "nav-item has-active-child" : "nav-item"}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  data-scope={item.scope}
                  title={`${item.label} · ${item.scope} scope`}
                  onClick={() => navigatePrimary(item.id)}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.id === "proof" && lastReceipt ? <span class="nav-proof-dot" /> : null}
                </button>,
                ...item.nested.map((nested) => (
                  <button
                    key={nested.id}
                    class={view === nested.id ? "nav-item nav-item--nested active" : "nav-item nav-item--nested"}
                    type="button"
                    aria-current={view === nested.id ? "page" : undefined}
                    data-scope={nested.scope}
                    title={`${nested.label} · ${nested.scope} scope`}
                    onClick={() => navigate(nested.id)}
                  >
                    <span class="nav-nested-marker" aria-hidden="true">↳</span>
                    <span>{nested.label}</span>
                  </button>
                )),
              ]})}
            </div>
          ))}
        </nav>
        <div class="sidebar-spacer" />
        <div class="profile-switcher">
          <span class="eyebrow">Agent profile</span>
          <MenuSelect
            className="profile-menu"
            ariaLabel="Agent profile"
            value={profileId}
            disabled={busy}
            options={managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name, description: profile.description }))}
            leading={(option) => <span class="profile-monogram" aria-hidden="true">{profileMonogram(option.label)}</span>}
            onChange={(nextId) => void changeProfile(nextId)}
          />
          <button type="button" class="profile-manage-link" onClick={() => navigate("profiles")}>Manage profiles</button>
        </div>
      </aside>

      <ViewErrorBoundary key={view} name={navigation.find((item) => item.id === view || item.nested.some((nested) => nested.id === view))?.label ?? "Airship"} onRecover={() => navigate("chat")}>
      <main
        ref={mainRegion}
        tabIndex={-1}
        class={view === "chat"
          ? lastReceipt ? "main chat-layout" : "main chat-layout no-inspector"
          : ["proof", "vault", "access", "billing"].includes(view)
            ? "main route-layout trust-route-layout"
            : "main route-layout"}
        inert={platformOverlayOpen}
        aria-hidden={platformOverlayOpen || undefined}
      >
        {["proof", "vault", "access", "billing"].includes(view) ? <TrustHubTabs view={view} onNavigate={navigatePrimary} /> : null}
        {view === "chat" ? (
          <>
            <section class="chat-stage" aria-label="Agent session">
              <div class="stage-header">
                <div class="stage-header-title">
                  <span class="eyebrow">Active session · {activeProfile.name}</span>
                  <h1>{activeSessionRecord?.title ?? activeProfile.name}</h1>
                </div>
                <button
                  class="mobile-new-conversation"
                  type="button"
                  aria-label="New conversation"
                  title="New conversation"
                  disabled={busy}
                  onClick={() => void createConversation()}
                >
                  <Icon name="plus" size={17} />
                </button>
                <div class="stage-header-model">
                  <ModelControl
                    active={activeChutesConnection ? {
                      providerLabel: "Chutes",
                      modelId: connection.model,
                      boundaryLabel: activeConnectionBoundaryLabel(connection),
                    } : activeExternalConnection ? {
                      providerLabel: activeExternalConnection.pin.provider.label,
                      modelId: activeExternalConnection.pin.model.id,
                      boundaryLabel: inferenceBoundaryLabel(activeExternalConnection.pin.provider.transportBoundary),
                    } : pinnedExternalRoute ? {
                      providerLabel: pinnedExternalRoute.pin.provider.label,
                      modelId: pinnedExternalRoute.pin.model.id,
                      boundaryLabel: "Disconnected · read-only pin",
                    } : activeInferenceBinding?.providerId === "chutes" ? {
                      providerLabel: "Chutes",
                      modelId: activeInferenceBinding.modelId,
                      boundaryLabel: "Disconnected · read-only pin",
                    } : undefined}
                    models={activeChutesConnection
                      ? sortModels(availableModels, "popularity").map((model) => ({
                          id: model.id,
                          label: compactModelLabel(model.id),
                          detail: compactModelCapabilityDetail(model),
                        }))
                      : activeExternalConnection?.models.map((model) => ({
                          id: model.id,
                          label: model.label,
                          detail: providerModelCapability(model, "image-input") === "supported" ? "Vision · evidenced" : undefined,
                        })) ?? []}
                    busy={busy || modelSwitching}
                    onSelect={activeChutesConnection ? switchChutesModel : switchExternalModel}
                    onOpenConnection={() => navigate("access")}
                  />
                </div>
                <button
                  class="mobile-session-details"
                  type="button"
                  onClick={() => navigate("sessions")}
                  aria-label={`Session. ${durabilityLabel(sessionDurability.state)}. ${attestationSeal.label}.`}
                  title={`Open details for session ${sessionId ?? "starting"}. ${sessionDurability.detail}`}
                >
                  <Seal
                    state={attestationSeal.state}
                    label="Session"
                    detail={`${attestationSeal.label}. ${attestationSeal.detail}`}
                    size={15}
                    compact
                  />
                  <DurabilityIndicator state={sessionDurability.state} detail={sessionDurability.detail} />
                </button>
                <div class="session-meta">
                  <div class="session-meta-trust">
                    <button class="session-attestation" type="button" onClick={() => openSessionProof()} title="Open this session's proof">
                      <Seal state={attestationSeal.state} label={`${attestationSeal.label} · this session`} detail={`Session ${sessionId ?? "starting"}. ${attestationSeal.detail}`} size={16} compact />
                    </button>
                    <span class={`session-lifecycle ${sessionLifecycle.state}`} title={sessionLifecycle.turnId ? `Turn ${sessionLifecycle.turnId}` : "No turn has started in this session"}>
                      <span aria-hidden="true" />{sessionLifecycle.label}
                    </span>
                    <DurabilityIndicator state={sessionDurability.state} detail={sessionDurability.detail} />
                  </div>
                  <div class="session-meta-record">
                    {activeSessionRecord?.manifest.lineage?.kind === "fork" ? (
                      <button
                        class="session-branch-link"
                        type="button"
                        title={`Open source conversation ${activeSessionRecord.manifest.lineage.sourceSessionId}`}
                        onClick={() => void openPaletteSession(activeSessionRecord.manifest.lineage!.sourceSessionId)}
                      >
                        <Icon name="branch" size={13} />
                        Branch from #{activeSessionRecord.manifest.lineage.sourceSessionId.slice(0, 8)}
                      </button>
                    ) : null}
                    {/* P11: plain language leads. "page-journal event" is the
                        internal record name and stays available on hover. */}
                    <span title={`${eventCount} page-journal event${eventCount === 1 ? "" : "s"}`}>{eventCount} recorded step{eventCount === 1 ? "" : "s"}</span>
                    <button class="session-id" type="button" title="Open conversation details" onClick={() => navigate("sessions")}>#{sessionId ? sessionId.slice(0, 8) : "starting"}</button>
                  </div>
                </div>
              </div>
              {!inferenceConnected ? <div class="chat-live-guidance" id="chat-demo-guidance" role="note">
                <span><strong>Workspace, editor, terminal and Git work right now.</strong> Chat needs a model provider; this composer is a deterministic demo.</span>
                <button type="button" onClick={() => navigate("access")}>Connect a model</button>
              </div> : null}
              <div
                ref={transcriptElement}
                class={messages.length <= 1 ? "transcript no-turns" : "transcript"}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  const pinned = isNearLastRealCard(element, 64);
                  transcriptPinned.current = pinned;
                  setTranscriptDetached(!pinned);
                }}
              >
                {transcriptBoundary ? (
                  <div ref={transcriptBoundaryElement} class="transcript-boundary" role="status">
                    <Icon name="warning" size={16} />
                    <span>
                      <strong>Bounded transcript view</strong>
                      {transcriptBoundary.omittedMessages > 0
                        ? ` ${transcriptBoundary.omittedMessages} earlier message${transcriptBoundary.omittedMessages === 1 ? " is" : "s are"} omitted.`
                        : " No message is omitted."}
                      {transcriptBoundary.shortened ? " At least one visible message is shortened." : ""}
                      {" The agent context builder reads the complete audited journal, so visible and provider context are not identical."}
                    </span>
                  </div>
                ) : null}
                {windowedTranscript.topSpacerHeight > 0
                  ? <div class="transcript-spacer" style={{ height: windowedTranscript.topSpacerHeight }} aria-hidden="true" />
                  : null}
                {windowedTranscript.entries.map((entry) => (
                  <div
                    class="transcript-row"
                    key={entry.key}
                    ref={(element) => windowedTranscript.observeElement(entry.key, entry.revision, element)}
                  >
                    <MessageCard
                      message={entry.item}
                      capabilityTier={activeSessionRecord?.manifest.capabilityTier}
                      onProof={() => entry.item.receipt && openReceiptProof(entry.item.receipt)}
                      onAttestations={() => entry.item.receipt ? openReceiptAttestation(entry.item.receipt) : openAttestationEvidence()}
                      attestation={describeMessageAttestation(entry.item.receipt, attestationRecords, attestationFailure, attestationNow)}
                      onCopy={() => void navigator.clipboard.writeText(entry.item.parts?.length ? messagePlainText(entry.item.parts) : entry.item.content)}
                      onRetry={() => entry.item.originatingPrompt && void sendMessage(
                        entry.item.originatingPrompt,
                        entry.item.originatingAttachments,
                      )}
                      onEdit={() => {
                        setInput(entry.item.originatingPrompt ?? entry.item.content);
                        setAttachments(entry.item.originatingAttachments ?? []);
                        textarea.current?.focus();
                      }}
                      onBranch={() => void branchFromMessage(entry.item)}
                      branchDisabled={!sessionLibrary || !activeSessionRecord}
                      streamStore={transcriptStreams}
                    />
                  </div>
                ))}
                {messages.length <= 1 ? (
                  <div class="transcript-starters" role="group" aria-label="Suggested ways to begin">
                    {(inferenceConnected ? CONNECTED_STARTERS : DISCONNECTED_STARTERS).map((starter) => (
                      <button
                        type="button"
                        key={starter.title}
                        class="starter-chip"
                        onClick={() => {
                          if (starter.action.kind === "route") {
                            navigate(starter.action.view);
                            return;
                          }
                          setInput(starter.action.prompt);
                          requestAnimationFrame(() => textarea.current?.focus());
                        }}
                      >
                        <strong>{starter.title}</strong>
                        <span>{starter.hint}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {windowedTranscript.bottomSpacerHeight > 0
                  ? <div class="transcript-spacer" style={{ height: windowedTranscript.bottomSpacerHeight }} aria-hidden="true" />
                  : null}
                {transcriptDetached ? (
                  <button
                    class="transcript-jump"
                    type="button"
                    onClick={() => {
                      transcriptPinned.current = true;
                      setTranscriptDetached(false);
                      const element = transcriptElement.current;
                      if (element) scrollToLastRealCard(element, preferredJumpBehavior(window.matchMedia("(prefers-reduced-motion: reduce)").matches, false));
                    }}
                  >
                    Jump to latest
                  </button>
                ) : null}
              </div>
              <div class="composer-wrap">
                <div
                  class={`composer${busy ? " busy" : ""}`}
                >
                  {slashMenuOpen ? (
                    <div class="slash-command-menu" id="slash-command-menu" role="listbox" aria-label="Available slash commands">
                      {slashCompletions.map((completion, index) => (
                        <button
                          key={`${completion.kind}-${completion.command.name}-${completion.insertText}`}
                          id={`slash-option-${index}`}
                          class={index === slashSelection ? "selected" : ""}
                          type="button"
                          role="option"
                          aria-selected={index === slashSelection}
                          disabled={Boolean(completion.disabledReason)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => acceptSlashCompletion(completion)}
                        >
                          <code>{completion.label}</code>
                          <span>{completion.disabledReason ?? completion.detail}</span>
                          <small>{completion.command.category} · {completion.command.permission?.effect ?? "local"}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {messageQueue.length ? (
                    <div class="composer-queue" aria-label="Queued messages" aria-live="polite">
                      <header>
                        <strong>Up next</strong>
                        <span>{messageQueue.length} queued</span>
                      </header>
                      {messageQueue.map((item, index) => (
                        <div class="composer-queue__item" key={item.id}>
                          <span>{item.prompt}</span>
                          {item.attachments.length ? <small>{item.attachments.length} attachment{item.attachments.length === 1 ? "" : "s"}</small> : null}
                          <div>
                            {index === 0 ? <button type="button" disabled={busy} onClick={() => sendQueuedMessageNow(item)}>Send now</button> : null}
                            <button type="button" onClick={() => editQueuedMessage(item)}>Edit</button>
                            <button type="button" aria-label={`Remove queued message ${index + 1}`} onClick={() => sessionId && discardQueuedMessage(sessionId, item)}>×</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {attachments.length ? <div class="composer-attachments" aria-label="Pending attachments">
                    {attachments.map((attachment) => <span key={attachment.id}>{attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <Icon name="file" size={14} />}<span>{attachment.name}</span><small>{imageInputCapability === "supported" ? "encrypted vision ready" : "vision model required"}</small><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => { if (attachment.previewUrl) { URL.revokeObjectURL(attachment.previewUrl); attachmentPreviewUrls.current.delete(attachment.previewUrl); } setAttachments((current) => current.filter((item) => item.id !== attachment.id)); }}>×</button></span>)}
                  </div> : null}
                  <div class="composer-input-row">
                    <textarea
                      ref={textarea}
                      role="combobox"
                      aria-label="Message Airship"
                      aria-autocomplete="list"
                      aria-expanded={slashMenuOpen}
                      aria-haspopup="listbox"
                      aria-controls={slashMenuOpen ? "slash-command-menu" : undefined}
                      aria-activedescendant={slashMenuOpen && slashSelection >= 0 ? `slash-option-${slashSelection}` : undefined}
                      rows={1}
                      value={input}
                      placeholder="Ask Airship or type / for tools and session commands…"
                      onInput={(event) => setInput(event.currentTarget.value)}
                      onPaste={(event) => {
                        const pasted = Array.from(event.clipboardData?.files ?? []);
                        if (pasted.length) addComposerFiles(pasted);
                      }}
                      onDrop={(event) => {
                        const dropped = Array.from(event.dataTransfer?.files ?? []);
                        if (!dropped.length) return;
                        event.preventDefault();
                        addComposerFiles(dropped);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onKeyDown={(event) => {
                        if (slashMenuOpen && event.key === "ArrowDown") {
                          event.preventDefault();
                          setSlashSelection((index) => moveSlashSelection(slashCompletions, index, 1));
                          return;
                        }
                        if (slashMenuOpen && event.key === "ArrowUp") {
                          event.preventDefault();
                          setSlashSelection((index) => moveSlashSelection(slashCompletions, index, -1));
                          return;
                        }
                        if (slashMenuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.isComposing))) {
                          const completion = enabledSlashSelection(slashCompletions, slashSelection);
                          if (!completion) return;
                          event.preventDefault();
                          acceptSlashCompletion(completion);
                          return;
                        }
                        if (slashMenuOpen && event.key === "Escape") {
                          event.preventDefault();
                          setSlashMenuDismissedFor(input);
                          return;
                        }
                        if (
                          event.key === "Enter"
                          && !event.shiftKey
                          && !event.isComposing
                          && (busy || modelSwitching || vaultProviderSwitching || localDeviceBusy)
                        ) {
                          event.preventDefault();
                          if (busy && input.trim()) enqueueCurrentComposer();
                          else setComposerNotice(busy
                            ? "Type a follow-up and press Enter to queue it, or stop the current turn."
                            : "Wait for the active model or storage transition. Your prompt remains in the composer.");
                          return;
                        }
                        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                          event.preventDefault();
                          void sendMessage();
                        }
                      }}
                    />
                    <div class="composer-footer">
                      <div class="composer-tools">
                        <label class="composer-attach"><input type="file" aria-label="Attach image" accept="image/*" multiple onChange={(event) => { addComposerFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} /><Icon name="plus" size={14} /><span>Attach image</span></label>
                        <span><Icon name="lock" size={14} /> {inferenceConnected
                          ? activeInferenceBinding?.authMethod === "local-none"
                            ? "local endpoint"
                            : "credential in memory"
                          : "local demo · page memory"}</span>
                        <MenuSelect
                          ariaLabel="Conversation approval policy"
                          className={`composer-approval-select policy-${activeApprovalMode}`}
                          value={activeApprovalMode}
                          disabled={busy || modelSwitching || vaultProviderSwitching || localDeviceBusy}
                          options={[
                            { value: "ask-first", label: "Ask First", description: "Prompt before effectful actions." },
                            { value: "auto-approve", label: "Auto Approve", description: "Ask the active model to review each effect; prompt when uncertain." },
                            { value: "full-access", label: "Full Access", description: "Allow effects inside the bounded browser workspace without prompting." },
                          ]}
                          onChange={(value) => void changeActiveApprovalMode(value as ApprovalMode)}
                        />
                      </div>
                      {busy ? (
                        <div class="composer-primary-actions">
                          {input.trim() ? <button class="queue-button" type="button" onClick={enqueueCurrentComposer}>Queue</button> : null}
                          <button class="send-button stop" type="button" onClick={stopTurn} aria-label="Stop turn"><Icon name="stop" /></button>
                        </div>
                      ) : (
                        <button
                          class="send-button"
                          type="button"
                          onClick={() => void sendMessage()}
                          disabled={!input.trim()
                            || !sessionId
                            || composerOfflineBlocked
                            || modelSwitching
                          || vaultProviderSwitching
                          || localDeviceBusy}
                          aria-label={composerOfflineBlocked ? "Send unavailable while remote inference is offline" : "Send message"}
                          aria-describedby={composerUsesDemo ? "chat-demo-guidance" : undefined}
                          title={composerOfflineBlocked
                            ? "Remote inference is paused offline. Local slash commands remain available."
                            : composerUsesDemo
                              ? "Deterministic local demo response. Connect a model for real inference."
                              : undefined}
                        ><Icon name="send" /></button>
                      )}
                    </div>
                  </div>
                </div>
                {composerNotice ? <p class="composer-notice" role="status">{composerNotice}</p> : null}
                {!online ? <p class="connectivity-inline-reason" role="status">{OFFLINE_INLINE_REASON}</p>
                  : isChutesConnected(connection) ? <p>{connection.posture === "encrypted-attested"
                    ? `Encrypted inference through ${connection.model}; fresh endpoint proof is required before the next invocation.`
                    : `Encrypted inference through ${connection.model}; this compatibility connection has no required endpoint-proof gate.`}</p>
                    : null}
              </div>
            </section>
              {lastReceipt ? <aside class="inspector"><ProofInspector
              receipt={lastReceipt}
              endpointRecord={lastReceipt ? attestationRecords.find((record) => attestationRecordMatchesReceipt(record, lastReceipt)) : undefined}
              now={attestationNow}
              compact
              onOpenAttestations={() => openAttestationEvidence()}
            /></aside> : null}
          </>
        ) : null}
        {view === "sessions" ? sessionLibrary && SessionsScreen ? (
          <SessionsScreen
            library={sessionLibrary}
            runtime={sessionRuntime}
            activeSessionId={sessionId}
            forkManifest={activeSessionRecord?.manifest}
            revision={sessionRevision}
            onResume={resumeLibrarySession}
            onForked={activateForkedSession}
            onOpenProof={openSessionProof}
            durability={sessionDurability}
          />
        ) : (
          <section class="work-view panel" aria-labelledby="session-library-loading-title">
            <div class="page-heading">
              <div>
                <span class="eyebrow">Conversation history</span>
                <h1 id="session-library-loading-title">All conversations</h1>
              </div>
            </div>
            <RouteSkeleton label="Loading conversation history" />
          </section>
        ) : null}
        {(view === "workspace" || view === "editor") && runtime.current && gitClient ? EditorScreen ? <EditorScreen
          key={runtime.current.workspaceId}
          files={files}
          selected={selectedFile}
          onOpen={openFile}
          workspace={runtime.current.workspace}
          workspaceIdentity={runtime.current.workspaceId}
          git={gitClient}
          review={reviewGitOperation}
          reviewImport={reviewSourceImport}
          onWorkspaceChanged={() => runtime.current ? refreshWorkspaceState(runtime.current.workspace, setFiles, setWorkspaceFiles) : undefined}
          durability={sessionDurability}
        /> : editorViewError ? <section class="work-view panel" role="alert"><h1>Editor</h1><p>{editorViewError}</p></section> : <RouteSkeleton label="Loading the browser-native Workspace Editor" /> : null}
        {view === "terminal" && runtime.current && gitClient ? TerminalScreen ? <TerminalScreen
          workspace={runtime.current.workspace}
          git={gitClient}
          reviewGit={reviewGitOperation}
          onWorkspaceChanged={() => runtime.current ? refreshWorkspaceState(runtime.current.workspace, setFiles, setWorkspaceFiles) : undefined}
          threadId={sessionId}
          workspaceRoot="/workspace"
        /> : terminalViewError ? <section class="work-view panel" role="alert"><h1>Terminal</h1><p>{terminalViewError}</p></section> : <RouteSkeleton label="Loading the browser terminal" /> : null}
        {view === "memory" || view === "context" ? MemoryScreen ? (
          <MemoryScreen
            sessionId={sessionId}
            messages={messages}
            files={workspaceFiles}
            catalog={catalog}
            activeProfile={activeProfile}
            workspace={runtime.current?.workspace}
            searchMemory={searchMemoryForUi}
            initialTab={view === "context" ? "index" : "search"}
          />
        ) : memoryViewError ? <section class="work-view panel" role="alert"><h1>Memory</h1><p>{memoryViewError}</p></section> : <RouteSkeleton label="Loading private memory" /> : null}
        {view === "profiles" || view === "capabilities" || view === "skills" ? <nav class={view === "skills" ? "profile-hub-tabs with-scope" : "profile-hub-tabs"} aria-label="Agent configuration">
          {([{"id":"profiles","label":"Profiles"},{"id":"capabilities","label":"Capabilities"},{"id":"skills","label":"Skills"}] as const).map((tab) => <button key={tab.id} type="button" aria-current={view === tab.id ? "page" : undefined} onClick={() => navigate(tab.id)}>{tab.label}</button>)}
          {view === "skills" ? <div class="profile-hub-scope"><span>Applies to</span><MenuSelect placement="down" ariaLabel="Skill scope" value={profileHubScope} options={[{ value: "global", label: "All profiles" }, ...managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name }))]} onChange={setProfileHubScope} /></div> : null}
        </nav> : null}
        {view === "profiles" ? (
          <ProfileManagerView
            key={profileHubScope}
            catalog={catalog}
            catalogDurability={runtime.current?.profiles.durability ?? "ephemeral"}
            activeProfileId={profileId}
            onActivate={async (id) => { await changeProfile(id, true); navigate("chat"); }}
            onSave={saveProfileRevision}
            onFork={forkProfile}
            onDelete={deleteProfile}
            draftState={profileDraftDirty}
            selectedProfileId={profileHubScope === "global" ? undefined : profileHubScope}
          />
        ) : null}
        {view === "capabilities" ? CapabilitiesScreen ? (
          <CapabilitiesScreen inspect={inspectExecutionCapabilities} inspectBrowser={inspectBrowserCapabilities} onCommand={openCapabilityCommand} onOpenSkills={() => navigate("skills")} />
        ) : capabilitiesViewError ? <section class="work-view panel" role="alert"><h1>Capabilities</h1><p>{capabilitiesViewError}</p></section> : <RouteSkeleton label="Inspecting browser capabilities" /> : null}
        {view === "skills" ? (
          <SkillsManagerView
            catalog={catalog}
            catalogDurability={runtime.current?.profiles.durability ?? "ephemeral"}
            activeProfileId={profileId}
            onSetGlobal={setGlobalSkill}
            onSetProfile={setProfileSkill}
            onApply={async (id) => { await changeProfile(id, true); navigate("chat"); }}
            scope={profileHubScope}
          />
        ) : null}
        {view === "vault" ? (
          <div class="work-view">
            {VaultScreen ? <VaultScreen
              snapshot={vaultSnapshot}
              runtimeAdopted={vaultRuntimeAdopted}
              contextMode={runtime.current?.contextMode}
              contextPublishing={vaultContextPublishing}
              contextPublicationMessage={vaultContextPublicationMessage}
              provider={preferences.vaultBackend}
              localDeviceStatus={localDeviceStatus}
              providerSwitching={vaultProviderSwitching || vaultContextPublishing || localDeviceBusy}
              onProviderChange={(provider) => void changeVaultProvider(provider)}
              onOpenSetup={preferences.vaultBackend === "ephemeral" ? undefined : () => setVaultSetupOpen((open) => !open)}
              onProbe={preferences.vaultBackend === "local-device" || vaultSnapshot.phase === "disconnected" ? undefined : () => void probeVault()}
              onCancelProbe={vaultSnapshot.phase === "probing" ? () => {
                vault.cancelProbe();
                setRuntimeStatus("Vault probe cancelled; readiness claim cleared");
              } : undefined}
              onReauthorize={vaultSnapshot.phase !== "disconnected" && isGoogleDriveConfiguration(vaultSnapshot.config)
                ? () => void reauthorizeGoogleDriveVault()
                : undefined}
              reauthorizing={driveReauthorizing}
              onPublishContext={vaultRuntimeAdopted ? () => void publishEncryptedContextIndex() : undefined}
              onDisconnect={localDeviceRuntimeAdopted || vaultSnapshot.phase !== "disconnected"
                ? () => void disconnectVaultSafely()
                : undefined}
            /> : vaultViewError ? <section class="panel" role="alert"><h1>Vault</h1><p>{vaultViewError}</p></section> : <RouteSkeleton label="Loading the Vault interface" />}
            {preferences.vaultBackend === "local-device" ? (
              <div class="vault-setup-slot">
                {LocalDeviceVaultSetupScreen ? <LocalDeviceVaultSetupScreen
                  partition={LOCAL_DEVICE_PARTITION}
                  status={localDeviceStatus}
                  onActivate={activateLocalDeviceWorkspace}
                  onRestoreEncryptedBackup={restoreLocalDeviceBackup}
                  onExportEncryptedBackup={localDeviceStatus ? exportLocalDeviceBackup : undefined}
                  onRequestPersistentStorage={localDeviceStatus ? requestLocalDevicePersistence : undefined}
                /> : <RouteSkeleton label="Loading Local Device Vault controls" />}
                {localDeviceError ? <p class="route-error" role="alert">{localDeviceError}</p> : null}
              </div>
            ) : (vaultSetupOpen || (preferences.vaultBackend === "google-drive" && vaultSnapshot.phase === "disconnected")) ? (
              <div class="vault-setup-slot">
                {preferences.vaultBackend === "google-drive" ? GoogleDriveSetupScreen ? <GoogleDriveSetupScreen onConfigure={(request) => {
                  vault.configureGoogleDrive(request);
                  setVaultSetupOpen(false);
                  setRuntimeStatus("Google Drive connected in page memory; verifying encrypted range storage");
                  void vault.probe({ acknowledgeImmutableProbeObjects: true }).then((result) => {
                    setRuntimeStatus(result.phase === "ready"
                      ? "Google Drive storage contract passed; adoption pending"
                      : result.phase === "degraded" ? `Google Drive vault blocked: ${result.diagnostic.publicMessage}` : result.message);
                  }).catch((error) => setRuntimeStatus(error instanceof Error ? error.message : "Google Drive verification stopped safely"));
                }} /> : <RouteSkeleton label="Loading Google Drive connection" /> : LocalLabSetupScreen ? <LocalLabSetupScreen onConfigure={(request) => {
                    vault.configure(request);
                    setVaultSetupOpen(false);
                    setRuntimeStatus("Local S3 lab configured in page memory; live probe still required");
                  }} /> : <RouteSkeleton label="Loading local S3 lab setup" />}
              </div>
            ) : null}
          </div>
        ) : null}
        {view === "billing" ? BillingScreen ? (
          <BillingScreen
            accountReadable={isChutesConnected(connection)}
            credentialKind={connection.kind === "chutes-oauth" ? "oauth" : connection.kind === "chutes-api-key" ? "api-key" : undefined}
            credentialRevision={credentialRevision}
            invocationTelemetry={invocationTelemetry}
            online={online}
            loadSnapshot={loadBillingSnapshot}
            onOpenAccess={() => navigate("access")}
          />
        ) : billingViewError ? <section class="work-view panel" role="alert"><h1>Account</h1><p>{billingViewError}</p></section> : <RouteSkeleton label="Loading Account" /> : null}
        {view === "proof" ? ProofScreen ? (
          <ProofScreen
            receipt={proofReceipt}
            eventCount={proofTargetId === sessionId ? eventCount : sessionRevision}
            sessionId={proofTargetId}
            requestedReceiptId={proofSelection?.receiptId}
            loadAudit={loadSessionAudit}
            section={proofSection}
            onSectionChange={(section) => {
              setProofSection(section);
              navigate("proof", proofHash(proofSelection, section));
            }}
            summarizeReceipt={receiptSummary}
            renderInspector={(onOpenAttestations) => <ProofInspector
              receipt={proofReceipt}
              endpointRecord={proofReceipt ? attestationRecords.find((record) => attestationRecordMatchesReceipt(record, proofReceipt)) : undefined}
              now={attestationNow}
              onOpenAttestations={onOpenAttestations}
            />}
            evidenceLedger={AttestationsScreen ? <AttestationsScreen
              endpointRecords={attestationRecords}
              receipts={attestationReceipts}
              selectedRecordId={selectedAttestationRecordId}
              onSelectRecord={(recordId) => setSelectedAttestationRecordId(recordId)}
              acquisitionNotice={!online ? OFFLINE_INLINE_REASON : attestationFailure ? `${attestationFailure.label}. Current endpoint evidence was not accepted, and no TEE claim was inferred.` : undefined}
              onOpenConnection={!chutesConnected ? () => navigate("access") : undefined}
              onRefresh={online && chutesConnected ? refreshAttestation : undefined}
              onCancel={() => attestationClient.current?.cancel()}
              embedded
            /> : attestationsViewError ? <div class="panel" role="alert">{attestationsViewError}</div> : <RouteSkeleton label="Loading attestation evidence" />}
            endpointEvidenceRecords={attestationRecords}
          />
        ) : proofViewError ? <section class="work-view panel" role="alert"><h1>Proof</h1><p>{proofViewError}</p></section> : <RouteSkeleton label="Loading Proof" /> : null}
        {view === "access" ? AccessScreen ? (
          <AccessScreen
            connection={connection}
            online={online}
            connectionActive={Boolean(activeChutesConnection)}
            onUseConnection={isChutesConnected(connection)
              ? () => switchChutesModel(connection.model)
              : undefined}
            onConnect={({ connection: nextConnection, transport, model, models, credential }) =>
              connectChutes(transport, model, models, credential, nextConnection)}
            onDisconnect={disconnectChutes}
            models={availableModels}
            onSelectModel={switchChutesModel}
            onInvocationTelemetry={setInvocationTelemetry}
            oauthNotice={oauthCallbackStatus ? {
              tone: oauthCallbackStatus.kind === "error"
                ? "error"
                : oauthCallbackStatus.kind === "verified"
                  ? "neutral"
                  : "warning",
              message: oauthCallbackStatus.message,
            } : undefined}
            oauthDiagnostic={{
              homepageUrl: CHUTES_ACTIVE_REGISTRATION.homepageUrl,
              callbackUrl: CHUTES_ACTIVE_REGISTRATION.redirectUris[0] ?? "Unavailable",
              scopes: CHUTES_ACTIVE_REGISTRATION.scopes,
              exchangeMode: import.meta.env.DEV ? "local-confidential-bridge" : "public-pkce",
              configurationError: CHUTES_ACTIVE_REGISTRATION.configurationError,
              onRun: startOAuthSignIn,
            }}
            oauthBootstrap={{
              revision: oauthBootstrapRevision,
              takeCredential: takePendingOAuthCredential,
              getBearerToken: currentOAuthBearer,
            }}
            connectedProviderIds={connectedInferenceProviderIds}
            onCheckLocalProviders={checkLocalModelServers}
            additionalProviders={ProviderConnectionsScreen ? (
              <ProviderConnectionsScreen
                online={online}
                activeBinding={activeInferenceBinding}
                onActivate={activateExternalInference}
                onDisconnect={disconnectExternalInference}
              />
            ) : <RouteSkeleton label="Loading cloud and local provider fabric" />}
          />
        ) : accessViewError ? <section class="work-view panel" role="alert"><h1>Connection</h1><p>{accessViewError}</p></section> : <RouteSkeleton label="Loading Connection" /> : null}
      </main>
      </ViewErrorBoundary>

      <MobileNavigation
        view={view}
        moreOpen={mobileMoreOpen}
        chromeInert={platformOverlayOpen}
        chatPending={unreadTurnCount}
        proofPending={Boolean(lastReceipt)}
        attestationPending={attestationRecords.length + (attestationFailure ? 1 : 0)}
        onNavigate={navigatePrimary}
        onOpenMore={() => setMobileMoreOpen(true)}
        onCloseMore={() => setMobileMoreOpen(false)}
        onOpenCommandPalette={() => { setMobileMoreOpen(false); setPaletteOpen(true); }}
        onOpenSettings={() => setPreferencesOpen(true)}
      />
      <ApprovalDock broker={approvalBroker} />
      <CommandPalette open={paletteOpen} entries={paletteEntries} onClose={() => setPaletteOpen(false)} />
      <PreferencesDialog open={preferencesOpen} value={preferences} onChange={(next) => {
        if (next.vaultBackend !== preferences.vaultBackend) {
          setPreferences((current) => Object.freeze({ ...next, vaultBackend: current.vaultBackend }));
          void changeVaultProvider(next.vaultBackend);
        }
        else setPreferences(next);
      }} onClose={() => setPreferencesOpen(false)} vaultProviderSwitching={vaultProviderSwitching} profileApproval={{
        mode: activeApprovalMode,
        onManage: () => {
          if (openProfileManager(profileId)) setPreferencesOpen(false);
        },
      }} />
      <TrustPostureSheet open={trustSheetOpen} axes={trustAxes} onClose={() => setTrustSheetOpen(false)} onNavigate={navigatePrimary} />
      <PwaUpdateBanner updateReady={pwaUpdate.updateReady} onReload={pwaUpdate.reload} />
    </div>
  );
}

async function createProfileSession(
  runtime: Runtime,
  profile: ProfileRevision,
  catalog: ProfileCatalog,
  requestedTitle?: string,
): Promise<SessionRecord> {
  const manifest = await createProfileSessionManifest(runtime, profile, catalog);
  const title = requestedTitle?.trim() || `${profile.name} conversation`;
  if (title.length > 240 || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error("The conversation title is invalid.");
  return runtime.journal.createSession(title, manifest);
}

async function createProfileSessionManifest(
  runtime: Runtime,
  profile: ProfileRevision,
  catalog: ProfileCatalog,
): Promise<SessionManifest> {
  const theme = catalog.themes.find((candidate) =>
    candidate.themeId === profile.theme.themeId && candidate.digest === profile.theme.digest,
  );
  if (!theme) throw new Error(`Profile ${profile.profileId} references an unavailable theme revision.`);
  const [{ browserCapabilityPromptEntries, getBrowserCapabilityRegistry }, capabilityTier] = await Promise.all([
    import("../capabilities/browser-runtime"),
    inspectBrowserExecutionTier(),
  ]);
  const browserReport = await getBrowserCapabilityRegistry().refresh();
  const pin = await resolveProfileForSession({
    profile,
    theme,
    skills: catalog.skills,
    globalSkills: catalog.globalSkills,
    installedTools: runtime.tools.definitions(),
    browserCapabilities: browserCapabilityPromptEntries(browserReport),
    inferenceDirectory: runtime.inferenceDirectory?.(),
  });
  if (!postureSatisfies(runtime.transport.posture, pin.minimumPosture)) {
    throw new Error(`The ${runtime.transport.posture} runtime does not satisfy this profile's ${pin.minimumPosture} minimum posture.`);
  }
  if (pin.workspaceBinding.kind === "workspace-id" && pin.workspaceBinding.workspaceId !== runtime.workspaceId) {
    throw new Error("This profile is pinned to a different workspace. Select that workspace before starting a conversation.");
  }
  const availableTools = new Set(runtime.tools.definitions().map((tool) => tool.name));
  for (const resolved of pin.resolvedSkills) {
    const skill = catalog.skills.find((candidate) => candidate.skillId === resolved.skillId && candidate.digest === resolved.digest);
    if (!skill) throw new Error(`Resolved skill ${resolved.skillId} is unavailable.`);
    const missingTools = skill.requiredTools.filter((tool) => !availableTools.has(tool));
    if (missingTools.length) throw new Error(`Skill ${skill.skillId} requires unavailable tools: ${missingTools.join(", ")}.`);
  }
  const manifest = await createSessionManifest({
    systemPrompt: pin.systemPrompt,
    providerId: runtime.transport.id,
    model: runtime.model,
    ...(runtime.inferenceBinding ? { inferenceBinding: runtime.inferenceBinding } : {}),
    tools: runtime.tools.definitions(),
    workspaceId: runtime.workspaceId,
    capabilityTier,
    securityPosture: runtime.transport.posture,
    turnContext: runtime.tools.getTurnContextProvider() ? "required" : "disabled",
    ...(runtime.contextPolicy ? { contextPolicy: runtime.contextPolicy } : {}),
    profile: {
      version: 2,
      profileId: pin.profile.profileId,
      profileRevision: pin.profile.revision,
      themeId: pin.theme.themeId,
      themeDigest: pin.theme.digest,
      resolvedSkills: pin.resolvedSkills.map((skill) => ({ ...skill })),
      skillSetDigest: pin.skillSetDigest,
      resolutionDigest: pin.resolutionDigest,
      workspaceBinding: pin.workspaceBinding,
      memoryScope: pin.memoryScope,
      approvalMode: pin.approvalMode,
      minimumPosture: pin.minimumPosture,
    },
  });
  if (manifest.systemPromptDigest !== pin.systemPromptDigest) {
    throw new Error("Resolved profile prompt digest did not match the session manifest.");
  }
  return manifest;
}

/** Resume only an exact current-runtime/profile pin; never mutate durable state. */
async function latestCompatibleProfileSession(
  runtime: Runtime,
  profile: ProfileRevision,
  catalog: ProfileCatalog,
): Promise<SessionRecord | undefined> {
  const expected = await createProfileSessionManifest(runtime, profile, catalog);
  const sessions = await runtime.journal.listSessions();
  return sessions
    .filter((session) => sessionManifestMatches(session.manifest, expected))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function sessionManifestMatches(actual: SessionManifest, expected: SessionManifest): boolean {
  const actualProfile = actual.profile;
  const expectedProfile = expected.profile;
  return actual.providerId === expected.providerId
    && actual.model === expected.model
    && actual.workspaceId === expected.workspaceId
    && sessionCapabilityTiersMatch(actual.capabilityTier, expected.capabilityTier)
    && actual.securityPosture === expected.securityPosture
    && (actual.turnContext ?? "disabled") === (expected.turnContext ?? "disabled")
    && sessionContextPoliciesMatch(actual.contextPolicy, expected.contextPolicy)
    && actual.systemPromptDigest === expected.systemPromptDigest
    && actual.toolManifestDigest === expected.toolManifestDigest
    && inferenceBindingsMatch(actual.inferenceBinding, expected.inferenceBinding)
    && actualProfile?.profileId === expectedProfile?.profileId
    && actualProfile?.profileRevision === expectedProfile?.profileRevision
    && actualProfile?.themeDigest === expectedProfile?.themeDigest
    && actualProfile?.skillSetDigest === expectedProfile?.skillSetDigest
    && actualProfile?.resolutionDigest === expectedProfile?.resolutionDigest;
}

function sessionCapabilityTiersMatch(
  actual: SessionManifest["capabilityTier"],
  expected: SessionManifest["capabilityTier"],
): boolean {
  if (actual === expected) return true;
  const actualIsBrowser = actual === "web-baseline" || actual === "web-enhanced";
  const expectedIsBrowser = expected === "web-baseline" || expected === "web-enhanced";
  return actualIsBrowser && expectedIsBrowser;
}

function inferenceBindingsMatch(
  actual: SessionManifest["inferenceBinding"],
  expected: SessionManifest["inferenceBinding"],
): boolean {
  if (!actual || !expected) return actual === expected;
  return actual.version === expected.version
    && actual.connectionId === expected.connectionId
    && actual.connectionGeneration === expected.connectionGeneration
    && actual.providerId === expected.providerId
    && actual.providerLabel === expected.providerLabel
    && actual.providerRevision === expected.providerRevision
    && actual.authMethod === expected.authMethod
    && actual.transportBoundary === expected.transportBoundary
    && actual.modelId === expected.modelId;
}

function contextPolicyForModel(model: AirshipModel): SessionManifest["contextPolicy"] | undefined {
  if (model.contextTokens !== undefined) {
    return createSessionContextPolicy({
      contextWindowTokens: model.contextTokens,
      source: { kind: "provider-catalog", field: "contextTokens" },
      summarizer: {
        mode: "inference-transport",
        adapterId: "airship/inference-transport-summary-v1",
        onFailure: "extractive-fallback",
      },
    });
  }
  if (model.maxModelTokens !== undefined) {
    return createSessionContextPolicy({
      contextWindowTokens: model.maxModelTokens,
      source: { kind: "provider-catalog", field: "maxModelTokens" },
      summarizer: {
        mode: "inference-transport",
        adapterId: "airship/inference-transport-summary-v1",
        onFailure: "extractive-fallback",
      },
    });
  }
  return undefined;
}

function contextPolicyForProviderModel(
  model: InferenceModelDescriptor,
): SessionManifest["contextPolicy"] | undefined {
  if (!model.contextWindowTokens) return undefined;
  return createSessionContextPolicy({
    contextWindowTokens: model.contextWindowTokens,
    source: { kind: "provider-catalog", field: "contextTokens" },
    summarizer: {
      mode: "inference-transport",
      adapterId: "airship/inference-transport-summary-v1",
      onFailure: "extractive-fallback",
    },
  });
}

function coreInferenceBinding(
  route: ActivatedInferenceRoute,
): NonNullable<SessionManifest["inferenceBinding"]> {
  return Object.freeze({
    version: 1,
    connectionId: route.pin.connection.id,
    connectionGeneration: route.pin.connection.generation,
    providerId: route.pin.provider.id,
    providerLabel: route.pin.provider.label,
    providerRevision: route.pin.provider.revision,
    authMethod: route.pin.connection.authKind === "oauth-public-pkce"
      ? "oauth-pkce"
      : route.pin.connection.authKind,
    transportBoundary: route.pin.provider.transportBoundary,
    modelId: route.pin.model.id,
    boundAt: route.pin.pinnedAt,
  });
}

function resolveExternalInferencePreflight(
  binding: NonNullable<SessionManifest["inferenceBinding"]>,
  route: ActivatedInferenceRoute | undefined,
  fabric: BrowserInferenceFabric | undefined,
): Readonly<{ state: "ready" }> | Readonly<{ state: "blocked"; detail: string }> {
  if (!route || !inferenceBindingsMatch(binding, coreInferenceBinding(route))) {
    return Object.freeze({
      state: "blocked",
      detail: "This conversation's exact inference credential generation is no longer in page memory.",
    });
  }
  if (!fabric) {
    return Object.freeze({
      state: "blocked",
      detail: "The page-lifetime inference directory is still starting.",
    });
  }
  const resolution = fabric.resolve(route.pin);
  return resolution.state === "ready"
    ? Object.freeze({ state: "ready" })
    : Object.freeze({ state: "blocked", detail: resolution.detail });
}

function providerModelCapability(
  model: InferenceModelDescriptor,
  capability: keyof InferenceModelDescriptor["capabilities"],
): "supported" | "unsupported" | "unknown" {
  return model.capabilities[capability]?.state ?? "unknown";
}

function inferenceBoundaryLabel(
  boundary: NonNullable<SessionManifest["inferenceBinding"]>["transportBoundary"],
): string {
  switch (boundary) {
    case "e2ee-attestable": return "application E2EE · evidence capable";
    case "provider-tls": return "provider TLS";
    case "loopback-local": return "this machine · loopback";
  }
}

function activeConnectionBoundaryLabel(connection: ActiveChutesConnection): string {
  if (connection.posture !== "encrypted-attested") return "E2EE · evidence recorded";
  return connection.invokeAuthorization === "verified"
    ? "E2EE · last turn proved"
    : "E2EE · proof required";
}

function combinedInferenceAvailability(
  providerSnapshot: InferenceAvailabilitySnapshot,
  chutes: ChutesAvailabilityAuthority | undefined,
  activeBinding: SessionManifest["inferenceBinding"],
): InferenceAvailabilitySnapshot {
  const connections: InferenceAvailabilityConnection[] = [...providerSnapshot.connections];
  if (chutes) {
    const models: InferenceAvailabilityConnection["models"] = Object.freeze(
      chutes.models.slice(0, 48).map((model) => {
        const supportedCapabilities: InferenceAvailabilityConnection["models"][number]["supportedCapabilities"] = Object.freeze([
          "text-input",
          "text-output",
          ...(modelInputModalityCapability(model, "image") === "supported" ? ["image-input" as const] : []),
          ...(model.features.includes("tools") ? ["tool-calling" as const] : []),
          ...(model.features.includes("reasoning") ? ["reasoning" as const] : []),
          ...(model.features.includes("structured_outputs") ? ["structured-output" as const] : []),
        ]);
        return Object.freeze({
          id: model.id,
          label: model.id,
          availability: "available" as const,
          supportedCapabilities,
        });
      }),
    );
    connections.push(Object.freeze({
      id: chutes.connectionId,
      providerId: "chutes",
      providerLabel: "Chutes",
      connectionLabel: chutes.connection.kind === "chutes-oauth"
        ? "Chutes sign-in"
        : "Chutes API key",
      authKind: chutes.connection.kind === "chutes-oauth"
        ? "oauth-public-pkce"
        : "api-key",
      health: "ready",
      canInvoke: true,
      availableCapabilities: Object.freeze([
        "invoke",
        "models:list",
        "identity:read",
        "billing:read",
        "usage:read",
      ] as const),
      models,
      omittedModels: Math.max(0, chutes.models.length - models.length),
    }));
  }
  const activeConnectionId = activeBinding?.connectionId;
  const ordered = connections
    .filter((connection, index, values) =>
      values.findIndex((candidate) => candidate.id === connection.id) === index
    )
    .sort((left, right) =>
      Number(right.id === activeConnectionId) - Number(left.id === activeConnectionId)
      || left.providerLabel.localeCompare(right.providerLabel)
      || left.id.localeCompare(right.id)
    );
  const bounded = Object.freeze(ordered.slice(0, 16));
  const activeSession = activeBinding
    ? Object.freeze({
        providerId: activeBinding.providerId,
        connectionId: activeBinding.connectionId,
        modelId: activeBinding.modelId,
        immutable: true as const,
        resolution: activeBinding.providerId === "chutes"
          ? chutes
            && chutes.connectionId === activeBinding.connectionId
            && chutes.generation === activeBinding.connectionGeneration
            && chutes.models.some((model) => model.id === activeBinding.modelId)
              ? "ready" as const
              : "connection-missing" as const
          : providerSnapshot.activeSession?.resolution ?? "connection-missing" as const,
      })
    : providerSnapshot.activeSession;
  return Object.freeze({
    version: 1,
    capturedAt: new Date().toISOString(),
    connections: bounded,
    omittedConnections: providerSnapshot.omittedConnections + Math.max(0, ordered.length - bounded.length),
    ...(activeSession ? { activeSession } : {}),
  });
}

function inferenceDirectoryFromAvailability(
  availability: InferenceAvailabilitySnapshot,
): InferenceDirectoryPromptDefinition {
  return Object.freeze({
    ...(availability.activeSession ? {
      active: Object.freeze({
        connectionId: availability.activeSession.connectionId,
        providerId: availability.activeSession.providerId,
        modelId: availability.activeSession.modelId,
      }),
    } : {}),
    providers: Object.freeze(availability.connections.map((connection) => Object.freeze({
      connectionId: connection.id,
      providerId: connection.providerId,
      label: connection.providerLabel,
      state: connection.canInvoke ? "connected" as const : "degraded" as const,
      authority: connection.authKind === "local-none"
        ? "local-service" as const
        : connection.authKind === "oauth-public-pkce"
          ? "oauth" as const
          : "api-key" as const,
      models: Object.freeze(connection.models.slice(0, 48).map((model) => {
        const supported = new Set(model.supportedCapabilities);
        const inputModalities = [
          ...(supported.has("text-input") ? ["text"] : []),
          ...(supported.has("image-input") ? ["image"] : []),
          ...(supported.has("audio-input") ? ["audio"] : []),
        ];
        const features = [
          ...(supported.has("tool-calling") ? ["tools"] : []),
          ...(supported.has("parallel-tool-calling") ? ["parallel-tools"] : []),
          ...(supported.has("reasoning") ? ["reasoning"] : []),
          ...(supported.has("structured-output") ? ["structured-output"] : []),
          ...(supported.has("embeddings") ? ["embeddings"] : []),
        ];
        return Object.freeze({
          id: model.id,
          ...(inputModalities.length ? { inputModalities: Object.freeze(inputModalities) } : {}),
          ...(features.length ? { features: Object.freeze(features) } : {}),
        });
      })),
      modelCount: connection.models.length + connection.omittedModels,
    }))),
  });
}

function activeSessionRuntime(runtime: Runtime, session: SessionRecord): ActiveSessionRuntime {
  const profile = session.manifest.profile;
  return Object.freeze({
    providerId: runtime.transport.id,
    model: runtime.model,
    ...(runtime.inferenceBinding ? { inferenceBinding: runtime.inferenceBinding } : {}),
    posture: runtime.transport.posture,
    toolManifestDigest: session.manifest.toolManifestDigest,
    workspaceId: runtime.workspaceId,
    ...(profile ? {
      profile: Object.freeze({
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        themeDigest: profile.themeDigest,
        skillSetDigest: profile.skillSetDigest,
        resolutionDigest: profile.resolutionDigest,
      }),
    } : {}),
  });
}

async function bindProfileToRuntime(profile: ProfileRevision, runtime: Runtime): Promise<ProfileRevision> {
  // Provider/model are immutable conversation pins, not profile mutations.
  // A profile can express a default, while the active session selects any
  // currently authorized route without stranding older profile revisions.
  void runtime;
  return profile;
}

function replaceProfile(catalog: ProfileCatalog, revision: ProfileRevision): ProfileCatalog {
  return Object.freeze({
    ...catalog,
    profiles: Object.freeze(catalog.profiles.map((profile) =>
      profile.profileId === revision.profileId ? revision : profile,
    )),
  });
}

function managedProfiles(catalog: ProfileCatalog): readonly ProfileRevision[] {
  return managedProfileRevisions(catalog);
}

function postureSatisfies(actual: InferenceTransport["posture"], minimum: ProfileRevision["minimumPosture"]): boolean {
  if (minimum === "local") return true;
  if (minimum === "plaintext-remote") return actual !== "local";
  if (minimum === "encrypted-unattested") return actual === "encrypted-unattested" || actual === "encrypted-attested";
  return actual === "encrypted-attested";
}

function applyTheme(theme: ThemeManifest) {
  const root = document.documentElement;
  root.style.removeProperty("--signal");
  root.style.removeProperty("--danger");
  for (const [property, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(property, value);
  root.dataset.theme = theme.themeId;
  root.dataset.density = theme.layout.density;
  root.dataset.corners = theme.layout.corners;
  root.dataset.typeScale = theme.typography.scale;
  root.dataset.bodyFont = theme.typography.body;
  root.dataset.mode = theme.colorScheme;
  root.style.colorScheme = theme.colorScheme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme.colors.ground);
}

async function refreshWorkspaceState(
  workspace: WorkspacePort,
  setEntries: (entries: WorkspaceEntry[]) => void,
  setMemoryFiles: (files: WorkspaceEntry[]) => void,
) {
  const entries = (await workspace.list()).filter((entry) => !isWorkspaceControlPlanePath(entry.path));
  setEntries(entries);
  // Refresh is metadata-only. Content is read only after an explicit open;
  // indexing has its own bounded, demand-driven workspace port.
  setMemoryFiles(entries.slice(0, 2_000));
}

/**
 * One-time migration for a pre-real-Git Vault. Ordinary files become the
 * baseline of a standards-compatible root repository; recognized imported
 * snapshots become their own nested repositories. Existing `.git` plus the
 * registry always wins, so this work is never repeated on a current Vault.
 */
async function existingWorkspaceFallbackSeed(workspace: WorkspacePort): Promise<readonly WorkspaceGitRepositorySeed[]> {
  const entries = (await workspace.list()).filter((entry) => !isWorkspaceControlPlanePath(entry.path));
  if (!entries.length) return [];
  const contents = new Map<string, string>();
  for (const entry of entries) {
    const file = await workspace.read(entry.path);
    if (!file || file.revision !== entry.revision) throw new Error(`Workspace changed while preparing real Git migration: ${entry.path}.`);
    contents.set(entry.path, file.content);
  }

  const nested: WorkspaceGitRepositorySeed[] = [];
  const nestedRoots = new Set<string>();
  for (const [path, content] of contents) {
    if (!path.endsWith("/.airship-import.json") || !path.startsWith("/workspace/sources/")) continue;
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(content) as Record<string, unknown>; } catch { continue; }
    if (manifest.kind !== "github-source-snapshot" || typeof manifest.source !== "string") continue;
    const root = path.slice(0, -"/.airship-import.json".length);
    const source = manifest.source;
    let remote: URL;
    try { remote = new URL(source); } catch { continue; }
    if (remote.protocol !== "https:" || remote.username || remote.password) continue;
    const name = remote.pathname.replace(/^\/+|\/+$/gu, "") || root.split("/").at(-1)!;
    const id = `migrated-${root.slice("/workspace/sources/".length).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").slice(0, 96)}`;
    const files = Object.fromEntries([...contents]
      .filter(([candidate]) => candidate.startsWith(`${root}/`))
      .map(([candidate, value]) => [candidate.slice(root.length + 1), value]));
    nested.push({ id, name, worktreePath: root, defaultBranch: typeof manifest.ref === "string" ? manifest.ref : "main", files, workingFiles: files, remoteUrl: remote.toString() });
    nestedRoots.add(root);
  }

  const rootFiles = Object.fromEntries([...contents]
    .filter(([path]) => ![...nestedRoots].some((root) => path.startsWith(`${root}/`)))
    .filter(([path]) => !path.startsWith("/workspace/sources/"))
    .map(([path, content]) => [path.slice("/workspace/".length), content]));
  return Object.freeze([
    ...(Object.keys(rootFiles).length ? [{ id: "airship-workspace", name: "Airship Workspace", worktreePath: "/workspace", files: rootFiles, workingFiles: rootFiles }] : []),
    ...nested,
  ]);
}

async function isPristineBootstrapRuntime(runtime: Runtime): Promise<boolean> {
  const { readme, architecture, retrieval } = (await loadBrowserGit()).AIRSHIP_BOOTSTRAP_FILES;
  const expected = new Map<string, string>([
    ["/workspace/README.md", readme],
    ["/workspace/docs/architecture.md", architecture],
    ["/workspace/notes/retrieval.md", retrieval],
  ]);
  const [allEntries, sessions] = await Promise.all([
    runtime.workspace.list(),
    runtime.journal.listSessions(),
  ]);
  const entries = allEntries.filter((entry) => !isWorkspaceControlPlanePath(entry.path));
  if (entries.length !== expected.size || sessions.length !== 1 || sessions[0]!.headSequence !== 1) return false;
  const bootstrapEvents = await runtime.journal.readEvents(sessions[0]!.id);
  if (bootstrapEvents.length !== 1 || bootstrapEvents[0]!.type !== "session.created") return false;
  for (const entry of entries) {
    const content = expected.get(entry.path);
    if (content === undefined) return false;
    const file = await runtime.workspace.read(entry.path);
    if (!file || file.content !== content) return false;
  }
  return true;
}

async function readWorkspaceFileBounded(
  workspace: WorkspacePort,
  path: string,
  maximumBytes: number,
): Promise<WorkspaceFile | undefined> {
  if (workspace.readBounded) return workspace.readBounded(path, maximumBytes);
  const file = await workspace.read(path);
  if (!file) return undefined;
  const bytes = new TextEncoder().encode(file.content);
  if (bytes.byteLength <= maximumBytes) return file;
  return {
    ...file,
    content: new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maximumBytes)),
  };
}

function parsePkceAttempt(value: string): ChutesPkceAttempt {
  if (value.length > 8_192) throw new Error("The saved Chutes authorization attempt exceeded its safety limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The saved Chutes authorization attempt is invalid.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The saved Chutes authorization attempt is invalid.");
  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => !["state", "verifier", "redirectUri", "createdAt"].includes(key)) ||
    typeof candidate.state !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.state) ||
    typeof candidate.verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/u.test(candidate.verifier) ||
    typeof candidate.redirectUri !== "string" ||
    candidate.redirectUri.length > 2_048 ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (candidate.createdAt as number) < 0
  ) {
    throw new Error("The saved Chutes authorization attempt is incomplete.");
  }
  return {
    state: candidate.state,
    verifier: candidate.verifier,
    redirectUri: candidate.redirectUri,
    createdAt: candidate.createdAt as number,
  };
}

function oauthPublicClientError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Chutes sign-in could not be completed.";
  if (message.includes("invalid_client")) {
    return import.meta.env.DEV
      ? "Chutes rejected the local app credentials. Restart the lab with its registered client ID and process-held secret. Never put the secret in the browser."
      : "Chutes rejected this public registration. Its token authentication must be “none”; after the owner converts it, consent again. Airship never embeds client secrets.";
  }
  if (message.includes("HTTP 502")) {
    return "Chutes identity gateway returned 502. Retry sign-in in a fresh browser window.";
  }
  return message.length <= 320 ? message : "Chutes sign-in failed without changing the active connection.";
}

function boundedTranscriptContent(value: string, maximum = 64 * 1024): string {
  if (value.length <= maximum) return value;
  let end = maximum;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}\n\n[Local display shortened; the journaled tool result is larger.]`;
}

function boundedSessionPresentationEvents(
  events: readonly DurableEvent[],
  maximum = 20_000,
): readonly DurableEvent[] {
  if (events.length <= maximum) return events;
  const earliest = events.length - maximum;
  for (let index = earliest; index < events.length; index += 1) {
    if (events[index]?.type === "turn.requested") return events.slice(index);
  }
  throw new Error("The newest durable turn exceeds the bounded replay window and cannot be presented safely.");
}

function insertSlashCompletion(input: string, completion: SlashCompletion): string {
  if (completion.kind === "command") return `${completion.insertText} `;
  if (/\s$/u.test(input)) return `${input}${completion.insertText} `;
  const boundary = input.lastIndexOf(" ");
  return `${boundary < 0 ? "" : input.slice(0, boundary + 1)}${completion.insertText} `;
}

function slugIdentifier(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 72);
  return slug || "profile";
}

function compactModelLabel(modelId: string): string {
  const leaf = modelId.split("/").filter(Boolean).at(-1) ?? modelId;
  return leaf.length > 25 ? `${leaf.slice(0, 22)}…` : leaf;
}

function compactModelCapabilityDetail(model: AirshipModel): string | undefined {
  const labels: string[] = [];
  if (modelInputModalityCapability(model, "image") === "supported") labels.push("Vision");
  if (model.provenance.capabilities === "llm-models" && model.features.some((feature) => feature.toLowerCase() === "tools")) {
    labels.push("Tools");
  }
  const popularity = modelPopularitySignal(model);
  if (popularity) labels.push(`${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(popularity.value)} ${popularity.basis === "lifetime-invocations" ? "invocations" : "req/h"}`);
  const utilization = model.telemetry?.freshness === "fresh" ? model.telemetry.utilization.oneHour : undefined;
  if (utilization !== undefined) labels.push(`${Math.round(utilization * 100)}% load`);
  return labels.length ? labels.join(" · ") : undefined;
}

function conversationTitleFromPrompt(prompt: string): string {
  const normalized = prompt.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const maximum = 64;
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

async function waitForOperationRelease(
  released: () => boolean,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (released()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!released()) throw new Error(failureMessage);
}

function profileMonogram(label: string): string {
  const words = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length >= 2) return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  return (words[0] ?? "A").slice(0, 2).toUpperCase();
}

function BootScreen({ status }: { status: string }) {
  return (
    <main class="boot-screen">
      <Seal class="boot-seal" state="checking" acting label="Preparing Airship" detail={status} size={32} compact />
      <span class="eyebrow">Airship edge runtime</span>
      <h1>Preparing the local kernel</h1>
      <p role="status" aria-live="polite">{status}</p>
    </main>
  );
}

function StatusSeal({ state, label, detail, origin, action = false, onClick }: { state: SealState; label: string; detail: string; origin?: "local" | "remote"; action?: boolean; onClick(): void }) {
  const detailId = useId();
  return <button class={`status-seal${action ? " status-seal--action" : ""}`} type="button" data-state={state} aria-describedby={detailId} onClick={onClick}>
    <Seal state={state} origin={origin} acting={state === "checking"} label={label} detail={detail} size={16} />
    <span id={detailId} class="status-seal-detail" role="tooltip">{detail}</span>
  </button>;
}

function receiptSealState(receipt?: ConversationReceipt): SealState {
  if (!receipt) return "none";
  if (Object.values(receipt.claims).some((claim) => claim.status === "failed" || claim.status === "expired")) return "failed";
  if (receipt.posture === "local") return "none";
  if (receipt.posture === "plaintext-remote") return "attention";
  if (receipt.posture === "encrypted-unattested") return "asserted";
  return receipt.claims.endpointKey.status === "verified" ? "verified" : "attention";
}

export function describeAttestationSeal(args: {
  connected: boolean;
  proofPolicy?: "record" | "strict";
  receipt?: ConversationReceipt;
  records: readonly ChutesEndpointEvidenceRecord[];
  failure?: AttestationAcquisitionFailure;
  now: number;
}): { state: SealState; label: string; detail: string } {
  if (args.receipt?.claims.endpointKey.status === "verified") {
    return {
      state: "verified",
      label: "Endpoint verified",
      detail: "The active receipt contains an independently verified endpoint-key claim. Model and conversation claims remain separate.",
    };
  }
  const historicalRecord = args.receipt
    ? args.records.find((candidate) => attestationRecordMatchesReceipt(candidate, args.receipt!))
    : undefined;
  const record = historicalRecord && isDisplayFreshAttestation(historicalRecord, args.now)
    ? historicalRecord
    : undefined;
  if (historicalRecord && !record) {
    return {
      state: "stale",
      label: "Evidence refresh due",
      detail: "The separate endpoint evidence record is historical. Refresh before relying on its local key or policy comparison.",
    };
  }
  if (record?.verdict === "rejected") {
    return {
      state: "failed",
      label: "Evidence rejected",
      detail: "Current endpoint evidence failed a local binding or published-policy comparison. It did not alter the conversation receipt.",
    };
  }
  if (record) {
    if (!recordLocallyBindsReceipt(record, args.receipt)) {
      return {
        state: "attention",
        label: "Separate evidence collected",
        detail: "A current endpoint record exists, but it did not establish both the local challenge and endpoint-key bindings for this immutable turn receipt.",
      };
    }
    return {
      state: "asserted",
      label: "Local key match",
      detail: "A separate current endpoint record locally matched the challenge and discovered key. It does not upgrade this immutable turn receipt; Intel DCAP, NVIDIA authenticity, and conversation binding remain independently scoped.",
    };
  }
  if (args.failure && (!args.receipt || attestationFailureAppliesToReceipt(args.failure, args.receipt))) {
    return {
      state: "attention",
      label: args.failure.label,
      detail: "Endpoint evidence was not accepted. This provider/acquisition state is not a TEE verdict.",
    };
  }
  return args.connected
    ? args.proofPolicy === "strict"
      ? {
        state: "asserted",
        label: "Proof required next turn",
        detail: "The fail-closed endpoint-proof policy is armed, but no active turn receipt currently establishes a hardware claim.",
      }
      : {
        state: "asserted",
        label: "Evidence checked per turn",
        detail: "Verify & record will collect fresh endpoint evidence on the next turn and keep every incomplete claim explicit without blocking encrypted inference.",
      }
    : {
      state: "none",
      // Plain language leads and the acronym follows. "Demo provider" was also
      // simply untrue — there is no demo provider; nothing is connected.
      label: "Secure hardware not checked",
      detail: "No inference provider is connected, so no TEE evidence has been requested for this session.",
    };
}

function describeMessageAttestation(
  receipt: ConversationReceipt | undefined,
  records: readonly ChutesEndpointEvidenceRecord[],
  failure?: AttestationAcquisitionFailure,
  now = Date.now(),
): MessageAttestation | undefined {
  if (!receipt || !isChutesReceiptProvider(receipt.provider)) return undefined;
  if (receipt.claims.endpointKey.status === "verified") {
    return {
      state: "verified",
      label: "Endpoint verified",
      detail: "This receipt has a verified endpoint-key claim; model and conversation proof remain independently scoped.",
    };
  }
  const historicalRecord = records.find((candidate) => attestationRecordMatchesReceipt(candidate, receipt));
  const record = historicalRecord && isDisplayFreshAttestation(historicalRecord, now) ? historicalRecord : undefined;
  if (historicalRecord && !record) {
    return {
      state: "stale",
      label: "Evidence refresh due",
      detail: "The separate endpoint evidence record is beyond its browser display-freshness window and must be reacquired.",
    };
  }
  if (record?.verdict === "rejected") {
    return {
      state: "failed",
      label: "Evidence rejected",
      detail: "A separate current endpoint record failed its local binding or policy comparison; the receipt was not upgraded.",
    };
  }
  if (record) {
    if (!recordLocallyBindsReceipt(record, receipt)) {
      return {
        state: "attention",
        label: "Separate evidence only",
        detail: "A separate current endpoint record exists, but it did not establish both local bindings for this receipt.",
      };
    }
    return {
      state: "asserted",
      label: "Local key match · separate",
      detail: "A separate current endpoint record matched the challenge and discovered key locally. It did not upgrade this receipt; quote/GPU authenticity and this conversation remain unverified.",
    };
  }
  if (failure && attestationFailureAppliesToReceipt(failure, receipt)) {
    return {
      state: "attention",
      label: "Evidence not pulled",
      detail: "The provider evidence acquisition did not complete. No TEE claim was inferred.",
    };
  }
  return {
    state: "none",
    label: "Secure hardware evidence pending",
    detail: "Airship has not accepted endpoint TEE evidence for this receipt.",
  };
}

function isChutesReceiptProvider(provider: string): boolean {
  return provider === "chutes" || provider === "chutes-e2ee-v1";
}

function attestationSnapshotError(snapshot: ChutesEndpointAttestationSnapshot): MountedAttestationError {
  const unavailable = snapshot.unavailable;
  return new MountedAttestationError(
    normalizeAttestationErrorCode(unavailable?.code),
    unavailable?.message ?? "Attestation evidence inspection failed closed.",
    {
      retryable: unavailable?.retryable ?? false,
      ...(unavailable?.status === undefined ? {} : { status: unavailable.status }),
    },
  );
}

function normalizeAttestationErrorCode(value: string | undefined): AttestationEvidenceClientErrorCode {
  switch (value) {
    case "invalid-input":
    case "network":
    case "cross-origin-unreadable":
    case "timeout":
    case "unauthorized":
    case "forbidden":
    case "http":
    case "invalid-content-type":
    case "response-too-large":
    case "invalid-json":
    case "invalid-response":
    case "subject-not-found":
    case "evidence-unavailable":
      return value;
    default:
      return "network";
  }
}

function attestationFailureLabel(code: AttestationEvidenceClientErrorCode): string {
  if (code === "cross-origin-unreadable") return "Evidence path unreadable";
  if (code === "unauthorized" || code === "forbidden") return "Evidence access denied";
  if (code === "subject-not-found" || code === "evidence-unavailable") return "Evidence unavailable";
  if (code === "invalid-content-type" || code === "invalid-json" || code === "invalid-response" || code === "response-too-large") {
    return "Evidence rejected";
  }
  return "Evidence pull unavailable";
}

function attestationRecordMatchesReceipt(
  record: ChutesEndpointEvidenceRecord,
  receipt: ConversationReceipt,
): boolean {
  const endpointKeyDigest = (record.subject as typeof record.subject & { e2ePublicKeyDigest?: string }).e2ePublicKeyDigest;
  return Boolean(
    receipt.instanceId &&
    receipt.bindings.endpointKeyDigest &&
    endpointKeyDigest &&
    record.subject.instanceId === receipt.instanceId &&
    endpointKeyDigest === receipt.bindings.endpointKeyDigest,
  );
}

function recordLocallyBindsReceipt(
  record: ChutesEndpointEvidenceRecord,
  receipt: ConversationReceipt | undefined,
): boolean {
  return Boolean(
    receipt &&
    attestationRecordMatchesReceipt(record, receipt) &&
    record.verdict === "evidence-only" &&
    record.binding.state === "matched" &&
    record.claims.nonceFreshness.state === "matched" &&
    record.claims.endpointKey.state === "matched",
  );
}

function attestationFailureAppliesToReceipt(
  failure: AttestationAcquisitionFailure,
  receipt: ConversationReceipt,
): boolean {
  if (failure.scope === "connection") return true;
  if (failure.scope === "receipt") return failure.receiptId === receipt.receiptId;
  if (!receipt.instanceId || failure.instanceId !== receipt.instanceId) return false;
  return !failure.endpointKeyDigest || failure.endpointKeyDigest === receipt.bindings.endpointKeyDigest;
}

function isDisplayFreshAttestation(record: ChutesEndpointEvidenceRecord, now: number): boolean {
  const freshUntil = Date.parse(record.acquisition.cacheFreshUntil);
  return Number.isFinite(freshUntil) && freshUntil > now;
}

function endpointEvidenceForView(record: ChutesEndpointEvidenceRecord): ChutesEndpointEvidenceRecord {
  return Object.freeze({
    ...record,
    subject: Object.freeze({
      ...record.subject,
      e2ePublicKey: "",
    }),
    acquisition: Object.freeze({
      ...record.acquisition,
      requestUrl: querylessProviderUrl(record.acquisition.requestUrl),
      requestNonce: "",
    }),
    evidence: Object.freeze({
      ...record.evidence,
      quote: Object.freeze({ ...record.evidence.quote, base64: "", reportDataHex: "" }),
      gpu: Object.freeze({ ...record.evidence.gpu, payloads: Object.freeze([]) }),
      certificate: Object.freeze({ ...record.evidence.certificate, base64: "" }),
    }),
    binding: Object.freeze({
      ...record.binding,
      expectedDigestHex: "",
      quotedDigestHex: "",
      reportDataHex: "",
    }),
    warnings: Object.freeze([
      ...record.warnings,
      "Raw quote, GPU, certificate, nonce, report-data, and endpoint-key material is omitted from view state.",
    ]),
  });
}

function modelCountLabel(count: number): string {
  return `${count} model${count === 1 ? "" : "s"}`;
}

/**
 * One bounded sentence for why a loopback server did not answer.
 *
 * Local connections carry no credential, but the message is still redacted and
 * capped rather than passed through: a thrown value is untrusted text and this
 * lands in the person's page.
 */
function localProbeCause(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return "the browser reported no reason.";
  return clean.length > 200 ? `${clean.slice(0, 197)}…` : clean;
}

function querylessProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "provider endpoint withheld";
  }
}

type MessageAttestation = Readonly<{
  state: SealState;
  label: string;
  detail: string;
}>;

function MessageCard({
  message,
  capabilityTier,
  onProof,
  onAttestations,
  attestation,
  onCopy,
  onRetry,
  onEdit,
  onBranch,
  branchDisabled,
  streamStore,
}: {
  message: UiMessage;
  capabilityTier?: SessionManifest["capabilityTier"];
  onProof: () => void;
  onAttestations: () => void;
  attestation?: MessageAttestation;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onBranch: () => void;
  branchDisabled: boolean;
  streamStore: TranscriptStreamStore;
}) {
  return (
    <article
      class={`message ${message.role} ${message.error ? "error" : ""}`}
      aria-label={`${message.role === "user" ? "Your" : "Airship"} message`}
      data-message-role={message.role}
      data-transcript-card
    >
      <div class="message-rail" aria-hidden="true"><span>{message.role === "user" ? "You" : "A"}</span></div>
      <div class="message-body">
        <div class="message-label">
          <strong>{message.role === "user" ? "You" : "Airship"}</strong>
          {message.role === "assistant" && capabilityTier ? (
            <span
              class={`message-capability-tier ${capabilityTier}`}
              title={`Initial session observation. ${capabilityTierDetail(capabilityTier)} Tool results name their live producing runtime separately.`}
            >
              <span aria-hidden="true" />Initial · {capabilityTierLabel(capabilityTier)}
            </span>
          ) : null}
          {message.status ? <span class="message-status"><span class="pulse-dot" />{message.status}</span> : null}
        </div>
        {message.parts?.length ? (
          <MessagePartsView parts={message.parts} />
        ) : <p>{message.content || " "}</p>}
        <StreamingMessageSlot store={streamStore} messageId={message.id} active={message.status !== undefined} />
        {message.liveToolOutput ? (
          <section class="live-tool-output" aria-live="polite" aria-label="Live tool output">
            <header><span class="pulse-dot" /><strong>Live tool output</strong><code>{message.liveToolOutput.stream}</code></header>
            <pre>{message.liveToolOutput.text}</pre>
          </section>
        ) : null}
        {message.history ? (
          <div class="message-history" aria-label="Durable turn disposition">
            <span class={message.history.turnStatus}>{message.history.turnStatus} turn</span>
            <span class={message.history.providerContext}>
              {message.history.providerContext === "included" ? "In provider context" : "Excluded from provider context"}
            </span>
          </div>
        ) : null}
        {message.receipt ? (
          <div class="message-evidence-chips">
            <button class="receipt-chip" type="button" onClick={onProof}>
              <Seal
                state={receiptSealState(message.receipt)}
                origin={message.receipt.posture === "local" ? "local" : "remote"}
                label={message.receipt.posture === "local" ? "Final response · local receipt" : "Final response · encrypted receipt"}
                detail={receiptSummary(message.receipt)}
                size={14}
                compact
              />
              <span>{message.receipt.receiptId.slice(-8)}</span>
            </button>
            {attestation ? (
              <button
                class={`attestation-chip ${attestation.state}`}
                type="button"
                title={attestation.detail}
                onClick={onAttestations}
              >
                <Seal state={attestation.state} label={attestation.label} detail={attestation.detail} size={14} compact />
              </button>
            ) : null}
          </div>
        ) : null}
        {/* Pointer devices get a real toolbar that the hover/focus rule fades
            in; touch devices get the disclosure below. This is deliberately not
            one `<details>` for both: engines no longer paint the contents of a
            closed `<details>`, so a summary hidden at desktop width left the
            actions laid out, measurable, and permanently unclickable.

            Pointer activation is admitted on primary press. The variable-height
            transcript can commit its first measurement between pointer-down and
            pointer-up, moving the overlay while the page settles; waiting for a
            native click would then silently target the card beneath it. Keyboard
            and assistive activation still arrives through the zero-detail click. */}
        <div class="message-actions" role="toolbar" aria-label="Message actions">
          <div class="message-actions-row">
            <button
              type="button"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
                onCopy();
              }}
              onClick={(event) => { if (event.detail === 0) onCopy(); }}
            >Copy</button>
            {/* Retry is the ordinary "ask that again" gesture, not only an
                error recovery. It re-sends into the same session, so the
                original turn and its receipt chain stay inspectable — and the
                earlier answer is still in provider context, which the title
                states rather than implying a clean regeneration. */}
            {message.role === "assistant" && message.originatingPrompt ? (
              <button
                type="button"
                title={message.error
                  ? "Send the same prompt again in this conversation."
                  : "Ask again in this conversation. The earlier answer stays in the transcript and in provider context."}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  onRetry();
                }}
                onClick={(event) => { if (event.detail === 0) onRetry(); }}
              >Retry</button>
            ) : null}
            {message.role === "user" ? (
              <button
                type="button"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  onEdit();
                }}
                onClick={(event) => { if (event.detail === 0) onEdit(); }}
              >Edit &amp; resend</button>
            ) : null}
            <button
              type="button"
              onPointerDown={(event) => {
                if (event.button !== 0 || branchDisabled) return;
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
                onBranch();
              }}
              onClick={(event) => { if (event.detail === 0 && !branchDisabled) onBranch(); }}
              disabled={branchDisabled}
            ><Icon name="branch" size={14} /> Fork conversation</button>
          </div>
        </div>
        <details class="message-actions-touch">
          <summary role="button" aria-label="Message actions">•••</summary>
          <div role="menu" aria-label="Message actions">
            <button role="menuitem" type="button" onClick={onCopy}>Copy</button>
            {message.role === "assistant" && message.originatingPrompt ? (
              <button role="menuitem" type="button" onClick={onRetry}>Retry</button>
            ) : null}
            {message.role === "user" ? <button role="menuitem" type="button" onClick={onEdit}>Edit &amp; resend</button> : null}
            <button role="menuitem" type="button" onClick={onBranch} disabled={branchDisabled}><Icon name="branch" size={14} /> Fork conversation</button>
          </div>
        </details>
      </div>
    </article>
  );
}

function ProfileManagerView({
  catalog,
  catalogDurability,
  activeProfileId,
  onActivate,
  onSave,
  onFork,
  onDelete,
  draftState,
  selectedProfileId,
}: {
  catalog: ProfileCatalog;
  catalogDurability: ProfileCatalogStore["durability"];
  activeProfileId: string;
  onActivate: (profileId: string) => Promise<void>;
  onSave: (draft: ProfileEditorDraft) => Promise<ProfileRevision>;
  onFork: (profile: ProfileRevision) => Promise<ProfileRevision>;
  onDelete: (profileId: string, replacementProfileId?: string) => Promise<void>;
  draftState: { current: boolean };
  selectedProfileId?: string;
}) {
  const profiles = useMemo(() => managedProfiles(catalog), [catalog]);
  const [selectedId, setSelectedId] = useState(activeProfileId);
  const selected = profiles.find((profile) => profile.profileId === selectedId) ?? profiles[0]!;
  const [draft, setDraft] = useState<ProfileEditorDraft>(() => profileDraftForEditor(selected));
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [previewThemeId, setPreviewThemeId] = useState<string>();
  const [replacementProfileId, setReplacementProfileId] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(profileDraftForEditor(selected));
  useBeforeUnloadGuard(dirty || busy);
  draftState.current = dirty;

  useEffect(() => {
    setDraft(profileDraftForEditor(selected));
    setReplacementProfileId("");
  }, [selected.revision]);

  useEffect(() => {
    if (!profiles.some((profile) => profile.profileId === selectedId)) setSelectedId(profiles[0]?.profileId ?? "");
  }, [catalog.archivedProfileIds, profiles, selectedId]);
  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.profileId === selectedProfileId)) setSelectedId(selectedProfileId);
  }, [profiles, selectedProfileId]);

  useEffect(() => () => {
    if (previewThemeId) {
      const active = catalog.themes.find((theme) => theme.themeId === selected.theme.themeId);
      if (active) applyTheme(active);
    }
  }, [catalog.themes, previewThemeId, selected.theme.themeId]);

  async function save() {
    setBusy(true);
    setStatus(undefined);
    try {
      const revision = await onSave(draft);
      setDraft(profileDraftForEditor(revision));
      setStatus(catalogDurability === "encrypted-vault"
        ? "Revision saved to the encrypted Vault. Existing sessions remain pinned."
        : "Revision saved in page memory. Existing sessions remain pinned.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function fork() {
    setBusy(true);
    setStatus(undefined);
    try {
      const profile = await onFork(selected);
      setSelectedId(profile.profileId);
      setDraft(profileDraftForEditor(profile));
      setStatus(catalogDurability === "encrypted-vault"
        ? "Independent profile fork saved to the encrypted Vault."
        : "Independent profile fork created in page memory.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (profiles.length <= 1) return;
    const isActive = selected.profileId === activeProfileId;
    if (isActive && !replacementProfileId) {
      setStatus("Choose the profile that should become active before removing this one from new work.");
      return;
    }
    if (!window.confirm(`Remove ${selected.name} from the profile manager? Existing conversations and receipts will remain pinned and inspectable.`)) return;
    setBusy(true);
    setStatus(undefined);
    try {
      await onDelete(selected.profileId, isActive ? replacementProfileId : undefined);
      const next = profiles.find((profile) => profile.profileId !== selected.profileId && profile.profileId === replacementProfileId)
        ?? profiles.find((profile) => profile.profileId !== selected.profileId);
      if (next) setSelectedId(next.profileId);
      setStatus("Removed from new work. Existing conversations remain inspectable and resumable through their pinned immutable profile revision.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="work-view">
      <PageHeading eyebrow="Immutable agent manifests" title="Profiles" description="Manage agent personas, instructions, and interface themes. Saves create content-addressed revisions; applying one forks a pinned session." />
      <div class="management-layout">
        <div class="profile-catalog panel">
          <div class="panel-heading"><span>Profiles</span><button class="small-button" type="button" onClick={() => void fork()} disabled={busy}><Icon name="plus" size={14} /> Fork</button></div>
          <div class="profile-card-list">
            {profiles.map((profile) => (
              <button key={profile.profileId} class={profile.profileId === selected.profileId ? "profile-card active" : "profile-card"} type="button" onClick={() => { if (!dirty || window.confirm(PROFILE_DRAFT_DISCARD_PROMPT)) { setStatus(undefined); setSelectedId(profile.profileId); } }}>
                <span class="profile-monogram">{profileMonogram(profile.name)}</span>
                <span><strong>{profile.name}</strong><small>{profile.description}</small><PostureChip posture={profile.minimumPosture} prefix="Minimum posture" /></span>
                {profile.profileId === activeProfileId ? <em>active</em> : null}
              </button>
            ))}
          </div>
        </div>
        <div class="profile-editor panel">
          <div class="panel-heading"><span>Profile revision</span><span>{selected.revision.slice(-10)}</span></div>
          <div class="profile-form">
            <div class="profile-form-row">
              <label><span>Name</span><input value={draft.name} maxLength={120} onInput={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
              <label><span>Role</span><input value={draft.description} maxLength={4096} onInput={(event) => setDraft({ ...draft, description: event.currentTarget.value })} /></label>
            </div>
            <details class="profile-editor-disclosure">
              <summary><span>System instructions</span><small>{draft.systemPrompt.length.toLocaleString()} characters</small></summary>
              <label><span>Prompt</span><textarea rows={7} value={draft.systemPrompt} onInput={(event) => setDraft({ ...draft, systemPrompt: event.currentTarget.value })} /></label>
            </details>
            <details class="profile-editor-disclosure">
              <summary><span>Interface theme</span><small>{catalog.themes.find((theme) => theme.themeId === draft.themeId)?.name ?? "Selected theme"}</small></summary>
              <div class="theme-manager">
                <div><span class="field-label">Theme library</span><small>Semantic tokens only</small></div>
                <div class="theme-options">
                {catalog.themes.map((theme) => (
                  <button
                    key={theme.themeId}
                    class={draft.themeId === theme.themeId ? "theme-option active" : "theme-option"}
                    type="button"
                    aria-pressed={draft.themeId === theme.themeId}
                    onClick={() => { setDraft({ ...draft, themeId: theme.themeId }); setPreviewThemeId(theme.themeId); applyTheme(theme); }}
                  >
                    <ProfileThemeSwatch theme={theme} />
                    <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                  </button>
                ))}
                </div>
              </div>
            </details>
            <details class="profile-editor-disclosure">
              <summary><span>Profile boundaries</span><small>{draft.memoryScope} memory · {approvalModeLabel(draft.approvalMode)}</small></summary>
              <div class="profile-boundary-grid">
                <label><span>Workspace</span><MenuSelect ariaLabel="Profile workspace binding" value={draft.workspaceBinding} options={[
                  { value: "active-workspace", label: "Current workspace", description: "Follow the workspace chosen by this runtime" },
                  { value: "workspace-id", label: "Exact workspace", description: "Only start on one pinned workspace ID" },
                ]} onChange={(workspaceBinding) => setDraft({ ...draft, workspaceBinding: workspaceBinding as ProfileEditorDraft["workspaceBinding"] })} /></label>
                <label><span>Memory priority</span><MenuSelect ariaLabel="Profile memory scope" value={draft.memoryScope} options={[
                  { value: "session", label: "This conversation" },
                  { value: "profile", label: "This profile" },
                  { value: "workspace", label: "Shared workspace" },
                ]} onChange={(memoryScope) => setDraft({ ...draft, memoryScope: memoryScope as ProfileEditorDraft["memoryScope"] })} /></label>
                <label><span>Action approvals</span><MenuSelect ariaLabel="Profile approval policy" value={draft.approvalMode} options={[
                  { value: "ask-first", label: "Ask First" },
                  { value: "auto-approve", label: "Auto Approve" },
                  { value: "full-access", label: "Full Access" },
                ]} onChange={(approvalMode) => setDraft({ ...draft, approvalMode: approvalMode as ProfileEditorDraft["approvalMode"] })} /></label>
                <label><span>Minimum proof</span><MenuSelect ariaLabel="Profile minimum proof posture" value={draft.minimumPosture} options={[
                  { value: "local", label: "Local", description: "No remote inference proof is required" },
                  { value: "plaintext-remote", label: "Remote", description: "Permit any connected remote runtime" },
                  { value: "encrypted-unattested", label: "Encrypted", description: "Require encrypted remote inference" },
                  { value: "encrypted-attested", label: "Attested", description: "Require verified endpoint evidence" },
                ]} onChange={(minimumPosture) => setDraft({ ...draft, minimumPosture: minimumPosture as SecurityPosture })} /></label>
                {draft.workspaceBinding === "workspace-id" ? <label><span>Workspace ID</span><input value={draft.workspaceId} maxLength={512} placeholder="vault+gdrive://…" onInput={(event) => setDraft({ ...draft, workspaceId: event.currentTarget.value })} /></label> : null}
              </div>
              <p class="profile-boundary-note">These settings, including the minimum proof posture below, are copied into each new session. Existing conversations keep their original pin.</p>
            </details>
            <div class="revision-strip">
              <span><small>Runtime</small>{selected.providerId} · {selected.model}</span>
              <span><PostureChip posture={selected.minimumPosture} prefix="Minimum proof" /></span>
              <span><small>Skills resolved</small>{effectiveSkillIds(selected, catalog).length}</span>
              <span><small>Parent</small>{selected.parentRevision?.slice(-8) ?? "origin"}</span>
            </div>
            <div class="profile-actions">
              <button class="small-button" type="button" onClick={() => void save()} disabled={busy}>Save new revision</button>
              <button class="primary-link button-link" type="button" onClick={() => void onActivate(selected.profileId)} disabled={busy || dirty} title={dirty ? "Save this revision before applying it." : undefined}>Apply in a new session</button>
              {previewThemeId ? <button class="small-button" type="button" onClick={() => { const theme = catalog.themes.find((item) => item.themeId === selected.theme.themeId); if (theme) applyTheme(theme); setDraft(profileDraftForEditor(selected)); setPreviewThemeId(undefined); }}>Cancel preview</button> : null}
              {previewThemeId ? <span>Previewing — not saved</span> : null}
              {status ? <span role="status" aria-live="polite">{status}</span> : null}
            </div>
            <details class="profile-danger-disclosure">
              <summary>Remove profile from new work</summary>
              <div class="profile-archive-zone">
                <div><strong>Immutable history stays available</strong><p>Existing conversations, receipts, audits, and pinned revisions remain inspectable.</p></div>
                {selected.profileId === activeProfileId ? <label><span>Activate replacement first</span><MenuSelect placement="up" ariaLabel="Replacement profile" value={replacementProfileId} options={[{ value: "", label: "Choose replacement" }, ...profiles.filter((profile) => profile.profileId !== selected.profileId).map((profile) => ({ value: profile.profileId, label: profile.name }))]} onChange={setReplacementProfileId} /></label> : null}
                <button class="small-button danger" type="button" disabled={busy || profiles.length <= 1 || (selected.profileId === activeProfileId && !replacementProfileId)} onClick={() => void archive()}>{profiles.length <= 1 ? "Only profile cannot be removed" : "Remove profile"}</button>
              </div>
            </details>
          </div>
        </div>
      </div>
      <details class="callout compact-callout"><summary><Icon name="cloud" /><strong>{catalogDurability === "encrypted-vault" ? "Storage status · encrypted Vault" : "Storage status · page memory"}</strong></summary><p>{catalogDurability === "encrypted-vault" ? "Profile, theme, and skill revisions use the same encrypted conditional-write authority as this active Vault." : "Profile changes last for this page lifetime. Manifests are content-addressed; this view does not claim they are synced."}</p></details>
    </section>
  );
}

function SkillsManagerView({
  catalog,
  catalogDurability,
  activeProfileId,
  onSetGlobal,
  onSetProfile,
  onApply,
  scope,
}: {
  catalog: ProfileCatalog;
  catalogDurability: ProfileCatalogStore["durability"];
  activeProfileId: string;
  onSetGlobal: (skillId: string, enabled: boolean) => Promise<void>;
  onSetProfile: (profileId: string, skillId: string, mode: SkillMode) => Promise<void>;
  onApply: (profileId: string) => Promise<void>;
  scope: string;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState(activeProfileId);
  const profiles = useMemo(() => managedProfiles(catalog), [catalog]);
  const scopedProfileId = scope === "global" ? selectedProfileId : scope;
  const profile = profiles.find((candidate) => candidate.profileId === scopedProfileId) ?? profiles[0]!;
  const [status, setStatus] = useState<string>();

  async function updateGlobal(skillId: string, enabled: boolean): Promise<void> {
    setStatus(undefined);
    try {
      await onSetGlobal(skillId, enabled);
      setStatus(catalogDurability === "encrypted-vault" ? "Global skill policy saved to the encrypted Vault." : "Global skill policy updated for this page.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateProfileSkill(skillId: string, mode: SkillMode): Promise<void> {
    setStatus(undefined);
    try {
      await onSetProfile(profile.profileId, skillId, mode);
      setStatus(catalogDurability === "encrypted-vault" ? "Profile skill policy saved to the encrypted Vault." : "Profile skill policy updated for this page.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section class="work-view">
      <PageHeading eyebrow="Resolved instruction modules" title="Skills" description={scope === "global" ? "Set global skill defaults. Enabled instructions are pinned into the next conversation manifest." : `Set inherit/on/off overrides for ${profile.name}. Existing conversations remain pinned.`} />
      <div class="skills-toolbar panel">
        {scope === "global" ? <div class="skill-select-field"><span>Preview resolution for</span><MenuSelect placement="down" ariaLabel="Preview profile resolution" value={profile.profileId} options={profiles.map((candidate) => ({ value: candidate.profileId, label: candidate.name }))} onChange={setSelectedProfileId} /></div> : <div><span class="eyebrow">Profile scope</span><strong>{profile.name}</strong></div>}
        <div><span class="eyebrow">Effective set</span><strong>{effectiveSkillIds(profile, catalog).length} of {catalog.skills.length}</strong></div>
        <button class="small-button" type="button" onClick={() => void onApply(profile.profileId)}>Apply in a new session</button>
      </div>
      <div class="skill-grid">
        {catalog.skills.map((skill) => {
          const globalEnabled = catalog.globalSkills[skill.skillId] ?? false;
          const mode = profile.skillModes[skill.skillId] ?? "inherit";
          const enabled = mode === "on" || (mode === "inherit" && globalEnabled);
          return (
            <article class={enabled ? "skill-card panel enabled" : "skill-card panel"} key={skill.skillId}>
              <header><span class="skill-glyph"><Icon name="skills" /></span><div><h2>{skill.name}</h2><code>{skill.skillId}</code></div><span class={enabled ? "skill-state on" : "skill-state"}>{enabled ? "resolved on" : "resolved off"}</span></header>
              <p>{skill.description}</p>
              <div class="skill-controls">
                {scope === "global" ? <button class={globalEnabled ? "toggle-control on" : "toggle-control"} role="switch" aria-checked={globalEnabled} type="button" onClick={() => void updateGlobal(skill.skillId, !globalEnabled)}><span /> Global default</button> : <div class="skill-select-field"><span>{profile.name}</span><MenuSelect placement="down" ariaLabel={`${profile.name} mode for ${skill.name}`} value={mode} options={[{ value: "inherit", label: "Inherit global" }, { value: "on", label: "Always on" }, { value: "off", label: "Always off" }]} onChange={(next) => void updateProfileSkill(skill.skillId, next as SkillMode)} /></div>}
              </div>
              <details class="skill-details"><summary>Instruction boundary</summary><footer><span>{skill.requiredTools.length ? `References ${skill.requiredTools.join(" · ")}` : "Instruction-only"}<br />Tools remain approval-gated.</span><code>{skill.digest.slice(-9)}</code></footer></details>
            </article>
          );
        })}
      </div>
      {status ? <p role="status" aria-live="polite">{status}</p> : null}
      <details class="callout compact-callout"><summary><Icon name="lock" /><strong>Conversation boundary</strong></summary><p>Changes affect future resolution only. Running conversations keep their pinned prompt and skill-set digests.</p></details>
    </section>
  );
}

function ProofInspector({
  receipt,
  endpointRecord,
  now = Date.now(),
  compact = false,
  onOpenAttestations,
}: {
  receipt?: ConversationReceipt;
  endpointRecord?: ChutesEndpointEvidenceRecord;
  now?: number;
  compact?: boolean;
  onOpenAttestations?: () => void;
}) {
  const model = composeClaimStack(receipt, endpointRecord, now);
  const establishedCount = model.groups.verified.length + model.groups.asserted.length;
  const evidenceTone = model.evidence === "absent"
    ? "absent"
    : model.evidence.startsWith("stale-") ? "stale" : "matched";
  const evidenceLabel = model.evidence === "turn-bound"
    ? "Receipt-bound endpoint evidence"
    : model.evidence === "same-endpoint"
      ? "Same endpoint · not turn-bound"
      : model.evidence === "stale-turn-bound"
        ? "Receipt evidence refresh due"
        : model.evidence === "stale-same-endpoint"
          ? "Endpoint comparison expired"
          : "Turn receipt only";
  return (
    <div class={compact ? "proof-inspector compact" : "proof-inspector panel"}>
      <div class="inspector-heading"><div><span class="eyebrow">Claim stack</span><h2>Verification</h2></div><span class="proof-level">{receipt ? proofLevelLabel(receipt.proofLevel) : "Not checked"}</span></div>
      {receipt ? <p class="proof-bottom-line">{rankedReceiptVerdict({ proofLevel: receipt.proofLevel, posture: receipt.posture, statuses: model.items.map((item) => item.status) })}</p> : null}
      {receipt ? (
        <section class={`evidence-join evidence-join--${evidenceTone}`} aria-label="Evidence composition">
          <div class="evidence-join__heading">
            <strong class={`evidence-join__state evidence-join__state--${evidenceTone}`}><span aria-hidden="true" />{evidenceLabel}</strong>
            <span>{establishedCount} established · {model.groups.unavailable.length} not established</span>
          </div>
          <p>{model.evidenceSummary}</p>
          {endpointRecord ? <dl class="evidence-join__facts">
            <div><dt>Instance</dt><dd>{endpointRecord.subject.instanceId}</dd></div>
            <div><dt>Evidence</dt><dd>{relativeEvidenceAge(endpointRecord.acquisition.fetchedAt, now)}</dd></div>
          </dl> : null}
          {onOpenAttestations ? <button class="evidence-join__action" type="button" onClick={onOpenAttestations}>{endpointRecord ? "Inspect endpoint evidence" : "Inspect evidence"} <span aria-hidden="true">→</span></button> : null}
        </section>
      ) : null}
      <div class="claim-groups">
        <ClaimGroup label="Needs attention" tone="failed" items={model.groups.failed} receipt={receipt} />
        <ClaimGroup label="Verified" tone="verified" items={model.groups.verified} receipt={receipt} />
        <ClaimGroup label="Assertions" tone="asserted" items={model.groups.asserted} receipt={receipt} />
        {model.groups.unavailable.length > 0 ? (
          <details class="claim-absence" open={!receipt}>
            <summary><span>Not established</span><strong>{model.groups.unavailable.length}</strong><small>Future or unavailable claims</small></summary>
            <div class="claim-absence__list">
              {model.groups.unavailable.map((item) => {
                const language = claimLanguage(item.key);
                return <div key={item.key}><span>{language.primary}</span><small>{item.claim.summary}</small></div>;
              })}
            </div>
          </details>
        ) : null}
      </div>
      {receipt ? (
         <details class="receipt-record"><summary>Technical receipt details</summary>
          <div class="receipt-id"><span>Receipt</span><code>{receipt.receiptId}</code></div>
          <dl class="receipt-metadata">
             <div><dt>Created</dt><dd><time dateTime={receipt.createdAt}>{relativeEvidenceAge(receipt.createdAt)}</time></dd></div>
             <div><dt>Posture</dt><dd>{postureLabel(receipt.posture)}</dd></div>
            <div><dt>Provider</dt><dd>{receipt.provider}</dd></div>
            <div><dt>Model</dt><dd>{receipt.model ?? "not recorded"}</dd></div>
            <div><dt>Session</dt><dd>{receipt.sessionId}</dd></div>
            <div><dt>Turn</dt><dd>{receipt.turnId}</dd></div>
            <div><dt>Binding</dt><dd>{receipt.bindings.algorithm}</dd></div>
            <div><dt>Evidence</dt><dd>{receipt.evidence?.format ?? "not attached"}</dd></div>
          </dl>
          <dl class="binding-record">
            {receipt.bindings.requestDigest ? <div><dt>Request digest</dt><dd>{receipt.bindings.requestDigest}</dd></div> : null}
            {receipt.bindings.responseDigest ? <div><dt>Response digest</dt><dd>{receipt.bindings.responseDigest}</dd></div> : null}
            {receipt.bindings.requestCiphertextDigest ? <div><dt>Request ciphertext</dt><dd>{receipt.bindings.requestCiphertextDigest}</dd></div> : null}
            {receipt.bindings.responseCiphertextDigest ? <div><dt>Response ciphertext</dt><dd>{receipt.bindings.responseCiphertextDigest}</dd></div> : null}
            {receipt.bindings.evidenceDigest ? <div><dt>Evidence digest</dt><dd>{receipt.bindings.evidenceDigest}</dd></div> : null}
          </dl>
         </details>
      ) : <p class="inspector-note">No turn receipt yet. Production remote mode must verify fresh endpoint evidence before inference; the compatibility lab remains visibly unattested.</p>}
    </div>
  );
}

function ClaimGroup({ label, tone, items, receipt }: { label: string; tone: "failed" | "verified" | "asserted"; items: readonly ClaimStackItem[]; receipt?: ConversationReceipt }) {
  if (items.length === 0) return null;
  return <section class={`claim-group claim-group--${tone}`} aria-label={`${label} claims`}>
    <header><span>{label}</span><strong>{items.length}</strong></header>
    <div class="claim-list">{items.map((item) => <ClaimRow key={item.key} item={item} receipt={receipt} />)}</div>
  </section>;
}

function ClaimRow({ item, receipt }: { item: ClaimStackItem; receipt?: ConversationReceipt }) {
  const { key: claimKey, claim, verification, facts, source, status } = item;
  const sealState = sealStateForProofStatus(status);
  const language = claimLanguage(claimKey);
  const expiresAt = claimExpiry(claim.details);
  return (
    <details class="claim-row">
      <summary>
        <span class="claim-title">{language.primary}</span>
        <span class="claim-disclosure"><span aria-hidden="true" /></span>
        <span class="claim-meta">
          <Seal class="claim-seal" state={sealState} label={proofStatusLabel(status)} size={16} compact />
          <span class={`claim-source claim-source--${source}`}>{source === "endpoint-evidence" ? "Receipt-bound evidence" : "Turn receipt"}</span>
        </span>
      </summary>
      <div class="claim-detail">
         <p>{claim.summary}</p>
         <dl><dt>Claim</dt><dd>{language.technical}</dd></dl>
         <dl><dt>Source</dt><dd>{source === "endpoint-evidence" ? "Endpoint evidence whose normalized payload digest matches this receipt" : "This conversation turn receipt"}</dd></dl>
         <dl><dt>Issuer</dt><dd>{claim.verifier ?? verification?.verifier ?? receipt?.provider ?? "Not supplied"}</dd></dl>
         <dl><dt>Subject</dt><dd>{receipt?.model ?? receipt?.sessionId ?? "Not supplied"}</dd></dl>
         <dl><dt>Scope</dt><dd>{claimKey === "conversation" ? "This conversation turn" : claimKey === "payment" ? "This account observation" : "This inference endpoint"}</dd></dl>
         <dl><dt>Status</dt><dd>{proofStatusLabel(status)}</dd></dl>
        {claim.verifier || verification?.verifier ? <dl><dt>Verifier</dt><dd>{claim.verifier ?? verification?.verifier}</dd></dl> : null}
        {verification?.version ? <dl><dt>Version</dt><dd>{verification.version}</dd></dl> : null}
         {claim.checkedAt || verification?.checkedAt ? <dl><dt>Checked</dt><dd><time dateTime={claim.checkedAt ?? verification?.checkedAt}>{relativeEvidenceAge((claim.checkedAt ?? verification?.checkedAt)!)}</time></dd></dl> : null}
         <dl><dt>Expires</dt><dd>{expiresAt ? <time dateTime={expiresAt} title={new Date(expiresAt).toLocaleString()}>{relativeEvidenceAge(expiresAt)}</time> : "Not supplied"}</dd></dl>
        {facts.map((fact: ClaimStackFact) => <dl key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></dl>)}
        {verification?.detail ? <dl><dt>Verifier note</dt><dd>{verification.detail}</dd></dl> : null}
         {claim.policyDigest || claim.details !== undefined ? <details><summary>Technical details</summary>{claim.policyDigest ? <dl><dt>Verifier policy digest</dt><dd>{claim.policyDigest}</dd></dl> : null}{claim.details !== undefined ? <pre>{JSON.stringify(claim.details, null, 2)}</pre> : null}</details> : null}
      </div>
    </details>
  );
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header class="page-heading"><span class="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

function EmptyState({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return <div class="empty-state"><Icon name={icon} /><strong>{title}</strong><p>{body}</p></div>;
}

function humanStatus(value: string): string {
  if (value === "thinking") return "Thinking";
  if (value === "complete") return "Sealing receipt";
  return value.replace(/^running /u, "Running ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function profileDraftForEditor(profile: ProfileRevision): ProfileEditorDraft {
  const silo = resolveProfileSilo(profile);
  return {
    profileId: profile.profileId,
    name: profile.name,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    themeId: profile.theme.themeId,
    workspaceBinding: silo.workspaceBinding.kind,
    workspaceId: silo.workspaceBinding.kind === "workspace-id" ? silo.workspaceBinding.workspaceId : "",
    memoryScope: silo.memoryScope,
    approvalMode: silo.approvalMode,
    minimumPosture: profile.minimumPosture,
  };
}

function effectiveSkillIds(profile: ProfileRevision, catalog: ProfileCatalog): string[] {
  return catalog.skills
    .filter((skill) => {
      const mode = profile.skillModes[skill.skillId] ?? "inherit";
      return mode === "on" || (mode === "inherit" && Boolean(catalog.globalSkills[skill.skillId]));
    })
    .sort((left, right) => left.promptOrder - right.promptOrder || left.skillId.localeCompare(right.skillId))
    .map((skill) => skill.skillId);
}

function receiptSummary(receipt: ConversationReceipt): string {
  if (receipt.posture === "local") return "Client request and response digests were recorded locally. No external signer or hardware identity is established.";
  if (receipt.posture === "encrypted-unattested") return "Encrypted request and response bindings were recorded, but the endpoint's hardware identity was not independently verified.";
  if (receipt.posture === "encrypted-attested") return "The receipt includes encrypted conversation bindings and endpoint evidence; expand each claim to inspect exactly what its verifier established.";
  return "A remote conversation receipt was recorded without an encrypted transport claim.";
}

function readViewHash(): View {
  if (typeof window === "undefined") return "chat";
  return navigationViewFromHash(window.location.hash);
}

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { serializePortableReceipt } from "../attestation/receipt";
import type {
  AttestationEvidenceClientErrorCode,
  ChutesAttestationEvidenceClient,
} from "../attestation/provider-client";
import type {
  ChutesEndpointAttestationSnapshot,
  ChutesEndpointEvidenceRecord,
} from "../attestation/provider-types";
import { ApprovalBroker } from "../approvals/broker";
import { approvalProvenance, createApprovalModePolicy } from "../approvals/modes";
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
  consumeChutesAuthorizationCallback,
  createChutesAuthorizationRequest,
  exchangeChutesAuthorizationCode,
  refreshChutesOAuthToken,
  type ChutesOAuthTokenSet,
  type ChutesPkceAttempt,
} from "../auth/chutes-oauth";
import { loadChutesAccountSnapshot } from "../billing/client";
import {
  completeSlashCommand,
  createSlashCommandRegistry,
  planSlashCommand,
  type SlashCommandPlan,
  type SlashCommandRegistry,
  type SlashCompletion,
} from "../commands";
import { createSessionManifest, runTurn } from "../core/agent";
import type { InferenceTransport, SessionManifest } from "../core/contracts";
import { prepareCanonicalImageInputs } from "../core/multimodal";
import { EventJournal, type DurableEvent, type SessionRecord } from "../core/journal";
import { randomUuid } from "../core/id";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import { MemoryJournalBackend } from "../core/memory-journal";
import type { SessionAuditReport } from "../core/session-audit";
import { DemoInferenceTransport } from "../inference/demo";
import {
  BrowserGitClient,
  MemoryGitAdapter,
  type GitOperation,
  type GitOperationDescriptor,
} from "../git";
import type { ChutesInferenceTransport, ChutesInvocationTelemetry } from "../inference/chutes";
import { modelInputModalityCapability, type AirshipModel } from "../models";
import type { ExecutionCapability } from "../execution/runtime-registry";
import {
  MemoryGraphRenderer,
  deriveMemoryRelationshipGraph,
  type MemoryRelationshipGraph,
} from "../memory-graph";
import { archiveProfileRevision, createBuiltInProfileCatalog, managedProfileRevisions, type ProfileCatalog } from "../profiles/catalog";
import {
  createGlobalSkillSettings,
  createProfileRevision,
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
} from "../sessions";
import { createAirshipToolRegistry } from "../tools/airship-tools";
import { VaultCoordinator, isGoogleDriveConfiguration, type ReadyVaultRuntime, type VaultSnapshot } from "../vault";
import { createLocalLabConfigureRequest } from "../vault/local-lab";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { isWorkspaceControlPlanePath, type WorkspaceEntry, type WorkspaceFile, type WorkspacePort } from "../workspace/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { composeClaimStack, type ClaimStackFact, type ClaimStackItem } from "./claim-stack-model";
import { ApprovalDock } from "./approval-dock";
import { attestationRecordIdForReceipt, sessionAttestationReceipts } from "./attestation-history";
import type { AttestationRefreshTarget } from "./attestations-view";
import { ContextView as ClientContextView } from "./context-route";
import { Icon, type IconName } from "./icons";
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
import { postureSeal, SEAL_LABELS, Seal, sealStateForProofStatus, type SealState } from "./seal";
import { enabledSlashSelection, firstEnabledSlashIndex, moveSlashSelection } from "./slash-menu-state";
import type { SourcesImportRequest } from "./sources-view";
import { transitionVaultProvider } from "./vault-provider-transition";
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
import { useWindowedTranscript } from "./chat/use-windowed-transcript";
import { composerAttachments, userMessageParts, type ComposerAttachment } from "./chat/composer-state";
import { recoverPartialTurn } from "./chat/turn-recovery";
import { StreamingMessageSlot, TranscriptStreamStore } from "./chat/streaming-slot";
import { isNearLastRealCard, preferredJumpBehavior, scrollToLastRealCard } from "./chat/transcript-anchor";
import { TabPresenceNote } from "./tab-presence";
import { MemoryKindLegend, MemorySearch } from "./memory-controls";
import { ProfileThemeSwatch } from "./profile-theme-swatch";
import { PostureChip } from "./posture-chip";
import { DurabilityIndicator } from "./durability-indicator";
import { groupMemoryRelationships } from "./memory-relationships";
import { mapUnknownRequestFailure } from "./request-state";
import { claimExpiry, claimLanguage, postureLabel, proofLevelLabel, proofStatusLabel, rankedReceiptVerdict, relativeEvidenceAge } from "./trust-language";
import { RouteSkeleton } from "./route-skeleton";
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

type Runtime = {
  workspace: WorkspacePort;
  workspaceId: string;
  journal: EventJournal;
  transport: InferenceTransport;
  model: string;
  tools: Awaited<ReturnType<typeof createAirshipToolRegistry>>;
};

type OAuthCallbackStatus = { kind: "verified" | "blocked" | "error"; message: string };
type AttestationsScreenComponent = typeof import("./attestations-view").AttestationsView;
type EditorScreenComponent = typeof import("./editor-view").EditorView;
type TerminalScreenComponent = typeof import("./terminal-view").TerminalView;
type CapabilitiesScreenComponent = typeof import("./capabilities-view").CapabilitiesView;
type GoogleDriveSetupComponent = typeof import("./google-drive-setup").GoogleDriveSetup;
type LocalLabSetupComponent = typeof import("./local-lab-setup").LocalLabSetup;
type SessionsScreenComponent = typeof import("./sessions-route").SessionsView;
type VaultScreenComponent = typeof import("./vault-view").VaultView;
type AccessScreenComponent = typeof import("./access-view").AccessView;
type BillingScreenComponent = typeof import("./billing-view").BillingView;
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

/** Keep automated browser work out of the operator's visible local-user vault. */
export function localLabVaultConfiguration(location?: Pick<Location, "hostname" | "search">) {
  if (!location || !["localhost", "127.0.0.1"].includes(location.hostname)) return LOCAL_LAB_VAULT;
  const candidate = new URLSearchParams(location.search).get(LOCAL_LAB_TEST_NAMESPACE_PARAMETER) ?? "";
  if (!/^airship-live-v2\/e2e\/[a-z0-9][a-z0-9-]{0,80}$/u.test(candidate)) return LOCAL_LAB_VAULT;
  return Object.freeze({ ...LOCAL_LAB_VAULT, namespace: candidate });
}
const LOCAL_LAB_DEV_KEY = Object.freeze([
  0xa1, 0x25, 0x7f, 0x0c, 0x93, 0x4e, 0xd8, 0x62, 0x1b, 0xf4, 0x30, 0xa9, 0x57, 0x8e, 0x6d, 0x14,
  0xc2, 0x0b, 0x9a, 0x46, 0xe3, 0x71, 0x58, 0xbd, 0x2f, 0x84, 0xd0, 0x6a, 0x39, 0xf7, 0x1c, 0x50,
]);

const AIRSHIP_WORKSPACE_GUIDE = `# Airship workspace

This is the agent's private virtual workspace, rooted at \`/workspace\`. The local lab adopts its client-encrypted MinIO vault by default; Preferences can deliberately move the active runtime to Ephemeral page memory and back.

## What the agent can do here

- Inspect, read, search, create, patch, move, and remove workspace files with revision checks.
- Build and query an on-device hybrid context index bound to exact file revisions.
- Maintain a validated task plan in \`.airship/tasks.json\`.
- Inspect and change browser-owned Git state (status, diffs, staging, commits, and branches).
- Fetch bounded textual HTTPS resources when CORS permits it.
- Import a bounded public GitHub repository snapshot into \`/workspace/sources\` without an Airship backend.
- Inspect available coding runtimes, execute bounded JavaScript, and run compact WASI Preview 1 command artifacts entirely in disposable browser workers.

The model has no ambient host shell or unrestricted filesystem. It should inspect its current tool manifest, use the available browser executors, verify results, and name any exact browser or service boundary that prevents an operation.
`;

const navigationIcons: Readonly<Record<CanonicalDestinationId, IconName>> = Object.freeze({
  chat: "chat", workspace: "workspace", memory: "memory",
  profiles: "profiles", vault: "cloud", attestations: "attestation", proof: "proof", access: "access",
});
const navigation = CANONICAL_DESTINATIONS.map((item) => Object.freeze({ ...item, icon: navigationIcons[item.id] }));

const welcomeMessage: UiMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "The edge runtime is ready. Airship can edit this private workspace, search context, plan work, use browser-native Git, import public sources, and execute code in available sandboxes. Try /help or ask me to inspect README.md.",
};

/** Shown only on a fresh transcript to give the empty stage an intentional
    entry point that showcases Airship's differentiators, without overload. */
const STARTER_PROMPTS: readonly Readonly<{ title: string; hint: string; prompt: string }>[] = Object.freeze([
  Object.freeze({
    title: "Explain my trust posture",
    hint: "What's encrypted, attested, and still unverified",
    prompt: "Walk me through this session's current security posture: what is encrypted, what is attested, and what remains unverified.",
  }),
  Object.freeze({
    title: "Inspect this workspace",
    hint: "Read README.md and get oriented",
    prompt: "Inspect README.md and the workspace, then summarize what this project is and suggest a sensible first task.",
  }),
  Object.freeze({
    title: "What can run here?",
    hint: "Available browser execution runtimes",
    prompt: "What execution runtimes are available in this browser right now, and what needs activation before you can run code?",
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

export function App() {
  const [view, setView] = useState<View>(() => readViewHash());
  const [online, setOnline] = useState(() => readOnlineState(
    typeof navigator === "undefined" ? undefined : navigator,
  ));
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [trustSheetOpen, setTrustSheetOpen] = useState(false);
  const [preferences, setPreferences] = useState<PreferenceOverrides>(loadPreferenceOverrides);
  const [catalog, setCatalog] = useState<ProfileCatalog>();
  const [profileId, setProfileId] = useState("engineer");
  const [profileHubScope, setProfileHubScope] = useState("global");
  const [sessionId, setSessionId] = useState<string>();
  const [activeSessionRecord, setActiveSessionRecord] = useState<SessionRecord>();
  const [sessionLibrary, setSessionLibrary] = useState<SessionLibrary>();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [chatNavExpanded, setChatNavExpanded] = useState(true);
  const [profileNavExpanded, setProfileNavExpanded] = useState(true);
  const [recentPaletteSessions, setRecentPaletteSessions] = useState<readonly Readonly<{ id: string; title: string; open(): void }>[]>([]);
  const [recentProfileConversations, setRecentProfileConversations] = useState<readonly Readonly<{ id: string; title: string; open(): void }>[]>([]);
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
  const [GoogleDriveSetupScreen, setGoogleDriveSetupScreen] = useState<GoogleDriveSetupComponent>();
  const [LocalLabSetupScreen, setLocalLabSetupScreen] = useState<LocalLabSetupComponent>();
  const [SessionsScreen, setSessionsScreen] = useState<SessionsScreenComponent>();
  const [VaultScreen, setVaultScreen] = useState<VaultScreenComponent>();
  const [vaultViewError, setVaultViewError] = useState<string>();
  const [AccessScreen, setAccessScreen] = useState<AccessScreenComponent>();
  const [accessViewError, setAccessViewError] = useState<string>();
  const [BillingScreen, setBillingScreen] = useState<BillingScreenComponent>();
  const [billingViewError, setBillingViewError] = useState<string>();
  const runtime = useRef<Runtime>();
  const workspaceOpenRequest = useRef(0);
  const approvalBroker = useMemo(() => new ApprovalBroker(), []);
  const transcriptStreams = useMemo(() => new TranscriptStreamStore(), []);
  const approvalModePolicy = useMemo(() => createApprovalModePolicy({
    mode: preferences.approvalMode,
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
  }), [approvalBroker, preferences.approvalMode]);
  const approvalPolicyController = useMemo(() => new SwitchableApprovalPolicy(approvalModePolicy), []);
  approvalPolicyController.replace(approvalModePolicy);
  const approvalPolicy = approvalPolicyController;
  const previousApprovalMode = useRef(preferences.approvalMode);
  const vault = useMemo(() => new VaultCoordinator(), []);
  const [vaultSnapshot, setVaultSnapshot] = useState<VaultSnapshot>(() => vault.snapshot);
  const [vaultSetupOpen, setVaultSetupOpen] = useState(false);
  const [vaultProviderSwitching, setVaultProviderSwitching] = useState(false);
  const vaultProviderSwitchingRef = useRef(false);
  const oauthTokens = useRef<ChutesOAuthTokenSet>();
  const pendingOAuthCredential = useRef<string>();
  const accountCredential = useRef<string>();
  const providerCredential = useRef<string>();
  const attestationClient = useRef<ChutesAttestationEvidenceClient>();
  const attestationOperation = useRef(0);
  const activeTurn = useRef<AbortController>();
  const activePrompt = useRef<string>();
  const activeSessionIdentity = useRef<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcriptElement = useRef<HTMLDivElement>(null);
  const transcriptBoundaryElement = useRef<HTMLDivElement>(null);
  const transcriptPinned = useRef(true);
  const transcriptEntryAlignment = useRef(true);
  const attachmentPreviewUrls = useRef(new Set<string>());
  const mainRegion = useRef<HTMLElement>(null);
  const pendingDelta = useRef<{ messageId: string; text: string }>();
  const pendingDeltaFrame = useRef<number>();
  const profileOperation = useRef(0);
  const vaultAdoptionBusy = useRef(false);
  const ephemeralAdoptionBusy = useRef(false);
  const currentView = useRef<View>(view);
  currentView.current = view;

  useGlobalPaletteShortcut(() => setPaletteOpen((open) => !open));
  useGlobalNavigationJumps(navigatePrimary);
  useBeforeUnloadGuard(busy || Boolean(sessionId));
  useVisualViewport();
  useEffect(() => () => {
    for (const url of attachmentPreviewUrls.current) URL.revokeObjectURL(url);
    attachmentPreviewUrls.current.clear();
  }, []);
  const pwaUpdate = usePwaUpdate();

  const activeProfile = catalog?.profiles.find((profile) => profile.profileId === profileId);
  const activeTheme = activeProfile
    ? catalog?.themes.find((theme) => theme.themeId === activeProfile.theme.themeId && theme.digest === activeProfile.theme.digest)
    : undefined;
  const chutesConnected = isChutesConnected(connection);
  const activeChutesModel = chutesConnected
    ? availableModels.find((model) => model.id === connection.model)
    : undefined;
  const imageInputCapability = activeChutesModel
    ? modelInputModalityCapability(activeChutesModel, "image")
    : "unsupported";
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
    chutesConnected,
    Boolean(composerPlan && composerPlan.kind !== "chat"),
  );
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

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${String(Math.min(180, Math.max(56, element.scrollHeight)))}px`;
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
    if (!sessionLibrary || !profileId) { setRecentProfileConversations([]); return; }
    const controller = new AbortController();
    void loadRecentSessionPaletteSources(
      sessionLibrary,
      (targetSessionId) => { void openPaletteSession(targetSessionId); },
      controller.signal,
      profileId,
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
    connected: chutesConnected,
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
  const vaultRuntimeAdopted = vaultSnapshot.phase === "ready"
    && runtime.current?.workspaceId.startsWith("vault+") === true;
  const trustAxes: readonly TrustAxis[] = Object.freeze([
    { id: "local", label: online ? "Local runtime" : OFFLINE_RUNTIME_LABEL, state: online ? "none" : "attention", detail: online ? "The agent kernel executes in this browser." : OFFLINE_RUNTIME_DETAIL, view: "proof" },
    { id: "vault", label: vaultRuntimeAdopted ? "Vault active" : vaultSnapshot.phase === "ready" ? "Vault verified" : vaultSnapshot.phase === "probing" ? "Vault testing" : vaultSnapshot.phase === "configured" ? "Vault configured" : vaultSnapshot.phase === "degraded" ? "Vault blocked" : "Ephemeral", state: vaultSnapshot.phase === "ready" ? "verified" : vaultSnapshot.phase === "probing" ? "checking" : vaultSnapshot.phase === "configured" ? "asserted" : vaultSnapshot.phase === "degraded" ? "failed" : "none", detail: vaultRuntimeAdopted ? "This page uses verified client-encrypted cloud workspace and journal adapters; cross-device convergence is not certified." : vaultSnapshot.phase === "ready" ? "Storage contract passed; the active runtime has not adopted it." : vaultSnapshot.message, view: "vault" },
    { id: "e2ee", label: chutesConnected ? (connection.invokeAuthorization === "verified" ? "E2EE used" : "E2EE ready") : "Inference local", state: chutesConnected ? (connection.invokeAuthorization === "verified" ? "verified" : "asserted") : "none", detail: chutesConnected ? (connection.invokeAuthorization === "verified" ? "Protected invocation succeeded." : "Provider permission has not been tested yet.") : "No Chutes credential configured.", view: "access" },
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
  }

  useEffect(() => () => {
    approvalBroker.denyAll();
    attestationOperation.current += 1;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    providerCredential.current = undefined;
  }, [approvalBroker]);

  useEffect(() => {
    if (previousApprovalMode.current === preferences.approvalMode) return;
    previousApprovalMode.current = preferences.approvalMode;
    // A pending prompt belongs to the policy that created it. Never let a
    // preference change reinterpret that outstanding decision under a new mode.
    approvalBroker.denyAll();
  }, [approvalBroker, preferences.approvalMode]);

  useEffect(() => {
    const unsubscribe = vault.subscribe(setVaultSnapshot);
    return () => {
      unsubscribe();
      vault.disconnect();
    };
  }, [vault]);

  // Local-lab backend auto-connects the baked MinIO vault. Google Drive waits
  // for an explicit user gesture; ephemeral remains entirely page-memory.
  // ephemeral (page memory only) when Preferences → Storage is "Ephemeral".
  useEffect(() => {
    if (preferences.vaultBackend !== "local-lab") return;
    if (!online || vault.snapshot.phase !== "disconnected") return;
    let cancelled = false;
    void (async () => {
      try {
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
          ? "Local vault verified; adopting encrypted storage"
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

  // Readiness is not durability until the verified adapters replace the active
  // page-memory runtime. This effect waits for both halves, then adopts once.
  useEffect(() => {
    if (
      preferences.vaultBackend === "ephemeral" ||
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

  function navigate(next: View, targetHash: string = navigationHashForView(next)) {
    setMobileMoreOpen(false);
    setView(next);
    if (next !== "proof") {
      setProofSelection(undefined);
      setProofSection("summary");
    }
    if (window.location.hash !== targetHash) window.history.pushState({ view: next }, "", targetHash);
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
    if (window.location.origin !== CHUTES_ACTIVE_REGISTRATION.homepageUrl) {
      throw new Error(`Open ${CHUTES_ACTIVE_REGISTRATION.homepageUrl} before signing in so this tab can recover its one-time PKCE state.`);
    }
    pendingOAuthCredential.current = undefined;
    setOauthCallbackStatus(undefined);
    const request = await createChutesAuthorizationRequest({
      clientId: CHUTES_ACTIVE_REGISTRATION.clientId,
      registration: CHUTES_ACTIVE_REGISTRATION,
    });
    sessionStorage.setItem(CHUTES_OAUTH_ATTEMPT_KEY, JSON.stringify(request.attempt));
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

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const nextCatalog = await createBuiltInProfileCatalog();
      const profile = nextCatalog.profiles.find((candidate) => candidate.profileId === "engineer") ?? nextCatalog.profiles[0];
      if (!profile) throw new Error("Airship has no built-in agent profile.");
      const workspace = new MemoryWorkspace();
      await workspace.write("README.md", AIRSHIP_WORKSPACE_GUIDE);
      await workspace.write(
        "docs/architecture.md",
        "The browser owns orchestration. Chutes owns inference. Encrypted object storage owns durable state.",
      );
      await workspace.write("notes/retrieval.md", "Context experts are selected by directory, Git, profile, and task focus.");
      const gitAdapter = await MemoryGitAdapter.create([{
        id: "airship-workspace",
        name: "Airship Workspace",
        worktreePath: "/workspace",
        files: { "README.md": "# Private workspace\n\nInitial browser repository snapshot." },
        workingFiles: {
          "README.md": AIRSHIP_WORKSPACE_GUIDE,
          "docs/architecture.md": "The browser owns orchestration. Chutes owns inference. Encrypted object storage owns durable state.",
          "notes/retrieval.md": "Context experts are selected by directory, Git, profile, and task focus.",
        },
      }]);
      const nextGitClient = new BrowserGitClient(gitAdapter);
      const journal = new EventJournal(new MemoryJournalBackend());
      const tools = await createAirshipToolRegistry({ workspace, journal, git: nextGitClient });
      const commands = createSlashCommandRegistry({ tools });
      const nextRuntime: Runtime = {
        workspace,
        workspaceId: "memory://airship-page",
        tools,
        journal,
        transport: new DemoInferenceTransport(),
        model: "airship/demo-v1",
      };
      runtime.current = nextRuntime;
      setSlashRegistry(commands);
      const nextSession = await createProfileSession(nextRuntime, profile, nextCatalog);
      if (disposed) return;
      setCatalog(nextCatalog);
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
      setRuntimeStatus("Local kernel failed to initialize");
      setMessages([{ id: randomUuid(), role: "assistant", error: true, content: error instanceof Error ? error.message : String(error) }]);
    });
    return () => {
      disposed = true;
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
    const rawAttempt = sessionStorage.getItem(CHUTES_OAUTH_ATTEMPT_KEY);
    sessionStorage.removeItem(CHUTES_OAUTH_ATTEMPT_KEY);
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
      setMobileMoreOpen(false);
      const nextProofSelection = next === "proof" ? proofSelectionFromHash(window.location.hash) : undefined;
      const nextProofSection = next === "proof" ? proofSectionFromHash(window.location.hash) : "summary";
      setView(next);
      setProofSelection(nextProofSelection);
      setProofSection(nextProofSection);
      const canonicalHash = next === "proof" ? proofHash(nextProofSelection, nextProofSection) : navigationHashForView(next);
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
    const media = window.matchMedia("(max-width: 640px)");
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
        oauthTokens.current = undefined;
        pendingOAuthCredential.current = undefined;
        accountCredential.current = undefined;
        providerCredential.current = undefined;
        setOauthCallbackStatus({ kind: "error", message: oauthPublicClientError(error) });
        setRuntimeStatus("Chutes OAuth rotation failed; clearing the remote connection");
        void disconnectChutes();
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

  async function changeProfile(nextId: string, force = false) {
    if (!runtime.current || !catalog || (!force && nextId === profileId)) return;
    const operation = ++profileOperation.current;
    activeTurn.current?.abort();
    const selected = catalog.profiles.find((candidate) => candidate.profileId === nextId);
    if (!selected) throw new Error(`Unknown profile: ${nextId}`);
    setRuntimeStatus("Forking pinned session");
    const profile = await bindProfileToRuntime(selected, runtime.current);
    const nextCatalog = profile === selected ? catalog : replaceProfile(catalog, profile);
    const nextSession = await createProfileSession(runtime.current, profile, nextCatalog);
    if (operation !== profileOperation.current) return;
    if (nextCatalog !== catalog) setCatalog(nextCatalog);
    setProfileId(nextId);
    activateSession(nextSession);
    setSessionRevision((value) => value + 1);
    setMessages([{ ...welcomeMessage, id: randomUuid(), content: `${profile.name} profile loaded in a new pinned session. ${welcomeMessage.content}` }]);
    setEventCount(1);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    setRuntimeStatus("Local kernel ready");
  }

  async function createConversation(title?: string) {
    if (busy || !runtime.current || !activeProfile || !catalog) return;
    const created = await createProfileSession(runtime.current, activeProfile, catalog, title);
    activateSession(created);
    setMessages([{ ...welcomeMessage, id: randomUuid(), content: `${created.title} is a new isolated conversation. ${welcomeMessage.content}` }]);
    setEventCount(created.headSequence);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    setSessionRevision((value) => value + 1);
    setRuntimeStatus("New conversation ready");
    navigate("chat");
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
      const modelIds = (availableModels.length ? availableModels.map((model) => model.id) : [runtime.current.model])
        .filter((model) => !query || model.toLowerCase().includes(query));
      appendLocalExchange(source, modelIds.length
        ? modelIds.map((model) => `${model === runtime.current?.model ? "•" : "○"} ${model}`).join("\n")
        : "No matching model is available.");
      return;
    }
    if (action.type === "models.select") await switchChutesModel(action.modelId);
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
      await append([{
        type: "local.command.requested",
        turnId,
        operationId,
        payload: { content: source, toolName: plan.toolName, arguments: plan.arguments },
      }]);
      const context = { sessionId: commandSessionId, turnId, operationId, signal: controller.signal };
      const decision = await commandRuntime.tools.review(plan.toolName, plan.arguments, context, approvalPolicy);
      const provenance = approvalProvenance(approvalPolicy, context);
      if (decision !== "allow") {
        const denied = preferences.approvalMode === "auto-approve"
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
        setRuntimeStatus(preferences.approvalMode === "auto-approve"
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
      : chutesConnected
        ? "Choose a model whose authoritative Chutes catalog record includes image input before sending."
        : "Connect a vision-capable Chutes model before sending this image.");
  }

  async function branchFromMessage(message: UiMessage): Promise<void> {
    if (!sessionLibrary || !activeSessionRecord) return;
    const result = await sessionLibrary.fork(activeSessionRecord.id, {
      title: `${activeSessionRecord.title} · fork`.slice(0, 240),
      expectedSourceHead: { sequence: activeSessionRecord.headSequence, digest: activeSessionRecord.headDigest },
      ...(message.sourcePoint ? { sourcePoint: message.sourcePoint } : {}),
    });
    await activateForkedSession(result);
    setInput(message.originatingPrompt ?? message.content);
    setAttachments(message.originatingAttachments ?? []);
    setRuntimeStatus("Pinned fork created; review the restored prompt before sending");
  }

  async function sendMessage(
    retryPrompt?: string,
    retryAttachments: readonly ComposerAttachment[] = [],
  ) {
    let content = (retryPrompt ?? input).trim();
    if (!content || !runtime.current || !sessionId || busy) return;
    if (slashRegistry) {
      const slashPlan = planSlashCommand(content, slashRegistry);
      if (slashPlan.kind !== "chat") {
        setInput("");
        try {
          await runSlashPlan(slashPlan, content);
        } catch (error) {
          appendLocalExchange(content, error instanceof Error ? error.message : String(error), true);
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
    if (!online && turnTransport.id === "chutes-e2ee-v1") {
      setRuntimeStatus("Offline · remote inference paused; prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    const outgoingAttachments = retryPrompt ? retryAttachments : attachments;
    if (outgoingAttachments.length > 0 && imageInputCapability !== "supported") {
      setComposerNotice(chutesConnected
        ? imageInputCapability === "unknown"
          ? "Airship cannot verify image support from this model's catalog record. Choose a model with explicit image input."
          : `${connection.model} is text-only. Choose a vision-capable model; the image remains in this page.`
        : "Connect a vision-capable Chutes model; the image remains in this page.");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    let images: Awaited<ReturnType<typeof prepareCanonicalImageInputs>> | undefined = undefined;
    try {
      images = outgoingAttachments.length
        ? await prepareCanonicalImageInputs(outgoingAttachments.map((attachment) => attachment.file))
        : undefined;
    } catch (error) {
      setComposerNotice(error instanceof Error ? error.message : "The selected image could not be prepared safely.");
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    setInput("");
    setAttachments([]);
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
    const controller = new AbortController();
    activeTurn.current = controller;
    activePrompt.current = content;
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
      await refreshWorkspaceState(turnRuntime.workspace, setFiles, setWorkspaceFiles);
      if (activeSessionIdentity.current === turnSessionId) setRuntimeStatus("Local kernel ready");
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
      const updatedSession = await turnRuntime.journal.getSession(turnSessionId);
      if (updatedSession && activeSessionIdentity.current === turnSessionId) setActiveSessionRecord(updatedSession);
      setBusy(false);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  function stopTurn() {
    if (activePrompt.current) setInput(activePrompt.current);
    activeTurn.current?.abort(new DOMException("Stopped by user", "AbortError"));
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
        setRuntimeStatus("Vault verified; adopting encrypted storage");
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
    const prior = runtime.current;
    if (!prior || !catalog || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for vault adoption.");
    }
    activeTurn.current?.abort(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus("Migrating workspace and sessions into encrypted cloud objects");
    const { migrateJournalState, migrateWorkspaceState } = await loadDeferredCapabilities();
    const [{ EncryptedWorkspaceGitAdapter }, gitCheckpoint, pristineBootstrap] = await Promise.all([
      loadDeferredCapabilities(),
      gitClient.exportCheckpoint(),
      isPristineBootstrapRuntime(prior),
    ]);
    // A freshly opened page contains deterministic sample state only. An
    // existing encrypted vault is authoritative; release-copy changes must not
    // be mistaken for user conflicts or create a throwaway session on reload.
    // Any real workspace edit or journal event disables this shortcut.
    const targetHasUserWorkspace = (await ready.workspace.list()).some((entry) => !isWorkspaceControlPlanePath(entry.path));
    if (!pristineBootstrap || !targetHasUserWorkspace) {
      await migrateWorkspaceState(prior.workspace, ready.workspace);
    }
    if (!pristineBootstrap) await migrateJournalState(prior.journal, ready.journal);

    const nextGitClient = new BrowserGitClient(
      await EncryptedWorkspaceGitAdapter.createFromCheckpoint(ready.workspace, gitCheckpoint, {
        // A new page starts from deterministic sample Git state. If the vault
        // already owns a checkpoint, load it. Checkpoints brought back from an
        // explicit Ephemeral detour carry a base and still reconcile via CAS.
        unbasedExisting: pristineBootstrap ? "load" : "conflict",
      }),
    );
    const journal = new EventJournal(ready.journal);
    const tools = await createAirshipToolRegistry({ workspace: ready.workspace, journal, git: nextGitClient });
    const nextRuntime: Runtime = {
      ...prior,
      workspace: ready.workspace,
      workspaceId: isGoogleDriveConfiguration(snapshot.config)
        ? `vault+gdrive://${snapshot.config.workspaceFolderId}/${snapshot.config.namespace}`
        : `vault+s3://${snapshot.config.bucket}/${snapshot.config.namespace}`,
      journal,
      tools,
    };
    const profile = await bindProfileToRuntime(activeProfile, nextRuntime);
    const nextCatalog = profile === activeProfile ? catalog : replaceProfile(catalog, profile);
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
      const messages = presentation.rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: messagePlainText(row.parts),
        parts: row.parts,
        ...(row.receipt ? { receipt: row.receipt } : {}),
        history: { turnStatus: row.turnStatus, providerContext: row.providerContext },
        sourcePoint: row.sourcePoint,
      } satisfies UiMessage));
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
    setGitClient(nextGitClient);
    setSlashRegistry(createSlashCommandRegistry({ tools }));
    setSessionLibrary(library);
    if (nextCatalog !== catalog) setCatalog(nextCatalog);
    setProfileId(profile.profileId);
    activateSession(nextSession);
    setMessages(resumedPresentation?.messages.length
      ? [...resumedPresentation.messages]
      : [{
          ...welcomeMessage,
          id: randomUuid(),
          content: resumableSession
            ? `Resumed ${resumableSession.title} from the encrypted Vault. ${welcomeMessage.content}`
            : "The verified Vault contract is now active. This new pinned session writes workspace files, explicit memories, task state, and session events as client-encrypted cloud objects; the previous page-memory sessions were migrated and remain separately inspectable.",
        }]);
    setEventCount(nextSession.headSequence);
    setSessionRevision((value) => value + 1);
    setLastReceipt(resumedPresentation?.lastReceipt);
    setSessionLifecycle(resumedPresentation?.lifecycle ?? READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(resumedPresentation?.boundary);
    await refreshWorkspaceState(ready.workspace, setFiles, setWorkspaceFiles);
    const vaultLabel = isGoogleDriveConfiguration(snapshot.config) ? "Encrypted Google Drive vault" : "Encrypted S3 vault";
    setRuntimeStatus(resumableSession ? `${vaultLabel} active · audited session resumed` : `${vaultLabel} active`);
  }

  async function adoptEphemeralRuntime(): Promise<void> {
    const prior = runtime.current;
    if (!prior || !catalog || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for an ephemeral transition.");
    }
    if (!prior.workspaceId.startsWith("vault+")) {
      vault.disconnect();
      return;
    }
    activeTurn.current?.abort(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus("Moving the active encrypted state into page memory");
    const { migrateJournalState, migrateWorkspaceState } = await loadDeferredCapabilities();
    const gitCheckpoint = await gitClient.exportCheckpoint();
    const workspace = new MemoryWorkspace();
    const journalBackend = new MemoryJournalBackend();
    await migrateWorkspaceState(prior.workspace, workspace);
    await migrateJournalState(prior.journal, journalBackend);

    const nextGitClient = new BrowserGitClient(await MemoryGitAdapter.restore(gitCheckpoint));
    const journal = new EventJournal(journalBackend);
    const tools = await createAirshipToolRegistry({ workspace, journal, git: nextGitClient });
    const nextRuntime: Runtime = {
      ...prior,
      workspace,
      workspaceId: "memory://airship-page",
      journal,
      tools,
    };
    const profile = await bindProfileToRuntime(activeProfile, nextRuntime);
    const nextCatalog = profile === activeProfile ? catalog : replaceProfile(catalog, profile);
    const nextSession = await createProfileSession(nextRuntime, profile, nextCatalog, `${profile.name} · ephemeral`);

    runtime.current = nextRuntime;
    setGitClient(nextGitClient);
    setSlashRegistry(createSlashCommandRegistry({ tools }));
    setSessionLibrary(new SessionLibrary(journal));
    if (nextCatalog !== catalog) setCatalog(nextCatalog);
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
    await refreshWorkspaceState(workspace, setFiles, setWorkspaceFiles);
    vault.disconnect();
    setRuntimeStatus("Ephemeral mode · page memory only");
  }

  async function changeVaultProvider(next: VaultBackend, desiredPreferences?: PreferenceOverrides): Promise<void> {
    if (vaultProviderSwitchingRef.current || next === preferences.vaultBackend) return;
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
        commitPreference: (provider) => setPreferences((current) => Object.freeze({ ...(desiredPreferences ?? current), vaultBackend: provider })),
      });
      setVaultSetupOpen(next !== "ephemeral");
      setRuntimeStatus(next === "google-drive"
        ? "Google Drive selected · connect your workspace"
        : next === "local-lab"
          ? "S3-compatible storage selected · configure the provider"
          : "Ephemeral mode · page memory only");
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : "Vault provider switch stopped safely");
    } finally {
      vaultProviderSwitchingRef.current = false;
      setVaultProviderSwitching(false);
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

  function clearAttestationEvidence(): void {
    attestationOperation.current += 1;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    providerCredential.current = undefined;
    setAttestationRecords([]);
    setAttestationFailure(undefined);
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
      // Chutes currently scopes E2E discovery as invoke, while the authenticated
      // evidence route can fall through to an unmatched `evidence:read` object.
      // Public hosted chutes permit an anonymous batch evidence read; selection
      // still requires the exact authenticated discovery instance and key.
      snapshot = await client.inspect({
        chuteId: args.chuteId,
        instanceId: args.instanceId,
        evidenceRoute: "public-chute",
        includePublishedPolicy: true,
        forceRefresh: args.forceRefresh,
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

  async function connectChutes(
    transport: ChutesInferenceTransport,
    model: AirshipModel,
    models: readonly AirshipModel[],
    credential: string,
    connectionMetadata: ActiveChutesConnection,
  ) {
    if (!runtime.current || !activeProfile || !catalog) throw new Error("The local runtime is not ready.");
    const parsedCredential = parseChutesCredential(credential);
    if (
      connectionMetadata.model !== model.id ||
      connectionMetadata.credentialKind !== parsedCredential.kind ||
      connectionMetadata.posture !== transport.posture ||
      !models.some((candidate) => candidate.id === model.id)
    ) {
      throw new Error("The selected model, transport posture, and credential metadata do not form one connection.");
    }
    activeTurn.current?.abort();
    setRuntimeStatus("Pinning encrypted Chutes session");
    const priorTransport = runtime.current.transport;
    const priorModel = runtime.current.model;
    runtime.current.transport = transport;
    runtime.current.model = model.id;
    let nextSession: SessionRecord;
    let nextProfile: ProfileRevision;
    try {
      nextProfile = await bindProfileToRuntime(activeProfile, runtime.current);
      nextSession = await createProfileSession(runtime.current, nextProfile, replaceProfile(catalog, nextProfile));
    } catch (error) {
      runtime.current.transport = priorTransport;
      runtime.current.model = priorModel;
      throw error;
    }
    setCatalog(replaceProfile(catalog, nextProfile));
    activateSession(nextSession);
    setSessionRevision((value) => value + 1);
    setMessages([
      {
        ...welcomeMessage,
        id: randomUuid(),
        content: `Connected to ${model.id} through Chutes E2EE v1 with a fail-closed proof gate. Before each encrypted invocation, Airship must locally accept fresh endpoint evidence and its key binding. Turn receipts show the evidence actually established; this connection policy alone is not proof.`,
      },
    ]);
    setEventCount(1);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    accountCredential.current = credential;
    await installAttestationEvidenceClient(credential, connectionMetadata.credentialKind);
    setAvailableModels(Object.freeze(models.slice()));
    setCredentialRevision((value) => value + 1);
    setInvocationTelemetry(undefined);
    setConnection(connectionMetadata);
    setRuntimeStatus("Encrypted session ready · endpoint proof required on every turn");
    navigate("chat");
  }

  async function disconnectChutes() {
    if (!runtime.current || !activeProfile || !catalog) return;
    activeTurn.current?.abort();
    const priorTransport = runtime.current.transport;
    const priorModel = runtime.current.model;
    runtime.current.transport = new DemoInferenceTransport();
    runtime.current.model = "airship/demo-v1";
    let nextSession: SessionRecord;
    let nextProfile: ProfileRevision;
    try {
      nextProfile = await bindProfileToRuntime(activeProfile, runtime.current);
      nextSession = await createProfileSession(runtime.current, nextProfile, replaceProfile(catalog, nextProfile));
    } catch (error) {
      runtime.current.transport = priorTransport;
      runtime.current.model = priorModel;
      throw error;
    }
    setCatalog(replaceProfile(catalog, nextProfile));
    activateSession(nextSession);
    setSessionRevision((value) => value + 1);
    setMessages([{ ...welcomeMessage, id: randomUuid() }]);
    setEventCount(1);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    oauthTokens.current = undefined;
    pendingOAuthCredential.current = undefined;
    accountCredential.current = undefined;
    clearAttestationEvidence();
    setAvailableModels([]);
    setCredentialRevision((value) => value + 1);
    setOauthTokenRevision((value) => value + 1);
    setInvocationTelemetry(undefined);
    setConnection(DISCONNECTED_CHUTES_CONNECTION);
    setRuntimeStatus("Local kernel ready");
  }

  async function switchChutesModel(modelId: string): Promise<void> {
    if (!runtime.current || !activeProfile || !catalog || !isChutesConnected(connection)) {
      throw new Error("Connect Chutes before selecting a remote model.");
    }
    const model = availableModels.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("The selected model is not in the active authoritative Chutes catalog snapshot.");
    if (model.id === connection.model) return;

    setModelSwitching(true);
    setRuntimeStatus("Forking a model-pinned session");
    activeTurn.current?.abort();
    const priorModel = runtime.current.model;
    runtime.current.model = model.id;
    let nextSession: SessionRecord;
    let nextProfile: ProfileRevision;
    try {
      nextProfile = await bindProfileToRuntime(activeProfile, runtime.current);
      const nextCatalog = replaceProfile(catalog, nextProfile);
      nextSession = await createProfileSession(runtime.current, nextProfile, nextCatalog);
      setCatalog(nextCatalog);
    } catch (error) {
      runtime.current.model = priorModel;
      setRuntimeStatus("Model switch failed safely");
      throw error;
    } finally {
      setModelSwitching(false);
    }

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
    setConnection(withChutesModel(connection, model.id));
    setRuntimeStatus("Encrypted session ready · endpoint proof required on next turn");
  }

  async function saveProfileRevision(draft: ProfileEditorDraft): Promise<ProfileRevision> {
    if (!catalog) throw new Error("The profile catalog is not ready.");
    const current = catalog.profiles.find((profile) => profile.profileId === draft.profileId);
    const theme = catalog.themes.find((candidate) => candidate.themeId === draft.themeId);
    if (!current || !theme) throw new Error("The selected profile or theme no longer exists.");
    const revision = await createProfileRevision({
      profileId: current.profileId,
      parentRevision: current.revision,
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      providerId: current.providerId,
      model: current.model,
      minimumPosture: current.minimumPosture,
      theme: { themeId: theme.themeId, digest: theme.digest },
      skillModes: current.skillModes,
      createdAt: new Date().toISOString(),
    });
    setCatalog(replaceProfile(catalog, revision));
    setRuntimeStatus(current.profileId === profileId ? "Profile revised; active session remains pinned" : "Profile revision saved in page memory");
    return revision;
  }

  async function forkProfile(source: ProfileRevision): Promise<ProfileRevision> {
    if (!catalog) throw new Error("The profile catalog is not ready.");
    const profileId = `${slugIdentifier(source.name)}-${randomUuid().slice(0, 6).toLowerCase()}`;
    const fork = await createProfileRevision({
      profileId,
      parentRevision: source.revision,
      name: `${source.name} Copy`,
      description: source.description,
      systemPrompt: source.systemPrompt,
      providerId: source.providerId,
      model: source.model,
      minimumPosture: source.minimumPosture,
      theme: source.theme,
      skillModes: source.skillModes,
      createdAt: new Date().toISOString(),
    });
    setCatalog(Object.freeze({ ...catalog, profiles: Object.freeze([...catalog.profiles, fork]) }));
    setRuntimeStatus("Profile forked in page memory");
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
    setCatalog((current) => current ? archiveProfileRevision(current, profileIdToDelete) : current);
    setRuntimeStatus("Profile archived from new work; historical conversations retain their pinned manifest and receipts");
  }

  function setGlobalSkill(skillId: string, enabled: boolean) {
    if (!catalog) return;
    setCatalog(Object.freeze({
      ...catalog,
      globalSkills: createGlobalSkillSettings({ ...catalog.globalSkills, [skillId]: enabled }),
    }));
    setRuntimeStatus("Global skill policy revised; existing sessions remain pinned");
  }

  async function setProfileSkill(profileIdToEdit: string, skillId: string, mode: SkillMode) {
    if (!catalog) return;
    const profile = catalog.profiles.find((candidate) => candidate.profileId === profileIdToEdit);
    if (!profile) return;
    const revision = await createProfileRevision({
      ...profile,
      parentRevision: profile.revision,
      skillModes: { ...profile.skillModes, [skillId]: mode },
      createdAt: new Date().toISOString(),
    });
    setCatalog(replaceProfile(catalog, revision));
    setRuntimeStatus("Profile skill policy revised; existing sessions remain pinned");
  }

  async function loadBillingSnapshot(signal: AbortSignal) {
    if (!online) throw new Error(OFFLINE_INLINE_REASON);
    const credential = accountCredential.current;
    if (!credential || !isChutesConnected(connection)) {
      throw new Error("A connected Chutes credential is required for account telemetry.");
    }
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
    if (!sessionLibrary || !sessionRuntime || !catalog) throw new Error("The session runtime is not ready.");
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
      ? presentation.rows.map((row) => ({
          id: row.id,
          role: row.role,
          content: messagePlainText(row.parts),
          parts: row.parts,
          ...(row.receipt ? { receipt: row.receipt } : {}),
          history: {
            turnStatus: row.turnStatus,
            providerContext: row.providerContext,
          },
          sourcePoint: row.sourcePoint,
        }))
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
  }

  async function activateForkedSession(result: SessionForkResult): Promise<void> {
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
  const platformOverlayOpen = mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen;
  const sessionDurability = vaultRuntimeAdopted
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
      <header class="topbar" inert={platformOverlayOpen} aria-hidden={platformOverlayOpen || undefined}>
        <button class="brand" type="button" onClick={() => navigate("chat")} aria-label="Open session">
          <Seal class="brand-seal" state="asserted" label="Airship mark" detail="Airship edge runtime" size={25} compact />
          <span class="brand-name">Airship</span>
          <span class="edition">edge runtime</span>
        </button>
        <TabPresenceNote />
        <div class="topbar-center" aria-label="Runtime state">
          <StatusSeal state="none" origin="local" label="Local runtime" detail="The agent kernel is executing in this browser; no remote proof is implied." onClick={() => openSessionProof()} />
          <StatusSeal
            state={vaultSnapshot.phase === "ready"
              ? "verified"
              : vaultSnapshot.phase === "probing"
                ? "checking"
                : vaultSnapshot.phase === "configured"
                  ? "asserted"
                  : vaultSnapshot.phase === "degraded"
                    ? "failed"
                    : "none"}
            label={vaultSnapshot.phase === "ready" ? "Vault ready" : vaultSnapshot.phase === "probing" ? "Vault testing" : vaultSnapshot.phase === "configured" ? "Vault configured" : vaultSnapshot.phase === "degraded" ? "Vault blocked" : "Ephemeral"}
            detail={vaultSnapshot.phase === "ready" ? "Storage contract passed; synchronization was not evaluated" : vaultSnapshot.message}
            onClick={() => navigate("vault")}
          />
          <StatusSeal
            state={chutesConnected ? (connection.invokeAuthorization === "verified" ? "verified" : "asserted") : "none"}
            label={chutesConnected ? (connection.invokeAuthorization === "verified" ? "E2EE used" : "E2EE ready") : "Inference local"}
            detail={chutesConnected ? (connection.invokeAuthorization === "verified" ? "Protected invocation succeeded" : "Provider permission not tested yet") : "No Chutes credential configured"}
            onClick={() => navigate("access")}
          />
          <StatusSeal
            state={attestationSeal.state}
            label={attestationSeal.label}
            detail={attestationSeal.detail}
            onClick={() => openAttestationEvidence()}
          />
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
        <nav class="primary-nav" aria-label="Primary">
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
                        class={session.id === sessionId ? "recent-conversation active" : "recent-conversation"}
                        type="button"
                        title={session.title}
                        aria-current={session.id === sessionId ? "page" : undefined}
                        onClick={session.open}
                      ><span aria-hidden="true">{session.id === sessionId ? "●" : "○"}</span><span>{session.title}</span></button>)}
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
                      {profileOptions.map((profile) => <button key={profile.profileId} class={profile.profileId === profileId ? "recent-conversation active" : "recent-conversation"} type="button" title={`Open ${profile.name} in the profile manager`} onClick={() => { setProfileHubScope(profile.profileId); navigate("profiles"); }}><span class="profile-monogram" aria-hidden="true">{profileMonogram(profile.name)}</span><span>{profile.name}</span></button>)}
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
          ? "main chat-layout"
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
                <div class="stage-header-model">
                  <ModelControl
                    connection={connection}
                    models={availableModels}
                    busy={busy || modelSwitching}
                    onSelect={switchChutesModel}
                    onOpenConnection={() => navigate("access")}
                  />
                </div>
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
                    <span>{eventCount} page-journal event{eventCount === 1 ? "" : "s"}</span>
                    <button class="session-id" type="button" title="Open conversation details" onClick={() => navigate("sessions")}>#{sessionId ? sessionId.slice(0, 8) : "starting"}</button>
                  </div>
                </div>
              </div>
              {!chutesConnected ? <div class="chat-live-guidance" role="note">
                <span><strong>Local tools ready.</strong> Slash commands work here. Connect Chutes by OAuth or API key for live E2EE.</span>
                <button type="button" onClick={() => navigate("access")}>Connect Chutes</button>
              </div> : null}
              <div
                ref={transcriptElement}
                class="transcript"
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
                      streamStore={transcriptStreams}
                    />
                  </div>
                ))}
                {messages.length <= 1 ? (
                  <div class="transcript-starters" role="group" aria-label="Suggested ways to begin">
                    {STARTER_PROMPTS.map((starter) => (
                      <button
                        type="button"
                        key={starter.title}
                        class="starter-chip"
                        onClick={() => {
                          setInput(starter.prompt);
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
                <div class={busy ? "composer busy" : "composer"}>
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
                  {attachments.length ? <div class="composer-attachments" aria-label="Pending attachments">
                    {attachments.map((attachment) => <span key={attachment.id}>{attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <Icon name="file" size={14} />}<span>{attachment.name}</span><small>{imageInputCapability === "supported" ? "encrypted vision ready" : "vision model required"}</small><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => { if (attachment.previewUrl) { URL.revokeObjectURL(attachment.previewUrl); attachmentPreviewUrls.current.delete(attachment.previewUrl); } setAttachments((current) => current.filter((item) => item.id !== attachment.id)); }}>×</button></span>)}
                  </div> : null}
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
                      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && busy) {
                        event.preventDefault();
                        setComposerNotice("Agent is busy. Stop the current turn or wait before sending another prompt.");
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
                      <label class="composer-attach"><input type="file" accept="image/*" multiple onChange={(event) => { addComposerFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} /><Icon name="plus" size={14} /><span>Attach image</span></label>
                      <span><Icon name="lock" size={14} /> {chutesConnected ? "credential in memory" : "page memory only"}</span>
                      <span class={`composer-policy policy-${preferences.approvalMode}`}><span class="composer-policy__dot" aria-hidden="true" /><Icon name="check" size={14} /> {approvalModeLabel(preferences.approvalMode)}</span>
                    </div>
                    {busy ? (
                      <button class="send-button stop" type="button" onClick={stopTurn} aria-label="Stop turn"><Icon name="stop" /></button>
                    ) : (
                      <button
                        class="send-button"
                        type="button"
                        onClick={() => void sendMessage()}
                        disabled={!input.trim() || !sessionId || composerOfflineBlocked}
                        aria-label={composerOfflineBlocked ? "Send unavailable while remote inference is offline" : "Send message"}
                        title={composerOfflineBlocked ? "Remote inference is paused offline. Local slash commands remain available." : undefined}
                      ><Icon name="send" /></button>
                    )}
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
            <aside class="inspector"><ProofInspector
              receipt={lastReceipt}
              endpointRecord={lastReceipt ? attestationRecords.find((record) => attestationRecordMatchesReceipt(record, lastReceipt)) : undefined}
              now={attestationNow}
              compact
              onOpenAttestations={() => openAttestationEvidence()}
            /></aside>
          </>
        ) : null}
        {view === "sessions" && sessionLibrary ? SessionsScreen ? (
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
        ) : <RouteSkeleton label="Loading session library" /> : null}
        {(view === "workspace" || view === "editor") && runtime.current && gitClient ? EditorScreen ? <EditorScreen
          files={files}
          selected={selectedFile}
          onOpen={openFile}
          workspace={runtime.current.workspace}
          git={gitClient}
          review={reviewGitOperation}
          reviewImport={reviewSourceImport}
          onWorkspaceChanged={() => runtime.current ? refreshWorkspaceState(runtime.current.workspace, setFiles, setWorkspaceFiles) : undefined}
          durability={sessionDurability}
        /> : editorViewError ? <section class="work-view panel" role="alert"><h1>Editor</h1><p>{editorViewError}</p></section> : <RouteSkeleton label="Loading the browser-native Workspace Editor" /> : null}
        {view === "terminal" && runtime.current ? TerminalScreen ? <TerminalScreen
          workspace={runtime.current.workspace}
          threadId={sessionId}
          workspaceRoot="/workspace"
        /> : terminalViewError ? <section class="work-view panel" role="alert"><h1>Terminal</h1><p>{terminalViewError}</p></section> : <RouteSkeleton label="Loading the browser terminal" /> : null}
        {view === "memory" || view === "context" ? (
          <MemoryView
            sessionId={sessionId}
            messages={messages}
            files={workspaceFiles}
            catalog={catalog}
            activeProfile={activeProfile}
            workspace={runtime.current?.workspace}
            initialTab={view === "context" ? "index" : "search"}
          />
        ) : null}
        {view === "profiles" || view === "capabilities" || view === "skills" ? <div class="profile-hub-tabs" role="tablist" aria-label="Profile manager views">
          {([{"id":"profiles","label":"Profile"},{"id":"capabilities","label":"Capabilities"},{"id":"skills","label":"Skills"}] as const).map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => navigate(tab.id)}>{tab.label}</button>)}
          <div class="profile-hub-scope"><span>Scope</span><MenuSelect placement="down" ariaLabel="Profile manager scope" value={profileHubScope} options={[{ value: "global", label: "Global" }, ...managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name }))]} onChange={setProfileHubScope} /></div>
        </div> : null}
        {view === "profiles" ? (
          <ProfileManagerView
            catalog={catalog}
            activeProfileId={profileId}
            onActivate={(id) => changeProfile(id, true)}
            onSave={saveProfileRevision}
            onFork={forkProfile}
            onDelete={deleteProfile}
            selectedProfileId={profileHubScope === "global" ? undefined : profileHubScope}
          />
        ) : null}
        {view === "capabilities" ? CapabilitiesScreen ? (
          <><div class="profile-scope-contract" role="note"><strong>{profileHubScope === "global" ? "Global runtime availability" : `${managedProfiles(catalog).find((profile) => profile.profileId === profileHubScope)?.name ?? "Profile"} runtime view`}</strong><span>Availability is measured and read-only. Airship has no separate tool-exposure policy API in this runtime, so this screen does not offer decorative toggles. Approval and skill instructions remain distinct controls.</span></div><CapabilitiesScreen inspect={inspectExecutionCapabilities} onCommand={openCapabilityCommand} onOpenSkills={() => navigate("skills")} /></>
        ) : capabilitiesViewError ? <section class="work-view panel" role="alert"><h1>Capabilities</h1><p>{capabilitiesViewError}</p></section> : <RouteSkeleton label="Inspecting browser capabilities" /> : null}
        {view === "skills" ? (
          <SkillsManagerView
            catalog={catalog}
            activeProfileId={profileId}
            onSetGlobal={setGlobalSkill}
            onSetProfile={setProfileSkill}
            onApply={(id) => changeProfile(id, true)}
            scope={profileHubScope}
          />
        ) : null}
        {view === "vault" ? (
          <div class="work-view">
            {VaultScreen ? <VaultScreen
              snapshot={vaultSnapshot}
              runtimeAdopted={vaultRuntimeAdopted}
              provider={preferences.vaultBackend}
              providerSwitching={vaultProviderSwitching}
              onProviderChange={(provider) => void changeVaultProvider(provider)}
              onOpenSetup={preferences.vaultBackend === "ephemeral" ? undefined : () => setVaultSetupOpen((open) => !open)}
              onProbe={vaultSnapshot.phase === "disconnected" ? undefined : () => void probeVault()}
              onCancelProbe={vaultSnapshot.phase === "probing" ? () => {
                vault.cancelProbe();
                setRuntimeStatus("Vault probe cancelled; readiness claim cleared");
              } : undefined}
              onDisconnect={vaultSnapshot.phase === "disconnected" ? undefined : () => {
                vault.disconnect();
                setRuntimeStatus("Vault disconnected and page-memory key material cleared");
              }}
            /> : vaultViewError ? <section class="panel" role="alert"><h1>Vault</h1><p>{vaultViewError}</p></section> : <RouteSkeleton label="Loading the Vault interface" />}
            {(vaultSetupOpen || (preferences.vaultBackend === "google-drive" && vaultSnapshot.phase === "disconnected")) ? (
              <div class="vault-setup-slot">
                {preferences.vaultBackend === "google-drive" ? GoogleDriveSetupScreen ? <GoogleDriveSetupScreen onConfigure={(request) => {
                  vault.configureGoogleDrive(request);
                  setVaultSetupOpen(false);
                  setRuntimeStatus("Google Drive connected in page memory; verifying encrypted range storage");
                  void vault.probe({ acknowledgeImmutableProbeObjects: true }).then((result) => {
                    setRuntimeStatus(result.phase === "ready"
                      ? "Google Drive vault verified; adopting encrypted storage"
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
        {view === "proof" ? (
          <ProofView
            receipt={proofReceipt}
            endpointRecord={proofReceipt ? attestationRecords.find((record) => attestationRecordMatchesReceipt(record, proofReceipt)) : undefined}
            attestationNow={attestationNow}
            eventCount={proofTargetId === sessionId ? eventCount : sessionRevision}
            sessionId={proofTargetId}
            requestedReceiptId={proofSelection?.receiptId}
            loadAudit={loadSessionAudit}
            section={proofSection}
            onSectionChange={(section) => {
              setProofSection(section);
              navigate("proof", proofHash(proofSelection, section));
            }}
            evidenceLedger={AttestationsScreen ? <AttestationsScreen
              endpointRecords={attestationRecords}
              receipts={attestationReceipts}
              selectedRecordId={selectedAttestationRecordId}
              onSelectRecord={(recordId) => setSelectedAttestationRecordId(recordId)}
              acquisitionNotice={!online ? OFFLINE_INLINE_REASON : attestationFailure ? `${attestationFailure.label}. Current endpoint evidence was not accepted, and no TEE claim was inferred.` : undefined}
              onRefresh={online && chutesConnected ? refreshAttestation : undefined}
              onCancel={() => attestationClient.current?.cancel()}
              embedded
            /> : attestationsViewError ? <div class="panel" role="alert">{attestationsViewError}</div> : <RouteSkeleton label="Loading attestation evidence" />}
          />
        ) : null}
        {view === "access" ? AccessScreen ? (
          <AccessScreen
            connection={connection}
            online={online}
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
          />
        ) : accessViewError ? <section class="work-view panel" role="alert"><h1>Connection</h1><p>{accessViewError}</p></section> : <RouteSkeleton label="Loading Connection" /> : null}
      </main>
      </ViewErrorBoundary>

      <MobileNavigation
        view={view}
        moreOpen={mobileMoreOpen}
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
        if (next.vaultBackend !== preferences.vaultBackend) void changeVaultProvider(next.vaultBackend, next);
        else setPreferences(next);
      }} onClose={() => setPreferencesOpen(false)} />
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
  const pin = await resolveProfileForSession({
    profile,
    theme,
    skills: catalog.skills,
    globalSkills: catalog.globalSkills,
  });
  if (pin.providerId !== runtime.transport.id || pin.model !== runtime.model) {
    throw new Error("The profile runtime binding changed. Create a new profile revision before starting its session.");
  }
  if (!postureSatisfies(runtime.transport.posture, pin.minimumPosture)) {
    throw new Error(`The ${runtime.transport.posture} runtime does not satisfy this profile's ${pin.minimumPosture} minimum posture.`);
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
    tools: runtime.tools.definitions(),
    workspaceId: runtime.workspaceId,
    capabilityTier: "web-enhanced",
    securityPosture: runtime.transport.posture,
    profile: {
      version: 1,
      profileId: pin.profile.profileId,
      profileRevision: pin.profile.revision,
      themeId: pin.theme.themeId,
      themeDigest: pin.theme.digest,
      resolvedSkills: pin.resolvedSkills.map((skill) => ({ ...skill })),
      skillSetDigest: pin.skillSetDigest,
      resolutionDigest: pin.resolutionDigest,
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
    && actual.securityPosture === expected.securityPosture
    && actual.capabilityTier === expected.capabilityTier
    && actual.systemPromptDigest === expected.systemPromptDigest
    && actual.toolManifestDigest === expected.toolManifestDigest
    && actualProfile?.profileId === expectedProfile?.profileId
    && actualProfile?.profileRevision === expectedProfile?.profileRevision
    && actualProfile?.themeDigest === expectedProfile?.themeDigest
    && actualProfile?.skillSetDigest === expectedProfile?.skillSetDigest
    && actualProfile?.resolutionDigest === expectedProfile?.resolutionDigest;
}

function activeSessionRuntime(runtime: Runtime, session: SessionRecord): ActiveSessionRuntime {
  const profile = session.manifest.profile;
  return Object.freeze({
    providerId: runtime.transport.id,
    model: runtime.model,
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
  if (profile.providerId === runtime.transport.id && profile.model === runtime.model) return profile;
  return createProfileRevision({
    ...profile,
    parentRevision: profile.revision,
    providerId: runtime.transport.id,
    model: runtime.model,
    createdAt: new Date().toISOString(),
  });
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
  const entries = (await workspace.list()).filter((entry) =>
    !entry.path.startsWith("/workspace/.airship/git/"),
  );
  setEntries(entries);
  // Refresh is metadata-only. Content is read only after an explicit open;
  // indexing has its own bounded, demand-driven workspace port.
  setMemoryFiles(entries.slice(0, 2_000));
}

async function isPristineBootstrapRuntime(runtime: Runtime): Promise<boolean> {
  const expected = new Map<string, string>([
    ["/workspace/README.md", AIRSHIP_WORKSPACE_GUIDE],
    ["/workspace/docs/architecture.md", "The browser owns orchestration. Chutes owns inference. Encrypted object storage owns durable state."],
    ["/workspace/notes/retrieval.md", "Context experts are selected by directory, Git, profile, and task focus."],
  ]);
  const [entries, sessions] = await Promise.all([
    runtime.workspace.list(),
    runtime.journal.listSessions(),
  ]);
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
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("The saved Chutes authorization attempt is invalid.");
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.verifier !== "string" ||
    typeof candidate.redirectUri !== "string" ||
    typeof candidate.createdAt !== "number"
  ) {
    throw new Error("The saved Chutes authorization attempt is incomplete.");
  }
  return {
    state: candidate.state,
    verifier: candidate.verifier,
    redirectUri: candidate.redirectUri,
    createdAt: candidate.createdAt,
  };
}

function oauthPublicClientError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Chutes sign-in could not be completed.";
  if (message.includes("invalid_client")) {
    return "OAuth client rejected. Retry through the configured local bridge.";
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

function profileMonogram(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean);
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

function StatusSeal({ state, label, detail, origin, onClick }: { state: SealState; label: string; detail: string; origin?: "local" | "remote"; onClick(): void }) {
  return <button class="status-seal" type="button" data-state={state} onClick={onClick}><Seal state={state} origin={origin} acting={state === "checking"} label={label} detail={detail} size={16} /></button>;
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
    ? {
        state: "asserted",
        label: "Proof required next turn",
        detail: "The fail-closed endpoint-proof policy is armed, but no active turn receipt currently establishes a hardware claim.",
      }
    : { state: "none", label: "TEE not checked", detail: "Demo provider" };
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
    label: "TEE evidence pending",
    detail: "Airship has not accepted endpoint evidence for this receipt.",
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
  onProof,
  onAttestations,
  attestation,
  onCopy,
  onRetry,
  onEdit,
  onBranch,
  streamStore,
}: {
  message: UiMessage;
  onProof: () => void;
  onAttestations: () => void;
  attestation?: MessageAttestation;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onBranch: () => void;
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
          {message.status ? <span class="message-status"><span class="pulse-dot" />{message.status}</span> : null}
        </div>
        {message.parts?.length ? (
          <MessagePartsView
            parts={message.parts}
          />
        ) : <p>{message.content || " "}</p>}
        <StreamingMessageSlot store={streamStore} messageId={message.id} active={message.status !== undefined} />
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
        <details class="message-actions">
          <summary aria-label="Open message actions">••• <span>Actions</span></summary>
          <div aria-label="Message actions">
            <button type="button" onClick={onCopy}>Copy</button>
            {message.role === "assistant" && message.error && message.originatingPrompt ? <button type="button" onClick={onRetry}>Retry</button> : null}
            {message.role === "user" ? <button type="button" onClick={onEdit}>Edit &amp; resend</button> : null}
            <button type="button" onClick={onBranch}><Icon name="branch" size={14} /> Fork session</button>
          </div>
        </details>
      </div>
    </article>
  );
}

function ProfileManagerView({
  catalog,
  activeProfileId,
  onActivate,
  onSave,
  onFork,
  onDelete,
  selectedProfileId,
}: {
  catalog: ProfileCatalog;
  activeProfileId: string;
  onActivate: (profileId: string) => Promise<void>;
  onSave: (draft: ProfileEditorDraft) => Promise<ProfileRevision>;
  onFork: (profile: ProfileRevision) => Promise<ProfileRevision>;
  onDelete: (profileId: string, replacementProfileId?: string) => Promise<void>;
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
      setStatus("Revision saved in page memory. Existing sessions remain pinned.");
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
      setStatus("Independent profile fork created in page memory.");
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
              <button key={profile.profileId} class={profile.profileId === selected.profileId ? "profile-card active" : "profile-card"} type="button" onClick={() => { if (!dirty || window.confirm("Discard unsaved profile edits?")) { setStatus(undefined); setSelectedId(profile.profileId); } }}>
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
            <label><span>System instructions</span><textarea rows={7} value={draft.systemPrompt} onInput={(event) => setDraft({ ...draft, systemPrompt: event.currentTarget.value })} /></label>
            <div class="theme-manager">
              <div><span class="field-label">Interface theme</span><small>Fixed semantic tokens only—no arbitrary CSS or remote assets.</small></div>
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
            <div class="revision-strip">
              <span><small>Runtime</small>{selected.providerId} · {selected.model}</span>
              <span><PostureChip posture={selected.minimumPosture} prefix="Trust floor" /></span>
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
            <div class="profile-archive-zone">
              <div><strong>Remove from new work</strong><p>The immutable revision is retained for existing conversations, receipts, audits, and resume. It disappears only from profile pickers and new conversations.</p></div>
              {selected.profileId === activeProfileId ? <label><span>Activate replacement first</span><MenuSelect placement="up" ariaLabel="Replacement profile" value={replacementProfileId} options={[{ value: "", label: "Choose replacement" }, ...profiles.filter((profile) => profile.profileId !== selected.profileId).map((profile) => ({ value: profile.profileId, label: profile.name }))]} onChange={setReplacementProfileId} /></label> : null}
              <button class="small-button danger" type="button" disabled={busy || profiles.length <= 1 || (selected.profileId === activeProfileId && !replacementProfileId)} onClick={() => void archive()}>{profiles.length <= 1 ? "Only profile cannot be removed" : "Remove profile"}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="callout"><Icon name="cloud" /><div><strong>Page-memory manager</strong><p>This milestone keeps profile changes only for the page lifetime. The manifests are already content-addressed and ready for encrypted S3 generations; the UI does not claim they are synced yet.</p></div></div>
    </section>
  );
}

function SkillsManagerView({
  catalog,
  activeProfileId,
  onSetGlobal,
  onSetProfile,
  onApply,
  scope,
}: {
  catalog: ProfileCatalog;
  activeProfileId: string;
  onSetGlobal: (skillId: string, enabled: boolean) => void;
  onSetProfile: (profileId: string, skillId: string, mode: SkillMode) => Promise<void>;
  onApply: (profileId: string) => Promise<void>;
  scope: string;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState(activeProfileId);
  const profiles = useMemo(() => managedProfiles(catalog), [catalog]);
  const scopedProfileId = scope === "global" ? selectedProfileId : scope;
  const profile = profiles.find((candidate) => candidate.profileId === scopedProfileId) ?? profiles[0]!;

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
                {scope === "global" ? <button class={globalEnabled ? "toggle-control on" : "toggle-control"} role="switch" aria-checked={globalEnabled} type="button" onClick={() => onSetGlobal(skill.skillId, !globalEnabled)}><span /> Global default</button> : <div class="skill-select-field"><span>{profile.name}</span><MenuSelect placement="down" ariaLabel={`${profile.name} mode for ${skill.name}`} value={mode} options={[{ value: "inherit", label: "Inherit global" }, { value: "on", label: "Always on" }, { value: "off", label: "Always off" }]} onChange={(next) => void onSetProfile(profile.profileId, skill.skillId, next as SkillMode)} /></div>}
              </div>
              <footer><span>{skill.requiredTools.length ? `Instructions reference: ${skill.requiredTools.join(" · ")}` : "Instruction-only"}<br />Enable pins instructions only; tools remain approval-gated.</span><code>{skill.digest.slice(-9)}</code></footer>
            </article>
          );
        })}
      </div>
      <div class="callout"><Icon name="lock" /><div><strong>No session mutation</strong><p>Switches revise future resolution only. A running conversation keeps its original prompt and skill-set digests until you explicitly fork it.</p></div></div>
    </section>
  );
}

function MemoryView({
  sessionId,
  messages,
  files,
  catalog,
  activeProfile,
  workspace,
  initialTab,
}: {
  sessionId?: string;
  messages: UiMessage[];
  files: WorkspaceEntry[];
  catalog: ProfileCatalog;
  activeProfile: ProfileRevision;
  workspace?: WorkspacePort;
  initialTab: "search" | "index";
}) {
  const graph = useMemo(() => deriveMemoryRelationshipGraph({
    sessions: sessionId ? [{
      id: sessionId,
      title: `${activeProfile.name} session`,
      profileId: activeProfile.profileId,
      skillIds: effectiveSkillIds(activeProfile, catalog),
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.parts?.length ? messagePlainText(message.parts) : message.content,
        profileId: activeProfile.profileId,
        skillIds: effectiveSkillIds(activeProfile, catalog),
      })),
    }] : [],
    workspaceFiles: files,
    profiles: catalog.profiles.map((profile) => ({
      id: profile.profileId,
      name: profile.name,
      role: profile.description,
      prompt: profile.systemPrompt,
      skillIds: effectiveSkillIds(profile, catalog),
    })),
    skills: catalog.skills.map((skill) => ({
      id: skill.skillId,
      name: skill.name,
      description: skill.description,
      profileIds: catalog.profiles.filter((profile) => effectiveSkillIds(profile, catalog).includes(skill.skillId)).map((profile) => profile.profileId),
      sessionIds: sessionId && effectiveSkillIds(activeProfile, catalog).includes(skill.skillId) ? [sessionId] : [],
    })),
  }), [activeProfile, catalog, files, messages, sessionId]);
  const [query, setQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [hiddenMemoryKinds, setHiddenMemoryKinds] = useState<ReadonlySet<import("../memory-graph").MemoryNodeKind>>(() => new Set());
  const [hiddenMemoryNodeIds, setHiddenMemoryNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [relationshipLimit, setRelationshipLimit] = useState(18);
  const [tab, setTab] = useState<"search" | "graph" | "index">(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => setRelationshipLimit(18), [selectedNodeId]);
  const results = query.trim() ? graph.search(query, { limit: 12 }) : [];
  const selectedNode = selectedNodeId ? graph.getNode(selectedNodeId) : undefined;
  const selectedEdges = selectedNodeId ? graph.getIncidentEdges(selectedNodeId) : [];
  const relationshipGroups = groupMemoryRelationships(selectedEdges, relationshipLimit);
  const truncationCount = Object.values(graph.stats.truncated).reduce((total, value) => total + value, 0);
  const selectMemoryNode = (nodeId: string | undefined) => { if (nodeId) setHiddenMemoryNodeIds((current) => { if (!current.has(nodeId)) return current; const next = new Set(current); next.delete(nodeId); return next; }); setSelectedNodeId(nodeId); };

  return (
    <section class="work-view memory-view">
      <PageHeading eyebrow="Private recall & on-device retrieval" title="Memory" description="Search the active conversation, its profile memory, and the shared workspace index from one client-owned surface; inspect relationships and index lineage without creating a second source of truth." />
      <div class="memory-mode-tabs" role="tablist" aria-label="Memory views">
        {(["search", "graph", "index"] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={tab === mode} onClick={() => setTab(mode)}>{mode[0]?.toUpperCase()}{mode.slice(1)}</button>)}
      </div>
      {tab === "search" ? <FederatedMemorySearch messages={messages} files={files} profile={activeProfile} /> : null}
      {tab === "graph" ? <>
      <div class="memory-metrics">
        <div class="metric"><span>Nodes</span><strong>{graph.stats.nodeCount}</strong><small>real page inputs + derived terms</small></div>
        <div class="metric"><span>Relationships</span><strong>{graph.stats.edgeCount}</strong><small>typed, bounded edges</small></div>
        <div class="metric"><span>Components</span><strong>{graph.stats.componentCount}</strong><small>current relationship islands</small></div>
        <div class="metric"><span>Density</span><strong>{formatGraphDensity(graph)}</strong><small>not vector similarity</small></div>
      </div>
      <div class={truncationCount ? "memory-boundary attention" : "memory-boundary"} role="status"><strong>{truncationCount ? "Bounded memory view" : "Memory view within bounds"}</strong><span>{truncationCount ? `${truncationCount} source or derived items were omitted by client limits. ` : "No configured derivation bound was reached. "}{graph.stats.isolatedNodeCount} isolated nodes · maximum degree {graph.stats.maxDegree} · {hiddenMemoryNodeIds.size} individually hidden. View filters never alter source memory.</span></div>
      <div class="memory-shell">
        <div class="memory-graph-panel panel">
          <div class="memory-toolbar">
            <MemorySearch query={query} results={results} onQuery={setQuery} onSelect={selectMemoryNode} />
            <span>{graph.revision.slice(-9)}</span>
          </div>
          <MemoryGraphRenderer graph={graph} hiddenKinds={hiddenMemoryKinds} hiddenNodeIds={hiddenMemoryNodeIds} selectedNodeId={selectedNodeId} onSelect={(selection) => selectMemoryNode(selection?.focus?.id)} class="memory-canvas" minHeight={470} ariaLabel="Interactive memory relationship graph" />
          <MemoryKindLegend counts={graph.stats.nodesByKind} hidden={hiddenMemoryKinds} onToggle={(kind) => setHiddenMemoryKinds((current) => { const next = new Set(current); next.has(kind) ? next.delete(kind) : next.add(kind); return next; })} />
        </div>
        <aside class="memory-detail panel">
          <div class="panel-heading"><span>Relationship inspector</span><span>{selectedNode ? selectedNode.kind : "select a node"}</span></div>
          {selectedNode ? (
            <div class="memory-node-detail">
              <span class="eyebrow">{selectedNode.kind}</span>
              <h2>{selectedNode.label}</h2>
              <p>{selectedNode.summary || "No additional summary is present for this node."}</p>
              <button class="small-button" type="button" onClick={() => { setHiddenMemoryNodeIds((current) => new Set(current).add(selectedNode.id)); setSelectedNodeId(undefined); }}>Hide from view</button>
              <dl>{Object.entries(selectedNode.metadata).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
              <h3>{selectedEdges.length} relationships</h3>
              <div class="relationship-groups">{relationshipGroups.map((group) => <section key={group.kind} aria-labelledby={`relationship-${group.kind}`}><h4 id={`relationship-${group.kind}`}>{group.label}<small>{group.edges.length} shown · {group.total} total</small></h4><div class="relationship-list">{group.edges.map((edge) => {
                const neighborId = edge.source === selectedNode.id ? edge.target : edge.source;
                const neighbor = graph.getNode(neighborId);
                return <button key={edge.id} type="button" onClick={() => selectMemoryNode(neighborId)}><span>{edge.label}</span><strong>{neighbor?.label ?? neighborId}</strong></button>;
              })}</div></section>)}</div>
              {selectedEdges.length > relationshipLimit ? <button class="small-button" type="button" onClick={() => setRelationshipLimit((value) => Math.min(selectedEdges.length, value + 18))}>Showing {relationshipLimit} of {selectedEdges.length} · show 18 more</button> : null}
            </div>
          ) : <EmptyState icon="memory" title="Select an idea" body="Pan, zoom, search, or select any node to inspect its typed relationships and source metadata." />}
        </aside>
      </div>
      <div class="callout"><Icon name="cloud" /><div><strong>The selected Vault is the encrypted backbone</strong><p>Google Drive or S3 can serve exact encrypted segment ranges, while expert routing and ranking stay in this browser. This relationship graph still derives from current page inputs; remote graph-generation convergence is not claimed yet.</p></div></div>
      </> : null}
      {tab === "index" ? workspace ? <ClientContextView workspace={workspace} entries={files} embedded /> : <EmptyState icon="context" title="Index unavailable" body="The active browser workspace is not ready, so no index generation was started." /> : null}
    </section>
  );
}

function FederatedMemorySearch({ messages, files, profile }: Readonly<{ messages: readonly UiMessage[]; files: readonly WorkspaceEntry[]; profile: ProfileRevision }>) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const thread = normalized ? messages.filter((message) => (message.parts?.length ? messagePlainText(message.parts) : message.content).toLocaleLowerCase().includes(normalized)).slice(-8).reverse() : [];
  const profileHits = normalized && [profile.name, profile.description, profile.systemPrompt].some((value) => value.toLocaleLowerCase().includes(normalized)) ? [profile] : [];
  const workspaceHits = normalized ? files.filter((file) => file.path.toLocaleLowerCase().includes(normalized)).slice(0, 12) : [];
  return <section class="memory-federated" aria-labelledby="memory-search-title">
    <header><div><span class="eyebrow">Federated client search</span><h2 id="memory-search-title">One query, explicit scopes</h2><p>Results stay grouped by ownership and freshness. Empty lanes are shown honestly; Airship does not blend provenance into one opaque score.</p></div><label><span class="sr-only">Search memory and context</span><Icon name="memory" size={16} /><input type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search conversation, profile, and workspace…" /></label></header>
    <div class="memory-result-lanes">
      <MemorySearchLane title="Current conversation" scope="conversation" freshness="live page" count={thread.length}>{thread.map((message) => <article key={message.id}><strong>{message.role === "user" ? "You" : "Airship"}</strong><p>{(message.parts?.length ? messagePlainText(message.parts) : message.content).slice(0, 260)}</p></article>)}</MemorySearchLane>
      <MemorySearchLane title="Active profile memory" scope={profile.name} freshness="pinned revision" count={profileHits.length}>{profileHits.map((item) => <article key={item.revision}><strong>{item.name}</strong><p>{item.description} · {item.systemPrompt.slice(0, 220)}</p></article>)}</MemorySearchLane>
      <MemorySearchLane title="Shared workspace & sources" scope="workspace" freshness="observed now" count={workspaceHits.length}>{workspaceHits.map((file) => <article key={file.path}><strong>{file.path}</strong><p>{file.size} bytes · revision {file.revision.slice(-8)} · observed {new Date(file.updatedAt).toLocaleString()}</p></article>)}</MemorySearchLane>
    </div>
  </section>;
}

function MemorySearchLane({ title, scope, freshness, count, children }: Readonly<{ title: string; scope: string; freshness: string; count: number; children: ComponentChildren }>) {
  return <section class="memory-result-lane"><header><div><h3>{title}</h3><span>{count} result{count === 1 ? "" : "s"}</span></div><div><span>{scope}</span><span>{freshness}</span></div></header><div>{count ? children : <p class="memory-lane-empty">Enter a query or refine it to surface results from this scope.</p>}</div></section>;
}

function ProofView({
  receipt,
  endpointRecord,
  attestationNow,
  eventCount,
  sessionId,
  requestedReceiptId,
  loadAudit,
  section,
  onSectionChange,
  evidenceLedger,
}: {
  receipt?: ConversationReceipt;
  endpointRecord?: ChutesEndpointEvidenceRecord;
  attestationNow: number;
  eventCount: number;
  sessionId?: string;
  requestedReceiptId?: string;
  loadAudit: (sessionId: string) => Promise<SessionAuditReport>;
  section: ProofSection;
  onSectionChange: (section: ProofSection) => void;
  evidenceLedger: ComponentChildren;
}) {
  const [receiptAction, setReceiptAction] = useState<string>();
  const [audit, setAudit] = useState<SessionAuditReport>();
  const [auditError, setAuditError] = useState<string>();
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    let current = true;
    setAudit(undefined);
    setAuditError(undefined);
    if (!sessionId) return () => { current = false; };
    setAuditLoading(true);
    void loadAudit(sessionId)
      .then((report) => {
        if (!current) return;
        setAudit(report);
      })
      .catch((error) => {
        if (!current) return;
        setAuditError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (current) setAuditLoading(false);
      });
    return () => { current = false; };
  }, [sessionId, eventCount]);

  async function copyReceipt() {
    if (!receipt) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser context.");
      await navigator.clipboard.writeText(serializePortableReceipt(receipt));
      setReceiptAction("Privacy-safe unsigned receipt summary copied");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  function exportReceipt() {
    if (!receipt) return;
    try {
      const blob = new Blob([serializePortableReceipt(receipt)], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `airship-receipt-${receipt.receiptId.slice(-8)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setReceiptAction("Privacy-safe unsigned receipt summary exported");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  function exportAudit() {
    if (!audit) return;
    try {
      const blob = new Blob([JSON.stringify(audit, null, 2)], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `airship-session-audit-${audit.sessionId.slice(0, 8)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setReceiptAction("Session audit exported");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  const auditLabel = audit?.status === "verified"
    ? "Locally consistent"
    : audit?.status === "incomplete"
      ? "Consistent but incomplete"
      : audit?.status === "invalid"
        ? "Integrity failure"
        : auditLoading
          ? "Checking journal"
          : "Not checked";

  return (
    <section class="work-view">
      <PageHeading eyebrow="Inspectable, portable evidence" title="Proof" description="Endpoint attestation and conversation receipts are different claims. Airship never presents one as the other." />
      <nav class="proof-surface-tabs" aria-label="Proof views" role="tablist">
        <button id="proof-tab-summary" type="button" role="tab" aria-controls="proof-panel-summary" aria-selected={section === "summary"} tabIndex={section === "summary" ? 0 : -1} onClick={() => onSectionChange("summary")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onSectionChange("attestations"); requestAnimationFrame(() => document.getElementById("proof-tab-attestations")?.focus()); } }}>Receipt &amp; journal</button>
        <button id="proof-tab-attestations" type="button" role="tab" aria-controls="proof-panel-attestations" aria-selected={section === "attestations"} tabIndex={section === "attestations" ? 0 : -1} onClick={() => onSectionChange("attestations")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onSectionChange("summary"); requestAnimationFrame(() => document.getElementById("proof-tab-summary")?.focus()); } }}>Attestation evidence</button>
      </nav>
      {section === "attestations" ? <div id="proof-panel-attestations" class="proof-surface-panel" role="tabpanel" aria-labelledby="proof-tab-attestations">{evidenceLedger}</div> : <div id="proof-panel-summary" class="proof-surface-panel" role="tabpanel" aria-labelledby="proof-tab-summary">
      <div class="proof-overview">
        <div class="proof-hero panel">
          <Seal
            class="proof-hero-seal"
            state={postureSeal(receipt?.posture)}
            origin={receipt?.posture === "local" ? "local" : "remote"}
            label={SEAL_LABELS[postureSeal(receipt?.posture)]}
            detail={receipt ? receiptSummary(receipt) : "No completed turn receipt is selected."}
            size={44}
          />
          <div><span class="eyebrow">Current proof level</span><h2>{receipt ? proofLevelLabel(receipt.proofLevel) : requestedReceiptId ? "Receipt unavailable" : "No completed turn"}</h2><p>{receipt ? receiptSummary(receipt) : requestedReceiptId ? "The selected receipt is not available in this page runtime. Airship will not substitute a different turn receipt." : "Complete a turn to create the first local receipt."}</p></div>
        </div>
        <div class="metric"><span>Session journal</span><strong>{auditLabel}</strong><small>{audit ? `${audit.counts.events} event${audit.counts.events === 1 ? "" : "s"} · ${audit.commitment.digest.slice(0, 18)}…` : `${eventCount} observed event${eventCount === 1 ? "" : "s"}`}</small></div>
        <div class="metric"><span>TEE verification</span><strong>{receipt?.posture === "encrypted-attested" ? "Receipt-attested" : "Not established"}</strong><small>{receipt?.posture === "encrypted-unattested" ? "compatibility mode" : "production remote mode must fail closed"}</small></div>
      </div>
      <ProofInspector receipt={receipt} endpointRecord={endpointRecord} now={attestationNow} onOpenAttestations={() => onSectionChange("attestations")} />
      <section class={`journal-audit panel ${audit?.status ?? "pending"}`} aria-labelledby="journal-audit-title">
        <div class="journal-audit-heading">
          <div>
            <span class="eyebrow">Independent local consistency check</span>
            <h2 id="journal-audit-title">Session journal integrity</h2>
          </div>
          <span class={`audit-state ${audit?.status ?? "pending"}`}>{auditLabel}</span>
        </div>
        {audit ? (
          <>
            <div class="audit-boundary">
              <Icon name={audit.status === "invalid" ? "warning" : "proof"} size={18} />
              <p><strong>A valid hash chain is not proof of authorship.</strong> This report checks schema, ordering, manifest bindings, turn/tool protocol, and receipt bindings. No separately trusted author identity was established.</p>
            </div>
            <div class="audit-check-grid" aria-label="Journal audit checks">
              {([
                ["Schema", audit.checks.schema],
                ["Hash chain", audit.checks.chain],
                ["Manifest", audit.checks.manifest],
                ["Turn protocol", audit.checks.protocol],
                ["Receipt bindings", audit.checks.receiptBindings],
                ["Complete history", audit.checks.complete],
              ] as const).map(([label, passed]) => (
                <div key={label} class={passed ? "pass" : "fail"}>
                  <Seal state={passed ? "verified" : "failed"} label={passed ? "Passed" : "Failed"} size={16} compact />
                  <strong>{label}</strong>
                  <small>{passed ? "consistent" : "attention required"}</small>
                </div>
              ))}
            </div>
            <dl class="audit-commitment">
              <div><dt>Session</dt><dd>{audit.sessionId}</dd></div>
              <div><dt>Journal events</dt><dd>{audit.commitment.sequence}</dd></div>
              <div><dt>Checked</dt><dd><time dateTime={audit.checkedAt} title={new Date(audit.checkedAt).toLocaleString()}>{relativeEvidenceAge(audit.checkedAt)}</time></dd></div>
              <div><dt>External anchor</dt><dd>{audit.anchor.status === "not-supplied" ? "Not supplied" : audit.anchor.status === "matched" ? "Matched" : "Did not match"}</dd></div>
            </dl>
            <details><summary>Technical journal details</summary><code>{audit.commitment.digest}</code></details>
            {audit.findings.length > 0 ? (
              <details class="audit-findings" open={audit.status === "invalid"}>
                <summary>{audit.findings.length} audit finding{audit.findings.length === 1 ? "" : "s"}</summary>
                <div>{audit.findings.slice(0, 30).map((finding, index) => (
                  <article key={`${finding.code}-${finding.sequence ?? index}`} data-severity={finding.severity}>
                    <span>{finding.severity}</span><strong>{finding.code}</strong><p>{finding.message}</p>
                  </article>
                ))}</div>
              </details>
            ) : <p class="audit-clean">No consistency findings were produced for this session prefix.</p>}
          </>
        ) : <p class="audit-loading" role="status">{auditError ?? (auditLoading ? "Recomputing the session commitment…" : "No active session is available to audit.")}</p>}
      </section>
      <div class="proof-actions" aria-label="Portable evidence actions">
        {receipt ? <button class="small-button" type="button" onClick={() => void copyReceipt()}><Icon name="proof" size={14} /> Copy safe summary</button> : null}
        {receipt ? <button class="small-button" type="button" onClick={exportReceipt}><Icon name="cloud" size={14} /> Export safe summary</button> : null}
        {audit ? <button class="small-button" type="button" onClick={exportAudit}><Icon name="proof" size={14} /> Export session audit</button> : null}
        {receiptAction ? <span role="status" aria-live="polite">{receiptAction}</span> : null}
      </div>
      {receipt ? <p class="proof-export-boundary">Default receipt export is an unsigned privacy-safe status summary. It withholds plaintext digests, raw evidence, arbitrary claim details, nonces, and keys; it is not an independently verifiable forensic bundle.</p> : null}
      </div>}
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
  return (
    <div class={compact ? "proof-inspector compact" : "proof-inspector panel"}>
      <div class="inspector-heading"><div><span class="eyebrow">Claim stack</span><h2>Verification</h2></div><span class="proof-level">{receipt ? proofLevelLabel(receipt.proofLevel) : "Not checked"}</span></div>
      {receipt ? <p class="proof-bottom-line">{rankedReceiptVerdict({ proofLevel: receipt.proofLevel, posture: receipt.posture, statuses: model.items.map((item) => item.status) })}</p> : null}
      {receipt ? (
        <section class={`evidence-join evidence-join--${model.evidence}`} aria-label="Evidence composition">
          <div class="evidence-join__heading">
            <strong class={`evidence-join__state evidence-join__state--${model.evidence}`}><span aria-hidden="true" />{model.evidence === "matched" ? "Endpoint evidence matched" : model.evidence === "stale" ? "Evidence refresh due" : "Turn receipt only"}</strong>
            <span>{establishedCount} established · {model.groups.unavailable.length} not established</span>
          </div>
          <p>{model.evidenceSummary}</p>
          {endpointRecord ? <dl class="evidence-join__facts">
            <div><dt>Instance</dt><dd>{endpointRecord.subject.instanceId}</dd></div>
            <div><dt>Evidence</dt><dd>{relativeEvidenceAge(endpointRecord.acquisition.fetchedAt, now)}</dd></div>
          </dl> : null}
          {onOpenAttestations ? <button class="evidence-join__action" type="button" onClick={onOpenAttestations}>{endpointRecord ? "Inspect endpoint evidence" : "Acquire endpoint evidence"} <span aria-hidden="true">→</span></button> : null}
        </section>
      ) : null}
      <div class="claim-groups">
        <ClaimGroup label="Needs attention" tone="failed" items={model.groups.failed} receipt={receipt} />
        <ClaimGroup label="Verified" tone="verified" items={model.groups.verified} receipt={receipt} />
        <ClaimGroup label="Assertions" tone="asserted" items={model.groups.asserted} receipt={receipt} />
        {model.groups.unavailable.length > 0 ? (
          <details class="claim-absence">
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
          <span class={`claim-source claim-source--${source}`}>{source === "endpoint-evidence" ? "Endpoint evidence" : "Turn receipt"}</span>
        </span>
      </summary>
      <div class="claim-detail">
         <p>{claim.summary}</p>
         <dl><dt>Claim</dt><dd>{language.technical}</dd></dl>
         <dl><dt>Source</dt><dd>{source === "endpoint-evidence" ? "Matching current endpoint evidence" : "This conversation turn receipt"}</dd></dl>
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
  return {
    profileId: profile.profileId,
    name: profile.name,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    themeId: profile.theme.themeId,
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

function formatGraphDensity(graph: MemoryRelationshipGraph): string {
  const possiblePairs = graph.stats.nodeCount * Math.max(0, graph.stats.nodeCount - 1) / 2;
  const density = possiblePairs === 0 ? 0 : graph.stats.edgeCount / possiblePairs;
  return density < 0.001 && density > 0 ? density.toExponential(1) : density.toFixed(3);
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

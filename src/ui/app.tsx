import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  AttestationEvidenceClientErrorCode,
  ChutesAttestationEvidenceClient,
} from "../attestation/provider-client";
import type {
  ChutesEndpointAttestationSnapshot,
  ChutesEndpointEvidenceRecord,
} from "../attestation/provider-types";
import { ApprovalBroker, redactForDisplay } from "../approvals/broker";
import { approvalProvenance, createApprovalModePolicy, createHumanIntentPolicy, decideHumanIntent, type ApprovalMode } from "../approvals/modes";
import { SwitchableApprovalPolicy } from "../approvals/switchable-policy";
import {
  DISCONNECTED_CHUTES_CONNECTION,
  isChutesConnected,
  parseChutesCredential,
  withChutesModel,
  withVerifiedInvocation,
  type ActiveChutesConnection,
  type ChutesConnection,
} from "../auth/connection";
import type { ChutesOAuthRegistration } from "../auth/chutes-oauth-registration";
import type { ChutesOAuthTokenSet } from "../auth/chutes-oauth";
import type { VaultUsageFacts } from "./vault-view";
import type { BrowserRuntimeCapabilityReport } from "../capabilities/browser-runtime";
import type { ExtensionBridgeObservation } from "../capabilities/extension-bridge";
import {
  type SlashCommandPlan,
  type SlashCommandRegistry,
  type SlashCompletion,
} from "../commands";
import { CONVERSATION_NAMED_EVENT_TYPE, HUMAN_INTENT_EVENT_TYPE } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import { finalizeProviderReceipt } from "../receipts/types";
import type { CanonicalMessage, InferenceTransport, JsonValue, SecurityPosture, SessionManifest, ToolDefinition } from "../core/contracts";
import type { LiveEnvironmentEntry } from "../core/live-environment";
import type { InferenceDirectoryPromptDefinition } from "../core/operating-charter";
import { EventJournal, type DurableEvent, type SessionRecord } from "../core/journal";
import { randomUuid } from "../core/id";
import { loadBrowserGit } from "../load-browser-git";
import { runTurn } from "../load-agent-runtime";
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
import type { BrowserGitClient } from "../git/client";
import type { GitOperation, GitOperationDescriptor } from "../git/types";
import type { WorkspaceGitRepositorySeed } from "../git/workspace-adapter";
import type { VaultContextFabricPort } from "../vault/context-fabric-port";
import type { ChutesInferenceTransport, ChutesInvocationTelemetry } from "../inference/chutes";
import { modelInputModalityCapability, sortModels, type AirshipModel } from "../models";
import type { ExecutionCapability } from "../execution/runtime-registry";
import { archiveProfileRevision, createBuiltInProfileCatalog, managedProfileRevisions, type ProfileCatalog } from "../profiles/catalog";
import {
  MemoryProfileCatalogStore,
  type ProfileCatalogCheckpoint,
  type ProfileCatalogStore,
} from "../profiles/persistence";
import {
  PROFILE_BOUNDARY_NOTE,
  PROFILE_MEMORY_SCOPE_LABELS,
  PROFILE_POSTURE_FIELD_LABEL,
} from "./profiles-governance";
import { postureFloorRefusal } from "./posture-floor";
/* The leaf record, not `attestation-gate` — that module carries the DCAP
   verifier's WASM and this file paints first. */
import { CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY as strictProofCapability } from "../inference/chutes/strict-proof-capability";
import { providerBoundaryLabel } from "../inference/transport-boundary-label";
import {
  createGlobalSkillSettings,
  createProfileRevision,
  enforcedMemoryScope,
  resolveProfileSilo,
  resolveProfileForSession,
  resolveSkillDecisions,
  themeCssVariables,
  type ProfileRevision,
  type ResolvedSkillDecision,
  type SkillMode,
  type ThemeColorScheme,
  type ThemeManifest,
} from "../profiles/domain";
import type { ConversationReceipt } from "../receipts/types";
import {
  READY_SESSION_LIFECYCLE,
  SessionLibrary,
  UnknownSessionError,
  advanceSessionLifecycle,
  type ActiveSessionRuntime,
  type SessionForkResult,
  type SessionLibraryDetail,
  type SessionLifecycle,
  type SessionListItem,
} from "../sessions";
import {
  inferenceBindingsMatch,
  profileOwnedSessions,
  profileOwnsSession,
  requireProfileOwnedSession,
  resolveResumableProfileConversation,
  resumableProfileManifestMatches,
} from "../sessions/profile-cockpit";
import {
  createAirshipToolRegistry,
  createVaultAwareAirshipToolRegistry,
  createVaultBackedAirshipToolRegistry,
  type LiveEnvironmentSupplementSource,
} from "../tools/airship-tools";
import type { FederatedMemoryResult } from "../tools/federated-memory";
// Deliberately a static import of a dependency-free module, not of the terminal
// manager: the journal must be bound before the first shell record exists, and
// the manager itself stays behind its lazy chunk.
import { subscribeTerminalAuditRecords, terminalActivityEvent } from "../terminal/audit-sink";
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
import { ProfileWorkspacePort, adoptLegacyRootWorkspace, isProfileWorkspacePath, profileWorkspaceIdentity } from "../workspace/profile-scope";
import { WorkspaceRefreshCoordinator, type WorkspaceRefreshAuthority } from "./workspace-refresh";
import { nextEditorSelection, type EditorSelection } from "./editor-selection";
import { composeClaimStack, type ClaimStackFact, type ClaimStackItem } from "./claim-stack-model";
import { TURN_EVIDENCE_COPY, turnEvidenceVerdict } from "./turn-evidence";
// The two per-message rung words, taken from the one dictionary rather than
// retyped, so `RETIRED_TRUST_LABELS` cannot be re-spelled back into this file.
import { TRUST_LABEL_MESSAGE_ASSERTED_NO_ENDPOINT, TRUST_LABEL_MESSAGE_NO_EVIDENCE } from "./trust-language";
// The one fail-closed rule for a stored receipt, imported rather than restated.
// `#proof` renders the hero verdict and this inspector on the same screen; if
// they fed their shared reducer from two different predicates the route would
// print two verdicts for one turn, which is the defect this package closes.
import { sealStateForReceipt } from "./seal-states";
import { ApprovalDock } from "./approval-dock";
import { attestationRecordIdForReceipt, sessionAttestationReceipts } from "./attestation-history";
import type { AttestationRefreshTarget } from "./attestations-view";
import { Icon } from "./icons";
import type {
  LocalDeviceActivationReason,
  LocalDeviceAtomicRestoreRequest,
} from "./local-device-vault-setup";
import { chatHash, chatSessionIdFromHash } from "./chat-route";
import { MenuSelect } from "./menu-select";
import { MobileNavigation } from "./mobile-navigation";
import { activeConnectionProofLabel, ModelControl } from "./model-control";
import { MODEL_CAPABILITY_WORDS } from "./model-vocabulary";
import { CANONICAL_DESTINATIONS, navigationHashForView, navigationViewFromHash, type NavigationView } from "./navigation-model";
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
  unloadWouldLoseWork,
  useBeforeUnloadGuard,
  useDebouncedValue,
  useGlobalNavigationJumps,
  useGlobalPaletteShortcut,
  usePwaUpdate,
  useVisualViewport,
  vaultBackendUnavailableReason,
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
import { Rail } from "./rail";
import { collapseLineageBranches } from "./recent-lineage";
import {
  isRailToggleChord,
  loadRailPreference,
  railBand,
  resolveRailState,
  saveRailPreference,
  toggledRailState,
  withRailState,
  type RailPreference,
  type RailState,
} from "./rail-state";
import { SEAL_LABELS, Seal, sealStateForProofStatus, type SealState } from "./seal";
import { useScrollEdges } from "./scroll-affordance";
import { enabledSlashSelection, firstEnabledSlashIndex, moveSlashSelection } from "./slash-menu-state";
import type { SourcesImportRequest } from "./sources-view";
import type { MemorySourceTarget } from "./memory-view";
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
import { composerAttachments, userMessageParts, COMPOSER_ATTACHMENT_LIMIT, type ComposerAttachment } from "./chat/composer-state";
import { MOBILE_SHELL_MEDIA_QUERY, shouldClaimComposerFocus } from "./chat/composer-focus";
import {
  composerAttachmentNeedsText,
  composerAttachmentNotice,
  composerGrowthCap,
  composerPlaceholder,
  composerPosture,
  ComposerKeyhintLegend,
  ComposerPostureChip,
  COMPOSER_NARROW_PLACEHOLDER_QUERY,
  COMPOSER_PLACEHOLDER_TITLE,
  SLASH_MENU_HEADER,
} from "./chat/composer";
// The pre-click branch sentence, imported rather than retyped: the literal
// that used to sit on the Retry button drifted away from this constant and
// ended up promising that the prior answer IS carried into the branch, which
// is the opposite of what the fork does.
import { forkBranchNotice, FORK_RETRY_TOOLTIP } from "./chat/fork-notice";
import { originatingPromptForRow } from "./chat/retry-prompt";
// Types only: the reducer itself stays in the deferred capability pack.
import type {
  SessionMessagePresentation,
  SessionPresentationHistory,
  SessionPresentationMarker,
  SessionPresentationProviderContext,
  SessionPresentationTurnStatus,
} from "./chat/session-message-presentation";
import { recoverPartialTurn } from "./chat/turn-recovery";
import { claimThreadDraftHydration, readThreadDraft, writeThreadDraft } from "./chat/thread-draft";
import { browserThreadViewportStorage, readThreadViewport, writeThreadViewport } from "./chat/thread-viewport";
import { appendThreadQueueItem, removeThreadQueueItem } from "./chat/thread-queue";
import {
  refreshCompletedTurnWorkspace,
  releaseComposerAndReloadSession,
} from "./chat/turn-housekeeping";
import { StreamingMessageSlot, TranscriptStreamStore } from "./chat/streaming-slot";
import { isNearLastRealCard, preferredJumpBehavior, scrollToLastRealCard } from "./chat/transcript-anchor";
import { DemoModelChip, SessionBar } from "./chat/session-bar";
import { sessionStatusShort, type SessionStatusFact } from "./chat/session-status-chip";
import {
  TRANSCRIPT_INTRO_DEMO_LINE,
  TRANSCRIPT_SEED_BODY,
  TranscriptIntro,
  TranscriptMarker,
  transcriptIntroNote,
} from "./chat/transcript-intro";
import { TopbarPostureChip } from "./topbar";
import { TabPresenceNote } from "./tab-presence";
import { ProfileThemeSwatch, themePresentation, themePresentationSummary } from "./profile-theme-swatch";
import { PostureChip } from "./posture-chip";
import { durabilityLabel, durabilitySeal, type DurabilityState } from "./durability-indicator";
import { RouteFailure } from "./route-failure";
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
  /**
   * Set only on a conversation seed — the message that states what runtime the
   * conversation opened in. It is real agent context but it is not a turn, so
   * the transcript renders it as its intro rather than as a card with an
   * avatar and a Retry no model's output is behind. The flag is what keeps a
   * genuine first message from ever being mistaken for chrome.
   */
  seed?: true;
  /**
   * A durable record that belongs to the session rather than to a turn.
   *
   * A rename, a context summary, or a record this build cannot replay. Set on a
   * row that is not a turn: the transcript renders it as a divider rather than
   * as a card, because it has no speaker and nothing to retry. It is a row at
   * all — rather than being skipped — because it is a record the user created,
   * and skipping it is how a page comes to imply it is complete when it is not.
   */
  marker?: SessionPresentationMarker;
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
  /**
   * The pre-turn boundary, carried separately from `sourcePoint`.
   *
   * "Fork from here" on an answer keeps the answer, so an assistant row's
   * `sourcePoint` is the post-answer terminal. Retry has to fork *before* the
   * turn or the regenerated answer is handed the answer it replaces as
   * context. Only an assistant row sets this; a user row's `sourcePoint` is
   * already the pre-turn boundary.
   */
  turnStartPoint?: Readonly<{ sequence: number; digest: string }>;
  history?: Readonly<{
    turnStatus: "completed" | "failed" | "cancelled" | "incomplete";
    providerContext: "included" | "excluded";
  }>;
};

/** One operation's buffered live tool output, pre-flush. */
export type PendingToolOutputUpdate = NonNullable<UiMessage["liveToolOutput"]>;

/** Live tool output keeps only the tail; the panel renders at most this much. */
const LIVE_TOOL_OUTPUT_LIMIT = 32_768;

/**
 * Coalesces a burst of `tool-output` chunks into one pending update per
 * operation. The execution stream emits per write; applying each to messages
 * rebuilt the whole transcript array and re-rendered every visible card per
 * chunk, while only the latest frame is ever painted. Intermediate text
 * merely accumulates here until the animation-frame flush applies every
 * pending operation in a single `setMessages`.
 */
export function mergePendingToolOutput(
  updates: Map<string, PendingToolOutputUpdate>,
  operationId: string,
  chunk: Readonly<{ stream: PendingToolOutputUpdate["stream"]; text: string }>,
): Map<string, PendingToolOutputUpdate> {
  const prior = updates.get(operationId);
  updates.set(operationId, {
    operationId,
    stream: chunk.stream,
    text: `${prior?.text ?? ""}${chunk.text}`.slice(-LIVE_TOOL_OUTPUT_LIMIT),
  });
  return updates;
}

/**
 * A conversation whose durable history is intact but whose transcript this
 * runtime could not replay.
 *
 * The two halves of that sentence must stay separate everywhere this is
 * rendered. The audit really did verify the chain, so "session damaged" would
 * be a false claim in the *understating* direction — it would tell a user their
 * data is gone when every byte is recoverable. "Ready to resume" would be the
 * false claim in the other direction. The honest reading is both facts at once:
 * history verified, transcript not replayable, and here is why.
 */
type QuarantinedSession = Readonly<{
  sessionId: string;
  title: string;
  /** Verbatim from `describeSessionPresentationFault` — never a bare UUID. */
  reason: string;
  /**
   * Whether `auditSessionHistory` actually returned `verified` before the
   * failure. One `try` used to cover the inspect, the read, the audit AND the
   * presentation, so a session whose audit came back `invalid` still reached a
   * panel headed "History verified · every event is intact" — printed three
   * lines above the product's own "History suspect". The surfaces that make
   * that claim must read this rather than assume it.
   */
  historyVerified: boolean;
}>;

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
  profileId: string;
  title: string;
  preview: string;
  updatedAt: string;
  favorite: boolean;
  /** Branches of this row's lineage the shortcut collapsed behind it. */
  hiddenBranchCount: number;
  open(): void;
  toggleFavorite(): void;
  moveFavorite(beforeSessionId?: string): void;
}>;

type RecentConversationCacheEntry = Readonly<{ preview: string; updatedAt: string }>;

type Runtime = {
  /**
   * The global storage authority — page memory or an adopted encrypted Vault.
   *
   * It owns every Profile's namespace, so this is what a Vault transition
   * migrates and what identity checks name. Nothing that reads or writes user
   * content should reach for it: `workspace` below is the only view a file,
   * repository, index, terminal or tool is allowed to see.
   */
  storage: WorkspacePort;
  storageId: string;
  /**
   * The active Profile's private namespace inside `storage`.
   *
   * Two Profiles resolve to disjoint subtrees, so they hold genuinely different
   * bytes, Git object databases, worktree inventories and indexes rather than
   * one shared filesystem behind separate presentation state. Keeping this
   * named `workspace` is deliberate: every existing consumer became
   * Profile-scoped by construction, and anything overlooked fails closed —
   * scoped — instead of silently sharing.
   */
  workspace: WorkspacePort;
  workspaceId: string;
  /** The Profile that `workspace` belongs to; a switch rebuilds both. */
  profileId: string;
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
  /**
   * The adopted Vault's context fabric, retained so a Profile switch can
   * rebuild the same class of tool registry. Absent under page memory.
   */
  contextFabric?: VaultContextFabricPort;
  tools: Awaited<ReturnType<typeof createAirshipToolRegistry>>;
};

type ForkActivationAuthority = Readonly<{
  runtime: Runtime;
  profileId: string;
  profileRevision: string;
  activeSessionId: string;
  manifest: SessionManifest;
}>;

type LocalPresentationAuthority = Readonly<{
  runtime: Runtime;
  profileId: string;
  profileRevision: string;
  sessionId: string;
}>;

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

/*
 * Scheduled OAuth rotation retries after a transient failure. Bounded on
 * purpose: three attempts over ~3.5 minutes outlast a blip, and past that the
 * connection claim has no honest basis left, so the original release applies.
 */
const OAUTH_ROTATION_RETRY_DELAYS = Object.freeze([30_000, 60_000, 120_000]);

/**
 * The Account route's non-Chutes tabs, in the order that route lists them.
 *
 * Restated rather than imported from `billing-view`: importing `BILLING_PROVIDERS`
 * would pull the Account route and its stylesheet into the shell's eager chunk
 * for three string constants. `billing-view.test.ts` pins this list to
 * `BILLING_PROVIDERS` so the two cannot drift. Chutes is absent on purpose —
 * the route reads its own credential for that tab.
 */
const BILLING_INVENTORY_PROVIDER_IDS: readonly Exclude<BillingProviderId, "chutes">[] =
  Object.freeze(["openai", "anthropic", "xai"]);

const EMPTY_INFERENCE_AVAILABILITY: InferenceAvailabilitySnapshot = Object.freeze({
  version: 1,
  capturedAt: "1970-01-01T00:00:00.000Z",
  connections: Object.freeze([]),
  omittedConnections: 0,
});

/*
 * Stable identities, so a route scoped away from the active conversation
 * re-renders with the same empty collection rather than a fresh literal each
 * pass. Frozen because these are handed to evidence surfaces that must not be
 * able to accumulate another session's records into them.
 */
const EMPTY_ENDPOINT_EVIDENCE: readonly ChutesEndpointEvidenceRecord[] = Object.freeze([]);
const EMPTY_CONVERSATION_RECEIPTS: readonly ConversationReceipt[] = Object.freeze([]);

/**
 * What the Attestation evidence ledger says when Proof is open for a
 * conversation that is not the active one. Endpoint evidence is acquired per
 * active session in this page runtime; it is not fetched for a conversation
 * you have only inspected, and pretending otherwise by showing the active
 * session's records would be the defect this sentence exists to prevent.
 */
const PROOF_UNSCOPED_EVIDENCE_NOTICE =
  "Endpoint evidence for this conversation is not loaded in this page runtime. Resume the conversation to acquire its own evidence; Airship will not show another conversation's records here.";

type DurableAdoptionDescriptor = Readonly<{
  ready: DurableStateRuntime;
  workspaceId: string;
  label: string;
  kind: "cloud" | "local-device";
  source: "migrate-active" | "target-authoritative";
}>;

type OAuthCallbackStatus = { kind: "verified" | "blocked" | "error"; message: string };
type ActiveOAuthRegistration = Readonly<{
  registration: ChutesOAuthRegistration;
  exchangeMode: "local-confidential-bridge" | "public-pkce";
}>;
type AttestationsScreenComponent = typeof import("./attestations-view").AttestationsView;
type ProofInspectorComponent = typeof import("./proof-inspector").ProofInspector;
type EditorScreenComponent = typeof import("./editor-view").EditorView;
type TerminalScreenComponent = typeof import("./terminal-view").TerminalView;
type CapabilitiesScreenComponent = typeof import("./capabilities-view").CapabilitiesView;
type ModelPickerComponent = typeof import("./model-picker").ModelPicker;
type MemoryScreenComponent = typeof import("./memory-view").MemoryView;
type GoogleDriveSetupComponent = typeof import("./google-drive-setup").GoogleDriveSetup;
type LocalLabSetupComponent = typeof import("./local-lab-setup").LocalLabSetup;
type LocalDeviceVaultSetupComponent = typeof import("./local-device-vault-setup").LocalDeviceVaultSetup;
type SessionsScreenComponent = typeof import("./sessions-route").SessionsView;
type VaultScreenComponent = typeof import("./vault-view").VaultView;
type AccessScreenComponent = typeof import("./access-view").AccessView;
type ProviderConnectionsScreenComponent = typeof import("./provider-connections-view").ProviderConnectionsView;
type BillingScreenComponent = typeof import("./billing-view").BillingView;
type BillingProviderId = import("./billing-view").BillingProviderId;
type ProofScreenComponent = typeof import("./proof-view").ProofView;
type EvidenceAcquisitionQueueController = import("../attestation/evidence-acquisition-queue").ReceiptEvidenceAcquisitionQueue;
type EvidenceAcquisitionQueueSnapshot = import("../attestation/evidence-acquisition-queue").EvidenceAcquisitionQueueSnapshot;
type EvidenceAcquisitionQueueAuthorityController = import("../attestation/workspace-evidence-acquisition-persistence").WorkspaceEvidenceAcquisitionAuthority;
type EvidenceAcquisitionQueueLoad = Readonly<{
  workspace: WorkspacePort;
  workspaceId: string;
  profileId: string;
  promise: Promise<EvidenceAcquisitionQueueController>;
}>;
type EndpointEvidenceAuthorityController = import("../attestation/workspace-endpoint-evidence-persistence").WorkspaceEndpointEvidenceAuthority;
type EndpointEvidenceBinding = import("../attestation/workspace-endpoint-evidence-persistence").WorkspaceEndpointEvidenceBinding;
type EndpointEvidenceRecordIdentity = import("../attestation/workspace-endpoint-evidence-persistence").EndpointEvidenceRecordIdentity;
type EndpointEvidenceScope = Readonly<{
  workspace: WorkspacePort;
  workspaceId: string;
  profileId: string;
}>;
type EndpointEvidenceFence = EndpointEvidenceScope & Readonly<{
  sessionId: string;
  receiptId?: string;
  instanceId: string;
  endpointKeyDigest?: string;
}>;
type EndpointEvidenceAuthorityLoad = EndpointEvidenceScope & Readonly<{
  promise: Promise<EndpointEvidenceBinding>;
}>;
type AttestationClientBinding = EndpointEvidenceScope & Readonly<{
  client: ChutesAttestationEvidenceClient;
  generation: number;
}>;
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
type AttestationPresentationState = EndpointEvidenceScope & Readonly<{
  sessionId: string;
  records: readonly ChutesEndpointEvidenceRecord[];
  failure?: AttestationAcquisitionFailure;
  selectedRecordId?: string;
  durabilityNotice?: string;
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

async function loadDeferredCapabilities() {
  const broker = await import("../load-deferred-capabilities");
  return broker.loadDeferredCapabilities();
}

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

/**
 * The rail owns the destination glyphs now (`navigation-model.ts`), so the
 * shell keeps only what it uses the destination table for: naming the route in
 * the document title and in the view error boundary.
 */
function destinationLabel(view: View): string | undefined {
  for (const item of CANONICAL_DESTINATIONS) {
    if (item.id === view) return item.label;
    for (const nested of item.nested) if (nested.id === view) return item.label;
  }
  return undefined;
}

/**
 * The seed that opens an empty conversation.
 *
 * It stays in `messages` because it is real agent context — the model is told
 * what runtime it woke up in — but it stopped rendering as a turn card: the
 * transcript intro states its claims once, deduplicated against the guidance
 * band's two sentences, and `transcriptIntroNote` keeps whatever per-session
 * sentence a caller prefixed to it.
 */
const welcomeMessage: UiMessage = {
  id: "welcome",
  role: "assistant",
  seed: true,
  content: TRANSCRIPT_SEED_BODY,
};

const PROFILE_DRAFT_DISCARD_PROMPT = "Discard unsaved profile edits?";

/**
 * Why Send and Enter wait out a model or storage transition.
 *
 * The Enter path shipped this sentence first; a disabled Send said nothing,
 * and `disabled` swallows `title` for touch and most screen readers. The
 * button's `aria-label` and `title`, and the Enter guard's notice, all quote
 * this one string so the three surfaces cannot drift.
 */
const COMPOSER_TRANSITION_WAIT = "Wait for the active model or storage transition. Your prompt remains in the composer.";

/**
 * The resting word for a lifecycle whose full label is too long for a chip.
 *
 * Every entry is the shipped `SessionLifecycle["label"]` said shorter, never
 * said differently: the full sentence is one gesture away in the popover, and
 * the chip only ever speaks for the lifecycle while a turn is running or has
 * ended badly — the two states a user cannot infer from the transcript alone.
 */
/**
 * How far the transcript scrolls before the session bar collapses to 32px.
 *
 * Deliberately larger than the bar itself: a collapse that fires on the first
 * wheel notch reads as a rendering fault rather than a response, and anything
 * shorter makes the boundary oscillate on a trackpad's momentum tail.
 */
const SESSION_BAR_COLLAPSE_SCROLL = 48;

/**
 * How long the recents shortcuts wait for a turn's durable events to stop
 * arriving. Long enough to collapse a whole tool-calling turn's writes into one
 * refresh, short enough that a rename or a new conversation lands before the
 * eye reaches the sidebar.
 */
const RECENTS_REFRESH_DEBOUNCE_MS = 250;

const SESSION_LIFECYCLE_SHORT: Readonly<Record<SessionLifecycle["state"], string>> = Object.freeze({
  ready: "Ready",
  running: "Working",
  completed: "Turn done",
  failed: "Turn failed",
  cancelled: "Cancelled",
});

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
  if (message.marker) return MARKER_MESSAGE_ESTIMATE;
  return message.role === "assistant" ? ASSISTANT_MESSAGE_ESTIMATE : USER_MESSAGE_ESTIMATE;
}

/** One line of text and one provenance line, at the transcript's line height. */
const MARKER_MESSAGE_ESTIMATE = 56;

/**
 * The materializer's per-turn metadata, in the shape the presentation checks it
 * against. Written out twice, identically, at the two call sites — which is one
 * copy more than a projection this mechanical can be trusted to keep in step.
 */
function presentationHistory(
  messages: readonly Readonly<{
    turnId?: string;
    turnStatus: SessionPresentationTurnStatus;
    providerContext: SessionPresentationProviderContext;
  }>[],
): SessionPresentationHistory[] {
  return messages.flatMap((message) => message.turnId ? [{
    turnId: message.turnId,
    turnStatus: message.turnStatus,
    providerContext: message.providerContext,
  }] : []);
}

/** The last turn in the page that carried a receipt, if any. */
function lastPresentationRowReceipt(presentation: SessionMessagePresentation): ConversationReceipt | undefined {
  return presentation.rows.flatMap((row) => row.receipt ? [row.receipt] : []).at(-1);
}

/**
 * The transcript rows for an audited presentation: its turns AND its markers.
 *
 * Two call sites built this list from `presentation.rows` alone — vault
 * adoption and library resume — and they were byte-for-byte the same twenty
 * lines, which is exactly the shape in which one of them would have gained the
 * session-scoped records and the other would not. They are one function now.
 *
 * Markers are merged in durable sequence order rather than appended: a rename
 * that happened between turn 3 and turn 4 belongs between turn 3 and turn 4,
 * and a divider floating at the end of a transcript is a record whose position
 * has quietly been lost.
 */
/**
 * Every receipt the Proof route can resolve for the conversation on screen.
 *
 * Proof addresses receipts only through this list, so a receipt missing from it
 * is unreachable no matter how well it was minted, finalized and journaled —
 * which is exactly what happened to the conversation-naming receipt, which
 * rides no transcript row until a reload replays its record as a marker.
 *
 * Two rules do the work. Ancillary receipts are filtered to this conversation,
 * because the page keeps them across conversation switches and one
 * conversation's evidence must never answer for another's. And they come
 * *first*, because `resolveProofReceipt` walks this list backwards when the
 * selection names no receipt: the conversation's most recent turn stays the
 * default hero, exactly as it did before anything beside a turn was listed.
 */
export function proofResolvableReceipts(
  ancillary: readonly ConversationReceipt[],
  messages: readonly Readonly<{ receipt?: ConversationReceipt }>[],
  sessionId: string | undefined,
): ConversationReceipt[] {
  return [
    ...ancillary.filter((receipt) => receipt.sessionId === sessionId),
    ...messages.flatMap((message) => message.receipt ? [message.receipt] : []),
  ];
}

function markComposerScroll(element: HTMLTextAreaElement): void {
  const inputRow = element.closest<HTMLElement>(".composer-input-row");
  if (!inputRow) return;
  const top = element.scrollTop > 0;
  const bottom = element.scrollHeight - element.scrollTop - element.clientHeight > 1;
  const state = top && bottom ? "both" : top ? "top" : bottom ? "bottom" : undefined;
  if (state) inputRow.dataset.scrolled = state;
  else delete inputRow.dataset.scrolled;
}

/** Reconcile the composer's box with the value currently in its DOM authority. */
function fitComposerTextarea(element: HTMLTextAreaElement): void {
  const style = getComputedStyle(element);
  const minimum = parseFloat(style.minHeight) || 44;
  // The cap is a share of what is *visible*, not of the document: with a
  // soft keyboard up, the flat 180px ceiling left the transcript 24px.
  const maximum = composerGrowthCap(
    parseFloat(style.maxHeight),
    window.visualViewport?.height ?? window.innerHeight,
    minimum,
  );
  element.style.height = `${minimum}px`;
  element.style.maxHeight = `${maximum}px`;
  const natural = element.scrollHeight;
  element.style.height = `${Math.min(maximum, Math.max(minimum, natural))}px`;
  element.style.overflowY = natural > maximum ? "auto" : "hidden";
  markComposerScroll(element);
}

function transcriptMessagesFromPresentation(presentation: SessionMessagePresentation): UiMessage[] {
  const rows = presentation.rows.map((row, index) => {
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
      ...(row.turnStartPoint ? { turnStartPoint: row.turnStartPoint } : {}),
    } satisfies UiMessage;
  });
  if (presentation.markers.length === 0) return rows;
  const merged: UiMessage[] = [];
  let cursor = 0;
  for (const marker of presentation.markers) {
    while (cursor < rows.length && presentation.rows[cursor]!.sequence < marker.sequence) {
      merged.push(rows[cursor]!);
      cursor += 1;
    }
    merged.push({
      id: `marker:${marker.eventId}`,
      // Neither party said this; the journal did. The role only decides the
      // height estimate, because a marker never reaches `MessageCard`.
      role: "assistant",
      content: marker.detail,
      marker,
      // A marker that records a billed request carries its receipt onto the
      // transcript item so `inPageReceipts` — the only list Proof resolves
      // against — contains it. Without this the naming receipt was minted,
      // validated and journaled, and then addressable by nothing.
      ...(marker.receipt ? { receipt: marker.receipt } : {}),
      sourcePoint: { sequence: marker.sequence, digest: marker.digest },
    });
  }
  merged.push(...rows.slice(cursor));
  return merged;
}

async function loadRecentConversations(
  library: SessionLibrary,
  open: (sessionId: string) => void,
  setFavorite: (sessionId: string, favorite: boolean) => void,
  moveFavorite: (sessionId: string, beforeSessionId?: string) => void,
  signal: AbortSignal,
  profileId: string,
  cache: Map<string, RecentConversationCacheEntry>,
  activeSessionId: string | undefined,
): Promise<readonly RecentConversation[]> {
  const [page, favorites] = await Promise.all([
    library.list({ sort: "updated-desc", limit: 200, profileId }, signal),
    library.favorites(profileId, signal),
  ]);
  if (signal.aborted) return Object.freeze([]);
  const favoriteOrder = new Map(favorites.map((favorite, index) => [favorite.sessionId, index]));
  const indexed = [...page.items];
  const indexedIds = new Set(indexed.map((item) => item.id));
  const missingFavorites = new Set(favorites.map((favorite) => favorite.sessionId).filter((id) => !indexedIds.has(id)));
  // The shortcut is bounded to ten rows, but an old favorite must not vanish
  // merely because more than one 200-item ledger page was created afterward.
  for (let offset = page.limit; missingFavorites.size > 0 && offset < page.total; offset += page.limit) {
    const next = await library.list({ sort: "updated-desc", limit: page.limit, offset, profileId }, signal);
    if (signal.aborted) return Object.freeze([]);
    for (const item of next.items) {
      if (!missingFavorites.delete(item.id)) continue;
      indexed.push(item);
    }
  }
  const itemById = new Map(indexed.map((item) => [item.id, item] as const));
  // Every favorite stays in the shortcut, even after it falls outside the
  // ordinary recency window. Non-favorites fill the remaining ten-row budget;
  // if a profile has more than ten favorites the scrollable tree shows all of
  // them rather than silently dropping the oldest star.
  const favoriteItems = favorites.flatMap((favorite) => {
    const item = itemById.get(favorite.sessionId);
    return item ? [item] : [];
  });
  // One row per lineage, not one row per branch. Edit & branch and Retry both
  // produce peer sessions, so a question retried three times used to take four
  // of the ten rows and push four unrelated conversations out of the shortcut
  // entirely. The collapse happens *before* the ten-row budget is applied, so
  // the rows it frees go to those unrelated conversations rather than being
  // lost. The active conversation is pinned through it: withdrawing the row a
  // person is currently reading would be a worse defect than the flooding.
  const recentGroups = collapseLineageBranches(
    indexed
      .filter((item) => !favoriteOrder.has(item.id))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    new Map(indexed.map((item) => [item.id, item.sourceSessionId] as const)),
    new Set(activeSessionId ? [activeSessionId] : []),
  ).slice(0, Math.max(0, 10 - favoriteItems.length));
  const branchCounts = new Map(recentGroups.map((group) => [group.item.id, group.hiddenBranchCount] as const));
  const selected = [...favoriteItems, ...recentGroups.map((group) => group.item)];
  const conversations = await Promise.all(selected.map(async (item) => recentConversationFor(
    item,
    library,
    open,
    signal,
    cache,
    favoriteOrder.has(item.id),
    setFavorite,
    moveFavorite,
    profileId,
    branchCounts.get(item.id) ?? 0,
  )));
  if (signal.aborted) return Object.freeze([]);
  return Object.freeze(conversations);
}

async function recentConversationFor(
  item: SessionListItem,
  library: SessionLibrary,
  open: (sessionId: string) => void,
  signal: AbortSignal,
  cache: Map<string, RecentConversationCacheEntry>,
  favorite: boolean,
  setFavorite: (sessionId: string, favorite: boolean) => void,
  moveFavorite: (sessionId: string, beforeSessionId?: string) => void,
  profileId: string,
  hiddenBranchCount: number,
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
  return Object.freeze({
    id: item.id,
    profileId,
    title: item.title,
    preview,
    updatedAt: item.updatedAt,
    favorite,
    hiddenBranchCount,
    open: () => open(item.id),
    toggleFavorite: () => setFavorite(item.id, !favorite),
    moveFavorite: (beforeSessionId) => moveFavorite(item.id, beforeSessionId),
  });
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
  const [narrowComposer, setNarrowComposer] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [trustSheetOpen, setTrustSheetOpen] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [preferences, setPreferences] = useState<PreferenceOverrides>(loadPreferenceOverrides);
  const [catalog, setCatalog] = useState<ProfileCatalog>();
  const [profileId, setProfileId] = useState("general");
  const profileAuthorityId = useRef(profileId);
  const [profileCockpitTransition, setProfileCockpitTransition] = useState<Readonly<{
    profileId: string;
    name: string;
  }>>();
  const [profileHubScope, setProfileHubScope] = useState("global");
  const [sessionId, setSessionId] = useState<string>();
  const [activeSessionRecord, setActiveSessionRecord] = useState<SessionRecord>();
  const [chatRouteRequest, setChatRouteRequest] = useState<string | undefined>(() =>
    typeof window === "undefined" ? undefined : chatSessionIdFromHash(window.location.hash)
  );
  const [sessionLibrary, setSessionLibrary] = useState<SessionLibrary>();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [pendingForkRetryRevision, setPendingForkRetryRevision] = useState(0);
  const [railPreference, setRailPreference] = useState<RailPreference>(loadRailPreference);
  // The viewport is only ever the *first* answer. Once a person has collapsed
  // or expanded the rail in this width band, that choice wins on every later
  // load — the rail stops re-deciding for them every time a lid is opened.
  const [railViewport, setRailViewport] = useState(() => readRailViewport());
  const railState: RailState = resolveRailState(railPreference, railViewport);
  const [recentPaletteState, setRecentPaletteState] = useState<Readonly<{
    profileId: string;
    sessions: readonly Readonly<{ id: string; title: string; open(): void }>[];
  }>>(() => Object.freeze({ profileId: "", sessions: Object.freeze([]) }));
  const recentPaletteSessions = recentPaletteState.profileId === profileId
    ? recentPaletteState.sessions
    : Object.freeze([]);
  const [recentProfileConversations, setRecentProfileConversations] = useState<readonly RecentConversation[]>([]);
  const [proofSelection, setProofSelection] = useState<ProofSelection | undefined>(() =>
    typeof window === "undefined" ? undefined : proofSelectionFromHash(window.location.hash)
  );
  const [proofSelectionAuthority, setProofSelectionAuthority] = useState<Readonly<{
    profileId: string;
    sessionId: string;
  }>>();
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
  /*
   * Stop has to mean stop. `busy` alone cannot say why a turn ended: the
   * teardown that follows a completed turn and the teardown that follows an
   * abort both land on `setBusy(false)`, so the auto-dispatch effect below
   * read a user's Stop as "the model is free, send the next one" and fired the
   * queue's head immediately. This latch is the missing distinction — set by
   * `stopTurn`, cleared only by an explicit user send — so a stopped
   * conversation stays stopped until the person who stopped it says otherwise.
   */
  const [queuePaused, setQueuePaused] = useState(false);
  /*
   * The slash-command module travels with the registry it builds rather than
   * through first paint. Every call site was already gated on `slashRegistry`
   * being present, so binding the parser and completer to the same state adds
   * no new waiting: the registry is constructed inside the runtime boot that
   * already awaits several packs.
   */
  const [slashModule, setSlashModule] = useState<typeof import("../commands")>();
  const [slashRegistry, setSlashRegistry] = useState<SlashCommandRegistry>();
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashMenuDismissedFor, setSlashMenuDismissedFor] = useState<string>();
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceEntry[]>([]);
  const [selectedFileSelection, setSelectedFileSelection] = useState<EditorSelection>();
  const selectedFile = selectedFileSelection?.profileId === profileId
    ? selectedFileSelection.file
    : undefined;
  const [busy, setBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState("Starting local kernel");
  const [eventCount, setEventCount] = useState(0);
  const [connection, setConnection] = useState<ChutesConnection>(DISCONNECTED_CHUTES_CONNECTION);
  const [availableModels, setAvailableModels] = useState<readonly AirshipModel[]>([]);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<ConversationReceipt>();
  /**
   * Receipts for requests made beside a turn rather than in one.
   *
   * A turn receipt reaches Proof on the assistant row that carries it; a naming
   * receipt has no row until a reload replays it as a marker, so this is what
   * keeps it addressable in the meantime. Bounded and filtered by session at
   * the point of use: it outlives a conversation switch, and one conversation's
   * evidence must never be able to answer for another's.
   */
  const [ancillaryReceipts, setAncillaryReceipts] = useState<readonly ConversationReceipt[]>([]);
  const [sessionLifecycle, setSessionLifecycle] = useState<SessionLifecycle>(READY_SESSION_LIFECYCLE);
  const [transcriptBoundary, setTranscriptBoundary] = useState<Readonly<{
    omittedMessages: number;
    shortened: boolean;
  }>>();
  const [transcriptLeadingHeight, setTranscriptLeadingHeight] = useState(0);
  const [transcriptDetached, setTranscriptDetached] = useState(false);
  const [stageScrolled, setStageScrolled] = useState(false);
  const [invocationTelemetry, setInvocationTelemetry] = useState<ChutesInvocationTelemetry>();
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [oauthCallbackStatus, setOauthCallbackStatus] = useState<OAuthCallbackStatus>();
  const [activeOAuthRegistration, setActiveOAuthRegistration] = useState<ActiveOAuthRegistration>();
  const [oauthBootstrapRevision, setOauthBootstrapRevision] = useState(0);
  const [oauthTokenRevision, setOauthTokenRevision] = useState(0);
  const [attestationPresentation, setAttestationPresentation] = useState<AttestationPresentationState>();
  const [evidenceAcquisitionSnapshot, setEvidenceAcquisitionSnapshot] = useState<EvidenceAcquisitionQueueSnapshot>();
  /**
   * Whether a refused queue checkpoint is currently parking acquisition.
   *
   * State rather than a render-time read of the controller ref: the fault is not
   * part of the persisted snapshot, so a ref read had no reactive channel of its
   * own — the notice appeared only if something else happened to re-render, and
   * the self-heal effect had nothing to key on.
   */
  const [evidenceCheckpointFaulted, setEvidenceCheckpointFaulted] = useState(false);
  /** Re-runs the automatic vault adoptions once a cockpit transition has settled. */
  const [cockpitSettleRetry, setCockpitSettleRetry] = useState(0);
  const [attestationNow, setAttestationNow] = useState(() => Date.now());
  /** One automatic refresh request per expired observation record. */
  const automaticEvidenceRefreshes = useRef(new Set<string>());
  const [AttestationsScreen, setAttestationsScreen] = useState<AttestationsScreenComponent>();
  const [attestationsViewError, setAttestationsViewError] = useState<string>();
  const [EditorScreen, setEditorScreen] = useState<EditorScreenComponent>();
  const [editorViewError, setEditorViewError] = useState<string>();
  /**
   * How many times the shell has been *asked* for a destination.
   *
   * The hash alone cannot answer that question. A destination can be re-entered
   * without it changing — the rail and the phone tab bar both call `navigate`
   * with the view already on screen, and a same-document navigation to the
   * current URL fires `popstate` with an unchanged hash — while a route's own
   * in-page state has meanwhile moved somewhere else (the workbench opens a
   * file into its editor pane without leaving `#workspace`). A route that
   * re-applies its arrival state only when the hash *value* changes therefore
   * ignores every one of those requests. This counter is that missing event.
   */
  const [destinationArrival, setDestinationArrival] = useState(0);
  const [TerminalScreen, setTerminalScreen] = useState<TerminalScreenComponent>();
  const [terminalViewError, setTerminalViewError] = useState<string>();
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<Readonly<{
    id: string;
    cwd: string;
    name?: string;
    profileId: string;
    workspaceIdentity: string;
  }>>();
  const [CapabilitiesScreen, setCapabilitiesScreen] = useState<CapabilitiesScreenComponent>();
  /*
   * The same picker Connection opens, loaded on demand.
   *
   * Chat used to render a flattened `{id,label,detail}` projection through a
   * plain menu, which is why it grew a second capability formatter: it never
   * had the model objects the shared picker takes. It has them — `availableModels`
   * is right here — so the only thing missing was the component, and the only
   * reason it was missing is that the picker travels with its own stylesheet in
   * a deferred pack. Deferred load keeps the pack boundary and still ends the
   * second vocabulary.
   */
  const [ModelPickerControl, setModelPickerControl] = useState<ModelPickerComponent>();
  const [capabilitiesViewError, setCapabilitiesViewError] = useState<string>();
  const [MemoryScreen, setMemoryScreen] = useState<MemoryScreenComponent>();
  const [memoryViewError, setMemoryViewError] = useState<string>();
  const [GoogleDriveSetupScreen, setGoogleDriveSetupScreen] = useState<GoogleDriveSetupComponent>();
  const [LocalLabSetupScreen, setLocalLabSetupScreen] = useState<LocalLabSetupComponent>();
  const [LocalDeviceVaultSetupScreen, setLocalDeviceVaultSetupScreen] = useState<LocalDeviceVaultSetupComponent>();
  const [SessionsScreen, setSessionsScreen] = useState<SessionsScreenComponent>();
  /*
   * All conversations was the one lazy route with no terminal failure state.
   *
   * Its catch wrote `setRuntimeStatus(...)` and nothing else, and
   * `.runtime-line` is deleted below 640px — so a phone user whose chunk fetch
   * dropped sat on a skeleton that has no timeout and no retry, with the only
   * carrier of the reason removed by a media query.
   */
  const [sessionsViewError, setSessionsViewError] = useState<string>();
  const [quarantinedSession, setQuarantinedSession] = useState<QuarantinedSession>();
  const [VaultScreen, setVaultScreen] = useState<VaultScreenComponent>();
  const [vaultViewError, setVaultViewError] = useState<string>();
  const [AccessScreen, setAccessScreen] = useState<AccessScreenComponent>();
  const [ProviderConnectionsScreen, setProviderConnectionsScreen] = useState<ProviderConnectionsScreenComponent>();
  const [accessViewError, setAccessViewError] = useState<string>();
  /*
   * `provider-connections-view` is its own build asset, so it fails
   * independently of the pack that supplies `AccessScreen`. Its catch used to
   * write `accessViewError`, which is rendered only in the branch where
   * `AccessScreen` is *absent* — i.e. never, in the normal case — so the
   * OpenAI/Anthropic/xAI/local-server section spun forever and said nothing.
   */
  const [providerFabricError, setProviderFabricError] = useState<string>();
  /*
   * Same dead write, same route: a failed OAuth registration fetch reported
   * itself into `accessViewError`, whose branch the loaded Connection route
   * never reaches. It belongs in the Chutes panel's own notice, beside the
   * sign-in button it disables.
   */
  const [oauthRegistrationError, setOAuthRegistrationError] = useState<string>();
  const [BillingScreen, setBillingScreen] = useState<BillingScreenComponent>();
  const [billingViewError, setBillingViewError] = useState<string>();
  const [ProofScreen, setProofScreen] = useState<ProofScreenComponent>();
  const [proofViewError, setProofViewError] = useState<string>();
  const [ProofInspector, setProofInspector] = useState<ProofInspectorComponent>();
  /*
   * `proof-inspector` and `proof-view` are separate assets, so the claim stack
   * can fail while the route around it loads. Its catch was silent on the
   * premise that `#proof` reports the failure; `setProofViewError` is written
   * only by the `proof-view` catch, so nothing did — and the one route whose
   * promise is that state is never overstated showed an indefinite skeleton
   * where the verdict belongs.
   */
  const [proofInspectorError, setProofInspectorError] = useState<string>();
  /*
   * The second attempt every failed chunk lacked.
   *
   * The loaders below are keyed on `[view, Screen]`, so a user standing on the
   * failed route could not re-enter them by any means short of a reload — the
   * failure panels shipped a sentence and no control. Bumping this re-enters
   * every loader whose route is open and whose chunk is still missing; the
   * ones that already resolved early-return on their own guard.
   */
  const [deferredChunkAttempt, setDeferredChunkAttempt] = useState(0);
  const runtime = useRef<Runtime>();
  const catalogCheckpoint = useRef<ProfileCatalogCheckpoint>();
  const catalogMutationTail = useRef<Promise<void>>(Promise.resolve());
  const workspaceOpenRequest = useRef(0);
  const workspaceRefreshCoordinator = useMemo(() => new WorkspaceRefreshCoordinator(), []);
  const proofSelectionOperation = useRef(0);
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
      // The model reviewer only runs when a governed tool action actually needs
      // adjudicating, so it is fetched then rather than carried through first
      // paint by every visitor who never triggers one.
      const { reviewToolActionWithModel } = await import("../approvals/model-reviewer");
      const review = await reviewToolActionWithModel({
        transport: active.transport,
        model: active.model,
        tool,
        argumentsValue,
        context,
      });
      /*
       * The adjudication is a provider request the person never sees, made on
       * their behalf and billed to them, so it gets the same durable record any
       * other inference gets. It is keyed to the call being adjudicated —
       * `context.operationId` is the tool-call ID — because that is the only
       * identity it has: the review has no step of its own in the turn.
       *
       * Best-effort by construction. A journal that refuses this append must
       * not turn into a denied tool action, so the failure is swallowed after
       * the fact; the append is serialized per session by `EventJournal`, so it
       * cannot interleave with the turn's own chain.
       */
      if (review.inputTokens !== undefined || review.outputTokens !== undefined) {
        try {
          await active.journal.append(context.sessionId, [{
            type: "inference.usage",
            turnId: context.turnId,
            operationId: context.operationId,
            payload: {
              ...(review.inputTokens !== undefined ? { inputTokens: review.inputTokens } : {}),
              ...(review.outputTokens !== undefined ? { outputTokens: review.outputTokens } : {}),
              source: "approval-review",
              ...(review.requestId ? { requestId: review.requestId } : {}),
              ...(review.model ? { model: review.model } : {}),
            },
          }]);
        } catch {
          // A recorded cost must never become a denied action.
        }
      }
      return review;
    },
  }), [approvalBroker, activeApprovalMode]);
  const approvalPolicyController = useMemo(() => new SwitchableApprovalPolicy(approvalModePolicy), []);
  approvalPolicyController.replace(approvalModePolicy);
  const approvalPolicy = approvalPolicyController;
  /*
   * The policy a local slash command is reviewed under. Same `SwitchableApprovalPolicy`
   * indirection, because a local command is a long-running turn of its own and
   * the mode can be re-pinned while its dock prompt is up; the delegate that
   * decided is the one that owns the provenance.
   *
   * Separate from `approvalPolicy` because the proposer is different, not
   * because the seam is: `/write` still goes through `tools.review` →
   * `executeApproved`, so it still mints and consumes a registry ticket bound
   * to its argument digest. Only the adjudicator changes — the person who typed
   * the command is asked, instead of a model being asked about them.
   */
  const humanIntentModePolicy = useMemo(
    () => createHumanIntentPolicy({ mode: activeApprovalMode, broker: approvalBroker }),
    [approvalBroker, activeApprovalMode],
  );
  const humanIntentPolicyController = useMemo(() => new SwitchableApprovalPolicy(humanIntentModePolicy), []);
  humanIntentPolicyController.replace(humanIntentModePolicy);
  const localCommandPolicy = humanIntentPolicyController;
  const previousApprovalMode = useRef(activeApprovalMode);
  const vault = useMemo(() => new VaultCoordinator(), []);
  const [vaultSnapshot, setVaultSnapshot] = useState<VaultSnapshot>(() => vault.snapshot);
  const [vaultSetupOpen, setVaultSetupOpen] = useState(false);
  const [vaultProviderSwitching, setVaultProviderSwitching] = useState(false);
  /**
   * The last adoption failure, in the runtime's own words.
   *
   * `runtimeStatus` is one mixed-purpose line that the shell overwrites with
   * the next thing that happens anywhere, and the Vault route deliberately does
   * not read it. Without a state of its own, the route's "Runtime adoption"
   * row could only ever print the generic "still page-memory" sentence, and the
   * reason a verified vault refused to be adopted was visible for a moment on a
   * different screen.
   */
  const [vaultAdoptionNotice, setVaultAdoptionNotice] = useState<string>();
  const vaultProviderSwitchingRef = useRef(false);
  const activeDurableAuthority = useRef<DurableAdoptionDescriptor>();
  const localDeviceHandle = useRef<LocalDeviceVaultHandle>();
  const [localDeviceStatus, setLocalDeviceStatus] = useState<LocalDeviceVaultStatus>();
  const [vaultUsageFacts, setVaultUsageFacts] = useState<VaultUsageFacts>();
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
  const attestationCredentialKind = useRef<ActiveChutesConnection["credentialKind"]>();
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
  const attestationClientBinding = useRef<AttestationClientBinding>();
  const attestationClientGeneration = useRef(0);
  const attestationOperation = useRef(0);
  const endpointEvidenceAuthority = useRef<EndpointEvidenceAuthorityController>();
  const endpointEvidenceAuthorityLoad = useRef<EndpointEvidenceAuthorityLoad>();
  const endpointEvidenceAuthorityOperation = useRef(0);
  const evidenceScopeTransition = useRef(0);
  const evidenceAcquisitionQueue = useRef<EvidenceAcquisitionQueueController>();
  const evidenceAcquisitionQueueAuthority = useRef<EvidenceAcquisitionQueueAuthorityController>();
  const evidenceAcquisitionQueueLoad = useRef<EvidenceAcquisitionQueueLoad>();
  const evidenceAcquisitionQueueOperation = useRef(0);
  const evidenceAcquisitionUnsubscribe = useRef<() => void>();
  const activeTurn = useRef<AbortController>();
  const localCommandAdmission = useRef(false);
  const activePrompt = useRef<string>();
  const activeSessionIdentity = useRef<string>();
  const activeSessionByProfile = useRef(new Map<string, string>());
  /**
   * One workspace authority per Profile, for as long as the storage authority
   * behind it lives.
   *
   * Rebuilding a Profile's `ProfileWorkspacePort` on every switch would be
   * correct but not stable, and several things key on that object's identity
   * rather than on a string: the workbench's page-memory store of unsaved
   * drafts, and the terminal manager registry. A fresh port on every A→B→A
   * would silently discard exactly the work a Profile switch is supposed to
   * preserve. Entries are only reused while `storage` still matches, so a Vault
   * transition cannot resurrect a port over the previous authority.
   */
  const profileAuthorities = useRef(new Map<string, Readonly<{
    storage: WorkspacePort;
    workspace: WorkspacePort;
    workspaceId: string;
    git: BrowserGitClient;
    tools: Runtime["tools"];
    contextMode: Runtime["contextMode"];
  }>>());
  const queuedMessagesBySession = useRef(new Map<string, readonly QueuedComposerItem[]>());
  const queuedDispatch = useRef(false);
  const draftHydrationIdentity = useRef<string>();
  const preserveComposerForDraftIdentity = useRef<string>();
  const pendingForkRetry = useRef<Readonly<{
    sessionId: string;
    profileId: string;
    runtime: Runtime;
    prompt: string;
    attachments: readonly ComposerAttachment[];
  }>>();
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
  const pendingToolOutput = useRef<{ messageId: string; updates: Map<string, PendingToolOutputUpdate> }>();
  const pendingToolOutputFrame = useRef<number>();
  const profileOperation = useRef(0);
  const sessionNavigationChanging = useRef(false);
  const catalogAuthorityChanging = useRef(false);
  const vaultAdoptionBusy = useRef(false);
  const ephemeralAdoptionBusy = useRef(false);
  const profileDraftDirty = useRef(false);
  const currentView = useRef<View>(view);
  currentView.current = view;
  const observeExtensionBridge = useCallback(async (): Promise<ExtensionBridgeObservation> => {
    const { probeExtensionBridge } = await import("../capabilities/extension-bridge");
    return probeExtensionBridge();
  }, []);
  const liveEnvironmentSource = useMemo<LiveEnvironmentSupplementSource>(() => async ({ signal }) => {
    signal.throwIfAborted();
    const extension = await observeExtensionBridge();
    signal.throwIfAborted();
    const providers = combinedInferenceAvailability(
      inferenceFabric.current?.availability(activeExternalRouteRef.current?.pin)
        ?? EMPTY_INFERENCE_AVAILABILITY,
      chutesAvailability.current,
      runtime.current?.inferenceBinding,
    );
    return Object.freeze({
      providers: liveProviderEntries(providers),
      storage: liveStorageEntries(
        // Durability is a property of the storage authority, which is also what
        // the adoption descriptor names. The Profile-suffixed view would never
        // match it, and would report every adopted Vault as mid-transition.
        runtime.current?.storageId,
        activeDurableAuthority.current,
        runtime.current?.contextMode,
      ),
      extension: liveExtensionEntries(extension),
      limitations: Object.freeze([
        ...(providers.connections.length === 0
          ? ["No live inference provider connection is currently available; the immutable session pin remains authoritative."]
          : []),
        ...(extension.state === "available"
          ? []
          : ["No usable extension bridge was observed for this turn; extension storage and background compute are unavailable."]),
      ]),
    });
  }, []);
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

  /*
   * Any platform overlay (command palette, preferences, trust sheet, mobile
   * "more" sheet, approval prompt, profile transition) makes the routed
   * surface inert — but inert does not stop a window-level keydown, so a `g`
   * chord could swap the route and push history invisibly behind the dialog.
   * The navigation-jump hook consults this gate before acting on a chord.
   * Rail buttons and overlay-owned navigation (palette entries, trust-sheet
   * rows) call `navigatePrimary` directly and stay ungated.
   */
  const platformOverlayOpen = mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen || approvalPending || Boolean(profileCockpitTransition);
  const platformOverlayOpenRef = useRef(platformOverlayOpen);
  platformOverlayOpenRef.current = platformOverlayOpen;

  useGlobalPaletteShortcut(() => setPaletteOpen((open) => !open));
  useGlobalNavigationJumps(navigatePrimary, () => !platformOverlayOpenRef.current);
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
  useEffect(() => {
    const requested = proofSelection;
    const active = runtime.current;
    const expectedProfileId = profileAuthorityId.current;
    const operation = ++proofSelectionOperation.current;
    if (
      view !== "proof"
      || !requested
      || !active
      || !sessionId
      || requested.sessionId === sessionId
    ) {
      setProofSelectionAuthority(undefined);
      return;
    }
    let disposed = false;
    setProofSelectionAuthority(undefined);
    void active.journal.getSession(requested.sessionId).then((target) => {
      if (
        disposed
        || operation !== proofSelectionOperation.current
        || runtime.current !== active
        || profileAuthorityId.current !== expectedProfileId
        || currentView.current !== "proof"
        || proofSelectionFromHash(window.location.hash)?.sessionId !== requested.sessionId
      ) return;
      if (target && profileOwnsSession(target, expectedProfileId)) {
        setProofSelectionAuthority(Object.freeze({
          profileId: expectedProfileId,
          sessionId: requested.sessionId,
        }));
        return;
      }
      const fallback = proofSelectionForSession(activeSessionIdentity.current);
      setProofSelection(fallback);
      setProofSelectionAuthority(undefined);
      const canonical = proofHash(fallback, proofSection);
      if (window.location.hash !== canonical) {
        window.history.replaceState({ view: "proof" }, "", canonical);
      }
      setRuntimeStatus("Proof is scoped to the active Profile. Switch Profiles before opening that session's evidence.");
    }).catch(() => {
      if (disposed || operation !== proofSelectionOperation.current) return;
      const fallback = proofSelectionForSession(activeSessionIdentity.current);
      setProofSelection(fallback);
      setProofSelectionAuthority(undefined);
    });
    return () => { disposed = true; };
  }, [profileId, proofSection, proofSelection?.sessionId, sessionId, view]);
  const activeTheme = activeProfile
    ? catalog?.themes.find((theme) => theme.themeId === activeProfile.theme.themeId && theme.digest === activeProfile.theme.digest)
    : undefined;
  /** True once the boot screen has been replaced by the real shell chrome. */
  const shellMounted = Boolean(catalog && activeProfile && activeTheme);
  const activeAttestationPresentation = attestationPresentation
    && runtime.current
    && attestationPresentation.workspace === runtime.current.workspace
    && attestationPresentation.workspaceId === runtime.current.workspaceId
    && attestationPresentation.profileId === profileId
    && attestationPresentation.sessionId === sessionId
      ? attestationPresentation
      : undefined;
  const attestationRecords = activeAttestationPresentation?.records ?? Object.freeze([]);
  const attestationFailure = activeAttestationPresentation?.failure;
  const selectedAttestationRecordId = activeAttestationPresentation?.selectedRecordId;
  const endpointEvidenceDurabilityNotice = activeAttestationPresentation?.durabilityNotice;
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
  /*
   * The same fact, addressed to the Account route.
   *
   * Account's provider tabs default to `unavailable`, which is written for "the
   * host said nothing" — and nothing ever said anything, so a working OpenAI
   * connection read as an absent capability. This states connection only: no
   * quota, usage, reset or identity is invented, because none of it is
   * observed. Nothing is emitted until the fabric exists, so "not observed yet"
   * still falls through to `unavailable` rather than being claimed as absence.
   */
  const billingProviderInventory = useMemo(
    () => inferenceFabric.current
      ? Object.freeze(BILLING_INVENTORY_PROVIDER_IDS.map((providerId) => Object.freeze({
          providerId,
          state: connectedInferenceProviderIds.includes(providerId) ? "connected" as const : "not-connected" as const,
        })))
      : undefined,
    [connectedInferenceProviderIds, Boolean(inferenceFabric.current)],
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
      ? `${activeExternalConnection.pin.model.id} · invocation checked · ${providerBoundaryLabel(activeExternalConnection.pin.provider.transportBoundary)}`
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
  /*
   * Whether "encrypted request" is a claim this composer may make.
   *
   * Only the app-encrypted boundary earns the word: `provider-tls` is
   * plaintext beyond TLS (its posture chip reads "Remote · not encrypted end
   * to end"), `loopback-local` never leaves the machine and needs no cipher
   * claim, and the demo makes no request at all. Every attachment sentence
   * below speaks through this one derivation so chip and refusal cannot drift.
   */
  const composerRequestEncrypted = activeInferenceBinding?.transportBoundary === "e2ee-attestable";
  const sessionRuntime = activeSessionRecord && runtime.current
    ? activeSessionRuntime(runtime.current, activeSessionRecord)
    : undefined;
  // The menu shows ten rows out of a command set that is routinely three times
  // that, so it carries the total as well as the slice: a list that silently
  // stops at ten tells the user those ten are everything, which is the exact
  // reason `/help` was believed not to exist.
  const slashMenu = useMemo(
    () => slashRegistry && slashModule
      ? slashModule.completeSlashCommandMenu(input, slashRegistry, { limit: 10 })
      : { completions: [], total: 0 },
    [input, slashRegistry, slashModule],
  );
  const slashCompletions = slashMenu.completions;
  const paletteEntries = useMemo(() => buildPaletteEntries({
    navigate: navigatePrimary,
    openPreferences: () => setPreferencesOpen(true),
    commands: slashRegistry?.descriptors(),
    sessions: recentPaletteSessions,
    runCommand: (command) => {
      // A palette command used to replace the composer outright, and the
      // debounced draft writer then persisted the command over the stored
      // draft — one palette visit destroyed an unsent message. With a draft
      // in the box the command inserts at the caret; the replace survives
      // only where the composer is empty or already a slash line, which is
      // the case the palette was built for.
      setInput((current) => insertDraftCommandAtCaret(
        current,
        command,
        textarea.current?.selectionStart ?? current.length,
      ));
      navigate("chat");
      requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
    },
  }), [slashRegistry, lastReceipt, sessionId, recentPaletteSessions]);
  // The rail's chord has a searchable twin: a shortcut nobody can discover is
  // a shortcut that does not exist, and the chevron is 700px away on a laptop.
  const paletteEntriesWithRail = useMemo(() => Object.freeze([
    ...paletteEntries,
    Object.freeze({
      id: "rail:toggle",
      label: railState === "standard" ? "Collapse navigation rail" : "Expand navigation rail",
      description: railState === "standard"
        ? "Icons only, labels on hover · ⌘\\"
        : "Show every destination label · ⌘\\",
      keywords: ["rail", "sidebar", "navigation", "collapse", "expand", "focus"],
      group: "Preferences" as const,
      run: toggleRailState,
    }),
  ]), [paletteEntries, railState, railPreference, railViewport]);
  const slashMenuOpen = slashCompletions.length > 0 && !busy && slashMenuDismissedFor !== input;
  const composerPlan = useMemo(
    () => input.trim() && slashRegistry && slashModule ? slashModule.planSlashCommand(input.trim(), slashRegistry) : undefined,
    [input, slashRegistry, slashModule],
  );
  const composerOfflineBlocked = remoteComposerBlocked(
    online,
    Boolean(inferenceConnected && activeRemoteInference),
    Boolean(composerPlan && composerPlan.kind !== "chat"),
  );
  const composerUsesDemo = !inferenceConnected && (!composerPlan || composerPlan.kind === "chat");
  /** Attachments staged, nothing typed: the one disabled Send that needs a reason. */
  const attachmentsAwaitText = attachments.length > 0 && !input.trim();
  /*
   * A model or storage transition holds Send the same way it holds Enter.
   *
   * Enter already names the reason (below); the pointer path disabled the same
   * button with no word at all, and a `title` on a disabled control is
   * unreachable for touch and for most screen readers — the reason belongs in
   * the accessible name as well as in `title`. One sentence, three surfaces.
   */
  const composerTransitionPending = modelSwitching || vaultProviderSwitching || localDeviceBusy;
  const windowedTranscript = useWindowedTranscript({
    items: messages,
    scrollContainerRef: transcriptElement,
    getKey: uiMessageKey,
    getRevision: uiMessageRevision,
    estimateHeight: uiMessageEstimate,
    leadingOffset: transcriptLeadingHeight,
  });
  const inPageReceipts = useMemo(
    () => proofResolvableReceipts(ancillaryReceipts, messages, sessionId),
    [ancillaryReceipts, messages, sessionId],
  );

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    // The measure/toggle/re-measure branch this replaces existed only to damp
    // an oscillation between a one-row and a two-row composer. The composer is
    // two rows at every width now, so the textarea's width is constant while it
    // grows and the oscillation is not reachable — which also means a 23-char
    // prompt can no longer be forced onto two lines by a footer stealing 450px.
    const fit = () => fitComposerTextarea(element);
    // Text scrolled above the cap has to read as scrolled rather than as a
    // half-sliced rendering fault, so the fade is driven by real scroll state.
    const markScroll = () => markComposerScroll(element);
    fit();
    const resizeTargets = [window, window.visualViewport];
    resizeTargets.forEach((target) => target?.addEventListener("resize", fit));
    element.addEventListener("scroll", markScroll, { passive: true });
    /*
     * The element's own `input` event, not only the `[input]` state dep.
     *
     * Re-fitting solely from state means any path that changes the value
     * without settling that state on the same frame leaves the box at its
     * previous height — which is how clearing a twelve-line draft left the
     * composer 136px tall over an empty field. The textarea's own event is the
     * authoritative signal that its content changed, and `fit` is idempotent,
     * so running it from both is free.
     */
    element.addEventListener("input", fit);
    return () => {
      resizeTargets.forEach((target) => target?.removeEventListener("resize", fit));
      element.removeEventListener("scroll", markScroll);
      element.removeEventListener("input", fit);
    };
  }, [input]);

  useEffect(() => setSlashSelection(Math.max(0, firstEnabledSlashIndex(slashCompletions))), [input, slashCompletions]);
  useEffect(() => observeConnectivity(window, navigator, setOnline), []);
  useEffect(() => {
    if (!catalog || profileHubScope === "global") return;
    if (!managedProfiles(catalog).some((profile) => profile.profileId === profileHubScope)) {
      setProfileHubScope("global");
    }
  }, [catalog, profileHubScope]);
  /*
   * The recents shortcuts want a turn boundary; `sessionRevision` is a durable
   * *event* counter. A single turn bumps it once per request, per tool call and
   * per completion, and each bump re-listed and re-decrypted the whole library
   * twice — once for the palette and once for the rail — for a sidebar nobody
   * can read mid-stream anyway. The trailing edge of the burst is the only
   * value that was ever going to be rendered.
   */
  const settledSessionRevision = useDebouncedValue(sessionRevision, RECENTS_REFRESH_DEBOUNCE_MS);
  useEffect(() => {
    if (!sessionLibrary) {
      setRecentPaletteState(Object.freeze({ profileId: "", sessions: Object.freeze([]) }));
      return;
    }
    const controller = new AbortController();
    void loadRecentSessionPaletteSources(
      sessionLibrary,
      (targetSessionId) => { void openPaletteSession(targetSessionId); },
      controller.signal,
      profileId,
    ).then((sessions) => {
      if (!controller.signal.aborted) setRecentPaletteState(Object.freeze({ profileId, sessions }));
    }).catch((error) => {
      if (!controller.signal.aborted) setRuntimeStatus(error instanceof Error ? error.message : "Recent sessions are unavailable.");
    });
    return () => controller.abort();
  }, [sessionLibrary, settledSessionRevision, profileId]);
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
        if (error instanceof UnknownSessionError) {
          // Absence is final, so holding the URL open for it is not patience —
          // it is a permanent dead address. `chatRouteRequest` is also what
          // suppresses canonicalisation, so clearing it lets the effect below
          // rewrite the hash to the conversation that is actually open.
          //
          // The unsent draft is the person's, not the dead conversation's, so
          // it moves onto the conversation that replaces the address before the
          // request is cleared. Without this, resetting the route re-keys the
          // composer to the live conversation, hydrates an empty draft over the
          // text that was typed a moment before the reload, and destroys it.
          adoptDraftFromUnresolvableAddress(requestedSessionId);
          setChatRouteRequest((current) => current === requestedSessionId ? undefined : current);
          setComposerNotice("That conversation existed only in page memory and did not survive the reload. This is a new conversation.");
          return;
        }
        // Keep the URL intact: a durable conversation can become available
        // after its Vault or exact inference connection is restored.
        void loadDeferredCapabilities().then(({ describeSessionPresentationFault }) => {
          setComposerNotice(
            error instanceof Error
              ? `This conversation link is not available in the current runtime: ${describeSessionPresentationFault(error)}`
              : "This conversation link is not available in the current runtime. Connect its Vault and exact inference provider, then retry.",
          );
        });
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
    const ownerProfileId = profileId;
    const ownerRuntime = runtime.current;
    const presentMutationFailure = (error: unknown) => {
      if (
        controller.signal.aborted
        || runtime.current !== ownerRuntime
        || profileAuthorityId.current !== ownerProfileId
      ) return;
      setRuntimeStatus(error instanceof Error ? error.message : "The conversation preference could not be saved.");
    };
    void loadRecentConversations(
      sessionLibrary,
      (targetSessionId) => { void openPaletteSession(targetSessionId); },
      (targetSessionId, favorite) => {
        void setProfileConversationFavorite(targetSessionId, favorite, ownerProfileId, ownerRuntime)
          .catch(presentMutationFailure);
      },
      (targetSessionId, beforeSessionId) => {
        void moveProfileConversationFavorite(targetSessionId, beforeSessionId, ownerProfileId, ownerRuntime)
          .catch(presentMutationFailure);
      },
      controller.signal,
      profileId,
      recentConversationPreviewCache.current,
      sessionId,
    ).then(setRecentProfileConversations).catch((error) => {
      if (!controller.signal.aborted) setRuntimeStatus(error instanceof Error ? error.message : "Recent conversations are unavailable.");
    });
    return () => controller.abort();
    // `sessionId` is a real input now, not incidental state: the lineage
    // collapse pins the active conversation's row, so switching branches has
    // to recompute which member of a lineage the shortcut is showing.
  }, [sessionLibrary, settledSessionRevision, profileId, sessionId]);
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
  /*
   * Shell work joins the one timeline.
   *
   * Terminal lineage was complete and durable and reachable from exactly one
   * `<summary>` popover: a command that rewrote the workspace produced no
   * journal event, so Proof audited a chain with a hole where the shell is, and
   * the product's claim — intent → effect → workspace head → receipt — was true
   * of tools and false of `jsh`.
   *
   * The binding is the terminal's own `threadId`, not the conversation that
   * happens to be on screen. A terminal opened from a conversation keeps
   * writing to that conversation after the reader navigates away, and a
   * terminal with no thread writes nowhere rather than borrowing someone
   * else's journal — its record still lives in the manager's own bounded set,
   * and claiming the journal has it would be the worse of the two failures.
   *
   * Appends are chained rather than fired in parallel because the journal is a
   * hash chain: two concurrent appends race the head digest, and the loser is a
   * conflict, not a queued write.
   */
  const terminalAuditTail = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => subscribeTerminalAuditRecords((record, terminalSession) => {
    const threadId = terminalSession.threadId;
    const active = runtime.current;
    if (!threadId || !active) return;
    const draft = terminalActivityEvent(record, terminalSession);
    terminalAuditTail.current = terminalAuditTail.current
      .then(() => active.journal.append(threadId, [{ type: draft.type, payload: draft.payload }]))
      .then(() => undefined)
      // Stated, never swallowed: an unrecorded shell action is exactly the gap
      // this closes, and a silent catch would reproduce it one layer up.
      .catch((error) => {
        setRuntimeStatus(`A ${record.kind} record from terminal ${terminalSession.name} could not be journaled: ${error instanceof Error ? error.message : "the session journal refused the append"}`);
      });
  }), [observeExtensionBridge]);
  useEffect(() => {
    if (
      !sessionId
      || profileCockpitTransition
      || activeSessionRecord?.manifest.profile?.profileId !== profileId
    ) return;
    const restored = readThreadViewport(profileId, sessionId, browserThreadViewportStorage());
    transcriptPinned.current = restored?.pinnedToLatest ?? true;
    transcriptEntryAlignment.current = !restored;
    setTranscriptDetached(restored ? !restored.pinnedToLatest : false);
    setStageScrolled((restored?.scrollTop ?? 0) > SESSION_BAR_COLLAPSE_SCROLL);
    if (!restored || restored.pinnedToLatest) return;
    let frame: number | undefined;
    let pass = 0;
    const restore = () => {
      const element = transcriptElement.current;
      if (!element) return;
      element.scrollTop = Math.min(restored.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight));
      pass += 1;
      // Windowed rows replace estimates with measured heights over the next
      // frames. Reapply the saved coordinate after those bounded anchor
      // corrections so A → B → A returns to A's reading position, not merely
      // to a generic detached posture.
      if (pass < 3) frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    const settle = window.setTimeout(restore, 120);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [profileId, sessionId, profileCockpitTransition, activeSessionRecord?.manifest.profile?.profileId]);
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
  /**
   * Moves an unsent draft off a conversation address that can never resolve.
   *
   * Drafts are stored per conversation, so a reset route would otherwise
   * re-key the composer to the live conversation and hydrate its empty draft
   * over text the person typed seconds earlier. The composer is claimed for
   * the live identity through the same preserve fence that a fork uses, and
   * the dead key is dropped so the text is never restored twice.
   */
  function adoptDraftFromUnresolvableAddress(unresolvableSessionId: string): void {
    const liveSessionId = activeSessionIdentity.current ?? sessionId;
    if (!liveSessionId || liveSessionId === unresolvableSessionId) return;
    try {
      const carried = readThreadDraft(unresolvableSessionId, sessionStorage);
      writeThreadDraft(unresolvableSessionId, "", sessionStorage);
      if (!carried) return;
      preserveComposerForDraftIdentity.current = liveSessionId;
      setInput((current) => current || carried);
      writeThreadDraft(liveSessionId, carried, sessionStorage);
    } catch {
      // Draft persistence is optional; the live composer remains authoritative.
    }
  }
  useEffect(() => {
    const pending = pendingForkRetry.current;
    if (!pending || busy || sessionNavigationChanging.current) return;
    if (
      pending.sessionId !== sessionId
      || pending.runtime !== runtime.current
      || pending.profileId !== profileAuthorityId.current
      || activeSessionIdentity.current !== pending.sessionId
    ) {
      pendingForkRetry.current = undefined;
      return;
    }
    pendingForkRetry.current = undefined;
    void sendMessage(pending.prompt, pending.attachments).then((admitted) => {
      // A pre-admission refusal (offline, pinned route, image capability)
      // consumes nothing: the fork already cleared the branch composer and
      // the branch is not the source, so a refused regeneration would leave
      // the prompt nowhere. Hand it back to the branch composer — but never
      // over anything typed in the meantime.
      if (admitted) return;
      setInput((current) => (current.trim() ? current : pending.prompt));
      setAttachments((current) => (current.length ? current : pending.attachments));
    });
  }, [busy, pendingForkRetryRevision, profileId, sessionId]);
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
      || queuePaused
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
    // `online`/`inferenceConnected` are not read here, but sendMessage's
    // pre-admission refusals are keyed on them: a dispatch refused offline
    // leaves the head in place with no other dep changing, so without these
    // the restored connection never retried the head. The refusal itself is
    // side-effect-safe to re-fire for an unchanged head — it only re-states
    // the notice — and never calls onAdmitted, so no loop and no loss.
  }, [busy, inferenceConnected, messageQueue, online, queuePaused, sessionId]);
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
  const proofSelectionAuthorized = !proofSelection
    || proofSelection.sessionId === sessionId
    || (
      proofSelectionAuthority?.profileId === profileId
      && proofSelectionAuthority.sessionId === proofSelection.sessionId
    );
  const effectiveProofSelection = proofSelectionAuthorized
    ? proofSelection
    : proofSelectionForSession(sessionId);
  const proofTargetId = effectiveProofSelection?.sessionId ?? sessionId;
  const proofReceipt = resolveProofReceipt(
    inPageReceipts,
    effectiveProofSelection,
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
  const automaticEvidenceAcquisitionNotice = evidenceAcquisitionNotice(
    evidenceAcquisitionSnapshot,
    proofReceipt?.receiptId,
    evidenceCheckpointFaulted,
  );
  const localDeviceRuntimeAdopted = Boolean(
    localDeviceStatus
    && runtime.current?.storageId.startsWith("vault+local-device://"),
  );
  const cloudVaultRuntimeAdopted = vaultSnapshot.phase === "ready"
    && runtime.current?.storageId.startsWith("vault+") === true
    && !runtime.current?.storageId.startsWith("vault+local-device://");
  // Detectable from the adopted snapshot's own configuration, not the selected
  // preference: the claim that follows is about the runtime that is live.
  const googleDriveVaultAdopted = cloudVaultRuntimeAdopted
    && vaultSnapshot.phase === "ready"
    && isGoogleDriveConfiguration(vaultSnapshot.config);
  const localS3VaultRuntimeAdopted = cloudVaultRuntimeAdopted
    && vaultSnapshot.phase === "ready"
    && !isGoogleDriveConfiguration(vaultSnapshot.config)
    && vaultSnapshot.config.mode === "local-development";
  const vaultRuntimeAdopted = localDeviceRuntimeAdopted || cloudVaultRuntimeAdopted;
  // Declared here rather than beside the other global hooks because adoption is
  // one of its three terms, and adoption is what decides whether closing the tab
  // costs anything at all.
  const releaseUnloadGuard = useBeforeUnloadGuard(unloadWouldLoseWork({
    busy,
    eventCount,
    vaultAdopted: vaultRuntimeAdopted,
  }));
  const trustAxes: readonly TrustAxis[] = Object.freeze([
    { id: "local", scope: "tab", label: online ? "Browser / Edge runtime" : OFFLINE_RUNTIME_LABEL, state: online ? "none" : "attention", detail: online ? "The agent kernel executes in this browser." : OFFLINE_RUNTIME_DETAIL, view: "proof" },
    {
      id: "vault",
      // Vault *adoption* is a property of this tab's runtime; where this
      // conversation's journal actually lives is the session bar's durability
      // claim. Two claims, two bands, and the labels stopped matching in
      // round 1 so the scope tag now records why.
      scope: "tab",
      label: localDeviceRuntimeAdopted
        ? "Local Device Vault active"
        : localS3VaultRuntimeAdopted
          ? "Local S3 Vault active"
          : googleDriveVaultAdopted && !online
            ? "Vault adopted · currently unreachable"
            : cloudVaultRuntimeAdopted
            ? "Cloud Vault active"
          : preferences.vaultBackend === "local-device"
            ? localDeviceBusy ? "Opening Local Device Vault" : "Local Device setup"
            // "Ephemeral" here answered "is a vault backend adopted in this
            // tab", while the session chip's "Ephemeral · this page only"
            // answers "where does *this conversation's* journal live". Two
            // different claims that read identically only because both are
            // currently empty. Naming the axis for what it measures is what
            // stops one screen printing the same word twice for two facts.
            : vaultSnapshot.phase === "ready" ? "Vault adoption pending" : vaultSnapshot.phase === "probing" ? "Vault testing" : vaultSnapshot.phase === "configured" ? "Vault configured" : vaultSnapshot.phase === "degraded" ? "Vault blocked" : "No vault adopted",
      state: vaultRuntimeAdopted
        // Adoption is a local fact and stays true offline; "verified" is not.
        // A Drive-backed runtime cannot be reached without connectivity, so
        // the axis degrades instead of certifying a sync that cannot run.
        ? googleDriveVaultAdopted && !online ? "attention" : "verified"
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
        : googleDriveVaultAdopted && !online
          ? "The adopted client-encrypted Google Drive runtime cannot be reached while this browser is offline; nothing is synchronizing and no local claim has changed."
          : cloudVaultRuntimeAdopted
          ? "This page uses the tested client-encrypted cloud workspace, journal, and profile adapters; cross-device convergence is not certified."
          : localDeviceError ?? (vaultSnapshot.phase === "ready"
            ? "The storage contract passed, but this active runtime is still page-memory until adoption completes."
            : vaultSnapshot.message),
      view: "vault",
    },
    { id: "e2ee", scope: "conversation", label: inferenceStatusLabel, state: activeChutesConnection ? (connection.invokeAuthorization === "verified" ? "verified" : "asserted") : activeExternalConnection ? "asserted" : "none", detail: inferenceStatusDetail, view: "access" },
    { id: "attestation", scope: "conversation", label: attestationSeal.label, state: attestationSeal.state, detail: attestationSeal.detail, view: "proof" },
  ]);
  const attestationReceipts = useMemo(() => sessionAttestationReceipts({
    messages,
    sessionId,
    selectedRecordId: selectedAttestationRecordId,
  }), [messages, sessionId, selectedAttestationRecordId]);
  /*
   * The Proof route carries two identities and must enforce one.
   *
   * `proofTargetId` is the conversation the route is *about* — the library can
   * open Proof for a conversation that was never resumed. Endpoint evidence,
   * receipts and acquisition failures, by contrast, are only ever acquired for
   * the ACTIVE conversation: `activeAttestationPresentation` is fenced on
   * `sessionId` a few hundred lines above. Handing the active collections to a
   * route scoped to a different session is how conversation A's TDX quotes end
   * up inside a verification bundle stamped `scope.sessionId === B`. When the
   * two identities diverge the route is given nothing, and says so.
   */
  const proofScoped = proofTargetId === sessionId;
  const proofEndpointRecords = proofScoped ? attestationRecords : EMPTY_ENDPOINT_EVIDENCE;
  const proofLedgerReceipts = proofScoped ? attestationReceipts : EMPTY_CONVERSATION_RECEIPTS;
  const ledgerSelectedRecordId = proofScoped
    ? selectedAttestationRecordId
      ?? (effectiveProofSelection?.receiptId ? `receipt:${effectiveProofSelection.receiptId}` : undefined)
    : undefined;
  /*
   * One turn, one verdict — including its modifier.
   *
   * `describeMessageAttestation` already admits an acquisition failure onto a
   * turn only when `attestationFailureAppliesToReceipt` holds, so the Proof
   * hero and the claim rail must apply the same predicate or the same turn
   * reads "evidence not pulled" in the transcript and says nothing about it on
   * the route dedicated to saying it.
   */
  const proofAcquisitionFailure = proofScoped
    && attestationFailure
    && (!proofReceipt || attestationFailureAppliesToReceipt(attestationFailure, proofReceipt))
      ? attestationFailure.label
      : undefined;
  const inspectorAcquisitionFailure = attestationFailure
    && (!lastReceipt || attestationFailureAppliesToReceipt(attestationFailure, lastReceipt))
      ? attestationFailure.label
      : undefined;

  async function activateSession(session: SessionRecord): Promise<SessionRecord> {
    const sessionProfileId = session.manifest.profile?.profileId;
    const activeRuntime = runtime.current;
    if (!sessionProfileId || !activeRuntime) {
      throw new Error("The selected conversation is not bound to an active profile journal.");
    }
    const selection = await new SessionLibrary(activeRuntime.journal).selectActiveConversation(
      sessionProfileId,
      session.id,
      { expectedTargetHead: { sequence: session.headSequence, digest: session.headDigest } },
    );
    const selected = selection.session;
    // Update the identity fence synchronously. An aborted prior turn can still
    // deliver its final durable signal before Preact commits the next render.
    activeSessionIdentity.current = selected.id;
    setSessionId(selected.id);
    setActiveSessionRecord(selected);
    activeSessionByProfile.current.set(sessionProfileId, selected.id);
    setMessageQueue(queuedMessagesBySession.current.get(selected.id) ?? []);
    // The pause belongs to the conversation that was stopped, not to the app.
    setQueuePaused(false);
    return selected;
  }

  useEffect(() => () => {
    approvalBroker.denyAll();
    vaultContextPublication.current?.abort(new DOMException("Airship is closing.", "AbortError"));
    attestationOperation.current += 1;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    attestationClientBinding.current = undefined;
    endpointEvidenceAuthorityOperation.current += 1;
    endpointEvidenceAuthorityLoad.current = undefined;
    void endpointEvidenceAuthority.current?.release();
    evidenceAcquisitionQueueOperation.current += 1;
    evidenceAcquisitionUnsubscribe.current?.();
    evidenceAcquisitionUnsubscribe.current = undefined;
    evidenceAcquisitionQueue.current?.dispose();
    evidenceAcquisitionQueue.current = undefined;
    evidenceAcquisitionQueueLoad.current = undefined;
    void evidenceAcquisitionQueueAuthority.current?.release();
    providerCredential.current = undefined;
  }, [approvalBroker]);

  // Endpoint proof and its scheduler are one Profile cockpit. A switch first
  // pauses the no-longer-authoritative worker/client, then installs a client
  // fenced to the new Profile+WorkspacePort, recovers that Profile's records,
  // and only then resumes persisted queue work. A disconnected page never
  // burns queue attempts merely because no credential-backed client exists.
  useEffect(() => {
    const active = runtime.current;
    if (!active) return;
    const credential = providerCredential.current;
    const credentialKind = attestationCredentialKind.current;
    if (!credential || !credentialKind) {
      setEvidenceAcquisitionSnapshot(undefined);
      return;
    }
    void rebindProfileEvidenceScope(active, profileId, credential, credentialKind)
      .catch((error) => publishAttestationFailureForCurrent({
        label: error instanceof Error && error.message.includes("checkpoint")
          ? "Stored endpoint evidence rejected"
          : "Evidence client unavailable",
        scope: "connection",
      }));
    // Runtime authority changes with the same Profile are rebound explicitly
    // by storage transitions; Profile identity is this effect's only key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

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

  /**
   * Holds an automatic durable adoption outside a cockpit transition.
   *
   * A profile switch and a vault adoption publish the *same* unit — the runtime,
   * the Git client, the slash registry, the catalog checkpoint, the session
   * library and the active conversation — and neither is atomic across its
   * awaits. Landing one inside the other half-commits both: `changeProfile`
   * captures the outgoing runtime, an adoption replaces `runtime.current`
   * mid-negotiation, and the switch then unwinds its own half over an adopted
   * Vault, leaving a catalog checkpoint minted by a store the runtime no longer
   * points at. `sessionNavigationChanging` is the latch every transition already
   * sets, and each one clears it in a `finally`, so waiting is bounded.
   *
   * Waiting, not refusing: these two adoptions are automatic consequences of a
   * stored preference, so the caller has nobody to report a refusal to. The
   * returned cleanup is the effect's own — re-checking is a re-run, which
   * re-evaluates every other precondition at the same time.
   */
  function deferAdoptionUntilCockpitSettles(): (() => void) | undefined {
    if (!sessionNavigationChanging.current) return undefined;
    const timer = window.setTimeout(() => setCockpitSettleRetry((value) => value + 1), 150);
    return () => window.clearTimeout(timer);
  }

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
      || runtime.current.storageId.startsWith("vault+local-device://")
    ) return;
    const deferred = deferAdoptionUntilCockpitSettles();
    if (deferred) return deferred;
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
  }, [preferences.vaultBackend, catalog, activeProfile, gitClient, vaultProviderSwitching, cockpitSettleRetry]);

  // Readiness is not durability until the verified adapters replace the active
  // page-memory runtime. This effect waits for both halves, then adopts once.
  useEffect(() => {
    if (
      (preferences.vaultBackend !== "google-drive" && preferences.vaultBackend !== "local-lab") ||
      vaultSnapshot.phase !== "ready" ||
      !runtime.current ||
      runtime.current.storageId.startsWith("vault+") ||
      !catalog ||
      !activeProfile ||
      !gitClient ||
      vaultAdoptionBusy.current
    ) return;
    const deferred = deferAdoptionUntilCockpitSettles();
    if (deferred) return deferred;
    vaultAdoptionBusy.current = true;
    void adoptReadyVaultRuntime(vaultSnapshot, vault.readyRuntime())
      // Cleared on success so a later retry cannot leave a stale reason under
      // an adoption that has since worked.
      .then(() => setVaultAdoptionNotice(undefined))
      .catch((error) => {
        const message = error instanceof Error
          ? `Local vault adoption failed: ${error.message}`
          : "Local vault adoption failed safely";
        setRuntimeStatus(message);
        setVaultAdoptionNotice(message);
      })
      .finally(() => { vaultAdoptionBusy.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.vaultBackend, vaultSnapshot, catalog, activeProfile, gitClient, cockpitSettleRetry]);

  // Ephemeral is an explicit operating mode. If an encrypted vault is active, copy
  // the live state into fresh page-memory adapters before dropping credentials.
  useEffect(() => {
    if (preferences.vaultBackend !== "ephemeral" || ephemeralAdoptionBusy.current) return;
    if (!runtime.current?.storageId.startsWith("vault+")) {
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

  /*
   * The Vault route's usage strip.
   *
   * Every provider answers "what are you holding" from its own evidence: the
   * cloud store lists its namespace, the device Vault reports the browser's
   * own storage estimate, and page memory honestly has no enumerable bytes —
   * what it can count is the work recorded in it this session. A provider
   * that cannot answer renders nothing rather than a guessed zero.
   */
  useEffect(() => {
    if (view !== "vault") { setVaultUsageFacts(undefined); return; }
    const backend = preferences.vaultBackend;
    let cancelled = false;
    const publish = (facts: VaultUsageFacts | undefined) => { if (!cancelled) setVaultUsageFacts(facts); };
    const detach = () => { cancelled = true; };
    if (backend === "ephemeral") {
      publish({ notes: [
        `${sessionRevision.toLocaleString()} durable event${sessionRevision === 1 ? "" : "s"} recorded this page session`,
        "Page memory — nothing survives closing this tab",
      ] });
      return detach;
    }
    if (backend === "local-device") {
      if (!localDeviceStatus) { publish(undefined); return detach; }
      publish({
        bytes: localDeviceStatus.readiness.usageBytes,
        quotaBytes: localDeviceStatus.readiness.quotaBytes,
        notes: [localDeviceStatus.readiness.backend === "opfs" ? "Origin Private File System" : "IndexedDB fallback"],
      });
      return detach;
    }
    if (vaultSnapshot.phase !== "ready") { publish(undefined); return detach; }
    void vault.collectStorageStats().then((stats) => publish(stats
      ? { objects: stats.objectCount, bytes: stats.totalBytes }
      : undefined));
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, preferences.vaultBackend, vaultSnapshot, localDeviceStatus, sessionRevision]);

  /*
   * The queue's own recovery channel, keyed on the fault and nothing else.
   *
   * A refused checkpoint write parks `schedule()` until an explicit `wake()`,
   * and this is the only production caller of it — so where it is driven from
   * decides whether the "acquisition is paused until the queue snapshot commits
   * again" notice is a promise or a lie. It used to ride the attestation
   * freshness tick, which cannot see the state that produces the fault: that
   * effect returns early with no records, and the *first* acquisition of a fresh
   * conversation is exactly when there are none. The queue is Profile-scoped and
   * outlives any one conversation, so opening a second conversation also tore
   * the tick down and left a still-faulted queue with no waker at all.
   *
   * `evidenceCheckpointFaulted` is state published from the queue's own
   * emission (see `publishEvidenceAcquisitionQueue`), so this runs whenever a
   * queue is faulted, regardless of what the Proof route happens to be showing.
   */
  useEffect(() => {
    if (!evidenceCheckpointFaulted) return;
    const retry = () => { wakeFaultedEvidenceAcquisitionQueue(evidenceAcquisitionQueue.current); };
    retry();
    const timer = window.setInterval(retry, 30_000);
    return () => window.clearInterval(timer);
  }, [evidenceCheckpointFaulted]);

  useEffect(() => {
    if (attestationRecords.length === 0) return;
    const tick = () => {
      const now = Date.now();
      setAttestationNow(now);
      if (!online || !chutesConnected || !attestationClient.current || !lastReceipt || !sessionId) return;
      const record = attestationRecords.find((candidate) => attestationRecordMatchesReceipt(candidate, lastReceipt));
      if (!record) return;
      if (isDisplayFreshAttestation(record, now)) {
        automaticEvidenceRefreshes.current.delete(record.recordId);
        return;
      }
      if (automaticEvidenceRefreshes.current.has(record.recordId)) return;
      automaticEvidenceRefreshes.current.add(record.recordId);
      void enqueueAutomaticReceiptEvidence(lastReceipt, sessionId, profileId).catch(() => {
        // The durable queue owns retries and its failure projection. Releasing
        // this record here would enqueue the same expired observation every
        // thirty seconds and turn a bounded retry into a polling storm.
      });
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [attestationRecords, chutesConnected, lastReceipt, online, profileId, sessionId]);

  useEffect(() => {
    const binding = endpointEvidenceAuthority.current?.current();
    if (binding && sessionId) projectEndpointEvidencePresentation(binding, sessionId);
    // A selected row/failure belongs to the prior session even when the record
    // store itself remains bound to the same Profile and workspace authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, sessionId]);

  /**
   * The one recovery verb, shared by every route that can fail to load.
   *
   * Each loader clears its own error as it re-enters, so this needs to do
   * nothing but ask them all to run again.
   */
  function retryDeferredChunk() {
    setDeferredChunkAttempt((value) => value + 1);
  }

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
  }, [view, proofSection, AttestationsScreen, deferredChunkAttempt]);

  /*
   * The claim rail is fetched the moment a receipt exists — or the Proof route
   * opens — and never before. It cannot render without one, so paying for it
   * at first paint bought an empty conversation nothing.
   */
  useEffect(() => {
    if ((view !== "proof" && !lastReceipt) || ProofInspector) return;
    let current = true;
    setProofInspectorError(undefined);
    void import("./proof-inspector").then((module) => {
      if (current) setProofInspector(() => module.ProofInspector);
    }).catch(() => {
      // This was silent on the premise that `#proof` reports the same failure.
      // It does not: `proofViewError` is written only by the `proof-view`
      // catch, and `proof-inspector` is a separate build asset that fails on
      // its own. The premise being false is how the claim stack came to render
      // an endless skeleton on the route that promises never to overstate.
      if (current) setProofInspectorError("The claim stack could not be loaded. No receipt, evidence, or journal state changed.");
    });
    return () => { current = false; };
  }, [view, lastReceipt, ProofInspector, deferredChunkAttempt]);

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
  }, [view, ProofScreen, deferredChunkAttempt]);

  useEffect(() => {
    if ((view !== "sessions" || SessionsScreen) && (view !== "vault" || VaultScreen)) return;
    let current = true;
    if (view === "sessions") setSessionsViewError(undefined);
    if (view === "vault") setVaultViewError(undefined);
    void import("./sessions-route").then((module) => {
      if (!current) return;
      if (view === "sessions") setSessionsScreen(() => module.SessionsView);
      if (view === "vault") setVaultScreen(() => module.VaultView);
    }).catch(() => {
      if (!current) return;
      // The runtime line stays — it is how a desktop reader learns without
      // leaving the route — but it can no longer be the *only* carrier: it is
      // `display: none` below 640px, which left the phone with a permanent
      // skeleton and no stated reason.
      if (view === "sessions") {
        setRuntimeStatus("Session library interface could not be loaded");
        setSessionsViewError("The conversation history interface could not be loaded. No session or journal state changed.");
      }
      if (view === "vault") setVaultViewError("The Vault interface could not be loaded. No provider, key, or runtime state changed.");
    });
    return () => { current = false; };
  }, [view, SessionsScreen, VaultScreen, deferredChunkAttempt]);

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
  }, [view, GoogleDriveSetupScreen, LocalLabSetupScreen, deferredChunkAttempt]);

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
  }, [view, preferences.vaultBackend, LocalDeviceVaultSetupScreen, deferredChunkAttempt]);

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
  }, [view, AccessScreen, BillingScreen, deferredChunkAttempt]);

  useEffect(() => {
    if (view !== "access" || activeOAuthRegistration) return;
    let current = true;
    setOAuthRegistrationError(undefined);
    void import("../auth/chutes-oauth-registration").then((module) => {
      if (!current) return;
      setActiveOAuthRegistration({
        registration: module.CHUTES_ACTIVE_REGISTRATION,
        exchangeMode: module.chutesOAuthExchangeMode(module.CHUTES_ACTIVE_REGISTRATION),
      });
    }).catch(() => {
      // Not `accessViewError`: that state renders only where `AccessScreen` is
      // absent, so writing this there described the route's own chunk failing
      // and was unreachable the moment the route loaded. The sign-in lane this
      // actually disables carries it instead.
      if (current) setOAuthRegistrationError("Chutes OAuth registration metadata could not be loaded, so browser sign-in is unavailable. Existing connections were not changed.");
    });
    return () => { current = false; };
  }, [view, activeOAuthRegistration, deferredChunkAttempt]);

  useEffect(() => {
    if (view !== "access" || ProviderConnectionsScreen) return;
    let current = true;
    setProviderFabricError(undefined);
    void import("./provider-connections-view").then((module) => {
      if (current) setProviderConnectionsScreen(() => module.ProviderConnectionsView);
    }).catch(() => {
      // Its own state, for the same reason as the registration loader above:
      // `accessViewError` is unrenderable once `AccessScreen` has loaded, and
      // this chunk is the normal case's *only* path to every non-Chutes
      // provider.
      if (current) setProviderFabricError("The provider fabric could not be loaded. Existing Chutes and conversation state were not changed.");
    });
    return () => { current = false; };
  }, [view, ProviderConnectionsScreen, deferredChunkAttempt]);

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
  }, [view, EditorScreen, deferredChunkAttempt]);

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
  }, [view, TerminalScreen, deferredChunkAttempt]);

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
  }, [view, CapabilitiesScreen, deferredChunkAttempt]);

  useEffect(() => {
    // Only for the route that has a catalogue to search. A failure here is not
    // reported: the control keeps its own trigger and the flattened menu, so a
    // pack that will not load costs the search field, never the ability to
    // change model.
    if (!activeChutesConnection || ModelPickerControl) return;
    let current = true;
    void import("./model-picker").then((module) => {
      if (current) setModelPickerControl(() => module.ModelPicker);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [activeChutesConnection, ModelPickerControl]);

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
  }, [view, MemoryScreen, deferredChunkAttempt]);

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

  /**
   * The one place the rail's width is chosen deliberately.
   *
   * The choice is written against the current width *band* rather than
   * globally: a laptop and the external display it is docked to are different
   * working postures, and one preference for both would be a third guess on
   * top of the two this replaces.
   */
  function toggleRailState() {
    const next = toggledRailState(railState);
    const preference = withRailState(railPreference, railBand(railViewport.width), next);
    setRailPreference(preference);
    saveRailPreference(preference);
  }

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
    setDestinationArrival((current) => current + 1);
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
    const ownerRuntime = runtime.current;
    const ownerProfile = activeProfileRef.current;
    const ownerSessionId = activeSessionIdentity.current;
    if (!ownerRuntime || !ownerProfile || !ownerSessionId) { navigate("sessions"); return; }
    try {
      const [target, authoritySession] = await Promise.all([
        ownerRuntime.journal.getSession(targetSessionId),
        ownerRuntime.journal.getSession(ownerSessionId),
      ]);
      if (!target || !authoritySession) throw new Error("The requested conversation is unavailable.");
      requireProfileOwnedSession(target, ownerProfile.profileId, "open");
      requireProfileOwnedSession(authoritySession, ownerProfile.profileId, "open");
      const detail = await new SessionLibrary(ownerRuntime.journal).inspect(
        target.id,
        activeSessionRuntime(ownerRuntime, authoritySession),
      );
      if (
        runtime.current !== ownerRuntime
        || activeProfileRef.current?.revision !== ownerProfile.revision
        || profileAuthorityId.current !== ownerProfile.profileId
        || activeSessionIdentity.current !== ownerSessionId
        || sessionNavigationChanging.current
      ) throw new Error("The active Profile or conversation changed before the requested conversation could open.");
      await resumeLibrarySession(detail);
    } catch (error) {
      const { describeSessionPresentationFault } = await loadDeferredCapabilities();
      setRuntimeStatus(error instanceof Error
        ? describeSessionPresentationFault(error)
        : "The recent session could not be opened.");
      navigate("sessions");
    }
  }

  async function setProfileConversationFavorite(
    targetSessionId: string,
    favorite: boolean,
    ownerProfileId: string,
    ownerRuntime: Runtime | undefined,
  ): Promise<void> {
    if (!sessionLibrary) throw new Error("The conversation journal is not ready.");
    await sessionLibrary.setFavorite(targetSessionId, ownerProfileId, favorite);
    if (runtime.current !== ownerRuntime || profileAuthorityId.current !== ownerProfileId) return;
    setSessionRevision((value) => value + 1);
    setRuntimeStatus(favorite ? "Conversation added to favorites" : "Conversation removed from favorites");
  }

  async function moveProfileConversationFavorite(
    targetSessionId: string,
    beforeSessionId: string | undefined,
    ownerProfileId: string,
    ownerRuntime: Runtime | undefined,
  ): Promise<void> {
    if (!sessionLibrary) throw new Error("The conversation journal is not ready.");
    await sessionLibrary.moveFavoriteBefore(targetSessionId, ownerProfileId, beforeSessionId);
    if (runtime.current !== ownerRuntime || profileAuthorityId.current !== ownerProfileId) return;
    setSessionRevision((value) => value + 1);
    setRuntimeStatus("Favorite order saved to the active profile journal");
  }

  async function renameActiveConversation(title: string): Promise<void> {
    const active = activeSessionRecord;
    const activeRuntime = runtime.current;
    if (!active || !activeRuntime) throw new Error("The conversation journal is not ready yet.");
    if (busy) throw new Error("Wait for the current turn to finish before renaming this conversation.");
    const renamed = await activeRuntime.journal.renameSession(active.id, title);
    if (activeSessionIdentity.current !== active.id) return;
    setActiveSessionRecord(renamed);
    setEventCount((count) => count + 1);
    setSessionRevision((value) => value + 1);
    setRuntimeStatus(`Renamed conversation to ${renamed.title}`);
  }

  /*
   * A rename committed from the conversation library is durable the moment
   * `library.rename` resolves, but the Chat header and the rail recents read
   * host state, not the library's own list. Adopt the returned record so the
   * name a reader just committed is the name every surface shows, without
   * waiting for a turn to bump the revision by accident.
   */
  function adoptLibraryRename(renamed: SessionRecord): void {
    setActiveSessionRecord((current) => current?.id === renamed.id ? renamed : current);
    setSessionRevision((value) => value + 1);
  }

  function openReceiptAttestation(receipt: ConversationReceipt): void {
    if (receipt.sessionId === sessionId) {
      selectEndpointEvidenceRecord(attestationRecordIdForReceipt(receipt));
    }
    const selection = proofSelectionForReceipt(receipt);
    setProofSelection(selection);
    setProofSection("attestations");
    navigate("proof", proofHash(selection, "attestations"));
  }

  async function startOAuthSignIn(): Promise<void> {
    if (!online) throw new Error(OFFLINE_INLINE_REASON);
    const oauth = await import("../auth/chutes-oauth");
    const registration = oauth.CHUTES_ACTIVE_REGISTRATION;
    if (!registration.configured) {
      throw new Error(registration.configurationError ?? "Chutes sign-in is not configured for this build.");
    }
    const locationState = oauth.chutesOAuthLocationState(registration.homepageUrl, window.location.href);
    if (!locationState.available) throw new Error(locationState.reason);
    pendingOAuthCredential.current = undefined;
    setOauthCallbackStatus(undefined);
    const request = await oauth.createChutesAuthorizationRequest({
      clientId: registration.clientId,
      registration,
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

  /*
   * Deliberately non-destructive.
   *
   * This used to consume the ref, which made a completed OAuth exchange a
   * single-use handoff: AccessView is conditionally mounted, so navigating off
   * #connection — or any remount at all — destroyed the only copy of a
   * credential the user had already paid a full authorization round trip for,
   * and the route came back as the empty entry stack. The token itself is
   * still live in `oauthTokens`, so the honest lifetime of this pointer is
   * "until it is committed or released": `connectChutes` clears it on commit,
   * `startOAuthSignIn` clears it before a new exchange, and
   * `releaseChutesAuthority` clears it when the authority goes away.
   */
  function readPendingOAuthCredential(): string | undefined {
    return pendingOAuthCredential.current;
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

  /**
   * Buffers a live-tool-output chunk and applies it on the next animation
   * frame — the same cadence `queueTextDelta` gives text deltas. The
   * `tool-output` signal fires per stream write; an immediate `setMessages`
   * per write rebuilt the whole messages array and re-rendered every visible
   * transcript card per chunk.
   */
  function queueToolOutput(messageId: string, chunk: PendingToolOutputUpdate) {
    const pending = pendingToolOutput.current?.messageId === messageId
      ? pendingToolOutput.current
      : { messageId, updates: new Map<string, PendingToolOutputUpdate>() };
    mergePendingToolOutput(pending.updates, chunk.operationId, chunk);
    pendingToolOutput.current = pending;
    if (pendingToolOutputFrame.current !== undefined) return;
    pendingToolOutputFrame.current = requestAnimationFrame(flushPendingToolOutput);
  }

  /**
   * Applies every buffered operation in ONE `setMessages`. Called by the
   * frame above, and called synchronously on turn completion/failure so the
   * terminal stamp cannot be overtaken by a late frame re-adding live output
   * to a settled row.
   */
  function flushPendingToolOutput() {
    if (pendingToolOutputFrame.current !== undefined) {
      cancelAnimationFrame(pendingToolOutputFrame.current);
      pendingToolOutputFrame.current = undefined;
    }
    const pending = pendingToolOutput.current;
    pendingToolOutput.current = undefined;
    if (!pending || !pending.updates.size) return;
    const { messageId, updates } = pending;
    setMessages((current) => current.map((message) => {
      if (message.id !== messageId) return message;
      // Arrival order is the Map's insertion order: the last operation to
      // report wins the row's single live-output slot, exactly as the
      // per-chunk writes did.
      let liveToolOutput = message.liveToolOutput;
      for (const update of updates.values()) {
        const prior = liveToolOutput?.operationId === update.operationId ? liveToolOutput.text : "";
        liveToolOutput = {
          operationId: update.operationId,
          stream: update.stream,
          text: `${prior}${update.text}`.slice(-LIVE_TOOL_OUTPUT_LIMIT),
        };
      }
      return { ...message, liveToolOutput };
    }));
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
      // Page memory is the storage authority; the bootstrap content belongs to
      // the Profile that opens it, inside that Profile's namespace, so a second
      // Profile starts genuinely empty rather than inheriting these files.
      const storage = new MemoryWorkspace();
      const storageId = "memory://airship-page";
      const workspace = new ProfileWorkspacePort(storage, profile.profileId);
      const [{ WorkspaceGitAdapter, AIRSHIP_BOOTSTRAP_FILES, BrowserGitClient }, { browserInferenceFabric }, { InspectInferenceConnectionsTool }] = await Promise.all([
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
        liveEnvironment: liveEnvironmentSource,
        additionalTools: [availabilityTool],
      });
      const commandModule = await import("../commands");
      setSlashModule(() => commandModule);
      const commands = commandModule.createSlashCommandRegistry({ tools });
      const profiles = new MemoryProfileCatalogStore();
      const initialCatalog = (await profiles.initialize(nextCatalog)).checkpoint;
      const nextRuntime: Runtime = {
        storage,
        storageId,
        workspace,
        workspaceId: profileWorkspaceIdentity(storageId, profile.profileId),
        profileId: profile.profileId,
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
      rememberProfileAuthority(nextRuntime, nextGitClient);
      setSlashRegistry(commands);
      const nextSession = await createProfileSession(nextRuntime, profile, nextCatalog);
      if (disposed) return;
      publishCatalogCheckpoint(initialCatalog);
      publishProfileId(profile.profileId);
      const activated = await activateSession(nextSession);
      setSessionLibrary(new SessionLibrary(nextRuntime.journal));
      setGitClient(nextGitClient);
      setSessionRevision(1);
      setEventCount(activated.headSequence);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      await refreshWorkspacePresentation(nextRuntime, profile.profileId);
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
      if (pendingToolOutputFrame.current !== undefined) cancelAnimationFrame(pendingToolOutputFrame.current);
    };
  }, []);

  /*
   * The preference layer is its own layer, and it is never gated on a theme.
   *
   * Riding the profile-theme effect made a synchronous localStorage value wait
   * on the end of a multi-await runtime boot, so a light-mode reader got the
   * dark sheet — full-screen — for the entire boot window, and the boot screen
   * rendered off whatever density and type ramp the stylesheet defaults to.
   * `src/main.tsx` applies the same call before the first render so the first
   * frame is already right; this keeps it true for every later change, whether
   * or not a theme has resolved.
   *
   * Declared before the theme effect so the theme effect commits last: it is
   * the one that re-asserts these same preferences over the theme's own
   * presentation base, and running it second is what keeps the layering
   * theme-under-preference rather than the reverse.
   */
  useEffect(() => {
    if (activeTheme) return;
    applyPreferenceOverrides(preferences);
  }, [activeTheme, preferences]);

  useEffect(() => {
    savePreferenceOverrides(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!activeTheme) return;
    // Profile themes establish defaults; global Preferences are the final,
    // non-profile override layer and must remain authoritative after a switch.
    // The mode is also an input to the theme, not just a layer over it: the
    // inline palette has to be diffed against the sheet the mode selects.
    applyThemeWithPreferences(activeTheme, preferences);
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
    void (async () => {
      let oauth: typeof import("../auth/chutes-oauth") | undefined;
      let exchangeMode: "local-confidential-bridge" | "public-pkce" = "public-pkce";
      try {
        oauth = await import("../auth/chutes-oauth");
        const registration = oauth.CHUTES_ACTIVE_REGISTRATION;
        exchangeMode = oauth.chutesOAuthExchangeMode(registration);
        if (disposed) return;
        setOauthCallbackStatus({
          kind: "blocked",
          message: exchangeMode === "local-confidential-bridge"
            ? "oauth:exchange-local"
            : "oauth:exchange-public",
        });
        if (!rawAttempt) throw new Error("No matching Chutes authorization attempt was found in this tab.");
        const attempt = oauth.parseChutesPkceAttempt(rawAttempt);
        const callback = oauth.consumeChutesAuthorizationCallback({ search: callbackSearch, attempt });
        const tokenSet = await oauth.exchangeChutesAuthorizationCode({
          callback,
          clientId: registration.clientId,
          registration,
        });
        if (disposed) return;
        oauthTokens.current = tokenSet;
        pendingOAuthCredential.current = tokenSet.accessToken;
        setOauthTokenRevision((value) => value + 1);
        setOauthBootstrapRevision((value) => value + 1);
        setOauthCallbackStatus({
          kind: "verified",
          message: exchangeMode === "local-confidential-bridge"
            ? "oauth:complete-local"
            : "oauth:complete-public",
        });
      } catch (error) {
        if (disposed) return;
        oauthTokens.current = undefined;
        pendingOAuthCredential.current = undefined;
        setOauthCallbackStatus({
          kind: "error",
          message: oauth?.describeChutesOAuthExchangeError(error, exchangeMode)
            ?? (error instanceof Error ? error.message : "Chutes sign-in could not be completed."),
        });
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
      setDestinationArrival((current) => current + 1);
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

  // The placeholder is measured, not guessed: the long form overflowed a phone
  // content box and was sliced mid-line. The words it drops stay on the control
  // as its title and in the slash menu, so nothing is lost by shortening it.
  useEffect(() => {
    const media = window.matchMedia(COMPOSER_NARROW_PLACEHOLDER_QUERY);
    const sync = () => setNarrowComposer(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (connection.kind !== "chutes-oauth") return;
    const tokenSet = oauthTokens.current;
    if (!tokenSet?.refreshToken) return;
    const controller = new AbortController();
    let disposed = false;
    let retries = 0;
    let timer = 0;
    const scheduleRotation = (delayMs: number) => {
      timer = window.setTimeout(() => {
        void (async () => {
          let oauth: typeof import("../auth/chutes-oauth") | undefined;
          let exchangeMode: "local-confidential-bridge" | "public-pkce" = "public-pkce";
          try {
            oauth = await import("../auth/chutes-oauth");
            const registration = oauth.CHUTES_ACTIVE_REGISTRATION;
            exchangeMode = oauth.chutesOAuthExchangeMode(registration);
            const next = await oauth.refreshChutesOAuthToken({
              clientId: registration.clientId,
              refreshToken: tokenSet.refreshToken!,
              signal: controller.signal,
              registration,
            });
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
          } catch (error) {
            if (disposed || controller.signal.aborted) return;
            /*
             * A refused fetch, a timeout or a 5xx names a bad minute of
             * network, not a dead grant: the refresh token may still be
             * entirely valid, so the connection is kept and the rotation is
             * retried on a bounded backoff. Only the token endpoint's own
             * rejection (invalid_grant / invalid_client) releases the
             * authority immediately — that grant is already gone no matter
             * what this page does. Exhausted retries fall through to the
             * original failure handling: minutes of failed rotation leave no
             * honest basis to keep claiming the connection.
             */
            if (!oauth?.isChutesOAuthProviderRejection(error) && retries < OAUTH_ROTATION_RETRY_DELAYS.length) {
              const retryDelay = OAUTH_ROTATION_RETRY_DELAYS[retries]!;
              retries += 1;
              scheduleRotation(retryDelay);
              return;
            }
            setOauthCallbackStatus({
              kind: "error",
              message: oauth?.describeChutesOAuthExchangeError(error, exchangeMode)
                ?? (error instanceof Error ? error.message : "Chutes sign-in could not be completed."),
            });
            releaseChutesAuthority("Chutes OAuth rotation failed · reconnect inference; this conversation remains intact");
          }
        })();
      }, delayMs);
    };
    scheduleRotation(Math.max(0, tokenSet.expiresAt - Date.now() - 60_000));
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort(new DOMException("OAuth refresh schedule changed.", "AbortError"));
    };
  }, [connection.kind, oauthTokenRevision]);

  useEffect(() => {
    const label = destinationLabel(view) ?? "Agent";
    document.title = unreadTurnCount > 0 ? `(${String(unreadTurnCount)}) Airship — ${label}` : `Airship — ${label}`;
  }, [unreadTurnCount, view]);

  useEffect(() => {
    mainRegion.current?.focus({ preventScroll: true });
    // `.main` is one persistent `overflow: auto` scroller across routes, so a
    // long-scrolled sessions list would otherwise hand its scroll offset to
    // the vault. Reset it on entry — chat excepted: the chat layout clips
    // `.main` (`overflow: hidden`) and owns scroll inside the transcript,
    // whose pinned-anchor effect must not race this one.
    if (view !== "chat") mainRegion.current?.scrollTo({ top: 0, behavior: "auto" });
    if (view === "chat" && !document.hidden) setUnreadTurnCount(0);
  }, [view]);

  // The rail fits without scrolling at every height this product is used at
  // now, but the mask machinery stays: it is measured rather than assumed, and
  // at a genuinely short viewport a clipped destination must still read as
  // "more below" rather than as a sliced row. Re-bind when the state or the
  // nesting changes the content height so the fade cannot go stale.
  useScrollEdges(primaryNav, `${String(shellMounted)}:${railState}:${view}`);

  // `data-rail` is on the document element, not the shell, because the topbar
  // and the app grid both size their first column from `--rail-width`.
  useEffect(() => { document.documentElement.dataset.rail = railState; }, [railState]);

  useEffect(() => {
    const onResize = () => setRailViewport(readRailViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isRailToggleChord(event)) return;
      event.preventDefault();
      toggleRailState();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railState, railViewport, railPreference]);

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

  function publishProfileId(nextProfileId: string): void {
    profileAuthorityId.current = nextProfileId;
    setProfileId(nextProfileId);
  }

  function currentWorkspaceRefreshAuthority(): WorkspaceRefreshAuthority | undefined {
    const active = runtime.current;
    if (!active) return undefined;
    return Object.freeze({
      workspace: active.workspace,
      workspaceId: active.workspaceId,
      profileId: profileAuthorityId.current,
    });
  }

  async function refreshWorkspacePresentation(
    expectedRuntime = runtime.current,
    expectedProfileId = profileAuthorityId.current,
  ): Promise<boolean> {
    if (!expectedRuntime || !expectedProfileId) return false;
    return workspaceRefreshCoordinator.refresh(
      Object.freeze({
        workspace: expectedRuntime.workspace,
        workspaceId: expectedRuntime.workspaceId,
        profileId: expectedProfileId,
      }),
      currentWorkspaceRefreshAuthority,
      (entries) => {
        setFiles([...entries]);
        /*
         * Refresh is metadata-only. Content is read only after an explicit
         * open; indexing has its own bounded, demand-driven WorkspacePort.
         *
         * Published whole, deliberately. This array is not only a presentation
         * input: ContextView hands it to the index engine as the *revision
         * snapshot* it validates against the live listing, so a 2,000-entry
         * presentation cap was silently asserting that a larger workspace had
         * changed under the engine, and `CONTEXT_SNAPSHOT_STALE` made such a
         * workspace impossible to index at all. Bounding belongs in the
         * consumers that need it, and both already have it: graph derivation
         * caps at 2,000 and reports `stats.truncated`, and the Index summary's
         * source count is now the true one.
         */
        setWorkspaceFiles([...entries]);
      },
    );
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

  /**
   * Rebuild the complete authority a Profile owns: its workspace namespace,
   * the Git object database over it, and the tool registry bound to both.
   *
   * This is what makes a Profile switch a change of authority rather than a
   * change of presentation. The tool registry has to be rebuilt with it —
   * tools captured the old port, so reusing the registry would let the new
   * Profile's agent read and write the previous Profile's files.
   */
  function rememberProfileAuthority(built: Runtime, git: BrowserGitClient): void {
    profileAuthorities.current.set(built.profileId, Object.freeze({
      storage: built.storage,
      workspace: built.workspace,
      workspaceId: built.workspaceId,
      git,
      tools: built.tools,
      contextMode: built.contextMode,
    }));
  }

  async function runtimeForProfile(
    active: Runtime,
    profile: ProfileRevision,
  ): Promise<Readonly<{ runtime: Runtime; git: BrowserGitClient }>> {
    const cached = profileAuthorities.current.get(profile.profileId);
    if (cached && cached.storage === active.storage) {
      return Object.freeze({
        runtime: {
          ...active,
          workspace: cached.workspace,
          workspaceId: cached.workspaceId,
          profileId: profile.profileId,
          tools: cached.tools,
          ...(cached.contextMode ? { contextMode: cached.contextMode } : {}),
        },
        git: cached.git,
      });
    }
    const authority = await openProfileWorkspaceAuthority({
      storage: active.storage,
      storageId: active.storageId,
      profile,
    });
    const registryOptions = {
      workspace: authority.workspace,
      journal: active.journal,
      git: authority.git,
      liveEnvironment: liveEnvironmentSource,
      additionalTools: [requireProviderAvailabilityTool()],
    };
    // Scoped to the incoming Profile: the routing mirror is a pointer into that
    // Profile's own indexed content, so it has to live in that namespace.
    const scopedFabric = active.contextFabric?.scopedTo(authority.workspace);
    const vaultAware = scopedFabric
      ? await createVaultAwareAirshipToolRegistry({
          ...registryOptions,
          workspaceId: authority.workspaceId,
          contextFabric: scopedFabric,
        })
      : undefined;
    const built: Runtime = {
      ...active,
      workspace: authority.workspace,
      workspaceId: authority.workspaceId,
      profileId: profile.profileId,
      tools: vaultAware ? vaultAware.tools : await createAirshipToolRegistry(registryOptions),
      ...(scopedFabric ? { contextFabric: scopedFabric } : {}),
      ...(vaultAware ? { contextMode: vaultAware.contextMode } : {}),
    };
    rememberProfileAuthority(built, authority.git);
    return Object.freeze({ runtime: built, git: authority.git });
  }

  /**
   * Switches the cockpit, and reports whether the switch actually committed.
   *
   * The boolean is not decoration: `deleteProfile` archives the outgoing
   * profile only if the replacement really became active, and a swallowed
   * failure that still returned `void` would archive the profile the user is
   * still running on.
   */
  async function changeProfile(nextId: string, force = false): Promise<boolean> {
    const active = runtime.current;
    if (!active || !catalog || (!force && nextId === profileId)) return false;
    if (inferenceRouteChanging.current || sessionNavigationChanging.current) {
      throw new Error("Wait for the current session or inference route change before switching profiles.");
    }
    workspaceRefreshCoordinator.invalidate();
    proofSelectionOperation.current += 1;
    setProofSelection(undefined);
    setProofSelectionAuthority(undefined);
    pendingForkRetry.current = undefined;
    sessionNavigationChanging.current = true;
    const operation = ++profileOperation.current;
    /*
     * Everything needed to put the outgoing cockpit back.
     *
     * A switch is a two-part commit — authority (runtime, Git client, tool and
     * slash registry) and identity (`profileId`) — and it used to publish the
     * first, then run the validation that can reject the switch, then publish
     * the second. A rejection therefore left profile A's UI and conversation
     * running on profile B's workspace, tools and Git client. Every call site
     * is fire-and-forget with no catch, so it was invisible as well as
     * inconsistent. The two publications are now adjacent, all fallible work
     * happens before them, and a failure restores the outgoing cockpit and
     * says so.
     */
    const previousProfileId = profileAuthorityId.current;
    const previousGit = gitClient;
    const previousRegistry = slashRegistry;
    /** The runtime this call published, if it got that far. See the catch. */
    let committed: Runtime | undefined;
    try {
      activeTurn.current?.abort();
      setRuntimeStatus("Switching profile cockpit");
      let profile: ProfileRevision | undefined;
      let nextSession: SessionRecord | undefined;
      let restored: Readonly<{
        fresh: SessionLibraryDetail;
        audited: Awaited<ReturnType<typeof loadAuditedSessionSnapshot>>;
      }> | undefined;
      let unresumableReason: string | undefined;
      let switched: Readonly<{ runtime: Runtime; git: BrowserGitClient }> | undefined;
      await mutateProfileCatalog(async (current) => {
        const selected = current.profiles.find((candidate) => candidate.profileId === nextId);
        if (!selected) throw new Error(`Unknown profile: ${nextId}`);
        setProfileCockpitTransition(Object.freeze({ profileId: selected.profileId, name: selected.name }));
        profile = await bindProfileToRuntime(selected, active);
        const next = profile === selected ? current : replaceProfile(current, profile);
        switched = await runtimeForProfile(active, profile);
        // Sessions are resolved against the *incoming* authority so a restored
        // or newly created conversation pins the workspace it will actually run
        // in, rather than the one being switched away from.
        nextSession = await compatibleProfileSession(
          switched.runtime,
          profile,
          next,
          activeSessionByProfile.current.get(nextId),
        );
        if (nextSession) {
          /*
           * Judge the conversation here, against the runtime it is about to run
           * in, while the outgoing runtime is still the committed one. Both
           * checks need only the incoming authority, never the pointer.
           *
           * A conversation that cannot be resumed is not a failed switch. The
           * profile starts a fresh one — the same outcome as a profile that
           * never had a compatible conversation — and the reason is named in
           * the opening message rather than thrown at a caller that has no
           * catch. The unresumable conversation itself is untouched.
           */
          const candidateSession = nextSession;
          const fresh = await new SessionLibrary(switched.runtime.journal).inspect(
            candidateSession.id,
            activeSessionRuntime(switched.runtime, candidateSession),
          );
          const audited = fresh.compatibility?.action === "resume"
            ? await loadAuditedSessionSnapshot(candidateSession.id, undefined, switched.runtime)
            : undefined;
          if (!audited) {
            const compatibility = fresh.compatibility;
            unresumableReason = compatibility
              ? `${compatibility.label}: ${compatibility.reasons.map((reason) => reason.message).join(" ")} ${fresh.history.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" ")}`.trim()
              : "It no longer matches this profile's runtime.";
          } else if (audited.report.status !== "verified") {
            unresumableReason = "It did not pass the local journal audit.";
          } else if (
            audited.session.headSequence !== fresh.session.headSequence
            || audited.session.headDigest !== fresh.session.headDigest
          ) {
            unresumableReason = "It changed while it was being restored.";
          } else {
            restored = Object.freeze({ fresh, audited });
          }
          if (!restored) nextSession = undefined;
        }
        nextSession ??= await createProfileSession(switched.runtime, profile, next);
        return next;
      });
      if (!profile || !nextSession || !switched) throw new Error("The profile session was not created.");
      if (runtime.current !== active) throw new Error("The runtime changed before the profile cockpit could be restored.");
      if (operation !== profileOperation.current) return false;
      // Authority and identity, adjacent. Nothing that can fail sits between
      // them, so `profileId` and `runtime.current` can no longer disagree.
      runtime.current = switched.runtime;
      committed = switched.runtime;
      setGitClient(switched.git);
      // Slash commands close over the tool registry, so they have to be rebuilt
      // with it; a stale registry would run the previous Profile's tools.
      if (slashModule) setSlashRegistry(slashModule.createSlashCommandRegistry({ tools: switched.runtime.tools }));
      publishProfileId(nextId);
      if (restored) {
        await publishAuditedSession(restored.fresh, restored.audited, `${profile.name} cockpit restored`);
        await releaseOutgoingProfileTerminals(active.workspace, profile.name);
        navigate("chat");
        return true;
      }
      const activated = await activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{ ...welcomeMessage, id: randomUuid(), content: unresumableReason
        ? `${profile.name}'s most recent conversation was not resumed, so Airship started a new one here. ${unresumableReason} That conversation is unchanged and still readable in Sessions. ${welcomeMessage.content}`
        : `${profile.name} had no compatible conversation, so Airship started one. ${welcomeMessage.content}` }]);
      setEventCount(activated.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setRuntimeStatus(`${profile.name} cockpit started`);
      await releaseOutgoingProfileTerminals(active.workspace, profile.name);
      navigate("chat");
      return true;
    } catch (error) {
      /*
       * The outgoing cockpit survives, and the user is told.
       *
       * A newer switch owns the cockpit if `operation` has moved on, so this
       * one must not write over it. Otherwise every part of the commit is put
       * back together — including `profileId`, so the two halves settle in
       * agreement whether or not the commit had been reached.
       *
       * Unless the runtime is not ours. The guard above throws precisely because
       * `runtime.current` can be replaced mid-switch by the durable-vault
       * adoption, which publishes a whole cockpit of its own — runtime, Git
       * client, slash registry, catalog checkpoint, session library, durable
       * authority and an activated Vault conversation. Restoring here would
       * splice four of those back to the outgoing page-memory values and leave
       * the rest adopted: the trust axis would read "not adopted" under a
       * vault-journal conversation, and the next `mutateProfileCatalog` would
       * hand a checkpoint minted by one store to another and fail forever.
       * `active` and the runtime this call itself published are the only two we
       * may write over; anything else belongs to a foreign authority, and the
       * only honest action is to name the failure and touch nothing.
       */
      const ownsRuntime = runtime.current === active || runtime.current === committed;
      if (operation === profileOperation.current) {
        if (ownsRuntime) {
          runtime.current = active;
          setGitClient(previousGit);
          setSlashRegistry(previousRegistry);
          publishProfileId(previousProfileId);
        }
        setRuntimeStatus(ownsRuntime
          ? `Profile switch failed: ${error instanceof Error ? error.message : String(error)}`
          : `Profile switch abandoned: ${error instanceof Error ? error.message : String(error)} The storage authority that replaced it stays active.`);
      }
      return false;
    } finally {
      sessionNavigationChanging.current = false;
      setProfileCockpitTransition(undefined);
    }
  }

  /**
   * Releases the outgoing Profile's live shell processes, after the switch.
   *
   * The page has one WebContainer to give out and each namespace has its own
   * terminal manager, so the outgoing Profile's processes and mount have to be
   * stopped and reconciled on this transaction's terms. `ensureHost` would
   * otherwise hand the host over on the new Profile's first boot instead, at an
   * unpredictable moment and under a stranger's reason. Tab metadata is durable
   * and reconstructs; a running process does not, and the Terminal surface says
   * so.
   *
   * Position is the whole point. This used to be the last statement inside
   * `mutateProfileCatalog`'s callback, which is *before* the encrypted catalog
   * commit, before the authority re-checks, and before the session publication —
   * every one of which unwinds through a catch that restores the outgoing
   * cockpit. A refused catalog write therefore left the user on profile A with
   * A's build killed behind the words "Switched to the B profile". Killing
   * processes is not undoable, so it happens only once the switch is a fact:
   * nothing between the commit and here boots a terminal, and the next terminal
   * boots when someone opens the Terminal route against the new profile.
   *
   * Reported, never thrown, for the same reason: the switch has already
   * committed, so a quiesce failure cannot be allowed to unwind it. It means the
   * next terminal boot has to contend for the host, which is a sentence, not a
   * rollback.
   */
  async function releaseOutgoingProfileTerminals(
    outgoingWorkspace: WorkspacePort,
    incomingProfileName: string,
  ): Promise<void> {
    try {
      await (await import("../terminal/manager")).quiesceBrowserTerminalWorkspace(
        outgoingWorkspace,
        `Switched to the ${incomingProfileName} profile. Restart this terminal against that profile's workspace.`,
      );
    } catch (error) {
      setRuntimeStatus((current) => `${current} · the previous profile's terminal processes could not be released: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  /**
   * The only way the product asks for a profile switch.
   *
   * `changeProfile` restores the outgoing cockpit and names the reason for
   * everything that fails inside its transaction, but the one refusal it raises
   * *before* that boundary — a switch asked for while a session or inference
   * route change is still in flight — is a throw, and every call site is
   * `void`-invoked. That refusal was therefore an unhandled rejection: the
   * switch did not happen, nothing was rolled back because nothing had been
   * committed, and the user was told nothing at all. One wrapper that cannot
   * reject, so no caller can drop a refusal on the floor and every refusal
   * reaches the same status line as every other failed switch.
   *
   * `deleteProfile` deliberately still calls `changeProfile` directly: it has
   * to distinguish "did not activate" from "activated", and it converts the
   * refusal into its own error so archiving the active profile fails loudly.
   */
  async function requestProfileChange(nextId: string, force = false): Promise<boolean> {
    try {
      return await changeProfile(nextId, force);
    } catch (error) {
      setRuntimeStatus(`Profile switch failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
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
      const activated = await activateSession(created);
      setMessages([{ ...welcomeMessage, id: randomUuid(), content: `${created.title} is a new isolated conversation. ${welcomeMessage.content}` }]);
      setEventCount(activated.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setSessionRevision((value) => value + 1);
      setRuntimeStatus("New conversation ready");
      navigate("chat");
      return created;
    } finally {
      sessionNavigationChanging.current = false;
    }
  }

  async function runSlashPlan(
    plan: Exclude<SlashCommandPlan, { kind: "chat" }>,
    source: string,
    authority: LocalPresentationAuthority,
  ): Promise<void> {
    if (plan.kind === "invalid") {
      appendLocalExchangeForAuthority(authority, source, plan.message, true);
      return;
    }
    if (plan.kind === "disabled") {
      appendLocalExchangeForAuthority(authority, source, `${plan.command.usage}\n\nUnavailable: ${plan.reason}`, true);
      return;
    }
    if (plan.kind === "builtin") {
      await runSlashBuiltin(plan, source, authority);
      return;
    }
    await runSlashTool(plan, source);
  }

  async function runSlashBuiltin(
    plan: Extract<SlashCommandPlan, { kind: "builtin" }>,
    source: string,
    authority: LocalPresentationAuthority,
  ): Promise<void> {
    if (!runtime.current || !slashRegistry) return;
    if (!localPresentationAuthorityIsCurrent(authority)) {
      throw new Error("The active Profile or conversation changed before the command could run.");
    }
    const commandRuntime = authority.runtime;
    const commandProfile = activeProfileRef.current;
    const commandSessionId = authority.sessionId;
    if (
      !commandProfile
      || commandProfile.profileId !== authority.profileId
      || commandProfile.revision !== authority.profileRevision
    ) {
      throw new Error("The active Profile authority is still changing. Retry the command after it settles.");
    }
    if (
      !commandSessionId
      || activeSessionRecord?.id !== commandSessionId
      || activeSessionRecord.manifest.profile?.profileId !== commandProfile.profileId
    ) throw new Error("The active conversation does not belong to the active Profile.");
    const action = plan.action;
    if (action.type === "help") {
      const descriptor = action.command ? slashRegistry.resolve(action.command) : undefined;
      const response = descriptor
        ? `${descriptor.usage}\n\n${descriptor.summary}${descriptor.availability.enabled ? "" : `\nUnavailable: ${descriptor.availability.reason}`}`
        : slashRegistry.descriptors().map((command) => `${command.usage} — ${command.summary}`).join("\n");
      appendLocalExchangeForAuthority(authority, source, response || "No slash commands are authorized for this profile.");
      return;
    }
    if (action.type === "sessions.list") {
      const sessions = profileOwnedSessions(await commandRuntime.journal.listSessions(), commandProfile.profileId);
      if (
        runtime.current !== commandRuntime
        || activeProfileRef.current?.revision !== commandProfile.revision
        || profileAuthorityId.current !== commandProfile.profileId
        || activeSessionIdentity.current !== commandSessionId
        || sessionNavigationChanging.current
      ) throw new Error("The Profile or session authority changed before the list could be shown.");
      appendLocalExchangeForAuthority(authority, source, sessions.length
        ? sessions.map((session) => `${session.id === sessionId ? "•" : "○"} ${session.title} · ${session.id.slice(0, 8)} · ${session.manifest.model}`).join("\n")
        : `No conversations are available in the ${commandProfile.name} Profile.`);
      return;
    }
    if (action.type === "sessions.create") {
      await createConversation(action.title);
      return;
    }
    if (action.type === "sessions.activate") {
      if (!sessionLibrary || !sessionRuntime) throw new Error("The session library is unavailable.");
      const target = await commandRuntime.journal.getSession(action.sessionId);
      if (!target) throw new Error("The requested conversation is unavailable.");
      requireProfileOwnedSession(target, commandProfile.profileId, "open");
      if (
        runtime.current !== commandRuntime
        || activeProfileRef.current?.revision !== commandProfile.revision
        || profileAuthorityId.current !== commandProfile.profileId
        || activeSessionIdentity.current !== commandSessionId
        || sessionNavigationChanging.current
      ) throw new Error("The Profile or session authority changed before the conversation could be opened.");
      await resumeLibrarySession(await sessionLibrary.inspect(target.id, sessionRuntime));
      return;
    }
    if (action.type === "sessions.fork") {
      if (!sessionLibrary || !activeSessionRecord || !catalog) throw new Error("The active session cannot be forked.");
      if (sessionNavigationChanging.current) throw new Error("Wait for the current conversation transition before forking.");
      sessionNavigationChanging.current = true;
      try {
        const sourceId = action.sessionId ?? activeSessionRecord.id;
        const [sourceSession, targetManifest] = await Promise.all([
          commandRuntime.journal.getSession(sourceId),
          createProfileSessionManifest(commandRuntime, commandProfile, catalog),
        ]);
        if (!sourceSession) throw new Error("The requested source session is unavailable.");
        requireProfileOwnedSession(sourceSession, commandProfile.profileId, "fork");
        if (
          runtime.current !== commandRuntime
          || activeProfileRef.current?.revision !== commandProfile.revision
          || profileAuthorityId.current !== commandProfile.profileId
          || activeSessionIdentity.current !== commandSessionId
        ) throw new Error("The Profile or session authority changed before the fork could be bound.");
        const result = await new SessionLibrary(commandRuntime.journal).fork(sourceId, {
          title: `${sourceSession.title} · fork`.slice(0, 240),
          manifest: targetManifest,
          expectedSourceHead: { sequence: sourceSession.headSequence, digest: sourceSession.headDigest },
        });
        await activateForkedSessionAgainst(result, Object.freeze({
          runtime: commandRuntime,
          profileId: commandProfile.profileId,
          profileRevision: commandProfile.revision,
          activeSessionId: commandSessionId,
          manifest: targetManifest,
        }));
      } finally {
        sessionNavigationChanging.current = false;
      }
      return;
    }
    if (action.type === "skills.list") {
      const pin = activeSessionRecord.manifest.profile;
      appendLocalExchangeForAuthority(authority, source, pin
        ? pinnedSkillListing({ pin, profile: commandProfile, catalogSkills: catalog?.skills ?? [] })
        : "This conversation is not pinned to a Profile, so no skills compose its prompt.");
      return;
    }
    if (action.type === "models.list") {
      const query = action.query?.toLowerCase();
      const activeModels = activeChutesConnection
        ? availableModels.map((model) => model.id)
        : activeExternalRoute?.models.map((model) => model.id) ?? [runtime.current.model];
      const modelIds = activeModels
        .filter((model) => !query || model.toLowerCase().includes(query));
      appendLocalExchangeForAuthority(authority, source, modelIds.length
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
    if (!runtime.current || !sessionId || busy || sessionNavigationChanging.current) return;
    const commandRuntime = runtime.current;
    const commandProfileId = profileAuthorityId.current;
    const commandSessionId = sessionId;
    if (
      activeSessionIdentity.current !== commandSessionId
      || activeProfileRef.current?.profileId !== commandProfileId
      || activeSessionRecord?.id !== commandSessionId
      || activeSessionRecord.manifest.profile?.profileId !== commandProfileId
    ) return;
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
      controller.signal.throwIfAborted();
      if (
        runtime.current !== commandRuntime
        || activeSessionIdentity.current !== commandSessionId
        || profileAuthorityId.current !== commandProfileId
        || sessionNavigationChanging.current
      ) throw new Error("The Profile or conversation authority changed before the local command could run.");
      requireProfileOwnedSession(commandSession, commandProfileId, "open");
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
      /*
       * `localCommandPolicy`, not `approvalPolicy`: the proposer of a slash
       * command is the person at the keyboard, so it is adjudicated the way
       * every other human-proposed effect is. Under Auto Approve this used to
       * send the typed command body to a review model and honour an `unsafe`
       * verdict as an outright denial — a model vetoing its own operator, with
       * no human fallback on that branch. The registry seam is untouched: this
       * call still mints the ticket that `executeApproved` below consumes.
       */
      const decision = await commandRuntime.tools.review(plan.toolName, plan.arguments, context, localCommandPolicy);
      const provenance = approvalProvenance(localCommandPolicy, context);
      if (decision !== "allow") {
        // One sentence for all three modes now, because it is true in all
        // three: no local command's parameters reach a model before it runs.
        const denied = `Permission denied for local /${plan.command.name}. No tool effect ran, and nothing was sent to the model.`;
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
        await refreshWorkspacePresentation(commandRuntime, commandProfileId);
        // No longer mode-dependent: a local command makes no provider request
        // under any approval mode, so the line that used to name a "separate
        // safety review" under Auto Approve would now be describing a request
        // that does not happen.
        setRuntimeStatus("Local command complete; no model request made");
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
      const releasesComposer = activeTurn.current === controller;
      if (releasesComposer) {
        activeTurn.current = undefined;
        setBusy(false);
      }
      const updated = await commandRuntime.journal.getSession(commandSessionId);
      if (updated && activeSessionIdentity.current === commandSessionId) setActiveSessionRecord(updated);
    }
  }

  function localPresentationAuthorityIsCurrent(authority: LocalPresentationAuthority): boolean {
    return runtime.current === authority.runtime
      && profileAuthorityId.current === authority.profileId
      && activeProfileRef.current?.revision === authority.profileRevision
      && activeSessionIdentity.current === authority.sessionId
      && !sessionNavigationChanging.current;
  }

  function appendLocalExchangeForAuthority(
    authority: LocalPresentationAuthority,
    source: string,
    response: string,
    error = false,
  ): boolean {
    if (!localPresentationAuthorityIsCurrent(authority)) return false;
    appendLocalExchange(source, response, error);
    return true;
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
    const remaining = Math.max(0, COMPOSER_ATTACHMENT_LIMIT - attachments.length);
    // Hitting the cap is a refusal, not a non-event. Only the MIME rejection
    // was ever counted, so eight pending attachments plus a ninth drop printed
    // "0 images are ready" — a success sentence for a file that was discarded.
    const overflow = images.length - Math.min(images.length, remaining);
    const next = composerAttachments(images.slice(0, remaining), randomUuid, (file) => {
      if (typeof URL.createObjectURL !== "function") return undefined;
      const url = URL.createObjectURL(file);
      attachmentPreviewUrls.current.add(url);
      return url;
    });
    setAttachments((current) => Object.freeze([...current, ...next].slice(0, COMPOSER_ATTACHMENT_LIMIT)));
    setComposerNotice(composerAttachmentNotice({
      added: next.length,
      rejected,
      overflow,
      capability: imageInputCapability === "supported"
        ? "supported"
        : inferenceConnected ? "model-lacks-vision" : "disconnected",
      encryptedRequest: composerRequestEncrypted,
    }));
  }

  async function forkFromMessage(
    message: UiMessage,
    action: "fork" | "edit" | "retry",
  ): Promise<void> {
    if (!sessionLibrary || !activeSessionRecord) {
      setComposerNotice("Conversation branching will be available when the local session journal is ready.");
      return;
    }
    if (busy || sessionNavigationChanging.current || !message.sourcePoint) {
      setComposerNotice(busy
        ? "Stop the active turn before creating a branch."
        : "This message does not expose a verified historical boundary yet. Resume the conversation and try again.");
      return;
    }
    // Retry regenerates the turn, so it forks *before* the request. Fail closed
    // rather than silently falling back to `sourcePoint`: on an assistant row
    // that is the post-answer terminal, and a "clean retry" that carried the
    // answer it was replacing would be a false claim, not a degraded one.
    const forkPoint = action === "retry" ? message.turnStartPoint : message.sourcePoint;
    if (!forkPoint) {
      setComposerNotice("This answer does not expose a verified pre-turn boundary, so Airship did not create a retry branch that still contained the answer it was replacing.");
      return;
    }
    const prompt = action === "retry"
      ? message.originatingPrompt
      : action === "edit"
        ? message.content
        : undefined;
    if ((action === "retry" || action === "edit") && !prompt?.trim()) {
      setComposerNotice(`The exact prompt for this ${action} is not recoverable, so Airship did not create a misleading partial branch.`);
      return;
    }
    if (
      (action === "retry" || action === "edit")
      && message.parts?.some((part) => part.kind === "attachment")
      && !message.originatingAttachments?.length
    ) {
      setComposerNotice("The original attachment bytes are no longer in this page, so Airship did not create a text-only branch that looked equivalent.");
      return;
    }
    sessionNavigationChanging.current = true;
    try {
      const sourceRuntime = runtime.current;
      const sourceProfile = activeProfileRef.current;
      const sourceId = activeSessionRecord.id;
      const source = await sourceRuntime?.journal.getSession(sourceId);
      if (
        !sourceRuntime
        || !sourceProfile
        || !source
        || activeSessionIdentity.current !== sourceId
        || runtime.current !== sourceRuntime
        || profileAuthorityId.current !== sourceProfile.profileId
        || activeProfileRef.current?.revision !== sourceProfile.revision
      ) {
        throw new Error("The active source conversation changed before its branch could be bound.");
      }
      requireProfileOwnedSession(source, sourceProfile.profileId, "fork");
      const result = await sessionLibrary.fork(source.id, {
        title: `${source.title} · ${action}`.slice(0, 240),
        expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
        sourcePoint: forkPoint,
      });
      preserveComposerForDraftIdentity.current = result.session.id;
      if (action === "retry") {
        pendingForkRetry.current = Object.freeze({
          sessionId: result.session.id,
          profileId: sourceProfile.profileId,
          runtime: sourceRuntime,
          prompt: prompt!,
          attachments: Object.freeze([...(message.originatingAttachments ?? [])]),
        });
      }
      await activateForkedSessionAgainst(result, Object.freeze({
        runtime: sourceRuntime,
        profileId: sourceProfile.profileId,
        profileRevision: sourceProfile.revision,
        activeSessionId: sourceId,
        manifest: source.manifest,
      }));
      // The bound the library already computed, said out loud. `fork()` returns
      // the carried and omitted counts precisely because the seed is bounded;
      // announcing a branch without them asserts a complete continuation that
      // the seed does not guarantee.
      if (action === "edit") {
        setInput(prompt!);
        setAttachments(message.originatingAttachments ?? []);
        setComposerNotice(forkBranchNotice("edit", result));
        setRuntimeStatus("Edit branch ready · source conversation unchanged");
        requestAnimationFrame(() => textarea.current?.focus());
      } else if (action === "retry") {
        setInput("");
        setAttachments([]);
        setComposerNotice(forkBranchNotice("retry", result));
        setRuntimeStatus("Clean retry branch ready · regeneration queued");
      } else {
        setInput("");
        setAttachments([]);
        setComposerNotice(forkBranchNotice(
          message.role === "assistant" ? "fork-after-answer" : "fork-before-prompt",
          result,
        ));
        setRuntimeStatus("True context fork active · waiting for a new prompt");
      }
    } catch (error) {
      pendingForkRetry.current = undefined;
      const detail = error instanceof Error ? error.message : "The source conversation changed before its branch could be committed.";
      setComposerNotice(`${action === "fork" ? "Conversation fork" : action === "edit" ? "Edit branch" : "Retry branch"} was not created: ${detail}`);
      setRuntimeStatus("Conversation branch could not be created safely");
    } finally {
      sessionNavigationChanging.current = false;
      if (pendingForkRetry.current) setPendingForkRetryRevision((value) => value + 1);
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
    // Admission and the announced count both come out of the append itself:
    // `messageQueue` here is the last committed render value and lies by one
    // in both directions — understating right after an enqueue, and
    // overstating at capacity ("25 waiting" while the cap silently dropped
    // the item the composer had just cleared). At capacity the composer keeps
    // the prompt so the message is refused, not lost.
    let admitted = false;
    let waiting = 0;
    publishMessageQueue(sessionId, (current) => {
      const appended = appendThreadQueueItem(current, item);
      admitted = appended.length > current.length;
      waiting = appended.length;
      return appended;
    });
    if (!admitted) {
      setComposerNotice(`Queue full · ${String(waiting)} messages waiting — send or remove one first`);
      return;
    }
    setInput("");
    setAttachments([]);
    setComposerNotice(`Queued for this conversation · ${String(waiting)} waiting`);
  }

  function editQueuedMessage(item: QueuedComposerItem): void {
    if (!sessionId) return;
    setQueuePaused(false);
    removeQueuedMessage(sessionId, item.id);
    setInput(item.prompt);
    setAttachments(item.attachments);
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function sendQueuedMessageNow(item: QueuedComposerItem): void {
    if (!sessionId || busy) return;
    setQueuePaused(false);
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
  ): Promise<boolean> {
    let content = (retryPrompt ?? input).trim();
    // The one bail that had to stop being silent. An attachment-only composer
    // looks armed — thumbnails pending, Send in place — and Enter did nothing
    // at all, with no way to learn why. The text requirement itself stands:
    // the durable turn's canonical prompt part is text, and admitting an empty
    // one would change what a receipt binds. So the refusal names itself
    // instead of the requirement being loosened.
    if (!content && (retryPrompt ? retryAttachments : attachments).length > 0) {
      setComposerNotice(composerAttachmentNeedsText(composerRequestEncrypted));
      return false;
    }
    if (
      !content
      || !runtime.current
      || !sessionId
      || busy
      || activeTurn.current
      || localCommandAdmission.current
      || inferenceRouteChanging.current
      || sessionNavigationChanging.current
      || catalogAuthorityChanging.current
      || vaultProviderSwitchingRef.current
      || localDeviceBusy
    ) return false;
    const admissionRuntime = runtime.current;
    const admissionSessionId = sessionId;
    const admissionProfile = activeProfileRef.current;
    if (
      !admissionProfile
      || profileAuthorityId.current !== admissionProfile.profileId
      || activeSessionIdentity.current !== admissionSessionId
      || activeSessionRecord?.id !== admissionSessionId
      || activeSessionRecord.manifest.profile?.profileId !== admissionProfile.profileId
    ) {
      setComposerNotice("Wait for the active Profile and conversation to finish binding before sending.");
      return false;
    }
    // An explicit send is the only thing that lifts a Stop. Placed past every
    // admission bail so a refused send does not silently resume the queue, and
    // scoped to non-queue sends so automatic dispatch can never clear its own
    // latch.
    if (!queue) setQueuePaused(false);
    const localPresentationAuthority = Object.freeze({
      runtime: admissionRuntime,
      profileId: admissionProfile.profileId,
      profileRevision: admissionProfile.revision,
      sessionId: admissionSessionId,
    });
    if (slashRegistry && slashModule) {
      const slashPlan = slashModule?.planSlashCommand(content, slashRegistry);
      if (slashPlan.kind !== "chat") {
        // Local built-ins do not all create an AbortController. Keep a separate
        // synchronous admission lock so duplicate click/key events in one
        // render cannot create two sessions, forks, or local transcript rows.
        localCommandAdmission.current = true;
        setInput("");
        try {
          await runSlashPlan(slashPlan, content, localPresentationAuthority);
        } catch (error) {
          appendLocalExchangeForAuthority(
            localPresentationAuthority,
            content,
            error instanceof Error ? error.message : String(error),
            true,
          );
        } finally {
          // A local plan never reaches the chat admission below, so without
          // this the queued head neither left nor stopped: built-ins wedged
          // the queue, and tool plans toggled `busy` — a dispatch-effect dep —
          // which re-sent the same head in an unbounded loop, appending
          // durable events on every iteration. Admit exactly once here, on
          // both the success and the error path above.
          queue?.onAdmitted();
          localCommandAdmission.current = false;
        }
        requestAnimationFrame(() => textarea.current?.focus());
        return true;
      }
      content = slashPlan.content.trim();
      if (!content) {
        // Same wedge as above for a plan rewritten to nothing: the item can
        // never become a turn, so a queued head has to leave the queue here.
        queue?.onAdmitted();
        return false;
      }
    }
    const turnSessionId = admissionSessionId;
    const turnRuntime = admissionRuntime;
    const turnTransport = turnRuntime.transport;
    const turnProfileId = admissionProfile.profileId;
    const turnProfileRevision = admissionProfile.revision;
    const turnAuthorityStillCurrent = () => (
      runtime.current === turnRuntime
      && activeSessionIdentity.current === turnSessionId
      && profileAuthorityId.current === turnProfileId
      && activeProfileRef.current?.revision === turnProfileRevision
      && !sessionNavigationChanging.current
    );
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
      return false;
    }
    if (turnRuntime.inferenceBinding && !inferenceConnected) {
      setComposerNotice("This conversation is permanently pinned to a released inference generation and remains read-only. Reconnect in Connection to start a new pinned conversation; your prompt, messages, journal, and workspace remain here.");
      setRuntimeStatus("Remote inference disconnected · prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    if (!online && turnRuntime.inferenceBinding?.transportBoundary !== "loopback-local") {
      setRuntimeStatus("Offline · remote inference paused; prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    const outgoingAttachments = retryPrompt ? retryAttachments : attachments;
    if (outgoingAttachments.length > 0 && imageInputCapability !== "supported") {
      setComposerNotice(inferenceConnected
        ? imageInputCapability === "unknown"
          ? "Airship cannot verify image support from this model's catalog record. Choose a model with explicit image input."
          : `${turnRuntime.model} is text-only. Choose a vision-capable model; the image remains in this page.`
        : "Connect a vision-capable model; the image remains in this page.");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
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
      if (activeTurn.current !== controller) return;
      activeTurn.current = undefined;
      if (activePrompt.current === content) activePrompt.current = undefined;
      setBusy(false);
    };
    let images: CanonicalMessage["images"] | undefined = undefined;
    try {
      if (outgoingAttachments.length) {
        const { prepareCanonicalImageInputs } = await import("../core/multimodal");
        images = await prepareCanonicalImageInputs(outgoingAttachments.map((attachment) => attachment.file));
      }
      controller.signal.throwIfAborted();
    } catch (error) {
      releasePreflight();
      setComposerNotice(controller.signal.aborted
        ? "Turn stopped before inference; your prompt remains in the composer."
        : error instanceof Error ? error.message : "The selected image could not be prepared safely.");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    if (!turnAuthorityStillCurrent()) {
      controller.abort(new DOMException("Profile or conversation authority changed.", "AbortError"));
      releasePreflight();
      setComposerNotice("The Profile or conversation changed while the turn was being prepared. Your prompt remains in the active draft.");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    /*
     * Name the conversation on its first real message.
     *
     * The gate is "still carrying its default name", not a head sequence. This
     * used to also require `headSequence === 1`, which silently stopped being
     * true the moment the Profile cockpit began journaling its own pointer
     * event at creation — and titling simply stopped happening, with nothing to
     * show for it. The default title is the fact that matters; how many
     * bookkeeping events preceded the message is not.
     */
    if (
      !retryPrompt
      && activeSessionRecord?.id === turnSessionId
      && activeProfile
      && activeSessionRecord.title === `${activeProfile.name} conversation`
    ) {
      const applyTitle = async (title: string) => {
        const renamed = await turnRuntime.journal.renameSession(turnSessionId, title, controller.signal);
        if (activeSessionIdentity.current === turnSessionId) {
          setActiveSessionRecord(renamed);
          setEventCount((count) => count + 1);
          setSessionRevision((value) => value + 1);
        }
      };
      try {
        // The heuristic lands first so the thread is never nameless.
        await applyTitle(conversationTitleFromPrompt(content));
      } catch {
        // Titling is presentational. A storage race must never prevent the turn.
      }
      /*
       * Then ask the model for a real name, off the turn's critical path. This
       * is not awaited: the answer arrives when it arrives, the turn never
       * waits on it, and a failed or unusable answer leaves the heuristic in
       * place — but an unusable answer is still recorded, because the request
       * that produced it was still made.
       */
      const namingTurnId = `naming-${randomUuid()}`;
      const namingOperationId = `naming-request-${randomUuid()}`;
      void conversationTitleFromModel(
        turnRuntime,
        content,
        { sessionId: turnSessionId, turnId: namingTurnId, operationId: namingOperationId },
        controller.signal,
      )
        .then(async (named) => {
          if (!named) return;
          /*
           * The record lands before the rename, and lands even when the model's
           * answer matches the heuristic, and even when the answer is no name at
           * all: a request that was made and paid for is a fact about this
           * conversation whether or not it changed the title. The usage rides in
           * its own `inference.usage` event so that every provider request this
           * session caused is counted the same way, and the naming event carries
           * the receipt that proves it happened.
           *
           * It is also written whether or not the user is still looking at this
           * conversation. The append is addressed by session id, so leaving the
           * thread cannot be what decides whether a charge is recorded; only the
           * counter and the rename below are gated on still being here.
           */
          try {
            await turnRuntime.journal.append(turnSessionId, [
              {
                type: CONVERSATION_NAMED_EVENT_TYPE,
                turnId: namingTurnId,
                operationId: namingOperationId,
                payload: {
                  // Absent when the answer was a refusal or an essay: the record
                  // then states what came back and that no name was adopted,
                  // rather than inventing one or vanishing.
                  ...(named.title ? { title: named.title } : {}),
                  answer: named.answer,
                  model: turnRuntime.model,
                  ...(named.receipt ? { receipt: named.receipt as unknown as JsonValue } : {}),
                },
              },
              ...(named.usage ? [{
                type: "inference.usage" as const,
                turnId: namingTurnId,
                operationId: namingOperationId,
                payload: {
                  ...(named.usage.inputTokens !== undefined ? { inputTokens: named.usage.inputTokens } : {}),
                  ...(named.usage.outputTokens !== undefined ? { outputTokens: named.usage.outputTokens } : {}),
                  source: "conversation-naming",
                },
              }] : []),
            ]);
            if (activeSessionIdentity.current === turnSessionId) {
              setEventCount((count) => count + (named.usage ? 2 : 1));
            }
            // Committed, so it can be shown. Bounded because this survives
            // conversation switches for the life of the page.
            const committed = named.receipt;
            if (committed) setAncillaryReceipts((current) => [...current, committed].slice(-32));
          } catch {
            // Presentational titling must not be able to fail a turn, and a
            // journal that refuses the record has already failed louder
            // elsewhere; the heuristic title stands either way.
          }
          if (activeSessionIdentity.current !== turnSessionId) return;
          // No usable name, or the same name the heuristic already applied:
          // either way there is nothing left to rename, and the record above
          // already accounts for the request.
          if (!named.title || named.title === conversationTitleFromPrompt(content)) return;
          await applyTitle(named.title);
        })
        .catch(() => undefined);
    }
    if (controller.signal.aborted) {
      releasePreflight();
      setRuntimeStatus("Turn stopped before submission");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
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
        return false;
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
            queueToolOutput(assistantId, signal);
          }
        },
      });
      clearPendingDelta(assistantId);
      // Flush before the terminal stamp: it settles `liveToolOutput` away, and
      // a surviving buffered frame would otherwise re-add it after settlement.
      flushPendingToolOutput();
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
                  // Retry forks here, not at `sourcePoint`: a live answer is
                  // the one most likely to be retried, so the boundary that
                  // excludes it has to be stamped in the same pass the replayed
                  // presentation stamps it.
                  ...(requestEvent
                    ? { turnStartPoint: { sequence: requestEvent.sequence - 1, digest: requestEvent.previousDigest } }
                    : {}),
                }
              : message,
          ),
        );
        setLastReceipt(result.receipt);
        announceCompletedTurnAwayFromChat();
        if (turnTransport.id === "chutes-e2ee-v1") {
          setConnection((current) => isChutesConnected(current) ? withVerifiedInvocation(current) : current);
          void enqueueAutomaticReceiptEvidence(result.receipt, turnSessionId, turnProfileId).catch(() => {
            // The queue and evidence client record bounded public failure state.
            // Background acquisition never changes the completed turn or receipt.
          });
        }
      }
      const workspaceRefreshWarning = await refreshCompletedTurnWorkspace(async () => {
        await refreshWorkspacePresentation(turnRuntime, turnProfileId);
      });
      if (activeSessionIdentity.current === turnSessionId) {
        setRuntimeStatus(workspaceRefreshWarning
          ? `Turn complete · workspace refresh delayed: ${workspaceRefreshWarning}`
          : "Local kernel ready");
      }
    } catch (error) {
      const pending = `${transcriptStreams.read(assistantId)}${pendingDelta.current?.messageId === assistantId ? pendingDelta.current.text : ""}`;
      clearPendingDelta(assistantId);
      flushPendingToolOutput();
      const cancelled = controller.signal.aborted;
      const failureMessage = cancelled
        ? "Turn stopped"
        : await import("./request-state")
          .then(({ mapUnknownRequestFailure }) => mapUnknownRequestFailure(error, online).message)
          .catch(() => "Request failed. Local state was kept; no remote success is assumed.");
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
        setRuntimeStatus(failureMessage);
      }
    } finally {
      const releasesComposer = activeTurn.current === controller;
      if (releasesComposer) {
        activeTurn.current = undefined;
        if (activePrompt.current === content) activePrompt.current = undefined;
      }
      releaseComposerAndReloadSession({
        release: () => { if (releasesComposer) setBusy(false); },
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
    // The prompt reached the transcript — even on the turn-failure path above,
    // where the user message is durable and only the answer is marked erred.
    return true;
  }

  function stopTurn() {
    // A follow-up typed while the turn ran is newer intent than the aborted
    // prompt; restoring unconditionally overwrote it, and the draft effect
    // then persisted the overwrite. Restore only into an empty composer.
    if (activePrompt.current) setInput((current) => current.trim() ? current : activePrompt.current ?? current);
    // Latch before the abort: the abort's teardown is what frees `busy`, and
    // the queue effect runs on that same commit.
    setQueuePaused(true);
    activeTurn.current?.abort(new DOMException("Stopped by user", "AbortError"));
  }

  async function activateLocalDeviceWorkspace(
    key: LocalDeviceWorkspaceKey,
    reason: LocalDeviceActivationReason = "opened",
  ): Promise<void> {
    const existing = localDeviceHandle.current;
    if (
      existing
      // The storage authority, not the Profile's view of it: `workspaceId`
      // now carries a Profile suffix and would never equal a bare Vault ID.
      && runtime.current?.storageId === `vault+local-device://${LOCAL_DEVICE_PARTITION}`
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
      // storage adapter. The restore disposition cannot gate this: create-new
      // reuses the enrolled key when it proves equivalent to the backup's (see
      // `restoreBackup` in local-device-vault-setup), so that path can fail
      // with a live vault closed behind it exactly as open-existing can.
      if (handleClosed) {
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

  /**
   * Opens a workspace path, and says which of the three things happened.
   *
   * A path that no longer resolves is an ordinary result of the read, not an
   * exception, so "did not throw" was never evidence that a document opened.
   * Callers that announce an outcome need the outcome, and the two failures are
   * not the same thing: `missing` is about the file, `superseded` is about this
   * request losing its runtime or profile and is nobody's business to report.
   *
   * A failed open closes nothing it did not open. Blanking the selection on any
   * unresolved path made the callers' own words false — `openMemorySource` says
   * "No document was opened" while the document you were reading vanished from
   * under you — and destroyed editor state to report a failure about a
   * different file. The one path that must still be dropped is the open one:
   * if the document on screen is the path that just failed to resolve, it no
   * longer has a file behind it, and leaving it up would present deleted
   * content as live and let a save silently recreate the file.
   */
  async function openFile(path: string): Promise<"opened" | "missing" | "superseded"> {
    const request = ++workspaceOpenRequest.current;
    const activeWorkspace = runtime.current?.workspace;
    const ownerProfileId = activeProfileRef.current?.profileId;
    const file = activeWorkspace
      ? await readWorkspaceFileBounded(activeWorkspace, path, WORKSPACE_EDITOR_BYTE_LIMIT)
      : undefined;
    if (
      request !== workspaceOpenRequest.current
      || runtime.current?.workspace !== activeWorkspace
      || !ownerProfileId
      || activeProfileRef.current?.profileId !== ownerProfileId
    ) return "superseded";
    // Through the updater rather than the captured render value: the read above
    // is awaited, so a selection set while it was in flight is the one this
    // decision has to be made against.
    setSelectedFileSelection((current) => nextEditorSelection(current, { path, ownerProfileId, file }));
    return file ? "opened" : "missing";
  }

  async function openMemorySource(target: MemorySourceTarget): Promise<void> {
    if (target.kind === "message") {
      navigate("chat", chatHash(target.sessionId));
      return;
    }
    if (!navigate("editor")) return;
    try {
      const outcome = await openFile(target.path);
      // Silence on `superseded`: the runtime or profile changed under this
      // request, so whatever is on screen belongs to that change, not to this
      // click, and naming either outcome would describe the wrong workspace.
      if (outcome === "superseded") return;
      if (outcome === "missing") {
        setRuntimeStatus(`That Memory source is no longer in the workspace: ${target.path}. No document was opened.`);
        return;
      }
      setRuntimeStatus(target.kind === "file"
        ? `Opened ${target.path} from Memory`
        : "Opened the active profile memory record in the editor");
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : "The Memory source could not be opened.");
    }
  }

  async function inspectExecutionCapabilities(): Promise<readonly ExecutionCapability[]> {
    const { inspectBrowserExecutionCapabilities } = await import("../execution/execution-runtime-pack");
    return inspectBrowserExecutionCapabilities();
  }

  async function inspectBrowserCapabilities(): Promise<BrowserRuntimeCapabilityReport> {
    const { getBrowserCapabilityRegistry } = await import("../capabilities/browser-runtime");
    return getBrowserCapabilityRegistry().refresh(true);
  }

  /*
   * The registry's publish side, handed to the Capabilities route so it renders
   * the same generation the agent reads rather than a copy taken at mount. The
   * identity has to be stable — the subscribing effect keys on it — and the
   * registry module stays deferred, so the async import is resolved inside the
   * subscription and the returned teardown covers both the pending import and
   * an established listener.
   */
  const subscribeBrowserCapabilities = useCallback((listener: (report: BrowserRuntimeCapabilityReport) => void) => {
    let released = false;
    let unsubscribe: (() => void) | undefined;
    void import("../capabilities/browser-runtime").then(({ getBrowserCapabilityRegistry }) => {
      if (released) return;
      unsubscribe = getBrowserCapabilityRegistry().subscribe(listener);
    }).catch(() => undefined);
    return () => {
      released = true;
      unsubscribe?.();
    };
  }, []);

  function openCapabilityCommand(command: string): void {
    void createConversation("Capability command").then((created) => {
      if (!created) {
        setRuntimeStatus("Finish the current operation before opening a capability conversation");
        return;
      }
      preserveComposerForDraftIdentity.current = created.id;
      setInput(command);
      setComposerNotice("New profile-scoped conversation · capability command prefilled");
      if (!window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches) {
        requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
      }
    }).catch((error) => {
      setRuntimeStatus(error instanceof Error ? error.message : "A capability conversation could not be opened.");
    });
  }

  /**
   * The one path every human-proposed effect takes.
   *
   * Three surfaces — Git, GitHub import, vault probe — each opened their own
   * approval and then dropped everything the registry path keeps: no journal
   * event, so an approved commit or a probe that wrote immutable objects left
   * no evidence at all; no abort, so a broker request outlived the screen that
   * asked for it; and Auto Approve's model reviewer sat in the middle of it,
   * able to deny an action its own operator had just proposed.
   *
   * Routing all three through here is the point: a fourth surface cannot skip
   * the record by forgetting to write it.
   */
  async function reviewHumanIntent(
    definition: ToolDefinition,
    argumentsValue: JsonValue,
    identity: Readonly<{ turnId: string; operationId: string }>,
  ): Promise<"allow" | "deny"> {
    const controller = new AbortController();
    const intentSessionId = sessionId;
    const intentRuntime = runtime.current;
    try {
      const reviewed = await decideHumanIntent({
        mode: activeApprovalMode,
        broker: approvalBroker,
        tool: definition,
        argumentsValue,
        context: {
          sessionId: intentSessionId ?? "airship-ui",
          turnId: identity.turnId,
          operationId: identity.operationId,
          signal: controller.signal,
        },
      });
      if (intentSessionId && intentRuntime) {
        try {
          await intentRuntime.journal.append(intentSessionId, [{
            type: HUMAN_INTENT_EVENT_TYPE,
            turnId: identity.turnId,
            operationId: identity.operationId,
            payload: {
              toolName: definition.name,
              effect: definition.effect,
              decision: reviewed.decision,
              summary: definition.description.slice(0, 512),
              arguments: redactForDisplay(argumentsValue),
              approval: reviewed.provenance as unknown as JsonValue,
            },
          }]);
        } catch (error) {
          // An unrecorded decision is exactly the defect this closes, so the
          // gap is stated rather than swallowed. The decision still stands:
          // refusing an approval the person already gave would be a worse lie
          // about what happened.
          setRuntimeStatus(`${definition.name} was ${reviewed.decision === "allow" ? "allowed" : "denied"}, but the decision could not be journaled: ${error instanceof Error ? error.message : "the session journal refused the append"}`);
        }
      }
      return reviewed.decision;
    } finally {
      // The controller outlived every decision it was made for, so a broker
      // request abandoned by navigation stayed pending forever.
      controller.abort();
    }
  }

  async function reviewGitOperation(
    operation: GitOperation,
    descriptor: GitOperationDescriptor,
  ): Promise<"allow" | "deny"> {
    if (!descriptor.approvalRequired) return "allow";
    return reviewHumanIntent(
      {
        name: `git_${operation.kind}`,
        description: `${descriptor.summary}. ${descriptor.dataLeavesDevice ? "Data may leave this device." : "No remote operation is implied."}`,
        effect: descriptor.brokerEffect,
        inputSchema: { type: "object" },
      },
      descriptor.arguments,
      { turnId: `human-git-${randomUuid()}`, operationId: `git-${randomUuid()}` },
    );
  }

  async function reviewSourceImport(request: SourcesImportRequest): Promise<"allow" | "deny"> {
    return reviewHumanIntent(
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
      { turnId: `human-source-${randomUuid()}`, operationId: `source-${randomUuid()}` },
    );
  }

  async function probeVault(): Promise<void> {
    if (!online) {
      setRuntimeStatus("Offline · remote vault probe paused");
      return;
    }
    const snapshot = vault.snapshot;
    if (snapshot.phase === "disconnected" || snapshot.phase === "probing") return;
    const decision = await reviewHumanIntent(
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
      { turnId: `human-vault-${randomUuid()}`, operationId: `vault-probe-${randomUuid()}` },
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
    const priorEvidenceRuntime = runtime.current;
    const priorEvidenceProfileId = activeProfileRef.current?.profileId;
    const priorEvidenceCredential = providerCredential.current;
    const priorEvidenceCredentialKind = attestationCredentialKind.current;
    const shouldRebindEvidence = Boolean(
      evidenceAcquisitionQueueAuthority.current
      || evidenceAcquisitionQueueLoad.current
      || evidenceAcquisitionQueue.current
      || attestationClientBinding.current
      || endpointEvidenceAuthority.current?.current(),
    );
    let adoptedProfileId: string | undefined;
    catalogAuthorityChanging.current = true;
    try {
      await catalogMutationTail.current;
      adoptedProfileId = await adoptDurableRuntimeExclusive(authority);
    } catch (error) {
      await rebindEvidenceAfterStorageTransition(
        shouldRebindEvidence,
        runtime.current ?? priorEvidenceRuntime,
        priorEvidenceProfileId,
        priorEvidenceCredential,
        priorEvidenceCredentialKind,
      );
      throw error;
    } finally {
      catalogAuthorityChanging.current = false;
    }
    await rebindEvidenceAfterStorageTransition(
      shouldRebindEvidence,
      runtime.current,
      adoptedProfileId,
      priorEvidenceCredential,
      priorEvidenceCredentialKind,
    );
  }

  async function adoptDurableRuntimeExclusive(
    authority: DurableAdoptionDescriptor,
  ): Promise<string> {
    const { ready, workspaceId } = authority;
    const prior = runtime.current;
    const priorCheckpoint = catalogCheckpoint.current;
    /** The one session, if any, whose transcript could not be replayed. */
    let quarantined: QuarantinedSession | undefined;
    if (!prior || !priorCheckpoint || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for vault adoption.");
    }
    activeTurn.current?.abort(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus(authority.kind === "local-device"
      ? "Opening encrypted device state"
      : "Migrating workspace and sessions into encrypted cloud objects");
    const [{ migrateJournalState, migrateProfileCatalogState, migrateWorkspaceState, reconcileAdoptedProfileCatalog }, { quiesceBrowserTerminalWorkspace }] = await Promise.all([
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
    const [{ WorkspaceGitAdapter, BrowserGitClient }, pristineBootstrap] = await Promise.all([
      loadBrowserGit(),
      targetAuthoritative ? Promise.resolve(true) : isPristineBootstrapRuntime(prior),
    ]);
    const targetCatalog = targetAuthoritative
      ? await ready.profiles.load()
      : undefined;
    const catalogMigration = targetCatalog
      ? Object.freeze({
          // An adopted catalog owns every profile and theme in it, but it is not
          // authoritative about which skills this build ships. Union them in
          // before the catalog becomes this runtime's, or the Vault's release
          // vintage silently decides the skill set forever.
          checkpoint: await reconcileAdoptedProfileCatalog(ready.profiles, targetCatalog),
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
    if (
      evidenceAcquisitionQueueAuthority.current
      || evidenceAcquisitionQueueLoad.current
      || evidenceAcquisitionQueue.current
      || attestationClientBinding.current
      || endpointEvidenceAuthority.current?.current()
    ) {
      // Freeze the worker, client cache, and record CAS authority before
      // WorkspacePort migration. Recovery is credential client → records →
      // scheduler only after the destination authority has been adopted.
      await releaseEvidenceAcquisitionQueue();
      await quiesceEndpointEvidenceClientAndStore(true);
    }
    // A freshly opened page contains deterministic sample state only. An
    // existing encrypted vault is authoritative; release-copy changes must not
    // be mistaken for user conflicts or create a throwaway session on reload.
    // Any real workspace edit or journal event disables this shortcut.
    if (!targetAuthoritative) {
      /*
       * A Profile's content now lives under the storage authority's own
       * reserved tree, so "is this target blank?" can no longer be asked by
       * filtering control-plane paths — that reads every adopted Vault as empty
       * and copies the local bootstrap over it, which then fails on the first
       * file whose content differs.
       *
       * The invariant that matters is narrower than the classification: a
       * pristine bootstrap has nothing worth keeping, so if the target holds
       * anything at all, it is the authority and nothing is copied onto it.
       */
      const targetIsBlank = (await ready.workspace.list()).length === 0;
      if (!pristineBootstrap || targetIsBlank) {
        // The storage authority, not one Profile's view: every Profile's
        // namespace has to travel, including those not currently active.
        //
        // A blank Vault receives the workspace whole. A Vault that already
        // holds state is the authority, and only reaches here because this
        // runtime has real user work to join into it — so that copy carries
        // user files and leaves the target's repositories alone.
        await migrateWorkspaceState(prior.storage, ready.workspace, targetIsBlank ? "seed" : "merge");
      }
      if (!pristineBootstrap) await migrateJournalState(prior.journal, ready.journal);
    }

    const adoptedAuthority = await openProfileWorkspaceAuthority({
      storage: ready.workspace,
      storageId: workspaceId,
      profile: selectedProfile,
    });
    const nextGitClient = adoptedAuthority.git;
    const journal = new EventJournal(ready.journal);
    /*
     * The fabric follows the Profile, not the storage root. Its routing mirror
     * is a pointer into indexed workspace content, so leaving it at the root
     * both collided between Profiles and looked like stray user content to
     * legacy adoption, which carried it into the first Profile to boot and
     * stranded every published generation behind it.
     */
    const adoptedFabric = ready.contextFabric.scopedTo(adoptedAuthority.workspace);
    const vaultTools = await createVaultAwareAirshipToolRegistry({
      workspace: adoptedAuthority.workspace,
      workspaceId: adoptedAuthority.workspaceId,
      journal,
      git: nextGitClient,
      liveEnvironment: liveEnvironmentSource,
      contextFabric: adoptedFabric,
      additionalTools: [requireProviderAvailabilityTool()],
    });
    const tools = vaultTools.tools;
    const nextRuntime: Runtime = {
      ...prior,
      storage: ready.workspace,
      storageId: workspaceId,
      workspace: adoptedAuthority.workspace,
      workspaceId: adoptedAuthority.workspaceId,
      profileId: selectedProfile.profileId,
      contextFabric: adoptedFabric,
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
    const candidateSession = pristineBootstrap
      ? await latestCompatibleProfileSession(nextRuntime, profile, nextCatalog)
      : undefined;
    let resumableSession = candidateSession;
    let resumedPresentation: Readonly<{
      messages: readonly UiMessage[];
      lastReceipt?: ConversationReceipt;
      lifecycle: SessionLifecycle;
      boundary?: Readonly<{ omittedMessages: number; shortened: boolean }>;
    }> | undefined;
    /*
     * Fail closed on the transcript, open on the storage authority.
     *
     * This block used to run outside any `try`, and it runs *before*
     * `runtime.current = nextRuntime`. One session that could not be replayed
     * therefore aborted the whole adoption: the workspace, every other session,
     * every profile, memory and the stored provider credential all became
     * unreachable, and the only fault detail anywhere in the product was an
     * event UUID in the topbar. The most likely response to that screen is to
     * wipe the store — destroying data that was never damaged.
     *
     * One conversation that cannot be replayed is one conversation's problem.
     * The vault is adopted either way, the failure is named rather than
     * swallowed, and the affected session is carried in `quarantinedSession` so
     * its row cannot go on offering a resume it cannot perform.
     */
    if (candidateSession) {
      let historyVerified = false;
      try {
        const detail = await library.inspect(
          candidateSession.id,
          activeSessionRuntime(nextRuntime, candidateSession),
        );
        if (detail.compatibility?.action !== "resume") {
          // Name the mismatch. "No longer matches" told a person nothing about
          // which pin moved, and the reasons were already computed right here.
          const because = [
            ...(detail.compatibility?.reasons ?? []).map((reason) => reason.message),
            ...detail.history.issues.map((issue) => `${issue.code}: ${issue.message}`),
          ].join(" ");
          throw new Error(`The latest encrypted session no longer matches the adopted runtime.${because ? ` ${because}` : ""}`);
        }
        const events = await journal.readEvents(candidateSession.id);
        const { auditSessionHistory, presentSessionMessages } = await loadDeferredCapabilities();
        const audit = await auditSessionHistory({ session: candidateSession, events });
        if (audit.status !== "verified") {
          throw new Error("The latest encrypted session failed its digest/protocol audit and was not resumed.");
        }
        // Past this line the audit really did pass, so the quarantine panel may
        // say so. Before it, nothing about the history has been established.
        historyVerified = true;
        const presentation = presentSessionMessages({
          session: candidateSession,
          audit,
          events: boundedSessionPresentationEvents(events),
          receipts: detail.transcript.receipts,
          history: presentationHistory(detail.transcript.messages),
        });
        const messages = transcriptMessagesFromPresentation(presentation);
        const lastPresentationReceipt = lastPresentationRowReceipt(presentation);
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
      } catch (error) {
        const { describeSessionPresentationFault } = await loadDeferredCapabilities();
        quarantined = Object.freeze({
          sessionId: candidateSession.id,
          title: candidateSession.title,
          reason: describeSessionPresentationFault(error),
          historyVerified,
        });
        resumableSession = undefined;
        resumedPresentation = undefined;
      }
    }
    const nextSession = resumableSession ?? await createProfileSession(
      nextRuntime,
      profile,
      nextCatalog,
      `${profile.name} · encrypted vault`,
    );

    workspaceRefreshCoordinator.invalidate();
    // The storage authority changed, so every cached Profile authority is over
    // the previous one and must not be reused.
    profileAuthorities.current.clear();
    runtime.current = nextRuntime;
    rememberProfileAuthority(nextRuntime, nextGitClient);
    activeDurableAuthority.current = authority;
    setGitClient(nextGitClient);
    const commandModule = await import("../commands");
    setSlashModule(() => commandModule);
    setSlashRegistry(commandModule.createSlashCommandRegistry({ tools }));
    setSessionLibrary(library);
    publishCatalogCheckpoint(nextCatalogCheckpoint);
    publishProfileId(profile.profileId);
    const activated = await activateSession(nextSession);
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
    setEventCount(activated.headSequence);
    setQuarantinedSession(quarantined);
    setSessionRevision((value) => value + 1);
    setLastReceipt(resumedPresentation?.lastReceipt);
    setSessionLifecycle(resumedPresentation?.lifecycle ?? READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(resumedPresentation?.boundary);
    let workspaceRefreshDeferred = false;
    try {
      await refreshWorkspacePresentation(nextRuntime, profile.profileId);
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
    // The quarantine is named in full — title, short id and reason — because the
    // version of this line that shipped said only "Local vault adoption failed"
    // and a UUID, which tells a user nothing they can act on and everything
    // they need to panic about.
    setRuntimeStatus(quarantined
      ? `${authority.label} active · “${quarantined.title}” (session ${quarantined.sessionId.slice(0, 8)}) could not be replayed: ${quarantined.reason} ${quarantined.historyVerified ? "Its history is intact — open Sessions to inspect it" : "Its history was not verified — open Sessions to inspect it"} · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`
      : resumableSession
        ? `${authority.label} active · audited session resumed · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`
        : `${authority.label} active · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`);
    return profile.profileId;
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
      || !active.storageId.startsWith("vault+")
      || !gitClient
      || !authority
      || authority.workspaceId !== active.storageId
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
        liveEnvironment: liveEnvironmentSource,
        // Publish into the active Profile's namespace, so the mirror written
        // here is the one this Profile's next reload reads back.
        contextFabric: active.contextFabric ?? ready.contextFabric.scopedTo(active.workspace),
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
      // Already loaded by the boot that produced this runtime; re-import is a
      // cache hit rather than a second fetch.
      const commandModule = await import("../commands");
      setSlashModule(() => commandModule);
      setSlashRegistry(commandModule.createSlashCommandRegistry({ tools: published.tools }));
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
    const priorEvidenceRuntime = runtime.current;
    const priorEvidenceProfileId = activeProfileRef.current?.profileId;
    const priorEvidenceCredential = providerCredential.current;
    const priorEvidenceCredentialKind = attestationCredentialKind.current;
    const shouldRebindEvidence = Boolean(
      evidenceAcquisitionQueueAuthority.current
      || evidenceAcquisitionQueueLoad.current
      || evidenceAcquisitionQueue.current
      || attestationClientBinding.current
      || endpointEvidenceAuthority.current?.current(),
    );
    let adoptedProfileId: string | undefined;
    catalogAuthorityChanging.current = true;
    try {
      await catalogMutationTail.current;
      adoptedProfileId = await adoptEphemeralRuntimeExclusive();
    } catch (error) {
      await rebindEvidenceAfterStorageTransition(
        shouldRebindEvidence,
        runtime.current ?? priorEvidenceRuntime,
        priorEvidenceProfileId,
        priorEvidenceCredential,
        priorEvidenceCredentialKind,
      );
      throw error;
    } finally {
      catalogAuthorityChanging.current = false;
    }
    await rebindEvidenceAfterStorageTransition(
      shouldRebindEvidence,
      runtime.current,
      adoptedProfileId,
      priorEvidenceCredential,
      priorEvidenceCredentialKind,
    );
  }

  async function adoptEphemeralRuntimeExclusive(): Promise<string> {
    const prior = runtime.current;
    const priorCheckpoint = catalogCheckpoint.current;
    if (!prior || !priorCheckpoint || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for an ephemeral transition.");
    }
    if (!prior.storageId.startsWith("vault+")) {
      vault.disconnect();
      return activeProfile.profileId;
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
    if (
      evidenceAcquisitionQueueAuthority.current
      || evidenceAcquisitionQueueLoad.current
      || evidenceAcquisitionQueue.current
      || attestationClientBinding.current
      || endpointEvidenceAuthority.current?.current()
    ) {
      await releaseEvidenceAcquisitionQueue();
      await quiesceEndpointEvidenceClientAndStore(true);
    }
    const storage = new MemoryWorkspace();
    const storageId = "memory://airship-page";
    const journalBackend = new MemoryJournalBackend();
    // Copy the whole storage authority so every Profile's namespace survives
    // the drop to page memory, not only the one that happens to be active.
    await migrateWorkspaceState(prior.storage, storage);
    await migrateJournalState(prior.journal, journalBackend);

    const ephemeralAuthority = await openProfileWorkspaceAuthority({
      storage,
      storageId,
      profile: activeProfile,
    });
    const workspace = ephemeralAuthority.workspace;
    const nextGitClient = ephemeralAuthority.git;
    const journal = new EventJournal(journalBackend);
    const tools = await createAirshipToolRegistry({
      workspace,
      journal,
      git: nextGitClient,
      liveEnvironment: liveEnvironmentSource,
      additionalTools: [requireProviderAvailabilityTool()],
    });
    const profiles = new MemoryProfileCatalogStore();
    const copiedCatalog = (await profiles.initialize(priorCheckpoint.catalog)).checkpoint;
    const nextRuntime: Runtime = {
      ...prior,
      storage,
      storageId,
      workspace,
      workspaceId: ephemeralAuthority.workspaceId,
      profileId: activeProfile.profileId,
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

    workspaceRefreshCoordinator.invalidate();
    profileAuthorities.current.clear();
    runtime.current = nextRuntime;
    rememberProfileAuthority(nextRuntime, nextGitClient);
    activeDurableAuthority.current = undefined;
    setGitClient(nextGitClient);
    const commandModule = await import("../commands");
    setSlashModule(() => commandModule);
    setSlashRegistry(commandModule.createSlashCommandRegistry({ tools }));
    setSessionLibrary(new SessionLibrary(journal));
    publishCatalogCheckpoint(nextCatalogCheckpoint);
    publishProfileId(profile.profileId);
    const activated = await activateSession(nextSession);
    setSessionRevision((value) => value + 1);
    setMessages([{
      ...welcomeMessage,
      id: randomUuid(),
      content: "Ephemeral mode is active. The current workspace and session history were copied into page memory, and the Vault connection was closed. New changes are not synced.",
    }]);
    setEventCount(activated.headSequence);
    setLastReceipt(undefined);
    setSessionLifecycle(READY_SESSION_LIFECYCLE);
    setTranscriptBoundary(undefined);
    let workspaceRefreshDeferred = false;
    try {
      await refreshWorkspacePresentation(nextRuntime, profile.profileId);
    } catch {
      workspaceRefreshDeferred = true;
      setFiles([]);
      setWorkspaceFiles([]);
    }
    if (prior.storageId.startsWith("vault+local-device://")) {
      localDeviceHandle.current?.close();
      localDeviceHandle.current = undefined;
      setLocalDeviceStatus(undefined);
    }
    vault.disconnect();
    setRuntimeStatus(workspaceRefreshDeferred
      ? "Ephemeral mode · page memory only · file view refresh due"
      : "Ephemeral mode · page memory only");
    return profile.profileId;
  }

  async function changeVaultProvider(next: VaultBackend): Promise<void> {
    if (vaultProviderSwitchingRef.current || next === preferences.vaultBackend) return;
    if (inferenceRouteChanging.current) {
      setRuntimeStatus("Finish the current inference route change before switching storage");
      return;
    }
    // Feasibility is checked before authority is released, not after. The
    // transition detaches the adopted Vault first, so selecting a destination
    // this build cannot open — Drive with no client ID, the MinIO lab off a
    // loopback origin — used to trade a working durable runtime for one that
    // could not be opened either.
    const unopenable = vaultBackendUnavailableReason(
      next,
      import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined,
      typeof window === "undefined" ? undefined : window.location,
    );
    if (unopenable) {
      setRuntimeStatus(`${unopenable} The current Vault was left attached.`);
      return;
    }
    vaultContextPublication.current?.abort(new DOMException("Vault provider is changing.", "AbortError"));
    vaultProviderSwitchingRef.current = true;
    setVaultProviderSwitching(true);
    setVaultSetupOpen(false);
    // The previous destination's adoption failure says nothing about the one
    // being selected, and the row it prints under is about to describe that one.
    setVaultAdoptionNotice(undefined);
    setRuntimeStatus("Safely releasing the current vault provider");
    try {
      await transitionVaultProvider({
        current: preferences.vaultBackend,
        next,
        runtimeUsesVault: () => runtime.current?.storageId.startsWith("vault+") === true,
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
      const release = {
        runtimeUsesVault: () => runtime.current?.storageId.startsWith("vault+") === true,
        adoptEphemeralRuntime,
        disconnectAuthority: () => vault.disconnect(),
      };
      if (preferences.vaultBackend === "ephemeral") {
        // Nothing to commit, and `transitionVaultProvider` would decline the
        // release as a no-op change.
        await releaseVaultAuthority(release);
      } else {
        // Detaching *is* choosing "Page memory only": the release alone left
        // `vaultBackend` naming the durable provider, which the Local Device
        // auto-open effect reads as a standing instruction and used to act on a
        // frame later, re-adopting the Vault the user had just released.
        await transitionVaultProvider({
          ...release,
          current: preferences.vaultBackend,
          next: "ephemeral",
          commitPreference: (provider) => setPreferences((current) => Object.freeze({ ...current, vaultBackend: provider })),
        });
      }
      setVaultSetupOpen(false);
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

  function endpointEvidenceScope(
    active: Runtime | undefined = runtime.current,
    activeProfileId: string | undefined = activeProfileRef.current?.profileId,
  ): EndpointEvidenceScope | undefined {
    if (!active || !activeProfileId) return undefined;
    return Object.freeze({
      workspace: active.workspace,
      workspaceId: active.workspaceId,
      profileId: activeProfileId,
    });
  }

  function endpointEvidenceFence(args: Readonly<{
    sessionId?: string;
    receiptId?: string;
    instanceId: string;
    endpointKeyDigest?: string;
    runtime?: Runtime;
    profileId?: string;
  }>): EndpointEvidenceFence {
    const scope = endpointEvidenceScope(args.runtime, args.profileId);
    const ownerSessionId = args.sessionId ?? activeSessionIdentity.current ?? sessionId;
    if (!scope || !ownerSessionId) {
      throw new MountedAttestationError(
        "invalid-input",
        "Endpoint evidence requires an active Profile, workspace authority, and session identity.",
      );
    }
    return Object.freeze({
      ...scope,
      sessionId: ownerSessionId,
      ...(args.receiptId ? { receiptId: args.receiptId } : {}),
      instanceId: args.instanceId,
      ...(args.endpointKeyDigest ? { endpointKeyDigest: args.endpointKeyDigest } : {}),
    });
  }

  function sameEndpointEvidenceScope(
    left: EndpointEvidenceScope | undefined,
    right: EndpointEvidenceScope | undefined,
  ): boolean {
    return Boolean(
      left
      && right
      && left.workspace === right.workspace
      && left.workspaceId === right.workspaceId
      && left.profileId === right.profileId,
    );
  }

  function isCurrentEndpointEvidenceFence(fence: EndpointEvidenceFence): boolean {
    const current = endpointEvidenceScope();
    return sameEndpointEvidenceScope(fence, current)
      && (activeSessionIdentity.current ?? sessionId) === fence.sessionId;
  }

  function recordsForEvidenceSession(
    binding: EndpointEvidenceBinding,
    ownerSessionId: string,
  ): readonly ChutesEndpointEvidenceRecord[] {
    return Object.freeze(binding.snapshot.entries
      .filter((entry) => entry.identity.sessionId === ownerSessionId)
      .map((entry) => entry.record));
  }

  function projectEndpointEvidencePresentation(
    binding: EndpointEvidenceBinding,
    ownerSessionId: string,
    options: Readonly<{
      failure?: AttestationAcquisitionFailure;
      selectedRecordId?: string;
      durabilityNotice?: string;
    }> = {},
  ): void {
    const fenceScope = endpointEvidenceScope();
    if (!sameEndpointEvidenceScope(binding, fenceScope)) return;
    setAttestationPresentation(Object.freeze({
      workspace: binding.workspace,
      workspaceId: binding.workspaceId,
      profileId: binding.profileId,
      sessionId: ownerSessionId,
      records: recordsForEvidenceSession(binding, ownerSessionId),
      ...(options.failure ? { failure: options.failure } : {}),
      ...(options.selectedRecordId ? { selectedRecordId: options.selectedRecordId } : {}),
      ...(options.durabilityNotice ? { durabilityNotice: options.durabilityNotice } : {}),
    }));
  }

  function publishAttestationFailureForFence(
    fence: EndpointEvidenceFence,
    failure: AttestationAcquisitionFailure | undefined,
  ): void {
    setAttestationPresentation((current) => {
      if (!isCurrentEndpointEvidenceFence(fence)) return current;
      const records = current
        && sameEndpointEvidenceScope(current, fence)
        && current.sessionId === fence.sessionId
          ? current.records
          : Object.freeze([]);
      return Object.freeze({
        workspace: fence.workspace,
        workspaceId: fence.workspaceId,
        profileId: fence.profileId,
        sessionId: fence.sessionId,
        records,
        ...(failure ? { failure } : {}),
        ...(current?.selectedRecordId ? { selectedRecordId: current.selectedRecordId } : {}),
        ...(current?.durabilityNotice ? { durabilityNotice: current.durabilityNotice } : {}),
      });
    });
  }

  function publishAttestationFailureForCurrent(failure: AttestationAcquisitionFailure): void {
    const active = runtime.current;
    const ownerSessionId = activeSessionIdentity.current ?? sessionId;
    const activeProfileId = activeProfileRef.current?.profileId;
    if (!active || !ownerSessionId || !activeProfileId) return;
    const instanceId = failure.instanceId ?? "connection";
    publishAttestationFailureForFence(Object.freeze({
      workspace: active.workspace,
      workspaceId: active.workspaceId,
      profileId: activeProfileId,
      sessionId: ownerSessionId,
      ...(failure.receiptId ? { receiptId: failure.receiptId } : {}),
      instanceId,
      ...(failure.endpointKeyDigest ? { endpointKeyDigest: failure.endpointKeyDigest } : {}),
    }), failure);
  }

  function selectEndpointEvidenceRecord(recordId: string | undefined): void {
    const scope = endpointEvidenceScope();
    const ownerSessionId = activeSessionIdentity.current ?? sessionId;
    if (!scope || !ownerSessionId) return;
    setAttestationPresentation((current) => {
      if (!current || !sameEndpointEvidenceScope(current, scope) || current.sessionId !== ownerSessionId) return current;
      return Object.freeze({
        ...current,
        ...(recordId ? { selectedRecordId: recordId } : { selectedRecordId: undefined }),
      });
    });
  }

  async function ensureEndpointEvidenceAuthority(
    target: EndpointEvidenceScope,
    expectedClientBinding: AttestationClientBinding,
  ): Promise<EndpointEvidenceBinding> {
    if (
      attestationClientBinding.current !== expectedClientBinding
      || !sameEndpointEvidenceScope(expectedClientBinding, target)
      || !providerCredential.current
    ) {
      throw new DOMException("The credential-backed endpoint-evidence client is not active for this scope.", "AbortError");
    }
    const current = endpointEvidenceAuthority.current?.current();
    if (current && sameEndpointEvidenceScope(current, target)) return current;
    const pending = endpointEvidenceAuthorityLoad.current;
    if (pending && sameEndpointEvidenceScope(pending, target)) return pending.promise;

    const operation = ++endpointEvidenceAuthorityOperation.current;
    const loading = import("../attestation/workspace-endpoint-evidence-persistence").then(async (module) => {
      if (attestationClientBinding.current !== expectedClientBinding || !providerCredential.current) {
        throw new DOMException("Endpoint-evidence authority changed while loading.", "AbortError");
      }
      const authority = endpointEvidenceAuthority.current ?? new module.WorkspaceEndpointEvidenceAuthority();
      endpointEvidenceAuthority.current = authority;
      const binding = await authority.activate(target);
      if (
        operation !== endpointEvidenceAuthorityOperation.current
        || attestationClientBinding.current !== expectedClientBinding
        || runtime.current?.workspace !== target.workspace
        || runtime.current?.workspaceId !== target.workspaceId
        || activeProfileRef.current?.profileId !== target.profileId
      ) {
        throw new DOMException("Endpoint-evidence recovery was superseded.", "AbortError");
      }
      const ownerSessionId = activeSessionIdentity.current ?? sessionId;
      if (ownerSessionId) projectEndpointEvidencePresentation(binding, ownerSessionId);
      return binding;
    });
    const load: EndpointEvidenceAuthorityLoad = Object.freeze({ ...target, promise: loading });
    endpointEvidenceAuthorityLoad.current = load;
    try {
      return await loading;
    } finally {
      if (endpointEvidenceAuthorityLoad.current === load) endpointEvidenceAuthorityLoad.current = undefined;
    }
  }

  async function releaseEndpointEvidenceAuthority(): Promise<boolean> {
    const authority = endpointEvidenceAuthority.current;
    const pending = endpointEvidenceAuthorityLoad.current;
    const wasActive = Boolean(authority?.current() || pending);
    endpointEvidenceAuthorityOperation.current += 1;
    endpointEvidenceAuthorityLoad.current = undefined;
    if (pending) await pending.promise.catch(() => undefined);
    await authority?.release();
    return wasActive;
  }

  async function rebindProfileEvidenceScope(
    active: Runtime,
    activeProfileId: string,
    credential: string,
    credentialKind: ActiveChutesConnection["credentialKind"],
  ): Promise<void> {
    const transition = ++evidenceScopeTransition.current;
    await releaseEvidenceAcquisitionQueue();
    if (transition !== evidenceScopeTransition.current) return;
    await quiesceEndpointEvidenceClientAndStore(true);
    if (transition !== evidenceScopeTransition.current || runtime.current !== active) return;
    const installed = await installAttestationEvidenceClient(credential, credentialKind, {
      runtime: active,
      profileId: activeProfileId,
    });
    if (!installed || transition !== evidenceScopeTransition.current || runtime.current !== active) return;
    await ensureEvidenceAcquisitionQueue(activeProfileId, active);
  }

  async function ensureEvidenceAcquisitionQueue(
    receiptProfileId: string,
    expectedRuntime: Runtime | undefined = runtime.current,
  ): Promise<EvidenceAcquisitionQueueController> {
    if (!expectedRuntime || runtime.current !== expectedRuntime) {
      throw new Error("The evidence acquisition workspace authority is not active.");
    }
    const expectedClient = attestationClientBinding.current;
    const expectedEndpointBinding = endpointEvidenceAuthority.current?.current();
    const evidenceScope = endpointEvidenceScope(expectedRuntime, receiptProfileId);
    if (
      !expectedClient
      || !expectedEndpointBinding
      || !evidenceScope
      || !providerCredential.current
      || !sameEndpointEvidenceScope(expectedClient, evidenceScope)
      || !sameEndpointEvidenceScope(expectedEndpointBinding, evidenceScope)
    ) {
      throw new DOMException(
        "Automatic endpoint evidence remains paused until a credential-backed client and matching record authority are installed.",
        "AbortError",
      );
    }
    const target = Object.freeze({
      workspace: expectedRuntime.workspace,
      workspaceId: expectedRuntime.workspaceId,
      profileId: receiptProfileId,
    });
    const currentBinding = evidenceAcquisitionQueueAuthority.current?.current();
    if (
      currentBinding
      && currentBinding.workspace === target.workspace
      && currentBinding.workspaceId === target.workspaceId
      && currentBinding.profileId === target.profileId
    ) {
      publishEvidenceAcquisitionQueue(currentBinding.queue);
      return currentBinding.queue;
    }
    const pending = evidenceAcquisitionQueueLoad.current;
    if (
      pending
      && pending.workspace === target.workspace
      && pending.workspaceId === target.workspaceId
      && pending.profileId === target.profileId
    ) return pending.promise;

    const operation = ++evidenceAcquisitionQueueOperation.current;
    const loading = Promise.all([
      import("../attestation/evidence-acquisition-queue"),
      import("../attestation/workspace-evidence-acquisition-persistence"),
    ]).then(async ([queueModule, persistenceModule]) => {
      if (runtime.current !== expectedRuntime) {
        throw new DOMException("Evidence acquisition authority changed while loading.", "AbortError");
      }
      let authority = evidenceAcquisitionQueueAuthority.current;
      if (!authority) {
        authority = new persistenceModule.WorkspaceEvidenceAcquisitionAuthority({
          worker: {
            async acquire(request, context) {
              try {
                await acquireEndpointAttestation({
                  chuteId: request.chuteId,
                  instanceId: request.instanceId,
                  signal: context.signal,
                  // A receipt identity receives its own fresh client challenge;
                  // it never reuses another session's memory-cache observation.
                  forceRefresh: true,
                  fence: endpointEvidenceFence({
                    runtime: expectedRuntime,
                    profileId: request.profileId,
                    sessionId: request.sessionId,
                    receiptId: request.receiptId,
                    instanceId: request.instanceId,
                    endpointKeyDigest: request.endpointKeyDigest,
                  }),
                  failureTarget: {
                    scope: "receipt",
                    receiptId: request.receiptId,
                    instanceId: request.instanceId,
                    ...(request.endpointKeyDigest ? { endpointKeyDigest: request.endpointKeyDigest } : {}),
                  },
                });
              } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") throw error;
                const mounted = error instanceof MountedAttestationError ? error : undefined;
                const code = mounted?.code ?? "network";
                const retryable = mounted?.context.retryable
                  ?? ["network", "timeout", "http", "evidence-unavailable", "subject-not-found"].includes(code);
                throw new queueModule.EvidenceAcquisitionAttemptError(
                  code,
                  attestationFailureLabel(code),
                  retryable,
                );
              }
            },
          },
        });
        evidenceAcquisitionQueueAuthority.current = authority;
      }
      const binding = await authority.activate(target);
      if (
        operation !== evidenceAcquisitionQueueOperation.current
        || runtime.current !== expectedRuntime
        || attestationClientBinding.current !== expectedClient
        || endpointEvidenceAuthority.current?.current() !== expectedEndpointBinding
        || authority.current()?.queue !== binding.queue
      ) {
        throw new DOMException("Evidence acquisition binding was superseded.", "AbortError");
      }
      publishEvidenceAcquisitionQueue(binding.queue);
      return binding.queue;
    });
    const load: EvidenceAcquisitionQueueLoad = Object.freeze({ ...target, promise: loading });
    evidenceAcquisitionQueueLoad.current = load;
    try {
      return await loading;
    } finally {
      if (evidenceAcquisitionQueueLoad.current === load) evidenceAcquisitionQueueLoad.current = undefined;
    }
  }

  function publishEvidenceAcquisitionQueue(queue: EvidenceAcquisitionQueueController): void {
    if (evidenceAcquisitionQueue.current !== queue) {
      evidenceAcquisitionUnsubscribe.current?.();
      // Two publications per emission, because the queue has two kinds of truth:
      // the task snapshot, and whether its last checkpoint write committed. The
      // second is not in the snapshot, and it is what parks scheduling, so it
      // gets its own reactive channel here rather than a render-time ref read.
      evidenceAcquisitionUnsubscribe.current = queue.subscribe((snapshot) => {
        setEvidenceAcquisitionSnapshot(snapshot);
        setEvidenceCheckpointFaulted(Boolean(queue.fault()));
      });
      evidenceAcquisitionQueue.current = queue;
    }
    setEvidenceAcquisitionSnapshot(queue.snapshot());
    setEvidenceCheckpointFaulted(Boolean(queue.fault()));
  }

  async function releaseEvidenceAcquisitionQueue(): Promise<boolean> {
    const authority = evidenceAcquisitionQueueAuthority.current;
    const pending = evidenceAcquisitionQueueLoad.current;
    const wasActive = Boolean(authority?.current() || pending || evidenceAcquisitionQueue.current);
    evidenceAcquisitionQueueOperation.current += 1;
    evidenceAcquisitionQueueLoad.current = undefined;
    if (pending) await pending.promise.catch(() => undefined);
    evidenceAcquisitionUnsubscribe.current?.();
    evidenceAcquisitionUnsubscribe.current = undefined;
    evidenceAcquisitionQueue.current = undefined;
    setEvidenceAcquisitionSnapshot(undefined);
    // No queue, no fault to heal: a released scope must not leave the self-heal
    // effect waking a controller this page no longer owns.
    setEvidenceCheckpointFaulted(false);
    await authority?.release();
    return wasActive;
  }

  async function rebindEvidenceAcquisitionQueue(
    shouldRebind: boolean,
    nextRuntime: Runtime | undefined,
    nextProfileId: string | undefined,
  ): Promise<void> {
    if (!shouldRebind || !nextRuntime || !nextProfileId || runtime.current !== nextRuntime) return;
    try {
      await ensureEvidenceAcquisitionQueue(nextProfileId, nextRuntime);
    } catch (error) {
      reportEvidenceAcquisitionQueueFailure(error);
    }
  }

  async function rebindEvidenceAfterStorageTransition(
    shouldRebind: boolean,
    nextRuntime: Runtime | undefined,
    nextProfileId: string | undefined,
    credential: string | undefined,
    credentialKind: ActiveChutesConnection["credentialKind"] | undefined,
  ): Promise<void> {
    if (!shouldRebind || !nextRuntime || !nextProfileId || !credential || !credentialKind) return;
    if (runtime.current !== nextRuntime) return;
    const installed = await installAttestationEvidenceClient(credential, credentialKind, {
      runtime: nextRuntime,
      profileId: nextProfileId,
    });
    if (!installed || !endpointEvidenceAuthority.current?.current()) return;
    await rebindEvidenceAcquisitionQueue(true, nextRuntime, nextProfileId);
  }

  function reportEvidenceAcquisitionQueueFailure(error: unknown): void {
    if (error instanceof DOMException && error.name === "AbortError") return;
    publishAttestationFailureForCurrent({
      label: "Automatic evidence queue unavailable",
      scope: "connection",
    });
  }

  async function enqueueAutomaticReceiptEvidence(
    receipt: ConversationReceipt,
    receiptSessionId: string,
    receiptProfileId: string,
  ): Promise<void> {
    if (!isChutesReceiptProvider(receipt.provider) || !receipt.instanceId || !receipt.model) return;
    const model = availableModels.find((candidate) => candidate.id === receipt.model);
    if (!model) {
      const fence = endpointEvidenceFence({
        profileId: receiptProfileId,
        sessionId: receiptSessionId,
        receiptId: receipt.receiptId,
        instanceId: receipt.instanceId,
        endpointKeyDigest: receipt.bindings.endpointKeyDigest,
      });
      publishAttestationFailureForFence(fence, {
        label: "Endpoint model unavailable",
        scope: "receipt",
        receiptId: receipt.receiptId,
        instanceId: receipt.instanceId,
        ...(receipt.bindings.endpointKeyDigest ? { endpointKeyDigest: receipt.bindings.endpointKeyDigest } : {}),
      });
      return;
    }
    const queue = await ensureEvidenceAcquisitionQueue(receiptProfileId);
    const enqueued = await queue.enqueue({
      version: 1,
      receiptId: receipt.receiptId,
      sessionId: receiptSessionId,
      profileId: receiptProfileId,
      providerId: "chutes",
      modelId: receipt.model,
      chuteId: model.chuteId,
      instanceId: receipt.instanceId,
      ...(receipt.bindings.endpointKeyDigest ? { endpointKeyDigest: receipt.bindings.endpointKeyDigest } : {}),
    });
    if (
      enqueued.disposition === "duplicate"
      && (enqueued.task.status === "failed" || enqueued.task.status === "cancelled")
    ) {
      // "Duplicate" answers the identity question, not the scheduling one: a
      // scope-released or exhausted task stays terminal if this path takes the
      // duplicate as "already handled", and the receipt is never re-acquired.
      // Re-arming a completed success would re-fetch settled evidence, so only
      // genuinely terminal non-success tasks get a fresh budget.
      await queue.retryTerminal(receipt.receiptId);
    }
  }

  function cancelQueuedEvidenceAcquisitions(): void {
    const queue = evidenceAcquisitionQueue.current;
    if (!queue) return;
    for (const task of queue.list()) {
      if (["succeeded", "failed", "cancelled"].includes(task.status)) continue;
      void queue.cancel(task.request.receiptId, "scope-released").catch(() => {
        // The queue exposes persistence faults separately; connection teardown
        // must still release the credential and mounted verifier immediately.
      });
    }
  }

  async function installAttestationEvidenceClient(
    credential: string,
    credentialKind: ActiveChutesConnection["credentialKind"],
    target: Readonly<{ runtime: Runtime; profileId: string }> = {
      runtime: runtime.current!,
      profileId: activeProfileRef.current!.profileId,
    },
  ): Promise<AttestationClientBinding | undefined> {
    const operation = ++attestationOperation.current;
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    attestationClientBinding.current = undefined;
    providerCredential.current = credential;
    attestationCredentialKind.current = credentialKind;
    const scope = endpointEvidenceScope(target.runtime, target.profileId);
    if (!scope || runtime.current !== target.runtime) return undefined;
    try {
      const {
        ChutesAttestationEvidenceClient: EvidenceClient,
        createIntelDcapQvlVerifierPort,
      } = await loadDeferredCapabilities();
      if (operation !== attestationOperation.current || runtime.current !== target.runtime) return undefined;
      const generation = ++attestationClientGeneration.current;
      const cachePartition = `connection-${scope.profileId}-${generation}-${randomUuid()}`;
      const client = new EvidenceClient({
        authorization: {
          kind: credentialKind === "oauth-user-token" ? "oauth" : "api-key",
          cachePartition,
          getBearerToken(signal) {
            if (signal.aborted) throw signal.reason ?? new DOMException("Attestation acquisition cancelled.", "AbortError");
            const activeBinding = attestationClientBinding.current;
            if (
              !activeBinding
              || activeBinding.generation !== generation
              || !sameEndpointEvidenceScope(activeBinding, scope)
            ) {
              throw new DOMException("The endpoint-evidence client authority changed.", "AbortError");
            }
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
      if (operation !== attestationOperation.current || runtime.current !== target.runtime) {
        client.dispose();
        return undefined;
      }
      const binding: AttestationClientBinding = Object.freeze({ ...scope, client, generation });
      attestationClient.current = client;
      attestationClientBinding.current = binding;
      try {
        await ensureEndpointEvidenceAuthority(scope, binding);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          publishAttestationFailureForCurrent({
            label: "Stored endpoint evidence rejected",
            scope: "connection",
          });
        }
      }
      return binding;
    } catch {
      if (operation !== attestationOperation.current) return undefined;
      providerCredential.current = undefined;
      attestationCredentialKind.current = undefined;
      publishAttestationFailureForCurrent({ label: "Evidence client unavailable", scope: "connection" });
      return undefined;
    }
  }

  async function quiesceEndpointEvidenceClientAndStore(preserveCredential: boolean): Promise<boolean> {
    const wasActive = Boolean(attestationClient.current || endpointEvidenceAuthority.current?.current());
    attestationOperation.current += 1;
    attestationClientGeneration.current += 1;
    attestationClient.current?.cancel();
    attestationClient.current?.dispose();
    attestationClient.current = undefined;
    attestationClientBinding.current = undefined;
    if (!preserveCredential) {
      providerCredential.current = undefined;
      attestationCredentialKind.current = undefined;
    }
    await releaseEndpointEvidenceAuthority();
    return wasActive;
  }

  function clearAttestationEvidence(preservePresentation = false): void {
    cancelQueuedEvidenceAcquisitions();
    void releaseEvidenceAcquisitionQueue();
    void quiesceEndpointEvidenceClientAndStore(false);
    if (!preservePresentation) setAttestationPresentation(undefined);
  }

  async function acquireEndpointAttestation(args: {
    chuteId: string;
    instanceId: string;
    signal?: AbortSignal;
    forceRefresh: boolean;
    fence?: EndpointEvidenceFence;
    failureTarget?: Omit<AttestationAcquisitionFailure, "label">;
  }): Promise<ChutesEndpointEvidenceRecord> {
    const client = attestationClient.current;
    const clientBinding = attestationClientBinding.current;
    const fence = args.fence ?? endpointEvidenceFence({
      sessionId: args.failureTarget?.scope === "receipt" ? undefined : activeSessionIdentity.current ?? sessionId,
      receiptId: args.failureTarget?.receiptId,
      instanceId: args.instanceId,
      endpointKeyDigest: args.failureTarget?.endpointKeyDigest,
    });
    if (
      !client
      || !clientBinding
      || clientBinding.client !== client
      || !providerCredential.current
      || !sameEndpointEvidenceScope(clientBinding, fence)
    ) {
      throw new MountedAttestationError(
        "invalid-input",
        "Connect a memory-only Chutes credential before acquiring endpoint evidence.",
      );
    }
    // This is a client-authority generation, not a "latest request wins"
    // counter. Independent receipt acquisitions may run concurrently; a
    // Profile/client teardown increments the generation and fences every late
    // result without causing sibling receipts to cancel one another.
    const operation = attestationOperation.current;
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
    if (args.signal?.aborted) {
      throw args.signal.reason ?? new DOMException("Attestation acquisition cancelled.", "AbortError");
    }
    if (
      operation !== attestationOperation.current
      || attestationClientBinding.current !== clientBinding
      || !sameEndpointEvidenceScope(clientBinding, fence)
    ) {
      throw new MountedAttestationError(
        "network",
        "A newer evidence operation superseded this acquisition.",
        { retryable: true },
      );
    }
    if (snapshot.status !== "evidence" || !snapshot.record) {
      const error = attestationSnapshotError(snapshot);
      publishAttestationFailureForFence(fence, {
        label: attestationFailureLabel(error.code),
        ...(args.failureTarget ?? { scope: "endpoint", instanceId: args.instanceId }),
      });
      throw error;
    }
    const completeRecord = endpointEvidenceForPersistence(snapshot.record);
    const authority = endpointEvidenceAuthority.current;
    const binding = authority?.current();
    if (!authority || !binding || !sameEndpointEvidenceScope(binding, fence)) {
      throw new MountedAttestationError(
        "network",
        "The endpoint-evidence storage authority is not active for this Profile and workspace.",
        { retryable: true },
      );
    }
    const identity: EndpointEvidenceRecordIdentity = Object.freeze({
      version: 1,
      profileId: fence.profileId,
      sessionId: fence.sessionId,
      ...(fence.receiptId ? { receiptId: fence.receiptId } : {}),
      instanceId: fence.instanceId,
      endpointKeyDigest: fence.endpointKeyDigest ?? completeRecord.subject.e2ePublicKeyDigest,
    });
    try {
      const result = await authority.commit(binding, { identity, record: completeRecord }, args.signal);
      if (
        operation !== attestationOperation.current
        || attestationClientBinding.current !== clientBinding
        || !sameEndpointEvidenceScope(clientBinding, fence)
      ) {
        throw new DOMException("Endpoint-evidence presentation was superseded after its durable commit.", "AbortError");
      }
      const accepted = result.disposition === "page-only" && result.reason
        ? endpointEvidenceWithDurabilityWarning(result.entry.record, result.reason)
        : result.entry.record;
      if (isCurrentEndpointEvidenceFence(fence)) {
        const activeBinding = authority.current();
        const durableRecords = activeBinding && sameEndpointEvidenceScope(activeBinding, fence)
          ? recordsForEvidenceSession(activeBinding, fence.sessionId)
          : Object.freeze([]);
        const records = result.disposition === "page-only"
          ? Object.freeze([accepted, ...durableRecords.filter((record) => record.recordId !== accepted.recordId)])
          : durableRecords;
        setAttestationPresentation(Object.freeze({
          workspace: fence.workspace,
          workspaceId: fence.workspaceId,
          profileId: fence.profileId,
          sessionId: fence.sessionId,
          records,
          ...(result.reason ? { durabilityNotice: result.reason } : {}),
        }));
      }
      return accepted;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const reason = "The complete endpoint-evidence record remains available for this page only because its CAS persistence failed. Raw quote, certificate, GPU, nonce, key, and binding material were not truncated.";
      const pageOnly = endpointEvidenceWithDurabilityWarning(completeRecord, reason);
      if (isCurrentEndpointEvidenceFence(fence)) {
        setAttestationPresentation((current) => Object.freeze({
          workspace: fence.workspace,
          workspaceId: fence.workspaceId,
          profileId: fence.profileId,
          sessionId: fence.sessionId,
          records: Object.freeze([
            pageOnly,
            ...(current?.records ?? []).filter((record) => record.recordId !== pageOnly.recordId),
          ]),
          durabilityNotice: reason,
        }));
      }
      throw new MountedAttestationError("network", "Endpoint evidence could not be committed to the active storage authority.", {
        retryable: true,
      });
    }
  }

  /**
   * Pull + verify fresh evidence for a currently-live instance of the connected
   * chute. Unlike a receipt refresh, this needs no prior turn: it discovers an
   * active endpoint and attests it as endpoint-evidence (never a retroactive
   * conversation upgrade). This is what makes "Refresh evidence" work cold.
   */
  async function probeCurrentEndpoint(signal?: AbortSignal): Promise<void> {
    const client = attestationClient.current;
    const clientBinding = attestationClientBinding.current;
    if (!client || !clientBinding || !providerCredential.current || !isChutesConnected(connection)) return;
    const model = availableModels.find((candidate) => candidate.id === connection.model);
    if (!model) {
      publishAttestationFailureForCurrent({ label: "Endpoint model unavailable", scope: "connection" });
      return;
    }
    let discovery;
    try {
      discovery = await client.discover(model.chuteId, { signal, forceRefresh: true });
    } catch (error) {
      if (!signal?.aborted && attestationClientBinding.current === clientBinding) {
        publishAttestationFailureForCurrent({ label: "Endpoint discovery failed", scope: "endpoint" });
      }
      throw error;
    }
    if (attestationClientBinding.current !== clientBinding || !sameEndpointEvidenceScope(clientBinding, endpointEvidenceScope())) {
      throw new DOMException("Endpoint discovery completed under an obsolete Profile or workspace authority.", "AbortError");
    }
    const endpoint = discovery.endpoints[0];
    if (!endpoint) {
      publishAttestationFailureForCurrent({ label: "No live endpoint is currently discoverable", scope: "endpoint" });
      return;
    }
    const fence = endpointEvidenceFence({
      instanceId: endpoint.instanceId,
    });
    // forceRefresh:false so inspect() reuses the discovery subset we just pulled
    // above — otherwise it re-discovers a different random subset that may not
    // contain this instance, and refuses to substitute → false rejection.
    await acquireEndpointAttestation({
      chuteId: model.chuteId,
      instanceId: endpoint.instanceId,
      forceRefresh: false,
      signal,
      fence,
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
      fence: endpointEvidenceFence({
        sessionId: receipt.sessionId,
        receiptId: receipt.receiptId,
        instanceId: receipt.instanceId,
        endpointKeyDigest: receipt.bindings.endpointKeyDigest,
      }),
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
      fence: endpointEvidenceFence({
        instanceId: target.record.subject.instanceId,
        endpointKeyDigest: target.record.subject.e2ePublicKeyDigest,
      }),
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
        contextPolicy: await contextPolicyForModel(model),
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
      // Commit is the one moment the pending OAuth handoff has done its job.
      // Clearing it earlier is what stranded a completed exchange on remount.
      pendingOAuthCredential.current = undefined;
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
      const activated = await activateSession(nextSession);
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
      setEventCount(activated.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      const evidenceClient = await installAttestationEvidenceClient(
        credential,
        connectionMetadata.credentialKind,
        { runtime: committedRuntime, profileId: nextProfile.profileId },
      );
      if (
        chutesAuthorityRevision.current !== committedAuthorityRevision
        || chutesTransport.current !== transport
        || chutesConnectionId.current !== nextConnectionId
        || runtime.current !== committedRuntime
      ) {
        throw new Error("The Chutes credential authority was released while connection setup was finishing.");
      }
      // Reconnection is the first point after reload where a credential-backed
      // worker can safely resume a persisted queue. Recovery before this point
      // would spend retry attempts while no evidence client exists.
      if (evidenceClient && endpointEvidenceAuthority.current?.current()) {
        await rebindEvidenceAcquisitionQueue(true, committedRuntime, nextProfile.profileId);
      }
      setAvailableModels(Object.freeze(models.slice()));
      setCredentialRevision((value) => value + 1);
      setInvocationTelemetry(undefined);
      setConnection(connectionMetadata);
      // The callback notice describes an exchange in flight ("finish the
      // connection"). Commitment is its terminal transition, and nothing else
      // wrote one, so a connected user kept being told to finish what they had
      // already finished.
      setOauthCallbackStatus(undefined);
      setRuntimeStatus(encryptedSessionReadyStatus(connectionMetadata.posture));
      navigate("chat");
    });
  }

  function releaseChutesAuthority(status: string): void {
    chutesAuthorityRevision.current += 1;
    const active = runtime.current;
    const releasedTransport = chutesTransport.current;
    const releasedTokens = oauthTokens.current;
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
    /*
     * Clearing page memory ends Airship's use of the credential. It does not
     * end the grant: a refresh token that has leaked stays valid at the
     * provider for the rest of its lifetime unless something asks the
     * revocation endpoint to drop it, and the only caller that ever did was a
     * broker production never mounts. The transport's identically named
     * `revokeCredential` above is why the gap was invisible here.
     *
     * Detached and best-effort by construction: teardown above is already
     * complete and released state is set whatever happens next, so a hung or
     * refused revocation cannot hold sign-out open. Its result is never
     * reported as proof the provider session ended — the endpoint answers 200
     * for tokens it has never seen (docs/gap-audit/inference.md).
     */
    if (releasedTokens) {
      void (async () => {
        const { CHUTES_ACTIVE_REGISTRATION, revokeChutesToken } = await import("../auth/chutes-oauth");
        for (const [token, tokenTypeHint] of [
          [releasedTokens.refreshToken, "refresh_token"],
          [releasedTokens.accessToken, "access_token"],
        ] as const) {
          if (!token) continue;
          await revokeChutesToken({
            token,
            tokenTypeHint,
            clientId: CHUTES_ACTIVE_REGISTRATION.clientId,
            registration: CHUTES_ACTIVE_REGISTRATION,
          }).catch(() => undefined);
        }
      })().catch(() => undefined);
    }
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
        contextPolicy: await contextPolicyForModel(model),
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
      const activated = await activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        content: `${model.id} is active in a new pinned session. The prior session and its receipt chain were not rewritten.`,
      }]);
      setEventCount(activated.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      attestationOperation.current += 1;
      attestationClient.current?.cancel();
      attestationClient.current?.clear();
      setAttestationPresentation(undefined);
      setInvocationTelemetry(undefined);
      setConnection(nextConnection);
      setRuntimeStatus(encryptedSessionReadyStatus(connection.posture));
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
        contextPolicy: await contextPolicyForProviderModel(route.pin.model),
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
      const activated = await activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        // "through <label>." became "Boundary: <label>." when the two boundary
        // sentences were merged: the surviving label is the Connect route's
        // titled form, and a titled clause mid-sentence read as a typo.
        content: `${route.pin.provider.label}/${route.pin.model.id} is active in a new immutable session. Boundary: ${providerBoundaryLabel(route.pin.provider.transportBoundary)}. Its connection generation and model are pinned; existing conversations were not retargeted.`,
      }]);
      setEventCount(activated.headSequence);
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
            detail: `Already connected in this tab · ${modelCountLabel(held.models.length)}${modelNameList(held.models)}.`,
          }));
          continue;
        }
        try {
          const connected = await fabric.connectLocal({ kind: server.kind, signal: controller.signal });
          results.push(Object.freeze({
            id: server.kind,
            label: server.label,
            outcome: "answered" as const,
            detail: `Answered on ${server.endpoint} · ${modelCountLabel(connected.models.length)}${modelNameList(connected.models)}.`,
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
      setComposerNotice("Stop the active turn and wait for model or storage changes before changing the approval policy.");
      return;
    }
    const active = runtime.current;
    sessionNavigationChanging.current = true;
    // Function scope, not try scope: the catch reads it to tell the default
    // already committed from a refusal before the write.
    let defaultCommitted = false;
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
      // From here on the profile's durable default HAS changed: a failure in
      // the activation leg below must say so instead of reading as if nothing
      // happened.
      defaultCommitted = true;
      const nextSession = await createProfileSession(
        active,
        revisedProfile,
        committed.catalog,
        `${activeSessionRecord.title} · ${approvalModeLabel(nextMode)}`.slice(0, 240),
      );
      if (runtime.current !== active) throw new Error("The runtime changed before the approval policy could become active.");
      publishProfileId(revisedProfile.profileId);
      const activated = await activateSession(nextSession);
      // Say the whole blast radius. The only place an approval mode can live is
      // a profile revision, and this commits one through `replaceProfile`, so
      // the profile's *next* conversation starts here too. Describing that as
      // conversation-scoped made a durable policy change read as a local one.
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        content: `Approval policy changed to ${approvalModeLabel(nextMode)} in this new pinned conversation, and ${revisedProfile.name} will start new conversations in ${approvalModeLabel(nextMode)} until you change it again. The previous conversation remains unchanged and addressable from its URL and conversation history.`,
      }]);
      setEventCount(activated.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setSessionRevision((value) => value + 1);
      setComposerNotice(undefined);
      setRuntimeStatus(`${approvalModeLabel(nextMode)} active · new pinned conversation · ${revisedProfile.name} default`);
      navigate("chat", chatHash(nextSession.id));
    } catch (error) {
      /*
       * Two different failures, two different sentences. Before the catalog
       * commit nothing changed and the failure can say exactly that. After it,
       * the profile's durable default already moved to the new mode — a
       * "could not be changed" notice would be a false statement about
       * state the user can verify by reopening the profile, so the notice
       * names what actually happened: default updated, activation failed.
       */
      const detail = error instanceof Error ? error.message : "The approval policy could not be changed.";
      setComposerNotice(defaultCommitted
        ? `The profile default was updated to ${approvalModeLabel(nextMode)}, but the new conversation could not be opened. ${detail}`
        : detail);
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
      // Archiving the profile the cockpit is still running on is the one
      // outcome this path may never produce, so the switch has to have
      // actually committed — not merely have been attempted.
      if (!await changeProfile(replacementProfileId, true)) {
        throw new Error("The replacement profile did not activate, so the active profile was not archived. The status line names the reason.");
      }
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
    const editingActiveProfile = profileIdToEdit === profileId;
    const active = runtime.current;
    if (editingActiveProfile && (
      busy
      || !active
      || !activeSessionRecord
      || inferenceRouteChanging.current
      || sessionNavigationChanging.current
    )) {
      throw new Error("Stop the active turn and wait for model or storage changes before changing this Profile's skill policy.");
    }
    if (editingActiveProfile) sessionNavigationChanging.current = true;
    // Function scope, not try scope: the catch reads both to tell the default
    // already committed from a refusal before the write.
    let revisedProfile: ProfileRevision | undefined;
    let defaultCommitted = false;
    try {
      const committed = await mutateProfileCatalog(async (current) => {
        const profile = current.profiles.find((candidate) => candidate.profileId === profileIdToEdit);
        if (!profile) throw new Error("The selected profile no longer exists.");
        revisedProfile = await createProfileRevision({
          ...profile,
          parentRevision: profile.revision,
          skillModes: { ...profile.skillModes, [skillId]: mode },
          createdAt: new Date().toISOString(),
        });
        return replaceProfile(current, revisedProfile);
      });
      if (!revisedProfile) throw new Error("The skill-policy Profile revision was not created.");
      if (!editingActiveProfile) {
        setRuntimeStatus(`${revisedProfile.name} skill policy revised · its next switch starts a new pinned conversation · the current conversation remains in All Conversations`);
        return;
      }
      // From here on the profile's durable skill policy HAS changed, so a
      // failure in the activation leg must not bubble up as if the write was
      // refused. The caller renders the thrown message verbatim; make it say
      // what actually happened.
      defaultCommitted = true;
      const nextSession = await createProfileSession(
        active!,
        revisedProfile,
        committed.catalog,
        `${activeSessionRecord!.title} · skills revised`.slice(0, 240),
      );
      if (runtime.current !== active) throw new Error("The runtime changed before the skill policy could become active.");
      const activated = await activateSession(nextSession);
      setMessages([{
        ...welcomeMessage,
        id: randomUuid(),
        content: `Skill policy changed in this new pinned conversation for ${revisedProfile.name}. The previous conversation remains unchanged and addressable from its URL and All Conversations.`,
      }]);
      setEventCount(activated.headSequence);
      setLastReceipt(undefined);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setSessionRevision((value) => value + 1);
      setComposerNotice(undefined);
      setRuntimeStatus(`${revisedProfile.name} skill policy active · new pinned conversation`);
      navigate("chat", chatHash(nextSession.id));
    } catch (error) {
      if (defaultCommitted && revisedProfile) {
        throw new Error(`The ${revisedProfile.name} profile default was updated, but the new conversation could not be opened. ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      if (editingActiveProfile) sessionNavigationChanging.current = false;
    }
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

  async function loadAuditedSessionSnapshot(
    targetSessionId: string,
    expectedProfileId?: string,
    /*
     * Which journal to audit. Defaults to the committed runtime, which is what
     * every ordinary caller means. A profile switch passes the *incoming*
     * runtime so the target conversation can be audited before any authority is
     * published — validating after the commit is what left a rejected switch
     * running the old UI against the new profile's workspace.
     */
    sourceRuntime = runtime.current,
  ): Promise<Readonly<{
    report: SessionAuditReport;
    session: SessionRecord;
    events: readonly DurableEvent[];
  }>> {
    const activeRuntime = sourceRuntime;
    if (!activeRuntime) throw new Error("The local runtime is not ready.");
    const [{ auditSessionHistory }, session] = await Promise.all([
      loadDeferredCapabilities(),
      activeRuntime.journal.getSession(targetSessionId),
    ]);
    if (!session) throw new Error("The active session is no longer available in this page runtime.");
    if (expectedProfileId) requireProfileOwnedSession(session, expectedProfileId, "open");
    const events = await activeRuntime.journal.readEvents(targetSessionId);
    return Object.freeze({
      report: await auditSessionHistory({ session, events }),
      session,
      events: boundedSessionPresentationEvents(events),
    });
  }

  async function loadSessionAudit(targetSessionId: string): Promise<SessionAuditReport> {
    const expectedRuntime = runtime.current;
    const expectedProfileId = profileAuthorityId.current;
    if (!expectedRuntime) throw new Error("The local runtime is not ready.");
    const audited = await loadAuditedSessionSnapshot(targetSessionId, expectedProfileId);
    if (
      runtime.current !== expectedRuntime
      || profileAuthorityId.current !== expectedProfileId
    ) throw new Error("The Profile or Proof authority changed while the session audit was loading.");
    return audited.report;
  }

  async function publishAuditedSession(
    fresh: SessionLibraryDetail,
    audited: Awaited<ReturnType<typeof loadAuditedSessionSnapshot>>,
    status: string,
  ): Promise<void> {
    const { describeSessionPresentationFault, presentSessionMessages } = await loadDeferredCapabilities();
    const presentation = (() => {
      try {
        return presentSessionMessages({
          session: audited.session,
          audit: audited.report,
          events: audited.events,
          receipts: fresh.transcript.receipts,
          history: presentationHistory(fresh.transcript.messages),
        });
      } catch (error) {
        throw new Error(`“${fresh.session.title}” could not be replayed: ${describeSessionPresentationFault(error)} Its history is intact — open Proof.`);
      }
    })();
    const activated = await activateSession(audited.session);
    setMessages(presentation.rows.length + presentation.markers.length > 0
      ? transcriptMessagesFromPresentation(presentation)
      : [{ ...welcomeMessage, id: randomUuid(), content: `Resumed ${fresh.session.title}. ${welcomeMessage.content}` }]);
    setEventCount(activated.headSequence);
    setLastReceipt(lastPresentationRowReceipt(presentation));
    setSessionLifecycle(fresh.transcript.lifecycle);
    setTranscriptBoundary(fresh.transcript.truncated ? {
      omittedMessages: fresh.transcript.omittedMessages,
      shortened: fresh.transcript.messages.some((message) => message.truncated),
    } : undefined);
    setProofSelection(undefined);
    setSessionRevision((value) => value + 1);
    setRuntimeStatus(status);
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
      let resumedProfileId: string | undefined;
      if (pinnedProfile) {
        const profile = catalog.profiles.find((candidate) =>
          candidate.profileId === pinnedProfile.profileId && candidate.revision === pinnedProfile.profileRevision,
        );
        if (!profile) throw new Error("The exact profile revision pinned by this session is unavailable; create a fork instead.");
        resumedProfileId = profile.profileId;
        if (profile.profileId !== profileId) {
          workspaceRefreshCoordinator.invalidate();
          pendingForkRetry.current = undefined;
          setProfileCockpitTransition(Object.freeze({ profileId: profile.profileId, name: profile.name }));
        }
      }
      await publishAuditedSession(fresh, audited, "Audited session resumed");
      if (resumedProfileId) publishProfileId(resumedProfileId);
      navigate("chat");
    } finally {
      sessionNavigationChanging.current = false;
      setProfileCockpitTransition(undefined);
    }
  }

  async function activateForkedSession(result: SessionForkResult): Promise<void> {
    if (sessionNavigationChanging.current) {
      throw new Error("Wait for the current conversation transition before activating a fork.");
    }
    sessionNavigationChanging.current = true;
    try {
      const activationRuntime = runtime.current;
      const activationProfile = activeProfileRef.current;
      const activationSessionId = activeSessionIdentity.current;
      if (!activationRuntime || !activationProfile || !activationSessionId) {
        throw new Error("The active Profile/session authority is unavailable for fork verification.");
      }
      const authoritySession = await activationRuntime.journal.getSession(activationSessionId);
      if (
        !authoritySession
        || runtime.current !== activationRuntime
        || activeSessionIdentity.current !== activationSessionId
        || profileAuthorityId.current !== activationProfile.profileId
        || activeProfileRef.current?.revision !== activationProfile.revision
      ) throw new Error("The active Profile/session authority changed before the fork could be verified.");
      requireProfileOwnedSession(authoritySession, activationProfile.profileId, "fork");
      await activateForkedSessionAgainst(result, Object.freeze({
        runtime: activationRuntime,
        profileId: activationProfile.profileId,
        profileRevision: activationProfile.revision,
        activeSessionId: activationSessionId,
        manifest: authoritySession.manifest,
      }));
    } finally {
      sessionNavigationChanging.current = false;
    }
  }

  async function activateForkedSessionAgainst(
    result: SessionForkResult,
    authority: ForkActivationAuthority,
  ): Promise<void> {
    if (inferenceRouteChanging.current) {
      throw new Error("The inference route changed before this fork could become active.");
    }
    if (
      runtime.current !== authority.runtime
      || profileAuthorityId.current !== authority.profileId
      || activeProfileRef.current?.revision !== authority.profileRevision
      || activeSessionIdentity.current !== authority.activeSessionId
    ) throw new Error("The active Profile/session authority changed before this fork could become active.");
    if (
      result.session.manifest.profile?.profileId !== authority.profileId
      || !resumableProfileManifestMatches(result.session.manifest, authority.manifest)
    ) throw new Error("The fork manifest is not compatible with the active Profile and runtime authority.");
    const library = new SessionLibrary(authority.runtime.journal);
    const fresh = await library.inspect(
      result.session.id,
      sessionManifestRuntime(authority.runtime, authority.manifest),
    );
    if (fresh.compatibility?.action !== "resume") {
      throw new Error(
        fresh.compatibility
          ? `${fresh.compatibility.label}: ${fresh.compatibility.reasons.map((reason) => reason.message).join(" ")}`
          : "The fork did not produce a resumable session for the active authority.",
      );
    }
    const audited = await loadAuditedSessionSnapshot(result.session.id);
    if (audited.report.status !== "verified") {
      throw new Error("The new fork did not pass its complete local journal audit.");
    }
    if (
      audited.session.headSequence !== fresh.session.headSequence
      || audited.session.headDigest !== fresh.session.headDigest
      || audited.session.headSequence !== result.session.headSequence
      || audited.session.headDigest !== result.session.headDigest
    ) {
      throw new Error("The new fork changed before its context commitment could be presented.");
    }
    if (
      runtime.current !== authority.runtime
      || profileAuthorityId.current !== authority.profileId
      || activeProfileRef.current?.revision !== authority.profileRevision
      || activeSessionIdentity.current !== authority.activeSessionId
    ) throw new Error("The active Profile/session authority changed during fork verification.");
    await publishAuditedSession(fresh, audited, "Verified context fork active");
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
  // `platformOverlayOpen` is computed once, next to the navigation-jump gate.
  const sessionDurability = describeSessionDurability({
    localDeviceRuntimeAdopted,
    cloudVaultRuntimeAdopted,
    googleDriveVault: googleDriveVaultAdopted,
    vaultContractReady: vaultSnapshot.phase === "ready",
    syncTarget: cloudVaultRuntimeAdopted && vaultSnapshot.phase === "ready"
      ? isGoogleDriveConfiguration(vaultSnapshot.config) ? vaultSnapshot.config.workspaceName : vaultSnapshot.config.bucket
      : undefined,
    online,
  });
  /*
   * An empty conversation renders its intro, not a card. The seed flag — not
   * the message count — is the fence: a materialized session can legitimately
   * hold exactly one real message, and re-presenting that as chrome would
   * delete a turn from the screen.
   */
  const seedOnlyTranscript = messages.length === 0
    || (messages.length === 1 && messages[0]!.seed === true);
  const e2eeTrustAxis = trustAxes.find((axis) => axis.id === "e2ee")!;
  // The vocabulary this claim belongs to owns the mapping: page memory is `none`
  // rather than `failed` (nothing went wrong, no durability evidence was asked
  // for), a running sync is `checking`, and a stopped one is `attention`. Read
  // from `durability-indicator` rather than restated, because a fourth copy of
  // the ternary is how the chip and the pill came to disagree.
  const sessionDurabilitySeal: SealState = durabilitySeal(sessionDurability.state);
  /**
   * The four claims the session bar used to render as four separate objects —
   * an attestation button, a lifecycle dot, a durability pill and a boundary
   * pill 140px away in the model card. They are assembled here rather than
   * inside the chip because every string is quoted verbatim from the vocabulary
   * that owns it, and none of those vocabularies belong to the chip.
   */
  /*
   * One string, read by the session chip, its abbreviation and the model card.
   *
   * These are the three surfaces the auditor found describing one connection
   * in two languages, and they were three separate expressions of the same
   * ternary. Computed once, they cannot drift; `activeConnectionProofLabel`
   * (in `model-control.tsx`, beside its test) is the only definition of the
   * words themselves.
   */
  const e2eeBoundaryLabel = activeChutesConnection ? activeConnectionProofLabel(connection) : e2eeTrustAxis.label;
  const sessionStatusFacts: readonly SessionStatusFact[] = Object.freeze([
    Object.freeze({
      id: "posture" as const,
      state: e2eeTrustAxis.state,
      label: e2eeBoundaryLabel,
      detail: e2eeTrustAxis.detail,
      short: sessionStatusShort(e2eeBoundaryLabel, SEAL_LABELS[e2eeTrustAxis.state]),
      action: Object.freeze({ label: "Models", onSelect: () => navigate("access") }),
    }),
    Object.freeze({
      id: "attestation" as const,
      state: attestationSeal.state,
      // Verbatim from `.session-attestation`, which stated the scope clause and
      // then hid the sentence explaining it in a `title`. Both are visible now.
      label: `${attestationSeal.label} · this session`,
      detail: attestationSeal.detail,
      short: sessionStatusShort(attestationSeal.label, SEAL_LABELS[attestationSeal.state]),
      action: Object.freeze({ label: "Proof", onSelect: () => openSessionProof() }),
    }),
    Object.freeze({
      id: "durability" as const,
      state: sessionDurabilitySeal,
      label: durabilityLabel(sessionDurability.state),
      detail: sessionDurability.detail,
      short: sessionStatusShort(durabilityLabel(sessionDurability.state), SEAL_LABELS[sessionDurabilitySeal]),
      action: Object.freeze({ label: "Vault", onSelect: () => navigate("vault") }),
    }),
    Object.freeze({
      id: "lifecycle" as const,
      // A completed turn is not `verified`: nothing cryptographic was checked by
      // finishing. It stays `none` so the seal vocabulary keeps meaning what
      // §4.4 says it means.
      state: sessionLifecycle.state === "running"
        ? "checking"
        : sessionLifecycle.state === "failed"
          ? "failed"
          : sessionLifecycle.state === "cancelled" ? "attention" : "none",
      label: sessionLifecycle.label,
      detail: sessionLifecycle.turnId
        ? `Turn ${sessionLifecycle.turnId} in this session.`
        : "No turn has started in this session.",
      short: sessionStatusShort(sessionLifecycle.label, SESSION_LIFECYCLE_SHORT[sessionLifecycle.state]),
    }),
  ]);

  return (
    <div
      class="app-shell"
      data-connectivity={online ? "online" : "offline"}
      data-active-profile={profileId}
      data-session-profile={activeSessionRecord?.manifest.profile?.profileId}
      data-active-session={sessionId}
      data-proof-session={view === "proof" ? proofTargetId : undefined}
    >
      {/* Tabbing from the document start otherwise crosses the whole rail, the
          recent-conversation list and the profile switcher — 35 stops — before
          reaching the composer, the highest-frequency control in the product.
          These are buttons, not `href="#..."` anchors: the shell routes on the
          location hash, so an in-page anchor would navigate the application. */}
      <div class="skip-links" inert={platformOverlayOpen} aria-hidden={platformOverlayOpen || undefined}>
        {/* The first link names what it actually lands on. `.main` is the
            transcript on `#chat` — the one route where a generic "main content"
            would be vaguer than the product can afford, because the second link
            (composer) only exists there and the pair has to read as two
            distinct places. Every other route puts an arbitrary view in the
            same element, so "main content" is the only name that stays true
            there. */}
        <button
          class="skip-link"
          type="button"
          onClick={() => mainRegion.current?.focus({ preventScroll: true })}
        >{view === "chat" ? "Skip to conversation" : "Skip to main content"}</button>
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
        {/* One chip, every width, every connection state. The four axis pills
            (398px, the fourth truncated) and the phone-only `.mobile-trust-chip`
            were two components rendering one fact at two sizes; the sheet they
            both open still renders all four axes verbatim. */}
        <div class="topbar-center" role="group" aria-label="Runtime state">
          <TopbarPostureChip axes={trustAxes} onOpen={() => setTrustSheetOpen(true)} />
        </div>
        <div class="topbar-actions">
          {/* The `e2ee` axis used to render its own action pill here on desktop
              and a second one inside the guidance band 130px below it, while a
              phone got a third, differently-worded one. This is the one button:
              same verb at every width, and the only brass object above the fold,
              because connecting a provider is the only thing a disconnected user
              has to do. Its visible text and its accessible name are the same
              string, so the shipped `exact: true` selector reads what is drawn. */}
          {!inferenceConnected ? (
            <button class="topbar-connect-action" type="button" onClick={() => navigate("access")}>Connect a model</button>
          ) : null}
          <MenuSelect
            className="compact-profile-menu"
            compact
            ariaLabel="Agent profile"
            value={profileId}
            disabled={busy}
            options={managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name }))}
            leading={(option) => <span class="profile-monogram" aria-hidden="true">{profileMonogram(option.label)}</span>}
            onChange={(nextId) => void requestProfileChange(nextId)}
          />
          <span class="runtime-line" title={runtimeStatus}><span class="pulse-dot" /><span class="runtime-line__text">{runtimeStatus}</span></span>
          <span class="sr-only" role="status" aria-live="polite">{runtimeStatus}</span>
          <button class="icon-button" type="button" aria-label="Open command palette" title="Command palette · ⌘K" onClick={() => setPaletteOpen(true)}>
            <span aria-hidden="true">⌘</span>
          </button>
          <button class="icon-button" type="button" aria-label="Open Preferences" onClick={() => setPreferencesOpen(true)}>
            <Icon name="settings" />
          </button>
          <button class="icon-button" type="button" aria-label="Open proof" onClick={() => openSessionProof()}>
            <Icon name="proof" />
          </button>
        </div>
      </header>

      <Rail
        view={view}
        state={railState}
        navRef={primaryNav}
        inert={platformOverlayOpen}
        busy={busy}
        unreadTurnCount={unreadTurnCount}
        hasReceipt={Boolean(lastReceipt)}
        conversations={recentProfileConversations}
        activeConversationId={sessionId ?? ""}
        formatTime={formatConversationTime}
        profiles={managedProfiles(catalog)}
        profileId={profileId}
        monogram={profileMonogram}
        onNavigate={(next) => navigatePrimary(next)}
        onManageProfiles={() => { openProfileManager(profileId); }}
        onNewConversation={() => void createConversation()}
        onChangeProfile={(nextId) => void requestProfileChange(nextId)}
        onToggleState={toggleRailState}
        onInteractionError={setRuntimeStatus}
      />

      <ViewErrorBoundary key={view} name={destinationLabel(view) ?? "Airship"} onRecover={() => navigate("chat")}>
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
            <section class="chat-stage" aria-label="Agent session" data-scrolled={stageScrolled ? "true" : undefined}>
              <SessionBar
                title={activeSessionRecord?.title ?? activeProfile.name}
                profileName={activeProfile.name}
                monogram={profileMonogram(activeProfile.name)}
                pinnedSkills={activeSessionRecord?.manifest.profile ? {
                  skillSetDigest: activeSessionRecord.manifest.profile.skillSetDigest,
                  skills: activeSessionRecord.manifest.profile.resolvedSkills.map((resolved) => ({
                    skillId: resolved.skillId,
                    digest: resolved.digest,
                    name: catalog.skills.find((candidate) => candidate.skillId === resolved.skillId && candidate.digest === resolved.digest)?.name
                      ?? resolved.skillId,
                  })),
                } : undefined}
                statusFacts={sessionStatusFacts}
                durabilityLabel={durabilityLabel(sessionDurability.state)}
                journal={{
                  eventCount,
                  sessionId,
                  lineage: activeSessionRecord?.manifest.lineage?.kind === "fork"
                    ? {
                        sourceSessionId: activeSessionRecord.manifest.lineage.sourceSessionId,
                        onOpen: () => void openPaletteSession(activeSessionRecord.manifest.lineage!.sourceSessionId),
                      }
                    : undefined,
                }}
                onOpenSession={() => navigate("sessions")}
                onRename={renameActiveConversation}
                renameDisabled={busy}
                onNewConversation={() => void createConversation()}
                newConversationDisabled={busy}
                model={inferenceConnected || pinnedExternalRoute || activeInferenceBinding?.providerId === "chutes" ? (
                  <ModelControl
                    active={activeChutesConnection ? {
                      providerLabel: "Chutes",
                      modelId: connection.model,
                      boundaryLabel: e2eeBoundaryLabel,
                    } : activeExternalConnection ? {
                      providerLabel: activeExternalConnection.pin.provider.label,
                      modelId: activeExternalConnection.pin.model.id,
                      boundaryLabel: providerBoundaryLabel(activeExternalConnection.pin.provider.transportBoundary),
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
                        }))
                      : activeExternalConnection?.models.map((model) => ({
                          id: model.id,
                          label: model.label,
                          // The shared word, not a second spelling of it. An
                          // external provider has no `AirshipModel` and so no
                          // access to `capabilityLabels`, but it may not invent
                          // its own noun for the same declared capability.
                          detail: externalModelCapabilityDetail(model),
                        })) ?? []}
                    busy={busy}
                    switching={modelSwitching}
                    onSelect={activeChutesConnection ? switchChutesModel : switchExternalModel}
                    onOpenConnection={() => navigate("access")}
                    picker={activeChutesConnection && ModelPickerControl ? (control) => (
                      <ModelPickerControl
                        models={availableModels}
                        value={connection.model}
                        disabled={control.disabled}
                        onSelect={control.select}
                      />
                    ) : undefined}
                  />
                ) : <DemoModelChip onConnect={() => navigate("access")} />}
              />
              <div
                ref={transcriptElement}
                class={messages.length <= 1 ? "transcript no-turns" : "transcript"}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  const pinned = isNearLastRealCard(element, 64);
                  transcriptPinned.current = pinned;
                  if (
                    sessionId
                    && !profileCockpitTransition
                    && activeSessionRecord?.manifest.profile?.profileId === profileId
                  ) {
                    writeThreadViewport(profileId, sessionId, {
                      scrollTop: element.scrollTop,
                      pinnedToLatest: pinned,
                    }, browserThreadViewportStorage());
                  }
                  setTranscriptDetached(!pinned);
                  // The only scroll-driven collapse in the product. The bar sheds
                  // chip labels, never chips: every `title` and `aria-label`
                  // survives, and `(pointer: coarse)` opts out entirely in CSS so
                  // a 44px target can never shrink under a thumb.
                  setStageScrolled(element.scrollTop > SESSION_BAR_COLLAPSE_SCROLL);
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
                {/* An empty transcript has no turns, so it renders no turn
                    cards. The seed "message" was an assistant card no model
                    produced, with an avatar attributing a speaker and a
                    Retry/Branch menu whose operations had no referent; its two
                    real claims are the intro's own lines and its per-context
                    note is passed through verbatim. */}
                {seedOnlyTranscript ? (
                  <TranscriptIntro
                    note={transcriptIntroNote(messages[0]?.content)}
                    demo={composerUsesDemo}
                    tier={activeSessionRecord?.manifest.capabilityTier}
                    onOpenCapabilities={() => navigate("capabilities")}
                  />
                ) : <>
                {windowedTranscript.topSpacerHeight > 0
                  ? <div class="transcript-spacer" style={{ height: windowedTranscript.topSpacerHeight }} aria-hidden="true" />
                  : null}
                {windowedTranscript.entries.map((entry) => (
                  <div
                    class="transcript-row"
                    key={entry.key}
                    ref={(element) => windowedTranscript.observeElement(entry.key, entry.revision, element)}
                  >
                    {entry.item.marker ? <TranscriptMarker marker={entry.item.marker} onOpenProof={openReceiptProof} /> : <MessageCard
                      message={entry.item}
                      capabilityTier={activeSessionRecord?.manifest.capabilityTier}
                      onProof={() => entry.item.receipt && openReceiptProof(entry.item.receipt)}
                      onAttestations={() => entry.item.receipt ? openReceiptAttestation(entry.item.receipt) : openAttestationEvidence()}
                      attestation={describeMessageAttestation(entry.item.receipt, attestationRecords, attestationFailure, attestationNow)}
                      onCopy={() => void navigator.clipboard.writeText(entry.item.parts?.length ? messagePlainText(entry.item.parts) : entry.item.content)}
                      onRetry={() => void forkFromMessage(entry.item, "retry")}
                      onEdit={() => void forkFromMessage(entry.item, "edit")}
                      onBranch={() => void forkFromMessage(entry.item, "fork")}
                      branchDisabled={!sessionLibrary || !activeSessionRecord || busy || !entry.item.sourcePoint}
                      streamStore={transcriptStreams}
                    />}
                  </div>
                ))}
                </>}
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
                {/* Send's `aria-describedby` points here. The guidance band that
                    used to own this id was a 42px banner; the transcript intro
                    that now says the same sentence unmounts after the first
                    turn, and a popover unmounts when it closes. This paragraph
                    is the only carrier whose lifetime matches the reference, so
                    the description can never dangle. */}
                {composerUsesDemo ? (
                  <p class="sr-only" id="chat-demo-guidance">{TRANSCRIPT_INTRO_DEMO_LINE}</p>
                ) : null}
                <div
                  class={`composer${busy ? " busy" : ""}`}
                >
                  {slashMenuOpen ? (
                    <div
                      class="slash-command-menu"
                      id="slash-command-menu"
                      role="listbox"
                      aria-label={`Available slash commands — showing ${slashCompletions.length} of ${slashMenu.total}`}
                    >
                      {/* Not an option: a listbox may only own options, so the
                          count lives in the listbox's own accessible name and
                          this row is the sighted twin of that sentence. */}
                      <header
                        class="slash-command-menu__header"
                        role="presentation"
                        style={{ display: "flex", gap: "10px", justifyContent: "space-between", alignItems: "baseline", padding: "4px 10px 6px" }}
                      >
                        <span>{SLASH_MENU_HEADER}</span>
                        <small>{slashCompletions.length} of {slashMenu.total}</small>
                      </header>
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
                    <div class="composer-queue" role="group" aria-label="Queued messages" aria-live="polite">
                      <header>
                        <strong>Up next</strong>
                        {/* A paused queue that looks identical to a running one
                            tells the same lie Stop used to tell. The way out is
                            already on screen — Send now and Edit — so the chip
                            only has to name the state it is in. */}
                        <span>{messageQueue.length} queued{queuePaused ? " · paused after Stop" : ""}</span>
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
                  {attachments.length ? <div class="composer-attachments" role="group" aria-label="Pending attachments">
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
                      placeholder={composerPlaceholder(narrowComposer)}
                      title={COMPOSER_PLACEHOLDER_TITLE}
                      onInput={(event) => {
                        // Size against the DOM value before React schedules its
                        // controlled-state reconciliation. The layout effect
                        // remains the second path for restored drafts and other
                        // programmatic value changes that emit no input event.
                        fitComposerTextarea(event.currentTarget);
                        setInput(event.currentTarget.value);
                      }}
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
                            : COMPOSER_TRANSITION_WAIT);
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
                        {/* The credential posture, as a chip rather than the
                            caption it shipped as. The caption was
                            `display: none` on a phone, so the fact stating what
                            this keystroke is about to trust was blank on the
                            device most likely to be someone else's. The chip
                            also carries the Send refusal, because a `title` has
                            no touch gesture. */}
                        <ComposerPostureChip
                          claim={composerPosture({
                            online,
                            offlineReason: OFFLINE_INLINE_REASON,
                            inferenceConnected,
                            authMethod: activeInferenceBinding?.authMethod,
                          })}
                          blockedReason={attachmentsAwaitText ? composerAttachmentNeedsText(composerRequestEncrypted) : undefined}
                        />
                        <MenuSelect
                          // Not "Conversation approval policy": choosing here
                          // revises the active profile, so the profile's later
                          // conversations start in the chosen mode as well.
                          ariaLabel="Conversation approval policy · applies to this conversation and future ones in this profile"
                          className={`composer-approval-select policy-${activeApprovalMode}`}
                          value={activeApprovalMode}
                          disabled={busy || modelSwitching || vaultProviderSwitching || localDeviceBusy}
                          options={[
                            { value: "ask-first", label: "Ask First", description: "Prompt before effectful actions." },
                            { value: "auto-approve", label: "Auto Approve", description: "Ask the active model to review each effect; prompt when uncertain." },
                            // "Inside the bounded browser workspace" was true of
                            // the write effects and false of the network ones,
                            // which reach any HTTPS origin that grants CORS.
                            { value: "full-access", label: "Full Access", description: "Allow every effect without prompting, including requests to any HTTPS origin." },
                          ]}
                          onChange={(value) => void changeActiveApprovalMode(value as ApprovalMode)}
                        />
                      </div>
                      {/* The Enter contract, stated before it is tripped over.
                          Enter-sends, Shift+Enter-newlines and Enter-while-busy
                          queues have all shipped for three waves with no
                          on-screen statement anywhere. */}
                      <ComposerKeyhintLegend busy={busy} />
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
                            || composerTransitionPending}
                          aria-label={composerOfflineBlocked
                            ? "Send unavailable while remote inference is offline"
                            // A disabled control has no hover and no touch
                            // gesture, so the reason rides in the name itself.
                            : composerTransitionPending
                              ? "Send unavailable while a model or storage transition settles"
                              : "Send message"}
                          aria-describedby={composerUsesDemo ? "chat-demo-guidance" : undefined}
                          title={composerOfflineBlocked
                            ? "Remote inference is paused offline. Local slash commands remain available."
                            : composerTransitionPending
                              ? COMPOSER_TRANSITION_WAIT
                              // The disabled state that reads as a bug unless it
                              // is named: attachments pending, nothing typed.
                              : attachmentsAwaitText
                                ? composerAttachmentNeedsText(composerRequestEncrypted)
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
              {lastReceipt && ProofInspector ? <aside class="inspector"><ProofInspector
              receipt={lastReceipt}
              endpointRecord={lastReceipt ? attestationRecords.find((record) => attestationRecordMatchesReceipt(record, lastReceipt)) : undefined}
              now={attestationNow}
              compact
              acquisitionFailure={inspectorAcquisitionFailure}
              onOpenAttestations={() => openAttestationEvidence()}
            /></aside>
              /* Rendering nothing here was the silent half of the same defect:
                 a receipt existed, the rail that inspects it did not load, and
                 the transcript simply had no claim column — indistinguishable
                 from a turn that produced no claims at all. */
              : lastReceipt && proofInspectorError ? <aside class="inspector">
                <RouteFailure inline title="the claim stack" message={proofInspectorError} onRetry={retryDeferredChunk} />
              </aside> : null}
          </>
        ) : null}
        {view === "sessions" ? sessionLibrary && SessionsScreen ? (
          <SessionsScreen
            key={profileId}
            library={sessionLibrary}
            runtime={sessionRuntime}
            activeSessionId={sessionId}
            scopeProfileId={profileId}
            scopeProfileName={activeProfile.name}
            forkManifest={activeSessionRecord?.manifest}
            revision={sessionRevision}
            onResume={resumeLibrarySession}
            onForked={activateForkedSession}
            onRenamed={adoptLibraryRename}
            onOpenProof={openSessionProof}
            durability={sessionDurability}
            quarantine={quarantinedSession}
          />
        ) : sessionsViewError ? (
          <RouteFailure title="All conversations" message={sessionsViewError} onRetry={retryDeferredChunk} />
        ) : (
          <section class="work-view panel" aria-labelledby="session-library-loading-title">
            <RouteBar
              routeId="sessions"
              title="All conversations"
              headingId="session-library-loading-title"
              eyebrow="Conversation history"
              description="Loading conversation history."
            />
            <RouteSkeleton label="Loading conversation history" />
          </section>
        ) : null}
        {(view === "workspace" || view === "editor") && runtime.current && gitClient ? EditorScreen ? <EditorScreen
          key={runtime.current.workspaceId}
          files={files}
          selected={selectedFile}
          onOpen={async (path) => { await openFile(path); }}
          workspace={runtime.current.workspace}
          workspaceIdentity={runtime.current.workspaceId}
          profileId={activeProfile.profileId}
          profileName={activeProfile.name}
          threadId={sessionId}
          git={gitClient}
          review={reviewGitOperation}
          reviewImport={reviewSourceImport}
          onWorkspaceChanged={async () => { await refreshWorkspacePresentation(); }}
          onOpenTerminalAt={(cwd) => {
            const activeWorkspace = runtime.current;
            if (!activeWorkspace) return;
            setTerminalOpenRequest(Object.freeze({
              id: randomUuid(),
              cwd,
              profileId: activeProfile.profileId,
              workspaceIdentity: activeWorkspace.workspaceId,
            }));
          }}
          terminalOpenRequest={terminalOpenRequest}
          onTerminalOpenRequestHandled={(id) => setTerminalOpenRequest((current) => current?.id === id ? undefined : current)}
          onOpenFullTerminal={() => navigate("terminal")}
          durability={sessionDurability}
          destinationArrival={destinationArrival}
        /> : editorViewError ? <RouteFailure title="Editor" message={editorViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading the browser-native Workspace Editor" /> : null}
        {view === "terminal" && runtime.current && gitClient ? TerminalScreen ? <TerminalScreen
          workspace={runtime.current.workspace}
          workspaceIdentity={runtime.current.workspaceId}
          git={gitClient}
          reviewGit={reviewGitOperation}
          onWorkspaceChanged={async () => { await refreshWorkspacePresentation(); }}
          threadId={sessionId}
          profileId={activeProfile.profileId}
          profileName={activeProfile.name}
          durability={sessionDurability}
          openRequest={terminalOpenRequest}
          onOpenRequestHandled={(id) => setTerminalOpenRequest((current) => current?.id === id ? undefined : current)}
          workspaceRoot="/workspace"
        /> : terminalViewError ? <RouteFailure title="Terminal" message={terminalViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading the browser terminal" /> : null}
        {view === "memory" || view === "context" ? MemoryScreen ? (
          <MemoryScreen
            key={`${profileId}:${sessionId ?? "no-session"}`}
            sessionId={sessionId}
            messages={messages}
            files={workspaceFiles}
            catalog={catalog}
            activeProfile={activeProfile}
            workspace={runtime.current?.workspace}
            searchMemory={searchMemoryForUi}
            initialTab={view === "context" ? "index" : "search"}
            onOpenSource={(target) => void openMemorySource(target)}
          />
        ) : memoryViewError ? <RouteFailure title="Memory" message={memoryViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading private memory" /> : null}
        {view === "profiles" || view === "capabilities" || view === "skills" ? <nav class={view === "skills" ? "profile-hub-tabs with-scope" : "profile-hub-tabs"} aria-label="Agent configuration">
          {([{"id":"profiles","label":"Profiles"},{"id":"skills","label":"Skills"},{"id":"capabilities","label":"Capabilities"}] as const).map((tab) => <button key={tab.id} type="button" aria-current={view === tab.id ? "page" : undefined} onClick={() => navigate(tab.id)}>{tab.label}</button>)}
          {view === "skills" ? <div class="profile-hub-scope"><span>Applies to</span><MenuSelect placement="down" ariaLabel="Skill scope" value={profileHubScope} options={[{ value: "global", label: "All profiles" }, ...managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name }))]} onChange={setProfileHubScope} /></div> : null}
        </nav> : null}
        {view === "profiles" ? (
          <ProfileManagerView
            key={profileHubScope}
            catalog={catalog}
            catalogDurability={runtime.current?.profiles.durability ?? "ephemeral"}
            activeProfileId={profileId}
            /* Only a switch that actually committed opens Chat. A refused one
               used to throw past this line, which is what kept the editor on
               screen; now that the refusal is reported instead of thrown, the
               boolean is what has to hold the editor open. */
            onActivate={async (id) => {
              // The outcome is returned, not inferred. `requestProfileChange`
              // cannot reject — it converts every refusal into the topbar runtime
              // line and `false` — so a `Promise<void>` left the editor with
              // nothing but an unchanged route to read a refusal from.
              const activated = await requestProfileChange(id, true);
              if (activated) navigate("chat");
              return activated;
            }}
            onSave={saveProfileRevision}
            onFork={forkProfile}
            onDelete={deleteProfile}
            draftState={profileDraftDirty}
            selectedProfileId={profileHubScope === "global" ? undefined : profileHubScope}
            preferences={preferences}
          />
        ) : null}
        {view === "capabilities" ? CapabilitiesScreen ? (
          <CapabilitiesScreen inspect={inspectExecutionCapabilities} inspectBrowser={inspectBrowserCapabilities} inspectExtension={observeExtensionBridge} subscribeBrowser={subscribeBrowserCapabilities} onCommand={openCapabilityCommand} onOpenSkills={() => navigate("skills")} />
        ) : capabilitiesViewError ? <RouteFailure title="Capabilities" message={capabilitiesViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Inspecting browser capabilities" /> : null}
        {view === "skills" ? (
          <SkillsManagerView
            catalog={catalog}
            catalogDurability={runtime.current?.profiles.durability ?? "ephemeral"}
            activeProfileId={profileId}
            onSetGlobal={setGlobalSkill}
            onSetProfile={setProfileSkill}
            onApply={async (id) => {
              const activated = await requestProfileChange(id, true);
              if (activated) navigate("chat");
              return activated;
            }}
            scope={profileHubScope}
          />
        ) : null}
        {view === "vault" ? (
          <div class="work-view">
            {VaultScreen ? <VaultScreen
              snapshot={vaultSnapshot}
              runtimeAdopted={vaultRuntimeAdopted}
              usage={vaultUsageFacts}
              adoptionNotice={vaultAdoptionNotice}
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
            /> : vaultViewError ? <RouteFailure title="Vault" message={vaultViewError} onRetry={retryDeferredChunk} class="panel" /> : <RouteSkeleton label="Loading the Vault interface" />}
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
            providerInventory={billingProviderInventory}
            loadSnapshot={loadBillingSnapshot}
            onOpenAccess={() => navigate("access")}
          />
        ) : billingViewError ? <RouteFailure title="Account" message={billingViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading Account" /> : null}
        {view === "proof" ? ProofScreen ? (
          <ProofScreen
            key={`${profileId}:${proofTargetId ?? "no-session"}`}
            receipt={proofReceipt}
            eventCount={proofScoped ? eventCount : sessionRevision}
            sessionId={proofTargetId}
            requestedReceiptId={effectiveProofSelection?.receiptId}
            loadAudit={loadSessionAudit}
            section={proofSection}
            onSectionChange={(section) => {
              setProofSection(section);
              navigate("proof", proofHash(effectiveProofSelection, section));
            }}
            summarizeReceipt={receiptSummary}
            acquisitionFailure={proofAcquisitionFailure}
            renderInspector={(onOpenAttestations) => ProofInspector ? <ProofInspector
              receipt={proofReceipt}
              endpointRecord={proofReceipt ? proofEndpointRecords.find((record) => attestationRecordMatchesReceipt(record, proofReceipt)) : undefined}
              now={attestationNow}
              acquisitionFailure={proofAcquisitionFailure}
              onOpenAttestations={onOpenAttestations}
            /> : proofInspectorError ? <RouteFailure inline title="the claim stack" message={proofInspectorError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading the claim stack" />}
            evidenceLedger={AttestationsScreen ? <AttestationsScreen
              endpointRecords={proofEndpointRecords}
              receipts={proofLedgerReceipts}
              selectedRecordId={ledgerSelectedRecordId}
              onSelectRecord={selectEndpointEvidenceRecord}
              acquisitionNotice={!proofScoped
                ? PROOF_UNSCOPED_EVIDENCE_NOTICE
                : !online
                  ? OFFLINE_INLINE_REASON
                  : automaticEvidenceAcquisitionNotice
                    ?? endpointEvidenceDurabilityNotice
                    ?? (attestationFailure ? `${attestationFailure.label}. Current endpoint evidence was not accepted, and no TEE claim was inferred.` : undefined)}
              onOpenConnection={!chutesConnected ? () => navigate("access") : undefined}
              // Refresh acquires evidence for the ACTIVE conversation. Offered
              // from an unscoped route it would file conversation A's fetch
              // under conversation B's page.
              onRefresh={proofScoped && online && chutesConnected ? refreshAttestation : undefined}
              onCancel={() => attestationClient.current?.cancel()}
              embedded
            /> : attestationsViewError ? <RouteFailure inline title="attestation evidence" message={attestationsViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading attestation evidence" />}
            endpointEvidenceRecords={proofEndpointRecords}
          />
        ) : proofViewError ? <RouteFailure title="Proof" message={proofViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading Proof" /> : null}
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
            /* A returning redirect outranks it: that status is about this
               attempt, this one about the next. Second, because a missing
               registration is only ever the reason the sign-in lane is inert. */
            } : oauthRegistrationError ? { tone: "error", message: oauthRegistrationError } : undefined}
            oauthDiagnostic={activeOAuthRegistration ? {
              homepageUrl: activeOAuthRegistration.registration.homepageUrl,
              callbackUrl: activeOAuthRegistration.registration.redirectUris[0] ?? "Unavailable",
              scopes: activeOAuthRegistration.registration.scopes,
              exchangeMode: activeOAuthRegistration.exchangeMode,
              configurationError: activeOAuthRegistration.registration.configurationError,
              onRun: startOAuthSignIn,
            } : undefined}
            oauthBootstrap={{
              revision: oauthBootstrapRevision,
              readCredential: readPendingOAuthCredential,
              getBearerToken: currentOAuthBearer,
            }}
            observeExtensionBridge={observeExtensionBridge}
            connectedProviderIds={connectedInferenceProviderIds}
            onCheckLocalProviders={checkLocalModelServers}
            additionalProviders={ProviderConnectionsScreen ? (
              <ProviderConnectionsScreen
                online={online}
                activeBinding={activeInferenceBinding}
                onActivate={activateExternalInference}
                onDisconnect={disconnectExternalInference}
              />
            ) : providerFabricError ? <RouteFailure inline title="the provider fabric" message={providerFabricError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading cloud and local provider fabric" />}
          />
        ) : accessViewError ? <RouteFailure title="Connection" message={accessViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading Connection" /> : null}
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
      <CommandPalette open={paletteOpen} entries={paletteEntriesWithRail} onClose={() => setPaletteOpen(false)} />
      <PreferencesDialog open={preferencesOpen} value={preferences} onChange={(next) => {
        if (next.vaultBackend !== preferences.vaultBackend) {
          setPreferences((current) => Object.freeze({ ...next, vaultBackend: current.vaultBackend }));
          void changeVaultProvider(next.vaultBackend);
        }
        else setPreferences(next);
      }} onClose={() => setPreferencesOpen(false)} vaultProviderSwitching={vaultProviderSwitching} vaultAdopted={vaultRuntimeAdopted} profileApproval={{
        mode: activeApprovalMode,
        onManage: () => {
          if (openProfileManager(profileId)) setPreferencesOpen(false);
        },
      }} />
      <TrustPostureSheet open={trustSheetOpen} axes={trustAxes} onClose={() => setTrustSheetOpen(false)} onNavigate={navigatePrimary} />
      {/*
        The reload the person just pressed is not the departure the guard
        exists for. Released synchronously, because `reload()` navigates in this
        same tick and no re-render could unregister the listener in time.
      */}
      <PwaUpdateBanner updateReady={pwaUpdate.updateReady} onReload={() => { releaseUnloadGuard(); pwaUpdate.reload(); }} />
      {profileCockpitTransition ? (
        <div class="platform-scrim profile-cockpit-transition" data-target-profile={profileCockpitTransition.profileId}>
          <section role="status" aria-live="assertive" aria-atomic="true">
            <span class="pulse-dot" aria-hidden="true" />
            <div>
              <strong>Opening {profileCockpitTransition.name}</strong>
              <small>Binding this Profile&rsquo;s conversation, workspace views, terminal sessions, memory, and Proof selection.</small>
            </div>
          </section>
        </div>
      ) : null}
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
  const [{ browserCapabilityPromptEntries, getBrowserCapabilityRegistry }, capabilityTier, { createSessionManifest }] = await Promise.all([
    import("../capabilities/browser-runtime"),
    inspectBrowserExecutionTier(),
    import("../core/session-manifest"),
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
    // The raw union members used to be interpolated straight into this
    // sentence, so a person who picked "Encrypted" was refused with
    // "encrypted-unattested" and given no remedy. `postureFloorRefusal` reads
    // the label dictionaries the editor's own select is spelled from.
    throw new Error(postureFloorRefusal(runtime.transport.posture, pin.minimumPosture));
  }
  // A pinned binding names a storage authority the person typed, so it is
  // compared against the storage ID rather than the Profile-suffixed view.
  if (pin.workspaceBinding.kind === "workspace-id" && pin.workspaceBinding.workspaceId !== runtime.storageId) {
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
  return compatibleProfileSession(runtime, profile, catalog);
}

async function compatibleProfileSession(
  runtime: Runtime,
  profile: ProfileRevision,
  catalog: ProfileCatalog,
  preferredSessionId?: string,
): Promise<SessionRecord | undefined> {
  const expected = await createProfileSessionManifest(runtime, profile, catalog);
  return resolveResumableProfileConversation(
    runtime.journal,
    profile.profileId,
    expected,
    preferredSessionId,
  );
}

async function contextPolicyForModel(model: AirshipModel): Promise<SessionManifest["contextPolicy"] | undefined> {
  const contextWindowTokens = model.contextTokens ?? model.maxModelTokens;
  if (contextWindowTokens === undefined) return undefined;
  const { createSessionContextPolicy } = await import("../core/context-policy");
  if (model.contextTokens !== undefined) {
    return createSessionContextPolicy({
      contextWindowTokens,
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
      contextWindowTokens,
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

async function contextPolicyForProviderModel(
  model: InferenceModelDescriptor,
): Promise<SessionManifest["contextPolicy"] | undefined> {
  if (!model.contextWindowTokens) return undefined;
  const { createSessionContextPolicy } = await import("../core/context-policy");
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

/**
 * The one sentence a ready encrypted session states about its proof gate.
 *
 * Connecting said "…required on every turn" / "…recorded after completed
 * turns"; switching model said "…required on next turn" / "…recorded after the
 * next completed turn". Four spellings of two facts, and the pairs are not
 * different claims: a gate that fires on every turn fires on the next one.
 * Stated once, in the form that covers both moments.
 */
function encryptedSessionReadyStatus(posture: SecurityPosture): string {
  return posture === "encrypted-attested"
    ? "Encrypted session ready · endpoint proof required on every turn"
    : "Encrypted session ready · endpoint evidence recorded after completed turns";
}

/*
 * The boundary label is `activeConnectionProofLabel`, and only that.
 *
 * This file carried a second copy which still said "E2EE · evidence recorded"
 * for an unattested connection — a phrase that reads as a verdict about the
 * turn ("evidence was recorded") when the fact it states is about the *policy*:
 * this connection has no proof gate. The shared function says "E2EE · no proof
 * gate", so the topbar axis, the session status chip and the model card now
 * quote one string. `model-control` is already a static import of this module,
 * so the shared reader costs no startup bytes and the duplicate is deleted
 * rather than re-synchronised.
 */

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

function liveProviderEntries(snapshot: InferenceAvailabilitySnapshot): readonly LiveEnvironmentEntry[] {
  if (snapshot.connections.length === 0) {
    return Object.freeze([Object.freeze({
      id: "provider-directory",
      label: "Inference provider directory",
      state: "available" as const,
      evidence: "runtime-reported" as const,
      detail: "The live provider directory was read for this turn and currently contains no connected inference authority.",
      facets: Object.freeze(["connections=0"]),
    })]);
  }
  return Object.freeze(snapshot.connections.map((connection) => Object.freeze({
    id: `provider:${connection.id}`,
    label: `${connection.providerLabel} · ${connection.connectionLabel}`,
    state: connection.health === "ready" && connection.canInvoke
      ? "ready" as const
      : connection.health === "degraded"
        ? "degraded" as const
        : connection.health === "offline" || connection.health === "expired"
          ? "unavailable" as const
          : "available" as const,
    evidence: "runtime-reported" as const,
    detail: `${connection.canInvoke ? "Invocation is available" : "Invocation is not currently available"}; ${String(connection.models.length)} bounded model record${connection.models.length === 1 ? "" : "s"} are visible. No credential is included.`,
    facets: Object.freeze([
      `provider=${connection.providerId}`,
      `health=${connection.health}`,
      `models=${String(connection.models.length)}`,
      ...(snapshot.activeSession?.connectionId === connection.id
        ? [`active-model=${snapshot.activeSession.modelId}`, `resolution=${snapshot.activeSession.resolution}`]
        : []),
    ]),
  })));
}

function liveStorageEntries(
  workspaceId: string | undefined,
  authority: DurableAdoptionDescriptor | undefined,
  contextMode: Runtime["contextMode"],
): readonly LiveEnvironmentEntry[] {
  if (!workspaceId) {
    return Object.freeze([Object.freeze({
      id: "storage-authority",
      label: "Durability authority",
      state: "not-observed" as const,
      evidence: "not-observed" as const,
      detail: "The application runtime has not published an active workspace storage authority yet.",
      facets: Object.freeze([]),
    })]);
  }
  if (!workspaceId.startsWith("vault+")) {
    return Object.freeze([Object.freeze({
      id: "storage:page",
      label: "Page-ephemeral workspace",
      state: "ready" as const,
      evidence: "runtime-reported" as const,
      detail: "Workspace, journal, profiles, and context state are active in this page only; browser restart durability is not claimed.",
      facets: Object.freeze(["durability=page-ephemeral", `workspace=${workspaceId}`]),
    })]);
  }
  if (!authority || authority.workspaceId !== workspaceId) {
    return Object.freeze([Object.freeze({
      id: "storage:vault-transition",
      label: "Encrypted Vault transition",
      state: "activating" as const,
      evidence: "runtime-reported" as const,
      detail: "A Vault-backed workspace ID is active, but its adoption descriptor is changing; no stronger durability claim is inferred for this turn.",
      facets: Object.freeze([`workspace=${workspaceId}`]),
    })]);
  }
  return Object.freeze([Object.freeze({
    id: authority.kind === "local-device" ? "storage:local-device" : "storage:encrypted-cloud",
    label: authority.label,
    state: "ready" as const,
    evidence: "runtime-reported" as const,
    detail: authority.kind === "local-device"
      ? "The active workspace, journal, profiles, Git objects, and context state use the encrypted Local Device Vault in this browser profile. No cloud sync is implied."
      : "The active workspace, journal, profiles, Git objects, and context state use the selected client-encrypted remote Vault authority.",
    facets: Object.freeze([
      `durability=${authority.kind === "local-device" ? "local-device" : "encrypted-remote"}`,
      `context=${contextMode ?? "local-fallback"}`,
    ]),
  })]);
}

function liveExtensionEntries(observation: ExtensionBridgeObservation): readonly LiveEnvironmentEntry[] {
  const entries: LiveEnvironmentEntry[] = [Object.freeze({
    id: "extension-bridge",
    label: observation.extensionVersion
      ? `Airship extension ${observation.extensionVersion}`
      : "Airship browser extension",
    state: observation.state === "available"
      ? "ready"
      : observation.state === "failed"
        ? "failed"
        : "unavailable",
    evidence: observation.evidence,
    detail: observation.detail,
    facets: Object.freeze([
      ...observation.providers.map((provider) => `provider=${provider}`),
      ...(observation.handshakeMs === undefined ? [] : [`handshake-ms=${String(Math.round(observation.handshakeMs))}`]),
    ]),
  })];
  const companion = observation.companion;
  if (companion) {
    entries.push(Object.freeze({
      id: "extension-storage",
      label: "Extension encrypted cache",
      state: companion.storage.state === "available"
        ? companion.storage.enabled ? "ready" : "available"
        : "unavailable",
      evidence: "runtime-reported",
      detail: companion.storage.state === "available"
        ? `The extension reports its ciphertext-only cache ${companion.storage.enabled ? "enabled" : "available but disabled"}; it is not a plaintext workspace authority.`
        : companion.storage.reason ?? "The extension reports no usable ciphertext cache.",
      facets: Object.freeze([
        `backend=${companion.storage.backend}`,
        `boundary=${companion.storage.boundary}`,
        `max-bytes=${String(companion.storage.maxCacheBytes)}`,
      ]),
    }));
    entries.push(Object.freeze({
      id: "extension-compute",
      label: "Extension background compute",
      state: companion.compute.state === "available" ? "available" : "unavailable",
      evidence: "runtime-reported",
      detail: companion.compute.state === "available"
        ? "The extension reports bounded background compute for the listed operations; it is not an unrestricted host shell."
        : companion.compute.reason ?? "The extension reports no usable background compute.",
      facets: Object.freeze(companion.compute.operations.map((operation) => `operation=${operation}`)),
    }));
  }
  return Object.freeze(entries);
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
  return sessionManifestRuntime(runtime, session.manifest);
}

function sessionManifestRuntime(runtime: Runtime, manifest: SessionManifest): ActiveSessionRuntime {
  const profile = manifest.profile;
  return Object.freeze({
    providerId: runtime.transport.id,
    model: runtime.model,
    ...(runtime.inferenceBinding ? { inferenceBinding: runtime.inferenceBinding } : {}),
    posture: runtime.transport.posture,
    toolManifestDigest: manifest.toolManifestDigest,
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
  //
  // The workspace boundary is not resolved here. It is a whole authority —
  // namespace, Git object database and tool registry — so it is built by
  // `openProfileWorkspaceAuthority` and published with the runtime, not folded
  // into a catalog revision.
  void runtime;
  return profile;
}

/**
 * Open one Profile's private workspace authority.
 *
 * A Profile owns a disjoint subtree of the global storage authority, so its
 * files, Git object database, worktree inventory and derived index are its
 * own. Two Profiles no longer share bytes behind separate presentation state:
 * `ProfileWorkspacePort` presents that subtree as an ordinary `/workspace`, and
 * every consumer below this point is scoped by construction because it never
 * receives the backing port.
 *
 * A profile that pins an exact `workspace-id` must resolve to the storage
 * authority carrying that ID. Silently handing it the active one is how a
 * pinned boundary becomes a false claim.
 */
async function openProfileWorkspaceAuthority(input: Readonly<{
  storage: WorkspacePort;
  storageId: string;
  profile: ProfileRevision;
}>): Promise<Readonly<{
  workspace: WorkspacePort;
  workspaceId: string;
  git: BrowserGitClient;
  adoptedLegacyPaths: number;
}>> {
  const binding = input.profile.workspaceBinding;
  if (binding?.kind === "workspace-id" && binding.workspaceId !== input.storageId) {
    throw new Error(`${input.profile.name} is pinned to workspace ${binding.workspaceId}, which is not the active storage authority.`);
  }
  const adoptedLegacyPaths = (await adoptLegacyRootWorkspace(input.storage, input.profile.profileId)).length;
  const workspace = new ProfileWorkspacePort(input.storage, input.profile.profileId);
  const { WorkspaceGitAdapter, BrowserGitClient, AIRSHIP_BOOTSTRAP_FILES } = await loadBrowserGit();
  const git = new BrowserGitClient(await WorkspaceGitAdapter.open(
    workspace,
    async () => {
      const existing = await existingWorkspaceFallbackSeed(workspace);
      if (existing.length) return existing;
      /*
       * A Profile opening its namespace for the first time gets its own
       * workspace repository, seeded exactly as the first Profile's was.
       *
       * Without this, isolation would read as breakage: every Profile after
       * the first would find an empty namespace, no repository, and therefore
       * no Explorer tree, worktree selector, diff or history — Source Control
       * would simply be dead for it. The content is identical at the start and
       * the bytes are its own from the first edit.
       */
      const files = {
        "README.md": AIRSHIP_BOOTSTRAP_FILES.readme,
        "docs/architecture.md": AIRSHIP_BOOTSTRAP_FILES.architecture,
        "notes/retrieval.md": AIRSHIP_BOOTSTRAP_FILES.retrieval,
      };
      return Object.freeze([{
        id: "airship-workspace",
        name: "Airship Workspace",
        worktreePath: "/workspace",
        files,
        workingFiles: files,
      }]);
    },
  ));
  return Object.freeze({
    workspace,
    workspaceId: profileWorkspaceIdentity(input.storageId, input.profile.profileId),
    git,
    adoptedLegacyPaths,
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

/**
 * Writes a theme onto `<html>`, diffed against the colour mode actually in force.
 *
 * The inline properties this sets outrank every stylesheet, so the baseline the
 * diff is taken against has to be the sheet the *mode preference* selected, not
 * the one the manifest names. Passing `mode` is what stops a dark-scheme theme
 * from pinning a dark palette on top of the light sheet; see `themeCssVariables`.
 */
function applyTheme(theme: ThemeManifest, mode: ThemeColorScheme = theme.colorScheme) {
  const root = document.documentElement;
  root.style.removeProperty("--signal");
  root.style.removeProperty("--danger");
  for (const [property, value] of Object.entries(themeCssVariables(theme, mode))) root.style.setProperty(property, value);
  root.dataset.theme = theme.themeId;
  // Through `themePresentation` so the manifest's 'standard' and the preference
  // layer's 'default' cannot both reach one attribute as different words.
  const presentation = themePresentation(theme);
  root.dataset.density = presentation.density;
  root.dataset.corners = presentation.corners;
  root.dataset.typeScale = presentation.typeScale;
  root.dataset.bodyFont = presentation.bodyFont;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme.colors.ground);
}

/**
 * The only sanctioned way to put a theme on the document.
 *
 * `applyTheme` is a whole-instrument commit: it writes the five layout and
 * typography attributes the *preference* layer also owns. Every caller outside
 * the one effect that owns both therefore silently overwrote the user's global
 * display preferences — previewing a theme in the Profiles editor reset type
 * scale, density, corners, body font and light/dark mode, and nothing put them
 * back. Preferences are the final override layer, so they are reasserted in the
 * same breath rather than left to a later effect that a preview never triggers.
 *
 * "Final override layer" is the whole point, and it used to be implemented as
 * "final rewrite": the theme's presentation became the base the preference layer
 * diffs against only when it was handed over explicitly, so that is what
 * happens here.
 */
function applyThemeWithPreferences(theme: ThemeManifest, preferences: PreferenceOverrides) {
  applyTheme(theme, preferences.mode);
  applyPreferenceOverrides(preferences, document.documentElement, themePresentation(theme));
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

/**
 * True when this runtime holds nothing a person made.
 *
 * Adoption uses this to decide whether the local runtime is worth carrying into
 * a Vault. Getting it wrong in the false direction is expensive: a disposable
 * sample workspace then gets copied over an authoritative Vault, which is how a
 * fresh page-load came to overwrite real device state.
 *
 * It therefore looks for *evidence of user work* rather than for an exact
 * bootstrap fingerprint. The previous form required exactly one session at
 * sequence 1 carrying exactly one `session.created` event, so the moment the
 * Profile cockpit began journaling its own `profile.active-conversation.selected`
 * pointer at startup, every fresh boot silently began claiming to hold user
 * work. That polarity fails dangerously: any bookkeeping event added later
 * flips the answer. Asking what a person actually did fails safe, because new
 * bookkeeping is simply not evidence of a person.
 */
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
  if (entries.length !== expected.size) return false;
  for (const entry of entries) {
    const content = expected.get(entry.path);
    if (content === undefined) return false;
    const file = await runtime.workspace.read(entry.path);
    if (!file || file.content !== content) return false;
  }
  for (const session of sessions) {
    if ((await runtime.journal.readEvents(session.id)).some(recordsUserWork)) return false;
  }
  return true;
}

/**
 * Evidence that a person did something, rather than bookkeeping the startup
 * path writes on its own behalf.
 *
 * A turn is a person asking for work. A rename is a person naming it. Session
 * creation and the Profile's active-conversation pointer are both written
 * before anyone has touched the page.
 */
function recordsUserWork(event: DurableEvent): boolean {
  return event.type.startsWith("turn.") || event.type === "session.renamed";
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

/**
 * A command-palette slash command meets an unsent draft.
 *
 * Replace is correct only on the palette's home turf — an empty composer, or
 * one already holding a slash line. With any other text in the box the
 * command inserts at the caret, spaced like a word, so the keystroke that
 * summoned the palette cannot destroy the message that was being written.
 * Exported because the rule is checkable without a browser, and this file's
 * draft tests quote it.
 */
export function insertDraftCommandAtCaret(input: string, command: string, caret: number): string {
  if (!input || input.startsWith("/")) return command;
  const position = Math.max(0, Math.min(caret, input.length));
  const before = input.slice(0, position);
  const after = input.slice(position);
  const lead = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/u.test(after) ? " " : "";
  return `${before}${lead}${command}${trail}${after}`;
}

function slugIdentifier(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 72);
  return slug || "profile";
}

function compactModelLabel(modelId: string): string {
  const leaf = modelId.split("/").filter(Boolean).at(-1) ?? modelId;
  return leaf.length > 25 ? `${leaf.slice(0, 22)}…` : leaf;
}

/**
 * Capability words for a route the shared picker cannot serve.
 *
 * `compactModelCapabilityDetail` stood here — a second capability formatter,
 * for the Chutes route, printing "Vision · Tools · 4.2k req/h" where Connection
 * printed "Vision"/"Tools" and put demand in its own column. The Chutes route
 * opens the shared picker now, so the only surface left without an
 * `AirshipModel` is an external provider, and it reads the same nouns from
 * `MODEL_CAPABILITY_WORDS` instead of coining its own.
 */
function externalModelCapabilityDetail(model: InferenceModelDescriptor): string | undefined {
  const labels: string[] = [];
  if (providerModelCapability(model, "image-input") === "supported") labels.push(MODEL_CAPABILITY_WORDS.vision);
  if (providerModelCapability(model, "tool-calling") === "supported") labels.push(MODEL_CAPABILITY_WORDS.tools);
  return labels.length ? labels.join(" · ") : undefined;
}

function conversationTitleFromPrompt(prompt: string): string {
  const normalized = prompt.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const maximum = 64;
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

const CONVERSATION_NAMING_PROMPT =
  "You name conversations. Reply with a title of at most six words for the message that follows. "
  + "Describe what it is about. No quotation marks, no trailing punctuation, no preamble.";
/**
 * How much of a naming answer is kept, well under `session-audit`'s 4 KiB bound.
 *
 * A title is at most 64 characters; anything past this is already an essay the
 * record exists only to account for. Keeping the whole of an unbounded stream
 * would let one bad answer make the naming record permanently unauditable.
 */
const MAX_CONVERSATION_NAMING_ANSWER = 1_024;

/** What the naming inference produced, including what it cost and what proves it. */
type ConversationNaming = Readonly<{
  /**
   * Absent when the request completed but its answer is not a usable name.
   *
   * That outcome is a *result*, not a failure: the request was made, billed and
   * attested, and only the rename is skipped. Collapsing it into `undefined`
   * alongside a network failure is what left a completed paid call recorded
   * nowhere — the same defect one layer down from the one this whole path fixes.
   */
  title?: string;
  /** The provider's exact answer, so the receipt's response digest is checkable. */
  answer: string;
  usage?: Readonly<{ inputTokens?: number; outputTokens?: number }>;
  receipt?: ConversationReceipt;
}>;

/**
 * Ask the active model to name a new conversation.
 *
 * A truncated first prompt is not a name — "Map the browser workspace bound…"
 * is just the message restated. A title should say what the conversation is
 * about, which is an inference, so it is asked of the model already answering.
 *
 * Deliberately best-effort. The conversation is titled from the local heuristic
 * first, so it is never nameless and the turn never waits on this; this only
 * ever improves that title, and any failure, abort, or unusable answer leaves
 * the heuristic in place. Returning `undefined` is an ordinary outcome.
 *
 * `undefined` means "no request is known to have happened" — it threw, it was
 * aborted, or the stream produced nothing at all. It does not mean "no title":
 * a request that came back with a refusal or an essay returns a record with no
 * `title`, because it was billed either way and the caller has to say so.
 *
 * It is issued against the conversation's own identity. It used to invent a
 * `naming-<uuid>` session id, which meant the one thing a receipt exists to do
 * — bind a request to the conversation that made it — was impossible, and the
 * usage and receipt the transport handed back were dropped on the floor. The
 * caller journals them; this returns them.
 */
export async function conversationTitleFromModel(
  // Only the two fields it actually uses, so this can be exercised against a
  // transport alone rather than against a whole storage/journal/profile runtime.
  runtime: Pick<Runtime, "transport" | "model">,
  prompt: string,
  identity: Readonly<{ sessionId: string; turnId: string; operationId: string }>,
  signal: AbortSignal,
): Promise<ConversationNaming | undefined> {
  try {
    const messages = [{ role: "user" as const, content: conversationTitleFromPrompt(prompt) }];
    const events = runtime.transport.stream({
      requestId: identity.operationId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      model: runtime.model,
      systemPrompt: CONVERSATION_NAMING_PROMPT,
      messages,
      tools: [],
      idempotencyKey: identity.operationId,
    }, signal);
    let text = "";
    let usage: ConversationNaming["usage"];
    let receipt: ConversationReceipt | undefined;
    for await (const event of events) {
      // Clamped as it accumulates, not after: a single delta can be arbitrarily
      // large, the audit bounds a naming record's answer at 4 KiB, and the
      // response digest below is taken over exactly this string — so what the
      // journal stores stays recomputable from the journal rather than from a
      // longer answer nobody kept. The stream is abandoned here anyway.
      if (event.type === "text-delta") text = `${text}${event.text}`.slice(0, MAX_CONVERSATION_NAMING_ANSWER);
      if (event.type === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      if (event.type === "completed") receipt = event.receipt;
      // A naming call that starts producing an essay is not naming anything.
      if (text.length > 240 || event.type === "completed") break;
    }
    // Nothing observable came back, so there is no request to attest to. Any
    // one of these three is evidence the provider was reached and charged.
    if (!text && !usage && !receipt) return undefined;
    const title = usableConversationTitle(text);
    return Object.freeze({
      ...(title ? { title } : {}),
      answer: text,
      ...(usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? { usage } : {}),
      // Normalized exactly as a turn receipt is, and bound to the request that
      // was actually made: the prompt is this constant plus the journaled first
      // message, and the answer is stored beside it, so the two digests can be
      // recomputed from the record rather than taken on trust.
      ...(receipt
        ? {
            receipt: finalizeProviderReceipt(
              receipt,
              runtime.transport.id,
              await sha256(stableStringify({
                model: runtime.model,
                systemPrompt: CONVERSATION_NAMING_PROMPT,
                messages,
                tools: [],
                idempotencyKey: identity.operationId,
              } as unknown as JsonValue)),
              await sha256(text),
            ),
          }
        : {}),
    });
  } catch {
    return undefined;
  }
}

/** Reduce a model answer to a title, or reject it. */
export function usableConversationTitle(answer: string): string | undefined {
  const normalized = answer
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    // Models like to wrap a title in quotes and end it with a full stop.
    .replace(/^\s*["\u2018\u2019\u201c\u201d'`]+|["\u2018\u2019\u201c\u201d'`]+\s*$/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.,;:]+$/u, "")
    .trim();
  if (!normalized || normalized.length > 64) return undefined;
  // A refusal or a preamble is longer than any title worth keeping.
  if (normalized.split(" ").length > 8) return undefined;
  return normalized;
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

/**
 * A digest short enough to read in a monospace transcript line and long enough
 * to compare against the one the Skills route and the session manifest print.
 */
function slashDigest(value: string): string {
  return value.length <= 22 ? value : `${value.slice(0, 14)}…${value.slice(-7)}`;
}

/**
 * What `/skills` prints: the set pinned into the open conversation.
 *
 * The pin, never the catalog's current state. A skill enabled or edited after
 * this conversation was opened belongs to the next one — the pin is what
 * composed the immutable system prompt this transcript was answered against,
 * and printing today's catalog would describe a conversation that does not
 * exist. The catalog is consulted for display names only.
 *
 * The source column comes from the Profile's `skillModes`, which is a property
 * of a *revision*. If the active revision has moved past the pinned one those
 * modes are no longer this conversation's answer, so the row names the pinned
 * revision instead of guessing global-versus-override from a later one.
 */
export function pinnedSkillListing(input: Readonly<{
  pin: Readonly<{
    profileRevision: string;
    skillSetDigest: string;
    resolvedSkills: readonly Readonly<{ skillId: string; digest: string; promptOrder: number }>[];
  }>;
  profile: Readonly<{ name: string; revision: string; skillModes: Readonly<Record<string, SkillMode>> }>;
  catalogSkills: readonly Readonly<{ skillId: string; name: string }>[];
}>): string {
  const { pin, profile } = input;
  const modesArePinned = profile.revision === pin.profileRevision;
  const rows = [...pin.resolvedSkills]
    .sort((left, right) => left.promptOrder - right.promptOrder || left.skillId.localeCompare(right.skillId))
    .map((resolved) => {
      const named = input.catalogSkills.find((candidate) => candidate.skillId === resolved.skillId);
      const mode = modesArePinned ? profile.skillModes[resolved.skillId] ?? "inherit" : undefined;
      const origin = mode === undefined
        ? `pinned at ${profile.name} revision ${slashDigest(pin.profileRevision)}`
        : mode === "inherit" ? "global" : `${profile.name} override`;
      return `• ${named?.name ?? resolved.skillId} · ${origin} · ${slashDigest(resolved.digest)}`;
    });
  return [
    rows.length
      ? `${rows.length} skill${rows.length === 1 ? "" : "s"} compose this conversation's prompt · set ${slashDigest(pin.skillSetDigest)}`
      : `No skill composes this conversation's prompt · set ${slashDigest(pin.skillSetDigest)}`,
    ...rows,
    "Manage them in Skills. A change applies to the next conversation, never this one.",
  ].join("\n");
}

function receiptSealState(receipt?: ConversationReceipt): SealState {
  if (!receipt) return "none";
  if (Object.values(receipt.claims).some((claim) => claim.status === "failed" || claim.status === "expired")) return "failed";
  if (receipt.posture === "local") return "none";
  if (receipt.posture === "plaintext-remote") return "attention";
  if (receipt.posture === "encrypted-unattested") return "asserted";
  return receipt.claims.endpointKey.status === "verified" ? "verified" : "attention";
}

/**
 * One description of endpoint evidence, in one vocabulary, at two scopes.
 *
 * `describeAttestationSeal` and `describeMessageAttestation` were separate
 * functions with the same five branches and different words for each of them:
 * one turn could carry "Separate evidence collected" in the session bar and
 * "Separate evidence only" under the answer, or the acquisition reason
 * ("Evidence unavailable") in one place and the canonical verdict word
 * ("Evidence not pulled") in the other. They are one function now, so the two
 * bands cannot drift; `scope` selects only the branches that genuinely differ,
 * which is the one where a live session has a *next* turn and a settled receipt
 * does not.
 *
 * Nothing merged here lost a clause. Where the two versions phrased the same
 * fact differently, the surviving detail is the union of both sentences.
 */
function describeEndpointEvidence(args: {
  scope: "session" | "turn";
  /** Session scope only. A settled receipt has no "is a provider connected now". */
  connected?: boolean;
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
      detail: "This receipt contains an independently verified endpoint-key claim. Model and conversation claims remain independently scoped.",
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
      detail: "The separate endpoint evidence record is beyond its browser display-freshness window. Refresh before relying on its local key or policy comparison.",
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
      state: TURN_EVIDENCE_COPY["evidence-blocked"].seal,
      // The canonical word, not the acquisition reason. The reason used to be
      // the label here and the label was "Evidence unavailable" while the chip
      // under the same turn's answer read "Evidence not pulled" — one failure,
      // two headlines. The reason is not lost: it leads the sentence below,
      // verbatim from `attestationFailureLabel()`.
      label: TURN_EVIDENCE_COPY["evidence-blocked"].chip,
      detail: `${args.failure.label}. ${TURN_EVIDENCE_COPY["evidence-blocked"].line} Endpoint evidence was not accepted. This provider/acquisition state is not a TEE verdict.`,
    };
  }
  // The only genuinely scope-dependent branch: a live session has a next turn
  // its policy can speak about, and a settled receipt does not.
  if (args.scope === "turn") {
    // "Secure hardware evidence pending" is a retired name: it promised an
    // arrival nothing is waiting for. The fact it carried — that no endpoint
    // TEE evidence was accepted — leads the sentence below, unchanged.
    //
    // The rung now follows the receipt, which is the rule the whole ladder is
    // built on. `describeMessageAttestation` returns undefined without one, so
    // in this build the first arm is the live one, and it lands on exactly the
    // rung `turnEvidenceVerdict` reaches for a settled receipt with no verified
    // claim. The two reducers agree instead of describing one turn twice.
    return args.receipt
      ? {
        state: "asserted",
        label: TRUST_LABEL_MESSAGE_ASSERTED_NO_ENDPOINT,
        detail: "Airship has not accepted endpoint TEE evidence for this receipt. The receipt records what the provider stated about this turn; nothing independent checked it.",
      }
      : {
        state: "none",
        label: TRUST_LABEL_MESSAGE_NO_EVIDENCE,
        detail: "Airship has not accepted endpoint TEE evidence for this turn, and no receipt records a claim about it.",
      };
  }
  /*
   * A proof *policy* is not a verdict, so neither arm below may stand on the
   * `asserted` rung.
   *
   * Both arms are reached with `args.receipt`, `args.records` and
   * `args.failure` all empty: the only inputs are whether a provider is
   * connected and what the user asked Airship to do on the *next* turn. A
   * setting about future turns is nobody's statement about this session, and
   * `trust-label-contract.ts` names the consequence — "an assertion nobody made
   * is not a weak assertion, it is an absence". `none` is the rung an absence
   * stands on, it is what the disconnected arm eight lines below already
   * returns, and it can only under-claim.
   *
   * The labels and the forward-tense sentences are unchanged; the record arm's
   * sentence gains the emptiness clause the strict arm always carried, so the
   * grey glyph and the forward-tense words cannot read as contradicting.
   */
  return args.connected
    ? args.proofPolicy === "strict"
      ? {
        state: "none",
        label: "Proof required next turn",
        detail: "The fail-closed endpoint-proof policy is armed, but no active turn receipt currently establishes a hardware claim.",
      }
      : {
        state: "none",
        label: "Evidence checked per turn",
        detail: "Verify & record will collect fresh endpoint evidence on the next turn and keep every incomplete claim explicit without blocking encrypted inference. No turn receipt currently establishes a hardware claim.",
      }
    : {
      state: "none",
      // Plain language leads and the acronym follows. "Demo provider" was also
      // simply untrue — there is no demo provider; nothing is connected.
      label: "Secure hardware not checked",
      detail: "No inference provider is connected, so no TEE evidence has been requested for this session.",
    };
}

export type SessionDurability = Readonly<{
  state: DurabilityState;
  detail: string;
}>;

/**
 * Where this session's journal lives, in the durability vocabulary.
 *
 * The one interesting boundary is an offline browser with an adopted Drive
 * vault: adoption is a local fact that stays true, but "synced" is a claim about
 * a completed round-trip that cannot currently run, so the derivation degrades
 * to `sync-paused` with the pause named in the detail. It deliberately does not
 * borrow `syncing`: that state's label is "Syncing encrypted state", a
 * present-progressive activity claim, and pairing it with this detail sentence
 * had one chip asserting both that a sync was in progress and that no sync was
 * running — in its visible text and in its accessible name at once. Ephemeral
 * and local-device answers do not depend on connectivity and are deliberately
 * untouched, and a loopback lab vault is reachable exactly as independently of
 * `navigator.onLine` as it was.
 */
export function describeSessionDurability(input: Readonly<{
  localDeviceRuntimeAdopted: boolean;
  cloudVaultRuntimeAdopted: boolean;
  googleDriveVault: boolean;
  vaultContractReady: boolean;
  syncTarget?: string;
  online: boolean;
}>): SessionDurability {
  if (input.localDeviceRuntimeAdopted) {
    return Object.freeze({
      state: "local" as const,
      detail: "This session journal and workspace write encrypted objects to browser-managed storage on this device. No cloud synchronization is active.",
    });
  }
  if (input.cloudVaultRuntimeAdopted && input.vaultContractReady) {
    if (input.googleDriveVault && !input.online) {
      return Object.freeze({
        state: "sync-paused" as const,
        detail: "Sync paused · offline. This browser cannot reach the adopted Google Drive folder; encrypted objects are not synchronizing until connectivity returns.",
      });
    }
    return Object.freeze({
      state: "synced" as const,
      detail: `This session journal and workspace write client-encrypted objects directly to ${input.syncTarget ?? "the adopted encrypted object store"}.`,
    });
  }
  return Object.freeze({
    state: "ephemeral" as const,
    detail: input.vaultContractReady
      ? "The cloud object-store contract is verified, but this active runtime has not adopted it; this session remains in page memory."
      : "This session journal exists only in page memory. Nothing is synced.",
  });
}

/** The conversation-scoped reading, for the session bar's attestation claim. */
export function describeAttestationSeal(args: {
  connected: boolean;
  proofPolicy?: "record" | "strict";
  receipt?: ConversationReceipt;
  records: readonly ChutesEndpointEvidenceRecord[];
  failure?: AttestationAcquisitionFailure;
  now: number;
}): { state: SealState; label: string; detail: string } {
  return describeEndpointEvidence({ ...args, scope: "session" });
}

/** The turn-scoped reading, for the evidence chip under one answer. */
function describeMessageAttestation(
  receipt: ConversationReceipt | undefined,
  records: readonly ChutesEndpointEvidenceRecord[],
  failure?: AttestationAcquisitionFailure,
  now = Date.now(),
): MessageAttestation | undefined {
  if (!receipt || !isChutesReceiptProvider(receipt.provider)) return undefined;
  return Object.freeze(describeEndpointEvidence({ scope: "turn", receipt, records, failure, now }));
}

export function evidenceAcquisitionNotice(
  snapshot: EvidenceAcquisitionQueueSnapshot | undefined,
  receiptId: string | undefined,
  persistenceFaulted = false,
): string | undefined {
  if (!snapshot || !receiptId) return undefined;
  const task = snapshot.tasks.find((candidate) => candidate.request.receiptId === receiptId);
  if (!task || task.status === "succeeded") return undefined;
  // A checkpoint fault halts queue scheduling, so any sentence here that
  // promises an upcoming retry would be lying while the fault stands.
  if (persistenceFaulted) {
    return "Evidence checkpointing failed. Automatic acquisition is paused until the queue snapshot commits again; the receipt remains unchanged.";
  }
  if (task.status === "pending") return "Automatic endpoint-evidence acquisition is queued for this completed turn.";
  if (task.status === "running") return `Automatic endpoint-evidence acquisition is running (attempt ${String(task.attempt)}).`;
  if (task.status === "retry") return `${task.failure.message}. Automatic acquisition will retry without changing the receipt.`;
  if (task.status === "failed") return `${task.failure.message}. Automatic acquisition reached a terminal outcome; the receipt remains unchanged.`;
  return task.reason === "scope-released"
    ? "Automatic endpoint-evidence acquisition stopped when the Chutes connection was released. The receipt remains unchanged."
    : "Automatic endpoint-evidence acquisition was cancelled. The receipt remains unchanged.";
}

/**
 * Asks a parked acquisition queue to retry the checkpoint that parked it.
 *
 * The queue's `schedule()` refuses to arm while a persistence fault stands, so
 * an explicit `wake()` is the only exit — which makes *what drives it* the whole
 * guarantee behind "acquisition is paused until the queue snapshot commits
 * again". It is a standalone function, taking nothing but the controller,
 * because the version this replaces was driven from the attestation-freshness
 * tick: that effect requires attestation records to exist, and the fault is
 * reachable on the very first acquisition of a conversation that has none. No
 * presentation state may be able to gate the recovery, so none is offered.
 *
 * Returns whether a wake was attempted, so the recovery is assertable directly
 * rather than inferred from the shape of an effect.
 */
export function wakeFaultedEvidenceAcquisitionQueue(
  queue: Pick<EvidenceAcquisitionQueueController, "fault" | "wake"> | undefined,
): boolean {
  if (!queue?.fault()) return false;
  void queue.wake().catch(() => {
    // Still faulted: the acquisition notice keeps naming the checkpoint failure
    // until a commit succeeds, and the caller arms the next attempt.
  });
  return true;
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

function endpointEvidenceForPersistence(record: ChutesEndpointEvidenceRecord): ChutesEndpointEvidenceRecord {
  return Object.freeze({
    ...record,
    acquisition: Object.freeze({
      ...record.acquisition,
      requestUrl: querylessProviderUrl(record.acquisition.requestUrl),
    }),
    warnings: Object.freeze([...record.warnings]),
  });
}

function endpointEvidenceWithDurabilityWarning(
  record: ChutesEndpointEvidenceRecord,
  reason: string,
): ChutesEndpointEvidenceRecord {
  return Object.freeze({
    ...record,
    warnings: Object.freeze([
      ...record.warnings.filter((warning) => warning !== reason),
      reason,
    ]),
  });
}

function modelCountLabel(count: number): string {
  return `${count} model${count === 1 ? "" : "s"}`;
}

/**
 * The names behind the count.
 *
 * "3 models" answers how many; nobody can pick one from a number. The check's
 * result sentence names the first few the server returned so the row points at
 * what was actually found, with the remainder counted.
 */
function modelNameList(models: readonly Readonly<{ id: string }>[]): string {
  if (models.length === 0) return "";
  const shown = models.slice(0, 4).map((model) => model.id);
  const rest = models.length - shown.length;
  return rest > 0 ? ` — ${shown.join(", ")}, +${rest} more` : ` — ${shown.join(", ")}`;
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
    // Preserve an invalid provider value for the strict persistence validator
    // to reject. Manufacturing a plausible replacement URL would hide source
    // corruption and weaken the independent-verification record.
    return value;
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
          <MessagePartsView parts={message.parts} live={message.status !== undefined} />
        ) : <p>{message.content || " "}</p>}
        <StreamingMessageSlot store={streamStore} messageId={message.id} active={message.status !== undefined} />
        {message.liveToolOutput ? (
          // No live region here: the <pre> re-renders on every output chunk,
          // and a polite region would re-announce the whole buffer per chunk.
          // The turn lifecycle is already announced through the message status.
          <section class="live-tool-output" aria-label="Live tool output">
            <header><span class="pulse-dot" /><strong>Live tool output</strong><code>{message.liveToolOutput.stream}</code></header>
            <pre>{message.liveToolOutput.text}</pre>
          </section>
        ) : null}
        {message.history ? (
          <div class="message-history" role="group" aria-label="Durable turn disposition">
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
        {/* Pointer devices get a reserved footer toolbar that fades on
            hover/focus; touch devices get the disclosure below. This is
            deliberately not one `<details>` for both: engines do not paint a
            closed details body, so hiding only its summary can leave desktop
            actions measurable but unreachable. */}
        <div class="message-actions" role="toolbar" aria-label="Message actions">
          <div class="message-actions-row">
            <button
              type="button"
              onClick={onCopy}
            >Copy</button>
            {/* Retry is a regeneration from the immutable pre-turn boundary.
                The prior answer remains inspectable in the source conversation
                but cannot contaminate the retry branch's provider context.

                The sentence is `FORK_RETRY_TOOLTIP`, not a literal: as a
                literal it drifted until it claimed the prior answer's sealed
                ancestor context IS carried into the branch, while the constant
                that every post-click branch headline is written beside says it
                is not. Two opposite claims about one click. */}
            {message.role === "assistant" && message.originatingPrompt ? (
              <button
                type="button"
                title={FORK_RETRY_TOOLTIP}
                onClick={onRetry}
                disabled={branchDisabled}
              >Retry</button>
            ) : null}
            {message.role === "user" ? (
              <button
                type="button"
                onClick={onEdit}
                disabled={branchDisabled}
              >Edit &amp; branch</button>
            ) : null}
            <button
              type="button"
              onClick={onBranch}
              disabled={branchDisabled}
            ><Icon name="branch" size={14} /> Fork from here</button>
          </div>
        </div>
        <details class="message-actions-touch">
          <summary aria-label="Message actions">•••</summary>
          <div role="group" aria-label="Message actions">
            <button type="button" onClick={onCopy}>Copy</button>
            {/* The same warning, as text a touch device can actually reach.
                `.message-actions` is `display: none` under `(hover: none)`, so
                the phone's Retry was this bare button and the only sentence
                describing what it does lived in a `title` no touch device can
                surface: a phone reader tapped Retry expecting a regenerate in
                place and silently got a new branch. Rendered as a sibling
                rather than inside the button so the control's accessible name
                stays the one word "Retry". */}
            {message.role === "assistant" && message.originatingPrompt ? (
              <>
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={branchDisabled}
                  aria-describedby={`retry-branch-note-${message.id}`}
                >Retry</button>
                <small class="message-actions-note" id={`retry-branch-note-${message.id}`}>{FORK_RETRY_TOOLTIP}</small>
              </>
            ) : null}
            {message.role === "user" ? <button type="button" onClick={onEdit} disabled={branchDisabled}>Edit &amp; branch</button> : null}
            <button type="button" onClick={onBranch} disabled={branchDisabled}><Icon name="branch" size={14} /> Fork from here</button>
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
  preferences,
}: {
  catalog: ProfileCatalog;
  catalogDurability: ProfileCatalogStore["durability"];
  activeProfileId: string;
  /**
   * Switches to this profile, and answers whether it actually became active.
   *
   * The boolean is the contract, not the absence of a rejection: the App-level
   * wrapper is deliberately unable to reject (`requestProfileChange`), so a
   * `Promise<void>` gave this editor no way to tell a committed switch from a
   * refused one and left the refusal legible only as a route that did not
   * change.
   */
  onActivate: (profileId: string) => Promise<boolean>;
  onSave: (draft: ProfileEditorDraft) => Promise<ProfileRevision>;
  onFork: (profile: ProfileRevision) => Promise<ProfileRevision>;
  onDelete: (profileId: string, replacementProfileId?: string) => Promise<void>;
  draftState: { current: boolean };
  selectedProfileId?: string;
  /**
   * The user's global display preferences. A theme preview writes the same
   * `<html>` attributes these own, so this view has to be able to put them
   * back in the same call; it never changes them.
   */
  preferences: PreferenceOverrides;
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

  /*
   * The undo for a preview, and only for leaving the route.
   *
   * Keyed on `previewThemeId` this was not a cleanup at all: choosing a second
   * theme re-ran it, so the first preview was reverted to the saved theme the
   * instant the second was applied. It restores the *active* profile's theme
   * rather than the selected one — the selected profile is whatever row the
   * editor happens to be showing, which may not be the profile the rest of the
   * cockpit is running on. The inputs are read from a ref so the effect can
   * have an empty dependency list and still restore current values.
   */
  const previewRestore = useRef<Readonly<{
    previewing: boolean;
    theme?: ThemeManifest;
    preferences: PreferenceOverrides;
  }>>();
  previewRestore.current = {
    previewing: Boolean(previewThemeId),
    theme: catalog.themes.find((theme) => theme.themeId === (
      profiles.find((profile) => profile.profileId === activeProfileId)?.theme.themeId ?? selected.theme.themeId
    )),
    preferences,
  };
  useEffect(() => () => {
    const restore = previewRestore.current;
    if (restore?.previewing && restore.theme) applyThemeWithPreferences(restore.theme, restore.preferences);
  }, []);

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

  /*
   * Activation is the one profile mutation this editor used to fire and forget.
   * Every other outcome here lands in `status`; a `void onActivate(…)` left a
   * refused switch to be inferred from the route not changing. Same shape as
   * `save`/`fork`/`archive`, including `busy` — a switch in flight must not
   * accept a second one.
   *
   * A refusal arrives as `false`, not as a rejection: the App wrapper converts
   * every failure into the topbar runtime line and returns, so awaiting alone
   * would have surfaced nothing here. The `catch` stays as the defence for a prop
   * that does reject — it is not what makes a refusal visible.
   */
  async function activate() {
    setBusy(true);
    setStatus(undefined);
    try {
      if (!await onActivate(selected.profileId)) {
        setStatus("This profile did not become active. The runtime status line at the top of the window names the reason.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="work-view">
      <RouteBar routeId="profiles" title="Profiles" eyebrow="Immutable agent manifests" description="Manage agent personas, instructions, and interface themes. Saves create content-addressed revisions; switching restores that profile's most recent compatible conversation." />
      <div class="management-layout">
        <div class="profile-catalog panel">
          <div class="panel-heading"><span>Profiles</span><button class="small-button" type="button" onClick={() => void fork()} disabled={busy}><Icon name="plus" size={14} /> Fork</button></div>
          <div class="profile-card-list">
            {profiles.map((profile) => (
              <button key={profile.profileId} class={profile.profileId === selected.profileId ? "profile-card active" : "profile-card"} type="button" onClick={() => { if (!dirty || window.confirm(PROFILE_DRAFT_DISCARD_PROMPT)) { setStatus(undefined); setSelectedId(profile.profileId); } }}>
                <span class="profile-monogram">{profileMonogram(profile.name)}</span>
                <span><strong>{profile.name}</strong><small>{profile.description}</small>{/* One spelling of this field's name, shared with the select below and
                    the revision strip beside it. It used to be typed out here with a
                    comment claiming `profiles-governance` was not in the startup
                    chunk — which was false: `chat/message-parts-view` imports
                    `PROFILE_APPROVAL_LABELS` from it, so the module was already
                    there and the duplicate bought nothing but a way to drift. */}
                <PostureChip posture={profile.minimumPosture} prefix={PROFILE_POSTURE_FIELD_LABEL} /></span>
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
            {/*
             * Instructions speak before they are opened.
             *
             * A closed disclosure with a character count answered "how long"
             * and concealed "what" — the profile's whole personality hid behind
             * one tap. The prompt previews through a fade and expands the same
             * disclosure on click, so the read happens in place; the editor
             * still lives one tap away inside the panel the summary names.
             */}
            <details class="profile-editor-disclosure">
              <summary>
                <span>System instructions</span>
                <small>{draft.systemPrompt.length.toLocaleString()} characters</small>
                {/* Two clamped lines with an ellipsis: enough of the prompt to
                    recognise the personality, never enough to mistake this for
                    the editor. The disclosure it previews folds away the moment
                    it opens (`.profile-editor-disclosure[open]` hides it). */}
                <span class="profile-prompt-preview" aria-hidden="true">{draft.systemPrompt.trim() || "No instructions set"}</span>
              </summary>
              <label><span>Prompt</span><textarea rows={7} value={draft.systemPrompt} onInput={(event) => setDraft({ ...draft, systemPrompt: event.currentTarget.value })} /></label>
            </details>
            {/* Interface theme and Profile boundaries open by default: a theme
                is a picture and a boundary is four words, both legible at a
                glance, and a collapsed section that only repeats its own title
                earns nothing. The summary smalls keep carrying the state for a
                reader who has already skimmed past it. */}
            <details class="profile-editor-disclosure" open>
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
                    onClick={() => { setDraft({ ...draft, themeId: theme.themeId }); setPreviewThemeId(theme.themeId); applyThemeWithPreferences(theme, preferences); }}
                  >
                    <ProfileThemeSwatch theme={theme} />
                    {/* The presentation line, because the manifest's typography
                        and layout are render inputs again: the option has to
                        name the difference activation will produce, not only
                        the colours the swatch already shows. */}
                    <span><strong>{theme.name}</strong><small>{theme.description}</small><small>{themePresentationSummary(theme)}</small></span>
                  </button>
                ))}
                </div>
              </div>
            </details>
            <details class="profile-editor-disclosure" open>
              <summary><span>Profile boundaries</span><small>{PROFILE_MEMORY_SCOPE_LABELS[enforcedMemoryScope(draft.memoryScope)]} · {approvalModeLabel(draft.approvalMode)}</small></summary>
              <div class="profile-boundary-grid">
                <label><span>Workspace</span><MenuSelect ariaLabel="Profile workspace binding" value={draft.workspaceBinding} options={[
                  { value: "active-workspace", label: "Current workspace", description: "Follow the workspace chosen by this runtime" },
                  { value: "workspace-id", label: "Exact workspace", description: "Only start on one pinned workspace ID" },
                ]} onChange={(workspaceBinding) => setDraft({ ...draft, workspaceBinding: workspaceBinding as ProfileEditorDraft["workspaceBinding"] })} /></label>
                {/* Two values, because there were only ever two boundaries.
                    "Shared workspace" named a widening no reader implements —
                    every memory read narrows on the pinned profile ID — so
                    offering it sold a silo change that never happened. The
                    draft arrives through `enforcedMemoryScope`, which reads a
                    stored `workspace` as the `profile` it always behaved as, so
                    an existing profile still selects a real option. */}
                <label><span>Memory priority</span><MenuSelect ariaLabel="Profile memory scope" value={draft.memoryScope} options={[
                  { value: "session", label: "This conversation" },
                  { value: "profile", label: "This profile" },
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
                  /*
                   * Offered, and honest about being unreachable in this build.
                   *
                   * Nothing can produce an `encrypted-attested` posture while
                   * strict endpoint proof is unavailable, so choosing it here
                   * used to commit a profile that could never start a
                   * conversation — while the Connection route, a thousand lines
                   * away, spent a whole disclosure saying strict fail-closed is
                   * unavailable. Two surfaces, opposite answers, and the
                   * overclaiming one silently bricked the profile.
                   *
                   * Disabled rather than deleted: the capability is real and
                   * half-built, the reason is the verifier's own words, and the
                   * option returns by itself the day `available` flips.
                   */
                  {
                    value: "encrypted-attested",
                    label: "Attested",
                    description: strictProofCapability.available ? "Require verified endpoint evidence" : strictProofCapability.reason,
                    disabled: !strictProofCapability.available,
                  },
                ]} onChange={(minimumPosture) => setDraft({ ...draft, minimumPosture: minimumPosture as SecurityPosture })} /></label>
                {draft.workspaceBinding === "workspace-id" ? <label><span>Workspace ID</span><input value={draft.workspaceId} maxLength={512} placeholder="vault+gdrive://…" onInput={(event) => setDraft({ ...draft, workspaceId: event.currentTarget.value })} /></label> : null}
              </div>
              <p class="profile-boundary-note">{PROFILE_BOUNDARY_NOTE}</p>
            </details>
            <div class="revision-strip">
              <span><small>Runtime</small>{selected.providerId} · {selected.model}</span>
              <span><PostureChip posture={selected.minimumPosture} prefix={PROFILE_POSTURE_FIELD_LABEL} /></span>
              <span><small>Skills resolved</small>{effectiveSkillIds(selected, catalog).length}</span>
              <span><small>Parent</small>{selected.parentRevision?.slice(-8) ?? "origin"}</span>
            </div>
            <div class="profile-actions">
              <button class="small-button" type="button" onClick={() => void save()} disabled={busy}>Save new revision</button>
              <button class="primary-link button-link" type="button" onClick={() => void activate()} disabled={busy || dirty} title={dirty ? "Save this revision before applying it." : undefined}>Switch to this profile</button>
              {/*
                * Cancelling a preview undoes the preview — nothing else. The
                * button used to replace the whole draft with the saved
                * revision, silently discarding every unsaved name, role,
                * instruction and boundary the editor was holding, without
                * confirmation. Only the previewed theme field goes back.
                */}
              {previewThemeId ? <button class="small-button" type="button" onClick={() => { const theme = previewRestore.current?.theme; if (theme) applyThemeWithPreferences(theme, preferences); setDraft((current) => ({ ...current, themeId: selected.theme.themeId })); setPreviewThemeId(undefined); }}>Cancel preview</button> : null}
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
  /** Switches to the previewed profile, answering whether it became active. */
  onApply: (profileId: string) => Promise<boolean>;
  scope: string;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState(activeProfileId);
  const profiles = useMemo(() => managedProfiles(catalog), [catalog]);
  const scopedProfileId = scope === "global" ? selectedProfileId : scope;
  const profile = profiles.find((candidate) => candidate.profileId === scopedProfileId) ?? profiles[0]!;
  const [status, setStatus] = useState<string>();
  /*
   * The grid asks `domain.ts` the same question the session pin asks it. It
   * used to recompute `on` / `inherit` / global-default itself, so a change to
   * the precedence had to be made here as well to keep the card's "resolved on"
   * badge honest about what the next conversation would actually load.
   */
  const decisions = useMemo(() => skillDecisionsFor(profile, catalog), [profile, catalog]);
  const decisionBySkillId = useMemo(
    () => new Map(decisions.map((decision) => [decision.skillId, decision] as const)),
    [decisions],
  );
  const resolvedCount = decisions.filter((decision) => decision.enabled).length;

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

  /** Same contract as the Profiles editor: a refusal is `false`, not a rejection. */
  async function applyProfile(): Promise<void> {
    setStatus(undefined);
    try {
      if (!await onApply(profile.profileId)) {
        setStatus("This profile did not become active. The runtime status line at the top of the window names the reason.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section class="work-view">
      <RouteBar routeId="skills" title="Skills" eyebrow="Resolved instruction modules" description={scope === "global" ? "Set global skill defaults. Enabled instructions are pinned into the next conversation manifest." : `Set inherit/on/off overrides for ${profile.name}. Existing conversations remain pinned.`} />
      <div class="skills-toolbar panel">
        {scope === "global" ? <div class="skill-select-field"><span>Preview resolution for</span><MenuSelect placement="down" ariaLabel="Preview profile resolution" value={profile.profileId} options={profiles.map((candidate) => ({ value: candidate.profileId, label: candidate.name }))} onChange={setSelectedProfileId} /></div> : <div><span class="eyebrow">Profile scope</span><strong>{profile.name}</strong></div>}
        <div><span class="eyebrow">Effective set</span><strong>{resolvedCount} of {catalog.skills.length}</strong></div>
        <button class="small-button" type="button" onClick={() => void applyProfile()}>Switch to {profile.name}</button>
      </div>
      <div class="skill-grid">
        {catalog.skills.map((skill) => {
          const { mode, globallyEnabled: globalEnabled, enabled } = decisionBySkillId.get(skill.skillId)!;
          return (
            <article class={enabled ? "skill-card panel enabled" : "skill-card panel"} key={skill.skillId}>
              <header><span class="skill-glyph"><Icon name="skills" /></span><div><h2>{skill.name}</h2><code>{skill.skillId}</code></div><span class={enabled ? "skill-state on" : "skill-state"}>{enabled ? "resolved on" : "resolved off"}</span></header>
              <p>{skill.description}</p>
              <div class="skill-controls">
                {scope === "global" ? <button class={globalEnabled ? "toggle-control on" : "toggle-control"} role="switch" aria-label={`Global default for ${skill.name}`} aria-checked={globalEnabled} type="button" onClick={() => void updateGlobal(skill.skillId, !globalEnabled)}><span /> Global default</button> : <div class="skill-select-field"><span>{profile.name}</span><MenuSelect placement="down" ariaLabel={`${profile.name} mode for ${skill.name}`} value={mode} options={[{ value: "inherit", label: "Inherit global" }, { value: "on", label: "Always on" }, { value: "off", label: "Always off" }]} onChange={(next) => void updateProfileSkill(skill.skillId, next as SkillMode)} /></div>}
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

/**
 * The route bar for the three headers the *entry chunk* renders.
 *
 * Not `<RouteHeader>`, and the reason is a budget rather than a preference:
 * `release-gate.mjs` classifies `route-header.tsx` as "shared route chrome
 * fetched with any route, never at first paint", and importing it from
 * `app.tsx` makes it a modulepreload of the entry — 1.9 KiB gzip of first
 * paint bought for three headers, on a product whose startup cap has never
 * been raised. The classifier rejects the build outright when that happens,
 * which is the budget defending itself.
 *
 * What matters is that there is still **one heading recipe**: this emits the
 * primitive's own class names, so `.route-header` / `.route-title` in
 * `routes.css` draw it, and a change there moves all fourteen routes at once.
 * The retired page slab was a second *recipe* — its own max-width, its
 * own 47px `clamp()` — not merely a second renderer.
 *
 * It is fixed at document density because that is the density that hides
 * nothing: the eyebrow and the sentence are both on screen, so no ⓘ is needed
 * and `<Popover>` — the actual weight in `route-header.tsx` — is not reached.
 * `route-header.test.ts` asserts the same thing about the component: with no
 * description behind it and no notes, the disclosure does not exist at all.
 */
function RouteBar({ routeId, eyebrow, title, description, headingId }: {
  routeId: string;
  eyebrow: string;
  title: string;
  description: string;
  headingId?: string;
}) {
  return (
    <header class="route-header" data-density="document">
      <div class="route-header__bar">
        <p class="route-header__eyebrow eyebrow" id={`route-${routeId}-eyebrow`}>{eyebrow}</p>
        <h1 class="route-title" id={headingId}>{title}</h1>
      </div>
      <p class="route-header__description" id={`route-${routeId}-description`}>{description}</p>
    </header>
  );
}

/* `EmptyState` moved to `./empty-state`. It was declared here, styled in
   `routes.css`, and rendered by nothing — a private helper inside 11k lines
   that no route could import, which is why ten routes drew their own
   "nothing here yet" at four different heights instead. */

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
    // A profile stored under the withdrawn `workspace` scope opens on the value
    // it has always behaved as, so the editor never shows a selection the
    // control no longer offers — and saving migrates the stored revision.
    memoryScope: enforcedMemoryScope(silo.memoryScope),
    approvalMode: silo.approvalMode,
    minimumPosture: profile.minimumPosture,
  };
}

/**
 * The resolved skill set, in the order the pin composes it.
 *
 * A thin read of `resolveSkillDecisions`, not a second answer: this used to
 * restate the inherit/on/off precedence and sort with `localeCompare`, where
 * `domain.ts` sorts with `asciiCompare` — so under a locale that collates skill
 * IDs differently the count beside "Skills resolved" was derived from an order
 * no manifest is ever composed in.
 */
function effectiveSkillIds(profile: ProfileRevision, catalog: ProfileCatalog): string[] {
  return skillDecisionsFor(profile, catalog)
    .filter((decision) => decision.enabled)
    .map((decision) => decision.skillId);
}

function skillDecisionsFor(profile: ProfileRevision, catalog: ProfileCatalog): readonly ResolvedSkillDecision[] {
  return resolveSkillDecisions({
    skillModes: profile.skillModes,
    skills: catalog.skills,
    globalSkills: catalog.globalSkills,
  });
}

function receiptSummary(receipt: ConversationReceipt): string {
  if (receipt.posture === "local") return "Client request and response digests were recorded locally. No external signer or hardware identity was verified.";
  if (receipt.posture === "encrypted-unattested") return "Encrypted request and response bindings were recorded, but the endpoint's hardware identity was not independently verified.";
  if (receipt.posture === "encrypted-attested") return "The receipt includes encrypted conversation bindings and endpoint evidence; expand each claim to inspect exactly what its verifier checked.";
  return "A remote conversation receipt was recorded without an encrypted transport claim.";
}

function readViewHash(): View {
  if (typeof window === "undefined") return "chat";
  return navigationViewFromHash(window.location.hash);
}

/**
 * What the rail is allowed to infer about this viewport.
 *
 * Pointer type is read as well as width because the 60px rail's labels are
 * revealed by hover, and a touch tablet has no hover to reveal them with —
 * width alone would ship an unlabelled icon column to an iPad.
 */
function readRailViewport(): Readonly<{ width: number; hoverCapable: boolean }> {
  if (typeof window === "undefined") return Object.freeze({ width: 1_440, hoverCapable: true });
  return Object.freeze({
    width: window.innerWidth,
    hoverCapable: window.matchMedia?.("(hover: hover)").matches ?? true,
  });
}

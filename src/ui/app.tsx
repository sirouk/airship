import { formatBytes } from "../core/bytes";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { isReclaimableObjectStore } from "../storage/object-store";
import { ApprovalBroker, redactForDisplay } from "../approvals/broker";
import { approvalProvenance, createApprovalModePolicy, createHumanIntentPolicy, decideHumanIntent, type ApprovalMode } from "../approvals/modes";
import { SwitchableApprovalPolicy } from "../approvals/switchable-policy";
import type { VaultUsageFacts } from "./vault-view";
import type { BrowserRuntimeCapabilityReport } from "../capabilities/browser-runtime";
import type { ExtensionBridgeObservation } from "../capabilities/extension-bridge";
import {
  type SlashCommandPlan,
  type SlashCommandRegistry,
  type SlashCompletion,
} from "../commands";
import { HUMAN_INTENT_EVENT_TYPE } from "../core/contracts";
import type { ConversationReceipt } from "../core/conversation-receipt";
import { conversationTitleFromPrompt } from "../core/conversation-title";
import type { CanonicalMessage, InferenceTransport, JsonValue, SessionManifest, ToolContext, ToolDefinition } from "../core/contracts";
import type { LiveEnvironmentEntry } from "../core/live-environment";
import type { InferenceDirectoryPromptDefinition } from "../core/operating-charter";
import { EventJournal, effectiveSessionModel, type DurableEvent, type SessionRecord } from "../core/journal";
import { planModelSwitch, modelSwitchNeedsCompressionGate } from "./model-switch-plan";
import { parseReasoningVisibility, setReasoningVisibility } from "./chat/reasoning-visibility";
import { densityAllows, parsePresentationDensity, setPresentationDensity, usePresentationDensity } from "./density";
import { randomUuid } from "../core/id";
import { loadBrowserGit } from "../load-browser-git";
import { runTurn } from "../load-agent-runtime";
import { runTurnBeforeNaming } from "./turn-naming";
import { inspectBrowserExecutionTier } from "../load-execution-runtime";
import { MemoryJournalBackend } from "../core/memory-journal";
import type { SessionAuditReport } from "../core/session-audit";
import { sessionAuditRefusesResume } from "../core/session-audit-admission";
import { DemoInferenceTransport } from "../inference/demo";
import type {
  ActivatedInferenceRoute,
  BrowserInferenceFabric,
  BrowserInferenceConnection,
} from "../inference/fabric";
import type {
  InspectInferenceConnectionsTool,
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
import type { ExecutionCapability } from "../execution/runtime-registry";
import {
  archiveProfileRevision,
  createBuiltInProfileCatalog,
  managedProfileRevisions,
  profileCodeThemeId,
  removeAuthoredSkill,
  setProfileCodeTheme,
  upsertAuthoredSkill,
  type ProfileCatalog,
} from "../profiles/catalog";
import {
  MemoryProfileCatalogStore,
  type ProfileCatalogCheckpoint,
  type ProfileCatalogStore,
} from "../profiles/persistence";
import {
  PROFILE_BOUNDARY_NOTE,
  PROFILE_MEMORY_SCOPE_LABELS,
} from "./profiles-governance";
import type { VNode } from "preact";
import type { QuarantineReportProps, ResumeReportProps } from "./chat/resume-report";
import { providerBoundaryLabel } from "../inference/transport-boundary-label";
import {
  createGlobalSkillSettings,
  createProfileRevision,
  createSkillRevision,
  enforcedMemoryScope,
  resolveProfileSilo,
  resolveProfileWebBodies,
  resolveProfileWebEgress,
  resolveProfileForSession,
  resolveSkillDecisions,
  themeCssVariables,
  type ProfileRevision,
  type ResolvedSkillDecision,
  type SkillMode,
  type SkillRevisionDraft,
  type ThemeColorScheme,
  type ThemeManifest,
} from "../profiles/domain";
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
  forkActivationManifestMatches,
  inferenceBindingsMatch,
  profileOwnedSessions,
  profileOwnsSession,
  requireProfileOwnedSession,
  resolveResumableProfileConversation,
  resumableProfileConversationCandidates,
  resumableProfileManifestMatches,
} from "../sessions/profile-cockpit";
// Type-only: the value side lives in the deferred adoption chunk, beside the
// migration whose result it describes, so first paint pays nothing for it.
import type { AdoptionCarriedWork } from "../vault/runtime-adoption";
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
import { ProfileWorkspacePort, adoptLegacyRootWorkspace, profileWorkspaceIdentity } from "../workspace/profile-scope";
import { WorkspaceRefreshCoordinator, type WorkspaceRefreshAuthority } from "./workspace-refresh";

import { nextEditorSelection, type EditorSelection } from "./editor-selection";
import { Icon } from "./icons";
import type {
  LocalDeviceActivationReason,
  LocalDeviceAtomicRestoreRequest,
} from "./local-device-vault-setup";
import { chatHash, chatSessionIdFromHash } from "./chat-route";
import {
  accessReconnectHash,
  canonicalAccessHash,
  parseAccessReconnectIntent,
  reconnectIntentsEqual,
  type AccessReconnectIntent,
} from "./access-intent";
import { useBottomFloor } from "./bottom-floor";
import { loadRetryableChunk } from "./chunk-recovery";
import { MenuSelect } from "./menu-select";
import { MobileNavigation } from "./mobile-navigation";
import { ModelControl } from "./model-control";
import { DeferredRunDetails } from "./chat/deferred-run-details";
import { CANONICAL_DESTINATIONS, navigationHashForView, navigationViewFromHash, type NavigationView } from "./navigation-model";
import {
  PwaUpdateBanner,
  SHORTCUT_SHEET_CHORD,
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
  useGlobalShortcutSheet,
  usePwaUpdate,
  useVisualViewport,
  vaultBackendUnavailableReason,
  type PreferenceOverrides,
  type VaultBackend,
} from "./platform-shell";
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
import { StatusMark, type StatusMarkState } from "./status-mark";
import { useScrollEdges } from "./scroll-affordance";
import { enabledSlashSelection, firstEnabledSlashIndex, moveSlashSelection } from "./slash-menu-state";
import type { SourcesImportRequest } from "./sources-view";
import type { MemoryChange, MemoryCommitOutcome, MemoryRecordPage, MemorySourceTarget } from "./memory-view";
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
import type { MessagePartsViewProps } from "./chat/message-parts-view";
import { capabilityTierDetail, capabilityTierLabel } from "./chat/capability-tier";
import { useWindowedTranscript } from "./chat/use-windowed-transcript";
import { composerAttachments, userMessageParts, COMPOSER_ATTACHMENT_LIMIT, type ComposerAttachment } from "./chat/composer-state";
import { MOBILE_SHELL_MEDIA_QUERY, shouldClaimComposerFocus } from "./chat/composer-focus";
import {
  composerAttachmentNeedsText,
  composerAttachmentNotice,
  composerGrowthCap,
  composerPlaceholder,
  ComposerKeyhintLegend,
  COMPOSER_NARROW_PLACEHOLDER_QUERY,
  COMPOSER_PLACEHOLDER_TITLE,
  SLASH_MENU_HEADER,
} from "./chat/composer";
// The pre-click branch sentence, imported rather than retyped: the literal
// that used to sit on the Retry button drifted away from this constant and
// ended up promising that the prior answer IS carried into the branch, which
// is the opposite of what the fork does.
import { branchTitleFor, forkBranchNotice, FORK_RETRY_TOOLTIP } from "./chat/fork-notice";
import { originatingPromptForRow } from "./chat/retry-prompt";
// Types only: the reducer itself stays in the deferred capability pack.
import type {
  SessionMessagePresentation,
  SessionPresentationHistory,
  SessionPresentationMarker,
  SessionPresentationProviderContext,
  SessionPresentationTurnStatus,
} from "./chat/session-message-presentation";
/**
 * The failure vocabulary is fetched when a turn fails, not at first paint.
 *
 * Every call site is already an `async` catch handler that awaits an import, so
 * the entry chunk does not have to carry sentences a turn only needs when it
 * goes wrong. The `.catch` at each site matters: the condition that produced
 * the failure is often the condition that will refuse this fetch too, and a
 * failed turn must still say something rather than throwing inside its own
 * error handler.
 */
const loadTurnRecovery = () => import("./chat/turn-recovery");
// One owner for everything a turn says out loud. Before it, the in-flight
// utterance named a storage operation, arrival quoted an empty stream buffer,
// and the local-command lane was silent in both directions.
import {
  arrivalAnnouncement,
  failureAnnouncement,
  localCommandAnnouncement,
  spokenCommandName,
  stoppedAnnouncement,
  useTurnNarration,
  workingAnnouncement,
} from "./chat/turn-narration";
import { claimThreadDraftHydration, readThreadDraft, writeThreadDraft } from "./chat/thread-draft";
import { readDurableDraft, writeDurableDraft } from "./chat/durable-draft";
import { publishReloadRisk } from "./reload-risk";
import type { UnrecoveredWork } from "./chat/return-ledger";
import { browserReturnLedgerStorage } from "./chat/ledger-storage";
import { browserThreadViewportStorage, readThreadViewport, writeThreadViewport } from "./chat/thread-viewport";
import { appendThreadQueueItem, removeThreadQueueItem } from "./chat/thread-queue";
import {
  refreshCompletedTurnWorkspace,
  releaseComposerAndReloadSession,
} from "./chat/turn-housekeeping";
import { StreamingMessageSlot, StreamingReasoningSlot, TranscriptStreamStore } from "./chat/streaming-slot";
import { focusTranscriptTurn, isNearLastRealCard, preferredJumpBehavior, scrollToLastRealCard } from "./chat/transcript-anchor";
import { DemoModelChip, SessionBar } from "./chat/session-bar";
import { sessionStatusShort, type SessionStatusFact } from "./chat/session-status-chip";
import {
  TRANSCRIPT_INTRO_DEMO_LINE,
  TRANSCRIPT_SEED_BODY,
  TranscriptIntro,
  TranscriptMarker,
  transcriptIntroNote,
} from "./chat/transcript-intro";
import { DeferredTabPresenceNote } from "./deferred-tab-presence";
import { ProfileThemeSwatch, themePresentation, themePresentationSummary } from "./profile-theme-swatch";
import { durabilityLabel, durabilityStatusMark, durabilityShort, type DurabilityState } from "./durability-indicator";
import { DeferredRouteFailure } from "./deferred-route-failure";
import { RouteSkeleton } from "./route-skeleton";
import type { ProfileSwitchFailure } from "./skills-manager-view";
import {
  OFFLINE_INLINE_REASON,
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
 * a person re-find a thread without exposing runtime pins or credentials. */
type RecentConversation = Readonly<{
  id: string;
  profileId: string;
  title: string;
  preview: string;
  updatedAt: string;
  favorite: boolean;
  durableEventCount: number;
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

type SessionRuntimeAuthority = Pick<Runtime, "transport" | "model" | "inferenceBinding" | "workspaceId">;

type ForkActivationAuthority = Readonly<{
  runtime: Runtime;
  profileId: string;
  profileRevision: string;
  activeSessionId: string;
  manifest: SessionManifest;
}>;

type LocalPresentationAuthority = Readonly<{
  identityRuntime: Runtime;
  commandRuntime: Runtime;
  profileId: string;
  profileRevision: string;
  sessionId: string;
}>;

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

type EditorScreenComponent = typeof import("./editor-view").EditorView;
type TerminalScreenComponent = typeof import("./terminal-view").TerminalView;
type CapabilitiesScreenComponent = typeof import("./capabilities-view").CapabilitiesView;
type MemoryScreenComponent = typeof import("./memory-view").MemoryView;
type SkillsScreenComponent = typeof import("./skills-manager-view").SkillsManagerView;
type GoogleDriveSetupComponent = typeof import("./google-drive-setup").GoogleDriveSetup;
type LocalLabSetupComponent = typeof import("./local-lab-setup").LocalLabSetup;
type LocalDeviceVaultSetupComponent = typeof import("./local-device-vault-setup").LocalDeviceVaultSetup;
type SessionsScreenComponent = typeof import("./sessions-route").SessionsView;
type VaultScreenComponent = typeof import("./vault-view").VaultView;
type ProviderConnectionsScreenComponent = typeof import("./provider-connections-view").ProviderConnectionsView;
const WORKSPACE_EDITOR_BYTE_LIMIT = 128 * 1024;
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
  webEgress: "node-first" | "browser-only";
  webBodies: "any" | "text-only";
  reasoningVisibility: "collapsed" | "expanded";
  density: "minimal" | "balanced" | "instrumented";
};

/**
 * The return ledger, fetched rather than shipped at first paint.
 *
 * Every one of its callers is already asynchronous — recording an entry, and
 * reconciling the ledger against a journal read — so deferring the module costs
 * nothing at the call site. Statically imported it put 9.9 KiB of source into
 * the entry chunk and helped push first paint to 114.73 KiB gzip against a
 * 112.00 KiB ceiling, which is the one budget in this file that does not move:
 * it is what a person waits for before anything at all is on screen.
 */
/**
 * The approval dock, fetched when something first asks permission.
 *
 * A request can only exist once a model is connected and a turn is running, so
 * none of this is first-paint content — and the pass that gave the dock its
 * accessible write description and its outcome announcement also gave it 425
 * lines, which the entry chunk was paying for on every cold open. The person
 * waiting on the dock is already waiting on the agent, and the chunk resolves
 * from cache on every request after the first.
 */
/**
 * The message-part renderer, fetched when a message first has parts.
 *
 * Tool calls, attachments, receipts and errors are what it draws, and an empty
 * conversation — the only thing on screen at first paint — has none of them. It
 * was static, so every cold open paid 32 KiB of source for a renderer nobody
 * had given anything to draw yet.
 */
function loadMessageParts() {
  /*
   * Through the chunk recovery every other deferred route already uses.
   *
   * A bare `import()` has exactly one attempt, and this one is on the path that
   * draws tool calls, attachments and receipts — so a single failed fetch left a
   * restored conversation unable to render its own contents. Observed under a
   * loaded dev server: three consecutive "Failed to fetch dynamically imported
   * module: .../message-parts-view.tsx" in one journey. A person on a bad
   * connection gets the same event, and the warm below cannot help if the one
   * attempt it makes is the one that fails.
   */
  return loadRetryableChunk(
    "message-parts-view",
    () => import("./chat/message-parts-view"),
    developmentChunkEntry("chat/message-parts-view.tsx"),
  );
}

/**
 * Warms the message-part chunk once the shell is up.
 *
 * Deferring it keeps 32 KiB of source out of first paint, and fetching it only
 * when a message first has parts made that fetch a network dependency at the
 * worst possible moment: this product is local-first, and the offline-reload
 * journey failed with "Failed to fetch dynamically imported module" — a
 * restored conversation that could not render its own tool calls because the
 * renderer was still on the far side of a connection that had gone away.
 *
 * So the split stays and the fetch moves: after the first paint, while nothing
 * is waiting on it, and long before anyone goes offline.
 */
function warmMessageParts(): void {
  // The rejection is terminated here because nobody is waiting on this fetch:
  // `loadRetryableChunk` reports a terminal failure by throwing, and from an
  // idle prefetch that is an unhandled rejection in the console rather than a
  // fact anyone can act on. The card that needs the chunk reports its own.
  const warm = () => { void loadMessageParts().catch(() => undefined); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 2_000 });
  else setTimeout(warm, 0);
}

/*
 * Same offline reality as the parts view: any route that lands cold on an
 * already-offline tab fetches this chunk twice and loses both times, and the
 * status tag is the W6 surface every fresh cockpit's chat stage takes.
 */
function warmAgentRuntimeStatus(): void {
  // Same unwatched prefetch, same reason it must not reject into the console.
  const warm = () => { void loadAgentRuntimeStatus().catch(() => undefined); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 2_000 });
  else setTimeout(warm, 0);
}

/*
 * The agent-runtime status tag, deferred — same mount-once shape as the
 * message parts above.
 *
 * Nothing asks which engine owns the session before the shell exists, and the
 * answer is an async journal read anyway, so the question's whole surface —
 * the status derivation in `src/prime/runtime/agent-runtimes.ts` included —
 * rides its own chunk and arrives after first paint.
 */
function loadAgentRuntimeStatus() {
  return loadRetryableChunk(
    "agent-runtime-status",
    () => import("./agent-runtime-status"),
    developmentChunkEntry("agent-runtime-status.ts"),
  );
}

type AgentRuntimeStatusTagComponent = typeof import("./agent-runtime-status").AgentRuntimeStatusTag;

let agentRuntimeStatusTag: AgentRuntimeStatusTagComponent | undefined;

function DeferredAgentRuntimeStatus(props: Parameters<AgentRuntimeStatusTagComponent>[0]) {
  const [Tag, setTag] = useState<AgentRuntimeStatusTagComponent | undefined>(() => agentRuntimeStatusTag);
  useEffect(() => {
    if (agentRuntimeStatusTag) return;
    let live = true;
    void loadAgentRuntimeStatus().then((module) => {
      agentRuntimeStatusTag = module.AgentRuntimeStatusTag;
      if (live) setTag(() => module.AgentRuntimeStatusTag);
    });
    return () => { live = false; };
  }, []);
  return Tag ? <Tag {...props} /> : null;
}

let messagePartsView: ((props: MessagePartsViewProps) => VNode) | undefined;

function DeferredMessageParts(props: MessagePartsViewProps) {
  const [View, setView] = useState<((props: MessagePartsViewProps) => VNode) | undefined>(() => messagePartsView);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (messagePartsView) return;
    let live = true;
    void loadMessageParts().then((module) => {
      messagePartsView = module.MessagePartsView;
      if (live) setView(() => module.MessagePartsView);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  if (View) return <View {...props} />;
  // The renderer is on the far side of a fetch that did not land, and
  // `loadRetryableChunk` has already spent its retry. Rendering `null` here
  // gave every row that has parts a labelled empty card, so a reloaded offline
  // conversation looked wiped. The words are local either way: say them, in the
  // same plain shape the card uses for a message with no parts at all.
  return failed ? <p>{messagePlainText(props.parts)}</p> : null;
}

function developmentChunkEntry(path: string): string | undefined {
  return import.meta.env.DEV ? `${import.meta.env.BASE_URL}src/ui/${path}` : undefined;
}

function loadApprovalDock() {
  return loadRetryableChunk(
    "approval-dock",
    () => import("./approval-dock"),
    developmentChunkEntry("approval-dock.tsx"),
  );
}

function loadPlatformOverlays() {
  return loadRetryableChunk(
    "platform-overlays",
    () => import("./platform-overlays"),
    developmentChunkEntry("platform-overlays.tsx"),
  );
}

function loadKeyboardShortcutsSheet() {
  return loadRetryableChunk(
    "keyboard-shortcuts-sheet",
    () => import("./keyboard-shortcuts-sheet"),
    developmentChunkEntry("keyboard-shortcuts-sheet.tsx"),
  );
}

type DeferredOverlayName = "Command Center" | "Preferences" | "Keyboard shortcuts";

function deferredOverlayOpenerCandidate(active: Element | null): HTMLElement | undefined {
  return active instanceof HTMLElement
    && active !== document.body
    && !active.closest(".pwa-update,[role=dialog]")
      ? active
      : undefined;
}

const APPROVAL_DOCK_LOAD_FAILURE =
  "Approval controls did not load. Requests that require a person’s decision remain blocked; automatic reads and Full Access do not use this dialog.";

/**
 * The return ledger, deferred — and remembered once it has arrived.
 *
 * Dismissing the resume report has to retire the records it reported, and doing
 * that through a fresh `import()` leaves the same close/reload race the delete
 * path was just fixed for: the report is gone from the screen and still on
 * disk, so the next visit mourns work the person has already been told about
 * and dismissed. By the time a dismiss is possible the module is loaded (the
 * report is rendered from it), so this hands it back synchronously and the
 * write cannot be outrun.
 */
let loadedReturnLedger: typeof import("./chat/return-ledger") | undefined;

function loadReturnLedger() {
  return import("./chat/return-ledger").then((module) => {
    loadedReturnLedger = module;
    return module;
  });
}

function readyReturnLedger(): typeof import("./chat/return-ledger") | undefined {
  return loadedReturnLedger;
}

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
  /**
   * The one card that carries the weight of the screen.
   *
   * Only set where a starter is the thing the person almost certainly came to
   * do. Three cards of equal weight is a menu, and a menu asks a newcomer to
   * decide something before they know anything.
   */
  lead?: true;
  action:
    | Readonly<{ kind: "prompt"; prompt: string }>
    | Readonly<{ kind: "route"; view: NavigationView }>;
}>;

const CONNECTED_STARTERS: readonly StarterCard[] = Object.freeze([
  Object.freeze({
    title: "Review this setup",
    hint: "See the provider, model, storage, and tool boundaries",
    action: Object.freeze({
      kind: "prompt" as const,
      prompt: "Summarize this session's current provider, model, storage, workspace, and tool setup. Name any limits that affect the work.",
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

/*
 * Connect leads, and it says what it gives rather than what it is only for.
 *
 * The topbar already renders "Connect a model" as the one filled brass action
 * on the screen, and the empty state disagreed with it: the same act was the
 * third of three equal cards, subtitled "Only chat needs this" — a true
 * sentence that reads, to someone who came here to chat, as a reason to skip
 * it. Two surfaces, one act, opposite weights, and the newcomer's own errand
 * ranked last.
 *
 * The other two stay exactly where they are. That a terminal and a real
 * workspace work in this tab with no account is Airship's most surprising
 * claim, it is already the headline above these cards, and burying it to make
 * Connect louder would trade one misplaced emphasis for another.
 */
const DISCONNECTED_STARTERS: readonly StarterCard[] = Object.freeze([
  Object.freeze({
    title: "Connect a model",
    hint: "A cloud provider or a model on this machine",
    lead: true as const,
    action: Object.freeze({ kind: "route" as const, view: "access" as const }),
  }),
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
  // Drop the ceiling this function wrote last time before reading the declared
  // one. An inline `max-height` outranks the stylesheet, so measuring without
  // clearing it fed the previous viewport-derived cap back in as the declared
  // cap — and the cap can only shrink, so one soft-keyboard raise left the
  // composer permanently capped at a third of the shrunken viewport, with the
  // dismissal that should have given the 180px back unable to.
  element.style.maxHeight = "";
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
  /*
   * An empty box is the one height that is known rather than measured.
   *
   * Growth still asks the element how tall its text wants to be. Emptiness
   * does not have to ask, and asking is what kept the composer open: measured
   * on this build at 320, 390, 430, 768, 1024, 1440 and 1920, clearing a draft
   * left the textarea sitting at exactly the cap — 180px of nothing above the
   * footer, with the transcript's one sentence pushed off a 320px phone —
   * because `scrollHeight` answered with the extent the box had grown to and
   * not with the extent an empty value needs, and every later refit measured
   * the same stuck answer. Blurring the composer did not release it either, so
   * it was not a focus affordance — it was 136px the person could not get back.
   */
  const natural = element.value ? element.scrollHeight : minimum;
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
      // `TranscriptMarker` reads any historical run receipt directly from
      // this marker; it never masquerades as an assistant answer.
      marker,
      sourcePoint: { sequence: marker.sequence, digest: marker.digest },
    });
  }
  merged.push(...rows.slice(cursor));
  return merged;
}

/**
 * Which of these conversations the journal still holds.
 *
 * Paged rather than capped: an absence from this set is what gets reported to a
 * returning person as lost work, and a 200-item page boundary is not evidence
 * of absence. The walk stops as soon as every wanted id is accounted for.
 */
async function findPresentSessions(
  library: SessionLibrary,
  wanted: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  const present = new Set<string>();
  if (wanted.size === 0) return present;
  let page = await library.list({ sort: "updated-desc", limit: 200 }, signal);
  for (;;) {
    for (const item of page.items) if (wanted.has(item.id)) present.add(item.id);
    const next = page.offset + page.items.length;
    if (signal.aborted || present.size === wanted.size || page.items.length === 0 || next >= page.total) break;
    page = await library.list({ sort: "updated-desc", limit: page.limit, offset: next }, signal);
  }
  return present;
}

/** `localStorage`, or nothing where a private mode refuses it. */
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
    durableEventCount: item.headSequence,
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

/**
 * Tab-scoped marker for a conversation address this page wrote into the URL.
 *
 * Namespaced so it cannot collide with the draft keys that share this storage,
 * and short-lived by nature: session storage dies with the tab.
 */
const MINTED_ADDRESS_PREFIX = "airship.minted-chat-address.v1:";

/**
 * How long the resume verdict may stay undecided before the address is answered
 * on whatever evidence exists. Measured Local Device adoption on this build
 * completes in 1.1–2.4 s from first paint; this is the ceiling that keeps a
 * backend which never reports from holding a bookmark open forever.
 */
const RESUME_SETTLE_CEILING_MS = 8_000;

/**
 * The encrypted copy costs an authenticated envelope write, so it settles on a
 * slower clock than the tab copy. A composer left mid-sentence is idle for far
 * longer than this before a tab is closed.
 */
const DRAFT_DURABLE_PERSIST_MS = 700;

export function App() {
  const [view, setView] = useState<View>(() => readViewHash());
  const accessReconnectIntent = view === "access" && typeof window !== "undefined"
    ? parseAccessReconnectIntent(window.location.hash)
    : undefined;
  const [online, setOnline] = useState(() => readOnlineState(
    typeof navigator === "undefined" ? undefined : navigator,
  ));
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [narrowComposer, setNarrowComposer] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const deferredOverlayOpener = useRef<HTMLElement>();
  const deferredOverlayFocusReturn = useRef<number>();
  const requestDeferredOverlay = (target?: DeferredOverlayName): void => {
    if (deferredOverlayFocusReturn.current) {
      cancelAnimationFrame(deferredOverlayFocusReturn.current);
    }
    if (target) {
      const opener = deferredOverlayOpenerCandidate(document.activeElement);
      if (opener) deferredOverlayOpener.current = opener;
    } else {
      const opener = deferredOverlayOpener.current;
      deferredOverlayFocusReturn.current = requestAnimationFrame(() => {
        (opener?.isConnected ? opener : textarea.current ?? mainRegion.current)?.focus({ preventScroll: true });
      });
    }
    setPaletteOpen(target === "Command Center");
    setPreferencesOpen(target === "Preferences");
    setShortcutsOpen(target === "Keyboard shortcuts");
  };
  /** Whether the composer's queue is showing its whole backlog. See `.composer-queue`. */
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
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
  /*
   * The conversation you are standing in goes last.
   *
   * The library is sorted by recency, so the active thread is always its first
   * row — and the palette's first row with an empty query is what `⌘K ↵` runs.
   * Leading with "reopen the conversation already on screen" is the one answer
   * that cannot be the one asked for. It stays listed and stays searchable by
   * its own title; it just does not win the default.
   */
  const paletteSessions = useMemo(() => Object.freeze([
    ...recentPaletteSessions.filter((session) => session.id !== sessionId),
    ...recentPaletteSessions.filter((session) => session.id === sessionId),
  ]), [recentPaletteSessions, sessionId]);
  const [recentProfileConversations, setRecentProfileConversations] = useState<readonly RecentConversation[]>([]);
  const recentDurableEventCount = recentProfileConversations.reduce(
    (total, conversation) => total + conversation.durableEventCount,
    0,
  );
  // A bump, not a boolean: the palette's "Rename conversation" verb has to be
  // able to ask twice in a row, and the editor that answers it lives in the
  // session bar. See `paletteActions`.
  const [renameRequest, setRenameRequest] = useState(0);
  const [gitClient, setGitClient] = useState<BrowserGitClient>();
  const [messages, setMessages] = useState<UiMessage[]>([welcomeMessage]);
  const [unreadTurnCount, setUnreadTurnCount] = useState(0);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [composerNotice, setComposerNotice] = useState<string>();
  /*
   * The compression gate before an in-place model switch. When the chosen
   * model's context window is smaller than what this conversation already
   * uses, the switch waits behind this dialog: the consequence is stated
   * before it happens, and "keep the current model" is the way back.
   */
  const [pendingModelSwitch, setPendingModelSwitch] = useState<Readonly<{
    modelLabel: string;
    usedTokens: number;
    windowTokens: number;
    proceed: () => Promise<void>;
  }> | undefined>(undefined);
  /*
   * The compression gate's modal loads on first ask rather than statically
   * from app.tsx — it is a rare, deliberate gesture, and statically sharing
   * this component with the entry chunk previously double-classified
   * workspace-view.css into the entry's single allowed stylesheet (solved: one
   * static .css import may serve the entry alone).
   */
  const [ConfirmDialogComp, setConfirmDialogComp] = useState<typeof import("./confirm-dialog")>();
  useEffect(() => {
    if (!pendingModelSwitch || ConfirmDialogComp) return;
    let live = true;
    void import("./confirm-dialog").then((module) => {
      if (live) setConfirmDialogComp(module);
    });
    return () => { live = false; };
  }, [pendingModelSwitch, ConfirmDialogComp]);
  const [messageQueue, setMessageQueue] = useState<readonly QueuedComposerItem[]>([]);
  /*
   * Stop has to mean stop. `busy` alone cannot say why a turn ended: the
   * teardown that follows a completed turn and the teardown that follows an
   * abort both clear this conversation's busy entry, so the effect below
   * read a user's Stop as "the model is free, send the next one" and fired the
   * queue's head immediately. The latch is session-scoped: switching away and
   * back must not reinterpret Stop as permission to send, and two conversations
   * may each hold a stopped queue. Only an explicit send in that conversation
   * clears its entry.
   */
  const [pausedQueueSessionIds, setPausedQueueSessionIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const queuePaused = Boolean(sessionId && pausedQueueSessionIds.has(sessionId));
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
  /*
   * Turns run per conversation, not per page.
   *
   * `busy` was one boolean and `activeTurn` one controller, so the product
   * could hold exactly one turn at a time no matter how many threads were
   * open: sending in a second conversation was refused outright, and the
   * shared approval delegate meant two turns could not have been reviewed
   * under their own conversations' modes even if they had been allowed to run.
   *
   * The set is the whole change. `busy` below is still *this* conversation's
   * answer to "is a turn running here", so every reference that asks about the
   * composer, the queue, Stop, or a destructive action keeps meaning exactly
   * what it meant. `anyTurnRunning` is for the few places that mean "anywhere"
   * — the page's own unload guard, and the transitions that invalidate every
   * running turn at once.
   */
  const [busySessions, setBusySessions] = useState<ReadonlySet<string>>(() => new Set<string>());
  function setSessionBusy(id: string, running: boolean): void {
    setBusySessions((current) => {
      if (running === current.has(id)) return current;
      const next = new Set(current);
      if (running) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const busy = sessionId !== undefined && busySessions.has(sessionId);
  const anyTurnRunning = busySessions.size > 0;
  const [runtimeStatus, setRuntimeLine] = useState("Starting local kernel");
  const [bootFailure, setBootFailure] = useState<string>();
  /**
   * The turn's own spoken channel, and the shell line's stand-down.
   *
   * The topbar runtime line is mirrored into a polite region, and at turn end
   * it was setting "Local kernel ready" in the same animation frame the arrival
   * sentence landed — two polite regions, one frame, and the reader hears
   * whichever the screen reader picks. The visible line is unchanged; while the
   * turn narrator is speaking, the *mirror* stands down, because a sentence
   * about the kernel is not news about the turn.
   */
  const turnNarration = useTurnNarration();
  const [runtimeAnnouncement, setRuntimeAnnouncement] = useState("Starting local kernel");
  function setRuntimeStatus(next: string | ((current: string) => string)): void {
    setRuntimeLine(next);
    if (turnNarration.holdsChannel()) return;
    setRuntimeAnnouncement(next);
  }
  function narrateTurn(utterance: string): void {
    turnNarration.narrate(utterance);
  }
  const [eventCount, setEventCount] = useState(0);
  const railDurableEventCount = recentProfileConversations.length > 0
    ? recentDurableEventCount
    : eventCount;
  const [modelSwitching, setModelSwitching] = useState(false);
  const [sessionLifecycle, setSessionLifecycle] = useState<SessionLifecycle>(READY_SESSION_LIFECYCLE);
  const [transcriptBoundary, setTranscriptBoundary] = useState<Readonly<{
    omittedMessages: number;
    shortened: boolean;
  }>>();
  const [transcriptLeadingHeight, setTranscriptLeadingHeight] = useState(0);
  const [transcriptDetached, setTranscriptDetached] = useState(false);
  const [stageScrolled, setStageScrolled] = useState(false);
  const [credentialRevision, setCredentialRevision] = useState(0);
  /** Re-runs the automatic vault adoptions once a cockpit transition has settled. */
  const [cockpitSettleRetry, setCockpitSettleRetry] = useState(0);
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
  const [capabilitiesViewError, setCapabilitiesViewError] = useState<string>();
  const [MemoryScreen, setMemoryScreen] = useState<MemoryScreenComponent>();
  const [memoryViewError, setMemoryViewError] = useState<string>();
  const [SkillsScreen, setSkillsScreen] = useState<SkillsScreenComponent>();
  const [skillsViewError, setSkillsViewError] = useState<string>();
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
  const [ProviderConnectionsScreen, setProviderConnectionsScreen] = useState<ProviderConnectionsScreenComponent>();
  const [providerFabricError, setProviderFabricError] = useState<string>();
  /** The active Profile's information density, shared by every presentation gate. */
  const appDensity = usePresentationDensity();
  /** A "Return to this turn" waiting for its conversation's transcript. */
  const [pendingTranscriptReturn, setPendingTranscriptReturn] = useState<Readonly<{ sessionId: string; turnId: string }>>();
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
  const inferenceRouteChanging = useRef(false);
  const approvalBroker = useMemo(() => new ApprovalBroker(), []);
  /**
   * A conversation can be opened while its predecessor is still answering.
   * Keep the answering session's policy authority separate from the session
   * currently on screen: replacing the shared delegate on navigation would
   * make the old turn's next tool call run under the new conversation's mode.
  */
  const sessionResumeDuringTurn = useRef<string>();
  const [liveApprovalMode, setLiveApprovalMode] = useState<Readonly<{
    sessionId: string;
    mode: ApprovalMode;
  }>>();
  const transcriptStreams = useMemo(() => new TranscriptStreamStore(), []);
  /* Reasoning gets its own slot store rather than sharing the transcript's:
     the two stream concurrently within a step, and one store keyed by message
     id cannot hold both without interleaving them into the same string. */
  const reasoningStreams = useMemo(() => new TranscriptStreamStore(), []);
  /** A conversation pin wins over global preferences; historical sessions stay semantically intact. */
  const pinnedApprovalMode = activeSessionRecord?.approvalModeOverride
    ?? (activeSessionRecord?.manifest.profile?.version === 2
      ? activeSessionRecord.manifest.profile.approvalMode
      : preferences.approvalMode);
  const activeApprovalMode = liveApprovalMode && liveApprovalMode.sessionId === activeSessionRecord?.id
    ? liveApprovalMode.mode
    : pinnedApprovalMode;
  const approvalModePolicies = useMemo(() => Object.freeze({
    "ask-first": createApprovalModePolicy({ mode: "ask-first", broker: approvalBroker }),
    "auto-approve": createApprovalModePolicy({ mode: "auto-approve", broker: approvalBroker }),
    "full-access": createApprovalModePolicy({ mode: "full-access", broker: approvalBroker }),
  }), [approvalBroker]);
  const approvalModePolicy = approvalModePolicies[activeApprovalMode];
  /*
   * One switchable delegate per conversation, and this is the half of
   * concurrency that could not have been faked.
   *
   * There used to be a single controller for the page, which meant the mode a
   * tool was reviewed under was whichever conversation happened to be on
   * screen. With one turn at a time that was survivable — the guard above
   * froze the delegate whenever the running turn was not the visible one. With
   * two turns running it is not survivable at all: a thread pinned to
   * ask-first and a thread pinned to full-access would have shared one
   * adjudicator, and the answer to "who approved this, under what mode" would
   * have depended on which tab of the rail was open. Approval provenance is
   * per conversation because the pin is.
   *
   * Created on demand and kept for the life of the page: a conversation's
   * controller has to be the same object across its turns, because a turn in
   * flight is holding a reference to it.
   */
  const approvalPolicyControllers = useRef(new Map<string, SwitchableApprovalPolicy>());
  function sessionApprovalPolicy(id: string): SwitchableApprovalPolicy {
    const existing = approvalPolicyControllers.current.get(id);
    if (existing) return existing;
    const created = new SwitchableApprovalPolicy(approvalModePolicy);
    approvalPolicyControllers.current.set(id, created);
    return created;
  }
  /*
   * Only the visible conversation's delegate follows `activeApprovalMode` —
   * that value *is* the visible conversation's pinned-or-global mode, so
   * pushing it into a background thread's controller would re-mode a turn
   * nobody was looking at. A background turn keeps the delegate it was
   * admitted with until its own conversation is on screen again.
   */
  if (sessionId) sessionApprovalPolicy(sessionId).replace(approvalModePolicy);
  const approvalPolicy = sessionId ? sessionApprovalPolicy(sessionId) : undefined;
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
  /* Per conversation for the same reason, and by the same rule. */
  const localCommandPolicyControllers = useRef(new Map<string, SwitchableApprovalPolicy>());
  function sessionLocalCommandPolicy(id: string): SwitchableApprovalPolicy {
    const existing = localCommandPolicyControllers.current.get(id);
    if (existing) return existing;
    const created = new SwitchableApprovalPolicy(humanIntentModePolicy);
    localCommandPolicyControllers.current.set(id, created);
    return created;
  }
  if (sessionId) sessionLocalCommandPolicy(sessionId).replace(humanIntentModePolicy);
  const localCommandPolicy = sessionId ? sessionLocalCommandPolicy(sessionId) : undefined;
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
  const [vaultWipeBusy, setVaultWipeBusy] = useState(false);
  const [vaultReclaimBusy, setVaultReclaimBusy] = useState(false);
  const [localDeviceBusy, setLocalDeviceBusy] = useState(false);
  const localDeviceAutoOpenOwner = useRef(0);
  const [localDeviceError, setLocalDeviceError] = useState<string>();
  /**
   * Whether the durability posture this browser profile is configured for has
   * finished trying to load.
   *
   * The Atlas measured Airship reopening instead of resuming: on a reload with
   * the Local Device Vault active, the page-memory runtime boots first, the
   * `#chat/<id>` in the address bar resolves against a journal the Vault has not
   * been adopted into yet, and the shell declares the conversation destroyed —
   * "That conversation existed only in page memory and did not survive the
   * reload" — one second before it restores that exact conversation and calls it
   * "audited session resumed". The same race is what destroys the composer
   * draft: the verdict re-keys the composer to the throwaway conversation the
   * boot minted, and the real conversation then arrives and hydrates its empty
   * draft over the text.
   *
   * So the route resolution waits for one declared answer. Every automatic
   * adoption path settles this exactly once — adopted, refused, or not
   * configured — and until then Airship says nothing about any address.
   */
  const [durableAuthoritySettled, setDurableAuthoritySettled] = useState(false);
  /**
   * The one resume verdict, read by the route resolver and the return report.
   *
   * Declared here rather than beside the other vault derivations further down
   * because the effect that resolves `#chat/<id>` runs before them, and the
   * whole point is that no surface may answer for an address before this does.
   * `vaultRuntimeAdopted` below asks the same question of the presented adoption status
   * state and is what every visible claim reads; this one asks it of the
   * runtime this render is actually writing through, which is the fact the
   * draft store and the ledger posture need.
   */
  const durableAuthorityAdopted = runtime.current?.storageId.startsWith("vault+") === true;
  /*
   * Deliberately not `durableAuthorityAdopted`. Adoption publishes the runtime
   * ref several awaits before it publishes the journal, and Preact flushes a
   * render inside those awaits — so there is a window in which the storage is
   * the Vault's and `sessionLibrary` is still the page-memory one that cannot
   * possibly hold the address. Resolving in that window is what moved an unsent
   * draft onto a throwaway conversation on one reload in two. The explicit flag
   * is set after the adoption has published everything.
   */
  const resumeAuthoritySettled = durableAuthoritySettled
    // Ephemeral is a decision, not a wait: nothing durable is coming.
    || preferences.vaultBackend === "ephemeral"
    // A cloud backend that is not configured in this tab is waiting on a person
    // (Drive's consent gesture) or on a service that answered "not here"
    // (the loopback lab). Neither arrives on its own, so the address may be
    // answered now rather than held open forever.
    || ((preferences.vaultBackend === "google-drive" || preferences.vaultBackend === "local-lab")
      && (vaultSnapshot.phase === "disconnected" || vaultSnapshot.phase === "degraded"));
  /**
   * Work this browser profile held that the journal did not give back.
   *
   * Held in state rather than read from storage at render time so a dismissal
   * is felt immediately and the reconciliation runs exactly once per boot.
   */
  const [unrecoveredWork, setUnrecoveredWork] = useState<UnrecoveredWork>();
  /*
   * The lost-work report is fetched when there is lost work to report.
   *
   * It renders for a returning person whose previous session did not survive —
   * the rarest state this surface has — and importing it statically put it, and
   * its stylesheet, in the entry chunk. That chunk is first paint, it had
   * 0.53 KiB of gzip headroom, and this cost 1.82 KiB of it: the release gate
   * refused the build at 115.00 KiB against a 112.00 KiB ceiling. Every other
   * rare surface in this file is already fetched on demand; this is the same
   * pattern, applied to the one that pays the highest rent.
   */
  const [ResumeReportView, setResumeReportView] = useState<(props: ResumeReportProps) => VNode>();
  /*
   * The two overlays that are never on screen at first paint.
   *
   * They lived in `platform-shell.tsx`, which the boot path imports for its
   * hooks, so 195 lines of dialog JSX shipped in the entry chunk to be rendered
   * by nobody. Entry gzip had 20 bytes under its 112 KiB ceiling and then
   * breached it at 112.01 — and a budget a symbol rename can breach is not a
   * budget. Split out, then warmed on idle after first paint, so the chunk is
   * in cache long before anyone presses Cmd+K and the ceiling gets a real
   * margin back instead of a raise.
  */
  const [Overlays, setOverlays] = useState<typeof import("./platform-overlays")>();
  const requestedDeferredOverlay: DeferredOverlayName | undefined = preferencesOpen
    ? "Preferences"
    : paletteOpen
      ? "Command Center"
      : shortcutsOpen
        ? "Keyboard shortcuts"
        : undefined;
  const requestedDeferredOverlayRef = useRef<DeferredOverlayName>();
  requestedDeferredOverlayRef.current = requestedDeferredOverlay;
  const [deferredOverlayFailure, setDeferredOverlayFailure] = useState<DeferredOverlayName>();
  const [platformOverlaysLoading, setPlatformOverlaysLoading] = useState(false);
  const [shortcutSheetLoading, setShortcutSheetLoading] = useState(false);
  const [deferredOverlayRetryStarted, setDeferredOverlayRetryStarted] = useState(false);
  const platformOverlaysReady = useRef(false);
  const platformOverlaysLoad = useRef<Promise<void>>();
  const deferredOverlayOwnerLive = useRef(true);
  const beginPlatformOverlaysLoad = useCallback((): void => {
    const opener = deferredOverlayOpenerCandidate(document.activeElement);
    if (requestedDeferredOverlayRef.current && opener) deferredOverlayOpener.current = opener;
    if (platformOverlaysReady.current || platformOverlaysLoad.current) return;
    if (deferredOverlayOwnerLive.current) setPlatformOverlaysLoading(true);
    const attempt = loadPlatformOverlays()
      .then((module) => {
        platformOverlaysReady.current = true;
        if (!deferredOverlayOwnerLive.current) return;
        const requested = requestedDeferredOverlayRef.current;
        if (
          (requested === "Command Center" || requested === "Preferences")
          && deferredOverlayOpener.current?.isConnected
        ) {
          deferredOverlayOpener.current.focus({ preventScroll: true });
        }
        if (!requested) deferredOverlayOpener.current = undefined;
        setOverlays(module);
        setDeferredOverlayFailure(undefined);
        setDeferredOverlayRetryStarted(false);
      })
      .catch(() => {
        // Publish retry only after the failed attempt releases admission. React
        // may render the recovery action before the promise's `finally` runs.
        if (platformOverlaysLoad.current === attempt) platformOverlaysLoad.current = undefined;
        const requested = requestedDeferredOverlayRef.current;
        if (!deferredOverlayOwnerLive.current || (requested !== "Command Center" && requested !== "Preferences")) return;
        requestDeferredOverlay();
        setDeferredOverlayFailure(requested);
        setRuntimeLine(`${requested} could not be loaded. The shell remains available.`);
      });
    platformOverlaysLoad.current = attempt;
    void attempt.finally(() => {
      if (platformOverlaysLoad.current === attempt) platformOverlaysLoad.current = undefined;
      if (deferredOverlayOwnerLive.current) setPlatformOverlaysLoading(false);
    });
  }, []);
  /* The same deferred chunk carries the quarantine card, so the two return
     states of this surface cost one fetch and one stylesheet between them. */
  const [QuarantineReportView, setQuarantineReportView] = useState<(props: QuarantineReportProps) => VNode>();
  /** Which conversation `#sessions` should open on, when the shell sends you. */
  const [sessionsFocusId, setSessionsFocusId] = useState<string>();
  /* Mounted as soon as a broker exists, so the dock is resident before the
     first request rather than fetched while someone waits on a decision.

     Readiness is separate from the component value because a broker request can
     arrive between the chunk resolving and Preact committing the next render.
     The gate may become modal only when the dialog code is already resident. */
  const [ApprovalDockView, setApprovalDockView] = useState<(props: { broker: typeof approvalBroker }) => VNode>();
  const [approvalDockLoadFailed, setApprovalDockLoadFailed] = useState(false);
  const [approvalDockLoading, setApprovalDockLoading] = useState(false);
  const [approvalDockRetryStarted, setApprovalDockRetryStarted] = useState(false);
  const [approvalDockBlockedRequests, setApprovalDockBlockedRequests] = useState(0);
  const [approvalDockWaitingRequests, setApprovalDockWaitingRequests] = useState(0);
  const [approvalDockFailurePositionReady, setApprovalDockFailurePositionReady] = useState(false);
  const approvalDockReady = useRef(false);
  const approvalDockUnavailable = useRef(false);
  const approvalDockSettlingFailure = useRef(false);
  const approvalDockLoad = useRef<Promise<void>>();
  const approvalDockOwnerLive = useRef(true);
  const approvalDockRetryNeedsFocusReturn = useRef(false);
  const denyPendingForUnavailableDock = useCallback((pendingCount: number): void => {
    if (pendingCount === 0 || approvalDockSettlingFailure.current) return;
    approvalDockSettlingFailure.current = true;
    try {
      approvalBroker.denyAll();
    } finally {
      approvalDockSettlingFailure.current = false;
    }
    if (approvalDockOwnerLive.current) {
      setApprovalDockBlockedRequests((count) => count + pendingCount);
    }
  }, [approvalBroker]);
  const beginApprovalDockLoad = useCallback((): void => {
    if (approvalDockReady.current || approvalDockLoad.current) return;
    approvalDockUnavailable.current = false;
    if (approvalDockOwnerLive.current) setApprovalDockLoading(true);
    const attempt = loadApprovalDock()
      .then((module) => {
        approvalDockReady.current = true;
        approvalDockUnavailable.current = false;
        if (!approvalDockOwnerLive.current) return;
        const pendingCount = approvalBroker.snapshot().pending.length;
        setApprovalDockView(() => module.ApprovalDock);
        setApprovalDockLoadFailed(false);
        setApprovalDockRetryStarted(false);
        setApprovalDockBlockedRequests(0);
        setApprovalDockWaitingRequests(0);
        // State updates above commit together. The shell becomes inert in the
        // same render that mounts the dialog, never one render before it.
        setApprovalPending(pendingCount > 0);
        if (pendingCount === 0 && approvalDockRetryNeedsFocusReturn.current) {
          approvalDockRetryNeedsFocusReturn.current = false;
          requestAnimationFrame(() => {
            (textarea.current ?? mainRegion.current)?.focus({ preventScroll: true });
          });
        }
      })
      .catch(() => {
        // A visible Retry must be able to start a new import immediately.
        if (approvalDockLoad.current === attempt) approvalDockLoad.current = undefined;
        approvalDockReady.current = false;
        approvalDockUnavailable.current = true;
        const pendingCount = approvalBroker.snapshot().pending.length;
        denyPendingForUnavailableDock(pendingCount);
        if (!approvalDockOwnerLive.current) return;
        setApprovalDockWaitingRequests(0);
        setApprovalPending(false);
        setApprovalDockLoadFailed(true);
      });
    approvalDockLoad.current = attempt;
    void attempt.finally(() => {
      if (approvalDockLoad.current === attempt) approvalDockLoad.current = undefined;
      if (approvalDockOwnerLive.current) setApprovalDockLoading(false);
    });
  }, [approvalBroker, denyPendingForUnavailableDock]);
  const [ShortcutSheetView, setShortcutSheetView] = useState<(props: {
    open: boolean;
    profiles?: readonly Readonly<{ name: string }>[];
    onClose(): void;
  }) => VNode | null>();
  useEffect(() => {
    approvalDockOwnerLive.current = true;
    beginApprovalDockLoad();
    warmMessageParts();
    warmAgentRuntimeStatus();
    return () => { approvalDockOwnerLive.current = false; };
  }, [beginApprovalDockLoad]);
  /* Same deferral, same reason: a sheet nobody has asked for yet is not
     first-paint JavaScript. Fetched the first time `?` (or the palette's own
     footer row) asks for it, and resident from then on. */
  useEffect(() => {
    deferredOverlayOwnerLive.current = true;
    return () => { deferredOverlayOwnerLive.current = false; };
  }, []);
  useEffect(() => {
    if ((requestedDeferredOverlay !== "Command Center" && requestedDeferredOverlay !== "Preferences") || Overlays) return;
    beginPlatformOverlaysLoad();
  }, [requestedDeferredOverlay, Overlays, beginPlatformOverlaysLoad]);
  useEffect(() => {
    if (!shortcutsOpen || ShortcutSheetView) return;
    let live = true;
    const opener = deferredOverlayOpenerCandidate(document.activeElement);
    if (opener) deferredOverlayOpener.current = opener;
    setShortcutSheetLoading(true);
    void loadKeyboardShortcutsSheet()
      .then((module) => {
        if (!live) return;
        setShortcutSheetView(() => module.KeyboardShortcutsSheet);
        setDeferredOverlayFailure(undefined);
        setDeferredOverlayRetryStarted(false);
      })
      .catch(() => {
        if (!live) return;
        requestDeferredOverlay();
        setDeferredOverlayFailure("Keyboard shortcuts");
        setRuntimeLine("Keyboard shortcuts could not be loaded. The shell remains available.");
      })
      .finally(() => { if (live) setShortcutSheetLoading(false); });
    return () => { live = false; };
  }, [shortcutsOpen, ShortcutSheetView]);
  useEffect(() => {
    if ((!unrecoveredWork && !quarantinedSession) || ResumeReportView) return;
    let live = true;
    void import("./chat/resume-report").then((module) => {
      if (!live) return;
      setResumeReportView(() => module.ResumeReport);
      setQuarantineReportView(() => module.QuarantineReport);
    });
    return () => { live = false; };
  }, [ResumeReportView, unrecoveredWork, quarantinedSession]);
  /** The journal the ledger has already been reconciled against. */
  const returnLedgerReconciled = useRef<SessionLibrary>();
  /**
   * Identifies this page session in the return ledger.
   *
   * A conversation that leaves the journal while its own page is still open was
   * deleted; only an absence that outlived the page that wrote it is a
   * returning person's lost work, and this is how the two are told apart.
   */
  const pageSessionToken = useRef(randomUuid());
  /** Addresses the reconciliation has already accounted for, so the composer
   *  notice does not restate a loss the report states better. */
  const reportedLostAddresses = useRef(new Set<string>());
  /** The address the loss notice was raised about, so it can be withdrawn if
   *  that conversation turns up after all. */
  const lossNoticeAddress = useRef<string>();
  /**
   * Turns, not rows: the conversation seed and the journal markers are chrome
   * and records, not work. A conversation whose count is zero has nothing to
   * mourn and never enters the ledger, which is what keeps a first-ever visit
   * from being told it lost something.
   */
  const recordedTranscriptSize = useMemo(
    () => messages.reduce((total, message) => total + (message.seed || message.marker ? 0 : 1), 0),
    [messages],
  );
  const [driveReauthorizing, setDriveReauthorizing] = useState(false);
  const driveReauthorizingRef = useRef(false);
  const [vaultContextPublishing, setVaultContextPublishing] = useState(false);
  const [vaultContextPublicationMessage, setVaultContextPublicationMessage] = useState<string>();
  const vaultContextPublication = useRef<AbortController>();
  const [activeExternalRoute, setActiveExternalRoute] = useState<ActivatedInferenceRoute>();
  const activeExternalRouteRef = useRef<ActivatedInferenceRoute>();
  const inferenceFabric = useRef<BrowserInferenceFabric>();
  const [providerFabricRevision, setProviderFabricRevision] = useState(0);
  const providerAvailabilityTool = useRef<InspectInferenceConnectionsTool>();
  /**
   * Every running turn, by the conversation that owns it. A conversation holds
   * at most one — the immutable session head admits one writer — but the page
   * holds as many as there are conversations with work in flight.
   */
  const activeTurns = useRef(new Map<string, AbortController>());
  /** The prompt each running turn was admitted with, for Stop's restore. */
  const activePrompts = useRef(new Map<string, string>());

  /**
   * Abort every running turn. For the transitions that invalidate all of them
   * at once — the inference route, the model, the credential, the workspace's
   * durability — where the old single-controller call was already reaching for
   * "the turn" and now has to mean all of them.
   */
  function abortAllTurns(reason?: DOMException): void {
    for (const controller of [...activeTurns.current.values()]) controller.abort(reason);
  }

  /** Abort one conversation's turn, if it has one. */
  function abortSessionTurn(id: string | undefined, reason?: DOMException): void {
    if (id) activeTurns.current.get(id)?.abort(reason);
  }

  const localCommandAdmission = useRef(false);
  const activeSessionIdentity = useRef<string>();
  const activeSessionByProfile = useRef(new Map<string, string>());
  const pendingSessionResume = useRef<Readonly<{
    run(): Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  }>>();
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
    webEgress: "node-first" | "browser-only";
  webBodies: "any" | "text-only";
    contextMode: Runtime["contextMode"];
  }>>());
  const queuedMessagesBySession = useRef(new Map<string, readonly QueuedComposerItem[]>());
  const queuedDispatch = useRef(false);
  const draftHydrationIdentity = useRef<string>();
  /** The conversation whose encrypted draft has been read back, and is therefore
   *  safe to write over. See the durable hydration effect. */
  const durableDraftIdentity = useRef<string>();
  const preserveComposerForDraftIdentity = useRef<string>();
  const pendingForkRetry = useRef<Readonly<{
    sessionId: string;
    profileId: string;
    runtime: Runtime;
    prompt: string;
    attachments: readonly ComposerAttachment[];
  }>>();
  const chatRouteOpening = useRef<string>();
  /*
   * Conversation addresses this page wrote into the URL itself.
   *
   * The first visit to a static host loads the document twice: the service
   * worker takes control, `controllerchange` fires, and the shell reloads so
   * COOP/COEP are established before anyone starts working. That reload is
   * deliberate and only ever happens before a person has interacted.
   *
   * The composer canonicalises `#chat/<id>` as soon as a conversation exists,
   * so the pre-reload address survives in the URL while the page-memory
   * conversation it names does not. The reader then met, on the first screen
   * they had ever seen, "That conversation existed only in page memory and did
   * not survive the reload." — a report of lost work addressed to someone who
   * had not yet done any. Measured on a never-visited namespace: five
   * main-frame navigations, two distinct session ids, and that sentence.
   *
   * The sentence is right for the case it was written for — a bookmark, a link,
   * a back button reaching a conversation that page memory could not keep. It
   * is wrong for an address this page minted seconds earlier. So the addresses
   * are remembered, and only the ones that came from somewhere else are
   * reported as lost.
   *
   * Tab storage, not a ref: the reload replaces the document, so a ref is empty
   * in exactly the case this exists for. Tab scope is also the right boundary —
   * the same bookmark opened in a NEW tab did come from somewhere else, and
   * still gets told.
   *
   * And the markers are dropped the moment a person touches the page. The boot
   * reload only ever fires before an interaction (`platform-shell` holds a page
   * that observed a gesture and offers it the reload instead), so an address
   * minted before anyone typed cannot have carried work — while an address in a
   * tab someone HAS worked in can, and that reader is owed the sentence. This
   * is the difference between "Airship reloaded itself during boot" and "your
   * draft was in a conversation page memory could not keep".
   */
  const rememberMintedAddress = (id: string): void => {
    try {
      sessionStorage.setItem(`${MINTED_ADDRESS_PREFIX}${id}`, "1");
    } catch {
      // A private mode without session storage keeps the previous behaviour.
    }
  };
  const addressWasMintedHere = (id: string): boolean => {
    try {
      return sessionStorage.getItem(`${MINTED_ADDRESS_PREFIX}${id}`) !== null;
    } catch {
      return false;
    }
  };
  const forgetMintedAddresses = (): void => {
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith(MINTED_ADDRESS_PREFIX)) sessionStorage.removeItem(key);
      }
    } catch {
      // Nothing to forget without session storage.
    }
  };
  useEffect(() => {
    const events = ["pointerdown", "keydown"] as const;
    events.forEach((type) => window.addEventListener(type, forgetMintedAddresses, { capture: true, once: true }));
    return () => events.forEach((type) => window.removeEventListener(type, forgetMintedAddresses, { capture: true }));
  }, []);
  /*
   * A liveness floor under the resume verdict, not a source of it.
   *
   * Every automatic adoption path settles the verdict itself, in a `finally` or
   * on each terminal branch. This exists for the case none of them reach — a
   * backend whose preconditions never assemble — because the failure mode of
   * waiting forever is a bookmark that never opens and a person with no
   * explanation at all. It can only ever release a wait; it never claims a
   * conversation was lost, which remains the resolver's decision on the
   * evidence it has by then.
   */
  useEffect(() => {
    const ceiling = window.setTimeout(() => setDurableAuthoritySettled(true), RESUME_SETTLE_CEILING_MS);
    return () => window.clearTimeout(ceiling);
  }, []);
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
  const pendingReasoning = useRef<{ messageId: string; text: string }>();
  const pendingReasoningFrame = useRef<number>();
  /**
   * The running turn's row, addressed as the journal addresses it.
   *
   * Held outside `messages` because `messages` belongs to whichever
   * conversation is on screen and is replaced wholesale when another one
   * opens. This is what lets the reattach effect find the re-projected row
   * and mark it live again after a switch away and back; it is set when the
   * journal issues the turn its id and cleared when the turn settles.
   */
  const liveTurnRow = useRef<{ sessionId: string; messageId: string; status: string }>();
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
   * Browsing the corpus, on the same read path the agent's own recall uses.
   *
   * `recall_memory` with no query is already a browse — newest first, scoped to
   * the session's pinned profile by the tool itself — so the route lists
   * exactly what the agent can reach, and cannot invent a record the silo would
   * refuse. Identity is stable so the Memory route's effect does not re-read on
   * every render.
   */
  const recallMemoryRecords = useMemo(() => async (signal: AbortSignal): Promise<MemoryRecordPage> => {
    const active = runtime.current;
    const authoritySessionId = activeSessionIdentity.current ?? sessionId;
    if (!active || !authoritySessionId) throw new Error("The active accountable session is not ready.");
    const tool = active.tools.get("recall_memory");
    if (!tool || tool.definition.effect !== "read") throw new Error("Profile memory recall is not installed in this agent runtime.");
    const operationId = `memory-list-${randomUuid()}`;
    const response = await tool.execute({ limit: 50 }, {
      sessionId: authoritySessionId,
      turnId: operationId,
      operationId,
      signal,
    });
    if (response.isError) throw new Error(response.content || "The remembered records could not be read.");
    const records = JSON.parse(response.content) as MemoryRecordPage["records"];
    // The tool reports how many records the scope holds beyond this page, which
    // is the difference between "these are the records" and "these are 50 of
    // them" — a distinction the route has to be able to state.
    const metadata = response.metadata && typeof response.metadata === "object" && !Array.isArray(response.metadata)
      ? response.metadata
      : {};
    const count = (key: string): number | undefined => {
      const value = metadata[key];
      return typeof value === "number" ? value : undefined;
    };
    return Object.freeze({
      records: Object.freeze(records),
      total: count("total") ?? records.length,
      legacyQuarantined: count("legacyQuarantined") ?? 0,
    });
  }, [sessionId]);

  /*
   * Any platform overlay (command palette, preferences, mobile
   * "more" sheet, approval prompt, profile transition) makes the routed
   * surface inert — but inert does not stop a window-level keydown, so a `g`
   * chord could swap the route and push history invisibly behind the dialog.
   * The navigation-jump hook consults this gate before acting on a chord.
   * Rail buttons and overlay-owned navigation (palette entries, sheet
   * rows) call `navigatePrimary` directly and stay ungated.
   */
  const platformOverlayOpen = mobileMoreOpen
    || (paletteOpen && Boolean(Overlays))
    || (shortcutsOpen && Boolean(ShortcutSheetView))
    || (preferencesOpen && Boolean(Overlays))
    || approvalPending || Boolean(profileCockpitTransition);
  const platformOverlayOpenRef = useRef(platformOverlayOpen);
  platformOverlayOpenRef.current = platformOverlayOpen;

  useGlobalPaletteShortcut(() => requestDeferredOverlay(paletteOpen ? undefined : "Command Center"));
  useGlobalShortcutSheet(() => requestDeferredOverlay("Keyboard shortcuts"), () => !platformOverlayOpenRef.current);
  useGlobalNavigationJumps(
    navigatePrimary,
    () => !platformOverlayOpenRef.current,
    // `g 1`…`g 9`, in the order the profile menu and the shortcut sheet list
    // them. Out of range is silently nothing rather than a wrapped choice: a
    // chord that switches the *wrong* profile is worse than one that misses.
    (index) => {
      const target = catalog ? managedProfiles(catalog)[index] : undefined;
      if (target && target.profileId !== profileId) void requestProfileChange(target.profileId);
    },
  );
  useVisualViewport();
  useEffect(() => () => {
    for (const url of attachmentPreviewUrls.current) URL.revokeObjectURL(url);
    attachmentPreviewUrls.current.clear();
  }, []);
  const pwaUpdate = usePwaUpdate();
  const providerAvailability = useMemo(
    () => combinedInferenceAvailability(
      inferenceFabric.current?.availability(activeExternalRoute?.pin)
        ?? EMPTY_INFERENCE_AVAILABILITY,
      activeSessionRecord && runtime.current
        ? activeSessionRuntime(runtime.current, activeSessionRecord).inferenceBinding
        : runtime.current?.inferenceBinding,
    ),
    [providerFabricRevision, activeExternalRoute, activeSessionRecord],
  );

  const activeProfile = catalog?.profiles.find((profile) => profile.profileId === profileId);
  const activeProfileRef = useRef<ProfileRevision>();
  activeProfileRef.current = activeProfile;
  /*
   * Profile-level presentation becomes live here, with the profile that owns
   * it. The revision digest is the dependency — a saved preference *is* a new
   * revision — so switching profiles and saving preferences land through the
   * same frame, and no render ever applies one profile's display setting to
   * another's transcript.
   */
  useEffect(() => {
    setReasoningVisibility(parseReasoningVisibility(activeProfile?.presentation?.reasoningVisibility));
    setPresentationDensity(parsePresentationDensity(activeProfile?.presentation?.density));
  }, [activeProfile?.revision]);
  const activeTheme = activeProfile
    ? catalog?.themes.find((theme) => theme.themeId === activeProfile.theme.themeId && theme.digest === activeProfile.theme.digest)
    : undefined;
  /** True once the boot screen has been replaced by the real shell chrome. */
  const shellMounted = Boolean(catalog && activeProfile && activeTheme);
  const deferredOverlayRequestIsLoading = requestedDeferredOverlay === "Keyboard shortcuts"
    ? !ShortcutSheetView && shortcutSheetLoading
    : Boolean(requestedDeferredOverlay) && !Overlays && platformOverlaysLoading;
  const deferredOverlayNoticeActive = Boolean(deferredOverlayFailure) || deferredOverlayRequestIsLoading;
  const deferredOverlayNoticeFloor = useBottomFloor(deferredOverlayNoticeActive && shellMounted);
  const [deferredOverlayNoticePositionReady, setDeferredOverlayNoticePositionReady] = useState(false);
  const deferredOverlayRecoveryAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!deferredOverlayNoticeActive || !shellMounted) {
      setDeferredOverlayNoticePositionReady(false);
      return;
    }
    const frame = requestAnimationFrame(() => setDeferredOverlayNoticePositionReady(true));
    return () => cancelAnimationFrame(frame);
  }, [deferredOverlayNoticeActive, shellMounted]);
  useEffect(() => {
    if (!deferredOverlayFailure || !deferredOverlayNoticePositionReady) return;
    const frame = requestAnimationFrame(() => {
      deferredOverlayRecoveryAction.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [deferredOverlayFailure, deferredOverlayNoticePositionReady, deferredOverlayRetryStarted]);
  /* A boot-time chunk refusal predates the composer. Re-bind the shared bottom
     measurement when the shell appears, rather than observing an empty boot
     screen forever and leaving the banner over Send. */
  const approvalDockFailureVisible = approvalDockLoadFailed && activeApprovalMode !== "full-access";
  const approvalDockWaitingVisible = approvalDockWaitingRequests > 0
    && !approvalDockReady.current
    && !approvalDockUnavailable.current
    && activeApprovalMode !== "full-access";
  const approvalDockNoticeVisible = approvalDockFailureVisible || approvalDockWaitingVisible;
  const approvalDockFailureFloor = useBottomFloor(approvalDockNoticeVisible && shellMounted);
  useEffect(() => {
    if (!approvalDockNoticeVisible || !shellMounted) {
      setApprovalDockFailurePositionReady(false);
      return;
    }
    /*
     * `useBottomFloor` measures after this shell render. Do not paint a fixed
     * banner at its zero-value first frame: that is exactly the frame where it
     * would cover the composer's Send button. One animation frame lets the live
     * composer/mobile-nav measurement commit before the banner can receive a
     * pointer.
     */
    const frame = requestAnimationFrame(() => setApprovalDockFailurePositionReady(true));
    return () => cancelAnimationFrame(frame);
  }, [approvalDockNoticeVisible, shellMounted]);
  const activeInferenceBinding = activeSessionRecord && runtime.current
    ? activeSessionRuntime(runtime.current, activeSessionRecord).inferenceBinding
    : runtime.current?.inferenceBinding;
  const activeExternalResolution = activeExternalRoute && inferenceFabric.current
    ? inferenceFabric.current.resolve(activeExternalRoute.pin)
    : undefined;
  const pinnedExternalRoute = activeExternalRoute
    && activeInferenceBinding
    && inferenceBindingsMatch(activeInferenceBinding, coreInferenceBinding(activeExternalRoute))
      ? activeExternalRoute
      : undefined;
  const activeExternalConnection = pinnedExternalRoute
    && activeExternalResolution?.state === "ready"
      ? pinnedExternalRoute
      : undefined;
  /** Keep a connected catalog visible until one model owns a conversation. */
  const standbyExternalConnections = useMemo(
    () => activeExternalConnection || activeInferenceBinding
      ? Object.freeze([] as readonly BrowserInferenceConnection[])
      : Object.freeze(inferenceFabric.current?.list() ?? []),
    [activeExternalConnection, activeInferenceBinding, providerFabricRevision],
  );
  const standbyExternalModels = useMemo(
    () => Object.freeze(standbyExternalConnections.flatMap((entry) => entry.models.map((model) => ({
      id: externalModelSelectionId(entry.connection.id, model.id),
      label: standbyExternalConnections.length > 1
        ? `${entry.provider.label} · ${model.label}`
        : model.label,
      detail: externalModelCapabilityDetail(model),
      disabled: !chatModelCapable(model),
    })))),
    [standbyExternalConnections],
  );
  const standbyExternalProviderLabel = standbyExternalConnections.length === 1
    ? standbyExternalConnections[0]?.provider.label
    : standbyExternalConnections.length > 1 ? "Connected models" : undefined;
  const inferenceConnected = Boolean(activeExternalConnection);
  const activeExternalModel = activeExternalConnection?.models.find((model) =>
    model.id === activeInferenceBinding?.modelId
  );
  const inferenceStatusLabel = activeExternalConnection
    ? `${activeExternalConnection.pin.provider.label} · ${compactModelLabel(activeExternalModel?.label ?? activeExternalConnection.pin.model.id)}`
    : pinnedExternalRoute
      ? `${pinnedExternalRoute.pin.provider.label} · disconnected`
      : activeInferenceBinding
        ? `${activeInferenceBinding.providerLabel} · disconnected`
        : "Connect a model";
  const inferenceStatusDetail = activeExternalConnection
    ? `${activeExternalConnection.pin.model.id} · route checked · ${providerBoundaryLabel(activeExternalConnection.pin.provider.transportBoundary)}`
    : pinnedExternalRoute && activeExternalResolution && activeExternalResolution.state !== "ready"
      ? `${pinnedExternalRoute.pin.model.id} remains pinned to this conversation. ${activeExternalResolution.detail}`
      : activeInferenceBinding
        ? `${activeInferenceBinding.modelId} remains as a read-only pin. Reconnect its exact provider connection to continue.`
        : "Connect a cloud provider, Ollama, or LM Studio. Local slash commands remain available without inference.";
  const imageInputCapability = activeExternalModel
    ? providerModelCapability(activeExternalModel, "image-input")
    : "unsupported";
  const activeRemoteInference = activeInferenceBinding?.transportBoundary === "provider-tls";
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
  /*
   * The shell's verbs, reachable without menu archaeology.
   *
   * The words live in `./palette-actions`, fetched the first time the palette
   * opens: the entry chunk's first-paint budget does not move for feature work,
   * and nothing here paints before ⌘K. What stays in the shell is what only the
   * shell can answer — whether each verb can run right now, and what to run.
   */
  const [paletteActionsModule, setPaletteActionsModule] = useState<typeof import("./palette-actions")>();
  useEffect(() => {
    if (!paletteOpen || paletteActionsModule) return;
    let live = true;
    void import("./palette-actions").then((module) => { if (live) setPaletteActionsModule(() => module); });
    return () => { live = false; };
  }, [paletteOpen, paletteActionsModule]);
  const paletteActions = useMemo(() => {
    if (!paletteActionsModule) return undefined;
    const lastUser = [...messages].reverse().find((message) => message.role === "user" && message.sourcePoint);
    const lastAnswer = [...messages].reverse().find((message) => message.role === "assistant" && message.sourcePoint);
    const turnBusy = busy ? "Stop the active turn first." : undefined;
    const branchBlocked = turnBusy ?? (!sessionLibrary || !activeSessionRecord
      ? "Available once the local session journal is ready."
      : undefined);
    return paletteActionsModule.conversationPaletteActions({
      ...(turnBusy ? { newConversationBlocked: turnBusy, renameBlocked: turnBusy } : {}),
      ...(branchBlocked ?? !lastAnswer ? { retryBlocked: branchBlocked ?? "No answer in this conversation to retry yet." } : {}),
      ...(branchBlocked ?? !lastUser ? { editBranchBlocked: branchBlocked ?? "No prompt in this conversation to branch from yet." } : {}),
      ...(branchBlocked ?? !lastAnswer ? { forkBlocked: branchBlocked ?? "No message in this conversation to fork from yet." } : {}),
      onNewConversation: () => { navigate("chat"); void createConversation(); },
      onRename: () => { navigate("chat"); setRenameRequest((value) => value + 1); },
      onRetry: () => { if (lastAnswer) void forkFromMessage(lastAnswer, "retry"); },
      onEditBranch: () => { if (lastUser) void forkFromMessage(lastUser, "edit"); },
      onFork: () => { if (lastAnswer) void forkFromMessage(lastAnswer, "fork"); },
    });
  }, [paletteActionsModule, messages, busy, sessionLibrary, activeSessionRecord]);
  const paletteEntries = useMemo(() => buildPaletteEntries({
    navigate: navigatePrimary,
    openPreferences: () => requestDeferredOverlay("Preferences"),
    openShortcuts: () => requestDeferredOverlay("Keyboard shortcuts"),
    commands: slashRegistry?.descriptors(),
    ...(paletteActions ? { actions: paletteActions } : {}),
    sessions: paletteSessions,
    // The keyboard route to the thing a multi-profile person does most often.
    // The topbar control is the 24th tab stop; these rows and their `g 1`…`g 9`
    // chords are three keystrokes from the transcript.
    profiles: (catalog ? managedProfiles(catalog) : []).map((profile) => Object.freeze({
      profileId: profile.profileId,
      name: profile.name,
      ...(profile.description ? { description: profile.description } : {}),
      active: profile.profileId === profileId,
      switchTo: () => { void requestProfileChange(profile.profileId); },
    })),
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
  }), [slashRegistry, sessionId, paletteSessions, paletteActions, catalog, profileId]);
  // The rail's chord has a searchable twin: a shortcut nobody can discover is
  // a shortcut that does not exist, and the chevron is 700px away on a laptop.
  const paletteEntriesWithRail = useMemo(() => Object.freeze([
    ...paletteEntries,
    Object.freeze({
      id: "rail:toggle",
      label: railState === "standard" ? "Collapse navigation rail" : "Expand navigation rail",
      description: railState === "standard"
        // Not "labels on hover" any more: the pointer no longer opens the
        // collapsed rail, so what a person gets is icons plus every row's
        // `title`, and the labels back on the row the keyboard is standing on.
        ? "Icons only, labels on the row you focus · ⌘\\"
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
  /*
   * Land the "Return to this turn" once the transcript it names has rendered.
   *
   * Keyed on the message list because the conversation is usually still being
   * resumed when the route changes — running on navigation alone scrolled an
   * empty stage and reported success. The request is one-shot in every branch,
   * including the one where the transcript does not hold the turn: a control
   * that says it will return you and then leaves the screen unchanged is the
   * defect, and a silent retry loop would be a slower version of it.
   *
   * Declared below `useWindowedTranscript` because it needs the window's
   * geometry: past 60 rows the transcript renders a slice, so the card being
   * returned to is usually not in the DOM at all and cannot be found by a scan.
   */
  useEffect(() => {
    const request = pendingTranscriptReturn;
    if (view !== "chat" || !request || request.sessionId !== sessionId || messages.length === 0) return;
    setPendingTranscriptReturn(undefined);
    /*
     * Unpin first, synchronously, and before the pin effect below runs.
     * Measured: the return marked and outlined the right card at top -1317 and
     * left the reader at the bottom of the thread, because the pin-to-latest
     * frame is queued after this one and wins. Unpinning is also the honest
     * state — the reader is now away from the newest turn — so the jump control
     * appears, which is the way back.
     */
    transcriptPinned.current = false;
    setTranscriptDetached(true);
    const index = messages.findIndex((message) => message.receipt?.turnId === request.turnId);
    if (index < 0) {
      // The one case the sentence is true about: no row in this conversation
      // carries that turn id, so there is nothing to land on. Said of a merely
      // unmounted card it blamed local commands for what virtualization did.
      setRuntimeStatus("That turn has no card in this transcript — a local command mints no receipt, so there is no id to land on. The conversation is open.");
      return;
    }
    let frame: number | undefined;
    let pass = 0;
    const land = () => {
      // Scroll by the index's offset rather than by the card: the card mounts
      // only once the window covers it. Reapplied on each pass because the
      // window replaces estimated heights with measured ones as rows arrive,
      // which moves the offset under the coordinate just written. The scroller
      // is read per pass, not captured, because the transcript may still be
      // mounting on the frame this effect runs from.
      const element = transcriptElement.current;
      if (element) {
        element.scrollTop = Math.min(
          windowedTranscript.offsetForIndex(index),
          Math.max(0, element.scrollHeight - element.clientHeight),
        );
      }
      if (focusTranscriptTurn(request.turnId) === "landed") return;
      pass += 1;
      // The same bounded retry the viewport restore above uses, and for the
      // same reason: the scroll listener defers its viewport read to a frame of
      // its own, so one frame is never enough for the row to exist.
      if (pass < 8) {
        frame = requestAnimationFrame(land);
        return;
      }
      setRuntimeStatus("That turn is in this conversation, but its card did not mount in time to land on. Scroll up, or reopen it from All conversations.");
    };
    frame = requestAnimationFrame(land);
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [view, sessionId, messages, pendingTranscriptReturn]);

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
  /*
   * A conversation row reads its opener at click time; it does not carry one.
   *
   * Both loaders below bake an `open` callback into every row they return, and
   * both effects are keyed on `settledSessionRevision` — the trailing edge of a
   * turn's event burst, which by construction settles while that turn is still
   * running. The rows now call the live opener below. Same-model requests open
   * immediately; incompatible continuations remain held for their safe journal
   * boundary rather than being rejected.
   *
   * The indirection keeps the row current; the pending-resume boundary keeps a
   * live turn's transcript projection and journal authority intact.
   */
  const openConversationRef = useRef<(targetSessionId: string) => Promise<void>>();
  openConversationRef.current = openPaletteSession;
  const openConversationFromList = (targetSessionId: string) => {
    void openConversationRef.current?.(targetSessionId);
  };
  useEffect(() => {
    if (!sessionLibrary) {
      setRecentPaletteState(Object.freeze({ profileId: "", sessions: Object.freeze([]) }));
      return;
    }
    const controller = new AbortController();
    void loadRecentSessionPaletteSources(
      sessionLibrary,
      openConversationFromList,
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
      // A journal that is still being adopted has not yet failed to hold the
      // address; asking it now is what produced "did not survive the reload"
      // about a conversation restored a second later. See
      // `durableAuthoritySettled`. The latch is the same one every storage
      // transition already sets, so a later Vault change is covered too.
      || !resumeAuthoritySettled
      || catalogAuthorityChanging.current
      || chatRouteOpening.current === chatRouteRequest
    ) return;
    if (sessionId === chatRouteRequest) {
      setChatRouteRequest(undefined);
      return;
    }
    const requestedSessionId = chatRouteRequest;
    chatRouteOpening.current = requestedSessionId;
    void inspectSessionForNavigation(requestedSessionId)
      .then((detail) => resumeLibrarySession(detail))
      .then(() => {
        setChatRouteRequest((current) => current === requestedSessionId ? undefined : current);
        lossNoticeAddress.current = undefined;
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
          // Nothing to mourn if this page wrote the address itself: see
          // `rememberMintedAddress`. Anything else came from a person.
          //
          // Nor if the return report already names this conversation among the
          // work that was not kept. One loss, one statement — the report has
          // the count, the clock and the remedy, and two surfaces narrating the
          // same event in different words is the "three independent surfaces
          // guessing" the Atlas measured on the resume path.
          if (
            !addressWasMintedHere(requestedSessionId)
            && !reportedLostAddresses.current.has(requestedSessionId)
          ) {
            lossNoticeAddress.current = requestedSessionId;
            setComposerNotice("That conversation existed only in page memory and did not survive the reload. This is a new conversation.");
          }
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
  }, [busy, catalog, chatRouteRequest, resumeAuthoritySettled, sessionId, sessionLibrary, sessionRuntime, view]);
  /*
   * A loss notice is withdrawn the moment the conversation it mourns is open.
   *
   * The gate above removes the race that raised the notice early, and this
   * removes the claim itself if any other path — a Vault adopting and resuming
   * its own latest session, a fork landing, a person picking the row out of the
   * rail — puts that conversation back on screen. The measured failure was a
   * cold open at `#chat/45b72a63` rendering "did not survive the reload" beside
   * a fully restored transcript and a topbar reading "audited session resumed":
   * whichever a reader believed, they had to distrust the other.
   */
  useEffect(() => {
    if (!sessionId || lossNoticeAddress.current !== sessionId) return;
    lossNoticeAddress.current = undefined;
    setComposerNotice(undefined);
  }, [sessionId]);
  useEffect(() => {
    if (view !== "chat" || chatRouteRequest || !sessionId) return;
    // A hash navigation can land between this effect being scheduled and
    // committed. Do not let a stale chat render rewrite a newer route such as
    // #sessions back to its canonical conversation URL.
    if (navigationViewFromHash(window.location.hash) !== "chat") return;
    const target = chatHash(sessionId);
    if (window.location.hash !== target) {
      rememberMintedAddress(sessionId);
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
      openConversationFromList,
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
   * journal event, so the local integrity check saw a chain with a hole where the shell is, and
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
      if (pass < 8) frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    // Windowed activation can land after the painted-fewest transcript rows
    // collapse their estimate into real heights; three frames and one 120 ms
    // settle covered a first paint from a cold boot, not a rail switch over an
    // already-mounted transcript whose deferred message parts re-tall it. A
    // bounded second settle at half a second measured enough for the largest
    // transcripts; everything after that is the reader's own scroll.
    const settle = window.setTimeout(restore, 120);
    const settleLate = window.setTimeout(restore, 500);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.clearTimeout(settleLate);
    };
  }, [profileId, sessionId, profileCockpitTransition, activeSessionRecord?.manifest.profile?.profileId]);
  useEffect(() => {
    const draftSessionId = chatRouteRequest ?? sessionId;
    if (!draftSessionId) return;
    /*
     * The first claim of the page's life is a conversation *arriving*, not a
     * conversation being switched away from.
     *
     * The composer is editable from the first paint, and on a cold `#chat`
     * boot there is no conversation behind it yet: the session is minted a
     * beat later and its id is pushed into the address. Until this guard, the
     * hydration that pass performed read the brand-new conversation's stored
     * draft — necessarily empty — and set it over whatever had been typed in
     * the meantime. Measured against `narrow-viewport-overflow`'s three
     * paragraph specs at 320, 390 and 768: `/help` typed into the composer,
     * then an empty composer with `Send message` permanently disabled and no
     * word anywhere about where the text went. A person who types the instant
     * the page paints gets the same silence.
     *
     * So the boot claim carries the live composer into the identity that just
     * landed — the same thing `preserveComposerForDraftIdentity` does for a
     * fork, and the same ordering the durable half below uses for its slower
     * read. An empty composer still hydrates normally, which is what keeps a
     * deep link to `#chat/<id>` restoring that conversation's own draft. Every
     * later claim is a real switch and still replaces the composer with the
     * arriving conversation's draft, empty included.
     */
    const bootClaim = draftHydrationIdentity.current === undefined;
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
      const stored = readThreadDraft(draftSessionId, sessionStorage);
      setInput((current) => (bootClaim && current ? current : stored));
    } catch {
      setInput((current) => (bootClaim && current ? current : ""));
    }
    setAttachments((current) => (bootClaim && current.length ? current : []));
  }, [chatRouteRequest, sessionId]);
  /*
   * The durable half of draft hydration.
   *
   * A browser restart empties `sessionStorage`, so the tab-scoped copy above is
   * exactly as durable as page memory — right for a page-memory session, wrong
   * for one whose journal the person has paid to keep. Measured with the Vault
   * active: "and one more thing I still need to check before Friday" before the
   * restart, `""` after, same URL, same conversation restored, no notice.
   *
   * It is a second effect rather than a branch of the first because the two
   * hydrations arrive on different clocks: the tab copy is there at first paint
   * and the Vault is adopted a second or two later, so a single fence keyed on
   * the conversation would claim hydration before the durable store existed and
   * never look again.
   */
  useEffect(() => {
    const draftSessionId = chatRouteRequest ?? sessionId;
    const durablePort = durableAuthorityAdopted ? runtime.current?.workspace : undefined;
    if (!draftSessionId || !durablePort || durableDraftIdentity.current === draftSessionId) return;
    // Until the read lands this conversation has no established durable draft,
    // and the writer below must not persist an empty composer over one.
    durableDraftIdentity.current = undefined;
    let cancelled = false;
    void readDurableDraft(durablePort, draftSessionId).then((carried) => {
      if (cancelled) return;
      durableDraftIdentity.current = draftSessionId;
      // Never over anything typed while the read was in flight.
      if (carried) setInput((current) => current || carried);
    });
    return () => { cancelled = true; };
  }, [chatRouteRequest, durableAuthorityAdopted, sessionId]);
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
    /*
     * The tab copy writes synchronously with the keystroke. A `setItem` costs
     * less than a frame even for a page-long draft, and the 160 ms debounce it
     * replaced bought nothing except a window in which navigation could race
     * hydration: type, tap a thread, and the going-away conversation's stored
     * draft was still the previous keystroke's — hydration then overwrote the
     * live composer with the stale copy and the line was gone. "Preserve
     * input" admits no clock here; the encrypted copy below keeps its slower
     * one because an authenticated envelope genuinely costs one.
     */
    try {
      writeThreadDraft(draftSessionId, input, sessionStorage);
      // Text in the composer is the plainest evidence that this tab has been
      // worked in, so from here on a lost address is a lost conversation and
      // is reported as one. See `rememberMintedAddress`.
      if (input) forgetMintedAddresses();
    } catch {
      // Draft persistence is optional; the live composer remains authoritative.
    }
    /*
     * The encrypted copy runs on its own, slower clock: the tab write is a
     * `sessionStorage.setItem`, this one is an authenticated envelope through
     * the Vault's workspace port, and a keystroke is not worth one of those.
     * It is fenced on the durable read having already answered for this
     * conversation, or the empty composer of the frame after a restart would
     * erase the very text it is one tick away from restoring.
     */
    const durablePort = durableAuthorityAdopted ? runtime.current?.workspace : undefined;
    const durableTimer = durablePort ? window.setTimeout(() => {
      if (durableDraftIdentity.current !== draftSessionId) return;
      void writeDurableDraft(durablePort, draftSessionId, input);
    }, DRAFT_DURABLE_PERSIST_MS) : undefined;
    return () => {
      if (durableTimer !== undefined) window.clearTimeout(durableTimer);
    };
  }, [chatRouteRequest, durableAuthorityAdopted, input, sessionId]);
  /*
   * Remember that work existed, so a return can be told what happened to it.
   *
   * The Atlas measured a person who had sent two turns close the browser and
   * reopen to a screen byte-identical to a first-ever visit — no notice, no
   * tombstone, "All conversations" reporting the empty conversation this boot
   * had just minted. Airship could not say what was lost because nothing in the
   * browser profile remembered that anything had been written.
   *
   * Only conversations that hold a real turn are recorded, which is what keeps
   * a first-ever visit silent: a boot-minted empty shell never enters the
   * ledger and can never be reported as lost. What is stored is a count, a
   * clock and the posture — never a title or a word of the conversation, so a
   * page-memory session's "What can lose it: Closing the page" stays true.
   */
  useEffect(() => {
    const storage = browserReturnLedgerStorage();
    if (!storage || !sessionId || !profileId || recordedTranscriptSize === 0) return;
    const lastActiveAt = new Date().toISOString();
    void loadReturnLedger().then(({ recordReturnLedgerEntry }) => {
      recordReturnLedgerEntry(storage, {
        sessionId,
        profileId,
        messageCount: recordedTranscriptSize,
        lastActiveAt,
        posture: durableAuthorityAdopted ? "durable" : "page-memory",
        pageSession: pageSessionToken.current,
      });
    });
  }, [durableAuthorityAdopted, profileId, recordedTranscriptSize, sessionId]);
  /*
   * Reconcile that memory with the journal that actually loaded, once.
   *
   * It waits for the same verdict the route resolver waits for: asking a
   * page-memory journal what a Vault holds is how the product came to announce
   * losses it was about to restore. The fence is the journal itself rather than
   * a boolean, so if a Vault is adopted after a verdict has been reached — the
   * liveness ceiling firing early on a slow machine is the way that happens —
   * the new journal re-answers and a wrong report is withdrawn rather than left
   * standing.
   */
  useEffect(() => {
    const storage = browserReturnLedgerStorage();
    if (!storage || !sessionLibrary || !resumeAuthoritySettled || returnLedgerReconciled.current === sessionLibrary) return;
    returnLedgerReconciled.current = sessionLibrary;
    const controller = new AbortController();
    // Tombstones are re-tested too: a journal that produces the conversation is
    // the only thing that can withdraw a verdict already written down.
    void loadReturnLedger().then(async ({ readReturnLedger, reconcileReturnLedger, summarizeUnrecoveredWork }) => {
      const wanted = new Set(readReturnLedger(storage).map((entry) => entry.sessionId));
      const present = await findPresentSessions(sessionLibrary, wanted, controller.signal);
        if (controller.signal.aborted) return;
        const lost = reconcileReturnLedger(storage, { present, pageSession: pageSessionToken.current });
        reportedLostAddresses.current = new Set(lost.map((entry) => entry.sessionId));
        // Whichever of the two resolutions finished first, one loss gets one
        // statement: the report carries the count, the clock and the remedy, so
        // the address-scoped notice withdraws rather than repeating it.
        if (lossNoticeAddress.current && reportedLostAddresses.current.has(lossNoticeAddress.current)) {
          lossNoticeAddress.current = undefined;
          setComposerNotice(undefined);
        }
        setUnrecoveredWork(summarizeUnrecoveredWork(lost));
    })
      .catch(() => {
        // A journal that could not be listed has proved nothing about what it
        // holds. Re-arm rather than report an absence nobody established.
        returnLedgerReconciled.current = undefined;
      });
    return () => controller.abort();
  }, [resumeAuthoritySettled, sessionLibrary]);
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
    /*
     * A conversation with no turns and a loss to report has one thing worth
     * reading, and it is at the top. Measured at 390x844: the pin-to-latest
     * scroll put "Your last visit was not kept" behind the sticky session bar
     * while the starter cards it scrolled to were the least urgent thing on the
     * surface. The pin resumes the moment a turn exists to be pinned to.
     */
    if (unrecoveredWork && recordedTranscriptSize === 0) return;
    const frame = requestAnimationFrame(() => {
      const element = transcriptElement.current;
      if (element) {
        scrollToLastRealCard(element, "auto", transcriptEntryAlignment.current ? "start-if-oversized" : "end");
        transcriptEntryAlignment.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, recordedTranscriptSize, transcriptLeadingHeight, unrecoveredWork, view, windowedTranscript.totalHeight]);
  /*
   * The report arrives after first paint — it waits for the journal — so the
   * pin above has already run and left the transcript scrolled to the starter
   * cards. Measured at 390x844: "Your last visit was not kept" sat behind the
   * sticky session bar while the least urgent thing on the surface was in view.
   * Returning to the top is the only correction that survives the report
   * appearing late.
   */
  useEffect(() => {
    if (!unrecoveredWork || recordedTranscriptSize > 0) return;
    const frame = requestAnimationFrame(() => {
      if (transcriptElement.current) transcriptElement.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [recordedTranscriptSize, unrecoveredWork]);
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
  const vaultRuntimeAdopted = localDeviceRuntimeAdopted || cloudVaultRuntimeAdopted;
  // Declared here rather than beside the other global hooks because adoption is
  // one of its three terms, and adoption is what decides whether closing the tab
  // costs anything at all.
  const releaseUnloadGuard = useBeforeUnloadGuard(unloadWouldLoseWork({
    /* Every conversation, not the visible one: closing the tab takes down
       each turn still running behind it, and the reader is owed the warning
       for work they are not currently looking at most of all. */
    busy: anyTurnRunning,
    eventCount,
    vaultAdopted: vaultRuntimeAdopted,
  }));
    async function selectSessionForActivation(
    session: SessionRecord,
    sourceRuntime = runtime.current,
    signal?: AbortSignal,
  ): Promise<SessionRecord> {
    const sessionProfileId = session.manifest.profile?.profileId;
    if (!sessionProfileId || !sourceRuntime) {
      throw new Error("The selected conversation is not bound to an active profile journal.");
    }
    const selection = await new SessionLibrary(sourceRuntime.journal).selectActiveConversation(
      sessionProfileId,
      session.id,
      {
        expectedTargetHead: { sequence: session.headSequence, digest: session.headDigest },
        ...(signal ? { signal } : {}),
      },
    );
    return selection.session;
  }

  function publishActiveSessionSelection(selected: SessionRecord): SessionRecord {
    const sessionProfileId = selected.manifest.profile?.profileId;
    if (!sessionProfileId) throw new Error("The selected conversation is not bound to an active profile journal.");
    // Update the identity fence synchronously. An aborted prior turn can still
    // deliver its final durable signal before Preact commits the next render.
    activeSessionIdentity.current = selected.id;
    setSessionId(selected.id);
    setActiveSessionRecord(selected);
    activeSessionByProfile.current.set(sessionProfileId, selected.id);
    setMessageQueue(queuedMessagesBySession.current.get(selected.id) ?? []);
    return selected;
  }

  async function activateSession(session: SessionRecord): Promise<SessionRecord> {
    return publishActiveSessionSelection(await selectSessionForActivation(session));
  }

  useEffect(() => () => {
    approvalBroker.denyAll();
    vaultContextPublication.current?.abort(new DOMException("Airship is closing.", "AbortError"));
  }, [approvalBroker]);

  /*
   * A capability request is a real modal only once its dialog is resident.
   *
   * A failed deferred import used to publish `pending` first, make the whole
   * shell inert, and render no dialog at all. The request then sat behind an
   * invisible modal until the broker's five-minute expiry. While the dock is
   * still loading, the effect remains paused but the shell stays operable. If
   * loading fails, every waiting request is denied synchronously; the banner
   * rendered beside the shell states that the effect did not run.
   */
  useEffect(
    () => approvalBroker.subscribe((state) => {
      const pendingCount = state.pending.length;
      if (pendingCount === 0) {
        setApprovalDockWaitingRequests(0);
        setApprovalPending(false);
        return;
      }
      if (approvalDockReady.current) {
        setApprovalDockWaitingRequests(0);
        setApprovalPending(true);
        return;
      }
      setApprovalPending(false);
      if (approvalDockUnavailable.current) {
        setApprovalDockWaitingRequests(0);
        denyPendingForUnavailableDock(pendingCount);
        return;
      }
      // A real effect is waiting, but the dialog code is not resident yet. Say
      // so and keep a denial path available instead of leaving the request
      // behind a silent five-minute broker expiry.
      setApprovalDockWaitingRequests(pendingCount);
      beginApprovalDockLoad();
    }),
    [approvalBroker, beginApprovalDockLoad, denyPendingForUnavailableDock],
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
          /*
           * Deliberately silent here. This is a standing state, not an event,
           * and it used to be announced by writing it into `runtimeStatus` —
           * the one mixed-purpose line the shell overwrites with the next thing
           * that happens anywhere. The Atlas measured every consequence of that
           * category error at once: the sentence was inert text with no action
           * (J002), it collapsed to 0×0 on a phone (J003), the first turn's
           * "Persisting turn intent" evicted it 0.6s in and "Local kernel ready"
           * replaced it for the next three hours (J114), and on the way past it
           * overwrote the completion signal for a profile switch (J020).
           *
           * The Vault adoption status below carries it instead: derived from state,
           * so nothing can evict it; rendered by the topbar posture chip, which
           * is a control and is the one piece of chrome measured legible at
           * 390px; and stated again by the durability claim on the conversation
           * itself, where the person is typing.
           */
          setVaultSetupOpen(true);
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
        // Only the live attempt may answer. Boot re-runs this effect as the
        // catalog, profile and Git client arrive, and settling from a cancelled
        // attempt declared "no Vault is coming" while the real adoption was
        // still two seconds out — which reproduced the whole defect: the route
        // resolver condemned the address, moved the unsent draft onto the
        // throwaway conversation the boot had minted, and the Vault then
        // restored the real one over an empty composer.
        if (localDeviceAutoOpenOwner.current !== owner) return;
        // The verdict settles on *conclusion*, not on success: an enrolment
        // that needs its recovery ceremony and a keyring that refused are both
        // definitive answers to "will a durable journal arrive", and the route
        // resolver is waiting for either one.
        setDurableAuthoritySettled(true);
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

  // Readiness is not durability until the configured adapters replace the active
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
      // Adopted or refused, the resume verdict has its answer; see
      // `durableAuthoritySettled`.
      .finally(() => { setDurableAuthoritySettled(true); vaultAdoptionBusy.current = false; });
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

  /**
   * The one recovery verb, shared by every route that can fail to load.
   *
   * Each loader clears its own error as it re-enters, so this needs to do
   * nothing but ask them all to run again.
   */
  function retryDeferredChunk() {
    setDeferredChunkAttempt((value) => value + 1);
  }

  /* Sessions and Vault share a deferred route chunk. Load it only when one
     of those destinations is open, and keep a route-local failure state. */
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
    if (view !== "access" || ProviderConnectionsScreen) return;
    let current = true;
    setProviderFabricError(undefined);
    void import("./provider-connections-view").then((module) => {
      if (current) setProviderConnectionsScreen(() => module.ProviderConnectionsView);
    }).catch(() => {
      // This route loads directly now, so its failure state must render here.
      if (current) setProviderFabricError("The Providers interface could not be loaded. Existing connections and conversations were not changed.");
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
    if ((view !== "memory" && view !== "context") || MemoryScreen) return;
    let current = true;
    setMemoryViewError(undefined);
    /*
     * Through the recovery loader, because the failure card's retry verb
     * provably could not work: a module URL that has failed once is recorded as
     * failed in this document's module map, so three presses of that button —
     * and a round trip through Chat — issued zero network requests, and the
     * route stayed dead for the life of the tab.
     */
    void loadRetryableChunk(
      "memory-view",
      () => import("./memory-view"),
      developmentChunkEntry("memory-view.tsx"),
    ).then((module) => {
      if (current) setMemoryScreen(() => module.MemoryView);
    }).catch(() => {
      if (current) setMemoryViewError("The private Memory interface could not be loaded. No index or workspace state changed.");
    });
    return () => { current = false; };
  }, [view, MemoryScreen, deferredChunkAttempt]);

  useEffect(() => {
    if (view !== "skills" || SkillsScreen) return;
    let current = true;
    setSkillsViewError(undefined);
    void loadRetryableChunk(
      "skills-manager-view",
      () => import("./skills-manager-view"),
      developmentChunkEntry("skills-manager-view.tsx"),
    ).then((module) => {
      if (current) setSkillsScreen(() => module.SkillsManagerView);
    }).catch(() => {
      if (current) setSkillsViewError("The Skills interface could not be loaded. No profile, skill, or conversation state changed.");
    });
    return () => { current = false; };
  }, [view, SkillsScreen, deferredChunkAttempt]);

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
    if (window.location.hash !== resolvedTargetHash) {
      window.history.pushState(
        next === "chat" ? { view: next, sessionId: chatSessionIdFromHash(resolvedTargetHash) } : { view: next },
        "",
        resolvedTargetHash,
      );
    }
    window.dispatchEvent(new Event("airship:n"));
    return true;
  }

  function abandonReconnectRequest(): void {
    if (inferenceRouteChanging.current) return;
    window.history.replaceState({ view: "access" }, "", "#connection");
    setDestinationArrival((current) => current + 1);
    setMobileMoreOpen(false);
    setView("access");
    setChatRouteRequest(undefined);
  }

  function navigatePrimary(next: View) {
    navigate(next);
  }

  async function inspectSessionForNavigation(
    targetSessionId: string,
    signal?: AbortSignal,
    sourceRuntime: Runtime | undefined = runtime.current,
    authoritySessionId: string | undefined = activeSessionIdentity.current,
  ): Promise<SessionLibraryDetail> {
    if (!sourceRuntime) throw new Error("The local runtime is not ready.");
    signal?.throwIfAborted();
    const target = await sourceRuntime.journal.getSession(targetSessionId, signal);
    if (!target) throw new UnknownSessionError(targetSessionId);
    const authority = authoritySessionId
      ? await sourceRuntime.journal.getSession(authoritySessionId, signal)
      : undefined;
    signal?.throwIfAborted();
    return new SessionLibrary(sourceRuntime.journal).inspect(
      targetSessionId,
      activeSessionRuntime(sourceRuntime, authority ?? target, target),
      signal,
    );
  }

  async function openPaletteSession(targetSessionId: string): Promise<void> {
    const ownerRuntime = runtime.current;
    const ownerProfile = activeProfileRef.current;
    const ownerSessionId = activeSessionIdentity.current;
    // A route click for the conversation that is already active is only
    // navigation. Browser Back already takes this identity fast path in the
    // hash resolver; recents and the palette must not turn the same destination
    // into an audit/reconnect operation merely because it was reached by a
    // button instead of browser history.
    if (ownerSessionId && targetSessionId === ownerSessionId) {
      navigate("chat", chatHash(targetSessionId));
      return;
    }
    if (!ownerRuntime || !ownerProfile || !ownerSessionId) {
      // The bail itself is architectural — an open is performed against the
      // active conversation's runtime authority — but it was silent, and
      // deleting the active conversation clears that identity with nothing to
      // re-establish it. Every rail row, palette row and switcher entry then
      // produced the library with no word about why, so the refusal names
      // itself and keeps the row that was clicked selected, where the disabled
      // Resume repeats the same reason.
      setSessionsFocusId(targetSessionId);
      setRuntimeStatus("No conversation is open, so there is no active runtime to open this one against. Start a new conversation first.");
      navigate("sessions");
      return;
    }
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
        activeSessionRuntime(ownerRuntime, authoritySession, target),
      );
      if (
        runtime.current !== ownerRuntime
        || activeProfileRef.current?.revision !== ownerProfile.revision
        || profileAuthorityId.current !== ownerProfile.profileId
        || activeSessionIdentity.current !== ownerSessionId
        || sessionNavigationChanging.current
      ) throw new Error("The active Profile or conversation changed before the requested conversation could open.");
      const modelChanged = detail.compatibility?.action === "fork-required"
        && detail.compatibility.reasons.some((reason) => reason.code === "MODEL_MISMATCH");
      if (modelChanged) {
        if (busy) {
          await queueSessionAction(() => openConversationRef.current?.(target.id) ?? Promise.resolve());
          return;
        }
        /*
         * A history click is already an explicit request to continue that
         * conversation.  When only the model pin differs, use the same
         * locally checked fork path as the visible Sessions action and
         * bind it to the current authority manifest.  This preserves the
         * source identity, bounded context seed, profile contract, and exact
         * credential generation without making the reader reconnect the old
         * model first.
         */
        const result = await new SessionLibrary(ownerRuntime.journal).fork(target.id, {
          manifest: authoritySession.manifest,
          expectedSourceHead: {
            sequence: target.headSequence,
            digest: target.headDigest,
          },
        });
        await activateForkedSession(result);
        setComposerNotice(`Continued on ${authoritySession.manifest.model} · ${result.contextMessageCount} carried.`);
      } else {
        await resumeLibrarySession(detail);
      }
    } catch (error) {
      const { describeSessionPresentationFault } = await loadDeferredCapabilities();
      setRuntimeStatus(error instanceof Error
        ? describeSessionPresentationFault(error)
        : "The recent session could not be opened.");
      /* A live turn only queues an incompatible continuation at its safe
         journal boundary; same-model history has already opened in place. */
      if (!busy) {
        // Keep the conversation the person chose in view.  A model/provider
        // mismatch is expected to refuse in-place replay, but sending the
        // reader to an unselected library made the safe continuation branch
        // look like the conversation had disappeared.
        setSessionsFocusId(targetSessionId);
        navigate("sessions");
      }
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

  /** Keep shell projections in step after SessionsView deletes the journal. */
  function adoptLibraryDelete(deletedSessionId: string): void {
    if (activeSessionIdentity.current === deletedSessionId) {
      activeSessionIdentity.current = undefined;
      activeSessionByProfile.current.delete(profileAuthorityId.current);
      setSessionId(undefined);
      setActiveSessionRecord(undefined);
      setMessages([{ ...welcomeMessage, id: randomUuid(), content: "The conversation was deleted. Start a new conversation when you are ready." }]);
      setEventCount(0);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
    }
    setSessionRevision((value) => value + 1);
  }

  function clearPendingDelta(messageId: string) {
    if (pendingDelta.current?.messageId === messageId) pendingDelta.current = undefined;
    if (pendingDeltaFrame.current !== undefined) {
      cancelAnimationFrame(pendingDeltaFrame.current);
      pendingDeltaFrame.current = undefined;
    }
    transcriptStreams.clear(messageId);
  }

  /**
   * The live reasoning buffer's own teardown, deliberately *not* folded into
   * `clearPendingDelta`. That one fires at the assistant boundary of every
   * step, and a multi-step turn reasons again after each tool result — folding
   * them together would blank the reasoning block between steps. Live
   * reasoning is cleared once, when the turn is over and the durable
   * `reasoning-summary` part takes the row.
   */
  function clearPendingReasoning(messageId: string) {
    if (pendingReasoning.current?.messageId === messageId) pendingReasoning.current = undefined;
    if (pendingReasoningFrame.current !== undefined) {
      cancelAnimationFrame(pendingReasoningFrame.current);
      pendingReasoningFrame.current = undefined;
    }
    reasoningStreams.clear(messageId);
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
   * Reasoning deltas arrive at the same per-token cadence as text, so they get
   * the same frame budget: one buffered append per animation frame into the
   * per-message slot store, which notifies that row's reasoning block and
   * nothing else. An immediate `setMessages` per delta — the shape this
   * started as — rebuilt the transcript array on every token the model thought.
   */
  function queueReasoningDelta(messageId: string, text: string) {
    const current = pendingReasoning.current;
    pendingReasoning.current = current?.messageId === messageId
      ? { messageId, text: current.text + text }
      : { messageId, text };
    if (pendingReasoningFrame.current !== undefined) return;
    pendingReasoningFrame.current = requestAnimationFrame(() => {
      const buffered = pendingReasoning.current;
      pendingReasoning.current = undefined;
      pendingReasoningFrame.current = undefined;
      if (!buffered) return;
      reasoningStreams.append(buffered.messageId, buffered.text);
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
        files: {
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
        webEgress: resolveProfileWebEgress(profile),
        webBodies: resolveProfileWebBodies(profile),
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
            runtime.current?.inferenceBinding,
          ),
        ),
      };
      runtime.current = nextRuntime;
      rememberProfileAuthority(nextRuntime, nextGitClient, resolveProfileWebEgress(profile), resolveProfileWebBodies(profile));
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
      const detail = error instanceof Error ? error.message : String(error);
      setBootFailure(detail);
      setRuntimeStatus("Airship could not finish starting the local kernel. Reload to try again; this tab never became ready.");
      setMessages([{ id: randomUuid(), role: "assistant", error: true, content: detail }]);
    });
    return () => {
      disposed = true;
      unsubscribeProviderFabric?.();
      abortAllTurns();
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
      setView(next);
      setChatRouteRequest(requestedChatSession);
      const canonicalHash = next === "chat"
        ? requestedChatSession
          ? chatHash(requestedChatSession)
          : chatHash(activeSessionIdentity.current)
        : next === "access"
          ? canonicalAccessHash(window.location.hash)
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

  // The route scroller earns the same affordance, and unlike the rail it earns
  // it at every viewport this product ships to: `.main` is bounded by the
  // topbar above and the navigation band below, so a short viewport ends the
  // content on a hard line and cuts whatever row is crossing it. `routes.css`
  // turns this reading into a 26px fade on the edge that is genuinely hiding
  // something. Re-bind on `view` because each route brings its own height, and
  // on `railState` because collapsing the rail rewidens every route and
  // rewraps its text — both change the overflow without a scroll event.
  useScrollEdges(mainRegion, `${String(shellMounted)}:${railState}:${view}`);

  // `data-rail` is on the document element, not the shell, because the topbar
  // and the app grid both size their first column from `--rail-width`. This is
  // a layout effect because the root grid and the Rail render are one visual
  // state: publishing after paint exposed a labelled/collapsed mismatch for a
  // frame after both a shortcut and a viewport-band transition.
  useLayoutEffect(() => { document.documentElement.dataset.rail = railState; }, [railState]);

  useEffect(() => {
    if (Overlays) return;
    const warm = () => beginPlatformOverlaysLoad();
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 2_000 });
    else setTimeout(warm, 0);
  }, [Overlays, beginPlatformOverlaysLoad]);

  /*
   * J151: tell the service-worker listener what a reload would cost.
   *
   * The takeover reloads the page so COOP/COEP are established before anyone
   * starts working, and its fence was "has a trusted input gesture been seen".
   * A conversation exists before anyone types. Measured on a fresh context
   * against the production build — which is what a first visit is — the reload
   * landed after the conversation had been minted, and page memory does not
   * cross it: the work was rendered, reported complete, and gone.
   *
   * `messages` starts as the welcome card, so the count subtracts it: an
   * untouched zero state has nothing to lose and should still take the reload
   * immediately, which is the whole point of doing it early.
   */
  useEffect(() => {
    publishReloadRisk({
      durableAuthority: durableAuthorityAdopted,
      recordedTurns: messages.filter((message) => message.id !== welcomeMessage.id).length,
      unsentDraft: input.trim().length > 0,
    });
  }, [durableAuthorityAdopted, messages, input]);

  useEffect(() => {
    const onResize = () => setRailViewport(readRailViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /*
   * Registered once, and read through a ref, because re-registering drops keys.
   *
   * This effect depended on `[railState, railViewport, railPreference]`, so
   * every state change tore the listener down and put a new one up — and
   * `railPreference` is loaded from storage after mount, and `railViewport`
   * changes on every resize. A chord pressed inside one of those windows hit no
   * listener at all and was silently discarded. Measured as an intermittent
   * failure of the rail's own contract test across full-suite runs: the rail
   * stayed 232px wide because Cmd+\ had landed in the gap. A person resizing
   * the window, or pressing it early in boot, gets the same nothing.
   *
   * The handler is a ref updated on every render, so the listener registered at
   * mount always calls the current one and never has to be replaced.
   */
  const railToggle = useRef(toggleRailState);
  railToggle.current = toggleRailState;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isRailToggleChord(event)) return;
      event.preventDefault();
      railToggle.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      overlayOpen: mobileMoreOpen || paletteOpen || preferencesOpen || approvalPending,
      narrowViewport: window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches,
      focusAtDocumentRoot: document.activeElement === null || document.activeElement === document.body,
    })) return;
    const frame = requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [shellMounted, view, mobileMoreOpen, paletteOpen, preferencesOpen, approvalPending]);

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
  function rememberProfileAuthority(
    built: Runtime,
    git: BrowserGitClient,
    webEgress: "node-first" | "browser-only",
    webBodies: "any" | "text-only",
  ): void {
    profileAuthorities.current.set(built.profileId, Object.freeze({
      storage: built.storage,
      workspace: built.workspace,
      workspaceId: built.workspaceId,
      git,
      tools: built.tools,
      webEgress,
      webBodies,
      contextMode: built.contextMode,
    }));
  }

  async function runtimeForProfile(
    active: Runtime,
    profile: ProfileRevision,
  ): Promise<Readonly<{ runtime: Runtime; git: BrowserGitClient }>> {
    const cached = profileAuthorities.current.get(profile.profileId);
    const webEgress = resolveProfileWebEgress(profile);
    const webBodies = resolveProfileWebBodies(profile);
    if (cached
      && cached.storage === active.storage
      && cached.webEgress === webEgress
      && cached.webBodies === webBodies) {
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
    // A policy-only revision rebuilds the registry over the same Profile port;
    // workspace identity (including unsaved drafts and terminal ownership) must
    // not be discarded merely because web routing changed.
    const authority = cached && cached.storage === active.storage
      ? { workspace: cached.workspace, workspaceId: cached.workspaceId, git: cached.git }
      : await openProfileWorkspaceAuthority({
          storage: active.storage,
          storageId: active.storageId,
          profile,
        });
    const registryOptions = {
      workspace: authority.workspace,
      journal: active.journal,
      git: authority.git,
      webEgress,
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
    rememberProfileAuthority(built, authority.git, webEgress, webBodies);
    return Object.freeze({ runtime: built, git: authority.git });
  }

  /**
   * Switches the cockpit, and reports either the committed outcome or the exact
   * refusal sentence the initiating surface must show.
   *
   * The outcome is not decoration: `deleteProfile` archives the outgoing
   * profile only if the replacement really became active, while each route can
   * render the exact refusal without scraping a global status line.
   */
  async function changeProfile(nextId: string, force = false): Promise<ProfileSwitchFailure> {
    const active = runtime.current;
    if (!active || !catalog) return "Profile controls are not ready yet.";
    if (!force && nextId === profileId) return undefined;
    if (inferenceRouteChanging.current || sessionNavigationChanging.current) {
      throw new Error("Wait for the current session or inference route change before switching profiles.");
    }
    workspaceRefreshCoordinator.invalidate();
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
      abortAllTurns();
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
          } else if (sessionAuditRefusesResume(audited.report)) {
            unresumableReason = "Its journal failed the local integrity audit.";
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
      if (operation !== profileOperation.current) {
        return "A newer profile operation replaced this switch.";
      }
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
        return undefined;
      }
      const activated = await activateSession(nextSession);
      setSessionRevision((value) => value + 1);
      setMessages([{ ...welcomeMessage, id: randomUuid(), content: unresumableReason
        ? `${profile.name}'s most recent conversation was not resumed, so Airship started a new one here. ${unresumableReason} That conversation is unchanged and still readable in Sessions. ${welcomeMessage.content}`
        : `${profile.name} had no compatible conversation, so Airship started one. ${welcomeMessage.content}` }]);
      setEventCount(activated.headSequence);
      setSessionLifecycle(READY_SESSION_LIFECYCLE);
      setTranscriptBoundary(undefined);
      setRuntimeStatus(`${profile.name} cockpit started`);
      await releaseOutgoingProfileTerminals(active.workspace, profile.name);
      navigate("chat");
      return undefined;
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
       * the rest adopted: the adoption status would read "not adopted" under a
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
        const detail = error instanceof Error ? error.message : String(error);
        const message = ownsRuntime
          ? `Profile switch failed: ${detail}`
          : `Profile switch abandoned: ${detail} The storage authority that replaced it stays active.`;
        setRuntimeStatus(message);
        return message;
      }
      return "A newer profile operation replaced this switch.";
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
  async function requestProfileChange(nextId: string, force = false): Promise<ProfileSwitchFailure> {
    try {
      return await changeProfile(nextId, force);
    } catch (error) {
      const message = `Profile switch failed: ${error instanceof Error ? error.message : String(error)}`;
      setRuntimeStatus(message);
      return message;
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
    const commandRuntime = authority.commandRuntime;
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
        runtime.current !== authority.identityRuntime
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
        runtime.current !== authority.identityRuntime
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
          runtime.current !== authority.identityRuntime
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
          runtime: authority.identityRuntime,
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
      const activeModels = activeExternalRoute?.models.map((model) => model.id)
        ?? [effectiveSessionModel(activeSessionRecord)];
      const modelIds = activeModels
        .filter((model) => !query || model.toLowerCase().includes(query));
      appendLocalExchangeForAuthority(authority, source, modelIds.length
        ? [
            `Connection: ${activeInferenceBinding?.providerLabel ?? "local demo"} / ${activeInferenceBinding?.connectionId ?? "built-in"}`,
            ...modelIds.map((model) => `${model === effectiveSessionModel(activeSessionRecord) ? "•" : "○"} ${model}`),
          ].join("\n")
        : "No matching model is available.");
      return;
    }
    if (action.type === "models.select") {
      if (activeExternalRoute) await switchExternalModel(action.modelId);
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
    const userId = randomUuid();
    const assistantId = randomUuid();
    /*
     * One turn has one disposition. The prompt row used to be written
     * "completed" the moment it was appended and never revised, so a `/write`
     * that failed rendered "COMPLETED TURN" above "FAILED TURN" for the same
     * exchange — and the durable path (session-message-presentation.ts) gives
     * both rows one status, so a reload silently disagreed with the live view.
     */
    const settleTurn = (
      turnStatus: "completed" | "failed" | "cancelled",
      assistant: (message: UiMessage) => UiMessage,
    ) => {
      setMessages((current) => current.map((message) => {
        if (message.id === userId) return { ...message, history: { turnStatus, providerContext: "excluded" as const } };
        if (message.id !== assistantId) return message;
        return assistant(message);
      }));
    };
    const controller = new AbortController();
    activeTurns.current.set(commandSessionId, controller);
    setSessionBusy(commandSessionId, true);
    setRuntimeStatus(`Reviewing local /${plan.command.name}`);
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: source, history: { turnStatus: "incomplete", providerContext: "excluded" } },
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
      /* This command's own conversation adjudicates it, whichever one is on
         screen by the time the dock is answered. */
      const commandPolicy = sessionLocalCommandPolicy(commandSessionId);
      const decision = await commandRuntime.tools.review(plan.toolName, plan.arguments, context, commandPolicy);
      const provenance = approvalProvenance(commandPolicy, context);
      if (decision !== "allow") {
        // One sentence for all three modes now, because it is true in all
        // three: no local command's parameters reach a model before it runs.
        const denied = `Permission denied for local /${plan.command.name}. No tool effect ran, and nothing was sent to the model.`;
        await append([{ type: "local.command.denied", turnId, operationId, payload: { content: denied, toolName: plan.toolName, approval: provenance ?? null } }]);
        settleTurn("completed", (message) => ({
          ...message,
          content: denied,
          status: undefined,
          error: true,
          history: { turnStatus: "completed", providerContext: "excluded" },
        }));
        narrateTurn(localCommandAnnouncement(plan.command.name, "denied", "No tool effect ran, and nothing was sent to the model."));
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
        settleTurn(result.isError ? "failed" : "completed", (message) => ({
          ...message,
          content: boundedTranscriptContent(result.content),
          status: "Local result · excluded from model context",
          error: result.isError,
          history: {
            turnStatus: result.isError ? "failed" : "completed",
            providerContext: "excluded",
          },
        }));
        await refreshWorkspacePresentation(commandRuntime, commandProfileId);
        // No longer mode-dependent: a local command makes no provider request
        // under any approval mode, so the line that used to name a "separate
        // safety review" under Auto Approve would now be describing a request
        // that does not happen.
        // The lane was mute in both directions: `/help` wrote a full command
        // listing and announced nothing, so a reader could not tell a completed
        // command from a rejected one. The result's own words are spoken, and
        // an `isError` result says so rather than reporting a completion.
        // Before the ambient line, so the two do not land in one frame.
        narrateTurn(localCommandAnnouncement(
          plan.command.name,
          result.isError ? "failed" : "completed",
          result.content,
        ));
        setRuntimeStatus("Local command complete; no model request made");
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      // `readableLocalFailure`, not the raw throw: a runtime pack that failed to
      // download reached the transcript as a hashed build-asset URL and nothing
      // else. Every sentence the product wrote itself passes through unchanged.
      const raw = error instanceof Error ? error.message : String(error);
      const message = cancelled
        ? "Local command stopped before completion."
        : (await loadTurnRecovery().then(({ readableLocalFailure }) => readableLocalFailure(raw)).catch(() => raw));
      try {
        await append([{ type: "local.command.failed", turnId, operationId, payload: { content: message, toolName: plan.toolName, cancelled } }]);
      } catch {
        // Preserve the original review/execute failure when journal completion also fails.
      }
      if (activeSessionIdentity.current === commandSessionId) {
        settleTurn(cancelled ? "cancelled" : "failed", (item) => ({
          ...item,
          content: message,
          status: undefined,
          error: true,
          history: { turnStatus: cancelled ? "cancelled" : "failed", providerContext: "excluded" },
        }));
        narrateTurn(localCommandAnnouncement(plan.command.name, cancelled ? "stopped" : "failed", message));
        setRuntimeStatus(cancelled ? "Local command stopped" : "Local command failed safely");
      }
    } finally {
      const releasesComposer = activeTurns.current.get(commandSessionId) === controller;
      if (releasesComposer) {
        activeTurns.current.delete(commandSessionId);
        setSessionBusy(commandSessionId, false);
      }
      const updated = await commandRuntime.journal.getSession(commandSessionId);
      if (updated && activeSessionIdentity.current === commandSessionId) setActiveSessionRecord(updated);
    }
  }

  function localPresentationAuthorityIsCurrent(authority: LocalPresentationAuthority): boolean {
    return runtime.current === authority.identityRuntime
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
    // One turn, one disposition: the prompt row carried a hardcoded "completed"
    // while the answer beside it could say "failed".
    const turnStatus = error ? "failed" : "completed";
    setMessages((current) => [
      ...current,
      { id: randomUuid(), role: "user", content: source, history: { turnStatus, providerContext: "excluded" } },
      { id: randomUuid(), role: "assistant", content: boundedTranscriptContent(response), error, status: "Local command · excluded from model context", history: { turnStatus, providerContext: "excluded" } },
    ]);
    // Every built-in command lands here, and every one of them was silent: a
    // rejected `/nonsense-command` and a full `/help` listing produced the same
    // nothing, so the one thing a reader could not do in this lane was tell
    // success from failure.
    narrateTurn(localCommandAnnouncement(spokenCommandName(source), error ? "failed" : "completed", response));
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
        : "This message does not expose a recorded historical boundary yet. Resume the conversation and try again.");
      return;
    }
    // Retry regenerates the turn, so it forks *before* the request. Fail closed
    // rather than silently falling back to `sourcePoint`: on an assistant row
    // that is the post-answer terminal, and a "clean retry" that carried the
    // answer it was replacing would be a false claim, not a degraded one.
    const forkPoint = action === "retry" ? message.turnStartPoint : message.sourcePoint;
    if (!forkPoint) {
      setComposerNotice("This answer does not expose a recorded pre-turn boundary, so Airship did not create a retry branch that still contained the answer it was replacing.");
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
        // Named for the turn it changed, not by appending to the ancestor's
        // name: two branches from two different turns used to arrive with the
        // identical title, and the suffix chain grew a word per operation.
        title: branchTitleFor(
          action === "fork" ? (message.role === "assistant" ? "fork-after-answer" : "fork-before-prompt") : action,
          message.originatingPrompt ?? (message.role === "user" ? message.content : undefined),
          source.title,
        ),
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

  /**
   * The failed turn's one working way forward.
   *
   * Retry forks and regenerates, which is the right verb when a durable pre-turn
   * boundary exists; when the failure happened before one landed, the fork has
   * nothing to cut at and the controls greyed out under a card still reading
   * "Retry is available." This re-issues the recorded prompt into the same
   * conversation, which is exactly what the person was left to do by hand —
   * hover the user bubble, Copy, click the composer, paste, Enter.
   */
  async function resendFailedTurn(message: UiMessage): Promise<void> {
    const prompt = message.originatingPrompt?.trim();
    if (!prompt || busy) return;
    if (message.turnStartPoint && sessionLibrary && activeSessionRecord) {
      await forkFromMessage(message, "retry");
      return;
    }
    await sendMessage(prompt, message.originatingAttachments ?? []);
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

  function setQueuePausedForSession(targetSessionId: string, paused: boolean): void {
    setPausedQueueSessionIds((current) => {
      if (current.has(targetSessionId) === paused) return current;
      const next = new Set(current);
      if (paused) next.add(targetSessionId);
      else next.delete(targetSessionId);
      return next;
    });
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
    // Same rule as Stop and the failure path: never clobber a newer draft the
    // person typed. The queue panel is only on screen while a turn runs, which
    // is exactly when the composer holds the next follow-up — and an
    // attachment-only composer would have been emptied with its object URLs
    // leaked. The queued item is safe where it is, so refuse and say so rather
    // than trade an unsent draft for it with no undo.
    if (input.trim() || attachments.length) {
      setComposerNotice("Clear or queue the composer before editing a queued message");
      return;
    }
    // No `setQueuePausedForSession` here. Pulling an item back into the
    // composer is not a send, and an explicit send is the only thing that lifts
    // a Stop; resuming here dispatched the very queued turns the reader had
    // pressed Stop to prevent.
    removeQueuedMessage(sessionId, item.id);
    setInput(item.prompt);
    setAttachments(item.attachments);
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function sendQueuedMessageNow(item: QueuedComposerItem): void {
    if (!sessionId || busy) return;
    setQueuePausedForSession(sessionId, false);
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
      setComposerNotice(composerAttachmentNeedsText());
      return false;
    }
    if (
      !content
      || !runtime.current
      || !sessionId
      || busy
      || activeTurns.current.has(sessionId)
      || localCommandAdmission.current
      || inferenceRouteChanging.current
      || vaultProviderSwitchingRef.current
      || localDeviceBusy
    ) return false;
    // These two latches are the ones with no mirror on the surface:
    // `composerTransitionPending` covers the route, Vault and local-device
    // transitions, so Send is disabled and Enter names the wait for those. A
    // conversation fork or a Profile storage change left Send enabled, the
    // legend still reading "↵ send", and Enter doing nothing whatsoever. It is
    // the same wait as the authority mismatch below, so it is the same
    // sentence.
    if (sessionNavigationChanging.current || catalogAuthorityChanging.current) {
      setComposerNotice("Wait for the active Profile and conversation to finish binding before sending.");
      return false;
    }
    const ambientRuntime = runtime.current;
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
    const admissionRuntime = runtimeForSessionRecord(ambientRuntime, activeSessionRecord);
    // An explicit send is the only thing that lifts a Stop. Placed past every
    // admission bail so a refused send does not silently resume the queue, and
    // scoped to non-queue sends so automatic dispatch can never clear its own
    // latch.
    if (!queue) setQueuePausedForSession(admissionSessionId, false);
    const localPresentationAuthority = Object.freeze({
      identityRuntime: ambientRuntime,
      commandRuntime: admissionRuntime,
      profileId: admissionProfile.profileId,
      profileRevision: admissionProfile.revision,
      sessionId: admissionSessionId,
    });
    if (slashRegistry && slashModule) {
      const slashPlan = slashModule?.planSlashCommand(content, slashRegistry);
      /*
       * The demo's teaching verbs are not product commands: /reason is the
       * prompt the demo's own help lists to demonstrate reasoning, and the
       * demo's inference lane owns it. When the composer is the demo and the
       * planner can only answer "unknown slash command", that verdict is not
       * a refusal — the prompt falls through to inference, where the demo
       * answers it. At a real inference connection the verdict still stands,
       * because nothing beyond the registry would take it.
       */
      const unknownSlashDemoPrompt = slashPlan.kind === "invalid"
        && slashPlan.code === "unknown-command"
        && !inferenceConnected;
      /* …and `composerUsesDemo` would be the wrong authority here: it reads
         `composerPlan`, whose "invalid" verdict on an unknown-ish prompt
         would turn the demo flag off precisely when the prompt is one of
         the demo's teaching verbs. The gate is the connection instead. */
      if (slashPlan.kind !== "chat" && !unknownSlashDemoPrompt) {
        // Local built-ins do not all create an AbortController. Keep a separate
        // synchronous admission lock so duplicate click/key events in one
        // render cannot create two sessions, forks, or local transcript rows.
        localCommandAdmission.current = true;
        setInput("");
        try {
          await runSlashPlan(slashPlan, content, localPresentationAuthority);
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          appendLocalExchangeForAuthority(
            localPresentationAuthority,
            content,
            await loadTurnRecovery().then(({ readableLocalFailure }) => readableLocalFailure(raw)).catch(() => raw),
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
      content = slashPlan.kind === "chat" ? slashPlan.content.trim() : content;
      if (!content) {
        // Same wedge as above for a plan rewritten to nothing: the item can
        // never become a turn, so a queued head has to leave the queue here.
        queue?.onAdmitted();
        return false;
      }
    }
    const turnSessionId = admissionSessionId;
    const turnRuntime = admissionRuntime;
    // The turn runtime projects the conversation's durable model onto the
    // live connection without changing the Profile default for new sessions.
    const turnTransport = turnRuntime.transport;
    const turnProfileId = admissionProfile.profileId;
    const turnProfileRevision = admissionProfile.revision;
    const turnAuthorityStillCurrent = () => (
      runtime.current === ambientRuntime
      && profileAuthorityId.current === turnProfileId
      && activeProfileRef.current?.revision === turnProfileRevision
      && (!sessionNavigationChanging.current || sessionResumeDuringTurn.current === turnSessionId)
    );
    const externalPreflight = turnRuntime.inferenceBinding
      ? resolveExternalInferencePreflight(
          turnRuntime.inferenceBinding,
          activeExternalRouteRef.current,
          inferenceFabric.current,
        )
      : undefined;
    if (externalPreflight && externalPreflight.state !== "ready") {
      setComposerNotice(`${externalPreflight.detail} This conversation remains read-only; reconnect its exact provider connection to continue. Your prompt remains here.`);
      setRuntimeStatus("Pinned inference route unavailable · prompt preserved");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    if (turnRuntime.inferenceBinding && !inferenceConnected) {
      setComposerNotice("This conversation is permanently pinned to a released inference generation and remains read-only. Reconnect its exact provider connection in Providers to continue; your prompt, messages, journal, and workspace remain here.");
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
    activeTurns.current.set(turnSessionId, controller);
    activePrompts.current.set(turnSessionId, content);
    setSessionBusy(turnSessionId, true);
    // The channel is claimed here, at the moment the turn is admitted and the
    // composer swaps Send for Stop turn. Claiming it later left the shell's
    // ambient line ("Preparing turn", then "Persisting turn intent") landing in
    // the same animation frame as the sentence about the model working — the
    // same two-regions-one-frame collision, moved to the start of the turn.
    narrateTurn(workingAnnouncement(true));
    setRuntimeStatus("Preparing turn");
    const releasePreflight = () => {
      if (activeTurns.current.get(turnSessionId) !== controller) return;
      activeTurns.current.delete(turnSessionId);
      if (activePrompts.current.get(turnSessionId) === content) activePrompts.current.delete(turnSessionId);
      setSessionBusy(turnSessionId, false);
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
      const refusal = controller.signal.aborted
        ? "Turn stopped before inference; your prompt remains in the composer."
        : error instanceof Error ? error.message : "The selected image could not be prepared safely.";
      setComposerNotice(refusal);
      // The channel already said Airship was answering. A turn admitted and
      // then refused has to retract that, not leave it as the last word.
      narrateTurn(controller.signal.aborted ? stoppedAnnouncement() : failureAnnouncement(refusal));
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    if (!turnAuthorityStillCurrent()) {
      controller.abort(new DOMException("Profile or conversation authority changed.", "AbortError"));
      releasePreflight();
      const refusal = "The Profile or conversation changed while the turn was being prepared. Your prompt remains in the active draft.";
      setComposerNotice(refusal);
      narrateTurn(failureAnnouncement(refusal));
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    if (turnRuntime.inferenceBinding) {
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
          + "This conversation is now read-only; reconnect its exact provider connection to continue. Your prompt and attachments remain here.",
        );
        setRuntimeStatus("Pinned inference route unavailable · prompt preserved");
        requestAnimationFrame(() => textarea.current?.focus());
        return false;
      }
    }
    /*
     * Compute the local title synchronously, but do not write it yet. Naming is
     * presentation-only and must never open an async gap between exact-route
     * preflight and turn admission. `runTurnBeforeNaming` starts this write
     * only after the authority-checked turn has completed durably.
     */
    const firstMessageNaming = (
      !retryPrompt
      && activeSessionRecord?.id === turnSessionId
      && activeProfile
      && isAppMintedConversationTitle(activeSessionRecord.title, activeProfile.name)
    ) ? Object.freeze({
      title: conversationTitleFromPrompt(content),
      profileName: activeProfile.name,
    }) : undefined;

    if (controller.signal.aborted) {
      releasePreflight();
      setRuntimeStatus("Turn stopped before submission");
      requestAnimationFrame(() => textarea.current?.focus());
      return false;
    }
    /*
     * The queue head leaves the durable queue when the turn it became is
     * durable — never at admission. An armed "open after turn" can abort a
     * freshly admitted turn between this gate and the journal's own
     * turn.requested append, and until now the item was already struck from
     * the queue when that happened: no bubble, no turn, no notice — typed
     * input silently gone on exactly the multi-tasking path the queue exists
     * for. "What persists" is the one question this product may never answer
     * with "nothing did."
     */
    let queueAdmitted = queue === undefined;
    const admitQueuedTurn = () => {
      if (queueAdmitted) return;
      queueAdmitted = true;
      queue?.onAdmitted();
    };
    if (retryPrompt === undefined) {
      setInput("");
      setAttachments([]);
    }
    setComposerNotice(undefined);
    setSessionBusy(turnSessionId, true);
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
    /*
     * Client-minted only until the journal issues this turn an id, at which
     * point `adoptJournalTurnAddress` below re-addresses the row and its
     * streams to `message:<turnId>:assistant` — the id
     * `presentSessionMessages` rebuilds this row under. Everything that reaches
     * for the row afterwards reads this binding, so it is `let`, not `const`.
     */
    let assistantId = randomUuid();
    let turnRequestBoundary: Readonly<{ sequence: number; digest: string }> | undefined;

    /**
     * Re-address the in-flight row from the optimistic id to the journal's.
     *
     * The bug this closes: leaving the row under a client uuid meant that
     * stepping into another conversation mid-turn and stepping back lost the
     * answer entirely. Coming back re-projects the transcript from the
     * journal, which *does* render the running turn — `presentSessionMessages`
     * emits a row per turn group whether or not it has terminated — but under
     * `message:<turnId>:assistant`, while the deltas still streamed into a slot
     * keyed by a uuid that no longer addressed anything on screen. Every
     * `setMessages` that reached for `assistantId` then matched no row, so the
     * answer never landed and the thread sat there looking hung until a
     * reload. Adopting the journal's address makes the live row and the
     * re-projected row the same row, and the streams follow it.
     *
     * Fires once, on the first `turn.requested`, which lands before any
     * inference — so in practice the slots are still empty and this is a
     * rename of nothing. `TranscriptStreamStore.rename` carries content anyway
     * rather than depend on that.
     */
    function adoptJournalTurnAddress(turnId: string): void {
      const journalId = `message:${turnId}:assistant`;
      if (journalId === assistantId) return;
      const optimisticId = assistantId;
      transcriptStreams.rename(optimisticId, journalId);
      reasoningStreams.rename(optimisticId, journalId);
      if (pendingDelta.current?.messageId === optimisticId) pendingDelta.current = { messageId: journalId, text: pendingDelta.current.text };
      if (pendingReasoning.current?.messageId === optimisticId) pendingReasoning.current = { messageId: journalId, text: pendingReasoning.current.text };
      if (pendingToolOutput.current?.messageId === optimisticId) pendingToolOutput.current = { messageId: journalId, updates: pendingToolOutput.current.updates };
      assistantId = journalId;
      liveTurnRow.current = { sessionId: turnSessionId, messageId: journalId, status: "Queued" };
      setMessages((current) => current.map((message) => message.id === optimisticId
        ? { ...message, id: journalId }
        : message));
    }
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
      const result = await runTurnBeforeNaming(() => runTurn({
        sessionId: turnSessionId,
        content,
        ...(images?.length ? { images } : {}),
        transport: turnTransport,
        ...(turnRuntime.inferenceBinding
          ? { activeInferenceBinding: turnRuntime.inferenceBinding }
          : {}),
        tools: turnRuntime.tools,
        journal: turnRuntime.journal,
        /* The Profile-scoped port, and the only one tools may see. The prime
           lane composes its own vocabulary over it; airship-core ignores it,
           because its registry already closed over the same workspace. */
        workspace: turnRuntime.workspace,
        /* The turn's own conversation's delegate — not the visible one's.
           This is the binding that lets two threads run under two different
           approval modes without either deciding for the other. */
        approvalPolicy: sessionApprovalPolicy(turnSessionId),
        signal: controller.signal,
        maxSteps: 32,
        onSignal(signal) {
          if (signal.type === "durable") {
            // The queue head is struck exactly when its turn is durable, and
            // only then (see the admission comment above).
            if (!queueAdmitted && signal.events.some((event) => event.type === "turn.requested")) {
              queueAdmitted = true;
              queue?.onAdmitted();
            }
            const reachedAssistantBoundary = signal.events.some((event) => event.type === "assistant.completed");
            if (reachedAssistantBoundary) clearPendingDelta(assistantId);
            /*
             * The handoff. `turn.reasoning` is journaled once per step, and
             * from that moment the durable `reasoning-summary` part carries
             * that step's thinking in its right place in the sequence. Holding
             * the live buffer too would render the same thought twice — once
             * in position and once at the tail — and a multi-step turn would
             * accumulate every earlier step's reasoning under the newest one.
             */
            if (signal.events.some((event) => event.type === "turn.reasoning")) {
              clearPendingReasoning(assistantId);
            }
            // Held from the live signal because a failed turn never returns a
            // result to read it from, and this is the boundary Retry forks at.
            if (!turnRequestBoundary) {
              const requested = signal.events.find((event) => event.type === "turn.requested" && event.sessionId === turnSessionId);
              if (requested) {
                turnRequestBoundary = Object.freeze({ sequence: requested.sequence - 1, digest: requested.previousDigest });
                /* `turnId` is optional on the durable-event shape; a
                   `turn.requested` without one is not a turn this row can be
                   re-addressed to, so the optimistic id simply stands. */
                if (requested.turnId) adoptJournalTurnAddress(requested.turnId);
              }
            }
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
          if (signal.type === "status") {
            /* Recorded even while another conversation is on screen: it is
               what the reattach effect restores onto the re-projected row, so
               a thread you step back into is live again immediately rather
               than at whatever moment the next status happens to fire. */
            if (liveTurnRow.current?.sessionId === turnSessionId) {
              liveTurnRow.current = { ...liveTurnRow.current, status: humanStatus(signal.status) };
            }
            if (activeSessionIdentity.current === turnSessionId) {
              setRuntimeStatus(signal.status);
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId ? { ...message, status: humanStatus(signal.status) } : message,
                ),
              );
            }
          }
          /*
           * Unfenced, like the reasoning signal below, and this is the half of
           * the switch-away defect that was losing text rather than misfiling
           * it. Fenced on the active session, every delta that arrived while
           * the reader was in another thread was dropped on the floor — so
           * even once the row was addressed correctly, coming back showed only
           * whatever happened to stream *after* the return. This writes a slot
           * store keyed by a message id this turn owns; it never touches the
           * `messages` array the visible conversation is rendering from.
           */
          if (signal.type === "text-delta") {
            queueTextDelta(assistantId, signal.text);
          }
          /*
           * Unfenced, unlike the text and tool-output signals above. Those
           * write `messages`, which belongs to whichever conversation is on
           * screen; this writes a slot store keyed by a message id that only
           * this turn owns, so a reader who steps into another thread mid-turn
           * comes back to the reasoning that arrived while they were gone
           * instead of to a gap. Cleared with the turn in the `finally`.
           */
          if (signal.type === "reasoning-delta") {
            queueReasoningDelta(assistantId, signal.text);
          }
          if (signal.type === "tool-output" && activeSessionIdentity.current === turnSessionId) {
            queueToolOutput(assistantId, signal);
          }
        },
      }), async () => {
        if (!firstMessageNaming) return;
        const latest = await turnRuntime.journal.getSession(turnSessionId);
        if (!latest || !isAppMintedConversationTitle(latest.title, firstMessageNaming.profileName)) return;
        const renamed = await turnRuntime.journal.renameSession(
          turnSessionId,
          firstMessageNaming.title,
          controller.signal,
        );
        if (activeSessionIdentity.current === turnSessionId) {
          setActiveSessionRecord(renamed);
          setEventCount((count) => count + 1);
          setSessionRevision((value) => value + 1);
        }
        // Naming is local and follows the completed turn, so it cannot create
        // an admission race or a second provider request.
      });
      /*
       * Retire the live row here, where the turn stopped being live — not in
       * the `finally`, which runs after the settle commit below.
       *
       * The reattach effect restores a running turn's status onto a row that
       * came back from the journal without one. At settle the order was:
       * commit `status: undefined`, effect runs on that very commit with
       * `busy` still true and this ref still set, sees a row with no status,
       * and helpfully puts the status back. Nothing cleared it a second time,
       * so every finished answer kept its three streaming dots and its last
       * status line — "Finalizing run details" — spinning under it for the rest of
       * the session.
       */
      if (liveTurnRow.current?.messageId === assistantId) liveTurnRow.current = undefined;
      clearPendingDelta(assistantId);
      // Flush before the terminal stamp: it settles `liveToolOutput` away, and
      // a surviving buffered frame would otherwise re-add it after settlement.
      flushPendingToolOutput();
      if (activeSessionIdentity.current === turnSessionId) {
        const requestEvent = result.events.find((event) => event.type === "turn.requested" && event.turnId === result.turnId);
        const terminalEvent = result.events.filter((event) => event.turnId === result.turnId && (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled")).at(-1);
        const settledParts = messagePartsFromDurableEvents(result.events, { turnId: result.turnId });
        // Spoken from what settled, not from the stream buffer: the demo and
        // every non-streaming provider fill no buffer, which is why the arrival
        // sentence carried no words on the default path.
        narrateTurn(arrivalAnnouncement(result.content || messagePlainText(settledParts)));
        setMessages((current) =>
          current.map((message) =>
            message.id === userMessageId && requestEvent
              ? { ...message, sourcePoint: { sequence: requestEvent.sequence - 1, digest: requestEvent.previousDigest } }
              : message.id === assistantId
              ? {
                  ...message,
                  content: result.content,
                  parts: settledParts,
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
          announceCompletedTurnAwayFromChat();
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
      // Same retirement as the settle path, and for the same reason: the
      // failure commit below clears the row's status, and the reattach effect
      // would otherwise restore it onto a turn that has already ended badly.
      if (liveTurnRow.current?.messageId === assistantId) liveTurnRow.current = undefined;
      const pending = `${transcriptStreams.read(assistantId)}${pendingDelta.current?.messageId === assistantId ? pendingDelta.current.text : ""}`;
      clearPendingDelta(assistantId);
      flushPendingToolOutput();
      const cancelled = controller.signal.aborted;
      // The whole classification, not only its sentence: `turn-recovery` owns a
      // cause vocabulary — rate limit, provider usage limit, access rejected, provider
      // unreachable — and passing it nothing meant every failure over a working
      // connection closed on "Turn failed", the one cause it could still not
      // have been. An import that does not land still degrades to the
      // unclassified footer rather than losing the card's sentence.
      const mapped = cancelled
        ? undefined
        : await import("./request-state")
          .then(({ mapUnknownRequestFailure }) => mapUnknownRequestFailure(error, online))
          .catch(() => undefined);
      const failureMessage = cancelled
        ? "Turn stopped"
        : mapped?.message ?? "Request failed. Local state was kept; no remote success is assumed.";
      const recovery = await loadTurnRecovery().catch(() => undefined);
      if (activeSessionIdentity.current === turnSessionId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  // Without the recovery module the card has no error part to
                  // carry the sentence, so the body carries it instead.
                  content: recovery ? "" : failureMessage,
                  // The pre-turn boundary, stamped on the failure path too.
                  // Only the success path stamped it, so a failed turn's Retry
                  // and Fork were disabled beneath a card that read "Retry is
                  // available." — the product treating its own failure as less
                  // recoverable than a completed turn.
                  ...(turnRequestBoundary ? { sourcePoint: turnRequestBoundary, turnStartPoint: turnRequestBoundary } : {}),
                  parts: recovery
                    ? recovery.recoverPartialTurn(message.parts ?? [], "", pending, cancelled, mapped?.kind, Boolean(turnRequestBoundary || message.originatingPrompt))
                    : message.parts,
                  status: undefined,
                  liveToolOutput: undefined,
                  error: true,
                }
              : message.id === userMessageId && turnRequestBoundary
              ? { ...message, sourcePoint: turnRequestBoundary }
              : message,
          ),
        );
        // Spoken from the most specific sentence that exists. The topbar's
        // mapped vocabulary ("Request failed. Local state was kept…") is a
        // classification; the thrown diagnostic is what the card shows, and a
        // reader who cannot see the card should hear the same cause.
        narrateTurn(cancelled
          ? stoppedAnnouncement()
          : failureAnnouncement(turnFailureCause(error) ?? failureMessage));
        setRuntimeStatus(failureMessage);
        // A failure is not less worth recovering than a deliberate Stop, which
        // has always restored the prompt. Same rule as Stop: never clobber a
        // newer draft the person typed while the turn was running.
        setInput((current) => current.trim() ? current : content);
      }
    } finally {
      /* The turn is over however it ended, so the live reasoning block hands
         the row back to the durable `reasoning-summary` part projected from
         `turn.reasoning`. Both paths above have already committed their
         messages, so this cannot blank a row that has nothing to replace it. */
      clearPendingReasoning(assistantId);
      /* Settled turns are the journal's to render. Cleared after the commits
         above so the reattach effect cannot re-mark a finished row live, and
         only if this turn is still the one it names — a newer turn in another
         thread owns the slot by then. */
      if (liveTurnRow.current?.messageId === assistantId) liveTurnRow.current = undefined;
      const releasesComposer = activeTurns.current.get(turnSessionId) === controller;
      if (releasesComposer) {
        activeTurns.current.delete(turnSessionId);
        if (activePrompts.current.get(turnSessionId) === content) activePrompts.current.delete(turnSessionId);
      }
      releaseComposerAndReloadSession({
        release: () => { if (releasesComposer) setSessionBusy(turnSessionId, false); },
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
    // then persisted the overwrite. Restore only into an empty composer —
    // and only the composer of the conversation the turn runs in. Stop can be
    // pressed from a different thread mid-flight, and the abort's own prompt
    // parked onto that thread's draft was never anyone's intent; the stopped
    // turn's transcript keeps the prompt as its durable record instead.
    const stoppingSessionId = activeSessionIdentity.current ?? sessionId;
    const stoppingPrompt = stoppingSessionId ? activePrompts.current.get(stoppingSessionId) : undefined;
    if (stoppingPrompt) {
      setInput((current) => current.trim() ? current : stoppingPrompt);
    }
    // Latch before the abort: the abort's teardown is what frees `busy`, and
    // the queue effect runs on that same commit.
    if (stoppingSessionId) setQueuePausedForSession(stoppingSessionId, true);
    abortSessionTurn(stoppingSessionId, new DOMException("Stopped by user", "AbortError"));
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

  /**
   * Export the existing authority even while its runtime is not adopted.
   *
   * A stale object store can outlive the browser-profile key handle after a
   * partial site-data clear. In that state the replacement ceremony must not
   * guess at ciphertext or silently discard it: only an enrolled key may open
   * a temporary runtime and produce the encrypted backup required by the UI.
   */
  async function exportExistingLocalDeviceBackup(): Promise<Uint8Array> {
    const active = localDeviceHandle.current;
    if (active) return active.exportEncryptedBackup();
    const [{ openLocalDeviceWorkspaceKey }, { openLocalDeviceVault }] = await Promise.all([
      import("../storage/local-device-keyring"),
      loadDeferredCapabilities(),
    ]);
    const enrolled = await openLocalDeviceWorkspaceKey({ partition: LOCAL_DEVICE_PARTITION });
    if (!enrolled) {
      // Named so the setup surface can flip to its keyless-authority stage
      // instead of presenting an export failure it can never recover from.
      const missing = new Error("Recover the existing Vault with its saved recovery key before downloading a replacement backup.");
      missing.name = "LocalDeviceEnrollmentMissingError";
      throw missing;
    }
    const temporary = await openLocalDeviceVault({
      partition: LOCAL_DEVICE_PARTITION,
      workspaceKey: enrolled.key,
      disposition: "open-existing",
      displayName: "Airship on this device",
    });
    try {
      return await temporary.exportEncryptedBackup();
    } finally {
      await temporary.closeAndWait();
    }
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
      const quiescing = [...activeTurns.current.values()];
      abortAllTurns(new DOMException("Local Device Vault restore started.", "AbortError"));
      const publication = vaultContextPublication.current;
      publication?.abort(new DOMException("Local Device Vault restore started.", "AbortError"));
      await waitForOperationRelease(
        // Every turn that was running when the restore started, not just one:
        // the restore replaces the workspace under all of them.
        () => quiescing.every((turn) => ![...activeTurns.current.values()].includes(turn))
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
      setRuntimeStatus(`Encrypted backup restored · ${String(result.restored)} objects checked`);
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
    // Named before the switch, because after it this conversation is no longer
    // the one on screen: the Atlas measured an 11-event thread replaced with no
    // notice, no confirmation and nothing on the new screen that named it.
    const leaving = activeSessionRecord?.title;
    void createConversation("Capability command").then((created) => {
      if (!created) {
        setRuntimeStatus("Finish the current operation before opening a capability conversation");
        return;
      }
      preserveComposerForDraftIdentity.current = created.id;
      setInput(command);
      setComposerNotice(leaving
        ? `New conversation, because a capability command pins its own runtime. The command is ready below — send it to run it. “${leaving}” is untouched; reopen it from the conversation switcher beside the title.`
        : "New conversation, because a capability command pins its own runtime. The command is ready below — send it to run it.");
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
   * no evidence at all; and no abort, so a broker request outlived the screen
   * that asked for it. Human actions stay under human authority in every mode.
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

  /**
   * Remembering and forgetting from the route that shows the corpus.
   *
   * The only way to write a memory was `/update-memory --json '{…}'` typed into
   * the composer, and the only way to delete one was to find its id inside a
   * per-hit provenance popover and type the command again. This is the same
   * tool with the same approval, asked for by a button: the definition comes
   * from the live registry rather than being synthesised here, so the dock
   * derives its consequence panel from the real schema, and the decision is
   * journaled by `reviewHumanIntent` exactly as the command's would be.
   *
   * Only what the tool itself said travels back as `message`. The wording for
   * a refusal or an unbound session belongs to the route that shows it, and it
   * is written in the route's own deferred chunk — first-paint bytes are not
   * where copy for the Memory surface lives.
   */
  async function commitMemoryChange(change: MemoryChange): Promise<MemoryCommitOutcome> {
    const active = runtime.current;
    const authoritySessionId = activeSessionIdentity.current ?? sessionId;
    const tool = active?.tools.get("update_memory");
    if (!active || !authoritySessionId || !tool) return Object.freeze({ status: "unbound" });
    const argumentsValue: JsonValue = change.action === "remember"
      ? { action: "remember", content: change.content, source: change.source }
      : { action: "forget", id: change.id };
    const turnId = `human-memory-${randomUuid()}`;
    const operationId = `memory-${randomUuid()}`;
    const decision = await reviewHumanIntent(tool.definition, argumentsValue, { turnId, operationId });
    if (decision === "deny") return Object.freeze({ status: "denied" });
    const controller = new AbortController();
    try {
      const response = await tool.execute(argumentsValue, {
        sessionId: authoritySessionId,
        turnId,
        operationId,
        signal: controller.signal,
      });
      if (response.isError) return Object.freeze({ status: "failed", message: response.content });
      await refreshWorkspacePresentation();
      return Object.freeze({ status: "committed", message: response.content });
    } catch (error) {
      return Object.freeze({ status: "failed", ...(error instanceof Error ? { message: error.message } : {}) });
    } finally {
      controller.abort();
    }
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
  ): Promise<string> {
    const { ready, workspaceId } = authority;
    const prior = runtime.current;
    const priorCheckpoint = catalogCheckpoint.current;
    /** The one session, if any, whose transcript could not be replayed. */
    let quarantined: QuarantinedSession | undefined;
    /** What the page-memory journal handed over, for the landing screen to state. */
    let adoptionCarried: AdoptionCarriedWork | undefined;
    if (!prior || !priorCheckpoint || !activeProfile || !gitClient) {
      throw new Error("The active browser runtime is not ready for vault adoption.");
    }
    abortAllTurns(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus(authority.kind === "local-device"
      ? "Opening encrypted device state"
      : "Migrating workspace and sessions into encrypted cloud objects");
    const [{ adoptionCarriedNote, migrateJournalState, migrateProfileCatalogState, migrateWorkspaceState, readAdoptionCarriedWork, reconcileAdoptedProfileCatalog }, { quiesceBrowserTerminalWorkspace }] = await Promise.all([
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
      if (!pristineBootstrap) {
        // Read before the copy runs, so the screen the person lands on can say
        // what came with them and what did not. `adoptionCarriedNote` carries
        // the measurement this answers (J110).
        adoptionCarried = await readAdoptionCarriedWork(prior.journal, activeProfile.profileId);
        await migrateJournalState(prior.journal, ready.journal);
      }
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
      webEgress: resolveProfileWebEgress(selectedProfile),
      webBodies: resolveProfileWebBodies(selectedProfile),
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
    /*
     * The whole shelf, not only its top row.
     *
     * A person who closed the tab on an unanswered approval came back to a
     * brand-new empty conversation while a fully resumable 14-event sibling sat
     * in the same list: adoption asked for exactly one candidate, and when that
     * one refused to replay it minted a new conversation instead of trying the
     * next. Reopening is not resuming.
     */
    const candidateSessions = pristineBootstrap
      ? await compatibleProfileSessions(nextRuntime, profile, nextCatalog)
      : Object.freeze([]);
    let resumableSession: SessionRecord | undefined;
    let resumedPresentation: Readonly<{
      messages: readonly UiMessage[];
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
    for (const candidateSession of candidateSessions) {
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
        if (sessionAuditRefusesResume(audit)) {
          throw new Error("The latest encrypted session failed its digest/protocol audit and was not resumed.");
        }
        // Past this line the history is admissible. `historyVerified` still
        // means *verified* and not merely admissible, so an incomplete audit —
        // an unfinished turn, a record from a newer build — reports itself
        // honestly instead of borrowing a claim it did not earn.
        historyVerified = audit.status === "verified";
        const presentation = presentSessionMessages({
          session: candidateSession,
          audit,
          events: boundedSessionPresentationEvents(events),
          receipts: detail.transcript.receipts,
          history: presentationHistory(detail.transcript.messages),
        });
        const messages = transcriptMessagesFromPresentation(presentation);
        resumedPresentation = Object.freeze({
          messages: Object.freeze(messages),
          lifecycle: detail.transcript.lifecycle,
          ...(detail.transcript.truncated ? {
            boundary: Object.freeze({
              omittedMessages: detail.transcript.omittedMessages,
              shortened: detail.transcript.messages.some((message) => message.truncated),
            }),
          } : {}),
        });
        resumableSession = candidateSession;
        break;
      } catch (error) {
        const { describeSessionPresentationFault } = await loadDeferredCapabilities();
        // The conversation the person was last in is the one they will look
        // for, so its failure is the one reported even if a later candidate
        // succeeds. Anything further down the shelf is a record the session
        // library already marks; naming a second one here would replace the
        // answer to "where did my work go" with a list.
        quarantined ??= Object.freeze({
          sessionId: candidateSession.id,
          title: candidateSession.title,
          reason: describeSessionPresentationFault(error),
          historyVerified,
        });
        resumedPresentation = undefined;
      }
    }
    const nextSession = resumableSession ?? await createProfileSession(
      nextRuntime,
      profile,
      nextCatalog,
      appMintedConversationTitle(profile.name, "vault"),
    );

    workspaceRefreshCoordinator.invalidate();
    // The storage authority changed, so every cached Profile authority is over
    // the previous one and must not be reused.
    profileAuthorities.current.clear();
    runtime.current = nextRuntime;
    rememberProfileAuthority(nextRuntime, nextGitClient, resolveProfileWebEgress(profile), resolveProfileWebBodies(profile));
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
            : `${authority.kind === "local-device"
              ? "The encrypted Local Device Vault is active. This new pinned session writes workspace files, explicit memories, task state, and session events as encrypted browser-managed objects that remain available offline."
              : "The Vault storage checks passed and its encrypted adapters are now active. This new pinned session writes workspace files, explicit memories, task state, and session events as client-encrypted cloud objects; the previous page-memory sessions were migrated and remain separately inspectable."
            }${adoptionCarriedNote(adoptionCarried)}`,
        }]);
    setEventCount(activated.headSequence);
    setQuarantinedSession(quarantined);
    setSessionRevision((value) => value + 1);
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
    /*
     * The quarantine is named, and its explanation is left where it renders.
     *
     * This line used to carry the whole forensic account — title, short id,
     * `quarantined.reason`, the history verdict and a raw
     * `LOCAL_COMMAND_INCOMPLETE: Client-only local command local-command-70aa…`
     * — 470 characters in a single-line chip that draws about sixty of them
     * before ellipsis, with no expansion affordance and roughly two words of
     * room on a phone. The Atlas is blunt about it: handing a person a raw
     * internal identifier in a truncated chip is not disclosure.
     *
     * Every one of those strings already renders in full on `#sessions`, in the
     * quarantine panel that `setQuarantinedSession` below feeds — verbatim
     * reason, the "WHY THE RUNTIME DECIDED THAT" table and the history verdict.
     * So this states the fact and names that destination, which is the whole of
     * what a status line can honestly do.
     */
    setRuntimeStatus(quarantined
      ? `${authority.label} active · “${quarantined.title}” could not be replayed — open All conversations for the reason · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`
      : resumableSession
        ? `${authority.label} active · audited session resumed · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`
        : `${authority.label} active · ${contextLabel}${workspaceRefreshDeferred ? " · file view refresh due" : ""}`);
    return profile.profileId;
  }

  async function publishEncryptedContextIndex(): Promise<void> {
    if (vaultContextPublication.current || vaultContextPublishing) return;
    if (anyTurnRunning || activeTurns.current.size > 0) {
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
      setVaultContextPublicationMessage("Activate an encrypted Vault before publishing context shards.");
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
    catalogAuthorityChanging.current = true;
    try {
      await catalogMutationTail.current;
      await adoptEphemeralRuntimeExclusive();
    } finally {
      catalogAuthorityChanging.current = false;
    }
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
    abortAllTurns(new DOMException("Workspace durability is changing.", "AbortError"));
    setRuntimeStatus("Moving the active encrypted state into page memory");
    const [{ migrateJournalState, migrateWorkspaceState }, { quiesceBrowserTerminalWorkspace }] = await Promise.all([
      loadDeferredCapabilities(),
      import("../terminal/manager"),
    ]);
    await quiesceBrowserTerminalWorkspace(
      prior.workspace,
      "Storage authority changed to page memory. Restart this terminal against the adopted workspace.",
    );
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
      webEgress: resolveProfileWebEgress(activeProfile),
      webBodies: resolveProfileWebBodies(activeProfile),
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
    const nextSession = await createProfileSession(nextRuntime, profile, nextCatalog, appMintedConversationTitle(profile.name, "ephemeral"));

    workspaceRefreshCoordinator.invalidate();
    profileAuthorities.current.clear();
    runtime.current = nextRuntime;
    rememberProfileAuthority(nextRuntime, nextGitClient, resolveProfileWebEgress(profile), resolveProfileWebBodies(profile));
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

  /*
   * The vault danger zone, in one action.
   *
   * "Wipe" means exactly what the route says per provider: page memory
   * reloads (that IS the wipe — ephemeral state exists no place else), the
   * device vault's whole store is trashed (the identity anchor survives by
   * design, so the vault reopens empty rather than "corrupt"), and an S3 or
   * Drive vault purges its namespace through the coordinator's own sited
   * listing. A reload ends either way: an adopted runtime pointing at an
   * emptied store is a contradiction nobody should be asked to live in.
   */
  async function wipeVaultStorage(): Promise<void> {
    const backend = preferences.vaultBackend;
    let temporaryLocalDeviceHandle: LocalDeviceVaultHandle | undefined;
    setVaultWipeBusy(true);
    /*
     * The continuity records go with the objects they describe.
     *
     * Every branch below ends in a reload, and the return ledger learns that a
     * conversation is gone by finding it absent from the journal — so before
     * this, the reload at the end of a wipe came back and mourned every
     * conversation the person had just chosen to destroy. Retired here, ahead
     * of the reload and ahead of the wipe itself, because a wipe that half
     * fails must not leave records claiming work is missing when it is not:
     * an empty ledger reports nothing, which is the honest answer either way
     * once a person has asked for a wipe.
     */
    const retireContinuityRecords = async (): Promise<void> => {
      try {
        const { clearReturnLedger } = await loadReturnLedger();
        const storage = browserReturnLedgerStorage();
        if (storage) clearReturnLedger(storage);
      } catch {
        // Same rule as deletion: a record that cannot be retired stays.
      }
    };
    try {
      await retireContinuityRecords();
      if (backend === "ephemeral") {
        location.reload();
        return;
      }
      if (backend === "local-device") {
        let handle = localDeviceHandle.current;
        if (!handle) {
          const [{ openLocalDeviceWorkspaceKey }, { destroyLocalDeviceAuthority, openLocalDeviceVault }] = await Promise.all([
            import("../storage/local-device-keyring"),
            loadDeferredCapabilities(),
          ]);
          const enrolled = await openLocalDeviceWorkspaceKey({ partition: LOCAL_DEVICE_PARTITION });
          if (!enrolled) {
            // Keyless authority: the person lost every key copy this browser
            // ever held, so nothing here is recoverable and the backup step
            // cannot exist — it is encrypted under the very key that is gone.
            // Destruction is the honest verb left, and it needs no key.
            const destruction = await destroyLocalDeviceAuthority(LOCAL_DEVICE_PARTITION);
            if (!destruction.destroyedAuthority) {
              throw new Error("No existing Local Device Vault was found; nothing was destroyed.");
            }
            const enumerated = destruction.backends
              .filter((backend) => typeof backend.records === "number")
              .reduce((sum, backend) => sum + Number(backend.records), 0);
            setRuntimeStatus(
              destruction.backends.every((backend) => typeof backend.records === "number")
                ? `Destroyed the existing Local Device Vault (${enumerated.toLocaleString()} encrypted records).`
                : "Destroyed the existing Local Device Vault.",
            );
            location.reload();
            return;
          }
          temporaryLocalDeviceHandle = await openLocalDeviceVault({
            partition: LOCAL_DEVICE_PARTITION,
            workspaceKey: enrolled.key,
            disposition: "open-existing",
            displayName: "Airship on this device",
          });
          handle = temporaryLocalDeviceHandle;
        }
        const store = handle.runtime.store;
        if (!isReclaimableObjectStore(store)) {
          throw new Error("This Vault cannot reclaim objects, so nothing was wiped.");
        }
        const objects = await store.list("");
        const receipt = await store.trash(objects.map((object) => object.key));
        // The identity anchor refuses by design, which is the vault staying
        // well-formed rather than corrupt: the wipe is complete, the
        // re-enrollment path survives.
        setRuntimeStatus(`Wiped the Local Device Vault (${receipt.reclaimed.length.toLocaleString()} objects).`);
        location.reload();
        return;
      }
      const wiped = await vault.purgeStoredObjects();
      if (!wiped) {
        throw new Error("This Vault cannot reclaim its objects, so nothing was wiped.");
      }
      setRuntimeStatus(`Wiped ${wiped.objectCount.toLocaleString()} vault objects.`);
      location.reload();
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? `Wipe stopped: ${error.message}` : "Wipe stopped safely.");
    } finally {
      if (temporaryLocalDeviceHandle) {
        await temporaryLocalDeviceHandle.closeAndWait().catch(() => undefined);
        temporaryLocalDeviceHandle = undefined;
      }
      setVaultWipeBusy(false);
    }
  }

  /*
   * The aged-supersession queue and the provider-side untracked enumeration,
   * driven from one button. The sentence built from the receipt reports counts
   * the provider confirmed in its own words — confirmed removals, offers it
   * declined, leftovers still inside their safety window — and never upgrades
   * an offer into a removal.
   */
  async function reclaimVaultStorage(): Promise<void> {
    if (vaultSnapshot.phase !== "ready") return;
    setVaultReclaimBusy(true);
    try {
      const receipt = await vault.runReclamationSweep();
      const untracked = receipt.untracked.status === "unavailable" ? undefined : receipt.untracked;
      const confirmed = receipt.queue.reclaimed + (untracked?.reclaimed ?? 0);
      const offered = receipt.queue.requested + (untracked?.requested ?? 0);
      const retained = receipt.queue.retained + (untracked?.retained ?? 0);
      let message: string;
      if (!offered && !retained && !receipt.queue.skippedUnverifiable) {
        message = receipt.queue.queued
          ? `Reclaim finished: nothing was old enough yet — ${receipt.queue.deferredYoung.toLocaleString()} recorded leftover${receipt.queue.deferredYoung === 1 ? "" : "s"} still inside the safety window.`
          : "Reclaim finished: no unreachable encrypted objects were waiting.";
      } else {
        const parts = [
          `Reclaim finished: ${confirmed.toLocaleString()} of ${offered.toLocaleString()} offered object${offered === 1 ? "" : "s"} confirmed moved to provider trash`,
        ];
        if (retained) parts.push(`${retained.toLocaleString()} offered but not confirmed removed, kept for a later run`);
        if (receipt.queue.deferredYoung) parts.push(`${receipt.queue.deferredYoung.toLocaleString()} still inside the safety window`);
        if (receipt.queue.skippedUnverifiable) parts.push(`${receipt.queue.skippedUnverifiable.toLocaleString()} untouched because a live reference could not be checked again`);
        if (receipt.queue.confirmationCommitted === "uncommitted") parts.push("the queue could not be told which removals landed; the next run re-checks them");
        if (untracked?.status === "truncated") parts.push("more provider-side leftovers remain; run again");
        if (!receipt.queue.queueReadable) parts.push("the reclamation queue could not be read this run");
        message = `${parts.join("; ")}.`;
      }
      setRuntimeStatus(message);
      // Bytes and object counts only fall through a sweep; refresh the facts
      // the route displays rather than leaving yesterday's numbers up.
      void vault.collectStorageStats().then((stats) => {
        if (stats) setVaultUsageFacts({ objects: stats.objectCount, bytes: stats.totalBytes });
      });
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? `Reclaim stopped: ${error.message}` : "Reclaim stopped safely.");
    } finally {
      setVaultReclaimBusy(false);
    }
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

  async function runInferenceRouteTransition<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    reconnectIntent?: AccessReconnectIntent,
    callerSignal?: AbortSignal,
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
    const statusBeforeTransition = runtimeStatus;
    const reconnectGuard = reconnectIntent
      ? reconnectSelectionGuard(reconnectIntent, callerSignal)
      : undefined;
    const signal = reconnectGuard?.signal ?? callerSignal;
    try {
      signal?.throwIfAborted();
      return await operation(signal);
    } catch (error) {
      if (signal?.aborted) setRuntimeStatus(statusBeforeTransition);
      throw error;
    } finally {
      reconnectGuard?.dispose();
      inferenceRouteChanging.current = false;
      setModelSwitching(false);
    }
  }

  async function activateExternalInference(
    route: ActivatedInferenceRoute,
    callerSignal?: AbortSignal,
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
    const reconnectIntent = accessReconnectIntent;
    const activate = async (reconnectSignal?: AbortSignal) => {
      const fabric = inferenceFabric.current;
      if (!fabric || fabric.preflight(route.pin).transport !== route.transport) {
        throw new Error("The selected inference route changed before its session could be pinned.");
      }
      abortAllTurns(new DOMException("Inference route is changing.", "AbortError"));
      setRuntimeStatus(reconnectIntent
        ? `Verifying the requested ${route.pin.provider.label} conversation`
        : `Creating a ${route.pin.provider.label} session`);
      const binding = coreInferenceBinding(route);
      const committedRuntime: Runtime = {
        ...priorRuntime,
        transport: route.transport,
        model: route.pin.model.id,
        inferenceBinding: binding,
        contextPolicy: await contextPolicyForProviderModel(route.pin.model),
      };
      const candidateRuntime: Runtime = {
        ...committedRuntime,
        inferenceDirectory: () => inferenceDirectoryFromAvailability(
          combinedInferenceAvailability(fabric.availability(route.pin), binding),
        ),
      };
      let nextSession: SessionRecord | undefined;
      let nextProfile: ProfileRevision | undefined;
      let reconnectSession: Awaited<ReturnType<typeof prepareReconnectSession>> | undefined;
      await mutateProfileCatalog(async (current) => {
        const selected = current.profiles.find((candidate) => candidate.profileId === routeProfile.profileId);
        if (!selected || runtime.current !== priorRuntime) {
          throw new Error("The active profile or browser runtime changed while the provider was being pinned.");
        }
        nextProfile = await bindProfileToRuntime(selected, candidateRuntime);
        const next = nextProfile === selected ? current : replaceProfile(current, nextProfile);
        if (reconnectIntent) {
          reconnectSession = await prepareReconnectSession(
            reconnectIntent,
            candidateRuntime,
            nextProfile,
            next,
            reconnectSignal,
          );
        } else {
          nextSession = await createProfileSession(candidateRuntime, nextProfile, next);
        }
        return next;
      });
      if (!nextProfile || (!nextSession && !reconnectSession)) {
        throw new Error("The provider route did not produce a conversation transition.");
      }
      if (
        runtime.current !== priorRuntime
        || fabric.preflight(route.pin).transport !== route.transport
      ) {
        throw new Error("The inference connection directory changed before activation committed.");
      }
      const reconnectSelection = reconnectSession && reconnectIntent
        ? await selectPreparedReconnectSession(reconnectSession, reconnectIntent, candidateRuntime, reconnectSignal)
        : undefined;
      if (reconnectSession && !reconnectSelection) throw new Error("The requested conversation selection did not commit.");

      runtime.current = committedRuntime;
      activeExternalRouteRef.current = route;
      setActiveExternalRoute(route);
      if (reconnectSession) {
        publishSelectedAuditedSession(
          reconnectSession.detail,
          reconnectSelection!,
          reconnectSession.presentation,
          `Reconnected ${route.pin.provider.label}/${route.pin.model.id} · audited conversation resumed`,
        );
        setComposerNotice(undefined);
      } else {
        const activated = await activateSession(nextSession!);
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
          setSessionLifecycle(READY_SESSION_LIFECYCLE);
        setTranscriptBoundary(undefined);
        setRuntimeStatus(`${route.pin.provider.label} session ready · model catalog and route checked`);
      }
      navigate("chat");
    };
    return transitionAlreadyClaimed
      ? activate(callerSignal)
      : runInferenceRouteTransition(activate, reconnectIntent, callerSignal);
  }

  async function switchExternalModel(modelId: string): Promise<ModelSwitchOutcome> {
    const current = activeExternalRouteRef.current;
    const conversationRuntime = runtime.current;
    const session = activeSessionRecord;
    if (!current || !activeExternalConnection || !conversationRuntime || !session) {
      throw new Error("Reconnect this conversation's exact provider route before changing its model.");
    }
    const model = current.models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("The selected model is no longer in this connection's catalog.");
    if (!chatModelCapable(model)) {
      throw new Error(`${model.label} is not advertised as a text-generation model.`);
    }
    const plan = planModelSwitch({ activeSession: session, targetModelId: model.id });
    if (plan.kind === "noop") return;
    const policy = await contextPolicyForProviderModel(model);
    const candidateWindow = policy?.contextWindowTokens;
    const used = await recentSessionUseTokens(conversationRuntime.journal, plan.session);
    if (candidateWindow !== undefined && modelSwitchNeedsCompressionGate(used, candidateWindow)) {
      setPendingModelSwitch({
        modelLabel: model.label,
        usedTokens: used,
        windowTokens: candidateWindow,
        proceed: async () => {
          try {
            await commitExternalModelInPlace(current, model.id, plan.session.id, policy);
          } catch (error) {
            setComposerNotice(error instanceof Error
              ? `The model could not be changed for this conversation. ${error.message}`
              : "The model could not be changed for this conversation.");
          }
        },
      });
      return "confirming-compression";
    }
    await commitExternalModelInPlace(current, model.id, plan.session.id, policy);
    return "in-place";
  }

  async function commitExternalModelInPlace(
    expectedRoute: ActivatedInferenceRoute,
    modelId: string,
    targetSessionId: string,
    policy: SessionManifest["contextPolicy"],
  ): Promise<void> {
    return runInferenceRouteTransition(async (signal) => {
      const fabric = inferenceFabric.current;
      const conversationRuntime = runtime.current;
      if (!fabric || !conversationRuntime) throw new Error("The inference connection directory is not ready.");
      if (activeExternalRouteRef.current !== expectedRoute || activeSessionIdentity.current !== targetSessionId) {
        throw new Error("The conversation or provider route changed before the model switch began.");
      }
      const route = await fabric.activate(
        expectedRoute.pin.connection.id,
        modelId,
        signal ?? new AbortController().signal,
      );
      if (
        runtime.current !== conversationRuntime
        || activeExternalRouteRef.current !== expectedRoute
        || activeSessionIdentity.current !== targetSessionId
        || route.pin.provider.id !== expectedRoute.pin.provider.id
        || route.pin.connection.id !== expectedRoute.pin.connection.id
        || route.pin.connection.generation !== expectedRoute.pin.connection.generation
      ) {
        throw new Error("The conversation or provider authority changed while model access was checked.");
      }
      sessionNavigationChanging.current = true;
      try {
        const updated = await conversationRuntime.journal.setSessionModel(targetSessionId, route.pin.model.id, {
          contextPolicy: policy ?? null,
        });
        if (
          runtime.current !== conversationRuntime
          || activeExternalRouteRef.current !== expectedRoute
          || activeSessionIdentity.current !== targetSessionId
          || fabric.preflight(route.pin).transport !== route.transport
        ) {
          throw new Error("The model change was recorded, but the live provider route changed before presentation committed.");
        }
        activeExternalRouteRef.current = route;
        setActiveExternalRoute(route);
        setActiveSessionRecord(updated);
        setEventCount(updated.headSequence);
        setSessionRevision((value) => value + 1);
        setRuntimeStatus(`Model changed to ${route.pin.model.label} for this conversation. The profile default for new conversations is unchanged.`);
        setComposerNotice(undefined);
      } finally {
        sessionNavigationChanging.current = false;
      }
    });
  }

  /**
   * Select one row from a connected, not-yet-pinned catalog in Chat. The
   * selection key carries the connection identity so two providers advertising
   * the same model id cannot activate the wrong transport.
   */
  async function selectStandbyExternalModel(selectionId: string): Promise<void> {
    const fabric = inferenceFabric.current;
    if (!fabric) throw new Error("The inference connection directory is still starting.");
    const selected = fabric.list()
      .flatMap((entry) => entry.models.map((model) => ({ entry, model })))
      .find(({ entry, model }) => externalModelSelectionId(entry.connection.id, model.id) === selectionId);
    if (!selected) throw new Error("The selected model is no longer in the connected catalog. Refresh Providers and choose it again.");
    if (!chatModelCapable(selected.model)) {
      throw new Error(`${selected.model.label} is not advertised as a text-generation model, so it cannot answer Chat prompts.`);
    }
    const route = await fabric.activate(selected.entry.connection.id, selected.model.id);
    await activateExternalInference(route);
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
      abortAllTurns(new DOMException("Inference connection was disconnected.", "AbortError"));
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
        workspaceBinding: draft.workspaceBinding === "workspace-id"
          ? { kind: "workspace-id", workspaceId: draft.workspaceId }
          : { kind: "active-workspace" },
        memoryScope: draft.memoryScope,
        approvalMode: draft.approvalMode,
        webEgress: draft.webEgress,
        webBodies: draft.webBodies,
        theme: { themeId: theme.themeId, digest: theme.digest },
        skillModes: current.skillModes,
        presentation: (() => {
          /*
           * Defaults are byte-stability citizens: they materialize only where
           * a revision already carried the member, so a profile that never
           * chose keeps its digest across every preference we add. Explicit
           * choices always write. Both fields are display-only.
           */
          const prior = current.presentation;
          const reasoningVisibility = draft.reasoningVisibility === "collapsed"
            ? prior?.reasoningVisibility === undefined ? undefined : "collapsed" as const
            : draft.reasoningVisibility;
          const density = draft.density === "minimal"
            ? prior?.density === undefined ? undefined : "minimal" as const
            : draft.density;
          if (reasoningVisibility === undefined && density === undefined) return undefined;
          return {
            ...(reasoningVisibility === undefined ? {} : { reasoningVisibility }),
            ...(density === undefined ? {} : { density }),
          };
        })(),
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
    const visibleSessionId = activeSessionRecord?.id ?? sessionId;
    const conversationRuntime = runtime.current;
    if (!conversationRuntime || !visibleSessionId || inferenceRouteChanging.current || sessionNavigationChanging.current) {
      setComposerNotice("The active conversation is not ready to change its approval policy.");
      return;
    }
    /*
     * One durable event on the same journal chain is the whole mechanism.
     * Whatever the new mode is now, it governs the very next call — a tool
     * check halfway through a running turn, a fresh prompt, or anything a
     * person triggers next — because after this append the conversation's
     * record carries the override and the controller below is rebuilt from
     * the mode it reads back. The manifest's pinned policy stays the birth
     * certificate the audit trail already references; the pinned-conversation
     * mint the old path did is what used to fork the reader's thread.
     */
    sessionNavigationChanging.current = true;
    try {
      const updated = await conversationRuntime.journal.setSessionApprovalMode(visibleSessionId, nextMode);
      if (activeTurns.current.has(visibleSessionId)) {
        // A running turn already owns a stable SwitchableApprovalPolicy; the
        // next inner check cannot wait for a journal round trip.
        sessionApprovalPolicy(visibleSessionId).replace(approvalModePolicies[nextMode]);
        setLiveApprovalMode(Object.freeze({ sessionId: visibleSessionId, mode: nextMode }));
      }
      if (activeSessionRecord?.id === updated.id) setActiveSessionRecord(updated);
      setEventCount(updated.headSequence);
      setSessionRevision((value) => value + 1);
      setRuntimeStatus(`Approval policy changed to ${approvalModeLabel(nextMode)} for this conversation. The profile default for new conversations is unchanged.`);
      setComposerNotice(undefined);
    } catch (error) {
      setComposerNotice(error instanceof Error
        ? `The approval policy could not be changed for this conversation. ${error.message}`
        : "The approval policy could not be changed for this conversation.");
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
        workspaceBinding: latest.workspaceBinding,
        memoryScope: latest.memoryScope,
        approvalMode: latest.approvalMode,
        webEgress: resolveProfileWebEgress(latest),
        webBodies: resolveProfileWebBodies(latest),
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
      const failure = await changeProfile(replacementProfileId, true);
      if (failure) {
        throw new Error(`The active profile was not archived. ${failure}`);
      }
    }
    await mutateProfileCatalog((current) => archiveProfileRevision(current, profileIdToDelete));
    setRuntimeStatus("Profile archived from new work; historical conversations retain their pinned manifest and receipts");
  }

  /**
   * Auto-save for the editor's syntax palette.
   *
   * One conditional write against the same catalog transaction every other
   * profile edit uses, so the choice is durable in the Vault the moment one is
   * adopted and ephemeral in page memory when it is not — with no new storage
   * key and, deliberately, no new profile revision: a colour preference is not
   * something a year of pinned conversations should have to resolve.
   *
   * The failure path is a status line rather than a throw. Nothing about the
   * open file changed, and a modal over a theme click would be the wrong size
   * of interruption; but a silent revert would leave the menu showing a choice
   * the catalog never took.
   */
  async function setProfileCodeThemeId(profileIdToEdit: string, codeThemeId: string): Promise<void> {
    try {
      await mutateProfileCatalog((current) => setProfileCodeTheme(current, profileIdToEdit, codeThemeId));
    } catch (error) {
      setRuntimeStatus(error instanceof Error
        ? `Editor theme not saved to ${profileCatalogAuthorityLabel()}: ${error.message}`
        : `Editor theme not saved to ${profileCatalogAuthorityLabel()}.`);
    }
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
          version: 3,
          parentRevision: profile.revision,
          skillModes: profileSkillModes(profile.skillModes, skillId, mode),
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

  /**
   * Commit an authored skill revision.
   *
   * Deliberately NOT a session re-pin, where `setProfileSkill` above is one. A
   * mode change alters which skills the next resolution selects and the route
   * has to say so; a skill's *text* is content-addressed, so a running
   * conversation is pinned to the digest it was composed from and is untouched
   * by definition. The status line says which authority took the write, because
   * "page memory" and "encrypted Vault" are a materially different promise about
   * whether these words survive the tab.
   */
  async function saveSkillRevision(draft: SkillRevisionDraft): Promise<void> {
    const revision = await createSkillRevision(draft);
    const editing = catalog?.skills.some((skill) => skill.skillId === revision.skillId) ?? false;
    await mutateProfileCatalog((current) => upsertAuthoredSkill(current, revision));
    setRuntimeStatus(`${revision.name} ${editing ? "revised" : "created"} in ${profileCatalogAuthorityLabel()} · conversations already running keep the instruction text they pinned`);
  }

  async function deleteSkillRevision(skillId: string): Promise<void> {
    await mutateProfileCatalog((current) => removeAuthoredSkill(current, skillId));
    setRuntimeStatus(`Skill removed from ${profileCatalogAuthorityLabel()} · conversations already running keep the instruction text they pinned`);
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
    signal?: AbortSignal,
  ): Promise<Readonly<{
    report: SessionAuditReport;
    session: SessionRecord;
    events: readonly DurableEvent[];
  }>> {
    const activeRuntime = sourceRuntime;
    if (!activeRuntime) throw new Error("The local runtime is not ready.");
    signal?.throwIfAborted();
    const [{ auditSessionHistory }, session] = await Promise.all([
      abortableReconnectRead(loadDeferredCapabilities(), signal),
      activeRuntime.journal.getSession(targetSessionId, signal),
    ]);
    signal?.throwIfAborted();
    if (!session) throw new Error("The active session is no longer available in this page runtime.");
    if (expectedProfileId) requireProfileOwnedSession(session, expectedProfileId, "open");
    const events = await activeRuntime.journal.readEvents(targetSessionId, 0, signal);
    const report = await abortableReconnectRead(auditSessionHistory({ session, events }), signal);
    signal?.throwIfAborted();
    return Object.freeze({
      report,
      session,
      events: boundedSessionPresentationEvents(events),
    });
  }

  /**
   * Proves that one provider activation may return to the addressed conversation.
   *
   * The URL is only intent. The journal record, current Profile policy, complete
   * audit, and exact inference binding all have to agree before the activation
   * transaction is allowed to skip session creation.
   */
  async function prepareReconnectSession(
    intent: AccessReconnectIntent,
    candidateRuntime: Runtime,
    candidateProfile: ProfileRevision,
    candidateCatalog: ProfileCatalog,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    detail: SessionLibraryDetail;
    audited: Awaited<ReturnType<typeof loadAuditedSessionSnapshot>>;
    presentation: SessionMessagePresentation;
  }>> {
    signal?.throwIfAborted();
    const target = await candidateRuntime.journal.getSession(intent.returnSessionId, signal);
    if (!target) throw new Error("The requested conversation is no longer available in this workspace. No new conversation was created.");
    requireProfileOwnedSession(target, candidateProfile.profileId, "open");
    const pinnedBinding = target.manifest.inferenceBinding;
    if (!pinnedBinding) {
      throw new Error("This older conversation does not record an exact inference connection generation, so this return request cannot continue it. No new conversation was created.");
    }
    if (
      pinnedBinding.providerId !== intent.providerId
      || effectiveSessionModel(target) !== intent.model
      || pinnedBinding.authMethod !== intent.method
      || pinnedBinding.connectionId !== intent.connectionId
      || pinnedBinding.connectionGeneration !== intent.connectionGeneration
    ) {
      throw new Error("The return request no longer matches this conversation's immutable provider pin. No new conversation was created.");
    }

    const candidateManifest = await createProfileSessionManifest(
      candidateRuntime,
      candidateProfile,
      candidateCatalog,
    );
    signal?.throwIfAborted();
    const library = new SessionLibrary(candidateRuntime.journal);
    const detail = await library.inspect(
      target.id,
      sessionManifestRuntime(candidateRuntime, candidateManifest),
      signal,
    );
    if (detail.compatibility?.action !== "resume") {
      const reasons = detail.compatibility?.reasons.map((reason) => reason.message).join(" ");
      throw new Error(
        `${detail.compatibility?.label ?? "The requested conversation cannot resume through this route."}${reasons ? ` ${reasons}` : ""} No new conversation was created.`,
      );
    }
    const audited = await loadAuditedSessionSnapshot(
      target.id,
      candidateProfile.profileId,
      candidateRuntime,
      signal,
    );
    if (sessionAuditRefusesResume(audited.report)) {
      throw new Error("The requested conversation's journal failed its local integrity audit and was not resumed. No new conversation was created.");
    }
    if (
      audited.session.headSequence !== detail.session.headSequence
      || audited.session.headDigest !== detail.session.headDigest
    ) {
      throw new Error("The requested conversation changed during return verification. Retry against its new immutable head; no new conversation was created.");
    }
    const presentation = await stageAuditedSessionPresentation(detail, audited, signal);
    return Object.freeze({ detail, audited, presentation });
  }

  async function selectPreparedReconnectSession(
    prepared: Awaited<ReturnType<typeof prepareReconnectSession>>,
    intent: AccessReconnectIntent,
    candidateRuntime: Runtime,
    signal?: AbortSignal,
  ): Promise<SessionRecord> {
    requireCurrentReconnectIntent(intent);
    signal?.throwIfAborted();
    return selectSessionForActivation(
      prepared.audited.session,
      candidateRuntime,
      signal,
    );
  }

  async function stageAuditedSessionPresentation(
    fresh: SessionLibraryDetail,
    audited: Awaited<ReturnType<typeof loadAuditedSessionSnapshot>>,
    signal?: AbortSignal,
  ): Promise<SessionMessagePresentation> {
    const { describeSessionPresentationFault, presentSessionMessages } = await abortableReconnectRead(
      loadDeferredCapabilities(),
      signal,
    );
    signal?.throwIfAborted();
    return (() => {
      try {
        return presentSessionMessages({
          session: audited.session,
          audit: audited.report,
          events: audited.events,
          receipts: fresh.transcript.receipts,
          history: presentationHistory(fresh.transcript.messages),
        });
      } catch (error) {
        throw new Error(`“${fresh.session.title}” could not be replayed: ${describeSessionPresentationFault(error)} Its history is intact.`);
      }
    })();
  }

  async function publishAuditedSession(
    fresh: SessionLibraryDetail,
    audited: Awaited<ReturnType<typeof loadAuditedSessionSnapshot>>,
    status: string,
    stagedPresentation?: SessionMessagePresentation,
  ): Promise<void> {
    const presentation = stagedPresentation
      ?? await stageAuditedSessionPresentation(fresh, audited);
    const selected = await selectSessionForActivation(audited.session);
    publishSelectedAuditedSession(fresh, selected, presentation, status);
  }

  function publishSelectedAuditedSession(
    fresh: SessionLibraryDetail,
    selected: SessionRecord,
    presentation: SessionMessagePresentation,
    status: string,
  ): void {
    const activated = publishActiveSessionSelection(selected);
    setMessages(presentation.rows.length + presentation.markers.length > 0
      ? transcriptMessagesFromPresentation(presentation)
      : [{ ...welcomeMessage, id: randomUuid(), content: `Resumed ${fresh.session.title}. ${welcomeMessage.content}` }]);
    setEventCount(activated.headSequence);
    setSessionLifecycle(fresh.transcript.lifecycle);
    setTranscriptBoundary(fresh.transcript.truncated ? {
      omittedMessages: fresh.transcript.omittedMessages,
      shortened: fresh.transcript.messages.some((message) => message.truncated),
    } : undefined);
    setSessionRevision((value) => value + 1);
    setRuntimeStatus(status);
  }

  async function resumeLibrarySessionNow(detail: SessionLibraryDetail): Promise<void> {
    if (inferenceRouteChanging.current || sessionNavigationChanging.current) {
      throw new Error("Wait for the current session or inference route transition before resuming.");
    }
    if (!sessionLibrary || !sessionRuntime || !catalog) throw new Error("The session runtime is not ready.");
    const preservedTurnSessionId = busy && detail.compatibility?.action !== "blocked"
      ? activeSessionIdentity.current
      : undefined;
    if (preservedTurnSessionId) sessionResumeDuringTurn.current = preservedTurnSessionId;
    sessionNavigationChanging.current = true;
    try {
      const fresh = await inspectSessionForNavigation(detail.session.id);
      if (fresh.compatibility?.action !== "resume") {
        throw new Error(fresh.compatibility?.label ?? "The session no longer matches the active runtime.");
      }
      const audited = await loadAuditedSessionSnapshot(fresh.session.id);
      if (sessionAuditRefusesResume(audited.report)) {
        throw new Error("This conversation's journal failed its local integrity audit and cannot be reopened.");
      }
      /*
       * A quarantine is a reading, and a reading expires.
       *
       * `quarantinedSession` is written once, during vault adoption, and was
       * cleared by exactly one thing: the Dismiss button on the chat card. So a
       * conversation that failed to open at adoption — often for a reason that
       * has since gone, an engine the audit had not learned, a runtime that had
       * not finished binding — kept a disabled Resume button and a rail row
       * reading "Needs review · could not be reopened" for the rest of the
       * page's life, no matter how cleanly it audited afterwards. The audit
       * that just passed on this exact session is better evidence than the one
       * that failed earlier, so it retires the verdict it supersedes.
       */
      setQuarantinedSession((current) => current?.sessionId === fresh.session.id ? undefined : current);
      if (
        audited.session.headSequence !== fresh.session.headSequence ||
        audited.session.headDigest !== fresh.session.headDigest
      ) {
        throw new Error("The session changed between inspection and audit. Retry resume against the new immutable head.");
      }
      const pinnedProfile = fresh.session.manifest.profile;
      let resumedProfileId: string | undefined;
      if (pinnedProfile) {
        /*
         * The profile the pin names, at the revision the catalog still holds.
         *
         * This used to demand the exact revision digest and refuse otherwise —
         * and the catalog keeps one revision per profile, so every conversation
         * became unresumable the moment its profile was edited at all, theme
         * included. `decideSessionResume` has already refused this session if
         * the profile's identity, skill set or any governing boundary moved, so
         * what survives to here is the same profile governing identically; a
         * revision digest that differs only in presentation is not a reason to
         * strand a finished conversation.
         */
        const profile = catalog.profiles.find((candidate) =>
          candidate.profileId === pinnedProfile.profileId && candidate.revision === pinnedProfile.profileRevision,
        ) ?? catalog.profiles.find((candidate) => candidate.profileId === pinnedProfile.profileId);
        if (!profile) throw new Error("The profile this conversation was started in is no longer in this catalog; create a fork instead.");
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
      if (sessionResumeDuringTurn.current === preservedTurnSessionId) sessionResumeDuringTurn.current = undefined;
      sessionNavigationChanging.current = false;
      setProfileCockpitTransition(undefined);
    }
  }

  /**
   * Same-model history is safe to activate while a turn runs: its durable
   * writes are addressed by the turn's own session id and its live projection
   * is already fenced by the active-session identity. Only a model-mismatch
   * continuation (or an address that still needs re-inspection) waits for the
   * turn's safe boundary.
   */
  function queueSessionAction(run: () => Promise<void>): Promise<void> {
    if (!busy) return run();
    pendingSessionResume.current?.reject(new Error("A newer request replaced this one."));
    const promise = new Promise<void>((resolve, reject) => {
      pendingSessionResume.current = Object.freeze({ run, resolve, reject });
    });
    setRuntimeStatus("Opening after turn");
    return promise;
  }

  /**
   * Navigating is not resuming. When a turn is in flight in another thread,
   * the thread you click opens now — its projection never borrowed the
   * turn's, and the in-flight turn keeps writing against its own session.
   * Only the journal-blocked kind waits, because even reading it pretends a
   * floor the journal does not verify.
   */
  /**
   * Navigating is not resuming. When a turn is in flight in another thread,
   * the thread you click opens now — its projection never borrowed the
   * turn's, and the in-flight turn keeps writing against its own session.
   * Only the journal-blocked kind waits, because even reading it pretends a
   * floor the journal did not verify.
   */
  function resumeLibrarySession(detail: SessionLibraryDetail): Promise<void> {
    if (busy && detail.compatibility?.action !== "blocked") {
      return resumeLibrarySessionNow(detail);
    }
    return queueSessionAction(() => resumeLibrarySessionNow(detail));
  }

  useEffect(() => {
    if (busy || !pendingSessionResume.current) return;
    const pending = pendingSessionResume.current;
    pendingSessionResume.current = undefined;
    void pending.run().then(
      () => pending.resolve(),
      (error) => pending.reject(error),
    );
  }, [busy]);

  /**
   * Step back into a thread whose turn is still running, and find it running.
   *
   * Re-opening a conversation replaces `messages` wholesale with the journal's
   * projection. For a turn still in flight that projection is correct and
   * complete — `presentSessionMessages` emits the row whether or not the turn
   * has terminated — but it is projection, not live state: the row arrives
   * with no `status`, so `StreamingMessageSlot` reads it as settled and mounts
   * nothing, and the answer streaming into that row's slot stays invisible
   * until the turn ends.
   *
   * This is the one place that can put the two back together, because it runs
   * after whichever load replaced the array. It restores exactly one field —
   * the status the turn last reported — which is the field that means "this
   * row is still being written". Everything else the reader needs is already
   * addressed correctly: `adoptJournalTurnAddress` moved the slots onto the
   * journal's id, so the text and reasoning that arrived while they were gone
   * are already sitting under the id this row now carries.
   *
   * Idempotent by construction: it returns the same array once the status is
   * on the row, so it cannot loop against its own write, and it declines to
   * act at all unless a turn is genuinely in flight (`busy`) for the
   * conversation on screen.
   */
  useEffect(() => {
    const live = liveTurnRow.current;
    if (!busy || !live || live.sessionId !== sessionId) return;
    setMessages((current) => {
      const row = current.find((message) => message.id === live.messageId);
      if (!row || row.status !== undefined) return current;
      return current.map((message) => message.id === live.messageId
        ? { ...message, status: live.status }
        : message);
    });
  }, [messages, sessionId, busy]);

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
      ) throw new Error("The active Profile/session authority changed before the fork could be confirmed.");
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
      || !forkActivationManifestMatches(result.session.manifest, authority.manifest)
    ) throw new Error("The fork manifest is not compatible with the active Profile and runtime authority.");
    const library = new SessionLibrary(authority.runtime.journal);
    const fresh = await library.inspect(
      result.session.id,
      sessionManifestRuntime(
        authority.runtime,
        result.session.manifest,
        result.session.manifest.model,
      ),
    );
    if (fresh.compatibility?.action !== "resume") {
      throw new Error(
        fresh.compatibility
          ? `${fresh.compatibility.label}: ${fresh.compatibility.reasons.map((reason) => reason.message).join(" ")}`
          : "The fork did not produce a resumable session for the active authority.",
      );
    }
    const audited = await loadAuditedSessionSnapshot(result.session.id);
    if (sessionAuditRefusesResume(audited.report)) {
      throw new Error("The new fork's journal failed its local integrity audit.");
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
    await publishAuditedSession(fresh, audited, "Context fork active");
    navigate("chat");
  }

  /*
   * Restore a transcript-targeted return after the requested conversation has rendered.
   *
   * The request is state rather than a scroll call because the conversation may
   * still be resuming when the route changes — `pendingTranscriptReturn` is
   * consumed by the effect below once the transcript for that session has
   * rendered, and reports what happened either way.
   */
  function returnToTurn(targetSessionId: string, turnId: string): void {
    setPendingTranscriptReturn(Object.freeze({ sessionId: targetSessionId, turnId }));
    navigate("chat", chatHash(targetSessionId));
  }

  if (bootFailure || !catalog || !activeProfile || !activeTheme) {
    return <BootScreen
      status={runtimeStatus}
      failure={bootFailure}
      onReload={() => window.location.reload()}
    />;
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
  /*
   * A branch is not a first visit.
   *
   * An Edit & branch opened on the newcomer cards — "Open a terminal", "Browse
   * the workspace", "Connect a model" — directly beneath its own sentence
   * saying four ancestor messages had been carried in. The transcript holds
   * only the seed marker at that moment, so every "is this conversation new"
   * test based on row count said yes. Inherited context is the fact that tells
   * them apart, and the marker now carries it.
   */
  /*
   * What the backlog shows without being asked.
   *
   * One item is its own summary, so it is rendered. More than one collapses to
   * the count line plus the next prompt, and every row stays one control away —
   * the panel is a disclosure about the queue, not the queue itself.
   */
  const queueVisibleItems = queueExpanded || messageQueue.length === 1 ? messageQueue : [];
  const isBranchTranscript = messages.some((message) => message.marker?.carriedContext !== undefined);
  /*
   * The suggestion cards are a suggestion, in the density taxonomy — at
   * minimal a fresh thread shows the composer and nothing else, which is the
   * rest of the mandate: the next action was already obvious, and three
   * buttons were extra weight beside it.
   */
  const firstRunTranscript = messages.length <= 1 && !isBranchTranscript && densityAllows("suggestion", appDensity);
  // The vocabulary this claim belongs to owns the mapping: page memory is `none`
  // rather than `failed` (nothing went wrong, no durability evidence was asked
  // for), a running sync is `checking`, and a stopped one is `attention`. Read
  // from `durability-indicator` rather than restated, because a fourth copy of
  // the ternary is how the chip and the pill came to disagree.
  const sessionDurabilityStatusMark: StatusMarkState = durabilityStatusMark(sessionDurability.state);
  const sessionStatusFacts: readonly SessionStatusFact[] = Object.freeze([
    Object.freeze({
      id: "durability" as const,
      state: sessionDurabilityStatusMark,
      label: durabilityLabel(sessionDurability.state),
      detail: sessionDurability.detail,
      // The vocabulary's own abbreviation, not `sessionStatusShort`'s head-of-
      // label rule. That rule yields the bare word "Ephemeral", and the Atlas
      // measured a person meeting it four times and still losing a conversation
      // to a refresh without understanding why. This chip is the only permanent
      // durability claim on the surface where the typing happens.
      short: durabilityShort(sessionDurability.state),
      action: Object.freeze({ label: "Vault", onSelect: () => navigate("vault") }),
    }),
    Object.freeze({
      id: "lifecycle" as const,
      // A completed turn is not `verified`: nothing cryptographic was checked by
      // finishing. It stays `none` so the status-mark vocabulary keeps meaning what
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
        {/* The third target, and the one the document order argues hardest for.
            Navigation is the *last* thing in the phone's DOM: measured, the
            mobile bar was entered at tab stop 22 of 25 and "More" — behind
            which Vault, Memory, Providers and the remaining destinations
            live — was stop 25, so reaching any of them from a cold phone load
            cost a sweep of the entire page. The rail is `display: none` below
            the phone breakpoint, which is what picks the destination here. */}
        <button
          class="skip-link"
          type="button"
          onClick={() => {
            const rail = primaryNav.current;
            const target = (rail && rail.offsetParent !== null
              ? rail.querySelector<HTMLElement>('button[tabindex="0"]') ?? rail.querySelector<HTMLElement>("button")
              : undefined)
              ?? document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"] button');
            target?.focus({ preventScroll: true });
          }}
        >Skip to navigation</button>
      </div>
      <header class="topbar" inert={platformOverlayOpen} aria-hidden={platformOverlayOpen || undefined}>
        <button class="brand" type="button" onClick={() => navigate("chat")} aria-label="Open session">
          <span class="brand-mark" aria-hidden="true"><Icon name="airship" size={25} /></span>
          <span class="brand-name">Airship</span>
          <span class="edition">edge runtime</span>
        </button>
        {/* Center is a flex group, so the tab note rides it when it exists:
            the note used to be a fourth child of a three-column topbar grid,
            and every second-tab session paid for it as a wrapped full-width
            second row of the shell header. */}
        <div class="topbar-center">
          {/*
            The band's own job, finally given to it.
            This column is `minmax(280px, 1fr)` and held one chip, so on every
            desktop width the widest strip in the shell was mostly ground —
            while each route drew a second full-width band directly beneath it
            to say which page you were on. Two headers, one of them empty. The
            destination is a shell fact (the rail selects it, the hash carries
            it, it is the same word on every route), so the shell's own header
            is where it belongs, and `.route-header` below stops being chrome
            and goes back to being the page's first content.
            Not a heading: the route's own `<h1>` is still the document's
            title and still on the page. This is the shell saying where you
            are, which is what the rail's selected row says too — so it is
            marked `aria-hidden` rather than read out a third time.
          */}
          <span class="topbar-destination" aria-hidden="true">{destinationLabel(view) ?? "Airship"}</span>
          <div class="topbar-runtime-state" role="group" aria-label="Runtime state">
          <DeferredTabPresenceNote />
          </div>
        </div>
        <div class="topbar-actions">
          {/* One provider-connect action at every width. Its visible text and
              accessible name are identical. */}
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
            leading={(option) => <span class="profile-monogram" style={profileBadgeStyle(profileThemeFor(catalog, option.value))} aria-hidden="true">{profileMonogram(option.label)}</span>}
            onChange={(nextId) => void requestProfileChange(nextId)}
          />
          <span class="runtime-line" title={runtimeStatus}><span class="pulse-dot" /><span class="runtime-line__text">{runtimeStatus}</span></span>
          {/* The mirror lags the line on purpose: it holds the last status the
              turn narrator did not claim, so ambient kernel telemetry cannot
              land in the same frame as the sentence about the answer. */}
          <span class="sr-only" role="status" aria-live="polite">{runtimeAnnouncement}</span>
          {/* The chord is printed, not merely bound. Measured on a fully loaded
              chat route: `document.body.innerText.includes("⌘K")` was false and
              the only carrier was this button's `title` — invisible to touch
              and to anyone who does not hover a bare ⌘ glyph. */}
          <button class="icon-button command-palette-button" type="button" aria-label="Open command palette" title={`Command palette · ⌘K · ${SHORTCUT_SHEET_CHORD} for all shortcuts`} onClick={() => requestDeferredOverlay("Command Center")}>
            <kbd aria-hidden="true">⌘K</kbd>
          </button>
          <button class="icon-button" type="button" aria-label="Open Preferences" onClick={() => requestDeferredOverlay("Preferences")}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {/*
        The topbar hides its runtime line below 640px — the grid there is one
        row, and the sentence used to wrap a control onto the session bar.
        Hiding the line meant the phone answered "what is happening?" with
        nothing ("Opening after turn", the policy-change scope sentence, the
        vault notices — all invisible at exactly the width multi-tasking
        matters most). This is the same sentence in a different place, and it is
        deliberately NOT a live region.

        It used to carry `role="status" aria-live="polite"`, on the reasoning
        that it and the topbar line are display-exclusives — but the topbar line
        has no live semantics at all. The pair that actually speaks is the
        sr-only mirror above and this band, and that mirror is what holds an
        ambient kernel sentence back for TURN_NARRATION_HOLD_MS so it cannot
        land on top of the narration about the answer. Announcing here bypassed
        that hold: measured on one phone turn, the narration said "Airship's
        turn ended" at t=1608ms and this band said "Local kernel ready" at
        t=1611ms. The mirror renders at every width, so removing the live
        semantics here loses no announcement.
      */}
      {/*
        `data-empty` collapses the band without unmounting it, so the sentence
        can appear and disappear without the surrounding grid reflowing, and a
        phone does not spend 34px of its shortest
        dimension on a status that says nothing. It reads as a stripe of dead
        `--ground` under the topbar, which is exactly what the nav band's own
        keyboard rule two blocks down exists to prevent for the same reason.
      */}
      <div class="runtime-line runtime-line--phone" data-empty={runtimeStatus ? undefined : "true"} title={runtimeStatus}><span class="pulse-dot" /><span class="runtime-line__text">{runtimeStatus}</span></div>

      <Rail
        view={view}
        state={railState}
        navRef={primaryNav}
        inert={platformOverlayOpen}
        busy={busy}
        activity={[+busy, `${busy ? "1 active" : "Ready"} · ${railDurableEventCount} events`]}
        unreadTurnCount={unreadTurnCount}
        conversations={recentProfileConversations}
        activeConversationId={sessionId ?? ""}
        {...(quarantinedSession ? { unresumableConversationId: quarantinedSession.sessionId } : {})}
        formatTime={formatConversationTime}
        profiles={managedProfiles(catalog)}
        profileId={profileId}
        monogram={profileMonogram}
        profileBadgeStyle={(id) => profileBadgeStyle(profileThemeFor(catalog, id))}
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
        class={view === "chat" ? "main chat-layout no-inspector" : "main route-layout"}
        inert={platformOverlayOpen}
        aria-hidden={platformOverlayOpen || undefined}
      >
        {view === "chat" ? (
          <>
            <section class="chat-stage" aria-label="Agent session" data-scrolled={stageScrolled ? "true" : undefined}>
              {/* The retired engine banner repeated a page-wide constant above
                  every thread. Per-turn provider and model facts remain in Run
                  details, and session pins remain in All conversations. */}
              <SessionBar
                title={activeSessionRecord?.title ?? activeProfile.name}
                profileName={activeProfile.name}
                monogram={profileMonogram(activeProfile.name)}
                profileBadgeStyle={profileBadgeStyle(activeTheme)}
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
                conversations={recentProfileConversations}
                activeConversationId={sessionId ?? ""}
                formatTime={formatConversationTime}
                onOpenAllConversations={() => navigate("sessions")}
                renameRequest={renameRequest}
                model={inferenceConnected || pinnedExternalRoute || activeInferenceBinding || standbyExternalModels.length > 0 ? (
                  <ModelControl
                    active={activeExternalConnection ? {
                      providerLabel: activeExternalConnection.pin.provider.label,
                      modelId: activeExternalConnection.pin.model.id,
                    } : pinnedExternalRoute ? {
                      providerLabel: pinnedExternalRoute.pin.provider.label,
                      modelId: pinnedExternalRoute.pin.model.id,
                    } : activeInferenceBinding ? {
                      providerLabel: activeInferenceBinding.providerLabel,
                      modelId: activeInferenceBinding.modelId,
                    } : undefined}
                    providerLabel={activeExternalConnection?.pin.provider.label ?? standbyExternalProviderLabel}
                    models={activeExternalConnection
                      ? activeExternalConnection.models.map((model) => ({
                          id: model.id,
                          label: model.label,
                          detail: externalModelCapabilityDetail(model),
                        }))
                      : standbyExternalModels}
                    busy={busy}
                    switching={modelSwitching}
                    inPlace={Boolean(activeExternalConnection && activeSessionRecord)}
                    onSelect={activeExternalConnection ? switchExternalModel : selectStandbyExternalModel}
                    onOpenConnection={() => navigate("access")}
                  />
                ) : <DemoModelChip onConnect={() => navigate("access")} />}
              />
              <div
                ref={transcriptElement}
                /*
                 * `no-turns` centres a short first-run column so the intro is
                 * not floating in 500px of void. A return report above that
                 * intro makes the column taller than the scroller, and
                 * `align-content: center` then overflows it *upwards*: measured
                 * at 390x844, the card's top was 96px while the transcript's own
                 * top was 107px, so "Your last visit was not kept" rendered
                 * above the scrollport with no way to scroll up to it.
                 */
                class={firstRunTranscript && !unrecoveredWork ? "transcript no-turns" : "transcript"}
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
                {/* Before anything else on the surface, because a person who
                    lost work is looking for it and every other row on screen is
                    about work they still have. */}
                {/* A conversation the Vault could not replay is the first thing
                    a returning person needs to know, and the Atlas measured the
                    chat route saying nothing about it while the truthful record
                    sat three clicks away. */}
                {quarantinedSession && QuarantineReportView ? (
                  <QuarantineReportView
                    title={quarantinedSession.title}
                    reason={quarantinedSession.reason}
                    historyVerified={quarantinedSession.historyVerified}
                    onOpenRecord={() => {
                      setSessionsFocusId(quarantinedSession.sessionId);
                      navigate("sessions");
                    }}
                    onDismiss={() => setQuarantinedSession(undefined)}
                  />
                ) : null}
                {unrecoveredWork && ResumeReportView ? (
                  <ResumeReportView
                    work={unrecoveredWork}
                    durableAuthorityAdopted={vaultRuntimeAdopted}
                    onOpenVault={() => navigate("vault")}
                    onDismiss={() => {
                      const storage = browserReturnLedgerStorage();
                      if (storage) {
                        const ids = unrecoveredWork.sessionIds;
                        // Synchronously where the module is already in hand,
                        // which is every real dismiss: the report the person
                        // is dismissing was rendered from it. The fallback
                        // covers nothing a person can reach, and is kept so a
                        // future caller cannot silently lose the write.
                        const ledger = readyReturnLedger();
                        if (ledger) ledger.forgetReturnLedgerEntries(storage, ids);
                        else void loadReturnLedger().then(({ forgetReturnLedgerEntries }) => forgetReturnLedgerEntries(storage, ids));
                      }
                      setUnrecoveredWork(undefined);
                    }}
                  />
                ) : null}
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
                    note={transcriptIntroNote(messages[0]?.content, TRANSCRIPT_SEED_BODY)}
                    demo={composerUsesDemo}
                    // The one fact that decides whether anything typed below
                    // survives, read from the same derivation the session chip
                    // and the Vault route read.
                    unsaved={sessionDurability.state === "ephemeral"}
                    onKeepConversations={() => navigate("vault")}
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
                    {entry.item.marker ? <TranscriptMarker marker={entry.item.marker} /> : <MessageCard
                      message={entry.item}
                      capabilityTier={activeSessionRecord?.manifest.capabilityTier}
                      onCopy={async () => {
                        if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser context.");
                        await navigator.clipboard.writeText(entry.item.parts?.length ? messagePlainText(entry.item.parts) : entry.item.content);
                      }}
                      onRetry={() => void forkFromMessage(entry.item, "retry")}
                      /* Recovery is not a privilege of durability. A failed
                         turn whose branch boundary never landed still holds the
                         prompt in this page, and re-sending it is the action
                         the person was going to perform by hand anyway. */
                      onResend={entry.item.error && entry.item.originatingPrompt?.trim() && !busy
                        ? () => void resendFailedTurn(entry.item)
                        : undefined}
                      onEdit={() => void forkFromMessage(entry.item, "edit")}
                      onBranch={() => void forkFromMessage(entry.item, "fork")}
                      branchDisabled={!sessionLibrary || !activeSessionRecord || busy || !entry.item.sourcePoint}
                      streamStore={transcriptStreams}
                      reasoningStore={reasoningStreams}
                    />}
                  </div>
                ))}
                </>}
                {firstRunTranscript ? (
                  <div class="transcript-starters" role="group" aria-label="Suggested ways to begin">
                    {(inferenceConnected ? CONNECTED_STARTERS : DISCONNECTED_STARTERS).map((starter) => (
                      <button
                        type="button"
                        key={starter.title}
                        class={starter.lead ? "starter-chip starter-chip--lead" : "starter-chip"}
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
                {/* The turn's whole spoken lifecycle, in one region that is
                    mounted for the life of the route. Per-message regions were
                    inserted and removed with their own turns, which is why the
                    settle sentence raced the shell's status mirror and why the
                    local-command lane, which mounts no streaming slot at all,
                    announced nothing in either direction. */}
                <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{turnNarration.spoken}</span>
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
                    <div
                      class="composer-queue"
                      role="group"
                      aria-label="Queued messages"
                      aria-live="polite"
                      /* A scroll container the keyboard cannot enter is a
                         scroll container only a mouse wheel can read. */
                      tabIndex={0}
                      data-expanded={queueExpanded ? "true" : undefined}
                    >
                      <header>
                        {/* Collapsed, the label carries the count so the panel
                            is one row high; expanded, the list beneath it is
                            the subject and the header is just its name. */}
                        <strong>{queueVisibleItems.length ? "Up next" : `${messageQueue.length} queued`}</strong>
                        {/* A paused queue that looks identical to a running one
                            tells the same lie Stop used to tell. The way out is
                            already on screen — Send now and Edit — so the chip
                            only has to name the state it is in. */}
                        <span>{queueVisibleItems.length
                          ? `${messageQueue.length} queued${queuePaused ? " · paused after Stop" : ""}`
                          : `Next: ${messageQueue[0]!.prompt}${queuePaused ? " · paused after Stop" : ""}`}</span>
                        {/* Measured at 390×844 with 22 rows: the box was 208px
                            of a 1,353px list — five rows visible, seventeen
                            behind a nested scroller with no scrollbar, no fade
                            and no control. The count in this header was the
                            only evidence the rest existed. */}
                        {messageQueue.length > 1 ? (
                          <button
                            class="composer-queue__expand"
                            type="button"
                            aria-expanded={queueExpanded}
                            onClick={() => setQueueExpanded((open) => !open)}
                          >{queueExpanded ? "Show fewer" : `Show all ${messageQueue.length}`}</button>
                        ) : null}
                      </header>
                      {/* Collapsed, the backlog is one row about itself. It
                          used to be the stack itself: 21 queued items took the
                          composer to 210px and the transcript to 51% of a
                          desktop viewport and 39% of a phone — the conversation
                          the backlog belongs to lost half its reading area to
                          it, silently, while it drained. */}
                      {queueVisibleItems.map((item, index) => (
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
                    {attachments.map((attachment) => <span key={attachment.id}>{attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <Icon name="file" size={14} />}<span>{attachment.name}</span><small>{imageInputCapability === "supported" ? "image ready" : "vision model required"}</small><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => { if (attachment.previewUrl) { URL.revokeObjectURL(attachment.previewUrl); attachmentPreviewUrls.current.delete(attachment.previewUrl); } setAttachments((current) => current.filter((item) => item.id !== attachment.id)); }}>×</button></span>)}
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
                        if (event.key === "Escape" && !input.trim()) {
                          /*
                           * The way out of the box, which had none.
                           *
                           * Airship claims this control on every cold chat load
                           * (see `shouldClaimComposerFocus`), and the chord
                           * handler correctly refuses to steal keys from a text
                           * field — so measured from where a person actually
                           * lands, `g x` and every other chord did nothing at
                           * all and nothing on screen said why. Escape releases
                           * the keyboard to the conversation, which is both a
                           * focus target with a visible ring and the place the
                           * chords work.
                           *
                           * Only from an empty box. With a draft in it, Escape
                           * is the key that dismisses the slash menu one clause
                           * above and otherwise does nothing — and "type the
                           * command, Escape the menu, Enter" is a sequence
                           * people and specs both already have in their hands.
                           * Leaving mid-draft is Shift+Tab, which always worked.
                           */
                          event.preventDefault();
                          mainRegion.current?.focus({ preventScroll: true });
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
                        <MenuSelect
                          // One durable journal event beside the manifest pin:
                          // the mode changes in flight on the same thread and
                          // the very next check — mid-turn or next message —
                          // is governed by it.
                          ariaLabel="Conversation approval policy · changes this conversation in place, next call governed"
                          className={`composer-approval-select policy-${activeApprovalMode}`}
                          value={activeApprovalMode}
                          disabled={modelSwitching || vaultProviderSwitching || localDeviceBusy}
                          options={[
                            { value: "ask-first", label: "Ask First", description: "Prompt before effectful actions." },
                            { value: "auto-approve", label: "Auto Approve", description: "Allow registered writes; ask before execute, network, or identity effects. No review inference." },
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
                          {/*
                            Stop is global by mechanism and thread-scoped by
                            meaning. Pressed from a different conversation
                            mid-flight, the button says whose turn it ends;
                            silence on that point is how a person "stopped
                            something" without knowing what.
                          */}
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
                                ? composerAttachmentNeedsText()
                                : composerUsesDemo
                                  ? "Deterministic local demo response. Connect a model for real inference."
                                  : undefined}
                        ><Icon name="send" /></button>
                      )}
                    </div>
                  </div>
                </div>
                {composerNotice ? <p class="composer-notice" role="status">{composerNotice}</p> : null}
                {/* The refusal the posture chip used to carry, in the band that
                    already exists for things the composer has to say right now.
                    Present only while Send is actually refusing, which is the
                    difference between a caveat and a caption. */}
                {attachmentsAwaitText ? <p class="composer-notice" role="status">{composerAttachmentNeedsText()}</p> : null}
                {/*
                  Offline is a state the composer must state at rest — remote
                  inference is paused and nothing the reader types will go
                  anywhere. `Encrypted inference through …` is not: it was true
                  on every turn of every connected conversation and therefore
                  told nobody anything they did not already know, while costing
                  a permanent line directly under the input on the smallest
                  screen the product runs on. The sentence is unchanged and now
                  rides in the runtime chip's sheet as this conversation's model
                  fact, which is where the owner asked the session's facts to
                  live.
                */}
                {!online ? <p class="connectivity-inline-reason" role="status">{OFFLINE_INLINE_REASON}</p> : null}
              </div>
            </section>
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
            inspectSession={(targetSessionId, signal) => inspectSessionForNavigation(targetSessionId, signal)}
            onResume={resumeLibrarySession}
            onOpenActive={(targetSessionId) => navigate("chat", chatHash(targetSessionId))}
            onForked={activateForkedSession}
            onRenamed={adoptLibraryRename}
            onDeleted={adoptLibraryDelete}
            durability={sessionDurability}
            quarantine={quarantinedSession}
            focusSessionId={sessionsFocusId}
            onFocusSessionConsumed={() => setSessionsFocusId(undefined)}
          />
        ) : sessionsViewError ? (
          <DeferredRouteFailure title="All conversations" message={sessionsViewError} onRetry={retryDeferredChunk} />
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
          codeThemeId={profileCodeThemeId(catalog, activeProfile.profileId)}
          onCodeThemeChange={async (codeThemeId) => { await setProfileCodeThemeId(activeProfile.profileId, codeThemeId); }}
        /> : editorViewError ? <DeferredRouteFailure title="Editor" message={editorViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading the browser-native Workspace Editor" /> : null}
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
        /> : terminalViewError ? <DeferredRouteFailure title="Terminal" message={terminalViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading the browser terminal" /> : null}
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
            recallRecords={recallMemoryRecords}
            commitMemory={commitMemoryChange}
            initialTab={view === "context" ? "index" : "search"}
            onOpenSource={(target) => void openMemorySource(target)}
          />
        ) : memoryViewError ? <DeferredRouteFailure title="Memory" message={memoryViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading private memory" /> : null}
        {view === "profiles" || view === "capabilities" || view === "skills" ? <nav class="profile-hub-tabs" aria-label="Agent configuration">
          {([{"id":"profiles","label":"Profiles"},{"id":"skills","label":"Skills"},{"id":"capabilities","label":"Capabilities"}] as const).map((tab) => <button key={tab.id} type="button" aria-current={view === tab.id ? "page" : undefined} onClick={() => navigate(tab.id)}>{tab.label}</button>)}
        </nav> : null}
        {/*
          * The scope control belongs to the Skills page, not to the tab strip.
          *
          * It was rendered as a sibling of the three tab buttons *inside*
          * `<nav aria-label="Agent configuration">`, which put a form control in
          * a navigation landmark — so a screen reader announced "Applies to,
          * Research" as part of the site navigation, and sighted readers saw a
          * dropdown wedged into a row of tabs where it read as a fourth tab.
          *
          * A tab strip says which page you are on. This says what the page you
          * are already on will act upon. Those are different questions and the
          * second one belongs with its page.
          */}
        {view === "skills" ? (
          <div class="profile-hub-scope">
            <span id="skill-scope-label">Applies to</span>
            <MenuSelect
              placement="down"
              ariaLabel="Skill scope"
              value={profileHubScope}
              options={[{ value: "global", label: "All profiles" }, ...managedProfiles(catalog).map((profile) => ({ value: profile.profileId, label: profile.name }))]}
              onChange={setProfileHubScope}
            />
          </div>
        ) : null}
        {view === "profiles" ? (
          <ProfileManagerView
            key={profileHubScope}
            catalog={catalog}
            catalogDurability={runtime.current?.profiles.durability ?? "ephemeral"}
            activeProfileId={profileId}
            /* Only a switch that actually committed opens Chat. A refused one
               used to throw past this line, which is what kept the editor on
               screen; now the explicit outcome is what holds the editor open. */
            onActivate={async (id) => {
              // The outcome is returned, not inferred. `requestProfileChange`
              // cannot reject — it returns the same failure sentence sent to the
              // runtime line — so this route can remain open and explain it.
              const failure = await requestProfileChange(id, true);
              if (!failure) navigate("chat");
              return failure;
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
        ) : capabilitiesViewError ? <DeferredRouteFailure title="Capabilities" message={capabilitiesViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Inspecting browser capabilities" /> : null}
        {view === "skills" ? SkillsScreen ? (
          <SkillsScreen
            catalog={catalog}
            catalogDurability={runtime.current?.profiles.durability ?? "ephemeral"}
            activeProfileId={profileId}
            onSetGlobal={setGlobalSkill}
            onSetProfile={setProfileSkill}
            onSaveSkill={saveSkillRevision}
            onDeleteSkill={deleteSkillRevision}
            onApply={async (id) => {
              const failure = await requestProfileChange(id, true);
              if (!failure) navigate("chat");
              return failure;
            }}
            onStartConversation={async () => {
              try {
                const created = await createConversation();
                return created
                  ? undefined
                  : "A new conversation could not be started while the current session was changing. Try again.";
              } catch (error) {
                return `New conversation failed: ${error instanceof Error ? error.message : String(error)}`;
              }
            }}
            startConversationDisabledReason={busy
              ? "Stop the active turn before starting a new conversation."
              : undefined}
            scope={profileHubScope}
          />
        ) : skillsViewError ? <DeferredRouteFailure title="Skills" message={skillsViewError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading Skills" /> : null}
        {view === "vault" ? (
          <div class="work-view vault-route">
            {VaultScreen ? <VaultScreen
              snapshot={vaultSnapshot}
              runtimeAdopted={vaultRuntimeAdopted}
              usage={vaultUsageFacts}
              wipeAvailable={preferences.vaultBackend === "ephemeral"
                || (preferences.vaultBackend === "local-device" && Boolean(localDeviceHandle.current))
                || vaultSnapshot.phase === "ready"}
              wipeBusy={vaultWipeBusy}
              onWipeStorage={() => void wipeVaultStorage()}
              reclaimAvailable={vaultSnapshot.phase === "ready"}
              reclaimBusy={vaultReclaimBusy}
              onReclaimStorage={() => void reclaimVaultStorage()}
              onEraseContinuityRecord={() => {
                // Erases the witness alone: no journal, no drafts, no
                // preferences. A person who chose ephemeral for privacy gets to
                // remove the one thing that outlives the tab without giving up
                // the posture that keeps everything else out of storage.
                void loadReturnLedger().then(({ clearReturnLedger }) => {
                  const storage = browserReturnLedgerStorage();
                  if (storage) clearReturnLedger(storage);
                  setUnrecoveredWork(undefined);
                  setRuntimeStatus("Continuity record erased. A return will look like a first visit.");
                }).catch(() => setRuntimeStatus("The continuity record could not be erased."));
              }}
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
            /> : vaultViewError ? <DeferredRouteFailure title="Vault" message={vaultViewError} onRetry={retryDeferredChunk} class="panel" /> : <RouteSkeleton label="Loading the Vault interface" />}
            {preferences.vaultBackend === "local-device" ? (
              <div class="vault-setup-slot">
                {LocalDeviceVaultSetupScreen ? <LocalDeviceVaultSetupScreen
                  partition={LOCAL_DEVICE_PARTITION}
                  status={localDeviceStatus}
                  onActivate={activateLocalDeviceWorkspace}
                  onRestoreEncryptedBackup={restoreLocalDeviceBackup}
                  onExportEncryptedBackup={localDeviceStatus ? exportLocalDeviceBackup : undefined}
                  onExportExistingEncryptedBackup={exportExistingLocalDeviceBackup}
                  onReplaceExistingVault={() => wipeVaultStorage()}
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
        {view === "access" ? ProviderConnectionsScreen ? (
          <ProviderConnectionsScreen
            online={online}
            activeBinding={activeInferenceBinding}
            reconnectIntent={accessReconnectIntent}
            onAbandonReconnect={abandonReconnectRequest}
            onActivate={activateExternalInference}
            onDisconnect={disconnectExternalInference}
          />
        ) : providerFabricError ? <DeferredRouteFailure title="Providers" message={providerFabricError} onRetry={retryDeferredChunk} /> : <RouteSkeleton label="Loading Providers" /> : null}
      </main>
      </ViewErrorBoundary>

      <MobileNavigation
        view={view}
        moreOpen={mobileMoreOpen}
        chromeInert={platformOverlayOpen}
        chatPending={unreadTurnCount}
        onNavigate={navigatePrimary}
        onOpenMore={() => setMobileMoreOpen(true)}
        onCloseMore={() => setMobileMoreOpen(false)}
        onOpenCommandPalette={() => { setMobileMoreOpen(false); requestDeferredOverlay("Command Center"); }}
        onOpenSettings={() => requestDeferredOverlay("Preferences")}
      />
      {ApprovalDockView ? <ApprovalDockView broker={approvalBroker} /> : null}
      {deferredOverlayNoticeActive
        && deferredOverlayNoticePositionReady
        && !approvalDockWaitingVisible
        && !(approvalDockLoadFailed && approvalDockBlockedRequests > 0) ? (
        <div
          class="pwa-update"
          role={deferredOverlayFailure ? "alert" : "status"}
          aria-atomic="true"
          style={{ "--pwa-update-floor": `${deferredOverlayNoticeFloor}px` }}
        >
          <span>
            <strong>{deferredOverlayFailure
              ? `${deferredOverlayFailure} unavailable`
              : `Opening ${requestedDeferredOverlay ?? "controls"}…`}</strong>
            <small>{deferredOverlayFailure
              ? deferredOverlayRetryStarted
                ? "The retry did not load the interface. Reload Airship to fetch a fresh application; current workspace and conversation state stay intact."
                : "The interface code did not load. The shell remains usable and no preference, navigation, or shortcut action was applied."
              : "Loading the interface. You can cancel and continue using the shell."}</small>
          </span>
          {deferredOverlayFailure ? deferredOverlayRetryStarted ? (
            <button ref={deferredOverlayRecoveryAction} type="button" onClick={() => window.location.reload()}>Reload Airship</button>
          ) : (
            <button ref={deferredOverlayRecoveryAction} type="button" onClick={() => {
              const failed = deferredOverlayFailure;
              setDeferredOverlayFailure(undefined);
              setDeferredOverlayRetryStarted(true);
              requestDeferredOverlay(failed);
            }}>{`Retry ${deferredOverlayFailure}`}</button>
          ) : (
            <button type="button" onClick={() => {
              requestDeferredOverlay();
            }}>Cancel</button>
          )}
        </div>
      ) : null}
      {approvalDockWaitingVisible
        && approvalDockFailurePositionReady ? (
        <div
          class="pwa-update"
          role="status"
          aria-atomic="true"
          style={{ "--pwa-update-floor": `${approvalDockFailureFloor}px` }}
        >
          <span>
            <strong>Approval controls are loading</strong>
            <small>{`${approvalDockWaitingRequests === 1 ? "One capability request is" : `${approvalDockWaitingRequests} capability requests are`} waiting. No effect has run. You can deny ${approvalDockWaitingRequests === 1 ? "it" : "them"} now or wait for the controls.`}</small>
          </span>
          <button type="button" onClick={() => {
            approvalBroker.denyAll();
            requestAnimationFrame(() => {
              (textarea.current ?? mainRegion.current)?.focus({ preventScroll: true });
            });
          }}>Deny pending request</button>
        </div>
      ) : null}
      {approvalDockFailureVisible
        && approvalDockFailurePositionReady
        && !approvalDockWaitingVisible
        && (!deferredOverlayNoticeActive || approvalDockBlockedRequests > 0) ? (
        <div
          class="pwa-update"
          role="alert"
          aria-atomic="true"
          style={{ "--pwa-update-floor": `${approvalDockFailureFloor}px` }}
        >
          <span>
            <strong>{approvalDockBlockedRequests > 0
              ? "Approval unavailable · effect blocked"
              : "Approval controls unavailable"}</strong>
            <small>{approvalDockBlockedRequests > 0
              ? `${approvalDockBlockedRequests === 1 ? "The pending capability request was" : `${approvalDockBlockedRequests} pending capability requests were`} denied because approval controls did not load. ${approvalDockBlockedRequests === 1 ? "Its effect" : "Their effects"} did not run; workspace and conversation state were kept. Retry the controls, then run the action again.`
              : `${APPROVAL_DOCK_LOAD_FAILURE} Retry the controls before running the action again.`}</small>
            {approvalDockRetryStarted ? <small>{approvalDockLoading
              ? "Retrying approval controls now. Reload Airship if this notice does not clear."
              : "Approval controls still did not load. Reload Airship to fetch the current application."}</small> : null}
          </span>
          {approvalDockRetryStarted ? (
            <button type="button" onClick={() => window.location.reload()}>Reload Airship</button>
          ) : (
            <button type="button" onClick={() => {
              approvalDockRetryNeedsFocusReturn.current = true;
              setApprovalDockRetryStarted(true);
              beginApprovalDockLoad();
            }}>Retry approval controls</button>
          )}
        </div>
      ) : null}
      {Overlays ? <Overlays.CommandPalette open={paletteOpen} entries={paletteEntriesWithRail} onClose={() => requestDeferredOverlay()} onOpenShortcuts={() => requestDeferredOverlay("Keyboard shortcuts")} /> : null}
      {/* The keyboard layer's only printed form. Eleven chords shipped taught
          nowhere: `?`, `F1` and `Shift+/` all opened nothing, Preferences had no
          keyboard section, and the palette could not find the word "shortcut".
          Fetched on first use, like the approval dock and the resume report —
          the entry chunk's ceiling does not move for a sheet. */}
      {ShortcutSheetView ? (
        <ShortcutSheetView
          open={shortcutsOpen}
          profiles={managedProfiles(catalog).map((profile) => ({ name: profile.name }))}
          onClose={() => requestDeferredOverlay()}
        />
      ) : null}
      {Overlays ? <Overlays.PreferencesDialog open={preferencesOpen} value={preferences} onChange={(next: PreferenceOverrides) => {
        if (next.vaultBackend !== preferences.vaultBackend) {
          setPreferences((current) => Object.freeze({ ...next, vaultBackend: current.vaultBackend }));
          void changeVaultProvider(next.vaultBackend);
        }
        else setPreferences(next);
      }} onClose={() => requestDeferredOverlay()} vaultProviderSwitching={vaultProviderSwitching} vaultAdopted={vaultRuntimeAdopted} profileApproval={{
        mode: activeApprovalMode,
        onManage: () => {
          if (openProfileManager(profileId)) requestDeferredOverlay();
        },
      }} /> : null}
      {pendingModelSwitch && ConfirmDialogComp ? (
        <ConfirmDialogComp.ConfirmDialog
          title={`Switch this conversation to ${pendingModelSwitch.modelLabel}?`}
          confirmLabel={`Switch to ${pendingModelSwitch.modelLabel}`}
          cancelLabel="Keep the current model"
          onCancel={() => setPendingModelSwitch(undefined)}
          onConfirm={() => {
            const pending = pendingModelSwitch;
            setPendingModelSwitch(undefined);
            void pending.proceed();
          }}
        >
          <>
            This conversation is already using about {pendingModelSwitch.usedTokens.toLocaleString()} tokens,
            and {pendingModelSwitch.modelLabel}&rsquo;s context window is {pendingModelSwitch.windowTokens.toLocaleString()}.
            The next reply will compress what came before to fit: wording in the thread
            is summarized under the new model&rsquo;s window, while the full history and its
            receipts stay intact and auditable.
          </>
        </ConfirmDialogComp.ConfirmDialog>
      ) : null}
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
              <small>Binding this Profile&rsquo;s conversation, workspace, terminal sessions, memory, skills, and provider route.</small>
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
  const title = requestedTitle?.trim() || appMintedConversationTitle(profile.name);
  if (title.length > 240 || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error("The conversation title is invalid.");
  return runtime.journal.createSession(title, manifest);
}

/**
 * The names Airship gives a conversation before its content has named it.
 *
 * One table, because these strings are written by three code paths and read by
 * a fourth: the first-message titler asks "is this still the name the app gave
 * it?" and compared against the new-conversation default only. A conversation
 * minted by vault adoption therefore kept "General · encrypted vault" forever,
 * and the Atlas found five of them stacked in the library — one being the
 * thread whose first message was "Draft the Q3 pricing memo intro paragraph."
 * The storage backend was naming the memo instead of the memo naming itself.
 *
 * A name written by a person, a rename, a fork or a policy change is never in
 * this set, so the titler cannot overwrite one.
 */
const APP_MINTED_TITLE_SUFFIX = Object.freeze({
  default: " conversation",
  vault: " · encrypted vault",
  ephemeral: " · ephemeral",
} as const);

export function appMintedConversationTitle(
  profileName: string,
  kind: keyof typeof APP_MINTED_TITLE_SUFFIX = "default",
): string {
  return `${profileName}${APP_MINTED_TITLE_SUFFIX[kind]}`;
}

export function isAppMintedConversationTitle(title: string, profileName: string): boolean {
  const normalized = title.trim();
  return (Object.keys(APP_MINTED_TITLE_SUFFIX) as (keyof typeof APP_MINTED_TITLE_SUFFIX)[])
    .some((kind) => normalized === appMintedConversationTitle(profileName, kind));
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
  /*
   * Loaded here, not imported at the top of this file: `tool-surface` reaches
   * prime's whole tool vocabulary and the kernel host, and a static import
   * dragged all of it into the eager entry bundle — 451 KiB raw against a
   * 384 KiB ceiling, 67 KiB of first paint spent on a surface that cannot be
   * used until someone starts a conversation. Starting one is already a
   * deferred moment, so the chunk arrives exactly when it is needed.
   */
  const { primeToolDefinitions } = await import("../prime/runtime/tool-surface");
  const manifest = await createSessionManifest({
    systemPrompt: pin.systemPrompt,
    providerId: runtime.inferenceBinding?.providerId ?? runtime.transport.id,
    model: runtime.model,
    ...(runtime.inferenceBinding ? { inferenceBinding: runtime.inferenceBinding } : {}),
    /*
     * A new conversation is a prime conversation, so it pins prime's tool
     * surface — its file and search vocabulary, the persistent kernel's
     * `execute_code`, the RLM family — rather than Airship's alone.
     *
     * This has to happen here and nowhere else. `toolManifestDigest` is
     * immutable and the session refuses any registry that does not match it,
     * so a turn that composes a richer surface than its manifest pinned is
     * refused with "The tool manifest changed" — every turn, for the life of
     * the conversation. Pinning at birth is the only moment the two can be
     * made to agree.
     *
     * Conversations created before this keep the surface they pinned and keep
     * working: `runPrimeTurn` compares the composed surface against the
     * manifest and falls back to the registry the session was built with
     * rather than marching anyone into a fork they did not ask for.
     */
    tools: [...primeToolDefinitions({ workspace: runtime.workspace, airship: runtime.tools })],
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

/**
 * The same resolution, as the ordered shelf rather than only its top row, so
 * adoption can try the next conversation when one refuses to replay.
 */
async function compatibleProfileSessions(
  runtime: Runtime,
  profile: ProfileRevision,
  catalog: ProfileCatalog,
): Promise<readonly SessionRecord[]> {
  const expected = await createProfileSessionManifest(runtime, profile, catalog);
  return resumableProfileConversationCandidates(runtime.journal, profile.profileId, expected);
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

type ModelSwitchOutcome = "in-place" | "confirming-compression" | void;

/**
 * What this conversation is using right now, answered from the journal's own
 * usage records. No usage record means nothing measurable, so the compression
 * gate stays silent instead of guessing.
 */
async function recentSessionUseTokens(journal: EventJournal, session: SessionRecord): Promise<number | undefined> {
  const events = await journal.readEvents(session.id, Math.max(0, session.headSequence - 400));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "inference.usage") continue;
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as { inputTokens?: unknown; outputTokens?: unknown }
      : undefined;
    const input = typeof payload?.inputTokens === "number" ? payload.inputTokens : 0;
    const output = typeof payload?.outputTokens === "number" ? payload.outputTokens : 0;
    if (input + output > 0) return input + output;
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
    version: 2,
    connectionId: route.pin.connection.id,
    connectionGeneration: route.pin.connection.generation,
    providerId: route.pin.provider.id,
    providerLabel: route.pin.provider.label,
    providerRevision: route.pin.provider.revision,
    transportId: route.transport.id,
    protocol: route.pin.provider.protocol,
    authMethod: route.pin.connection.authKind === "oauth-public-pkce"
      ? "oauth-pkce"
      : route.pin.connection.authKind,
    transportBoundary: route.pin.provider.transportBoundary,
    modelId: route.pin.model.id,
    boundAt: route.pin.pinnedAt,
  });
}

/** The visible URL remains the authority for an in-flight return transaction. */
function requireCurrentReconnectIntent(intent: AccessReconnectIntent): void {
  const current = typeof window === "undefined"
    ? undefined
    : parseAccessReconnectIntent(window.location.hash);
  if (!reconnectIntentsEqual(current, intent)) {
    throw new Error("The return request was abandoned or changed. The conversation and inference route were left unchanged.");
  }
}

function reconnectSelectionGuard(intent: AccessReconnectIntent, callerSignal?: AbortSignal): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const cancelIfChanged = () => {
    const current = parseAccessReconnectIntent(window.location.hash);
    if (!reconnectIntentsEqual(current, intent)) {
      controller.abort(new DOMException("Return request changed before selection.", "AbortError"));
    }
  };
  const cancelFromCaller = () => {
    controller.abort(callerSignal?.reason ?? new DOMException("Provider activation cancelled.", "AbortError"));
  };
  const navigationEvents = ["hashchange", "popstate", "airship:n"] as const;
  navigationEvents.forEach((type) => window.addEventListener(type, cancelIfChanged));
  callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
  if (callerSignal?.aborted) cancelFromCaller();
  cancelIfChanged();
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      navigationEvents.forEach((type) => window.removeEventListener(type, cancelIfChanged));
      callerSignal?.removeEventListener("abort", cancelFromCaller);
    },
  });
}

/** Abort a read-only preparation step without pretending its underlying work
 * was cancelled. The guarded import/audit may finish in the background, but it
 * has no mutation to publish; the route transaction can yield immediately. */
function abortableReconnectRead<T>(pending: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(pending);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve(pending).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
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

function combinedInferenceAvailability(
  providerSnapshot: InferenceAvailabilitySnapshot,
  activeBinding: SessionManifest["inferenceBinding"],
): InferenceAvailabilitySnapshot {
  const activeConnectionId = activeBinding?.connectionId;
  const ordered = [...providerSnapshot.connections]
    .filter((connection, index, values) =>
      values.findIndex((candidate) => candidate.id === connection.id) === index
    )
    .sort((left, right) =>
      Number(right.id === activeConnectionId) - Number(left.id === activeConnectionId)
      || left.providerLabel.localeCompare(right.providerLabel)
      || left.id.localeCompare(right.id)
    );
  const bounded = Object.freeze(ordered.slice(0, 16));
  const projectedActive = providerSnapshot.activeSession;
  const activeSession = activeBinding
    ? projectedActive
      && projectedActive.providerId === activeBinding.providerId
      && projectedActive.connectionId === activeBinding.connectionId
      && projectedActive.modelId === activeBinding.modelId
        ? projectedActive
        : Object.freeze({
            providerId: activeBinding.providerId,
            connectionId: activeBinding.connectionId,
            modelId: activeBinding.modelId,
            immutable: true as const,
            resolution: "connection-missing" as const,
          })
    : projectedActive;
  return Object.freeze({
    version: 1,
    capturedAt: providerSnapshot.capturedAt,
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

function runtimeForSessionRecord(runtime: Runtime, session: SessionRecord): Runtime {
  const model = effectiveSessionModel(session);
  return {
    ...runtime,
    model,
    ...(runtime.inferenceBinding
      ? { inferenceBinding: Object.freeze({ ...runtime.inferenceBinding, modelId: model }) }
      : { inferenceBinding: undefined }),
  };
}

export function activeSessionRuntime(
  runtime: SessionRuntimeAuthority,
  authoritySession: SessionRecord,
  routeSession: SessionRecord = authoritySession,
): ActiveSessionRuntime {
  /*
   * Navigation restores the route carried by the thread being opened; it does
   * not compare that thread with whichever model happened to be on screen.
   * The current authority still supplies the live Profile boundaries, provider
   * account and credential generation. Only the model address is thread-local,
   * and `session.model-changed` is its durable source of truth.
   */
  return sessionManifestRuntime(runtime, authoritySession.manifest, effectiveSessionModel(routeSession));
}

function sessionManifestRuntime(
  runtime: SessionRuntimeAuthority,
  manifest: SessionManifest,
  model: string = runtime.model,
): ActiveSessionRuntime {
  const profile = manifest.profile;
  const inferenceBinding = runtime.inferenceBinding
    ? Object.freeze({ ...runtime.inferenceBinding, modelId: model })
    : undefined;
  return Object.freeze({
    providerId: runtime.inferenceBinding?.providerId ?? runtime.transport.id,
    model,
    ...(inferenceBinding ? { inferenceBinding } : {}),
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
        // The governing boundaries travel with the runtime side of the
        // comparison, so `decideSessionResume` can refuse a changed workspace,
        // memory scope or approval policy without having to refuse
        // every cosmetic revision along with them.
        ...(profile.version === 2 ? {
          workspaceBinding: profile.workspaceBinding.kind === "workspace-id"
            ? `workspace-id:${profile.workspaceBinding.workspaceId}`
            : "active-workspace",
          memoryScope: enforcedMemoryScope(profile.memoryScope),
          approvalMode: profile.approvalMode,
        } : {}),
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


/**
 * The `skillModes` map `setProfileSkill` commits. An explicit "inherit" is
 * deleted, not stored.
 *
 * `resolveSkillDecisions` reads `skillModes[id] ?? "inherit"`
 * (`src/profiles/domain.ts`), so an explicit entry and no entry are the same
 * decision, the same `skillSetDigest` and the same composed prompt. Storing one
 * was invisible until skills became authorable, and then it was not: setting a
 * profile's control to "Inherit global" and back left a key behind, and the
 * removal path — which asks `skillReferences` whether any profile still uses the
 * skill — read that key as a profile that does. Remove then refused permanently,
 * naming a profile the skill does not affect, and `validateProfileCatalog`
 * refuses a `skillModes` key with no matching revision, so nothing inside the
 * product could clear it. Both refuters found this independently, from opposite
 * ends.
 *
 * Deleting costs no extra revision: this call already mints one.
 */
function profileSkillModes(
  current: Readonly<Record<string, SkillMode>>,
  skillId: string,
  mode: SkillMode,
): Record<string, SkillMode> {
  const next = { ...current };
  if (mode === "inherit") delete next[skillId];
  else next[skillId] = mode;
  return next;
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

/** One capability vocabulary for every cloud and local provider route. */
function externalModelCapabilityDetail(model: InferenceModelDescriptor): string | undefined {
  const labels: string[] = [];
  if (providerModelCapability(model, "image-input") === "supported") labels.push("Vision");
  if (providerModelCapability(model, "tool-calling") === "supported") labels.push("Tools");
  if (providerModelCapability(model, "embeddings") === "supported") labels.push("Embeddings");
  if (providerModelCapability(model, "text-input") === "unknown" || providerModelCapability(model, "text-output") === "unknown") {
    labels.push("Chat capability unconfirmed");
  }
  return labels.length ? labels.join(" · ") : undefined;
}

function externalModelSelectionId(connectionId: string, modelId: string): string {
  return `${connectionId}\u0000${modelId}`;
}

function chatModelCapable(model: Pick<InferenceModelDescriptor, "capabilities">): boolean {
  // Unknown is not a name-based guess. It is the honest state for a local
  // directory that advertises an id but omits capability fields (common for
  // Ollama /api/tags). Only explicit non-text evidence is disabled; the one
  // selected model may then be checked by its protected invocation.
  const textInput = model.capabilities["text-input"]?.state;
  const textOutput = model.capabilities["text-output"]?.state;
  const embeddingOnly = model.capabilities.embeddings?.state === "supported"
    && textInput !== "supported"
    && textOutput !== "supported";
  return !embeddingOnly
    && textInput !== "unsupported"
    && textOutput !== "unsupported";
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

/** Resolve the exact theme revision a profile selected, when it is available. */
function profileThemeFor(catalog: ProfileCatalog, profileId: string): ThemeManifest | undefined {
  const profile = catalog.profiles.find((candidate) => candidate.profileId === profileId);
  return profile
    ? catalog.themes.find((theme) => theme.themeId === profile.theme.themeId && theme.digest === profile.theme.digest)
    : undefined;
}

/**
 * Keep profile marks recognisable across the picker while using only semantic
 * theme roles. The muted mix is applied in CSS so the initials remain legible
 * in both light and dark themes.
 */
function profileBadgeStyle(theme?: ThemeManifest): Readonly<Record<string, string>> | undefined {
  if (!theme) return undefined;
  return Object.freeze({
    "--profile-accent": theme.colors.accent,
    "--profile-accent-bright": theme.colors.accentBright,
    "--profile-ground": theme.colors.ground,
    "--profile-surface": theme.colors.surface,
  });
}

function BootScreen({ status, failure, onReload }: Readonly<{
  status: string;
  failure?: string;
  onReload(): void;
}>) {
  return (
    <main class="boot-screen" data-state={failure ? "failed" : "checking"}>
      <StatusMark
        class="boot-mark"
        state={failure ? "failed" : "checking"}
        acting={!failure}
        label={failure ? "Local kernel did not start" : "Preparing Airship"}
        detail={status}
        size={32}
        compact
      />
      <span class="eyebrow">Airship edge runtime</span>
      <h1>{failure ? "The local kernel did not start" : "Preparing the local kernel"}</h1>
      <p role="status" aria-live="polite">{status}</p>
      {failure ? <>
        <button type="button" onClick={onReload}>Reload Airship</button>
        <details>
          <summary>Technical details</summary>
          <code>{failure.slice(0, 500)}</code>
        </details>
      </> : null}
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
      ? "The cloud object-store checks passed, but this active runtime has not adopted it; this session remains in page memory."
      : "This session journal exists only in page memory. Nothing is synced.",
  });
}

/**
 * The failure sentence the card is showing, for the channel that speaks it.
 *
 * A thrown provider diagnostic is another program's text landing in this
 * person's page, so it is bounded and stripped exactly like every other
 * passed-through string here. An empty or absurdly long value yields nothing
 * and the caller falls back to the mapped vocabulary rather than speaking
 * something that reads like a stack trace.
 */
function turnFailureCause(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : "";
  const clean = raw.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean || clean.length > 400) return undefined;
  return clean;
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

function MessageCard({
  message,
  capabilityTier,
  onCopy,
  onRetry,
  onResend,
  onEdit,
  onBranch,
  branchDisabled,
  streamStore,
  reasoningStore,
}: {
  message: UiMessage;
  capabilityTier?: SessionManifest["capabilityTier"];
  onCopy: () => Promise<void>;
  onRetry: () => void;
  /** Present only on a failed turn whose prompt this page still holds. */
  onResend?: () => void;
  onEdit: () => void;
  onBranch: () => void;
  branchDisabled: boolean;
  streamStore: TranscriptStreamStore;
  reasoningStore: TranscriptStreamStore;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailure, setCopyFailure] = useState<string>();
  /*
   * The Profile's density decides which of this card's *explanatory* extras
   * mount at all. The model chip, the capability pill, the disposition line
   * and the run row are commentary and trace labels — never the work itself,
   * so minimal spends nothing on them while the journal keeps the turn.
   */
  const density = usePresentationDensity();
  async function copyMessage(): Promise<void> {
    setCopyFailure(undefined);
    try {
      await onCopy();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch (error) {
      setCopied(false);
      setCopyFailure(`Copy failed: ${error instanceof Error ? error.message : String(error)} Select the message text and use your browser's Copy command.`);
    }
  }

  return (
    <article
      class={`message ${message.role} ${message.error ? "error" : ""}`}
      /* A failed turn was styled as an error and named like a success: browse
         mode read `Airship message` over a card badged FAILED TURN, so the one
         signal a reader could not get was the disposition. The name carries it
         because the alternative — role="alert" on a transcript row — would
         re-announce every historical failure on every replay. */
      aria-label={`${message.role === "user" ? "Your" : "Airship"} message${message.error ? " — failed turn" : ""}`}
      data-message-role={message.role}
      {...(message.error ? { "data-turn-failed": "true" } : {})}
      /* The trace address carries a turn id, and the rendered receipt is where
         this card learns it. A row without one (a local command, a marker)
         simply has no attribute, which is why `focusTranscriptTurn` reports
         "not-rendered" rather than pretending it landed. */
      {...(message.receipt?.turnId ? { "data-turn-id": message.receipt.turnId } : {})}
      data-transcript-card
    >
      <div class="message-body">
        <div class="message-label">
          <strong>{message.role === "user" ? "You" : "Airship"}</strong>
          {message.role === "assistant" && capabilityTier && densityAllows("telemetry", density) ? (
            <span
              class={`message-capability-tier ${capabilityTier}`}
              title={`Initial session observation. ${capabilityTierDetail(capabilityTier)} Tool results name their live producing runtime separately.`}
            >
              {/* The dot and the words are separate elements because text
                  cannot be ellipsised while it is an anonymous flex item — the
                  same reason `.runtime-line` carries a `__text` span. */}
              <span class="message-capability-tier__dot" aria-hidden="true" />
              <span class="message-capability-tier__label">Initial · {capabilityTierLabel(capabilityTier)}</span>
            </span>
          ) : null}
          {message.status ? (
            // `title` so the truncated form at 320px is still readable on hover
            // and long-press; the accessible text is the full string either way.
            <span class="message-status" title={message.status}>
              <span class="pulse-dot" />
              <span class="message-status__text">{message.status}</span>
            </span>
          ) : null}
        </div>
        {/*
          Reading order, and nothing else decides it.
          `message.parts` is the ordered spine: `turn.reasoning` is journaled
          once per inference step, so the durable parts already interleave each
          step's reasoning with the tool calls and text around it. What was
          wrong was this overlay — the live reasoning block sat *above* the
          whole row, so a second step's thinking appeared at the top, before
          the tool call that provoked it, and every later thought piled into
          the same box at the head of the message.
          The two live slots belong where the turn actually is: after
          everything already settled, reasoning first because it precedes the
          answer it produced. When the step's `turn.reasoning` lands, the live
          buffer clears and the durable part takes its place in the sequence,
          so the same thought is never in two positions at once.
        */}
        {message.parts?.length ? (
          <DeferredMessageParts
            parts={message.parts}
            live={message.status !== undefined}
            {...(message.liveToolOutput ? { liveOutput: message.liveToolOutput } : {})}
            onRetry={onResend}
          />
        ) : <p>{message.content || " "}</p>}
        <StreamingReasoningSlot
          store={reasoningStore}
          answerStore={streamStore}
          messageId={message.id}
          active={message.status !== undefined}
          settled={Boolean(message.parts?.length)}
        />
        <StreamingMessageSlot store={streamStore} messageId={message.id} active={message.status !== undefined} />
        {/* The pinned "Live tool output" block is retired. It rendered under
            the whole message while the step that produced it sat above with
            the other operations, so a reader had to match a shell's stdout to
            its own call by eye. `MessagePartsView` puts it inside that
            operation's row, in the result slot it is about to become. Still no
            live region: the <pre> re-renders per chunk and a polite region
            would re-announce the whole buffer each time. */}
        {/* A disposition that explains a healthy turn is commentary and goes
            quiet with the density; one that says the turn ended badly or that
            the provider could not carry it forward is a warning, and warnings
            only ever render when they require attention. */}
        {message.history && (densityAllows("commentary", density)
          || message.history.turnStatus !== "completed"
          || message.history.providerContext === "excluded") ? (
          <div class="message-history" role="group" aria-label="Durable turn disposition">
            <span class={message.history.turnStatus}>{message.history.turnStatus} turn</span>
            <span class={message.history.providerContext}>
              {message.history.providerContext === "included" ? "In provider context" : "Excluded from provider context"}
            </span>
          </div>
        ) : null}
        {message.receipt ? <DeferredRunDetails receipt={message.receipt} /> : null}
        {copyFailure ? <p class="message-copy-failure" role="alert">{copyFailure}</p> : null}
        {/* Pointer devices get a reserved footer toolbar that fades on
            hover/focus; touch devices get the disclosure below. This is
            deliberately not one `<details>` for both: engines do not paint a
            closed details body, so hiding only its summary can leave desktop
            actions measurable but unreachable. */}
        <div class="message-actions" role="toolbar" aria-label="Message actions">
          <div class="message-actions-row">
            <button
              type="button"
              onClick={() => void copyMessage()}
            >{copied ? "Copied" : "Copy"}</button>
            {/* Retry is a regeneration from the immutable pre-turn boundary.
                The prior answer remains inspectable in the source conversation
                but cannot contaminate the retry branch's provider context.

                The sentence is `FORK_RETRY_TOOLTIP`, not a literal: as a
                literal it drifted until it claimed the prior answer's
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
            <button type="button" onClick={() => void copyMessage()}>{copied ? "Copied" : "Copy"}</button>
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
   * The outcome is the contract, not the absence of a rejection: the App-level
   * wrapper deliberately converts a refusal into the exact message this route
   * must render beside its initiating control.
   */
  onActivate: (profileId: string) => Promise<ProfileSwitchFailure>;
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
   * A refusal carries the same exact message as the global runtime report. The
   * local alert is the authority on touch layouts where that global line is
   * hidden or truncated.
   */
  async function activate() {
    setBusy(true);
    setStatus(undefined);
    try {
      const failure = await onActivate(selected.profileId);
      if (failure) setStatus(failure);
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
                <span class="profile-monogram" style={profileBadgeStyle(profileThemeFor(catalog, profile.profileId))}>{profileMonogram(profile.name)}</span>
                {/* The catalog clamps a long name to three lines so one profile
                    cannot set the height of the whole row; the title is how the
                    rest of it is recovered without selecting the card. */}
                <span><strong title={profile.name}>{profile.name}</strong><small>{profile.description}</small></span>
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
                <label><span>Web requests</span><MenuSelect ariaLabel="Profile web egress" value={draft.webEgress} options={[
                  { value: "node-first", label: "Client Node first", description: "Use the shipped Node http/https relay, then browser-direct as fallback" },
                  { value: "browser-only", label: "Browser only", description: "Opt out of Node egress; cross-origin reads remain subject to CORS" },
                ]} onChange={(webEgress) => setDraft({ ...draft, webEgress: webEgress as ProfileEditorDraft["webEgress"] })} /></label>
                {/*
                  What a fetch is allowed to bring back. Wide open is the
                  default and the point: the agent asked for the address, so
                  the agent judges the answer. The narrow setting is here for a
                  profile that wants nothing but text crossing the boundary.
                */}
                <label><span>Web responses</span><MenuSelect ariaLabel="Profile web bodies" value={draft.webBodies} options={[
                  { value: "any", label: "Any format", description: "Text arrives as text; anything else is saved to the workspace for the agent to handle" },
                  { value: "text-only", label: "Text only", description: "Refuse a response whose bytes are not text, and never save a download" },
                ]} onChange={(webBodies) => setDraft({ ...draft, webBodies: webBodies as ProfileEditorDraft["webBodies"] })} /></label>
                {/*
                  The Profile's presentation density: how much chatter the app
                  renders around the work. Minimal keeps the work, the tools,
                  and the answer; Balanced restores run metadata, counters,
                  and suggestions where they are relevant; Instrumented adds
                  every digest, receipt, and diagnostic to the surface. It is
                  display-only — the same work runs, the same records land —
                  and it saves with the profile revision, Profile-local beside
                  the global Preferences.
                */}
                <label><span>Presentation</span><MenuSelect ariaLabel="Profile presentation density" value={draft.density} options={[
                  { value: "minimal", label: "Minimal", description: "The work and the answer; everything else one action away" },
                  { value: "balanced", label: "Balanced", description: "Run metadata, counters, and suggestions where they are relevant" },
                  { value: "instrumented", label: "Instrumented", description: "Every digest, receipt, and diagnostic on the surface" },
                ]} onChange={(density) => setDraft({ ...draft, density: density as ProfileEditorDraft["density"] })} /></label>
                {/*
                  Display-only, like every entry in this row's class: the choice
                  changes how deeply a turn's reasoning begins expanded and
                  nothing else — never what runs, what is stored, or what the
                  audit sees.
                */}
                <label><span>Reasoning</span><MenuSelect ariaLabel="Profile reasoning display" value={draft.reasoningVisibility} options={[
                  { value: "collapsed", label: "Summary", description: "A headline line; the full reasoning opens on demand" },
                  { value: "expanded", label: "Show by default", description: "The full provider-exposed reasoning starts open" },
                ]} onChange={(reasoningVisibility) => setDraft({ ...draft, reasoningVisibility: reasoningVisibility as ProfileEditorDraft["reasoningVisibility"] })} /></label>

                {draft.workspaceBinding === "workspace-id" ? <label><span>Workspace ID</span><input value={draft.workspaceId} maxLength={512} placeholder="vault+gdrive://…" onInput={(event) => setDraft({ ...draft, workspaceId: event.currentTarget.value })} /></label> : null}
              </div>
              <p class="profile-boundary-note">{PROFILE_BOUNDARY_NOTE}</p>
            </details>
            <div class="revision-strip">
              {/* Every cell in this strip is `nowrap` with an ellipsis, and a
                  quarter of the strip is not enough for a provider and a model
                  name: "airship-demo · airship…" truncated at 1920px, with no
                  hover recovery anywhere. The `title` is the same recovery the
                  terminal's shell path already uses for the same reason. */}
              <span title={`${selected.providerId} · ${selected.model}`}><small>Runtime</small>{selected.providerId} · {selected.model}</span>
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
              {/*
                * `save()` deliberately leaves the preview armed — the paint
                * bookkeeping and its unmount restore both depend on the flag —
                * so this claim has to be about the theme rather than about the
                * flag. Unconditional, it sat beside "Revision saved to the
                * encrypted Vault" calling the saved theme unsaved, and a reader
                * who believed it pressed "Cancel preview" on a theme it had
                * just kept.
                */}
              {previewThemeId ? <span>{previewThemeId === selected.theme.themeId ? "Previewing this profile's saved theme" : "Previewing — not saved"}</span> : null}
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

/**
 * The route bar for the two headers the *entry chunk* renders.
 *
 * Not `<RouteHeader>`, and the reason is a budget rather than a preference:
 * `release-gate.mjs` classifies `route-header.tsx` as "shared route chrome
 * fetched with any route, never at first paint", and importing it from
 * `app.tsx` makes it a modulepreload of the entry — 1.9 KiB gzip of first
 * paint bought for two headers, on a product whose startup cap has never
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

function humanStatus(value: string): string {
  if (value === "thinking") return "Thinking";
  if (value === "complete") return "Finalizing run details";
  return value.replace(/^running /u, "Running ");
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
    webEgress: resolveProfileWebEgress(profile),
    webBodies: resolveProfileWebBodies(profile),
    reasoningVisibility: parseReasoningVisibility(profile.presentation?.reasoningVisibility),
    density: parsePresentationDensity(profile.presentation?.density),
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

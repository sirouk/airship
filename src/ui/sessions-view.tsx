import type { SessionManifest } from "../core/contracts";
import {
  type ActiveSessionRuntime,
  type SessionListPage,
  type SessionListSort,
} from "../sessions/domain";
import {
  SessionLibrary,
  type SessionForkResult,
  type SessionLibraryDetail,
} from "../sessions/library";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import "./sessions-view.css";
import { DurabilityIndicator, durabilityLabel, type DurabilityState } from "./durability-indicator";
import { Popover } from "./popover";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import { groupPinnedSessions, pagePinnedSessionIds, setPageSessionPinned } from "./session-pins";
import {
  SESSION_SEARCH_PLACEHOLDER,
  SESSION_TITLE_MAX,
  forkTitleFor,
  relativeSessionTime,
  sessionEmptyStateBody,
  sessionEventCount,
  sessionIntegrityRow,
  sessionLineage,
  shortSessionId,
} from "./sessions-presentation";

export type SessionsViewProps = Readonly<{
  library: SessionLibrary;
  runtime?: ActiveSessionRuntime;
  activeSessionId?: string;
  /** Optional host-created manifest used when a fork should move to the active runtime. */
  forkManifest?: SessionManifest;
  revision?: number;
  onResume: (detail: SessionLibraryDetail) => void | Promise<void>;
  onForked?: (result: SessionForkResult, source: SessionLibraryDetail) => void | Promise<void>;
  onOpenProof?: (sessionId: string) => void;
  durability?: Readonly<{ state: DurabilityState; detail: string }>;
}>;

/** The journal-adapter sentence, unchanged, chosen by the adapter that is live. */
function journalAdapterSentence(state: DurabilityState): string {
  return state === "synced"
    ? "Client-encrypted cloud journal; writes commit directly from this browser."
    : "Page-memory journal; remote availability is not inferred.";
}

function durabilitySeal(state: DurabilityState): SealState {
  return state === "ephemeral" ? "none" : state === "syncing" ? "checking" : "verified";
}

export function SessionsView({
  library,
  runtime,
  activeSessionId,
  forkManifest,
  revision = 0,
  onResume,
  onForked,
  onOpenProof,
  durability = { state: "ephemeral", detail: "This journal exists only in page memory. Nothing is synced." },
}: SessionsViewProps) {
  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [profileId, setProfileId] = useState("");
  const [sort, setSort] = useState<SessionListSort>("updated-desc");
  const [page, setPage] = useState<SessionListPage>();
  const [selectedId, setSelectedId] = useState(activeSessionId);
  const [detail, setDetail] = useState<SessionLibraryDetail>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkTitle, setForkTitle] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(pagePinnedSessionIds);

  const runtimeKey = useMemo(() => runtimeFingerprint(runtime), [runtime]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draftSearch), 140);
    return () => clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingList(true);
    setError(undefined);
    void library.list({
      search,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(profileId ? { profileId: profileId as string | "unbound" } : {}),
      sort,
      limit: 200,
    }, controller.signal).then(
      (next) => {
        setPage(next);
        setSelectedId((current) => current ?? (activeSessionId && next.items.some((item) => item.id === activeSessionId)
          ? activeSessionId
          : next.items[0]?.id));
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoadingList(false);
    });
    return () => controller.abort();
  }, [activeSessionId, library, model, profileId, providerId, refresh, revision, search, sort]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    const controller = new AbortController();
    setLoadingDetail(true);
    setDetailError(undefined);
    setForkOpen(false);
    setRenaming(false);
    void library.inspect(selectedId, runtime, controller.signal).then(
      setDetail,
      (caught: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(undefined);
          setDetailError(errorMessage(caught));
        }
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoadingDetail(false);
    });
    return () => controller.abort();
  }, [library, refresh, revision, runtimeKey, selectedId]);

  async function resumeSelected() {
    if (!detail || detail.compatibility?.action !== "resume" || detail.session.id === activeSessionId) return;
    setBusy(true);
    setDetailError(undefined);
    try {
      await onResume(detail);
      setAnnouncement(`${detail.session.title} is now the active session.`);
    } catch (caught) {
      setDetailError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function prepareFork() {
    if (!detail) return;
    setForkTitle(forkTitleFor(detail.session.title));
    setForkOpen(true);
    setDetailError(undefined);
  }

  async function createFork() {
    if (!detail || !forkTitle.trim()) return;
    setBusy(true);
    setDetailError(undefined);
    try {
      const result = await library.fork(detail.session.id, {
        title: forkTitle,
        ...(forkManifest ? { manifest: forkManifest } : {}),
        expectedSourceHead: {
          sequence: detail.session.headSequence,
          digest: detail.session.headDigest,
        },
      });
      await onForked?.(result, detail);
      setForkOpen(false);
      setSelectedId(result.session.id);
      setRefresh((value) => value + 1);
      setAnnouncement(`Created ${result.session.title} as a new session. Source history was not rewritten.`);
    } catch (caught) {
      setDetailError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function renameSelected() {
    if (!detail || !renameTitle.trim()) return;
    setBusy(true);
    try {
      const renamed = await library.rename(detail.session.id, renameTitle);
      setRenameTitle("");
      setRenaming(false);
      setRefresh((value) => value + 1);
      setAnnouncement(`Renamed session to ${renamed.title}.`);
    } catch (caught) {
      setDetailError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function clearFilters() {
    setDraftSearch("");
    setSearch("");
    setProviderId("");
    setModel("");
    setProfileId("");
  }

  const filterActive = Boolean(search || providerId || model || profileId);
  const groupedSessions = groupPinnedSessions(page?.items ?? [], pinned);
  // Lineage is only navigable to a conversation the current filter actually
  // loaded, so the parent lookup is built from what is on screen rather than
  // from a promise that a second read would succeed.
  const titleById = useMemo(
    () => new Map((page?.items ?? []).map((item) => [item.id, item.title] as const)),
    [page?.items],
  );
  const ordered = [...groupedSessions.pinned, ...groupedSessions.other];

  return (
    <section class="session-library-view" aria-labelledby="session-library-title">
      <RouteHeader
        routeId="sessions"
        density="tool"
        title="All conversations"
        headingId="session-library-title"
        eyebrow="Conversation history"
        description="Open a thread where you left it. Pinned runtime details remain available for audit; a fork appears only when its meaning genuinely changes."
        status={
          /* The journal-adapter panel used to be a 52px card that `display:none`d
             itself below 1180px — the storage claim vanished on every tablet and
             phone. As a header chip it renders at every width, and its sentence
             and its durability seal are both one gesture away instead of one
             breakpoint away. */
          <Popover
            class="session-journal-chip"
            label={`Current journal adapter. ${durabilityLabel(durability.state)}. Opens where this journal is written and what is not inferred from it.`}
            heading="Current journal adapter"
            trigger={<Seal state={durabilitySeal(durability.state)} label={durabilityLabel(durability.state)} density="chip" />}
          >
            <p class="session-journal-chip__body">{journalAdapterSentence(durability.state)}</p>
            <DurabilityIndicator state={durability.state} detail={durability.detail} />
          </Popover>
        }
      />

      <div class="session-library-toolbar" role="search" aria-label="Filter sessions">
        <label class="session-library-search">
          <span class="session-library-visually-hidden">{SESSION_SEARCH_PLACEHOLDER}</span>
          <Icon name="context" size={17} />
          <input
            type="search"
            value={draftSearch}
            onInput={(event) => setDraftSearch(event.currentTarget.value)}
            placeholder={SESSION_SEARCH_PLACEHOLDER}
            autocomplete="off"
            spellcheck={false}
          />
        </label>
        <MenuSelect
          className="session-filter-menu"
          placement="down"
          ariaLabel="Filter by provider"
          value={providerId}
          options={[{ value: "", label: "All providers" }, ...(page?.facets.providers.map((provider) => ({ value: provider, label: provider })) ?? [])]}
          onChange={setProviderId}
        />
        <MenuSelect
          className="session-filter-menu"
          placement="down"
          ariaLabel="Filter by model"
          value={model}
          options={[{ value: "", label: "All models" }, ...(page?.facets.models.map((modelId) => ({ value: modelId, label: modelId })) ?? [])]}
          onChange={setModel}
        />
        <MenuSelect
          className="session-filter-menu"
          placement="down"
          ariaLabel="Filter by profile"
          value={profileId}
          options={[
            { value: "", label: "All profiles" },
            { value: "unbound", label: "No profile binding" },
            ...(page?.facets.profiles.map((profile) => ({ value: profile, label: profile })) ?? []),
          ]}
          onChange={setProfileId}
        />
        <MenuSelect
          className="session-filter-menu session-library-sort-menu"
          placement="down"
          ariaLabel="Sort sessions"
          value={sort}
          options={[
            { value: "updated-desc", label: "Recently active" },
            { value: "created-desc", label: "Recently created" },
            { value: "title-asc", label: "Title A–Z" },
          ]}
          onChange={(next) => setSort(next as SessionListSort)}
        />
        {filterActive ? <button type="button" onClick={clearFilters}>Clear</button> : null}
        <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loadingList} aria-label="Refresh session library">
          {loadingList ? "Reading…" : "Refresh"}
        </button>
      </div>

      {error ? <div class="session-library-alert error" role="alert"><Icon name="warning" /><span>{error}</span></div> : null}
      {page?.rejected ? <div class="session-library-alert warning" role="status"><Icon name="warning" /><span>{page.rejected} malformed or out-of-bound session record{page.rejected === 1 ? " was" : "s were"} excluded.</span></div> : null}
      <span class="session-library-visually-hidden" aria-live="polite">{announcement}</span>

      <div class="session-library-layout">
        <aside class="session-library-list-panel" aria-label="Conversations">
          <div class="session-library-list-heading">
            <span>{page?.total ?? 0} conversation{page?.total === 1 ? "" : "s"}</span>
            {/* "Metadata only" used to be a bare eyebrow; the sentence it stood
                for now travels with it instead of living in nobody's head. */}
            <small title="Metadata only; transcripts are read on selection.">{loadingList ? "Reading journal…" : "Metadata only"}</small>
          </div>
          <div class="session-library-list" role="list" aria-label="Available conversations">
            {groupedSessions.pinned.length ? <div class="session-library-group-label" role="presentation">Pinned · page memory</div> : null}
            {ordered.map((item, index) => {
              const lineage = sessionLineage(item.sourceSessionId, titleById);
              const active = item.id === activeSessionId;
              return (
                <>{index === groupedSessions.pinned.length && groupedSessions.pinned.length && groupedSessions.other.length ? <div class="session-library-group-label" role="presentation">All sessions</div> : null}
                <div class="session-library-row" role="listitem" key={item.id}>
                  <button
                    class={`session-library-card${item.id === selectedId ? " selected" : ""}`}
                    type="button"
                    aria-current={item.id === selectedId ? "true" : undefined}
                    aria-label={`${item.title}. ${relativeSessionTime(item.updatedAt)}. ${sessionEventCount(item.headSequence)}. ${item.providerId} ${item.model}${item.profileId ? `, profile ${item.profileId}` : ""}${lineage ? `, forked from ${lineage.label}` : ""}${active ? ", active session" : ""}`}
                    title={`${item.title}\n${item.providerId} · ${item.model}\nUpdated ${formatDateTime(item.updatedAt)}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span class="session-library-card-top">
                      <span class="session-library-card-mark" data-active={active ? "true" : "false"} aria-hidden="true">
                        {lineage ? <Icon name="branch" size={13} /> : <span class="session-library-card-dot" />}
                      </span>
                      <strong>{item.title}</strong>
                      <time dateTime={item.updatedAt}>{relativeSessionTime(item.updatedAt)}</time>
                    </span>
                    <span class="session-library-card-line2">
                      {/* `ACTIVE` was a 42px uppercase pill. It survives as a
                          word, not as the dot's colour: P2 forbids colour as
                          the only carrier, so the mark and the word ship
                          together. */}
                      {active ? <em class="session-library-card-active">Active</em> : null}
                      {lineage ? <em class="session-library-card-lineage">↳ from {lineage.label}</em> : null}
                      <span>{sessionEventCount(item.headSequence)}</span>
                      {item.profileId ? <span class="session-library-card-profile">{item.profileId}</span> : null}
                      <span class="session-library-card-model" title={`${item.providerId} · ${item.model}`}>{item.model}</span>
                    </span>
                  </button>
                  {lineage?.navigable ? (
                    <button
                      class="session-library-lineage-jump"
                      type="button"
                      aria-label={`Open the source conversation, ${lineage.label}`}
                      onClick={() => setSelectedId(lineage.parentId)}
                    >↳</button>
                  ) : null}
                  <button
                    class="session-library-pin"
                    type="button"
                    aria-pressed={pinned.has(item.id)}
                    aria-label={`${pinned.has(item.id) ? "Unpin" : "Pin"} ${item.title}`}
                    onClick={() => setPinned(setPageSessionPinned(item.id, !pinned.has(item.id)))}
                  >★</button>
                </div></>
              );
            })}
            {!loadingList && page?.items.length === 0 ? (
              <div class="session-library-empty">
                <Icon name="chat" size={24} />
                <strong>No matching conversations</strong>
                {sessionEmptyStateBody({ filtered: filterActive, searched: Boolean(search) }).map((line) => <p key={line}>{line}</p>)}
              </div>
            ) : null}
          </div>
        </aside>

        <main class="session-library-detail" aria-live="polite">
          {loadingDetail ? <div class="session-library-loading" role="status" aria-live="polite">Auditing history…</div> : null}
          {detailError ? <div class="session-library-alert error" role="alert"><Icon name="warning" /><span>{detailError}</span></div> : null}
          {!loadingDetail && !detail ? <div class="session-library-empty detail"><Icon name="chat" size={28} /><strong>Select a session</strong><p>Its pinned runtime, structural history status, and bounded transcript will appear here.</p></div> : null}
          {!loadingDetail && detail ? (
            <SessionDetail
              detail={detail}
              active={detail.session.id === activeSessionId}
              busy={busy}
              forkOpen={forkOpen}
              forkTitle={forkTitle}
              forkUsesActiveManifest={Boolean(forkManifest)}
              runtimeAvailable={Boolean(runtime)}
              renaming={renaming}
              renameTitle={renameTitle}
              parentTitle={detail.pins.lineage ? titleById.get(detail.pins.lineage.sourceSessionId) : undefined}
              onSelectSession={setSelectedId}
              onStartRename={() => { setRenameTitle(detail.session.title); setRenaming(true); }}
              onCancelRename={() => { setRenaming(false); setRenameTitle(""); }}
              onRenameTitle={setRenameTitle}
              onCommitRename={() => void renameSelected()}
              onForkTitle={setForkTitle}
              onPrepareFork={prepareFork}
              onCancelFork={() => setForkOpen(false)}
              onCreateFork={() => void createFork()}
              onResume={() => void resumeSelected()}
              onOpenProof={onOpenProof ? () => onOpenProof(detail.session.id) : undefined}
            />
          ) : null}
        </main>
      </div>
    </section>
  );
}

function SessionDetail({
  detail,
  active,
  busy,
  forkOpen,
  forkTitle,
  forkUsesActiveManifest,
  runtimeAvailable,
  renaming,
  renameTitle,
  parentTitle,
  onSelectSession,
  onStartRename,
  onCancelRename,
  onRenameTitle,
  onCommitRename,
  onForkTitle,
  onPrepareFork,
  onCancelFork,
  onCreateFork,
  onResume,
  onOpenProof,
}: {
  detail: SessionLibraryDetail;
  active: boolean;
  busy: boolean;
  forkOpen: boolean;
  forkTitle: string;
  forkUsesActiveManifest: boolean;
  runtimeAvailable: boolean;
  renaming: boolean;
  renameTitle: string;
  parentTitle?: string;
  onSelectSession: (id: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRenameTitle: (value: string) => void;
  onCommitRename: () => void;
  onForkTitle: (value: string) => void;
  onPrepareFork: () => void;
  onCancelFork: () => void;
  onCreateFork: () => void;
  onResume: () => void;
  onOpenProof?: () => void;
}) {
  const compatibility = detail.compatibility;
  const resumeDisabled = busy || active || !runtimeAvailable || compatibility?.action !== "resume";
  const resumeLabel = active ? "Active session" : !runtimeAvailable ? "No active runtime" : compatibility?.action === "resume" ? "Resume session" : compatibility?.label ?? "Cannot resume";
  const forkPrimary = compatibility?.action === "fork-required" || compatibility?.action === "blocked";
  const lineage = detail.pins.lineage;
  const integrity = sessionIntegrityRow({
    history: detail.history,
    receiptCount: detail.transcript.receipts.length,
    lifecycle: detail.transcript.lifecycle,
    ...(compatibility ? { compatibility } : {}),
  });
  const bodyId = useId();
  const renameInput = useRef<HTMLInputElement>(null);
  // The row opens itself whenever anything disagrees, and re-opens if the
  // selection changes to a session that disagrees — collapse may only ever hide
  // agreement, so the open state is keyed on the verdict, not on the click.
  const [expanded, setExpanded] = useState(integrity.autoExpanded);
  useEffect(() => setExpanded(integrity.autoExpanded), [detail.session.id, integrity.autoExpanded]);
  useEffect(() => { if (renaming) renameInput.current?.focus(); }, [renaming]);

  return (
    <article class="session-library-inspector">
      <header class="session-library-detail-heading">
        <div>
          <span class="session-library-eyebrow">Session {shortSessionId(detail.session.id)}</span>
          <h2>{detail.session.title}</h2>
          {/* Rename used to open a form *above* the title it renames. It is now
              the title's own adjacent verb, and its field opens beneath the
              heading, in reading order. */}
          {renaming ? (
            <form
              class="session-library-rename"
              onSubmit={(event) => { event.preventDefault(); onCommitRename(); }}
            >
              <label class="session-library-visually-hidden" for={`${bodyId}-rename`}>Conversation title</label>
              <input
                id={`${bodyId}-rename`}
                ref={renameInput}
                value={renameTitle}
                maxlength={SESSION_TITLE_MAX}
                placeholder={detail.session.title}
                onInput={(event) => onRenameTitle(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancelRename(); } }}
              />
              <button type="submit" disabled={busy || !renameTitle.trim()}>Save rename</button>
              <button type="button" onClick={onCancelRename} disabled={busy}>Cancel</button>
            </form>
          ) : null}
          {lineage ? (
            <p class="session-library-lineage-line">
              <Icon name="branch" size={14} />
              Forked from{" "}
              <button
                type="button"
                class="session-library-lineage-link"
                aria-label={`Open the source conversation, ${parentTitle ?? shortSessionId(lineage.sourceSessionId)}`}
                onClick={() => onSelectSession(lineage.sourceSessionId)}
              >{parentTitle ?? shortSessionId(lineage.sourceSessionId)}</button>
              {" "}at head {lineage.sourceHeadSequence} · source untouched
            </p>
          ) : null}
          <p>Created <time dateTime={detail.session.createdAt}>{formatDateTime(detail.session.createdAt)}</time> · updated <time dateTime={detail.session.updatedAt}>{formatDateTime(detail.session.updatedAt)}</time></p>
        </div>
        <div class="session-library-actions">
          <button type="button" onClick={onStartRename} disabled={busy || renaming} aria-expanded={renaming}>Rename</button>
          {onOpenProof ? <button type="button" onClick={onOpenProof}><Icon name="proof" size={16} />Proof</button> : null}
          <button class={forkPrimary ? "primary" : ""} type="button" onClick={onPrepareFork} disabled={busy}><Icon name="branch" size={16} />{forkPrimary ? "Fork to continue" : "Fork"}</button>
          <button class={!forkPrimary ? "primary" : ""} type="button" onClick={onResume} disabled={resumeDisabled}>{resumeLabel}</button>
        </div>
      </header>

      <section class="session-integrity" data-state={integrity.state}>
        <button
          class="session-integrity__row"
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={integrity.label}
          onClick={() => setExpanded((value) => !value)}
        >
          {integrity.pills.map((pill) => <Seal key={pill.key} state={pill.state} label={pill.label} density="chip" />)}
          <span class="session-integrity__caret" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
        </button>
        <div class="session-integrity__body" id={bodyId} hidden={!expanded}>
          <div class="session-integrity__scope">
            <strong>{detail.history.status === "consistent" ? "Journal structure passed" : detail.history.label}</strong>
            <small>{detail.history.checkedEvents} of {detail.history.totalEvents} events inspected · {detail.history.turnCount} turn{detail.history.turnCount === 1 ? "" : "s"}</small>
            <span class="session-library-proof-scope">Structural linkage only · digests not recomputed · authenticity not proven</span>
          </div>

          <section class="session-library-continuity" aria-label="Session continuity">
            <div class={`session-library-lifecycle ${detail.transcript.lifecycle.state}`}>
              <span aria-hidden="true" />
              <strong>{detail.transcript.lifecycle.label}</strong>
              <small>{detail.transcript.lifecycle.turnId ? `turn ${shortSessionId(detail.transcript.lifecycle.turnId)}` : "no turn has started"}</small>
            </div>
            <div><span>Model pin</span><strong title={`${detail.pins.providerId} · ${detail.pins.model}`}>{detail.pins.model}</strong></div>
            <div><span>Receipt chain</span><strong>{detail.transcript.receipts.length} recovered</strong></div>
            <div><span>Journal head</span><strong>{sessionEventCount(detail.session.headSequence)}</strong></div>
          </section>

          {compatibility ? (
            <section class={`session-library-compatibility ${compatibility.action}`} aria-labelledby="session-compatibility-title">
              <div><span>Runtime decision</span><strong id="session-compatibility-title">{compatibility.label}</strong></div>
              {compatibility.reasons.length ? <ul>{compatibility.reasons.map((reason) => <li class={reason.severity} key={reason.code}><span>{reason.code.replaceAll("_", " ")}</span>{reason.message}</li>)}</ul> : <p>Provider, model, posture, tool manifest, workspace, and profile digests match the active runtime.</p>}
              {/* The fork contract is stated once, where the decision is made —
                  in the fork panel. Here it only says what is required. */}
              {forkPrimary ? <p>Continuing here requires a fork.</p> : null}
            </section>
          ) : (
            <section class="session-library-compatibility unavailable"><div><span>Runtime decision</span><strong>No active runtime supplied</strong></div><p>Inspection remains available, but this component cannot authorize a resume.</p></section>
          )}
        </div>
      </section>

      {forkOpen ? (
        <section class="session-library-fork" aria-labelledby="session-fork-title">
          <div><span class="session-library-eyebrow">Explicit fork</span><h3 id="session-fork-title">Create a new session identity</h3><p>Fork = new identity · empty transcript · source untouched. The new manifest records the source head as immutable lineage.</p></div>
          <label><span>Fork title</span><input value={forkTitle} maxlength={SESSION_TITLE_MAX} onInput={(event) => onForkTitle(event.currentTarget.value)} /></label>
          <div class="session-library-fork-note"><Icon name="lock" size={16} /><span>{forkUsesActiveManifest ? "The host supplied the active runtime manifest for this fork." : "The fork keeps the source runtime pins; only its session identity and lineage change."}</span></div>
          <div class="session-library-fork-actions"><button type="button" onClick={onCancelFork} disabled={busy}>Cancel</button><button class="primary" type="button" onClick={onCreateFork} disabled={busy || !forkTitle.trim()}>{busy ? "Creating…" : "Create clean fork"}</button></div>
        </section>
      ) : null}

      <details class="session-library-technical">
        <summary><span>Runtime record</span><strong>Manifest pins and transcript</strong></summary>
        <div class="session-library-detail-grid">
        <section class="session-library-panel" aria-labelledby="session-pins-title">
          <div class="session-library-panel-heading"><span>Immutable manifest</span><strong id="session-pins-title">Runtime pins</strong></div>
          <dl class="session-library-pins">
            <div><dt>Provider</dt><dd>{detail.pins.providerId}</dd></div>
            <div><dt>Model</dt><dd>{detail.pins.model}</dd></div>
            <div><dt>Security posture</dt><dd>{postureLabel(detail.pins.posture.value)}<small>{postureBasis(detail.pins.posture.basis)}</small></dd></div>
            <div><dt>Initial page tier</dt><dd>{detail.pins.capabilityTier}</dd></div>
            <div><dt>Workspace</dt><dd title={detail.pins.workspaceId}>{detail.pins.workspaceId}</dd></div>
            <div><dt>Profile</dt><dd>{detail.pins.profile?.profileId ?? "Unbound"}{detail.pins.profile ? <small>revision {shortDigest(detail.pins.profile.profileRevision)}</small> : null}</dd></div>
          </dl>
          <div class="session-library-digests">
            <Digest label="System prompt" value={detail.pins.systemPromptDigest} />
            <Digest label="Tool manifest" value={detail.pins.toolManifestDigest} />
            {detail.pins.profile ? <>
              <Digest label="Profile resolution" value={detail.pins.profile.resolutionDigest} />
              <Digest label="Theme" value={detail.pins.profile.themeDigest} />
              <Digest label="Resolved skills" value={detail.pins.profile.skillSetDigest} />
            </> : null}
            <Digest label={`Journal head · ${detail.session.headSequence}`} value={detail.session.headDigest} />
          </div>
          {lineage ? <div class="session-library-lineage"><Icon name="branch" size={16} /><span><strong>Forked from {shortSessionId(lineage.sourceSessionId)}</strong><small>source head {lineage.sourceHeadSequence} · {shortDigest(lineage.sourceHeadDigest)}</small></span></div> : null}
        </section>

        <section class="session-library-panel transcript" aria-labelledby="session-transcript-title">
          <div class="session-library-panel-heading"><span>Bounded local materialization</span><strong id="session-transcript-title">Transcript</strong></div>
          {detail.transcript.truncated ? <p class="session-library-truncation"><Icon name="warning" size={15} />Showing a bounded tail. {detail.transcript.omittedMessages} message{detail.transcript.omittedMessages === 1 ? "" : "s"} omitted.</p> : null}
          {detail.transcript.messages.length ? (
            <ol class="session-library-transcript">
              {detail.transcript.messages.map((message) => (
                <li class={message.role} key={`${message.id}:${message.sequence}`}>
                  <div><strong>{message.role === "user" ? "You" : "Agent"}</strong><span>{message.phase === "tool-call" ? "tool phase · " : ""}event {message.sequence}</span></div>
                  <p>{message.content}</p>
                  <div class="session-library-message-disposition">
                    <span class={message.turnStatus}>{message.turnStatus} turn</span>
                    <span class={message.providerContext}>{message.providerContext === "included" ? "Provider context included" : "Excluded from provider context"}</span>
                  </div>
                  {message.receipt ? <small class="session-library-message-receipt"><Icon name="proof" size={12} />Receipt {shortSessionId(message.receipt.receiptId)}</small> : null}
                  {message.truncated ? <small>Message bounded for display</small> : null}
                </li>
              ))}
            </ol>
          ) : <div class="session-library-empty compact"><Icon name="chat" size={20} /><strong>No user or assistant messages</strong><p>Tool payloads and internal events are intentionally not rendered here.</p></div>}
        </section>
        </div>
      </details>

      {detail.history.issues.length ? (
        <details class="session-library-issues">
          <summary>{detail.history.issues.length} structural observation{detail.history.issues.length === 1 ? "" : "s"}</summary>
          <ul>{detail.history.issues.map((issue, index) => <li class={issue.severity} key={`${issue.code}:${issue.sequence ?? index}`}><strong>{issue.code.replaceAll("_", " ")}</strong><span>{issue.message}{issue.sequence ? ` Event ${issue.sequence}.` : ""}</span></li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}

function Digest({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <span>{label}</span>
      <code title={value}>{shortDigest(value)}</code>
      {/* A digest is the one value on this pane a person retypes into a proof
          comparison, and it was only ever available as a hover tooltip. */}
      <button
        class="session-library-copy"
        type="button"
        aria-label={`Copy the full ${label} digest`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
            () => setCopied(false),
          );
        }}
      >{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

function postureLabel(value: string | undefined): string {
  return value?.replaceAll("-", " ") ?? "Not recorded";
}

function postureBasis(value: "manifest" | "event-observation" | "not-recorded"): string {
  if (value === "manifest") return "manifest pin";
  if (value === "event-observation") return "observed only · not a pin";
  return "no posture claim";
}

function runtimeFingerprint(runtime: ActiveSessionRuntime | undefined): string {
  if (!runtime) return "none";
  return [
    runtime.providerId,
    runtime.model,
    runtime.posture,
    runtime.toolManifestDigest,
    runtime.workspaceId ?? "",
    runtime.profile?.profileId ?? "",
    runtime.profile?.profileRevision ?? "",
    runtime.profile?.themeDigest ?? "",
    runtime.profile?.skillSetDigest ?? "",
    runtime.profile?.resolutionDigest ?? "",
  ].join("\u0000");
}

function shortDigest(value: string): string {
  if (value === "genesis") return value;
  return value.length <= 22 ? value : `${value.slice(0, 14)}…${value.slice(-7)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "Unknown time";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The session operation could not be completed.";
}

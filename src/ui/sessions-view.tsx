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
import { useEffect, useMemo, useState } from "preact/hooks";
import "./sessions-view.css";
import { DurabilityIndicator, type DurabilityState } from "./durability-indicator";
import { groupPinnedSessions, pagePinnedSessionIds, setPageSessionPinned } from "./session-pins";

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
    setForkTitle(`${detail.session.title} · fork`.slice(0, 240));
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
    try { const renamed = await library.rename(detail.session.id, renameTitle); setRenameTitle(""); setRefresh((value) => value + 1); setAnnouncement(`Renamed session to ${renamed.title}.`); }
    catch (caught) { setDetailError(errorMessage(caught)); }
    finally { setBusy(false); }
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
  return (
    <section class="session-library-view" aria-labelledby="session-library-title">
      <header class="session-library-heading">
        <div>
          <span class="session-library-eyebrow">Conversation history</span>
          <h1 id="session-library-title">All conversations</h1>
          <p>Open a thread where you left it. Pinned runtime details remain available for audit; a fork appears only when its meaning genuinely changes.</p>
        </div>
        <div class="session-library-origin"><Icon name="workspace" size={17} /><span><strong>Current journal adapter</strong><small>{durability.state === "synced" ? "Client-encrypted cloud journal; writes commit directly from this browser." : "Page-memory journal; remote availability is not inferred."}</small></span><DurabilityIndicator state={durability.state} detail={durability.detail} /></div>
      </header>

      <div class="session-library-toolbar" role="search" aria-label="Filter sessions">
        <label class="session-library-search">
          <span class="session-library-visually-hidden">Search conversations</span>
          <Icon name="context" size={17} />
          <input
            type="search"
            value={draftSearch}
            onInput={(event) => setDraftSearch(event.currentTarget.value)}
            placeholder="Search conversations"
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
            <small>{loadingList ? "Reading journal…" : "Metadata only"}</small>
          </div>
          <div class="session-library-list" role="listbox" aria-label="Available conversations">
            {groupedSessions.pinned.length ? <div class="session-library-group-label" role="presentation">Pinned · page memory</div> : null}
            {[...groupedSessions.pinned, ...groupedSessions.other].map((item, index) => {
              const selected = item.id === selectedId;
              const active = item.id === activeSessionId;
              return (
                <>{index === groupedSessions.pinned.length && groupedSessions.pinned.length && groupedSessions.other.length ? <div class="session-library-group-label" role="presentation">All sessions</div> : null}
                <button
                  class={`session-library-card${selected ? " selected" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`${item.title}, ${item.providerId}, ${item.model}${active ? ", active session" : ""}`}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span class="session-library-card-top"><strong>{item.title}</strong>{pinned.has(item.id) ? <em>Pinned</em> : null}{active ? <em>Active</em> : null}</span>
                  <span class="session-library-card-runtime"><span>{item.providerId}</span><span>{item.model}</span></span>
                  <span class="session-library-card-meta"><time dateTime={item.updatedAt}>{formatRelativeDate(item.updatedAt)}</time><span>{item.headSequence} event{item.headSequence === 1 ? "" : "s"}</span></span>
                  {item.profileId ? <span class="session-library-card-profile"><Icon name="profiles" size={13} />{item.profileId}</span> : null}
                  <span class="session-library-pin" role="button" tabIndex={0} aria-label={`${pinned.has(item.id) ? "Unpin" : "Pin"} ${item.title}`} onClick={(event) => { event.stopPropagation(); setPinned(setPageSessionPinned(item.id, !pinned.has(item.id))); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.currentTarget.click(); }}>★</span>
                </button></>
              );
            })}
            {!loadingList && page?.items.length === 0 ? (
              <div class="session-library-empty"><Icon name="chat" size={24} /><strong>No matching conversations</strong><p>{filterActive ? "Clear or widen the current filters." : "A conversation appears here after the journal creates it."}</p></div>
            ) : null}
          </div>
        </aside>

        <main class="session-library-detail" aria-live="polite">
          {loadingDetail ? <div class="session-library-loading" role="status" aria-live="polite">Auditing history…</div> : null}
          {detailError ? <div class="session-library-alert error" role="alert"><Icon name="warning" /><span>{detailError}</span></div> : null}
          {!loadingDetail && !detail ? <div class="session-library-empty detail"><Icon name="chat" size={28} /><strong>Select a session</strong><p>Its pinned runtime, structural history status, and bounded transcript will appear here.</p></div> : null}
          {!loadingDetail && detail ? (
            <><details class="session-library-rename-disclosure"><summary>Rename conversation</summary><form class="session-library-rename" onSubmit={(event) => { event.preventDefault(); void renameSelected(); }}><label>Title<input value={renameTitle} maxlength={240} placeholder={detail.session.title} onInput={(event) => setRenameTitle(event.currentTarget.value)} /></label><button type="submit" disabled={busy || !renameTitle.trim()}>Save rename</button></form></details>
            <SessionDetail
              detail={detail}
              active={detail.session.id === activeSessionId}
              busy={busy}
              forkOpen={forkOpen}
              forkTitle={forkTitle}
              forkUsesActiveManifest={Boolean(forkManifest)}
              runtimeAvailable={Boolean(runtime)}
              onForkTitle={setForkTitle}
              onPrepareFork={prepareFork}
              onCancelFork={() => setForkOpen(false)}
              onCreateFork={() => void createFork()}
              onResume={() => void resumeSelected()}
              onOpenProof={onOpenProof ? () => onOpenProof(detail.session.id) : undefined}
            /></>
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
  return (
    <article class="session-library-inspector">
      <header class="session-library-detail-heading">
        <div>
          <span class="session-library-eyebrow">Session {shortId(detail.session.id)}</span>
          <h2>{detail.session.title}</h2>
          <p>Created <time dateTime={detail.session.createdAt}>{formatDateTime(detail.session.createdAt)}</time> · updated <time dateTime={detail.session.updatedAt}>{formatDateTime(detail.session.updatedAt)}</time></p>
        </div>
        <div class="session-library-actions">
          {onOpenProof ? <button type="button" onClick={onOpenProof}><Icon name="proof" size={16} />Proof</button> : null}
          <button class={forkPrimary ? "primary" : ""} type="button" onClick={onPrepareFork} disabled={busy}><Icon name="branch" size={16} />{forkPrimary ? "Fork to continue" : "Fork"}</button>
          <button class={!forkPrimary ? "primary" : ""} type="button" onClick={onResume} disabled={resumeDisabled}>{resumeLabel}</button>
        </div>
      </header>

      <div class={`session-library-health ${detail.history.status}`}>
        <span class="session-library-health-mark"><Icon name={detail.history.status === "consistent" ? "check" : "warning"} size={18} /></span>
        <div><strong>{detail.history.status === "consistent" ? "Journal structure passed" : detail.history.label}</strong><small>{detail.history.checkedEvents} of {detail.history.totalEvents} events inspected · {detail.history.turnCount} turn{detail.history.turnCount === 1 ? "" : "s"}</small></div>
        <span class="session-library-proof-scope">Structural linkage only · digests not recomputed · authenticity not proven</span>
      </div>

      <section class="session-library-continuity" aria-label="Session continuity">
        <div class={`session-library-lifecycle ${detail.transcript.lifecycle.state}`}>
          <span aria-hidden="true" />
          <strong>{detail.transcript.lifecycle.label}</strong>
          <small>{detail.transcript.lifecycle.turnId ? `turn ${shortId(detail.transcript.lifecycle.turnId)}` : "no turn has started"}</small>
        </div>
        <div><span>Model pin</span><strong>{detail.pins.model}</strong></div>
        <div><span>Receipt chain</span><strong>{detail.transcript.receipts.length} recovered</strong></div>
        <div><span>Journal head</span><strong>{detail.session.headSequence} events</strong></div>
      </section>

      {compatibility ? (
        <section class={`session-library-compatibility ${compatibility.action}`} aria-labelledby="session-compatibility-title">
          <div><span>Runtime decision</span><strong id="session-compatibility-title">{compatibility.label}</strong></div>
          {compatibility.reasons.length ? <ul>{compatibility.reasons.map((reason) => <li class={reason.severity} key={reason.code}><span>{reason.code.replaceAll("_", " ")}</span>{reason.message}</li>)}</ul> : <p>Provider, model, posture, tool manifest, workspace, and profile digests match the active runtime.</p>}
          {forkPrimary ? <p><strong>Fork = new identity · empty transcript · source untouched.</strong> Continuing here creates a clean session and retains this record unchanged.</p> : null}
        </section>
      ) : (
        <section class="session-library-compatibility unavailable"><div><span>Runtime decision</span><strong>No active runtime supplied</strong></div><p>Inspection remains available, but this component cannot authorize a resume.</p></section>
      )}

      {forkOpen ? (
        <section class="session-library-fork" aria-labelledby="session-fork-title">
          <div><span class="session-library-eyebrow">Explicit fork</span><h3 id="session-fork-title">Create a new session identity</h3><p>Fork = new identity · empty transcript · source untouched. The new manifest records the source head as immutable lineage.</p></div>
          <label><span>Fork title</span><input value={forkTitle} maxlength={240} onInput={(event) => onForkTitle(event.currentTarget.value)} /></label>
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
          {detail.pins.lineage ? <div class="session-library-lineage"><Icon name="branch" size={16} /><span><strong>Forked from {shortId(detail.pins.lineage.sourceSessionId)}</strong><small>source head {detail.pins.lineage.sourceHeadSequence} · {shortDigest(detail.pins.lineage.sourceHeadDigest)}</small></span></div> : null}
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
                  {message.receipt ? <small class="session-library-message-receipt"><Icon name="proof" size={12} />Receipt {shortId(message.receipt.receiptId)}</small> : null}
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
  return <div><span>{label}</span><code title={value}>{shortDigest(value)}</code></div>;
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

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
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

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The session operation could not be completed.";
}

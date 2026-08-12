import type { SessionManifest } from "../core/contracts";
import type { SessionRecord } from "../core/journal";
import {
  type ActiveSessionRuntime,
  type SessionListItem,
  type SessionListPage,
  type SessionListSort,
} from "../sessions/domain";
import {
  SessionLibrary,
  type SessionForkResult,
  type SessionLibraryDetail,
} from "../sessions/library";
import { forkLibraryAnnouncement } from "./chat/fork-notice";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import "./sessions-view.css";
import { DurabilityIndicator, durabilityLabel, durabilitySeal, type DurabilityState } from "./durability-indicator";
import { ConfirmDialog } from "./confirm-dialog";
import { Popover } from "./popover";
import { RouteHeader } from "./route-header";
import { Seal } from "./seal";
import { favoriteDirectionalMove, favoriteDropMove, groupPinnedSessions } from "./session-pins";
import {
  SESSION_OUT_OF_RESULTS_CAPTION,
  SESSION_OUT_OF_RESULTS_NOTICE,
  SESSION_SEARCH_PLACEHOLDER,
  SESSION_TITLE_MAX,
  forkRequirement,
  forkTitleFor,
  relativeSessionTime,
  sessionEmptyState,
  sessionEventCount,
  sessionIntegrityRow,
  sessionLineage,
  sessionReconnectPlan,
  shortSessionId,
  titleMatchSegments,
  type SessionReconnectPlan,
} from "./sessions-presentation";

export type SessionsViewProps = Readonly<{
  library: SessionLibrary;
  runtime?: ActiveSessionRuntime;
  activeSessionId?: string;
  /** The active profile is the ordinary conversation-library boundary. */
  scopeProfileId: string;
  scopeProfileName: string;
  /** Optional host-created manifest used when a fork should move to the active runtime. */
  forkManifest?: SessionManifest;
  revision?: number;
  onResume: (detail: SessionLibraryDetail) => void | Promise<void>;
  onForked?: (result: SessionForkResult, source: SessionLibraryDetail) => void | Promise<void>;
  /**
   * A durable rename landed in the journal.
   *
   * The list refreshes itself from its own counter, but the host owns the only
   * copies the Chat header and the rail recents read. Without this the title a
   * reader just committed stays stale everywhere outside this route until some
   * unrelated turn happens to bump the host's revision.
   */
  onRenamed?: (record: SessionRecord) => void;
  /**
   * Lets the shell retire the deleted row from its profile-local rail and
   * palette immediately. The conversation journal owns the deletion; the
   * shell owns the other live projections.
   */
  onDeleted?: (sessionId: string, removeEvidence: boolean) => void | Promise<void>;
  onOpenProof?: (sessionId: string) => void;
  durability?: Readonly<{ state: DurabilityState; detail: string }>;
  /**
   * The conversation whose transcript the active runtime could not replay.
   *
   * Set by vault adoption when it quarantines one session instead of stranding
   * the whole vault. It is plumbed here in the same change rather than as a
   * follow-up, because a list that goes on showing "Structure passed / Ready to
   * resume" for a conversation the runtime just refused to open is asserting an
   * intactness it did not establish.
   */
  quarantine?: Readonly<{ sessionId: string; title: string; reason: string; historyVerified: boolean }>;
  /**
   * A conversation the shell wants inspected on arrival.
   *
   * The quarantine card on the chat surface names a conversation and offers to
   * open its record; without this the route landed on whatever was active and
   * left the reader to find the row the sentence they just read was about.
   */
  focusSessionId?: string;
  /**
   * Clears a one-shot focus request after the requested conversation is
   * selected, so returning to the library later does not jump back to an old
   * rail selection.
   */
  onFocusSessionConsumed?: () => void;
}>;

/** The journal-adapter sentence, chosen by the adapter that is live. */
function journalAdapterSentence(state: DurabilityState): string {
  if (state === "synced") return "Client-encrypted cloud journal; writes commit directly from this browser.";
  // Adopted but unreachable is still the encrypted cloud adapter. Calling it a
  // page-memory journal would understate what this session writes and where, in
  // the one state where a reader most needs to know which store holds it.
  if (state === "sync-paused") return "Client-encrypted cloud journal; this browser cannot reach it right now, so commits are not landing.";
  return "Page-memory journal; remote availability is not inferred.";
}

/** Stable identity, so a conversation with no branches re-renders unchanged. */
const EMPTY_BRANCHES: readonly SessionListItem[] = Object.freeze([]);

/**
 * How many conversations one read of the journal returns.
 *
 * Not a preference — a ceiling. `querySessionRecords` clamps the request with
 * `positiveInteger(query.limit, 100, 200)`, so 200 is the most a single read
 * can ever answer with, and asking for more silently gets 200 back.
 */
export const SESSION_LIBRARY_PAGE_SIZE = 200;

export type SessionListBound = Readonly<{
  /** True when the journal holds conversations this list has not read. */
  bounded: boolean;
  /** The sentence that names both numbers, so neither can be inferred wrong. */
  sentence: string;
  /** How many rows the next read would add, at most. */
  next: number;
}>;

/**
 * What the list is allowed to say about its own bound.
 *
 * The measured defect: the heading printed `page.total` — "312 conversations" —
 * above a list hard-capped at one 200-row read, with no pagination, no
 * load-more and no sentence anywhere saying 112 rows were unreachable. Every
 * fork, edit and retry mints a peer row, so 200 arrives in ordinary use. The
 * two numbers are stated together or the bound is not stated at all.
 */
export function sessionListBound(
  shown: number,
  total: number,
  pageSize: number = SESSION_LIBRARY_PAGE_SIZE,
): SessionListBound {
  const remaining = Math.max(0, total - shown);
  return Object.freeze({
    bounded: remaining > 0,
    sentence: `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} conversation${total === 1 ? "" : "s"}`,
    next: Math.min(pageSize, remaining),
  });
}

export function SessionsView({
  library,
  runtime,
  activeSessionId,
  scopeProfileId,
  scopeProfileName,
  forkManifest,
  revision = 0,
  onResume,
  onForked,
  onRenamed,
  onDeleted,
  onOpenProof,
  durability = { state: "ephemeral", detail: "This journal exists only in page memory. Nothing is synced." },
  quarantine,
  focusSessionId,
  onFocusSessionConsumed,
}: SessionsViewProps) {
  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [sort, setSort] = useState<SessionListSort>("updated-desc");
  const [page, setPage] = useState<SessionListPage>();
  const [selectedId, setSelectedId] = useState(focusSessionId ?? activeSessionId);
  const [detail, setDetail] = useState<SessionLibraryDetail>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  /** The conversation whose open editors (rename, fork) belong to the person. */
  const openEditorsFor = useRef<string>();
  const [forkOpen, setForkOpen] = useState(false);
  /*
   * The fork's own refusal, kept out of the pane-wide alert.
   *
   * Measured: pressing "Create fork" on a blocked conversation left the count
   * at 3, the URL at #sessions and the panel open, and put "The observed source
   * head did not pass the local journal audit (LOCAL_COMMAND_INCOMPLETE)." into
   * the alert at the top of a scrolled pane — rendered at y=-117 with
   * `document.body.scrollHeight === 900` in a 900px viewport, i.e. above the
   * visible area with no scroll that could reach it. The person saw a button
   * that did nothing. A refusal belongs at the control that was pressed.
   */
  const [forkError, setForkError] = useState<string>();
  const [forkTitle, setForkTitle] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeEvidence, setRemoveEvidence] = useState(false);
  const [favoriteState, setFavoriteState] = useState<Readonly<{
    profileId: string;
    favorites: readonly Readonly<{ sessionId: string; pinnedAt: string; membershipEventId: string }>[];
  }>>(() => Object.freeze({ profileId: "", favorites: Object.freeze([]) }));
  const [favoriteBusy, setFavoriteBusy] = useState<string>();
  const [draggingFavoriteId, setDraggingFavoriteId] = useState<string>();
  /*
   * How many conversations the last *unfiltered* read found.
   *
   * The filtered page only knows its own total, so a zero result cannot say
   * how much was searched without a number from somewhere. This is that
   * number, and the empty state labels it as what it is — a figure from the
   * last unfiltered read — rather than asserting a live count it never saw.
   */
  const [loadedTotal, setLoadedTotal] = useState<number>();
  /*
   * How many 200-row reads the reader has asked this list to hold.
   *
   * Kept as a request rather than as an appended array so a refresh — starring
   * a conversation bumps `refresh`, and so does every rename and fork — re-reads
   * the same depth instead of silently dropping the reader back to row 200.
   *
   * Tagged with the query it was made against, and read back through that tag,
   * so a narrower filter falls to one page *during* the render that changed it.
   * Resetting it in an effect instead would fire the journal read twice on
   * every filter change: once at the stale depth, then again at 1.
   */
  const [depth, setDepth] = useState<Readonly<{ key: string; pages: number }>>(() => Object.freeze({ key: "", pages: 1 }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const toolbarId = useId();

  /** The identity of the list being asked for; changing it is a different list. */
  const queryKey = [scopeProfileId, search, providerId, model, sort].join("\u0000");
  const requestedPages = depth.key === queryKey ? depth.pages : 1;

  const runtimeKey = useMemo(() => runtimeFingerprint(runtime), [runtime]);
  // Never render an async result under a different profile prop. The old
  // projection can exist for one render while the new journal read starts;
  // its profile tag makes that frame an empty favorite group, not a leak.
  const favorites = favoriteState.profileId === scopeProfileId ? favoriteState.favorites : [];
  const favoriteOrder = favorites.map((favorite) => favorite.sessionId);
  const pinned = useMemo(() => new Set(favoriteOrder), [favoriteOrder.join("\0")]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draftSearch), 140);
    return () => clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingList(true);
    setError(undefined);
    const query = {
      search,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      profileId: scopeProfileId,
      sort,
    };
    /*
     * Depth is reachable only by offset, so this is a loop and not a bigger
     * `limit`: the journal query clamps every read at
     * `SESSION_LIBRARY_PAGE_SIZE`, so asking for 400 returns 200 and says
     * nothing about it. The pages are concatenated into one projection, and
     * `limit` is set to what this projection actually spans so the page object
     * cannot describe a window it no longer holds.
     */
    void (async (): Promise<SessionListPage> => {
      const first = await library.list({ ...query, offset: 0, limit: SESSION_LIBRARY_PAGE_SIZE }, controller.signal);
      const items: SessionListItem[] = [...first.items];
      for (let read = 1; read < requestedPages && items.length < first.total; read += 1) {
        const next = await library.list({ ...query, offset: items.length, limit: SESSION_LIBRARY_PAGE_SIZE }, controller.signal);
        if (next.items.length === 0) break;
        items.push(...next.items);
      }
      return Object.freeze({
        ...first,
        items: Object.freeze(items),
        offset: 0,
        limit: SESSION_LIBRARY_PAGE_SIZE * requestedPages,
      });
    })().then(
      (next) => {
        setPage(next);
        if (!search && !providerId && !model) setLoadedTotal(next.total);
        setSelectedId((current) => current && next.items.some((item) => item.id === current)
          ? current
          : activeSessionId && next.items.some((item) => item.id === activeSessionId)
            ? activeSessionId
            : next.items[0]?.id);
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoadingList(false);
    });
    return () => controller.abort();
  }, [activeSessionId, library, model, providerId, refresh, requestedPages, revision, scopeProfileId, search, sort]);

  useEffect(() => {
    const controller = new AbortController();
    void library.favorites(scopeProfileId, controller.signal).then(
      (next) => setFavoriteState(Object.freeze({ profileId: scopeProfileId, favorites: next })),
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      },
    );
    return () => controller.abort();
  }, [library, refresh, revision, scopeProfileId]);

  // A later request is a later intent: arriving here twice for two different
  // conversations must land on the second one, not on the first still selected.
  useEffect(() => {
    if (!focusSessionId) return;
    setSelectedId(focusSessionId);
    onFocusSessionConsumed?.();
  }, [focusSessionId, onFocusSessionConsumed]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    const controller = new AbortController();
    setLoadingDetail(true);
    setDetailError(undefined);
    /*
     * Only a change of conversation closes what is open on it.
     *
     * This effect re-runs on `refresh` and on the host's `revision` too, and it
     * used to close the rename field and the fork panel every time — so any
     * unrelated background write, a turn completing or a vault appending, threw
     * away a title someone was in the middle of typing. It is also why the
     * rename spec was flaky: the Save button was detached from the DOM
     * mid-click, "element is not stable ... element was detached", on roughly
     * two runs in five. A person gets the same event as a click that does
     * nothing.
     *
     * The re-fetch below still runs on every trigger, because the record really
     * may have changed. It is only the person's own open editors that now
     * survive it.
     */
    if (openEditorsFor.current !== selectedId) {
      openEditorsFor.current = selectedId;
      setForkOpen(false);
      setRenaming(false);
    }
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

  /*
   * The row is an opener, not only a selector.
   *
   * Measured: single click, double click and Enter on a conversation row all
   * left `location.hash` at "#sessions" — the only opener was "Resume
   * conversation" in the detail pane, which on a 390×844 phone rendered at
   * y=791, under the bottom tab bar. A person came here to get back into a
   * conversation and the list would not let them.
   *
   * Selection is preserved as the audit gesture; this is the resume verb, one
   * press from every row. A refusal selects the row instead of failing
   * silently, so the pane that explains why is what appears.
   */
  async function openSession(sessionId: string) {
    if (busy || sessionId === activeSessionId) { setSelectedId(sessionId); return; }
    setBusy(true);
    setDetailError(undefined);
    try {
      const fresh = await library.inspect(sessionId, runtime);
      if (fresh.compatibility?.action !== "resume") {
        setSelectedId(sessionId);
        setDetailError(fresh.compatibility?.label ?? "This conversation cannot be resumed in the current runtime.");
        return;
      }
      await onResume(fresh);
    } catch (caught) {
      setSelectedId(sessionId);
      setDetailError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function resumeSelected() {
    if (!detail || detail.compatibility?.action !== "resume" || detail.session.id === activeSessionId) return;
    setBusy(true);
    setDetailError(undefined);
    try {
      await onResume(detail);
      setAnnouncement(`${detail.session.title} is now the active conversation.`);
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
    setForkError(undefined);
  }

  async function createFork() {
    if (!detail || !forkTitle.trim()) return;
    setBusy(true);
    setDetailError(undefined);
    setForkError(undefined);
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
      // The counts `fork()` returns, in the announcement that is the only
      // thing a screen-reader user hears about this branch. Without them the
      // sentence claims a new session and says nothing about how much of the
      // source actually came with it.
      setAnnouncement(forkLibraryAnnouncement(result.session.title, result));
    } catch (caught) {
      setForkError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Delete the selected conversation, fenced to the head the pane is showing.
   *
   * `expectedSourceHead` is the same fence `fork` uses, for a sharper reason:
   * if a turn landed while the confirmation was open, the person is about to
   * discard a reply they have never seen. The journal refuses, and the pane
   * says so rather than destroying it quietly.
   */
  async function deleteSelected() {
    if (!detail) return;
    setBusy(true);
    setDetailError(undefined);
    /*
     * Started before the delete so the write after it is synchronous.
     *
     * The continuity record has to be retired in the same breath as the
     * deletion, and a dynamic import in that breath is a window a closing tab
     * can fit through. Loading the module first turns the post-delete step into
     * a `localStorage.setItem`, which is synchronous and cannot be half-done.
     * Loaded, not used, until the journal has actually accepted the delete —
     * a failed deletion must discard neither the conversation nor its record.
     */
    const ledgerModule = import("./chat/return-ledger").catch(() => undefined);
    try {
      await library.delete(detail.session.id, {
        expectedHead: { sequence: detail.session.headSequence, digest: detail.session.headDigest },
      });
      const removed = detail.session.title;
      /*
       * Deliberate removal is not lost work, and the ledger has to be told.
       *
       * The return ledger records every conversation this browser has seen so a
       * later visit can report what did not come back. It learns that a
       * conversation is gone by finding its entry absent from the journal — and
       * a conversation the person deleted on purpose is absent in exactly the
       * same way. Delete a thread, close the browser, come back, and Airship
       * mourned it: "1 conversation · N messages · last active …", offering to
       * set up a Vault to protect work that was thrown away on purpose. A
       * product that cannot tell a decision from an accident is not telling the
       * truth about either.
       *
       * Forgotten here rather than in reconciliation because this is the only
       * place that knows the difference, and awaited before the success
       * announcement rather than fired and forgotten: review pointed out that
       * "deleted" spoken ahead of the record leaves a close/reload race in
       * which the row is gone and the tombstone is not. Nothing claims the
       * deletion is complete until the intent is durably recorded. A module
       * that could not load leaves the record in place, which errs toward
       * reporting a deletion as loss rather than losing work silently.
       */
      const deletedId = detail.session.id;
      const ledger = await ledgerModule;
      const storage = ledger?.browserReturnLedgerStorage();
      if (ledger && storage) ledger.forgetReturnLedgerEntries(storage, [deletedId]);
      let cleanupFailure: unknown;
      try {
        await onDeleted?.(deletedId, removeEvidence);
      } catch (error) {
        // The journal deletion already committed. Keep the row retired and
        // report a truthful partial result if optional endpoint-evidence
        // cleanup could not complete; never make a deleted conversation look
        // present again because a secondary cache refused a write.
        cleanupFailure = error;
      }
      setDeleting(false);
      setSelectedId(undefined);
      setDetail(undefined);
      setRefresh((value) => value + 1);
      setRemoveEvidence(false);
      setAnnouncement(cleanupFailure
        ? `Deleted ${removed}. Its transcript and events were removed; endpoint evidence was kept because cleanup failed.`
        : `Deleted ${removed}. Its transcript and events were removed from this journal.`);
    } catch (caught) {
      setDeleting(false);
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
      onRenamed?.(renamed);
      setAnnouncement(`Renamed conversation to ${renamed.title}.`);
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
    // Sort is one of the things the reader chose, so `Clear` has to be able to
    // undo it. It was previously modelled as layout state, which left a
    // non-default order stuck with no control that returns it.
    setSort("updated-desc");
  }

  async function setSessionFavorite(sessionId: string, title: string, next: boolean) {
    setFavoriteBusy(sessionId);
    setError(undefined);
    try {
      await library.setFavorite(sessionId, scopeProfileId, next);
      const resolved = await library.favorites(scopeProfileId);
      setFavoriteState(Object.freeze({ profileId: scopeProfileId, favorites: resolved }));
      setAnnouncement(`${title} ${next ? "added to" : "removed from"} favorites.`);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setFavoriteBusy((current) => current === sessionId ? undefined : current);
    }
  }

  async function moveSessionFavorite(sessionId: string, title: string, beforeSessionId?: string) {
    setFavoriteBusy(sessionId);
    setError(undefined);
    try {
      const resolved = await library.moveFavoriteBefore(sessionId, scopeProfileId, beforeSessionId);
      setFavoriteState(Object.freeze({ profileId: scopeProfileId, favorites: resolved }));
      setAnnouncement(`${title} moved in favorites.`);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setFavoriteBusy((current) => current === sessionId ? undefined : current);
    }
  }

  function moveSessionFavoriteDirection(sessionId: string, title: string, direction: -1 | 1) {
    const move = favoriteDirectionalMove(favoriteOrder, sessionId, direction);
    if (move.changed) void moveSessionFavorite(sessionId, title, move.beforeSessionId);
  }

  const filterActive = Boolean(search || providerId || model);
  // `Clear` reverts every choice the reader made about this list, and sort is
  // one of them. It stays out of `filterActive` because that flag means "rows
  // were withheld" — it words the empty state and decides whether a selected
  // conversation is out of scope, and re-ordering a list withholds nothing.
  const clearable = filterActive || sort !== "updated-desc";
  // Only the collapsible menus are counted; the search term is on the row that
  // stays visible, so counting it would name a filter the reader can already see.
  const activeFilterCount = [providerId, model].filter(Boolean).length + (sort === "updated-desc" ? 0 : 1);
  const groupedSessions = groupPinnedSessions(page?.items ?? [], favoriteOrder);
  // Lineage is only navigable to a conversation the current filter actually
  // loaded, so the parent lookup is built from what is on screen rather than
  // from a promise that a second read would succeed.
  const titleById = useMemo(
    () => new Map((page?.items ?? []).map((item) => [item.id, item.title] as const)),
    [page?.items],
  );
  /*
   * The reverse of the lineage link, which was the only direction that existed.
   *
   * `sourceSessionId` has always been walked upward — a branch could name the
   * conversation it came from, but a conversation could not name its branches.
   * So the one place a reader goes to compare "what if I had asked it
   * differently" showed nothing at the fork point, and every alternative was
   * only reachable by recognising its title in a flat, recency-ordered list.
   * Built from the same page already in hand, for the same reason `titleById`
   * is: a branch this filter did not load is not one this panel can navigate
   * to, and claiming otherwise would be a link that goes nowhere.
   */
  const branchesBySourceId = useMemo(() => {
    const index = new Map<string, SessionListItem[]>();
    for (const item of page?.items ?? []) {
      if (!item.sourceSessionId) continue;
      const branches = index.get(item.sourceSessionId);
      if (branches) branches.push(item);
      else index.set(item.sourceSessionId, [item]);
    }
    return index;
  }, [page?.items]);
  const ordered = [...groupedSessions.pinned, ...groupedSessions.other];
  const emptyState = sessionEmptyState({ filtered: filterActive, query: search, ...(loadedTotal === undefined ? {} : { loadedTotal }) });
  /*
   * The pane and the list must agree about what is in scope.
   *
   * A selection survives a filter change, so the detail pane went on offering
   * `Fork to continue` — which writes a new session manifest — beside a list
   * that had just declared the target out of scope. The pane keeps every fact
   * it was rendering; the mismatch is stated, and the verbs are withdrawn
   * until the filter that hid the conversation is cleared.
   */
  const outOfResults = Boolean(page && selectedId && filterActive && !page.items.some((item) => item.id === selectedId));
  const bound = sessionListBound(page?.items.length ?? 0, page?.total ?? 0);

  return (
    <section class="session-library-view" aria-labelledby="session-library-title">
      <RouteHeader
        routeId="sessions"
        density="tool"
        title="All conversations"
        headingId="session-library-title"
        eyebrow="Conversation history"
        description={`Open a ${scopeProfileName} thread where you left it. Search, recents, and continuation stay inside the active profile; pinned runtime details remain available for audit.`}
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

      {/* Every accessible name on this route says "conversation", because the
          route is called "All conversations" and its heading counts
          conversations. A VoiceOver user used to hear a "Conversations"
          landmark containing a "Filter sessions" search and a "Refresh session
          library" button, and had to decide whether those were two things. */}
      <div class="session-library-toolbar" role="search" aria-label="Filter conversations" data-filters-open={filtersOpen ? "true" : "false"}>
        <span class="session-library-profile-scope" title={`Profile id ${scopeProfileId}`}>Profile · {scopeProfileName}</span>
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
        {/*
          * Below 640px the four filters are a counted disclosure rather than a
          * row that scrolls: as `overflow-x: auto` three of them sat off the
          * right edge of a 430px phone with no scrollbar, no fade and nothing
          * saying they existed, and wrapping them into the resting layout cost
          * 160px of a 740px viewport. The control states how many are set, so
          * a collapsed filter can never be a silent one. Hidden at every width
          * where all four already fit, which includes the 768px and 820px the
          * menu-anchoring spec drives.
          */}
        <button
          class="session-library-filter-toggle"
          type="button"
          aria-expanded={filtersOpen}
          aria-controls={`${toolbarId}-filters`}
          onClick={() => setFiltersOpen((value) => !value)}
        >Filters{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
        <div class="session-library-filters" id={`${toolbarId}-filters`}>
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
        {/*
          * `session-library-sort-menu` carries no styling on purpose.
          *
          * It is the name the regression guard uses: a responsive rule that
          * hid this control once shipped, and the only way a test can say
          * "never hide the ordering control" is if the control has a selector
          * to name. Keep the hook; do not give it a rule.
          */}
        <MenuSelect
          className="session-filter-menu session-library-sort-menu"
          placement="down"
          ariaLabel="Sort conversations"
          value={sort}
          options={[
            { value: "updated-desc", label: "Recently active" },
            { value: "created-desc", label: "Recently created" },
            { value: "title-asc", label: "Title A–Z" },
          ]}
          onChange={(next) => setSort(next as SessionListSort)}
        />
        </div>
        {clearable ? <button type="button" onClick={clearFilters}>Clear</button> : null}
        <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loadingList} aria-label="Refresh conversations">
          {loadingList ? "Reading…" : "Refresh"}
        </button>
      </div>

      {error ? <div class="session-library-alert error" role="alert"><Icon name="warning" /><span>{error}</span></div> : null}
      {page?.rejected ? <div class="session-library-alert warning" role="status"><Icon name="warning" /><span>{page.rejected} malformed or out-of-bound conversation record{page.rejected === 1 ? " was" : "s were"} excluded.</span></div> : null}
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
            {groupedSessions.pinned.length ? <div class="session-library-group-label" role="presentation">Favorites · {durability.state === "ephemeral" ? "page memory" : "encrypted journal"}</div> : null}
            {ordered.map((item, index) => {
              const lineage = sessionLineage(item.sourceSessionId, titleById);
              const active = item.id === activeSessionId;
              const favorite = pinned.has(item.id);
              const favoriteIndex = favoriteOrder.indexOf(item.id);
              return (
                <>{index === groupedSessions.pinned.length && groupedSessions.pinned.length && groupedSessions.other.length ? <div class="session-library-group-label" role="presentation">All conversations</div> : null}
                <div
                  class="session-library-row"
                  role="listitem"
                  key={item.id}
                  data-session-id={item.id}
                  data-favorite={favorite ? "true" : "false"}
                  data-dragging={draggingFavoriteId === item.id ? "true" : undefined}
                  draggable={favorite}
                  onDragStart={(event) => {
                    if (!favorite || !event.dataTransfer) { event.preventDefault(); return; }
                    setDraggingFavoriteId(item.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.id);
                  }}
                  onDragEnd={() => setDraggingFavoriteId(undefined)}
                  onDragOver={(event) => {
                    if (!favorite || !draggingFavoriteId || draggingFavoriteId === item.id || !event.dataTransfer) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = draggingFavoriteId || event.dataTransfer?.getData("text/plain");
                    setDraggingFavoriteId(undefined);
                    const source = ordered.find((candidate) => candidate.id === sourceId);
                    if (!source) return;
                    const move = favoriteDropMove(favoriteOrder, source.id, item.id);
                    if (move.changed) void moveSessionFavorite(source.id, source.title, move.beforeSessionId);
                  }}
                >
                  <button
                    class={`session-library-card${item.id === selectedId ? " selected" : ""}`}
                    type="button"
                    aria-current={item.id === selectedId ? "true" : undefined}
                    aria-label={`${item.title}. ${relativeSessionTime(item.updatedAt)}. ${sessionEventCount(item.headSequence)}. ${item.providerId} ${item.model}${item.profileId ? `, profile ${item.profileId}` : ""}${lineage ? `, forked from ${lineage.label}` : ""}${active ? ", active conversation" : ""}`}
                    /*
                     * The gesture line names the affordance that exists on
                     * every input device, and names double-click second.
                     *
                     * It used to say only "Double-click to open" — on a phone,
                     * a row documenting a gesture the reader does not have,
                     * beside an `Open` button it never mentioned. Pressing the
                     * row selects; that is the audit gesture the detail pane,
                     * the fork and the rename all depend on, so it is stated
                     * too rather than left to be discovered by pressing.
                     */
                    title={`${item.title}\n${item.providerId} · ${item.model}\nUpdated ${formatDateTime(item.updatedAt)}\n${active ? "Active conversation · press to inspect it" : "Press to select · Open on this row, or double-click, to open it"}`}
                    onClick={() => setSelectedId(item.id)}
                    // The mouse gesture every list of documents already binds,
                    // and the keyboard one: Enter on a row already selected
                    // opens it rather than re-selecting what is selected.
                    onDblClick={() => void openSession(item.id)}
                    aria-keyshortcuts={favorite ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && item.id === selectedId && item.id !== activeSessionId) {
                        event.preventDefault();
                        void openSession(item.id);
                        return;
                      }
                      if (!favorite || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                      event.preventDefault();
                      moveSessionFavoriteDirection(item.id, item.title, event.key === "ArrowUp" ? -1 : 1);
                    }}
                  >
                    <span class="session-library-card-top">
                      <span class="session-library-card-mark" data-active={active ? "true" : "false"} aria-hidden="true">
                        {lineage ? <Icon name="branch" size={13} /> : <span class="session-library-card-dot" />}
                      </span>
                      {/* The matched run is marked, not re-worded: the title is
                          reassembled character for character, so a filtered
                          list says where it matched instead of making the
                          reader re-run the search by eye. */}
                      <strong>{titleMatchSegments(item.title, search).map((segment, part) => (
                        segment.matched
                          ? <mark key={`${part}:${segment.text}`}>{segment.text}</mark>
                          : <>{segment.text}</>
                      ))}</strong>
                      <time dateTime={item.updatedAt}>{relativeSessionTime(item.updatedAt)}</time>
                    </span>
                    <span class="session-library-card-line2">
                      {/* `ACTIVE` was a 42px uppercase pill, then an 11px word
                          on this line. It is now the accessible half of a pair:
                          the visible carrier for the green mark is the row's
                          own opener, which is disabled and reads `Active` under
                          exactly this condition, so P2 is satisfied without the
                          row printing one word twice — see the rule beside
                          `.session-library-visually-hidden`, which is what
                          hides this copy and why. */}
                      {active ? <em class="session-library-card-active">Active</em> : null}
                      {lineage ? <em class="session-library-card-lineage">↳ from {lineage.label}</em> : null}
                      {/* Classed so the stylesheet can name it in the line's
                          shrink order: it is the fact that yields first, and an
                          unclassed span could only have been reached by a
                          positional selector that renaming anything would
                          silently repoint. */}
                      <span class="session-library-card-events">{sessionEventCount(item.headSequence)}</span>
                      {item.profileId ? <span class="session-library-card-profile">{item.profileId}</span> : null}
                      <span class="session-library-card-model" title={`${item.providerId} · ${item.model}`}>{item.model}</span>
                    </span>
                  </button>
                  {/* The one-press opener, on the row rather than 791px down
                      the page. It is the row's own verb, so it carries the
                      row's name; the active conversation's row says so
                      instead of offering to reopen what is open. */}
                  <button
                    class="session-library-open"
                    type="button"
                    disabled={busy || active}
                    aria-label={active ? `${item.title} is the active conversation` : `Open ${item.title}`}
                    title={active ? "Active conversation" : `Open ${item.title}`}
                    onClick={() => void openSession(item.id)}
                  >{active ? "Active" : "Open"}</button>
                  {lineage?.navigable ? (
                    <button
                      class="session-library-lineage-jump"
                      type="button"
                      aria-label={`Open the source conversation, ${lineage.label}`}
                      onClick={() => setSelectedId(lineage.parentId)}
                    >↳</button>
                  ) : null}
                  {favorite ? (
                    <span class="session-library-favorite-order" role="group" aria-label={`Reorder favorite ${item.title}`}>
                      <span class="session-library-favorite-drag" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
                      <button
                        type="button"
                        aria-label={`Move favorite ${item.title} up`}
                        disabled={favoriteBusy === item.id || favoriteIndex <= 0}
                        onClick={() => moveSessionFavoriteDirection(item.id, item.title, -1)}
                      >↑</button>
                      <button
                        type="button"
                        aria-label={`Move favorite ${item.title} down`}
                        disabled={favoriteBusy === item.id || favoriteIndex < 0 || favoriteIndex >= favoriteOrder.length - 1}
                        onClick={() => moveSessionFavoriteDirection(item.id, item.title, 1)}
                      >↓</button>
                    </span>
                  ) : null}
                  <button
                    class="session-library-pin"
                    type="button"
                    aria-pressed={favorite}
                    aria-label={`${favorite ? "Remove from favorites" : "Add to favorites"} ${item.title}`}
                    disabled={favoriteBusy === item.id}
                    onClick={() => void setSessionFavorite(item.id, item.title, !favorite)}
                  >★</button>
                </div></>
              );
            })}
            {/*
              * The bound, stated where the list ends.
              *
              * The heading has always printed `page.total`; the list has always
              * held at most one 200-row read. At 312 conversations that is 112
              * threads a reader could see counted and could not reach by any
              * gesture on this route. The sentence names both numbers and the
              * control beside it reads the next page, so the count and the rows
              * agree or the disagreement is spelled out.
              */}
            {bound.bounded ? (
              <div class="session-library-bound" role="status">
                <p>{bound.sentence}</p>
                <button
                  class="session-library-empty-action"
                  type="button"
                  disabled={loadingList}
                  onClick={() => setDepth(Object.freeze({ key: queryKey, pages: requestedPages + 1 }))}
                >{loadingList ? "Reading…" : `Load ${bound.next.toLocaleString()} more`}</button>
              </div>
            ) : null}
            {!loadingList && page?.items.length === 0 ? (
              <div class="session-library-empty">
                <Icon name="chat" size={24} />
                {/* Names the term, the scope and the size of what was read, and
                    ends in the control that undoes it. The old body described
                    the reader's own action back at them and stopped there. */}
                <strong>{emptyState.heading}</strong>
                {emptyState.lines.map((line) => <p key={line}>{line}</p>)}
                {emptyState.offersClear ? (
                  <button class="session-library-empty-action" type="button" onClick={clearFilters}>Clear filters</button>
                ) : null}
              </div>
            ) : null}
          </div>
        </aside>

        <main class="session-library-detail" aria-live="polite">
          {loadingDetail ? <div class="session-library-loading" role="status" aria-live="polite">Auditing history…</div> : null}
          {detailError ? <div class="session-library-alert error" role="alert"><Icon name="warning" /><span>{detailError}</span></div> : null}
          {!loadingDetail && !detail ? (
            <div class="session-library-empty detail">
              <Icon name="chat" size={28} />
              <strong>No conversation open</strong>
              <p>Its pinned runtime, structural history status, and bounded transcript will appear here.</p>
              {/* An empty pane beside a populated list is a state with an
                  obvious next move; it used to only describe itself. */}
              {ordered[0] ? (
                <button class="session-library-empty-action" type="button" onClick={() => setSelectedId(ordered[0]!.id)}>Open the first conversation</button>
              ) : null}
            </div>
          ) : null}
          {!loadingDetail && detail && outOfResults ? (
            <div class="session-library-out-of-results" role="status">
              <Icon name="warning" size={16} />
              <span>{SESSION_OUT_OF_RESULTS_NOTICE}</span>
              <button type="button" onClick={clearFilters}>Clear filters and show it</button>
            </div>
          ) : null}
          {!loadingDetail && detail ? (
            <SessionDetail
              detail={detail}
              active={detail.session.id === activeSessionId}
              outOfResults={outOfResults}
              busy={busy}
              forkOpen={forkOpen}
              forkTitle={forkTitle}
              {...(forkError ? { forkError } : {})}
              forkUsesActiveManifest={Boolean(forkManifest)}
              runtimeAvailable={Boolean(runtime)}
              {...(runtime ? { runtime } : {})}
              renaming={renaming}
              renameTitle={renameTitle}
              parentTitle={detail.pins.lineage ? titleById.get(detail.pins.lineage.sourceSessionId) : undefined}
              alternates={branchesBySourceId.get(detail.session.id) ?? EMPTY_BRANCHES}
              onSelectSession={setSelectedId}
              onStartRename={() => { setRenameTitle(detail.session.title); setRenaming(true); }}
              onCancelRename={() => { setRenaming(false); setRenameTitle(""); }}
              onRenameTitle={setRenameTitle}
              onCommitRename={() => void renameSelected()}
              onForkTitle={setForkTitle}
              onPrepareFork={prepareFork}
              onRequestDelete={() => { setRemoveEvidence(false); setDeleting(true); }}
              onCancelFork={() => setForkOpen(false)}
              onCreateFork={() => void createFork()}
              onResume={() => void resumeSelected()}
              onOpenProof={onOpenProof ? () => onOpenProof(detail.session.id) : undefined}
              quarantine={quarantine?.sessionId === detail.session.id ? quarantine : undefined}
            />
          ) : null}
        </main>
      </div>
      {/*
        * The same destructive grammar as every other irreversible action in the
        * product, via the shared dialog rather than a fourth confirmation
        * dialect. It names the conversation, states plainly what leaves with it
        * and where from, and does not promise anything about copies a person
        * exported earlier — which is the only claim about deletion this build
        * can actually keep.
        */}
      {deleting && detail ? (
        <ConfirmDialog
          title="Delete this conversation?"
          titleDetail={detail.session.title}
          confirmLabel={busy ? "Deleting…" : "Delete conversation"}
          confirmDisabled={busy}
          destructive
          onCancel={() => setDeleting(false)}
          onConfirm={() => void deleteSelected()}
        >
          <p>
            Its transcript, every recorded step and its journal entries are removed
            from {durability.state === "ephemeral" ? "this page's memory" : "this journal"}.
            Forks already made from it keep their own copies.
          </p>
          <label class="session-delete-evidence-option">
            <input
              type="checkbox"
              checked={removeEvidence}
              onChange={(event) => setRemoveEvidence(event.currentTarget.checked)}
            />
            <span>Also remove this conversation’s endpoint evidence and pending evidence checks.</span>
          </label>
          <p class="session-delete-evidence-note">
            Leave this unchecked to keep its separately stored Proof evidence history.
          </p>
          <p>This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function SessionDetail({
  detail,
  active,
  outOfResults,
  busy,
  forkOpen,
  forkError,
  forkTitle,
  forkUsesActiveManifest,
  runtimeAvailable,
  runtime,
  renaming,
  renameTitle,
  parentTitle,
  alternates,
  onSelectSession,
  onStartRename,
  onCancelRename,
  onRenameTitle,
  onCommitRename,
  onForkTitle,
  onPrepareFork,
  onRequestDelete,
  onCancelFork,
  onCreateFork,
  onResume,
  onOpenProof,
  quarantine,
}: {
  detail: SessionLibraryDetail;
  active: boolean;
  /** True while the current filter excludes this conversation from the list. */
  outOfResults: boolean;
  busy: boolean;
  forkOpen: boolean;
  /** The fork's own refusal, rendered inside the panel that raised it. */
  forkError?: string;
  forkTitle: string;
  forkUsesActiveManifest: boolean;
  runtimeAvailable: boolean;
  /** The live runtime, so the pane can name what this tab is actually on. */
  runtime?: ActiveSessionRuntime;
  renaming: boolean;
  renameTitle: string;
  parentTitle?: string;
  /** Conversations branched from this one, as far as the loaded page shows. */
  alternates: readonly SessionListItem[];
  onSelectSession: (id: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRenameTitle: (value: string) => void;
  onCommitRename: () => void;
  onForkTitle: (value: string) => void;
  onPrepareFork: () => void;
  onRequestDelete: () => void;
  onCancelFork: () => void;
  onCreateFork: () => void;
  onResume: () => void;
  onOpenProof?: () => void;
  quarantine?: Readonly<{ sessionId: string; title: string; reason: string; historyVerified: boolean }>;
}) {
  const compatibility = detail.compatibility;
  // Every state-mutating verb is withdrawn while the pane is out of scope.
  // Read-only controls — Proof, the disclosures, the transcript — stay live,
  // because the facts on this pane are real and the reader may still want them.
  const mutationBlocked = busy || outOfResults;
  const resumeDisabled = mutationBlocked || active || !runtimeAvailable || Boolean(quarantine) || compatibility?.action !== "resume";
  const requirement = forkRequirement(compatibility, detail.history);
  const resumeLabel = active
    ? "Active conversation"
    : !runtimeAvailable
      ? "No active runtime"
      // Not "Cannot resume", and emphatically not "Session damaged": the audit
      // verified this chain. Only the replay failed, and only the replay is
      // named here.
      : quarantine
        ? "Transcript cannot be replayed"
        : compatibility?.action === "resume" ? "Resume conversation" : compatibility?.label ?? "Cannot resume";
  /*
   * The refusal that has a remedy other than forking.
   *
   * `undefined` for every refusal that reconnecting would not cure — a moved
   * approval policy, a suspect history — so this card is never the answer to a
   * question it cannot answer. When it *is* present it owns the primary
   * emphasis, and the fork in the action row steps down to an ordinary button:
   * offering two gold buttons for one decision is how "Fork to continue" came
   * to read as the only way forward in the first place.
   */
  const reconnect = sessionReconnectPlan({
    pins: detail.pins,
    ...(runtime ? { runtime } : {}),
    ...(compatibility ? { compatibility } : {}),
    sessionId: detail.session.id,
  });
  // The label still states the requirement; only the gold moves.
  const forkRequired = requirement.required;
  const forkPrimary = forkRequired && !reconnect;
  const lineage = detail.pins.lineage;
  const integrity = sessionIntegrityRow({
    history: detail.history,
    receiptCount: detail.transcript.receipts.length,
    lifecycle: detail.transcript.lifecycle,
    messageCount: detail.transcript.messages.length,
    ...(compatibility ? { compatibility } : {}),
    ...(quarantine ? { transcriptReplayFailed: true } : {}),
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
      {/*
        * Above the title, not below the action row.
        *
        * Measured on a 390x664 phone: the five-button action row wraps to three
        * lines, so anything after the heading starts 346px below the
        * conversation's own name — the same shape as the defect this work
        * exists to end, where the only opener rendered at y=791 under the
        * bottom tab bar. The card's own sentence names the pinned route and the
        * active one, so it locates itself without borrowing the heading.
        */}
      {reconnect ? (
        <SessionReconnectCard
          plan={reconnect}
          reasons={requirement.reasons}
          disabled={mutationBlocked}
          onFork={onPrepareFork}
        />
      ) : null}
      <header class="session-library-detail-heading">
        <div>
          <span class="session-library-eyebrow">Conversation {shortSessionId(detail.session.id)}</span>
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
          {/* The other direction of the same fact. Without it, a conversation
              retried three times looked identical to one never branched, and
              the three alternatives were peers in a flat list with nothing
              saying they answered the same question.

              Each entry states its fork point, because the branch time alone
              does not answer the only question this list exists to answer:
              three branches cut from event 12 are alternative answers to one
              turn, while branches at 4, 12 and 30 are three different
              questions that happen to share an ancestor. The sequence is the
              branch's own `lineage.sourceHeadSequence` — the same commitment
              the upward "Forked from … at head N" line reads — so the two
              directions cannot disagree. */}
          {alternates.length ? (
            <div class="session-library-alternates">
              <p class="session-library-alternates__heading">
                <Icon name="branch" size={14} />
                Alternates ({alternates.length})
              </p>
              <ul>
                {alternates.map((branch) => (
                  <li key={branch.id}>
                    <button
                      type="button"
                      class="session-library-lineage-link"
                      aria-label={`Open the branch ${branch.title}${branch.sourceHeadSequence === undefined ? "" : `, branched at head ${branch.sourceHeadSequence}`}`}
                      onClick={() => onSelectSession(branch.id)}
                    >{branch.title}</button>
                    {" "}<small>
                      {/* Absent only for a summary whose manifest carried no
                          lineage — which cannot reach this list, since the
                          index is keyed on it — so the fallback states the
                          gap rather than printing a sequence of its own. */}
                      {branch.sourceHeadSequence === undefined ? "fork point unrecorded" : `branched at head ${branch.sourceHeadSequence}`}
                      {" · "}<time dateTime={branch.createdAt}>{formatDateTime(branch.createdAt)}</time>
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>Created <time dateTime={detail.session.createdAt}>{formatDateTime(detail.session.createdAt)}</time> · updated <time dateTime={detail.session.updatedAt}>{formatDateTime(detail.session.updatedAt)}</time></p>
        </div>
        <div class="session-library-actions">
          <button type="button" onClick={onStartRename} disabled={mutationBlocked || renaming} aria-expanded={renaming}>Rename</button>
          {onOpenProof ? <button type="button" onClick={onOpenProof}><Icon name="proof" size={16} />Proof</button> : null}
          <button class={forkPrimary ? "primary" : ""} type="button" onClick={onPrepareFork} disabled={mutationBlocked}><Icon name="branch" size={16} />{forkPrimary ? "Fork to continue" : "Fork"}</button>
          {/* Emphasis follows what can actually be pressed. Keyed on the
              requirement rather than on which control is gold, so demoting the
              fork for the reconnect card does not promote a disabled Resume. */}
          <button class={!forkRequired ? "primary" : ""} type="button" onClick={onResume} disabled={resumeDisabled}>{resumeLabel}</button>
          {/* Last in the row and styled as the danger it is. The product's spec
              has always promised "Export, migrate, delete", and this is the
              first build in which the verb exists — before it, a conversation
              holding a pasted credential could only be removed by destroying
              the whole Vault. */}
          <button class="small-button danger" type="button" onClick={onRequestDelete} disabled={mutationBlocked}>
            {/* `warning` rather than a bin: the icon set has no bin, and the
                label already says Delete. A glyph that means "this is the
                dangerous one" beside the word is honest; inventing a
                near-miss glyph in a set another author is editing is not. */}
            <Icon name="warning" size={16} />Delete
          </button>
          {outOfResults ? <p class="session-library-actions-caption">{SESSION_OUT_OF_RESULTS_CAPTION}</p> : null}
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
            {/* "Unfinished" beside "8 of 8 events inspected" reads as a
                contradiction until the verdict names what produced it. The
                observations themselves stay in their own list below. */}
            <small>{detail.history.checkedEvents} of {detail.history.totalEvents} events inspected · {detail.history.turnCount} turn{detail.history.turnCount === 1 ? "" : "s"}{detail.history.issues.length ? ` · ${detail.history.issues.length} structural observation${detail.history.issues.length === 1 ? "" : "s"} below` : ""}</small>
            <span class="session-library-proof-scope">Structural linkage only · digests not recomputed · authenticity not proven</span>
          </div>

          <section class="session-library-continuity" aria-label="Conversation continuity">
            <div class={`session-library-lifecycle ${detail.transcript.lifecycle.state}`}>
              <span aria-hidden="true" />
              <strong>{detail.transcript.lifecycle.label}</strong>
              <small>{detail.transcript.lifecycle.turnId ? `turn ${shortSessionId(detail.transcript.lifecycle.turnId)}` : "no turn has started"}</small>
            </div>
            <div><span>Model pin</span><strong title={`${detail.pins.providerId} · ${detail.pins.model}`}>{detail.pins.model}</strong></div>
            <div><span>Receipt chain</span><strong>{detail.transcript.receipts.length} recovered</strong></div>
            <div><span>Journal head</span><strong>{sessionEventCount(detail.session.headSequence)}</strong></div>
          </section>

          {quarantine ? (
            /*
             * Both halves of the truth, in one place, in this order.
             *
             * "History verified" is not a courtesy: `auditSessionHistory` rated
             * this chain `verified`, and a user who is told only that a session
             * "failed" will reasonably conclude their work is gone and wipe the
             * store to start over — destroying data the product could have
             * handed back. What actually failed is named immediately after it,
             * verbatim, and the read-only routes that still work are named too.
             *
             * It is only a courtesy the product has earned when the audit
             * actually ran and passed. The adoption path once wrapped the
             * audit and the presentation in one `try`, so a chain rated
             * `invalid` reached this panel and read "every event is intact"
             * directly above the product's own "History suspect". The claim is
             * gated on `historyVerified` now; when the audit did not establish
             * it, this says what is actually known instead.
             */
            <section class="session-library-compatibility unavailable" aria-labelledby="session-quarantine-title">
              <div><span id="session-quarantine-title">{quarantine.historyVerified
                ? "History verified · transcript cannot be replayed"
                : "Transcript cannot be replayed"}</span></div>
              <p>{quarantine.reason}</p>
              <p>{quarantine.historyVerified
                ? "The digest chain passed its audit and every event is intact. This runtime could not rebuild the transcript from them, so this conversation was not resumed and the rest of the vault was adopted without it. Proof stays available here."
                : "This runtime could not rebuild the transcript, and the digest audit did not complete, so nothing here establishes whether the stored events are intact. The conversation was not resumed and the rest of the vault was adopted without it. Proof stays available here."}</p>
            </section>
          ) : null}

          {compatibility ? (
            // The verdict word is the resting `resume` pill on the row this
            // panel expands from, so it is not printed a second time 60px
            // below itself; what this panel owns is the reasons behind it.
            <section class={`session-library-compatibility ${compatibility.action}`} aria-labelledby="session-compatibility-title">
              <div><span id="session-compatibility-title">Why the runtime decided that</span></div>
              {compatibility.reasons.length ? <ReasonList reasons={requirement.reasons} /> : <p>Provider, model, posture, tool manifest, workspace, and profile digests match the active runtime.</p>}
              {/* The fork contract is stated once, where the decision is made —
                  in the fork panel. Here it only says what is required. */}
              {forkPrimary ? <p>Continuing here requires a fork.</p> : null}
            </section>
          ) : (
            <section class="session-library-compatibility unavailable"><div><span>Why the runtime decided that</span></div><p>Inspection remains available, but this component cannot authorize a resume.</p></section>
          )}
        </div>
      </section>

      {forkOpen ? (
        <section class="session-library-fork" aria-labelledby="session-fork-title">
          <div>
            <span class="session-library-eyebrow">Explicit fork</span>
            <h3 id="session-fork-title">Create a new conversation identity</h3>
            {/* This promised a blank slate, from before the seed shipped. The
                journal is not copied — that is what `historyCopied: false`
                means — but the branch does start with a bounded, digest-sealed
                copy of the ancestor context, which is the opposite of what the
                reader was being told. */}
            <p>Fork = new identity · source untouched. The branch inherits a bounded, digest-sealed copy of the ancestor context and records the source head as immutable lineage.</p>
            {/*
              * The route claims a fork appears only when the meaning genuinely
              * changes, and then offered `Fork to continue` with nothing on
              * screen saying what changed. These are the runtime's own reasons,
              * verbatim, re-presented at the moment of the decision; they still
              * render in the integrity row's expansion, which is where the
              * verdict lives.
              */}
            {requirement.required && requirement.reasons.length ? (
              <div class="session-library-fork-why">
                <span class="session-library-eyebrow">Why this needs a fork · {requirement.label}</span>
                <ReasonList reasons={requirement.reasons} />
              </div>
            ) : null}
          </div>
          <label><span>Fork title</span><input value={forkTitle} maxlength={SESSION_TITLE_MAX} onInput={(event) => onForkTitle(event.currentTarget.value)} /></label>
          <div class="session-library-fork-note"><Icon name="lock" size={16} /><span>{forkUsesActiveManifest ? "The host supplied the active runtime manifest for this fork." : "The fork keeps the source runtime pins; only its conversation identity and lineage change."}</span></div>
          {/* At the control that was pressed, and scrolled to — the pane-wide
              alert this used to use rendered above the visible area with no
              page scroll that could reach it, so the button read as inert. */}
          {forkError ? (
            <div
              class="session-library-alert error session-library-fork-error"
              role="alert"
              ref={(element: HTMLDivElement | null) => element?.scrollIntoView({ block: "nearest" })}
            >
              <Icon name="warning" />
              <span>
                <strong>The fork was refused.</strong> {forkError}{" "}
                This conversation stays readable below, and Rename, Proof and Delete still work on it.
              </span>
            </div>
          ) : null}
          <div class="session-library-fork-actions"><button type="button" onClick={onCancelFork} disabled={busy}>Cancel</button><button class="primary" type="button" onClick={onCreateFork} disabled={busy || !forkTitle.trim()}>{busy ? "Creating…" : "Create fork"}</button></div>
        </section>
      ) : null}

      {/* The transcript is inside this disclosure and nowhere else, so the
          summary states its size: "Manifest pins and transcript" alone gave a
          returning reader no reason to believe their messages were in there. */}
      <details class="session-library-technical">
        <summary><span>Runtime record</span><strong>Manifest pins and transcript · {detail.transcript.messages.length} message{detail.transcript.messages.length === 1 ? "" : "s"}{detail.transcript.truncated ? ` of ${detail.transcript.messages.length + detail.transcript.omittedMessages}` : ""}</strong></summary>
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

/**
 * The two safe ways forward when in-place replay is unavailable.
 *
 * Measured on this build: a 110-event conversation pinned to a cloud provider,
 * opened in a tab that had lost its connection on reload, rendered five stacked
 * amber mismatch rows — provider, model, inference connection, posture, profile
 * digest — all with one cause and one remedy, and offered exactly one enabled
 * action: `Fork to continue` — which the same panel defines as a new identity
 * carrying none of this transcript. The product had already computed the pinned
 * provider id, the pinned model id and the delta, and then made the reader
 * carry all three by hand to `#access`, re-run key discovery, find the model
 * again and navigate back.
 *
 * Nothing is removed here. Every mismatch string still renders verbatim, inside
 * the disclosure; the ones carrying concrete identifiers are additionally
 * promoted into a pinned/active table, because comparing two ids in prose is
 * the part a person cannot do at a glance. The disclosure is closed at rest:
 * the reader who just read the header already knows what it says.
 */
function SessionReconnectCard({ plan, reasons, disabled, onFork }: {
  plan: SessionReconnectPlan;
  /** The runtime's own reasons, worst first, unchanged. */
  reasons: readonly Readonly<{ code: string; severity: string; message: string }>[];
  disabled: boolean;
  onFork: () => void;
}) {
  return (
    <section class="session-library-reconnect" aria-labelledby="session-reconnect-title">
      <p id="session-reconnect-title">{plan.header}</p>
      {/*
        * An anchor, not a button calling `location.hash`: this is a navigation
        * to an address the card can name, so it is one the reader can middle-
        * click, copy, or read in the status bar before committing to it. The
        * lane, auth method, model and the conversation to come back to ride in
        * the query so Connection can preselect them; `navigationViewFromHash`
        * splits on `?`, so the route resolves whether or not it reads them.
        */}
      <a class="session-library-reconnect__primary" href={plan.href}>{plan.primaryLabel}</a>
      <button class="session-library-reconnect__fork" type="button" onClick={onFork} disabled={disabled}>{plan.secondaryLabel}</button>
      {/* The fork's own contract, said beside the fork rather than discovered
          after pressing it. Deliberately not the design note's blanker phrase
          for a fork: `forkSession` seals and commits a bounded
          ancestor-context seed, and `sessions-view.test.ts` holds the line
          against reintroducing that older, blanker claim. What a person asking
          "will forking bring my conversation" needs to know is the middle
          clause. */}
      <small>Continue creates a new conversation on the active model. It carries a bounded, digest-sealed copy of the context — not this transcript — and leaves this one untouched.</small>
      <details class="session-library-reconnect__delta">
        <summary>{plan.disclosureLabel}</summary>
        {plan.deltas.length ? (
          <table>
            <thead><tr><th scope="col">Pin</th><th scope="col">Pinned</th><th scope="col">Active</th></tr></thead>
            <tbody>
              {plan.deltas.map((delta) => (
                <tr key={delta.label}>
                  <th scope="row">{delta.label}</th>
                  <td>{delta.pinned}</td>
                  <td>{delta.active}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <ReasonList reasons={reasons} />
      </details>
    </section>
  );
}

/**
 * One rendering of the runtime's reasons, used by both places that need them.
 *
 * The integrity row states the verdict; the fork panel states why the verdict
 * forces a fork. Same rows, same severity classes, same words — a second
 * markup for the same list is how two renderings of one fact drift apart.
 */
function ReasonList({ reasons }: { reasons: readonly Readonly<{ code: string; severity: string; message: string }>[] }) {
  return (
    <ul class="session-library-reason-list">
      {reasons.map((reason) => (
        <li class={reason.severity} key={reason.code}><span>{reason.code.replaceAll("_", " ")}</span>{reason.message}</li>
      ))}
    </ul>
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

/*
 * Deliberately no `SessionMessagePresentationError` branch here.
 *
 * A transcript fault reaches this route only through `onResume`, and the host
 * describes it there — `resumeLibrarySession` rethrows it already carrying its
 * session, sequence and event type, instead of the bare event UUID this route
 * used to print. Importing the presentation module to re-describe it would pull
 * `session-message-presentation` into the sessions-route chunk, which is a
 * release-gate classification change for a string this route is already given.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The conversation operation could not be completed.";
}

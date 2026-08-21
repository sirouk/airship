import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  approvalOutcomeReason,
  type ApprovalBroker,
  type ApprovalBrokerSnapshot,
  type ApprovalSettlement,
  type PendingApproval,
} from "../approvals/broker";
import { approvalDerivationInput } from "../approvals/consequence";
import { Icon } from "./icons";
import { remainingApprovalTime, writeApprovalFacts, type WriteApprovalFacts } from "./approval-presentation";
import { trapFocus } from "./focus-trap";
// The deferred bar is the one part of this surface routes.css does not own.
// Kept beside the component that renders it rather than appended to a 110 KB
// sheet another pass held open.
import "./approval-dock.css";
import { useBottomFloor } from "./bottom-floor";

/**
 * How close to the deadline the assertive warning fires.
 *
 * The countdown was `role="timer"`, whose implicit `aria-live` is `off`: the
 * text churned once a second and no screen reader ever spoke it, so the five
 * minute deadline was invisible to assistive technology and the request was
 * silently withdrawn when it elapsed. A deadline is announced twice — once in
 * the dialog's description on open, once assertively here — and never as
 * per-second text churn.
 */
const DEADLINE_WARNING_MS = 30_000;

/**
 * How long a one-shot announcement stays in the permanently mounted region.
 *
 * Longer than the transcript's arrival announcement (8s, `chat/streaming-slot`)
 * because this sentence carries a path and a byte count and queues behind that
 * one: the turn settles and the outcome lands in the same second.
 */
const ANNOUNCEMENT_MS = 10_000;

/** One frame's blank, so the same sentence spoken twice is still a text mutation. */
const ANNOUNCEMENT_GAP_MS = 60;

/**
 * What the deferred bar must float clear of.
 *
 * Measured, never assumed: pinned at the corner the way `.pwa-update` is, the
 * bar covered the composer's send button at 1440×900 and almost the whole
 * composer at 390×844 — it would have hidden the control a person reaches for
 * the moment they put a decision down. The composer also grows as it is typed
 * into and does not exist on Workspace, so a constant offset is wrong at some
 * size or some route by construction. These are read, not written: they belong
 * to `chat.css` and `platform-shell.css`.
 */

/**
 * What the request actually does, as one sentence.
 *
 * The dialog's `aria-describedby` resolved to the tool's generic capability
 * line — "Create or replace one UTF-8 file in the private virtual workspace." —
 * while the facts that decide the answer (which file, how big) sat in a
 * separate section the description never reached. A person who cannot see the
 * screen was being asked to consent to a write without being told what it
 * writes. Composed from the same derived facts the visible grid renders, so the
 * spoken description and the printed one cannot disagree.
 */
export function approvalConsequenceSummary(facts: WriteApprovalFacts): string {
  if (!facts.derived) {
    return "This tool declares no derivable consequence. Its raw arguments are listed in this dialog.";
  }
  return [
    facts.targets.length ? `Target ${facts.targets.join(", ")}.` : "",
    `Change: ${facts.disposition}.`,
    facts.byteLength === undefined ? "" : `New size ${facts.byteLength} bytes.`,
    facts.byteDelta === undefined ? "" : `Size delta ${facts.byteDelta >= 0 ? "+" : ""}${facts.byteDelta} bytes.`,
  ].filter(Boolean).join(" ");
}

/**
 * What a settled security decision is entitled to say out loud.
 *
 * Denial and allow both resolved into utterances that named neither — "Airship's
 * turn ended." for a refusal, "Local command complete; no model request made"
 * for an approval, a claim about the model containing neither the path nor the
 * byte count. The outcome half reuses `approvalOutcomeReason`, the same sentence
 * the journal keeps, so audible feedback and the durable record stay aligned.
 *
 * An allow says the effect *may run*, never that it did: this surface decides
 * permission and does not observe execution, and a completion claim it cannot
 * check is the failure mode it exists to fix.
 */
export function approvalSettlementAnnouncement(settlement: ApprovalSettlement, facts: WriteApprovalFacts): string {
  const reason = approvalOutcomeReason(settlement.outcome);
  const tool = settlement.request.toolName;
  if (settlement.outcome !== "allow") return `${reason} ${tool} was not executed and nothing changed.`;
  const summary = facts.derived ? ` ${approvalConsequenceSummary(facts)}` : "";
  return `${reason} ${tool} may now run.${summary}`;
}

/**
 * The deadline, spoken once on open, in the words the expiry outcome uses.
 *
 * Measured from the deadline rather than from the budget. Defer-and-resume is
 * this component's own designed flow — Escape files no decision and leaves the
 * request on its original clock — so a sentence computed as
 * `expiresAt - requestedAt` announced the full five minutes to a listener
 * re-entering the dialog with sixty seconds left, while the countdown beside it
 * read 01:00. The clamp keeps an already-elapsed request from reading as a
 * window that is still open.
 */
export function approvalDeadlineSentence(request: PendingApproval, now = Date.now()): string {
  const left = spokenDuration(Math.max(0, Date.parse(request.expiresAt) - now));
  return `You have ${left} left to decide. If the clock runs out, nothing runs and no decision is recorded.`;
}

export function approvalDeadlineWarning(request: PendingApproval): string {
  return `Less than ${spokenDuration(DEADLINE_WARNING_MS)} left to decide on ${request.toolName}. If it expires, nothing runs.`;
}

/** What Escape now means: put the request down, do not answer it. */
export function approvalDeferralNotice(request: PendingApproval, now: number, conversation?: string): string {
  return `Not decided. The request to allow ${request.toolName} is still waiting and expires in ${remainingApprovalTime(request.expiresAt, now)}. Use the “${reviewLabel(request, conversation)}” button at the bottom of the screen to answer it.`;
}

/**
 * What the waiting bar says for itself, once, when a request lands in it that
 * nobody put there.
 *
 * The bar was a `role="group"` with no live region, so the only request ever
 * announced was one the person had just deferred with Escape — and that is the
 * one case they already know about. A request filed because it came from a
 * conversation they are not reading (see `focusSession`) appeared silently at
 * the bottom edge of a screen they were not looking at.
 *
 * It is the bar's own channel, not the transcript's: the turn narrator is
 * saying what the conversation on screen is doing, and a decision waiting in a
 * different one may not overwrite that. It states that nothing was interrupted,
 * because nothing was, and it names the button by the label that button
 * actually carries.
 */
export function deferredArrivalNotice(
  requests: readonly PendingApproval[],
  conversation: (sessionId: string) => string,
): string {
  const first = requests[0];
  if (!first) return "";
  const named = conversation(first.sessionId);
  const more = requests.length > 1 ? `, and ${requests.length - 1} more with it` : "";
  return `${first.toolName} is waiting for a decision in ${named}${more}. Nothing was interrupted; nothing runs`
    + ` until you answer it. Use “${reviewLabel(first, named)}” below.`;
}

/** The one spelling of the way back, shared by the bar and the sentence about it. */
export function reviewLabel(request: PendingApproval, conversation?: string): string {
  return conversation ? `Review ${request.toolName} in ${conversation}` : `Review ${request.toolName}`;
}

export type ApprovalDockProps = Readonly<{
  broker: ApprovalBroker;
  /**
   * What to call a conversation in front of a person.
   *
   * Turns run per conversation and one broker serves all of them, so an
   * effect, an operation and a turn no longer identify a request: the first
   * thing a person needs is which thread is asking.
   */
  conversationName(sessionId: string): string;
}>;

export function ApprovalDock({ broker, conversationName }: ApprovalDockProps) {
  const [snapshot, setSnapshot] = useState<ApprovalBrokerSnapshot>(() => broker.snapshot());
  const panel = useRef<HTMLDivElement>(null);
  /** The control this request interrupted, tagged with the request it belongs to. */
  const restore = useRef<{ id: string; element: HTMLElement }>();
  const current = snapshot.pending[0];
  const waiting = snapshot.deferred[0];
  // The request the clock is running on. A deferred request is still on the
  // same five-minute timer, and its deadline matters more, not less, once the
  // modal is no longer in front of the person.
  const live = current ?? waiting;
  // Shared with the runtime-update banner; see `bottom-floor.ts`.
  const floor = useBottomFloor(Boolean(waiting));
  const [clock, setClock] = useState(() => Date.now());
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  /** The waiting bar's own one-shot sentence; see `deferredArrivalNotice`. */
  const [arrival, setArrival] = useState("");
  /** Every request this bar has already spoken for, pruned as they settle. */
  const spokenFor = useRef(new Set<string>());
  const warnedFor = useRef<string>();
  const timers = useRef<number[]>([]);
  const arrivalTimers = useRef<number[]>([]);

  const announce = useRef<(text: string) => void>(() => {});
  announce.current = (text: string) => {
    for (const timer of timers.current) window.clearTimeout(timer);
    setNotice("");
    timers.current = [
      window.setTimeout(() => setNotice(text), ANNOUNCEMENT_GAP_MS),
      window.setTimeout(() => setNotice(""), ANNOUNCEMENT_GAP_MS + ANNOUNCEMENT_MS),
    ];
  };

  useEffect(() => broker.subscribe(setSnapshot), [broker]);

  useEffect(() => () => {
    for (const timer of [...timers.current, ...arrivalTimers.current]) window.clearTimeout(timer);
  }, []);

  /*
   * One announcement per request that arrives already waiting.
   *
   * Escape marks its own request spoken-for before it defers, so the sentence
   * that path already speaks is never doubled here; what is left is exactly the
   * request nobody was shown. The set is pruned against the live snapshot, so
   * it cannot outgrow the queue and a resumed-then-deferred request is spoken
   * for again by whichever path put it back.
   */
  useEffect(() => {
    const fresh = snapshot.deferred.filter((request) => !spokenFor.current.has(request.id));
    // Rebuilt rather than added to, so a settled request cannot leave an entry
    // behind and the set can never outgrow the queue.
    spokenFor.current = new Set(snapshot.deferred.map((request) => request.id));
    if (fresh.length === 0) return;
    const sentence = deferredArrivalNotice(fresh, conversationName);
    for (const timer of arrivalTimers.current) window.clearTimeout(timer);
    setArrival("");
    arrivalTimers.current = [
      window.setTimeout(() => setArrival(sentence), ANNOUNCEMENT_GAP_MS),
      window.setTimeout(() => setArrival(""), ANNOUNCEMENT_GAP_MS + ANNOUNCEMENT_MS),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.deferred]);

  useEffect(() => broker.subscribeSettled((settlement) => {
    announce.current(approvalSettlementAnnouncement(settlement, factsFor(settlement.request)));
  }), [broker]);

  useEffect(() => {
    if (!current) return;
    // The request arrives unprompted mid-turn, so the control the user was on
    // has to be given back when the decision resolves; without this the shell
    // inerting the background would strand focus on <body>. Never overwritten
    // by our own deferred bar, so a defer-and-resume round trip still returns
    // the keyboard to the composer the request interrupted.
    const active = document.activeElement;
    // `<body>` is not a control to hand the keyboard back to — restoring to it
    // silently succeeds and looks, to every check downstream, exactly like a
    // successful restore. Measured on a phone, where sending from the composer
    // left focus on the body and Escape then stranded it there. Neither is our
    // own deferred bar: a defer-and-resume round trip must still return the
    // keyboard to the composer the request interrupted, not to the bar the
    // person came back through — so the caller is kept, tagged with the request
    // it belongs to, and a *different* request never inherits it.
    const caller = active instanceof HTMLElement && active !== document.body && !active.closest(".approval-deferred")
      ? active
      : undefined;
    if (caller) restore.current = { id: current.id, element: caller };
    else if (restore.current?.id !== current.id) restore.current = undefined;
    // The dialog itself, never a decision button. Focus used to land on "Deny",
    // so Enter — the reflex of every person in a chat surface — threw away a
    // typed command and its arguments. Focusing the panel also means entering
    // the dialog reads its name and full description before any choice is
    // offered, which is the order consent has to happen in.
    panel.current?.focus({ preventScroll: true });
    return () => {
      const target = restore.current?.element;
      const restored = () => {
        target?.focus({ preventScroll: true });
        return Boolean(target) && document.activeElement === target;
      };
      if (restored()) return;
      requestAnimationFrame(() => {
        // The shell's `inert` is lifted by a sibling subscriber's render, so on
        // the commit that closes this dialog the composer can still be inside
        // an inert subtree — and focusing an inert element silently does
        // nothing. One frame later it does not.
        if (restored()) return;
        if (document.activeElement && document.activeElement !== document.body) return;
        // The control this interrupted is gone or unfocusable — measured on a
        // phone, where the send button no longer existed and focus was left on
        // <body>. If the request is still waiting, the way back to it is the
        // only landing place that does not strand the keyboard.
        document.querySelector<HTMLButtonElement>(".approval-deferred button")?.focus({ preventScroll: true });
      });
    };
  }, [current?.id]);

  useEffect(() => {
    if (!live) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live?.id]);

  useEffect(() => {
    setWarning("");
    warnedFor.current = undefined;
  }, [live?.id]);

  useEffect(() => {
    if (!live || warnedFor.current === live.id) return;
    if (Date.parse(live.expiresAt) - clock > DEADLINE_WARNING_MS) return;
    warnedFor.current = live.id;
    setWarning(approvalDeadlineWarning(live));
  }, [live?.id, clock]);

  /**
   * When this dialog came up, which is when its description is read.
   *
   * Not `clock`: the deadline is announced twice — in the description on open
   * and assertively as it runs out — and never as per-second churn inside a
   * span the dialog's `aria-describedby` points at. A resume is a new open (the
   * request leaves `pending` and comes back), so the sentence is recomputed
   * exactly when a listener is about to hear it again.
   */
  const openedAt = useMemo(() => Date.now(), [current?.id]);

  const facts = current ? factsFor(current) : undefined;
  // A write with no mapped consequence still renders the grid: an unrecognised
  // write must be visible as unrecognised, never as a missing section. Every
  // other effect renders it only when there is something derived to say —
  // which is how `execute_shell` and `execute_workspace_program`, whose
  // derivations existed and had never once been shown, reach the screen.
  const showFacts = Boolean(facts && (facts.derived || current?.effect === "write"));
  const describedBy = ["approval-description", showFacts ? "approval-consequence" : "", "approval-deadline"]
    .filter(Boolean)
    .join(" ");

  // A fragment, not a wrapper: `.app-shell` is a two-track grid, and an element
  // between it and these overlays would be auto-placed into an implicit row.
  return (
    <>
      {/*
        The dock's own voice, mounted for the life of the app.
        Every terminal outcome of a security decision is spoken from here —
        allowed, denied, expired — because the component that held the request
        is gone by the time there is anything to say about it, and a live region
        inserted at the same moment as its text is not reliably announced.
      */}
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{notice}</span>
      <span class="sr-only" role="alert" aria-atomic="true">{warning}</span>
      {/* The waiting bar's own voice, kept apart from the outcome channel above
          so a settlement and an arrival do not overwrite each other, and apart
          from the transcript's narrator so neither steals the other's turn. */}
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{arrival}</span>

      {waiting ? (
        <div
          class="approval-deferred"
          role="group"
          aria-label="Capability request waiting for a decision"
          style={{ "--approval-deferred-floor": `${floor}px` }}
        >
          <strong>{snapshot.deferred.length === 1 ? "1 decision waiting" : `${snapshot.deferred.length} decisions waiting`}</strong>
          {/* Every one of them, not only the first. The count said two and the
              bar printed one name, one clock and one button: the second request
              had no name a person could read and no control at all until the
              first was answered, while its own five minutes ran out. */}
          <ul>
            {snapshot.deferred.map((request) => {
              /* Resolved once per row: the line prints it, the button names it,
                 and the arrival sentence quotes that same button. With turns
                 running in parallel the same tool name can be waiting in two
                 threads, and a decision a person cannot attribute is one they
                 cannot make. */
              const named = conversationName(request.sessionId);
              return (
                <li key={request.id}>
                  <small>{request.toolName} · {named} · expires in {remainingApprovalTime(request.expiresAt, clock)}</small>
                  {/* Reachable, and it answers where the person is standing. A
                      conversation whose turn is still in flight cannot be
                      re-opened — its journal has no terminal event yet, which
                      the local audit reads as invalid — so "go there first"
                      would be a route to nowhere. The dialog names the thread
                      instead. */}
                  <button class="small-button" type="button" onClick={() => broker.resume(request.id)}>{reviewLabel(request, named)}</button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {current ? (
        <div
          class="approval-scrim"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              // Escape filed a denial, so the same keystroke that dismisses the
              // slash menu one line above destroyed the command it dismissed.
              // It now decides nothing: the request stays live on its own clock
              // and stops being modal, so the person can go and read the file
              // they are being asked to overwrite before answering.
              if (broker.defer(current.id)) {
                // Spoken for by the sentence below, so the arrival
                // announcement on the waiting bar does not repeat it.
                spokenFor.current.add(current.id);
                announce.current(approvalDeferralNotice(current, Date.now(), conversationName(current.sessionId)));
              }
            } else if (event.key === "Tab") {
              trapFocus(event, panel.current);
            }
          }}
        >
          <div
            ref={panel}
            class={`approval-dock risk-${current.risk}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-title"
            aria-describedby={describedBy}
            tabIndex={-1}
          >
            <header class="approval-heading">
              <span class="approval-glyph"><Icon name={iconForApproval(current)} /></span>
              <div>
                {/* An effect, an operation and a turn named the request; the
                    thread it came from was the one fact missing, and with turns
                    running in parallel it is the first one a person needs. It
                    goes above the title rather than into the identity grid
                    because it is read before the question, not after it. */}
                <span class="eyebrow">Capability request · {conversationName(current.sessionId)} · {current.risk}</span>
                <h2 id="approval-title">Allow {current.toolName} once?</h2>
              </div>
              {snapshot.pending.length > 1 ? <span class="approval-queue">1 of {snapshot.pending.length}</span> : null}
            </header>

            {/* No `role="timer"`: its implicit aria-live is off, so this was a
                second-by-second text churn no screen reader ever spoke. The
                deadline is spoken by #approval-deadline on open and by the
                assertive region above as it runs out; this is the sighted
                reading of the same fact. */}
            <p class="approval-expiry">Decision expires in <strong>{remainingApprovalTime(current.expiresAt, clock)}</strong></p>

            <p id="approval-description" class="approval-description">{current.description}</p>

            <div class="approval-facts" role="group" aria-label="Approval identity">
              <span><small>Effect</small><strong>{current.effect}</strong></span>
              <span title={current.operationId}><small>Operation</small><strong>{compactId(current.operationId)}</strong></span>
              <span title={current.turnId}><small>Turn</small><strong>{compactId(current.turnId)}</strong></span>
              <span><small>Requested</small><strong>{formatApprovalTime(current.requestedAt)}</strong></span>
            </div>

            {showFacts && facts ? <section class="approval-write-facts" aria-label="Write consequence">
              <div><small>Target</small><strong>{facts.targets.length ? facts.targets.join(", ") : "Adapter-selected target"}</strong></div>
              <div><small>Change</small><strong class="approval-disposition" data-derived={facts.derived ? "true" : "false"}>{facts.disposition}</strong></div>
              <div><small>New size</small><strong>{facts.byteLength === undefined ? "Not supplied" : `${facts.byteLength} bytes`}</strong></div>
              {/* A delta is a difference from a value this panel does not have.
                  Printing "Not supplied" beside it read as a missing argument,
                  when the truth is that nothing here reads the file. The row is
                  shown when the arguments declare both sides and omitted when
                  they do not — which is what the spoken description already
                  did, so the two now agree. */}
              {facts.byteDelta === undefined ? null : <div><small>Size delta</small><strong>{`${facts.byteDelta >= 0 ? "+" : ""}${facts.byteDelta} bytes`}</strong></div>}
              {/* Two sides only when there are two. A create-or-overwrite call
                  carries the new content and nothing about what it replaces, so
                  the old side rendered "∅" over a file that had content — a
                  claim this surface cannot make, and the worst one to make
                  wrong now that a write can land on a person's own disk. The
                  single value is labelled as what it is instead. */}
              {facts.after === undefined ? null : <div class="approval-diff">
                <small>{facts.before === undefined
                  ? "New content, bounded. What it replaces is not read here."
                  : "Bounded old → new preview"}</small>
                <pre>{facts.before === undefined ? null : <del>{facts.before}{"\n"}</del>}<ins>{facts.after || "(empty)"}</ins></pre>
              </div>}
            </section> : null}

            {/* The two halves of the accessible description the grid and the
                countdown could not supply on their own. Not visible, because
                both facts are already on screen above in the form a sighted
                reader needs; this is the same claim, in the form a listener
                needs. */}
            {showFacts && facts ? <span id="approval-consequence" class="sr-only">{approvalConsequenceSummary(facts)}</span> : null}
            <span id="approval-deadline" class="sr-only">{approvalDeadlineSentence(current, openedAt)}</span>

            <details class="approval-arguments">
              <summary>Arguments shown to the approval policy</summary>
              <pre>{JSON.stringify(current.displayArguments, null, 2)}</pre>
            </details>

            <p class="approval-assurance"><Icon name="lock" size={15} /> Secret-like fields are redacted and the display copy is bounded. Approval applies only to this operation ID.</p>

            <footer class="approval-actions">
              <button class="small-button approval-deny" type="button" onClick={() => broker.decide(current.id, "deny")}>Deny</button>
              <button class="small-button approval-allow" type="button" onClick={() => broker.decide(current.id, "allow")}>Allow once</button>
            </footer>
            <p class="approval-escape-hint">Escape decides nothing and keeps this request waiting.</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The derived consequence for one request, in the vocabulary it is derivable
 * in. Read effects never reach the broker, so every request here has one.
 */
function factsFor(request: PendingApproval): WriteApprovalFacts {
  const input = approvalDerivationInput(request.toolName, request.displayArguments);
  return writeApprovalFacts(input.toolName, input.argumentsValue);
}

/** How much of the viewport's bottom edge one blocker occupies, 0 when absent. */
function spokenDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  // The floor of one second is now reachable: the deadline sentence measures
  // what is left rather than the fixed budget, so the last second of a request
  // is spoken — and "1 seconds" is not a thing a screen reader should say.
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function iconForApproval(request: PendingApproval): "workspace" | "cloud" | "terminal" | "access" | "warning" {
  if (request.effect === "write") return "workspace";
  if (request.effect === "network") return "cloud";
  if (request.effect === "execute") return "terminal";
  if (request.effect === "identity") return "access";
  return "warning";
}

function compactId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`;
}

function formatApprovalTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

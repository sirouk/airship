import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Turns are per conversation, and this file is what stops that collapsing back
 * into one.
 *
 * The product used to hold exactly one turn for the whole page: `busy` was a
 * boolean, `activeTurn` was one `AbortController`, and one
 * `SwitchableApprovalPolicy` adjudicated every tool call in every thread.
 * Sending in a second conversation was refused outright, and — the part no
 * amount of allowing would have fixed — two threads pinned to different
 * approval modes would have shared a single adjudicator, so who approved what,
 * under which mode, depended on which conversation happened to be on screen.
 *
 * Source-shape, like `thread-queue.test.ts` and `tool-output-batching.test.ts`
 * beside it: the turn runner is a closure over the app's session authority and
 * cannot be lifted out of `app.tsx` to be driven directly.
 */
async function appSource(): Promise<string> {
  return readFile(new URL("./app.tsx", import.meta.url), "utf8");
}

describe("turns run per conversation, not per page", () => {
  it("derives the visible conversation's busy from a set of running sessions", async () => {
    const app = await appSource();
    expect(app).toContain("const [busySessions, setBusySessions] = useState<ReadonlySet<string>>");
    // The name every existing call site reads keeps meaning "this thread",
    // which is why the composer, the queue and Stop needed no rewrite.
    expect(app).toContain("const busy = sessionId !== undefined && busySessions.has(sessionId);");
    expect(app).toContain("const anyTurnRunning = busySessions.size > 0;");
    // The page-wide boolean is gone from the shell component. `ProfileManagerView`
    // further down keeps one of its own — that one is a form's save latch, not
    // a turn, and it is scoped to a component that renders one profile.
    const shell = app.slice(0, app.indexOf("function ProfileManagerView({"));
    expect(shell).not.toContain("const [busy, setBusy] = useState(false)");
    expect(shell).not.toContain("setBusy(true)");
  });

  it("keeps one controller and one prompt per conversation", async () => {
    const app = await appSource();
    expect(app).toContain("const activeTurns = useRef(new Map<string, AbortController>());");
    expect(app).toContain("const activePrompts = useRef(new Map<string, string>());");
    expect(app).toContain("activeTurns.current.set(turnSessionId, controller);");
    expect(app).toContain("activePrompts.current.set(turnSessionId, content);");
  });

  it("admits a send against this conversation's turn, not the page's", async () => {
    const app = await appSource();
    const guard = app.slice(app.indexOf("async function sendMessage("));
    expect(guard).toContain("|| activeTurns.current.has(sessionId)");
    // The old spelling would refuse a send in thread B because thread A was
    // still answering.
    expect(guard.slice(0, guard.indexOf("setSessionBusy"))).not.toContain("|| activeTurn.current");
  });

  it("binds every turn to its own conversation's approval delegate", async () => {
    const app = await appSource();
    expect(app).toContain("const approvalPolicyControllers = useRef(new Map<string, SwitchableApprovalPolicy>());");
    expect(app).toContain("const localCommandPolicyControllers = useRef(new Map<string, SwitchableApprovalPolicy>());");
    // The turn passes its own session's, never the visible session's.
    expect(app).toContain("approvalPolicy: sessionApprovalPolicy(turnSessionId),");
    expect(app).toContain("const commandPolicy = sessionLocalCommandPolicy(commandSessionId);");
    // Only the visible conversation follows `activeApprovalMode` — that value
    // *is* the visible conversation's mode, so pushing it anywhere else would
    // re-mode a thread nobody is looking at.
    expect(app).toContain("if (sessionId) sessionApprovalPolicy(sessionId).replace(approvalModePolicy);");
    expect(app).toContain("if (sessionId) sessionLocalCommandPolicy(sessionId).replace(humanIntentModePolicy);");
  });

  it("aborts every turn only when a page-wide authority becomes invalid", async () => {
    const app = await appSource();
    expect(app).toContain("function abortAllTurns(reason?: DOMException): void {");
    for (const reason of [
      "Inference route is changing.",
      "Inference connection was disconnected.",
      "Workspace durability is changing.",
      "Local Device Vault restore started.",
    ]) {
      expect(app).toContain(`abortAllTurns(new DOMException("${reason}", "AbortError"))`);
    }
    // A model override is journaled on one conversation. A running turn keeps
    // the model its request already named, so unrelated turns are not aborted.
    const modelSwitch = app.slice(
      app.indexOf("async function switchExternalModel"),
      app.indexOf("async function selectStandbyExternalModel"),
    );
    expect(modelSwitch).toContain("commitExternalModelInPlace");
    expect(modelSwitch).not.toContain("abortAllTurns");
  });

  it("stops only the conversation whose Stop was pressed", async () => {
    const app = await appSource();
    expect(app).toContain("function abortSessionTurn(id: string | undefined, reason?: DOMException): void {");
    const stop = app.slice(app.indexOf("function stopTurn()"));
    expect(stop).toContain('abortSessionTurn(stoppingSessionId, new DOMException("Stopped by user", "AbortError"));');
    // Stop is a verb about this thread; it may never reach into another one.
    expect(stop.slice(0, stop.indexOf("}\n"))).not.toContain("abortAllTurns");
  });

  it("warns on unload about every running thread, not the visible one", async () => {
    const app = await appSource();
    const guard = app.slice(app.indexOf("useBeforeUnloadGuard(unloadWouldLoseWork({"));
    expect(guard.slice(0, guard.indexOf("}))"))).toContain("busy: anyTurnRunning,");
  });

  /*
   * You can go back to a conversation while it is still answering.
   *
   * `decideSessionResume` reads the journal alone, so a turn in flight is
   * indistinguishable there from one abandoned mid-answer: `TURN_INCOMPLETE`
   * becomes a `HISTORY_INCOMPLETE` warning and `resumeLibrarySessionNow` opened
   * the conversation for reading only. Measured in Chromium with a real
   * endpoint held open: clicking that conversation in the rail did nothing, and
   * the refusal it produced could not name one thing that had moved, because
   * nothing had. `activeTurns` is the page's own answer to "is this thread
   * live" — the same authority Stop and the rail's "Working…" read — so it is
   * the one that decides here too.
   */
  it("does not call a conversation this page is answering a saved one", async () => {
    const app = await appSource();
    const resume = app.slice(
      app.indexOf("async function resumeLibrarySessionNow("),
      app.indexOf("function queueSessionAction("),
    );
    expect(resume).toContain("const answeringHere = activeTurns.current.has(fresh.session.id)");
    // Only the reason a live turn actually raises is discounted, only when the
    // whole history was inspected, and never for a blocked verdict.
    expect(resume).toContain('&& fresh.compatibility?.action === "fork-required"');
    expect(resume).toContain("&& fresh.history.checkedEvents === fresh.history.totalEvents");
    expect(resume).toContain('reason.code === "HISTORY_INCOMPLETE" || reason.severity === "info"');
    expect(resume).toContain('const held = fresh.compatibility?.action === "resume" || answeringHere');
  });
});

/*
 * The engine ran turns per conversation; the shell threw it away.
 *
 * `createConversation` returned silently while `busy`, the rail's "+" and both
 * profile switchers were `disabled={busy}`, five palette verbs refused with
 * "Stop the active turn first.", and a `/write` awaiting its approval held a
 * page-wide admission latch that refused a send in every other thread. Every
 * one of those was a page-wide gate standing in for a rule about one
 * conversation, and four of them were about verbs that mint a *new*
 * conversation — which a running turn cannot collide with at all.
 */
describe("a running turn no longer blocks the rest of the shell", () => {
  it("starts a new conversation while any turn is running", async () => {
    const app = await appSource();
    const create = app.slice(app.indexOf("async function createConversation("));
    const guard = create.slice(create.indexOf("if ("), create.indexOf("const active = runtime.current;"));
    expect(guard).not.toContain("busy");
    // What still refuses is an authority in mid-transition, not a turn.
    expect(guard).toContain("inferenceRouteChanging.current");
    expect(guard).toContain("sessionNavigationChanging.current");
  });

  it("leaves the rail's + and both profile switchers reachable mid-turn", async () => {
    const app = await appSource();
    const rail = await readFile(new URL("./rail.tsx", import.meta.url), "utf8");
    // The rail has no page-wide turn flag left to disable anything with.
    expect(rail).not.toContain("disabled={busy}");
    expect(rail).not.toContain("busy: boolean;");
    // The topbar switcher lost its gate too. What `disabled={busy}` still
    // guards in this file is Send-now on this conversation's own queue and a
    // profile form's save latch, neither of which is a profile switch.
    expect(app).not.toMatch(/ariaLabel="Agent profile"[\s\S]{0,200}?disabled=\{busy\}/u);
    expect(app).not.toContain("renameDisabled=");
    expect(app).not.toContain("newConversationDisabled=");
    const bar = await readFile(new URL("./chat/session-bar.tsx", import.meta.url), "utf8");
    expect(bar).not.toContain("renameDisabled");
    expect(bar).not.toContain("newConversationDisabled");
  });

  it("renames, retries, forks and branches without stopping the turn first", async () => {
    const app = await appSource();
    // The sentences themselves, as string literals. The comments that record
    // why they are gone quote them with typographic quotes, exactly so this
    // assertion reads code rather than prose.
    expect(app).not.toContain('"Stop the active turn first."');
    expect(app).not.toContain("Stop the active turn before creating a branch.");
    expect(app).not.toContain("Wait for the current turn to finish before renaming this conversation.");
    expect(app).not.toContain('"Stop the active turn before starting a new conversation."');
    const fork = app.slice(app.indexOf("async function forkFromMessage("));
    expect(fork.slice(0, fork.indexOf("const forkPoint"))).not.toContain("busy");
    expect(app).toContain("branchDisabled={!sessionLibrary || !activeSessionRecord || !entry.item.sourcePoint}");
  });

  it("keeps a local command's admission latch per conversation", async () => {
    const app = await appSource();
    expect(app).toContain("const localCommandAdmission = useRef(new Set<string>());");
    // A `/write` waits on a person, so a page-wide latch refused every other
    // thread's send for as long as the dock was unanswered.
    expect(app).toContain("|| localCommandAdmission.current.has(sessionId)");
    expect(app).toContain("localCommandAdmission.current.add(admissionSessionId);");
    expect(app).toContain("localCommandAdmission.current.delete(admissionSessionId);");
  });

  it("keeps the refusals that are about correctness", async () => {
    const app = await appSource();
    // One turn per conversation: the send guard still refuses its own thread.
    const send = app.slice(app.indexOf("async function sendMessage("));
    expect(send.slice(0, send.indexOf("setSessionBusy"))).toContain("|| activeTurns.current.has(sessionId)");
    // A profile switch replaces the authority every running turn holds, so it
    // still ends all of them — and now says how many, because it is reachable
    // while they run.
    const switchProfile = app.slice(app.indexOf("async function changeProfile("));
    expect(switchProfile).toContain("const stopped = activeTurns.current.size;");
    expect(switchProfile).toContain("abortAllTurns();");
    expect(switchProfile).toContain("turn${stopped === 1 ? \"\" : \"s\"} stopped");
    // A revised profile rebinds what every running turn is using, so the skill
    // refusal became stricter rather than looser.
    expect(app).toContain("if (editingActiveProfile && (\n      anyTurnRunning");
  });

  it("tells the rail which conversations are working", async () => {
    const app = await appSource();
    const rail = await readFile(new URL("./rail.tsx", import.meta.url), "utf8");
    expect(rail).toContain("running?: boolean;");
    expect(rail).toContain('<small class="recent-conversation__running">Working');
    expect(app).toContain("busySessions.has(conversation.id)");
    expect(app).toContain("{ ...conversation, running: true }");
    // The one aggregate reading on the rail counts conversations, not the page.
    expect(app).toContain("activity={[busySessions.size,");
  });
});

/*
 * One broker, many conversations. The dock's modal is the shell's only
 * self-inflicted inert state, and it was raised for `pending.length` — the
 * whole page's answer to a question about one thread.
 */
describe("an approval belongs to the conversation that raised it", () => {
  it("lets only the visible conversation interrupt the shell", async () => {
    const app = await appSource();
    const broker = await readFile(new URL("../approvals/broker.ts", import.meta.url), "utf8");
    // Published beside the two per-conversation policy delegates, because it is
    // the same kind of fact and has to be current before any turn asks.
    expect(app).toContain("approvalBroker.focusSession(sessionId);");
    expect(broker).toContain("focusSession(sessionId: string | undefined): void {");
    expect(broker).toContain("if (this.focused !== undefined && context.sessionId !== this.focused) this.postponed.add(id);");
  });

  it("names the conversation on the dialog, the bar and the way back", async () => {
    const app = await appSource();
    const dock = await readFile(new URL("./approval-dock.tsx", import.meta.url), "utf8");
    expect(app).toContain("conversationName={conversationDisplayName}");
    expect(app).toContain("function conversationDisplayName(id: string): string {");
    expect(dock).toContain("Capability request \u00b7 {conversationName(current.sessionId)} \u00b7 {current.risk}");
    // One row per waiting request, each naming its own conversation: the bar
    // used to print `deferred[0]` and count the rest, so a second request had
    // no name a person could read and no control that answered it.
    expect(dock).toContain("{snapshot.deferred.map((request) => {");
    expect(dock).toContain("const named = conversationName(request.sessionId);");
    expect(dock).toContain("{request.toolName} \u00b7 {named} \u00b7 expires in");
    expect(dock).toContain("{reviewLabel(request, named)}");
  });

  it("re-modes only the conversation whose policy changed", async () => {
    const app = await appSource();
    // Opening a thread pinned to another mode changes `activeApprovalMode`
    // without changing anything about a background thread's pending request.
    expect(app).toContain("if (!sessionId || seen.sessionId !== sessionId || seen.mode === activeApprovalMode) return;");
    expect(app).toContain('approvalBroker.settleAll("page", sessionId);');
    const broker = await readFile(new URL("../approvals/broker.ts", import.meta.url), "utf8");
    expect(broker).toContain('settleAll(actor: "human" | "page", sessionId?: string): void {');
    expect(broker).toContain("if (sessionId === undefined || entry.request.sessionId === sessionId)");
  });
});

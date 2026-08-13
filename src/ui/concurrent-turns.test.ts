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

  it("aborts every turn for a transition that invalidates every turn", async () => {
    const app = await appSource();
    expect(app).toContain("function abortAllTurns(reason?: DOMException): void {");
    // The route, the model, the credential and the workspace's durability are
    // page-wide facts: a turn in an unwatched thread is running against them
    // just as much as the visible one.
    for (const reason of [
      "Inference route is changing.",
      "Inference model is changing.",
      "Inference connection was disconnected.",
      "Remote inference credential was released.",
      "Workspace durability is changing.",
    ]) {
      expect(app).toContain(`abortAllTurns(new DOMException("${reason}", "AbortError"))`);
    }
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
});

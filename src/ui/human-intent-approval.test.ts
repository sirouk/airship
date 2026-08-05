import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../approvals/broker";
import { createApprovalModePolicy, createHumanIntentPolicy, decideHumanIntent } from "../approvals/modes";
import { ToolRegistry } from "../tools/registry";
import type { ToolContext, ToolDefinition } from "../core/contracts";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const helper = source.match(
  /async function reviewHumanIntent\([\s\S]*?\n  \}\n/u,
)?.[0] ?? "";

const commitTool: ToolDefinition = {
  name: "git_commit",
  description: "Commit staged changes in the browser-owned repository.",
  effect: "write",
  inputSchema: { type: "object" },
};

function context(): ToolContext {
  return {
    sessionId: "session",
    turnId: "human-git-1",
    operationId: "git-1",
    signal: new AbortController().signal,
  };
}

/*
 * Two approval paths existed. The registry path validated, ticketed and
 * journaled every model-proposed effect; the direct path used by Git, GitHub
 * import and the vault probe adjudicated the *person's* own effects and then
 * kept nothing — no event, no abort — while still routing them through a model
 * reviewer that could veto its own operator.
 */
describe("human-initiated approvals", () => {
  it("asks the person, not a model, when the person is the one proposing", async () => {
    const broker = new ApprovalBroker();
    const pending = decideHumanIntent({
      mode: "auto-approve",
      broker,
      tool: commitTool,
      argumentsValue: { message: "Ship it" },
      context: context(),
    });

    // Auto Approve means "have a model review what the model wants to do". A
    // commit the operator just typed is not that, so it reaches the dock.
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "allow");
    const reviewed = await pending;

    expect(reviewed.decision).toBe("allow");
    // The mode in force is still the session's pinned mode — the audit rejects
    // provenance claiming a mode the manifest never pinned — while the source
    // names who actually decided.
    expect(reviewed.provenance).toMatchObject({ mode: "auto-approve", source: "human" });
  });

  it("keeps Full Access meaning no prompt, because that is the person's own standing decision", async () => {
    const broker = new ApprovalBroker();
    const reviewed = await decideHumanIntent({
      mode: "full-access",
      broker,
      tool: { ...commitTool, effect: "network" },
      argumentsValue: {},
      context: context(),
    });

    expect(reviewed.decision).toBe("allow");
    expect(reviewed.provenance).toMatchObject({ mode: "full-access", source: "bounded-browser-sandbox" });
    expect(reviewed.provenance.reason).toContain("remote origin");
    expect(broker.snapshot().pending).toHaveLength(0);
  });

  it("routes every human-proposed effect through the one helper that records it", () => {
    /*
     * The three surfaces that exist today, named — and then the scan that makes
     * the claim true of the fourth. A hardcoded list cannot see the failure this
     * guards: a later "push to remote" button that adjudicates a person's own
     * effect by calling the policy or the mode helper directly appends no
     * `HUMAN_INTENT_EVENT_TYPE` event, so the decision is adjudicated and
     * forgotten — exactly the completeness the journal used to claim and not
     * have — while a three-element array stays green because the new function's
     * name is not in it.
     */
    for (const site of ["reviewGitOperation", "reviewSourceImport", "probeVault"]) {
      const body = source.match(new RegExp(`async function ${site}\\([\\s\\S]*?\\n  \\}\\n`, "u"))?.[0] ?? "";
      expect(body, site).toContain("reviewHumanIntent(");
      expect(body, site).not.toContain("decideHumanIntent(");
    }

    // One adjudication of a person's own intent in the whole surface, and it is
    // the one inside the helper that journals it.
    const adjudications = [...source.matchAll(/\bdecideHumanIntent\(/gu)].map((match) => match.index!);
    expect(adjudications).toHaveLength(1);
    const helperStart = source.indexOf("async function reviewHumanIntent(");
    expect(helperStart).toBeGreaterThan(-1);
    expect(adjudications[0]).toBeGreaterThan(helperStart);
    expect(adjudications[0]).toBeLessThan(helperStart + helper.length);

    /*
     * And no surface may reach an adjudicator around it. `review()` on either
     * policy controller, or `request()` on the broker, would both produce a
     * decision with no journal event; the only permitted `.review(` in this file
     * is `tools.review(`, the registry seam that mints and consumes a ticket
     * bound to the argument digest and records its own event.
     */
    for (const bypass of [
      /\bapprovalPolicy\.review\(/u,
      /\blocalCommandPolicy\.review\(/u,
      /\bhumanIntentPolicyController\.review\(/u,
      /\bapprovalBroker\.request\(/u,
    ]) expect(source, String(bypass)).not.toMatch(bypass);
    for (const call of [...source.matchAll(/([A-Za-z_$][\w$]*)\.review\(/gu)]) {
      expect(call[1], call[0]).toBe("tools");
    }

    expect(helper).toContain("decideHumanIntent(");
    expect(helper).toContain("type: HUMAN_INTENT_EVENT_TYPE");
    expect(helper).toContain("approval: reviewed.provenance");
    // The controller outlived every decision it was made for.
    expect(helper).toContain("} finally {");
    expect(helper).toContain("controller.abort();");
  });
});

/*
 * A pending human decision has an abort controller, and the obvious worry is
 * that navigating away strands it: the promise never settles, so `finally`
 * never fires and the controller never aborts.
 *
 * It cannot happen, and this pins the three facts that make it so rather than
 * leaving them as an assumption in a review note. If any of them is ever
 * loosened — the dock moved inside the routed region, `approvalPending`
 * dropped from the inert set, `denyAll` removed from teardown — a route-change
 * abort becomes necessary and these assertions are where that is discovered.
 */
describe("a pending decision cannot be navigated away from", () => {
  /*
   * The dock is deferred but warmed as soon as the shell mounts, keeping its
   * accessibility implementation out of first paint without fetching it while
   * a person waits on a decision. It is still mounted from the same place,
   * which is the whole of what this contract is about, so the assertion follows
   * the component rather than the import.
   */
  const dock = "{ApprovalDockView ? <ApprovalDockView broker={approvalBroker} /> : null}";

  it("renders the dock outside the routed region, so a view change cannot unmount it", () => {
    expect(source).toContain(dock);
    // After `</main>`: the dock is a sibling of the routed region, not a child,
    // so every route renders the same live decision rather than discarding one.
    expect(source.indexOf(dock)).toBeGreaterThan(source.indexOf("</main>"));
  });

  it("makes the shell inert only when the pending decision has a resident dialog", () => {
    // The broker's own pending count still drives the modal state, but a failed
    // chunk may never make controls inert around an empty screen. That request
    // is denied synchronously instead.
    expect(source).toContain('"approval-dock",\n    () => import("./approval-dock"),');
    expect(source).toContain("approvalBroker.subscribe((state) => {");
    expect(source).toContain("if (approvalDockReady.current) {");
    expect(source).toContain("if (approvalDockUnavailable.current) {");
    expect(source).toContain("denyPendingForUnavailableDock(pendingCount);");
    expect(source).toContain("setApprovalDockWaitingRequests(pendingCount);");
    expect(source).toContain(">Deny pending request</button>");
    expect(source).toContain("&& !approvalDockWaitingVisible");
    expect(source).toContain("|| approvalPending || Boolean(profileCockpitTransition)");
    // Topbar, rail, main and the mobile bar: every control that changes route.
    expect(source.match(/inert=\{platformOverlayOpen\}/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain("chromeInert={platformOverlayOpen}");
  });

  it("fails the decision closed if the page goes away under it", () => {
    // The one exit that is not navigation. Teardown denies rather than
    // abandoning, so no awaited decision outlives the surface that asked for it.
    expect(source).toContain("approvalBroker.denyAll();");
  });
});

/*
 * The fourth surface. `/write`, `/execute-shell` and their peers are typed by
 * the person, but were adjudicated by `createApprovalModePolicy` — so under Auto
 * Approve the operator's own command body went to a review model, and an
 * `unsafe` verdict denied it outright with no human fallback. They cannot use
 * `decideHumanIntent` directly, because `ToolRegistry.review` is what mints the
 * approval ticket `executeApproved` consumes; the decision is injected as the
 * policy so the ticket seam survives intact.
 */
describe("local slash commands", () => {
  const writeTool: ToolDefinition = {
    name: "write_file",
    description: "Write a file into the profile workspace.",
    effect: "write",
    inputSchema: { type: "object" },
  };

  function localContext(): ToolContext {
    return { sessionId: "session", turnId: "local-1", operationId: "op-1", signal: new AbortController().signal };
  }

  it("asks the person under Auto Approve instead of asking a model about them", async () => {
    const broker = new ApprovalBroker();
    const policy = createHumanIntentPolicy({ mode: "auto-approve", broker });
    const context = localContext();
    const pending = policy.review(writeTool, { path: "notes.txt", content: "hi" }, context);

    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "allow");

    expect(await pending).toBe("allow");
    // The mode in force is still the session's pinned mode — the audit rejects
    // provenance naming a mode the manifest never pinned.
    expect(policy.takeProvenance?.(context)).toMatchObject({ mode: "auto-approve", source: "human" });
  });

  it("still runs through the registry, so the approval ticket is what authorizes execution", async () => {
    const registry = new ToolRegistry();
    let wrote = "";
    registry.register({
      definition: writeTool,
      async execute(argumentsValue) {
        wrote = String((argumentsValue as { content?: unknown }).content ?? "");
        return { content: "written" };
      },
    });
    const broker = new ApprovalBroker();
    const policy = createHumanIntentPolicy({ mode: "auto-approve", broker });
    const context = localContext();

    async function allowOnce(target: ToolContext): Promise<void> {
      const reviewing = registry.review("write_file", { content: "hi" }, target, policy);
      await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
      broker.decide(broker.snapshot().pending[0]!.id, "allow");
      expect(await reviewing).toBe("allow");
    }

    // The ticket binds the exact arguments that were shown at the dock, so an
    // allowed command cannot be executed with different ones — and the attempt
    // spends the ticket, so it cannot be retried with the right ones either.
    await allowOnce(context);
    await expect(registry.executeApproved("write_file", { content: "swapped" }, context))
      .rejects.toThrow("Approved tool arguments changed");
    await expect(registry.executeApproved("write_file", { content: "hi" }, context))
      .rejects.toThrow("not bound to a live approval");
    expect(wrote).toBe("");

    const second = { ...localContext(), operationId: "op-2" };
    await allowOnce(second);
    expect((await registry.executeApproved("write_file", { content: "hi" }, second)).content).toBe("written");
    expect(wrote).toBe("hi");
  });

  it("cannot be vetoed by a model verdict the operator never gets to answer", async () => {
    const unsafe = { verdict: "unsafe" as const, reason: "The model judged this command dangerous." };

    // What the composer did before: an `unsafe` verdict is a terminal denial in
    // `createApprovalModePolicy` — no dock prompt, no fallback — so a command
    // the person typed themselves was refused by a model on their behalf.
    const vetoBroker = new ApprovalBroker();
    const vetoed = createApprovalModePolicy({
      mode: "auto-approve",
      broker: vetoBroker,
      safetyReview: async () => unsafe,
    });
    expect(await vetoed.review(writeTool, { path: "notes.txt" }, localContext())).toBe("deny");
    expect(vetoBroker.snapshot().pending).toHaveLength(0);

    // What it does now: the person is asked, and there is no reviewer to ask.
    const broker = new ApprovalBroker();
    const context = localContext();
    const pending = createHumanIntentPolicy({ mode: "auto-approve", broker })
      .review(writeTool, { path: "notes.txt" }, context);
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "allow");
    expect(await pending).toBe("allow");
  });

  it("keeps reads automatic, so asking is reserved for effects worth adjudicating", async () => {
    const broker = new ApprovalBroker();
    const policy = createHumanIntentPolicy({ mode: "ask-first", broker });
    const context = localContext();

    expect(await policy.review({ ...writeTool, effect: "read" }, {}, context)).toBe("allow");
    expect(broker.snapshot().pending).toHaveLength(0);
    expect(policy.takeProvenance?.(context)).toMatchObject({ mode: "ask-first", source: "automatic-read" });
  });

  it("reviews the composer's local command under the human-intent policy", () => {
    // Source-shape, because the local-command runner is a 200-line closure over
    // the app's session authority and cannot be lifted out of app.tsx.
    expect(source).toContain("createHumanIntentPolicy({ mode: activeApprovalMode, broker: approvalBroker })");
    expect(source).toContain("commandRuntime.tools.review(plan.toolName, plan.arguments, context, localCommandPolicy)");
    expect(source).toContain("approvalProvenance(localCommandPolicy, context)");
    expect(source).not.toContain("commandRuntime.tools.review(plan.toolName, plan.arguments, context, approvalPolicy)");
    // The two lines that described a provider request that no longer happens.
    expect(source).not.toContain("the safety review model received this action's parameters");
    expect(source).not.toContain("Local command complete after a separate safety review");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../approvals/broker";
import { decideHumanIntent } from "../approvals/modes";
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
    // A fourth surface must not be able to skip the journal by forgetting to
    // write it, so no UI-initiated effect may call the policy directly.
    for (const site of ["reviewGitOperation", "reviewSourceImport", "probeVault"]) {
      const body = source.match(new RegExp(`async function ${site}\\([\\s\\S]*?\\n  \\}\\n`, "u"))?.[0] ?? "";
      expect(body, site).toContain("reviewHumanIntent(");
      expect(body, site).not.toContain("approvalPolicy.review(");
    }
    expect(helper).toContain("decideHumanIntent(");
    expect(helper).toContain("type: HUMAN_INTENT_EVENT_TYPE");
    expect(helper).toContain("approval: reviewed.provenance");
    // The controller outlived every decision it was made for.
    expect(helper).toContain("} finally {");
    expect(helper).toContain("controller.abort();");
  });
});

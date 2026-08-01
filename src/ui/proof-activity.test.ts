import { describe, expect, it } from "vitest";
import { CONVERSATION_NAMED_EVENT_TYPE, HUMAN_INTENT_EVENT_TYPE, TERMINAL_ACTIVITY_EVENT_TYPE, type JsonValue } from "../core/contracts";
import type { DurableEvent } from "../core/journal";
import { proofActivityLedger, proofActivityRowForTurn, proofGroundingIndex } from "./proof-activity";

let sequence = 0;
function event(type: string, payload: JsonValue, turnId?: string): DurableEvent {
  sequence += 1;
  return {
    version: 1,
    eventId: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    recordedAt: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    previousDigest: "sha256:previous",
    digest: "sha256:digest",
    type,
    ...(turnId ? { turnId } : {}),
    payload,
  };
}

const DIGEST = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GENERATION = "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CHUNK = "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const HIT_TEXT = "the body";

/**
 * A v2 selection shaped the way `canonicalContextSelection` accepts one.
 *
 * Built through the real validator rather than a hand-rolled shape, because a
 * fixture the parser rejects would let this file pass while the route rendered
 * nothing — the exact failure mode of the finding it covers.
 */
function selection(): JsonValue {
  return {
    version: 2,
    queryDigest: DIGEST,
    generationDigest: GENERATION,
    workspaceSnapshotDigest: DIGEST,
    selectionDigest: DIGEST,
    selectedAt: "2026-07-31T00:00:00.000Z",
    maxHits: 8,
    maxBytes: 32_768,
    selectedBytes: new TextEncoder().encode(HIT_TEXT).byteLength,
    truncated: false,
    hits: [{
      path: "notes/retrieval.md",
      revision: "rev-7",
      contentDigest: DIGEST,
      chunkId: CHUNK,
      chunkIndex: 3,
      score: 0.82,
      text: HIT_TEXT,
      textDigest: DIGEST,
      corpus: "workspace",
      sourceId: "notes/retrieval.md",
      lineageRef: GENERATION,
    }],
    lineage: {
      retriever: "airship-workspace-turn-context-v1",
      scope: { sessionId: "session-1" },
      generations: [{
        id: GENERATION,
        corpus: "workspace",
        sourceRevision: "rev-7",
        sourceDigest: DIGEST,
        extractor: "text",
        chunker: "paragraph",
        indexFormat: "airship-index-v1",
        persistence: "memory-only",
        embedding: { provider: "deterministic", dimensions: 64, posture: "deterministic-bootstrap" },
      }],
    },
  } as unknown as JsonValue;
}

describe("proofActivityLedger", () => {
  it("names a local command turn and why it has no receipt", () => {
    // J048. The transcript badges `/read` "COMPLETED TURN"; Proof reported the
    // integer 1 and nothing about what ran.
    const ledger = proofActivityLedger([
      event("local.command.requested", { content: "/read notes/retrieval.md", toolName: "read_file" }, "turn-local"),
      event("local.command.approved", { toolName: "read_file" }, "turn-local"),
      event("local.command.completed", { content: "…", toolName: "read_file", isError: false }, "turn-local"),
    ]);
    expect(ledger.rows).toHaveLength(1);
    const row = ledger.rows[0]!;
    expect(row.kind).toBe("local-command");
    expect(row.title).toBe("/read notes/retrieval.md");
    expect(row.outcome).toBe("completed");
    expect(row.receiptId).toBeUndefined();
    expect(row.receiptNote).toMatch(/called no provider/u);
    expect(row.facts).toContainEqual({ label: "Tool", value: "read_file" });
  });

  it("carries the sources a turn was grounded on, with revision and chunk", () => {
    // J049. The selection is journaled and audited; nothing rendered it.
    const ledger = proofActivityLedger([
      event("turn.requested", { content: "What did the Kyoto trial say?" }, "turn-1"),
      event("turn.context.selected", { contextSelection: selection() }, "turn-1"),
      event("turn.completed", { receiptId: "urn:airship:receipt:abc" }, "turn-1"),
    ]);
    const row = ledger.rows[0]!;
    expect(row.receiptId).toBe("urn:airship:receipt:abc");
    expect(row.receiptNote).toBeUndefined();
    expect(row.grounding).toEqual([{
      path: "notes/retrieval.md",
      revision: "rev-7",
      chunkId: CHUNK,
      chunkIndex: 3,
      contentDigest: DIGEST,
      score: 0.82,
      corpus: "workspace",
    }]);
    expect(row.groundingBytes).toBe(new TextEncoder().encode(HIT_TEXT).byteLength);
    expect(proofGroundingIndex(ledger)).toHaveLength(1);
  });

  it("counts the human-approved effects no audit field counts", () => {
    // J069. Two commits under two approvals rendered as four zeros.
    const ledger = proofActivityLedger([
      event(HUMAN_INTENT_EVENT_TYPE, {
        toolName: "git_stage", effect: "write", decision: "allow",
        summary: "Stage paths", arguments: { path: "README.md" }, approval: null,
      }),
      event(HUMAN_INTENT_EVENT_TYPE, {
        toolName: "git_commit", effect: "write", decision: "allow",
        summary: "Commit staged", arguments: { message: "docs: persist marker" }, approval: null,
      }),
    ]);
    expect(ledger.rows.map((row) => row.title)).toEqual(["git_stage", "git_commit"]);
    expect(ledger.rows.every((row) => row.kind === "approved-effect")).toBe(true);
    expect(ledger.rows[1]!.facts).toContainEqual({ label: "Target", value: "docs: persist marker" });
  });

  it("records shell work and the conversation-naming request", () => {
    const ledger = proofActivityLedger([
      event(TERMINAL_ACTIVITY_EVENT_TYPE, {
        version: 1, terminalSessionId: "t1", recordId: "r1", sequence: 1, kind: "command",
        outcome: "exited", recordedAt: "2026-07-31T00:00:00.000Z", processEpoch: 1,
        origin: "workspace", cwd: "/workspace", summary: "git status", command: "git status",
        exitCode: 0, changedPaths: ["README.md"],
      }),
      event(CONVERSATION_NAMED_EVENT_TYPE, { title: "Kyoto retrieval", model: "airship/demo-v1" }),
    ]);
    expect(ledger.rows.map((row) => row.kind)).toEqual(["shell", "naming"]);
    expect(ledger.rows[0]!.facts).toContainEqual({ label: "Exit code", value: "0" });
    expect(ledger.rows[1]!.title).toBe("Named “Kyoto retrieval”");
  });

  it("says a started turn never reached a terminal event rather than calling it done", () => {
    const ledger = proofActivityLedger([event("turn.requested", { content: "hello" }, "turn-x")]);
    expect(ledger.rows[0]!.outcome).toBe("running");
    expect(ledger.rows[0]!.receiptNote).toMatch(/no terminal event/iu);
  });

  it("resolves the turn a deep link is scoped to", () => {
    // J050. The address carried a turn id the route rendered nothing for.
    const ledger = proofActivityLedger([
      event("turn.requested", { content: "first" }, "turn-a"),
      event("turn.completed", { receiptId: "urn:one" }, "turn-a"),
      event("turn.requested", { content: "second" }, "turn-b"),
    ]);
    expect(proofActivityRowForTurn(ledger, "turn-b")?.title).toBe("second");
    expect(proofActivityRowForTurn(ledger, "missing")).toBeUndefined();
    expect(proofActivityRowForTurn(ledger, undefined)).toBeUndefined();
  });

  it("shortens a long prompt visibly and strips control characters", () => {
    const ledger = proofActivityLedger([
      event("turn.requested", { content: `${"x".repeat(400)}` }, "turn-long"),
    ]);
    const title = ledger.rows[0]!.title;
    expect(title.endsWith("…")).toBe(true);
    expect(title).toHaveLength(120);
    expect(/[\u0000-\u001F]/u.test(title)).toBe(false);
  });

  it("reports how much of the journal it accounted for", () => {
    const ledger = proofActivityLedger([
      event("session.created", { title: "General" }),
      event("turn.requested", { content: "hi" }, "turn-1"),
      event("turn.completed", { receiptId: "urn:one" }, "turn-1"),
    ]);
    expect(ledger.totalEvents).toBe(3);
    expect(ledger.accountedEvents).toBe(2);
  });
});

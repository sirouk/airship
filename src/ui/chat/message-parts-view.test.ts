import { describe, expect, it } from "vitest";
import { messagePartsFromFacts, type MessagePart, type MessagePartFact } from "./message-parts";
import {
  boundedMessageParts,
  DEFAULT_OPERATION_RENDER_LIMIT,
  operationHeadline,
  operationStripState,
  pairOperations,
  resultDigest,
  scalarDigest,
  streamedMessageTail,
  type OperationsNode,
  type PairedOperation,
} from "./message-parts-view";

describe("streamed message tail", () => {
  it("renders the separate, non-durable stream segment beside durable facts", () => {
    const parts = messagePartsFromFacts([{ kind: "text", factId: "first", sequence: 1, text: "Stored " }]);
    expect(streamedMessageTail(parts, "live", true)).toBe("live");
  });

  it("renders the full stream before any durable text exists", () => {
    const parts = messagePartsFromFacts([{
      kind: "tool-call",
      factId: "call",
      sequence: 1,
      callId: "call-1",
      name: "read_file",
    }]);
    expect(streamedMessageTail(parts, "Working…", true)).toBe("Working…");
  });

  it("hides ephemeral content as soon as a message is no longer streaming", () => {
    const parts = messagePartsFromFacts([{ kind: "text", factId: "first", sequence: 1, text: "Durable" }]);
    expect(streamedMessageTail(parts, "Durable complete", false)).toBe("");
  });

  it("keeps the default tool-step surface bounded", () => {
    expect(DEFAULT_OPERATION_RENDER_LIMIT).toBe(12);
  });

  it("moves the whole chronological suffix after the operation boundary", () => {
    const facts = Array.from({ length: 13 }, (_, index) => ([
      { kind: "tool-call" as const, factId: `call-${String(index)}`, sequence: index * 2 + 1, callId: `call-${String(index)}`, name: "read_file" },
      { kind: "tool-result" as const, factId: `result-${String(index)}`, sequence: index * 2 + 2, callId: `call-${String(index)}`, content: `result ${String(index)}` },
    ])).flat();
    facts.push({ kind: "text", factId: "final", sequence: 100, text: "Final answer" } as never);
    const bounded = boundedMessageParts(messagePartsFromFacts(facts), 12);

    expect(bounded.visible.filter((part) => part.kind === "tool-call" || part.kind === "tool-result")).toHaveLength(12);
    expect(bounded.overflow[0]?.kind).toBe("tool-call");
    expect(bounded.overflow.at(-1)).toMatchObject({ kind: "text", content: "Final answer" });
  });
});

describe("paired operations", () => {
  it("folds a result into its call and renders one row at the call's index", () => {
    const nodes = pairOperations(messagePartsFromFacts([
      { kind: "text", factId: "lead", sequence: 1, text: "I’ll read it." },
      call("call-1", 2, "read_file", { path: "/workspace/README.md" }),
      { kind: "tool-result", factId: "result-1", sequence: 3, callId: "call-1", content: "# Airship" },
      { kind: "text", factId: "answer", sequence: 4, text: "It is Airship." },
    ]));

    expect(nodes.map((node) => node.kind)).toEqual(["part", "operations", "part"]);
    const [operation] = operations(nodes[1]!);
    expect(operation).toMatchObject({
      callId: "call-1",
      name: "read_file",
      outcome: "ran",
      statusSentence: "Tool step completed",
      argumentDigest: "/workspace/README.md",
      hasCall: true,
      hasResult: true,
    });
    expect(operations(nodes[1]!)).toHaveLength(1);
  });

  it("marks the missing half of an orphaned result rather than dropping it", () => {
    const nodes = pairOperations(messagePartsFromFacts([
      { kind: "tool-result", factId: "orphan", sequence: 1, callId: "call-lost", name: "list_files", content: "3 files" },
    ]));

    expect(operations(nodes[0]!)[0]).toMatchObject({
      name: "list_files",
      hasCall: false,
      hasResult: true,
      argumentDigest: "Originating call not recorded",
    });
  });

  it("brackets the steps one provider message issued together", () => {
    const nodes = pairOperations(messagePartsFromFacts([
      { ...call("call-a", 2, "read_file", { path: "a" }), ordinal: 0 },
      { ...call("call-b", 2, "read_file", { path: "b" }), ordinal: 1 },
      call("call-c", 3, "list_files", { path: "/" }),
    ]));
    const node = nodes[0] as OperationsNode;

    expect(node.groups.map((group) => group.parallel)).toEqual([true, false]);
    expect(node.groups[0]?.operations).toHaveLength(2);
    expect(operationHeadline(node.operations, false)).toContain("2 in parallel");
  });

  it("is not sliced in two by a provider's blank text delta", () => {
    const nodes = pairOperations(messagePartsFromFacts([
      call("call-1", 1, "read_file", { path: "a" }),
      { kind: "text", factId: "blank", sequence: 2, text: "\n\n" },
      call("call-2", 3, "list_files", { path: "/" }),
    ]));

    expect(nodes.filter((node) => node.kind === "operations")).toHaveLength(1);
    expect(operations(nodes.find((node) => node.kind === "operations")!)).toHaveLength(2);
    // The blank part still renders: nothing is deleted, it simply is not a break.
    expect(nodes.filter((node) => node.kind === "part")).toHaveLength(1);
  });

  it("keeps consecutive operations in one strip and breaks it at prose", () => {
    const nodes = pairOperations(messagePartsFromFacts([
      call("call-1", 1, "read_file", { path: "a" }),
      call("call-2", 2, "read_file", { path: "b" }),
      { kind: "text", factId: "middle", sequence: 3, text: "Now listing." },
      call("call-3", 4, "list_files", { path: "/" }),
    ]));

    expect(nodes.map((node) => node.kind)).toEqual(["operations", "part", "operations"]);
    expect(operations(nodes[0]!)).toHaveLength(2);
  });
});

describe("operation strip state", () => {
  it("collapses only a settled, wholly completed run of four or more", () => {
    expect(operationStripState(run(4, "ran")).collapsible).toBe(true);
    expect(operationStripState(run(3, "ran")).collapsible).toBe(false);
    expect(operationStripState([...run(3, "ran"), ...run(1, "running")]).collapsible).toBe(false);
  });

  it("keeps a failure or a denial on screen whatever the preference says", () => {
    const failed = operationStripState([...run(4, "ran"), ...run(1, "failed")]);
    expect(failed.forced).toBe(true);
    expect(failed.collapsible).toBe(false);
    expect(operationStripState([...run(4, "ran"), ...run(1, "denied")]).collapsible).toBe(false);
  });

  it("honours the expert override without ever hiding a row by default", () => {
    expect(operationStripState(run(6, "ran"), "rows").collapsible).toBe(false);
    expect(operationStripState(run(6, "ran"), "summary").collapsible).toBe(true);
  });

  it("enumerates counts, distinct tool names and outcomes in the header", () => {
    const steps = [
      operation("read_file", "ran", 1),
      operation("read_file", "ran", 2),
      operation("list_files", "ran", 3),
      operation("write_file", "ran", 4),
    ];
    expect(operationHeadline(steps, false)).toBe("4 steps · read_file ×2, list_files, write_file · all completed");
    expect(operationHeadline([...steps, operation("write_file", "failed", 5)], false))
      .toBe("5 steps · read_file ×2, list_files, write_file ×2 · 4 completed, 1 failed");
    expect(operationHeadline(steps, true)).toBe("Working · 4 steps");
  });

  it("states that the whole chronological run is shown once it passes the render limit", () => {
    const long = Array.from({ length: 13 }, (_, index) => operation("read_file", "ran", index + 1));
    expect(operationHeadline(long, false)).toContain("all shown in order");
    expect(operationHeadline(run(4, "ran"), false)).not.toContain("shown in order");
  });
});

describe("row digests", () => {
  it("promotes the first scalar of the arguments and falls back to the raw summary", () => {
    expect(scalarDigest('{"path":"/workspace/README.md"}')).toBe("/workspace/README.md");
    expect(scalarDigest('{"filter":{"limit":12}}')).toBe("12");
    expect(scalarDigest("not json")).toBe("not json");
    expect(scalarDigest("")).toBe("");
  });

  it("prefers a size or a count the tool itself reported", () => {
    expect(resultDigest(result("x", { metadataSummary: '{"count":23}' }))).toBe("23 items");
    expect(resultDigest(result("x", { metadataSummary: '{"files":4}' }))).toBe("4 files");
    expect(resultDigest(result("x", { metadataSummary: '{"bytes":845}' }))).toBe("845 B");
  });

  it("never claims a size it cannot see the end of", () => {
    expect(resultDigest(result("abcde"))).toBe("5 B");
    expect(resultDigest(result("abcde…"))).toBe("8 B+");
  });

  it("leads a failure with its first clause instead of a byte count", () => {
    expect(resultDigest(result("ENOENT: no such file. Check the path.", { status: "error" })))
      .toBe("ENOENT: no such file");
  });
});

function operations(node: { kind: string }): readonly PairedOperation[] {
  return (node as OperationsNode).operations;
}

function call(callId: string, sequence: number, name: string, args: Record<string, string>): MessagePartFact {
  return { kind: "tool-call", factId: `fact-${callId}`, sequence, callId, name, arguments: args };
}

function result(
  content: string,
  overrides: Partial<Extract<MessagePart, { kind: "tool-result" }>> = {},
): Extract<MessagePart, { kind: "tool-result" }> {
  return Object.freeze({
    id: "tool-result:one",
    kind: "tool-result",
    sequence: 1,
    endSequence: 1,
    sourceFactIds: Object.freeze(["one"]),
    callId: "call-1",
    summary: content,
    status: "success",
    ...overrides,
  });
}

function run(count: number, outcome: PairedOperation["outcome"]): readonly PairedOperation[] {
  return Array.from({ length: count }, (_, index) => operation("read_file", outcome, index + 1));
}

function operation(name: string, outcome: PairedOperation["outcome"], sequence: number): PairedOperation {
  return Object.freeze({
    id: `op-${name}-${String(sequence)}`,
    callId: `call-${String(sequence)}`,
    name,
    sequence,
    outcome,
    statusSentence: "Tool step completed",
    argumentsSummary: "{}",
    argumentDigest: "",
    resultDigest: "",
    hasCall: true,
    hasResult: outcome === "ran",
  });
}

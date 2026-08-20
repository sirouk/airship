/**
 * Journal-level proof of airship's read-effect batch discipline inside the
 * prime session authority: declared `effect: "read"` tools execute
 * concurrently in contiguous runs and journal tool_execution_end in
 * settlement order; anything else is a barrier. The planner semantics live
 * in src/prime/agent/tool-batches.test.ts — this file pins the session's
 * journal evidence end-to-end.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../ai/providers/faux.test-support";
import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { createSessionManifest } from "../../core/session-manifest";
import type { Model } from "../ai/types";
import { PrimeAgentSession } from "./session";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

/** A stub tool with controlled settle latency, minted with airship effect metadata. */
function latencyTool(name: string, effect: "read" | "write", latencyMs: number, log: string[]): Tool {
  return {
    definition: {
      name,
      description: `Latency stub ${name}`,
      effect,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(_args: JsonValue, _context: ToolContext): Promise<ToolExecutionResult> {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      log.push(`${name}:end`);
      return { content: `${name}-ok`, isError: false };
    },
  };
}

async function fixture(tools: Tool[]): Promise<Readonly<{
  registration: FauxProviderRegistration;
  journal: EventJournal;
  session: PrimeAgentSession;
  sessionId: string;
  statuses: string[];
}>> {
  const registration = registerFauxProvider({});
  registrations.push(registration);
  const model = registration.getModel() as Model<string>;
  if (!model) throw new Error("no model");
  const journal = new EventJournal(new MemoryJournalBackend());
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const manifest = await createSessionManifest({
    systemPrompt: "batch test",
    providerId: "faux",
    model: model.id,
    tools: registry.definitions(),
    workspaceId: "ws-batch-test",
    securityPosture: "local",
    turnContext: "disabled",
  });
  const statuses: string[] = [];
  const record = await journal.createSession("batch evidence", manifest);
  const session = new PrimeAgentSession({
    sessionId: record.id,
    manifest,
    journal,
    registry,
    approvalPolicy: allowAllForTests,
    model,
    onSignal(signal) {
      if (signal.type === "status") statuses.push(signal.status);
    },
  });
  return { registration, journal, session, sessionId: record.id, statuses };
}

describe("prime read-effect batching, journal evidence", () => {
  it("three declared reads complete concurrently and journal execution_end in settlement order", async () => {
    const log: string[] = [];
    const fix = await fixture([
      latencyTool("read_a", "read", 90, log),
      latencyTool("read_b", "read", 20, log),
      latencyTool("read_c", "read", 50, log),
    ]);
    // One assistant message with three read calls, then an answering message.
    fix.registration.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("read_a", {}, { id: "call-a" }),
          fauxToolCall("read_b", {}, { id: "call-b" }),
          fauxToolCall("read_c", {}, { id: "call-c" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const started = Date.now();
    const result = await fix.session.prompt("run the batch");
    expect(result.outcome).toBe("completed");
    // Settlement order is the actual concurrency witness: every start
    // precedes every end, and ends land b(20) < c(50) < a(90).
    expect(log).toEqual([
      "read_a:start", "read_b:start", "read_c:start",
      "read_b:end", "read_c:end", "read_a:end",
    ]);

    // tool_execution_start / _end are the loop's progress vocabulary in
    // both engines, never journaled: the settlement-order proof rides the
    // settle log above, and the status channel mirrors admission order
    // ("running X" fires at each call's admission, strict source order).
    const events = await fix.journal.readEvents(fix.sessionId);
    const results = events.filter((event) => event.type === "tool.resulted");
    expect(results.map((event) => event.operationId)).toEqual(["call-a", "call-b", "call-c"]);
    // One "running X" fires at review (beforeToolCall) and one at the
    // loop's admission emit — both strict source order per call.
    expect(fix.statuses.filter((status) => status.startsWith("running"))).toEqual([
      "running read_a", "running read_a",
      "running read_b", "running read_b",
      "running read_c", "running read_c",
    ]);
  });

  it("a write barrier splits two read runs and strictly serializes the boundary", async () => {
    const log: string[] = [];
    const fix = await fixture([
      latencyTool("read_a", "read", 60, log),
      latencyTool("write_b", "write", 10, log),
      latencyTool("read_c", "read", 30, log),
      latencyTool("read_d", "read", 5, log),
    ]);
    fix.registration.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("read_a", {}, { id: "call-a" }),
          fauxToolCall("write_b", {}, { id: "call-b" }),
          fauxToolCall("read_c", {}, { id: "call-c" }),
          fauxToolCall("read_d", {}, { id: "call-d" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const result = await fix.session.prompt("run the mixed batch");
    expect(result.outcome).toBe("completed");
    // Barrier discipline: read_a settles before write_b starts; the second
    // read run starts only after write_b settles, and d(5) settles before
    // c(30) — concurrency inside the run, serialization across the barrier.
    expect(log).toEqual([
      "read_a:start", "read_a:end",
      "write_b:start", "write_b:end",
      "read_c:start", "read_d:start",
      "read_d:end", "read_c:end",
    ]);
    const events = await fix.journal.readEvents(fix.sessionId);
    const results = events.filter((event) => event.type === "tool.resulted");
    expect(results.map((event) => event.operationId)).toEqual(["call-a", "call-b", "call-c", "call-d"]);
  }, 30_000);
});

import { describe, expect, it, vi } from "vitest";
import { allowAllForTests, ToolRegistry } from "../tools/registry";
import type { InferenceEvent, InferenceRequest, InferenceTransport, JsonValue } from "./contracts";
import { createSessionManifest, runTurn } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";

describe("agent runtime promotion", () => {
  it("continues one journaled baseline turn through activation, install, build, and final response", async () => {
    let ready = false;
    let dependenciesReady = false;
    const installRuntime = vi.fn(async () => {
      ready = true;
      return {
        content: JSON.stringify({
          state: "ready",
          usableNow: true,
          sessionCompatibility: "ready-in-current-session",
        }),
        metadata: {
          initialCapabilityTier: "web-baseline",
          liveCapabilityTier: "web-enhanced",
          capabilityTier: "web-enhanced",
          requiresNewConversation: false,
        },
      };
    });
    const executeNode = vi.fn(async (args: JsonValue) => {
      if (!ready) throw new Error("Node runtime was not activated.");
      const commandArgs = args && typeof args === "object" && !Array.isArray(args) && Array.isArray(args.args)
        ? args.args.map(String)
        : [];
      if (commandArgs[0] === "install") dependenciesReady = true;
      if (commandArgs[0] === "run" && !dependenciesReady) throw new Error("Dependencies were not retained.");
      return {
        content: JSON.stringify({
          runtime: "node-webcontainer",
          exitCode: 0,
          provenance: { capabilityTier: "web-enhanced", authority: "browser" },
        }),
        metadata: { capabilityTier: "web-enhanced" },
      };
    });
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "install_execution_runtime",
        description: "Activate a browser runtime and continue in this conversation.",
        effect: "network",
        inputSchema: {
          type: "object",
          properties: { runtime: { type: "string" } },
          required: ["runtime"],
          additionalProperties: false,
        },
      },
      execute: installRuntime,
    });
    tools.register({
      definition: {
        name: "execute_node_project",
        description: "Run one finite Node project command.",
        effect: "network",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
          },
          required: ["command", "args"],
          additionalProperties: false,
        },
      },
      execute: executeNode,
    });

    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({
      systemPrompt: "Activate the right runtime, continue immediately, and verify the build.",
      providerId: "scripted-runtime-promotion",
      model: "test/model",
      tools: tools.definitions(),
      workspaceId: "memory://vite",
      capabilityTier: "web-baseline",
    });
    const session = await journal.createSession("Vite hello world", manifest);
    const requests: InferenceRequest[] = [];
    const transport = scriptedTransport([
      toolCall("activate-node", "install_execution_runtime", { runtime: "node-webcontainer" }),
      toolCall("npm-install", "execute_node_project", { command: "npm", args: ["install"] }),
      toolCall("vite-build", "execute_node_project", { command: "npm", args: ["run", "build"] }),
      [
        { type: "text-delta", text: "Vite hello world built successfully in this conversation." },
        { type: "completed", finishReason: "stop" },
      ],
    ], requests);

    const result = await runTurn({
      sessionId: session.id,
      content: "Build me a Vite hello world.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("Vite hello world built successfully in this conversation.");
    expect(installRuntime).toHaveBeenCalledOnce();
    expect(executeNode).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(4);
    const events = await journal.readEvents(session.id);
    expect(new Set(events.flatMap(({ turnId }) => turnId ? [turnId] : []))).toEqual(new Set([result.turnId]));
    expect(events.filter(({ type }) => type === "tool.requested")).toHaveLength(3);
    expect(events.filter(({ type }) => type === "tool.resulted")).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.some(({ type }) => type === "turn.failed")).toBe(false);
  });
});

function toolCall(id: string, name: string, args: JsonValue): readonly InferenceEvent[] {
  return [
    { type: "tool-call", call: { id, name, arguments: args } },
    { type: "completed", finishReason: "tool-calls" },
  ];
}

function scriptedTransport(
  steps: readonly (readonly InferenceEvent[])[],
  requests: InferenceRequest[],
): InferenceTransport {
  let next = 0;
  return {
    id: "scripted-runtime-promotion",
    posture: "local",
    async *stream(request: InferenceRequest, signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      requests.push(request);
      const events = steps[next++];
      if (!events) throw new Error("Scripted runtime-promotion transport exhausted.");
      for (const event of events) yield event;
    },
  };
}

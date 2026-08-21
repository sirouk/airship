import { describe, expect, it } from "vitest";
import type { InferenceTransport, SessionInferenceBindingV2 } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { allowAllForTests } from "../../tools/registry";
import { createWorkspaceToolRegistry } from "../../tools/workspace-tools";
import { MemoryWorkspace } from "../../workspace/memory";
import type { Model } from "../ai/types";
import { createPrimeAgentRuntimeFactory } from "./agent-factory";

const binding: SessionInferenceBindingV2 = Object.freeze({
  version: 2,
  connectionId: "ollama-loopback",
  connectionGeneration: 4,
  providerId: "ollama",
  providerLabel: "Ollama",
  providerRevision: 1,
  transportId: "ollama-openai-local-v1",
  protocol: "openai-compatible",
  authMethod: "local-none",
  transportBoundary: "loopback-local",
  modelId: "gemma3:latest",
  boundAt: "2026-08-20T00:00:00.000Z",
});
const model: Model<"openai-completions"> = Object.freeze({
  id: binding.modelId,
  name: binding.modelId,
  api: "openai-completions",
  provider: binding.providerId,
  baseUrl: "https://gateway/ollama",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
});

describe("Prime child inference authority", () => {
  it("pins a child to the parent's canonical provider, protocol, and exact transport", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const workspace = new MemoryWorkspace();
    const airshipTools = createWorkspaceToolRegistry(workspace);
    const transport: InferenceTransport = {
      id: binding.transportId,
      posture: "local",
      async *stream() { throw new Error("not invoked while constructing a child"); },
    };
    const factory = createPrimeAgentRuntimeFactory({
      journal,
      approvalPolicy: allowAllForTests,
      workspace,
      airshipTools,
      transport,
      providerId: binding.providerId,
      inferenceBinding: binding,
      workspaceId: "memory://prime-child",
    });

    const input = {
      childId: "child-1",
      fromId: "root-1",
      fromName: "root",
      prompt: "inspect",
      taskPrompt: "inspect",
      name: "inspector",
      slug: "inspector",
      model,
      depth: 1,
      sessionPath: "session://root-1/child-1",
      spawnMessage: {
        id: "message-1",
        fromId: "root-1",
        fromName: "root",
        toId: "child-1",
        toName: "inspector",
        content: "inspect",
        timestamp: 1,
      },
    } as const;
    const bundle = await factory.create(input);

    const [record] = await journal.listSessions();
    expect(record?.manifest).toMatchObject({
      providerId: "ollama",
      model: "gemma3:latest",
      inferenceBinding: {
        version: 2,
        providerId: "ollama",
        transportId: "ollama-openai-local-v1",
        protocol: "openai-compatible",
      },
    });
    await bundle.runtime.stop("test complete");

    const mismatchedFactory = createPrimeAgentRuntimeFactory({
      journal,
      approvalPolicy: allowAllForTests,
      workspace,
      airshipTools,
      transport: { ...transport, id: "ollama" },
      providerId: binding.providerId,
      inferenceBinding: binding,
      workspaceId: "memory://prime-child",
    });
    await expect(mismatchedFactory.create({
      ...input,
      childId: "child-2",
      name: "refused-child",
      slug: "refused-child",
      sessionPath: "session://root-1/child-2",
      spawnMessage: {
        ...input.spawnMessage,
        id: "message-2",
        toId: "child-2",
        toName: "refused-child",
      },
    })).rejects.toThrow(/transport is pinned/u);
    expect(await journal.listSessions()).toHaveLength(1);
  });
});

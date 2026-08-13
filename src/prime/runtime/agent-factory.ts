import type { ApprovalPolicy } from "../../core/contracts";
import type { EventJournal } from "../../core/journal";
import type { InferenceTransport } from "../../core/contracts";
import type { WorkspacePort } from "../../workspace/contracts";
import type { Agent } from "../agent";
import type { KernelJobResult, KernelJobSpec } from "../kernel/kernel-contract";
import type { Usage } from "../ai/types";
import type { PrimeAgentMessage, PrimeAgentRuntime, PrimeSubagentHandle } from "./types-prime";
import type { PrimeAgentMessageSink } from "../subagents/types";
import type {
  PrimeAgentRuntimeBundle,
  PrimeAgentRuntimeFactory,
  PrimeSubagentSpawnInput,
} from "../subagents/types";
import { PrimeAgentSession } from "./session";
import { createSessionManifest } from "../../core/session-manifest";
import { createPrimeToolSurface, attachPrimeKernelTool } from "./tool-surface";
import { primeHarnessStore } from "./harness-store";
import { composePrimeSystemPrompt } from "../system-prompt";

/**
 * The production runtime factory: `rlm(...)` and `subagent(...)` become real
 * child sessions instead of a named absence.
 *
 * Until now the only implementation of this interface was the test double in
 * `subagents/test-utils.ts`, which is why `createPrimeToolRegistry` omitted
 * the whole RLM family with "no agent registry is attached to this session".
 *
 * The contract this has to honour, and the one that is easy to get wrong: a
 * factory MUST NOT run the task inline. It builds the child and returns; the
 * registry starts the run by pushing the `spawnMessage` envelope into the
 * sink, and watches the bundled `agent` for `agent_end` to decide the child
 * finished. Running the prompt here would make admission and execution the
 * same act, and the registry's whole admission model — never awaited, rate
 * limited, depth gated — assumes they are not.
 *
 * Each child is a real journaled conversation. It gets its own session record,
 * its own manifest (digested from the same tool surface the parent runs, so a
 * child's evidence chain is auditable by exactly the rules the parent's is),
 * its own kernel host, and its own approval path. A subagent that could write
 * files without crossing `ToolRegistry.review` would be an approval bypass
 * wearing a delegation's name.
 */
export type PrimeAgentFactoryDeps = Readonly<{
  journal: EventJournal;
  approvalPolicy: ApprovalPolicy;
  workspace: WorkspacePort;
  /** Airship's registry, whose non-colliding tools the child inherits. */
  airshipTools: Parameters<typeof createPrimeToolSurface>[0]["airship"];
  transport: InferenceTransport;
  providerId: string;
  workspaceId: string;
  /** Bounds a child turn exactly as the parent turn is bounded. */
  maxSteps?: number;
  /** Aborts every live child when the parent turn is aborted. */
  signal?: AbortSignal;
}>;

/**
 * A sink over one child session's prompt queue.
 *
 * `accept` answers "delivered" only once the child has actually taken the
 * message into a turn. Anything the child is still working through is
 * "queued", and `pendingCount` reports that depth so the router can refuse at
 * its bound instead of growing an unbounded backlog behind a wedged child —
 * which is the failure this interface's comment exists to prevent.
 */
class PrimeSessionSink implements PrimeAgentMessageSink {
  #pending: PrimeAgentMessage[] = [];
  #running = false;

  constructor(
    private readonly session: PrimeAgentSession,
    private readonly onSettled: (error?: unknown) => void,
  ) {}

  pendingCount(): number {
    return this.#pending.length;
  }

  async accept(message: PrimeAgentMessage): Promise<"delivered" | "queued"> {
    this.#pending.push(message);
    if (this.#running) return "queued";
    void this.#drain();
    return "delivered";
  }

  async #drain(): Promise<void> {
    this.#running = true;
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending.shift()!;
        await this.session.prompt(next.content);
      }
      this.onSettled();
    } catch (error) {
      // Never a silent drop: the registry's terminal notice is how the parent
      // learns a child died, and swallowing this is what would make a failed
      // child look like a child that simply never replied.
      this.onSettled(error);
    } finally {
      this.#running = false;
    }
  }
}

export function createPrimeAgentRuntimeFactory(deps: PrimeAgentFactoryDeps): PrimeAgentRuntimeFactory {
  return {
    async create(input: PrimeSubagentSpawnInput): Promise<PrimeAgentRuntimeBundle> {
      const surface = createPrimeToolSurface({
        workspace: deps.workspace,
        airship: deps.airshipTools,
        ...(primeHarnessStore() ? { harness: primeHarnessStore()! } : {}),
      });

      /*
       * The child's own system prompt, composed with its own identity. The
       * ported composer takes the child doctrine verbatim from `rlm.ts` —
       * "You are a child agent spawned by <parent>. Task prompts are labeled
       * `[task from parent]`." — and a child that did not carry it would not
       * know it was one.
       */
      const composed = await composePrimeSystemPrompt({
        sessionId: input.childId,
        workingDirectory: "/workspace",
        conversationLogPath: "not persisted",
        currentDate: new Date().toISOString().slice(0, 10),
        recursionDepth: input.depth,
        parentAgentName: input.fromName,
      });
      const systemPrompt = composed.prompt;

      const manifest = await createSessionManifest({
        systemPrompt,
        providerId: deps.providerId,
        model: input.model.id,
        tools: surface.registry.definitions(),
        workspaceId: deps.workspaceId,
      });
      const record = await deps.journal.createSession(`${input.name} · child of ${input.fromName}`, manifest);

      const session = new PrimeAgentSession({
        sessionId: record.id,
        manifest,
        journal: deps.journal,
        registry: surface.registry,
        approvalPolicy: deps.approvalPolicy,
        model: input.model,
        transport: deps.transport,
        ...(deps.maxSteps !== undefined ? { maxSteps: deps.maxSteps } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      attachPrimeKernelTool(surface, session.kernelHost);

      const handle: PrimeSubagentHandle = Object.freeze({
        id: input.childId,
        name: input.name,
        role: "subagent",
        parentId: input.fromId,
        depth: input.depth,
        model: input.model,
        sessionPath: input.sessionPath,
        status: "running",
      });

      const sink = new PrimeSessionSink(session, () => {
        // Settlement is observed by the registry through the agent's own
        // `agent_end`; nothing extra is emitted here.
      });

      const runtime: PrimeAgentRuntime = Object.freeze({
        handle,
        agent: session.agent as Agent,
        kernel: session.kernelHost,
        execKernel: (spec: KernelJobSpec): Promise<KernelJobResult> => session.kernelHost.exec(spec),
        usage: (): Usage => session.getUsageTotals(),
        stop: async (reason: string): Promise<void> => {
          await session.dispose(reason);
        },
      });

      return { runtime, sink };
    },
  };
}

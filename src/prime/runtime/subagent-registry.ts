import type {
  ApprovalPolicy,
  InferenceTransport,
  SessionInferenceBindingV2,
} from "../../core/contracts";
import type { EventJournal } from "../../core/journal";
import type { WorkspacePort } from "../../workspace/contracts";
import type { Api, Model } from "../ai/types";
import type { ToolRegistry } from "../../tools/registry";
import type { PrimeAgentMessage } from "./types-prime";
import type { PrimeAgentMessageSink } from "../subagents/types";
import type { PrimeToolAgentDeps } from "../tools/registry-factories";
import { PrimeAgentRegistry } from "../subagents/registry";
import { createPrimeAgentRuntimeFactory } from "./agent-factory";
import { primeHarnessStore } from "./harness-store";
import type { PrimeAgentSession } from "./session";

/**
 * The parent side of the family: a registry whose owner is this turn's own
 * session.
 *
 * Two orderings fight here and this module is where they are reconciled. The
 * tool surface must exist before the session, because the session is
 * constructed with the registry the surface produced — and the *agent*
 * registry must exist before the surface, because `rlm_spawn` is only
 * registered when one is present. But `PrimeAgentRegistry` requires
 * `owner.sink`, and the owner is the session that does not exist yet.
 *
 * So the owner's sink is a late-bound forwarder: constructed empty, answered
 * by `bindOwnerSession` the moment the session is attached. Before binding it
 * refuses descriptively rather than dropping — a terminal notice delivered
 * into a void is exactly the silent failure `PrimeAgentMessageSink`'s contract
 * forbids, and the window is a few statements wide.
 */
export type PrimeSubagentRegistryDeps = Readonly<{
  journal: EventJournal;
  approvalPolicy: ApprovalPolicy;
  workspace: WorkspacePort;
  airshipTools: ToolRegistry;
  transport: InferenceTransport;
  providerId: string;
  inferenceBinding?: SessionInferenceBindingV2;
  workspaceId: string;
  sessionId: string;
  model: Model<Api>;
  maxSteps?: number;
  signal?: AbortSignal;
}>;

export type PrimeSubagentRegistryBinding = Readonly<{
  /** Hand straight to `createPrimeToolSurface({ agent })`. */
  deps: PrimeToolAgentDeps;
  registry: PrimeAgentRegistry;
  /** Answer the owner's sink once the session it names exists. */
  bindOwnerSession(session: PrimeAgentSession): void;
}>;

class LateBoundOwnerSink implements PrimeAgentMessageSink {
  #session: PrimeAgentSession | undefined;
  #pending = 0;

  bind(session: PrimeAgentSession): void {
    this.#session = session;
  }

  pendingCount(): number {
    return this.#pending;
  }

  async accept(message: PrimeAgentMessage): Promise<"delivered" | "queued"> {
    const session = this.#session;
    if (!session) {
      throw new Error("The owning prime session is not attached yet, so this notice cannot be delivered.");
    }
    this.#pending += 1;
    try {
      await session.prompt(message.content);
      return "delivered";
    } finally {
      this.#pending -= 1;
    }
  }
}

export function createPrimeSubagentRegistry(deps: PrimeSubagentRegistryDeps): PrimeSubagentRegistryBinding {
  const ownerSink = new LateBoundOwnerSink();
  const factory = createPrimeAgentRuntimeFactory({
    journal: deps.journal,
    approvalPolicy: deps.approvalPolicy,
    workspace: deps.workspace,
    airshipTools: deps.airshipTools,
    transport: deps.transport,
    providerId: deps.providerId,
    ...(deps.inferenceBinding ? { inferenceBinding: deps.inferenceBinding } : {}),
    workspaceId: deps.workspaceId,
    ...(deps.maxSteps !== undefined ? { maxSteps: deps.maxSteps } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  const registry = new PrimeAgentRegistry({
    factory,
    owner: {
      id: deps.sessionId,
      name: "root",
      role: "root",
      // Roots are depth 0; the depth gate counts down from here and the child
      // doctrine only renders below it.
      depth: 0,
      model: deps.model,
      sessionPath: `session://${deps.sessionId}`,
      sink: ownerSink,
    },
    /*
     * `env` rather than `process.env`: there is no process in a browser, and
     * the registry reads exactly one variable (`RLM_MAX_DEPTH`). Passing an
     * empty snapshot lets the documented precedence — chat > global > env >
     * default 1 — resolve without the port reaching for a global that is not
     * there.
     */
    env: {},
    ...(primeHarnessStore() ? { harnessStore: primeHarnessStore()! } : {}),
  });

  return Object.freeze({
    registry,
    deps: Object.freeze({
      self: Object.freeze({ id: deps.sessionId, name: "root", depth: 0 }),
      registry,
    }),
    bindOwnerSession(session: PrimeAgentSession): void {
      ownerSink.bind(session);
    },
  });
}

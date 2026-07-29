import type {
  ApprovalPolicy,
  JsonValue,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import { compileToolInputSchema } from "./schema";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import type { TurnContextProvider } from "../core/context-selection";
import type { LiveEnvironmentProvider } from "../core/live-environment";

const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
const MAX_APPROVAL_TICKETS = 256;
const MAX_CLOSED_OPERATIONS = 65_536;

type RegisteredTool = Readonly<{
  tool: Tool;
  validate: (value: JsonValue) => void;
}>;

type ApprovalTicket = Readonly<{
  toolName: string;
  argumentsDigest: string;
  signal: AbortSignal;
  abort: () => void;
}>;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly pendingReviews = new Set<string>();
  private readonly pendingOperations = new Set<string>();
  private readonly closedOperations = new Set<string>();
  private readonly approvals = new Map<string, ApprovalTicket>();
  private contextRuntime?: ClientContextRuntime;
  private turnContextProvider?: TurnContextProvider;
  private liveEnvironmentProvider?: LiveEnvironmentProvider;

  attachContextRuntime(runtime: ClientContextRuntime): void {
    if (this.contextRuntime && this.contextRuntime !== runtime) throw new Error("A different context runtime is already attached.");
    this.contextRuntime = runtime;
  }

  getContextRuntime(): ClientContextRuntime | undefined {
    return this.contextRuntime;
  }

  attachTurnContextProvider(provider: TurnContextProvider): void {
    if (this.turnContextProvider && this.turnContextProvider !== provider) {
      throw new Error("A different turn context provider is already attached.");
    }
    this.turnContextProvider = provider;
  }

  getTurnContextProvider(): TurnContextProvider | undefined {
    return this.turnContextProvider;
  }

  attachLiveEnvironmentProvider(provider: LiveEnvironmentProvider): void {
    if (this.liveEnvironmentProvider && this.liveEnvironmentProvider !== provider) {
      throw new Error("A different live environment provider is already attached.");
    }
    this.liveEnvironmentProvider = provider;
  }

  getLiveEnvironmentProvider(): LiveEnvironmentProvider | undefined {
    return this.liveEnvironmentProvider;
  }

  register(tool: Tool): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(tool.definition.name)) {
      throw new Error(`Invalid tool name: ${tool.definition.name}`);
    }
    if (this.tools.has(tool.definition.name)) throw new Error(`Tool already registered: ${tool.definition.name}`);
    const validate = compileToolInputSchema(tool.definition.inputSchema);
    this.tools.set(tool.definition.name, Object.freeze({ tool, validate }));
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .map(({ tool }) => structuredClone(tool.definition))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  validateArguments(name: string, argumentsValue: JsonValue): void {
    const registered = this.tools.get(name);
    if (!registered) throw new Error(`Unknown tool: ${name}`);
    registered.validate(argumentsValue);
  }

  async review(
    name: string,
    argumentsValue: JsonValue,
    context: ToolContext,
    approvalPolicy: ApprovalPolicy,
  ): Promise<"allow" | "deny"> {
    const registered = this.tools.get(name);
    if (!registered || context.signal.aborted) return "deny";
    registered.validate(argumentsValue);
    const key = approvalKey(context);
    const operation = operationKey(context);
    if (
      this.pendingReviews.has(key) ||
      this.pendingOperations.has(operation) ||
      this.closedOperations.has(operation) ||
      this.approvals.has(key) ||
      this.approvals.size >= MAX_APPROVAL_TICKETS ||
      this.closedOperations.size >= MAX_CLOSED_OPERATIONS
    ) return "deny";
    this.pendingReviews.add(key);
    this.pendingOperations.add(operation);
    try {
      const canonicalArguments = structuredClone(argumentsValue);
      const argumentsDigest = await sha256(stableStringify(canonicalArguments));
      const decision = await approvalPolicy.review(registered.tool.definition, canonicalArguments, context);
      if (decision !== "allow" || context.signal.aborted) return "deny";
      const abort = () => this.consumeApproval(key);
      context.signal.addEventListener("abort", abort, { once: true });
      this.approvals.set(key, Object.freeze({ toolName: name, argumentsDigest, signal: context.signal, abort }));
      return "allow";
    } finally {
      this.closedOperations.add(operation);
      this.pendingReviews.delete(key);
      this.pendingOperations.delete(operation);
    }
  }

  async executeApproved(
    name: string,
    argumentsValue: JsonValue,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const registered = this.tools.get(name);
    if (!registered) return { content: `Unknown tool: ${name}`, isError: true };
    if (context.signal.aborted) throw context.signal.reason;
    registered.validate(argumentsValue);
    const key = approvalKey(context);
    const ticket = this.consumeApproval(key);
    if (!ticket || ticket.toolName !== name) throw new Error("Tool execution is not bound to a live approval.");
    const argumentsDigest = await sha256(stableStringify(argumentsValue));
    if (argumentsDigest !== ticket.argumentsDigest) throw new Error("Approved tool arguments changed before execution.");
    const result = await registered.tool.execute(structuredClone(argumentsValue), context);
    if (new TextEncoder().encode(result.content).byteLength > MAX_TOOL_OUTPUT_BYTES) {
      throw new Error(`Tool output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes.`);
    }
    return result;
  }

  private consumeApproval(key: string): ApprovalTicket | undefined {
    const ticket = this.approvals.get(key);
    if (!ticket) return undefined;
    this.approvals.delete(key);
    ticket.signal.removeEventListener("abort", ticket.abort);
    return ticket;
  }
}

function approvalKey(context: ToolContext): string {
  return [context.sessionId, context.turnId, context.operationId]
    .map((value) => `${value.length}:${value}`)
    .join("|");
}

function operationKey(context: ToolContext): string {
  return [context.sessionId, context.operationId]
    .map((value) => `${value.length}:${value}`)
    .join("|");
}

export const allowReadsAskWrites = (ask: (summary: string) => Promise<boolean>): ApprovalPolicy => ({
  async review(tool, _argumentsValue, _context) {
    if (tool.effect === "read") return "allow";
    return (await ask(`${tool.name} requests ${tool.effect} access.`)) ? "allow" : "deny";
  },
});

export const allowAllForTests: ApprovalPolicy = {
  async review() {
    return "allow";
  },
  // A policy that approves has to say on whose authority, or the journals these
  // fixtures produce are not the journals Airship writes — and the audit, which
  // now requires provenance on every approval, would be proving something else.
  takeProvenance() {
    return {
      mode: "full-access",
      source: "bounded-browser-sandbox",
      reason: "Allowed unconditionally by the test approval policy.",
    };
  },
};

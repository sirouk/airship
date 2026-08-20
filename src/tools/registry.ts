import type {
  ApprovalPolicy,
  JsonValue,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  TaskPlanProvider,
} from "../core/contracts";
import { toolArgumentsDigest } from "../core/hash";
import { compileToolInputSchema } from "./schema";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import type { TurnContextProvider } from "../core/context-selection";
import type { LiveEnvironmentProvider } from "../core/live-environment";

const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
const MAX_APPROVAL_TICKETS = 256;
const MAX_CLOSED_OPERATIONS = 65_536;
const MAX_ARGUMENT_SNAPSHOT_DEPTH = 64;
const MAX_ARGUMENT_SNAPSHOT_VALUES = 100_000;

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
  private taskPlanProvider?: TaskPlanProvider;

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

  attachTaskPlanProvider(provider: TaskPlanProvider): void {
    if (this.taskPlanProvider && this.taskPlanProvider !== provider) {
      throw new Error("A different task plan provider is already attached.");
    }
    this.taskPlanProvider = provider;
  }

  getTaskPlanProvider(): TaskPlanProvider | undefined {
    return this.taskPlanProvider;
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
    if (!registered) return "deny";

    // Take both caller-owned inputs before the first await. Everything below,
    // including the policy, sees this exact immutable admission snapshot.
    const canonicalArguments = ownedJsonSnapshot(argumentsValue);
    const canonicalContext = toolContextSnapshot(context);
    if (canonicalContext.signal.aborted) return "deny";
    registered.validate(canonicalArguments);
    const key = approvalKey(canonicalContext);
    const operation = operationKey(canonicalContext);
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
      const argumentsDigest = await toolArgumentsDigest(canonicalArguments);
      const decision = await approvalPolicy.review(
        registered.tool.definition,
        canonicalArguments,
        canonicalContext,
      );
      if (decision !== "allow" || canonicalContext.signal.aborted) return "deny";
      const abort = () => this.consumeApproval(key);
      canonicalContext.signal.addEventListener("abort", abort, { once: true });
      this.approvals.set(key, Object.freeze({
        toolName: name,
        argumentsDigest,
        signal: canonicalContext.signal,
        abort,
      }));
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

    // Snapshot synchronously so mutation while WebCrypto is pending cannot
    // change either the digest preimage or the values delivered to the tool.
    const canonicalArguments = ownedJsonSnapshot(argumentsValue);
    const canonicalContext = toolContextSnapshot(context);
    if (canonicalContext.signal.aborted) throw canonicalContext.signal.reason;
    registered.validate(canonicalArguments);
    const key = approvalKey(canonicalContext);
    const ticket = this.consumeApproval(key);
    if (!ticket || ticket.toolName !== name || ticket.signal !== canonicalContext.signal) {
      throw new Error("Tool execution is not bound to a live approval.");
    }
    const argumentsDigest = await toolArgumentsDigest(canonicalArguments);
    if (argumentsDigest !== ticket.argumentsDigest) throw new Error("Approved tool arguments changed before execution.");
    throwIfAborted(canonicalContext.signal);
    const result = await registered.tool.execute(canonicalArguments, canonicalContext);
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

/**
 * Clone the JSON data domain without reading a property value through normal
 * property access. `structuredClone` accepts accessors and several non-JSON
 * platform objects, while JSON stringification silently changes sparse arrays
 * and unsupported values. Approval inputs must do neither.
 */
function ownedJsonSnapshot(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const budget = { values: 0 };

  const clone = (input: unknown, depth: number, path: string): JsonValue => {
    budget.values += 1;
    if (budget.values > MAX_ARGUMENT_SNAPSHOT_VALUES) {
      throw new TypeError("Tool arguments exceed the JSON snapshot value limit.");
    }
    if (depth > MAX_ARGUMENT_SNAPSHOT_DEPTH) {
      throw new TypeError("Tool arguments exceed the JSON snapshot depth limit.");
    }
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError(`Tool arguments ${path} is not a finite JSON number.`);
      return input;
    }
    if (typeof input !== "object") throw new TypeError(`Tool arguments ${path} is not JSON data.`);
    if (ancestors.has(input)) throw new TypeError(`Tool arguments ${path} is cyclic.`);

    ancestors.add(input);
    try {
      const prototype = Object.getPrototypeOf(input);
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);

      if (Array.isArray(input)) {
        if (prototype !== Array.prototype) throw new TypeError(`Tool arguments ${path} contains an exotic array.`);
        const lengthDescriptor = descriptors.length;
        const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
        if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
          throw new TypeError(`Tool arguments ${path} contains a sparse or exotic array.`);
        }
        const output: JsonValue[] = new Array(length);
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError(`Tool arguments ${path} contains an accessor or sparse array entry.`);
          }
          output[index] = clone(descriptor.value, depth + 1, `${path}/${index}`);
        }
        return Object.freeze(output) as unknown as JsonValue;
      }

      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Tool arguments ${path} contains an exotic object.`);
      }
      const output: Record<string, JsonValue> = {};
      for (const key of keys) {
        if (typeof key !== "string") throw new TypeError(`Tool arguments ${path} contains a symbol key.`);
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`Tool arguments ${path}/${key} contains an accessor or non-JSON property.`);
        }
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, depth + 1, `${path}/${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return Object.freeze(output) as JsonValue;
    } finally {
      ancestors.delete(input);
    }
  };

  return clone(value, 0, "");
}

/** Read every caller-owned field once, before an await, and pass only this object onward. */
function toolContextSnapshot(context: ToolContext): ToolContext {
  const sessionId = context.sessionId;
  const turnId = context.turnId;
  const operationId = context.operationId;
  const signal = context.signal;
  const capabilityTier = context.capabilityTier;
  const onOutput = context.onOutput;
  if (typeof sessionId !== "string" || typeof turnId !== "string" || typeof operationId !== "string") {
    throw new TypeError("Tool context identifiers must be strings.");
  }
  if (!signal || typeof signal !== "object") throw new TypeError("Tool context signal is invalid.");
  if (
    capabilityTier !== undefined &&
    capabilityTier !== "web-baseline" &&
    capabilityTier !== "web-enhanced" &&
    capabilityTier !== "native" &&
    capabilityTier !== "remote-heavy"
  ) throw new TypeError("Tool context capability tier is invalid.");
  if (onOutput !== undefined && typeof onOutput !== "function") {
    throw new TypeError("Tool context output callback is invalid.");
  }
  const snapshot: ToolContext = { sessionId, turnId, operationId, signal };
  if (capabilityTier !== undefined) snapshot.capabilityTier = capabilityTier;
  if (onOutput !== undefined) snapshot.onOutput = onOutput;
  return Object.freeze(snapshot);
}

function throwIfAborted(signal: AbortSignal): void {
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) throw signal.reason;
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

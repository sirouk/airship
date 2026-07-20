import type { ApprovalPolicy, JsonValue, ToolContext, ToolDefinition } from "../core/contracts";

const MAX_COMPLETED_REVIEWS = 512;

/**
 * Stable policy identity for long-running turns.
 *
 * A turn captures its ApprovalPolicy when it starts. Preferences may change
 * before that turn reaches a tool call, so replacing only a component-local
 * policy object leaves the live turn on the old mode. This indirection selects
 * the current policy when review actually begins and preserves provenance from
 * the exact delegate that made that decision.
 */
export class SwitchableApprovalPolicy implements ApprovalPolicy {
  private active: ApprovalPolicy;
  private readonly completed = new Map<string, ApprovalPolicy>();

  constructor(initial: ApprovalPolicy) {
    this.active = initial;
  }

  replace(next: ApprovalPolicy): void {
    this.active = next;
  }

  async review(tool: ToolDefinition, argumentsValue: JsonValue, context: ToolContext) {
    const delegate = this.active;
    const decision = await delegate.review(tool, argumentsValue, context);
    if (this.completed.size >= MAX_COMPLETED_REVIEWS) {
      this.completed.delete(this.completed.keys().next().value as string);
    }
    this.completed.set(contextKey(context), delegate);
    return decision;
  }

  takeProvenance(context: ToolContext) {
    const key = contextKey(context);
    const delegate = this.completed.get(key);
    this.completed.delete(key);
    return delegate?.takeProvenance?.(context);
  }
}

function contextKey(context: ToolContext): string {
  return [context.sessionId, context.turnId, context.operationId]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

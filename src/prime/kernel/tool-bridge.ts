/**
 * The kernel tool bridge: the sanctioned egress from sandboxed kernel
 * code into airship tools. Every bridge call:
 *
 *   1. is validated + reviewed by the same ToolRegistry.review() the turn
 *      loop uses — a denial here is a denial of the real tool;
 *   2. gets its own kernel operation identity
 *      (prime-kernel:<jobId>:<seq>) so approval tickets and journal
 *      records stay independently auditable;
 *   3. is journaled under the prime.kernel.* namespace, using the exact
 *      tool.* payload shapes the turn audit already knows how to read;
 *      kernel-internal effects never masquerade as provider tool calls;
 *   4. is bounded per-call by the registry (MAX_TOOL_OUTPUT_BYTES) and
 *      per-job by the kernel budget — two independent bounds.
 *
 * Layering: this module imports from src/tools and src/approvals;
 * src/prime/kernel/* must not. The seam is the KernelBridgePort.
 */

import { approvalProvenance } from "../../approvals/modes";
import type { ApprovalPolicy, JsonValue, ToolContext } from "../../core/contracts";
import type { EventJournal } from "../../core/journal";
import type { ToolRegistry } from "../../tools/registry";
import type { KernelBridgeCallRequest, KernelBridgeCallResult } from "./kernel-contract";
import type { KernelBridgePort } from "./kernel-host";

export type KernelToolBridgeOptions = Readonly<{
  registry: ToolRegistry;
  approvalPolicy: ApprovalPolicy;
  journal: EventJournal;
  sessionId: string;
  /** The owning turn id; bridged calls are attributed to it as turnId. */
  turnId: () => string;
  signal: AbortSignal;
  capabilityTier?: "web-baseline" | "web-enhanced";
}>;

export const PRIME_KERNEL_TOOL_EVENT_TYPES = Object.freeze({
  toolRequested: "prime.kernel.tool.requested",
  toolApproved: "prime.kernel.tool.approved",
  toolDenied: "prime.kernel.tool.denied",
  toolResulted: "prime.kernel.tool.resulted",
  toolFailed: "prime.kernel.tool.failed",
} as const);

export function kernelOperationId(jobId: string, seq: number): string {
  return `prime-kernel:${jobId}:${seq}`;
}

export class KernelToolBridge implements KernelBridgePort {
  constructor(private readonly options: KernelToolBridgeOptions) {}

  async call(request: KernelBridgeCallRequest, label?: string): Promise<KernelBridgeCallResult> {
    const { registry, approvalPolicy } = this.options;
    const operationId = kernelOperationId(request.jobId, request.seq);
    const turnId = this.options.turnId();
    const context: ToolContext = {
      sessionId: this.options.sessionId,
      turnId,
      operationId,
      signal: this.options.signal,
      capabilityTier: this.options.capabilityTier,
    };
    const meta = { jobId: request.jobId, seq: request.seq, label: label ?? null };

    if (request.tool === "execute_code") {
      const message = "The Prime kernel bridge cannot invoke execute_code recursively; return from the current kernel job before starting another.";
      await this.failed(operationId, request, meta, message);
      return { seq: request.seq, ok: false, error: message };
    }

    try {
      registry.validateArguments(request.tool, request.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failed(operationId, request, meta, message);
      return { seq: request.seq, ok: false, error: message };
    }

    let decision: "allow" | "deny";
    try {
      decision = await this.options.registry.review(request.tool, request.arguments, context, approvalPolicy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failed(operationId, request, meta, message);
      return { seq: request.seq, ok: false, error: message };
    }

    const provenance = approvalProvenance(approvalPolicy, context);
    if (decision === "deny") {
      await this.options.journal.append(this.options.sessionId, [{
        type: PRIME_KERNEL_TOOL_EVENT_TYPES.toolDenied,
        turnId,
        operationId,
        payload: { callId: operationId, name: request.tool, approval: provenance ?? null, ...meta },
      }]);
      return { seq: request.seq, ok: false, error: `Permission denied for ${request.tool}.` };
    }

    await this.options.journal.append(this.options.sessionId, [{
      type: PRIME_KERNEL_TOOL_EVENT_TYPES.toolApproved,
      turnId,
      operationId,
      payload: { callId: operationId, name: request.tool, approval: provenance ?? null, ...meta },
    }]);

    try {
      const execution = await this.options.registry.executeApproved(request.tool, request.arguments, context);
      await this.options.journal.append(this.options.sessionId, [{
        type: PRIME_KERNEL_TOOL_EVENT_TYPES.toolResulted,
        turnId,
        operationId,
        payload: {
          callId: operationId,
          name: request.tool,
          content: execution.content,
          isError: execution.isError ?? false,
          metadata: execution.metadata ?? null,
          ...meta,
        },
      }]);
      if (execution.isError) {
        return { seq: request.seq, ok: false, error: execution.content, metadata: execution.metadata ?? undefined };
      }
      return { seq: request.seq, ok: true, content: execution.content, metadata: execution.metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failed(operationId, request, meta, message);
      return { seq: request.seq, ok: false, error: message };
    }
  }

  private async failed(
    operationId: string,
    request: KernelBridgeCallRequest,
    meta: Readonly<{ jobId: string; seq: number; label: string | null }>,
    message: string,
  ): Promise<void> {
    await this.options.journal.append(this.options.sessionId, [{
      type: PRIME_KERNEL_TOOL_EVENT_TYPES.toolFailed,
      turnId: this.options.turnId(),
      operationId,
      payload: { callId: operationId, name: request.tool, content: message, ...meta },
    }]);
  }
}


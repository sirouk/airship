import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalPolicy,
  JsonValue,
  Tool,
  ToolContext,
  ToolDefinition,
} from "../core/contracts";
import { ToolRegistry } from "./registry";
import { compileToolInputSchema, ToolArgumentValidationError } from "./schema";

const writeDefinition: ToolDefinition = {
  name: "write_record",
  description: "Write a bounded record.",
  effect: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 128, pattern: "^[^\\u0000]+$" },
      content: { type: "string", maxLength: 1024 },
      tags: { type: "array", items: { type: "string" }, maxItems: 4, uniqueItems: true },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

describe("ToolRegistry authorization boundary", () => {
  it("validates schema before approval and fails closed on unknown keys", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const review = vi.fn(async () => "allow" as const);
    const policy: ApprovalPolicy = { review };

    await expect(registry.review(
      "write_record",
      { path: "notes/a.md", content: "safe", unexpected: true },
      context(),
      policy,
    )).rejects.toBeInstanceOf(ToolArgumentValidationError);
    expect(review).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds an approval to canonical arguments and rejects mutation", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const ctx = context();
    const argumentsValue: Record<string, JsonValue> = { path: "notes/a.md", content: "approved" };

    await expect(registry.review("write_record", argumentsValue, ctx, allow)).resolves.toBe("allow");
    argumentsValue.content = "changed after approval";
    await expect(registry.executeApproved("write_record", argumentsValue, ctx)).rejects.toThrow(
      "Approved tool arguments changed before execution.",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("snapshots review arguments and context before a gated digest yields", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const firstSignal = new AbortController().signal;
    const firstOutput = vi.fn();
    const ctx: ToolContext = {
      sessionId: "session-1",
      turnId: "turn-1",
      operationId: "operation-1",
      signal: firstSignal,
      capabilityTier: "web-baseline",
      onOutput: firstOutput,
    };
    const argumentsValue: Record<string, JsonValue> = {
      path: "notes/a.md",
      content: "approved",
      tags: ["reviewed"],
    };
    let reviewedArguments: JsonValue | undefined;
    let reviewedContext: ToolContext | undefined;
    const gate = gateNextDigest();

    try {
      const pending = registry.review("write_record", argumentsValue, ctx, {
        async review(_tool, snapshotArguments, snapshotContext) {
          reviewedArguments = snapshotArguments;
          reviewedContext = snapshotContext;
          return "allow";
        },
      });
      await gate.started;
      argumentsValue.content = "mutated while digest waited";
      (argumentsValue.tags as JsonValue[])[0] = "mutated";
      ctx.sessionId = "other-session";
      ctx.turnId = "other-turn";
      ctx.operationId = "other-operation";
      ctx.signal = new AbortController().signal;
      ctx.capabilityTier = "native";
      ctx.onOutput = vi.fn();
      gate.release();

      await expect(pending).resolves.toBe("allow");
      expect(reviewedArguments).toEqual({
        path: "notes/a.md",
        content: "approved",
        tags: ["reviewed"],
      });
      expect(reviewedArguments).not.toBe(argumentsValue);
      expect(Object.isFrozen(reviewedArguments)).toBe(true);
      expect(Object.isFrozen((reviewedArguments as Record<string, JsonValue>).tags)).toBe(true);
      expect(reviewedContext).toEqual({
        sessionId: "session-1",
        turnId: "turn-1",
        operationId: "operation-1",
        signal: firstSignal,
        capabilityTier: "web-baseline",
        onOutput: firstOutput,
      });
      expect(reviewedContext).not.toBe(ctx);
      expect(Object.isFrozen(reviewedContext)).toBe(true);
    } finally {
      gate.restore();
    }
  });

  it("executes the exact argument and context snapshots taken before a gated digest", async () => {
    let executedArguments: JsonValue | undefined;
    let executedContext: ToolContext | undefined;
    const registry = registryWith(async (snapshotArguments, snapshotContext) => {
      executedArguments = snapshotArguments;
      executedContext = snapshotContext;
      return { content: "ok" };
    });
    const firstSignal = new AbortController().signal;
    const firstOutput = vi.fn();
    const ctx: ToolContext = {
      sessionId: "session-1",
      turnId: "turn-1",
      operationId: "operation-1",
      signal: firstSignal,
      capabilityTier: "web-enhanced",
      onOutput: firstOutput,
    };
    const argumentsValue: Record<string, JsonValue> = {
      path: "notes/a.md",
      content: "approved",
      tags: ["executed"],
    };
    await registry.review("write_record", argumentsValue, ctx, allow);
    const gate = gateNextDigest();

    try {
      const pending = registry.executeApproved("write_record", argumentsValue, ctx);
      await gate.started;
      argumentsValue.content = "swapped after digest admission";
      (argumentsValue.tags as JsonValue[])[0] = "swapped";
      ctx.sessionId = "other-session";
      ctx.turnId = "other-turn";
      ctx.operationId = "other-operation";
      ctx.signal = new AbortController().signal;
      ctx.capabilityTier = "remote-heavy";
      ctx.onOutput = vi.fn();
      gate.release();

      await expect(pending).resolves.toEqual({ content: "ok" });
      expect(executedArguments).toEqual({
        path: "notes/a.md",
        content: "approved",
        tags: ["executed"],
      });
      expect(executedArguments).not.toBe(argumentsValue);
      expect(Object.isFrozen(executedArguments)).toBe(true);
      expect(Object.isFrozen((executedArguments as Record<string, JsonValue>).tags)).toBe(true);
      expect(executedContext).toEqual({
        sessionId: "session-1",
        turnId: "turn-1",
        operationId: "operation-1",
        signal: firstSignal,
        capabilityTier: "web-enhanced",
        onOutput: firstOutput,
      });
      expect(executedContext).not.toBe(ctx);
      expect(Object.isFrozen(executedContext)).toBe(true);
    } finally {
      gate.restore();
    }
  });

  it("does not invoke a tool when its approved signal aborts during the execution digest", async () => {
    const execute = vi.fn(async () => ({ content: "should not run" }));
    const registry = registryWith(execute);
    const controller = new AbortController();
    const ctx = context(controller);
    const argumentsValue = { path: "notes/a.md", content: "approved" };
    await registry.review("write_record", argumentsValue, ctx, allow);
    const gate = gateNextDigest();
    const stopped = new DOMException("Stopped during digest", "AbortError");

    try {
      const pending = registry.executeApproved("write_record", argumentsValue, ctx);
      await gate.started;
      controller.abort(stopped);
      gate.release();

      await expect(pending).rejects.toBe(stopped);
      expect(execute).not.toHaveBeenCalled();
      await expect(registry.executeApproved("write_record", argumentsValue, ctx)).rejects.toBe(stopped);
    } finally {
      gate.restore();
    }
  });

  it("does not let a different live signal spend an approval", async () => {
    const execute = vi.fn(async () => ({ content: "should not run" }));
    const registry = registryWith(execute);
    const approvedContext = context();
    const argumentsValue = { path: "notes/a.md", content: "approved" };
    await registry.review("write_record", argumentsValue, approvedContext, allow);
    const substitutedContext: ToolContext = {
      ...approvedContext,
      signal: new AbortController().signal,
    };

    await expect(registry.executeApproved(
      "write_record",
      argumentsValue,
      substitutedContext,
    )).rejects.toThrow("Tool execution is not bound to a live approval.");
    await expect(registry.executeApproved(
      "write_record",
      argumentsValue,
      approvedContext,
    )).rejects.toThrow("Tool execution is not bound to a live approval.");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects accessors and non-JSON object shapes without policy or tool invocation", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const review = vi.fn(async () => "allow" as const);
    let accessorReads = 0;
    const accessor = Object.defineProperty({ path: "notes/a.md" }, "content", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "unsafe";
      },
    });
    const sparseTags: JsonValue[] = [];
    sparseTags[1] = "tag";
    const cyclic: Record<string, unknown> = { path: "notes/a.md", content: "unsafe" };
    cyclic.self = cyclic;
    const invalidValues: unknown[] = [
      accessor,
      { path: "notes/a.md", content: "unsafe", tags: sparseTags },
      cyclic,
      new Date(),
      { path: "notes/a.md", content: undefined },
    ];

    for (const invalid of invalidValues) {
      const registry = registryWith(execute);
      await expect(registry.review(
        "write_record",
        invalid as JsonValue,
        context(),
        { review },
      )).rejects.toBeInstanceOf(TypeError);
    }
    expect(accessorReads).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsafe execution snapshots without invoking or spending the approval", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const ctx = context();
    const approved = { path: "notes/a.md", content: "safe" };
    await registry.review("write_record", approved, ctx, allow);
    let accessorReads = 0;
    const unsafe = Object.defineProperty({ path: "notes/a.md" }, "content", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "changed";
      },
    });

    await expect(registry.executeApproved("write_record", unsafe as JsonValue, ctx)).rejects.toBeInstanceOf(TypeError);
    expect(accessorReads).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    await expect(registry.executeApproved("write_record", approved, ctx)).resolves.toEqual({ content: "ok" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("accepts semantically identical object key ordering", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const ctx = context();

    await registry.review("write_record", { path: "notes/a.md", content: "same" }, ctx, allow);
    await expect(registry.executeApproved(
      "write_record",
      { content: "same", path: "notes/a.md" },
      ctx,
    )).resolves.toEqual({ content: "ok" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("consumes tickets exactly once and rejects replay", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const ctx = context();
    const argumentsValue = { path: "notes/a.md", content: "once" };

    await registry.review("write_record", argumentsValue, ctx, allow);
    await registry.executeApproved("write_record", argumentsValue, ctx);
    await expect(registry.executeApproved("write_record", argumentsValue, ctx)).rejects.toThrow(
      "Tool execution is not bound to a live approval.",
    );
    await expect(registry.review("write_record", argumentsValue, ctx, allow)).resolves.toBe("deny");
    await expect(registry.review("write_record", argumentsValue, {
      ...ctx,
      turnId: "turn-2",
    }, allow)).resolves.toBe("deny");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("binds tickets to session, turn, operation, and canonical tool name", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const approvedContext = context();
    const argumentsValue = { path: "notes/a.md", content: "bound" };
    await registry.review("write_record", argumentsValue, approvedContext, allow);

    await expect(registry.executeApproved("write_record", argumentsValue, {
      ...approvedContext,
      operationId: "another-operation",
    })).rejects.toThrow("Tool execution is not bound to a live approval.");
    await expect(registry.executeApproved("unknown_tool", argumentsValue, approvedContext)).resolves.toMatchObject({
      isError: true,
    });
    await expect(registry.executeApproved("write_record", argumentsValue, approvedContext)).resolves.toEqual({
      content: "ok",
    });
  });

  it("revalidates immediately before execution", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const ctx = context();
    const argumentsValue: Record<string, JsonValue> = { path: "notes/a.md", content: "valid" };
    await registry.review("write_record", argumentsValue, ctx, allow);
    argumentsValue.extra = "not declared";

    await expect(registry.executeApproved("write_record", argumentsValue, ctx)).rejects.toBeInstanceOf(
      ToolArgumentValidationError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("removes approvals on abort and rejects unsupported schema keywords at registration", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = registryWith(execute);
    const controller = new AbortController();
    const ctx = context(controller);
    const argumentsValue = { path: "notes/a.md", content: "abort" };
    await registry.review("write_record", argumentsValue, ctx, allow);
    const stopped = new DOMException("Stopped", "AbortError");
    controller.abort(stopped);
    // Pinned to the exact reason rather than `toBeTruthy()`, which accepted any
    // thrown value at all and so could not tell the aborted-signal short
    // circuit apart from a bind failure arriving for some other cause.
    await expect(registry.executeApproved("write_record", argumentsValue, ctx)).rejects.toBe(stopped);
    // That rejection is only the aborted signal answering for itself, and it
    // would arrive whether or not the ticket survived. The removal is the claim
    // under test: the same approval key, presented with a live signal, must
    // find nothing left to spend. A ticket that outlived its cancelled turn is
    // a decision the person made about work they then stopped.
    const revived: ToolContext = { ...ctx, signal: new AbortController().signal };
    await expect(registry.executeApproved("write_record", argumentsValue, revived)).rejects.toThrow(
      "Tool execution is not bound to a live approval.",
    );
    expect(execute).not.toHaveBeenCalled();

    const unsupported = new ToolRegistry();
    expect(() => unsupported.register({
      definition: {
        ...writeDefinition,
        name: "unsupported",
        inputSchema: { type: "string", format: "uri" },
      },
      async execute() {
        return { content: "never" };
      },
    })).toThrow("Unsupported tool schema keyword format");

    expect(() => unsupported.register({
      definition: {
        ...writeDefinition,
        name: "unsafe_pattern",
        inputSchema: { type: "string", maxLength: 128, pattern: "^(a+)+$" },
      },
      async execute() {
        return { content: "never" };
      },
    })).toThrow("linear-time subset");
  });

  it("propagates validation work exhaustion through not instead of treating it as a non-match", () => {
    const validate = compileToolInputSchema({
      type: "array",
      items: { not: false },
    });
    let failure: unknown;
    try {
      validate(Array.from({ length: 50_100 }, () => null));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ToolArgumentValidationError);
    expect((failure as ToolArgumentValidationError).issue.keyword).toBe("bounds");
  });
});

const allow: ApprovalPolicy = {
  async review() {
    return "allow";
  },
};

function registryWith(execute: Tool["execute"]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ definition: writeDefinition, execute });
  return registry;
}

function context(controller = new AbortController()): ToolContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    operationId: "operation-1",
    signal: controller.signal,
  };
}

function gateNextDigest(): {
  started: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  let announceStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, data) => {
    announceStarted();
    await blocked;
    return realDigest(algorithm, data);
  });
  return { started, release, restore: () => spy.mockRestore() };
}

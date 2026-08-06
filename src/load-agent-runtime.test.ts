import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { DurableEvent } from "./core/journal";
import { sessionRuntimeKind } from "./load-agent-runtime";

function event(type: string): { type: string } {
  return { type };
}

describe("sessionRuntimeKind", () => {
  it("classifies a fresh (empty) journal as unpinned", () => {
    expect(sessionRuntimeKind([event("session.created")])).toBe("unpinned");
  });

  it("any prime.* evidence pins the session prime", () => {
    expect(sessionRuntimeKind([event("session.created"), event("turn.requested"), event("prime.kernel.job.started")])).toBe("prime");
    expect(sessionRuntimeKind([event("prime.session.runtime.seal")])).toBe("prime");
  });

  it("journal with ordinary turn history and no prime evidence is airship-core", () => {
    expect(sessionRuntimeKind([event("session.created"), event("turn.requested"), event("inference.started")])).toBe("airship-core");
  });

  it("prime evidence beats later airship turn protocol (engine flips only via fork)", () => {
    expect(sessionRuntimeKind([event("prime.kernel.tool.requested"), event("turn.requested")])).toBe("prime");
  });
});

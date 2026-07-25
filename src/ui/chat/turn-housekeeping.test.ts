import { describe, expect, it, vi } from "vitest";
import {
  refreshCompletedTurnWorkspace,
  releaseComposerAndReloadSession,
} from "./turn-housekeeping";

describe("completed turn housekeeping", () => {
  it("returns a warning instead of rejecting a durable turn when workspace refresh fails", async () => {
    await expect(refreshCompletedTurnWorkspace(async () => {
      throw new Error("vault list temporarily unavailable");
    })).resolves.toBe("vault list temporarily unavailable");
  });

  it("releases chat before a slow session reload and absorbs reload failure", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<{ headSequence: number }>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const release = vi.fn();
    const apply = vi.fn();

    releaseComposerAndReloadSession({
      release,
      load: () => pending,
      accept: () => true,
      apply,
    });

    expect(release).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    reject(new Error("session head read unavailable"));
    await Promise.resolve();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies only an accepted background session refresh", async () => {
    const apply = vi.fn();
    releaseComposerAndReloadSession({
      release() {},
      load: async () => ({ headSequence: 7 }),
      accept: (value) => value.headSequence >= 8,
      apply,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
  });

  it("still releases chat when the session adapter throws before returning a promise", () => {
    const release = vi.fn();
    expect(() => releaseComposerAndReloadSession({
      release,
      load() { throw new Error("adapter unavailable"); },
      accept: () => true,
      apply() {},
    })).not.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });
});

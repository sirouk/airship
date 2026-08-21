import { describe, expect, it } from "vitest";
import { runTurnBeforeNaming } from "./turn-naming";

describe("turn naming admission order", () => {
  it("leaves title, head, and events unchanged when authority is replaced before admission", async () => {
    const state = { title: "General conversation", head: 1, events: [] as string[] };
    let routeCurrent = true;
    let release!: () => void;
    const namingBlocked = new Promise<void>((resolve) => { release = resolve; });

    const attempt = runTurnBeforeNaming(async () => {
      await namingBlocked;
      if (!routeCurrent) throw new Error("The exact page-memory inference route is no longer available.");
      state.events.push("turn.requested");
      state.head += 1;
      return "completed";
    }, async () => {
      state.title = "Prompt title";
      state.events.push("session.renamed");
      state.head += 1;
    });

    routeCurrent = false;
    release();
    await expect(attempt).rejects.toThrow(/exact page-memory inference route/u);
    expect(state).toEqual({ title: "General conversation", head: 1, events: [] });
  });

  it("starts presentational naming only after a completed durable turn", async () => {
    const order: string[] = [];
    await expect(runTurnBeforeNaming(async () => {
      order.push("turn.requested", "turn.completed");
      return "completed";
    }, async () => {
      order.push("session.renamed");
    })).resolves.toBe("completed");
    expect(order).toEqual(["turn.requested", "turn.completed", "session.renamed"]);
  });
});

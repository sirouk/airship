import { describe, expect, it } from "vitest";
import { InMemoryHarnessKvAdapter } from "./store";

describe("kv debug4", () => {
  it("rejected?", async () => {
    const adapter = new InMemoryHarnessKvAdapter();
    await adapter.transact([{ type: "put", key: "entry/local/memory/a", value: "one", expectedValue: null }]);
    const p = adapter.transact([{ type: "put", key: "entry/local/memory/a", value: "bad", expectedValue: "stale" }]);
    console.log("thenable?", typeof (p as unknown as Promise<unknown> | undefined)?.then);
    await p.then(
      () => console.log("resolved"),
      (e: Error) => console.log("rejected:", e.constructor.name, "::", e.message),
    );
  });
});

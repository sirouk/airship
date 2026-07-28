import { describe, expect, it } from "vitest";
import { runObjectStoreConformance } from "./conformance";
import { MemoryObjectStore } from "./memory-object-store";

describe("object-store conformance", () => {
  it("proves exact range, read-after-write, listing, and single-winner CAS", async () => {
    let tick = 0;
    const result = await runObjectStoreConformance({
      store: new MemoryObjectStore(),
      prefix: "airship-conformance",
      nonce: "fixed-run-001",
      now: () => tick++,
    });
    expect(result.capabilities).toMatchObject({
      adapter: { adapter: "memory" },
      exactRangeRead: "verified",
      conditionalCreate: "verified",
      compareAndSwap: "verified",
    });

    expect(result.prefix).toBe("airship-conformance/fixed-run-001");
    expect(result.checks.map((check) => check.name)).toEqual([
      "conditional create",
      "duplicate rejection",
      "concurrent create serialization",
      "read after write",
      "exact range read",
      "special-character key injectivity",
      "prefix list after write",
      "empty-prefix list",
      "root create",
      "stale CAS rejection",
      "missing-key CAS rejection",
      "concurrent CAS serialization",
      "winning root visibility",
    ]);
    expect(result.checks.every((check) => check.durationMs === 1)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { KIND_VISUAL } from "./kind-visual";
import { MEMORY_NODE_KINDS } from "./types";
describe("memory kind visuals", () => { it("gives every kind a unique non-color shape", () => { expect(Object.keys(KIND_VISUAL).sort()).toEqual([...MEMORY_NODE_KINDS].sort()); expect(new Set(Object.values(KIND_VISUAL).map((item) => item.shape)).size).toBe(6); }); });

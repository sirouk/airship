import { describe, expect, it } from "vitest";
import { nextModelIndex, visibleModelCount } from "./model-picker";
describe("ModelPicker bounds", () => {
  it("renders at most thirty rows before explicit expansion", () => { expect(visibleModelCount(150, false)).toBe(30); expect(visibleModelCount(150, true)).toBe(150); });
  it("wraps keyboard option navigation", () => { expect(nextModelIndex(4, 3, 1)).toBe(0); expect(nextModelIndex(4, 0, -1)).toBe(3); });
});

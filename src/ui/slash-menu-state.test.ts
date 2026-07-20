import { describe, expect, it } from "vitest";
import {
  enabledSlashSelection,
  firstEnabledSlashIndex,
  moveSlashSelection,
} from "./slash-menu-state";

describe("slash menu keyboard state", () => {
  const options = [
    { disabledReason: "Unavailable" },
    {},
    { disabledReason: "Unavailable" },
    {},
  ] as const;

  it("starts on and returns only enabled options", () => {
    expect(firstEnabledSlashIndex(options)).toBe(1);
    expect(enabledSlashSelection(options, 1)).toBe(options[1]);
    expect(enabledSlashSelection(options, 0)).toBeUndefined();
  });

  it("wraps in both directions while skipping disabled options", () => {
    expect(moveSlashSelection(options, 1, 1)).toBe(3);
    expect(moveSlashSelection(options, 3, 1)).toBe(1);
    expect(moveSlashSelection(options, 1, -1)).toBe(3);
  });

  it("stays closed when every result is disabled", () => {
    const disabled = [{ disabledReason: "No" }, { disabledReason: "No" }];
    expect(firstEnabledSlashIndex(disabled)).toBe(-1);
    expect(moveSlashSelection(disabled, 0, 1)).toBe(-1);
  });
});

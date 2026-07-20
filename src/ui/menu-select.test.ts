import { describe, expect, it } from "vitest";
import { moveMenuSelection } from "./menu-select";

describe("menu selection keyboard movement", () => {
  const options = [{ disabled: false }, { disabled: true }, { disabled: false }];

  it("wraps with arrow keys and skips disabled options", () => {
    expect(moveMenuSelection(0, "ArrowDown", options)).toBe(2);
    expect(moveMenuSelection(2, "ArrowDown", options)).toBe(0);
    expect(moveMenuSelection(0, "ArrowUp", options)).toBe(2);
  });

  it("moves to enabled boundaries with Home and End", () => {
    expect(moveMenuSelection(2, "Home", options)).toBe(0);
    expect(moveMenuSelection(0, "End", options)).toBe(2);
  });
});

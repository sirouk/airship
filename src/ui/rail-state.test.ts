import { describe, expect, it } from "vitest";
import {
  defaultRailState,
  isRailToggleChord,
  loadRailPreference,
  RAIL_PREFERENCE_STORAGE_KEY,
  railBand,
  resolveRailState,
  saveRailPreference,
  toggledRailState,
  withRailState,
} from "./rail-state";

function chord(key: string, modifiers: Partial<Readonly<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>> = {}) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

describe("rail bands", () => {
  it("splits at the width where the designed rail, measure and inspector stop fitting", () => {
    expect(railBand(1_440)).toBe("wide");
    expect(railBand(1_362)).toBe("wide");
    expect(railBand(1_361)).toBe("narrow");
    expect(railBand(834)).toBe("narrow");
  });
});

describe("the viewport-derived default", () => {
  it("gives a wide fine-pointer desktop the labelled rail", () => {
    expect(defaultRailState({ width: 1_440, hoverCapable: true })).toBe("standard");
  });

  it("collapses a narrow fine-pointer window, where a tooltip can still be read", () => {
    expect(defaultRailState({ width: 1_280, hoverCapable: true })).toBe("rail");
    expect(defaultRailState({ width: 1_024, hoverCapable: true })).toBe("rail");
  });

  it("keeps labels on a touch tablet, which has no hover to reveal them with", () => {
    expect(defaultRailState({ width: 1_024, hoverCapable: false })).toBe("standard");
    expect(defaultRailState({ width: 861, hoverCapable: false })).toBe("standard");
  });

  it("still collapses a touch viewport too narrow for a 232px rail", () => {
    expect(defaultRailState({ width: 860, hoverCapable: false })).toBe("rail");
  });
});

describe("the remembered choice", () => {
  it("beats the viewport default for the band it was made in", () => {
    const preference = withRailState({}, "narrow", "standard");
    expect(resolveRailState(preference, { width: 1_280, hoverCapable: true })).toBe("standard");
    // A choice made on a laptop says nothing about an external display.
    expect(resolveRailState(preference, { width: 1_920, hoverCapable: true })).toBe("standard");
    expect(resolveRailState(withRailState({}, "wide", "rail"), { width: 1_920, hoverCapable: true })).toBe("rail");
    expect(resolveRailState(withRailState({}, "wide", "rail"), { width: 1_280, hoverCapable: true })).toBe("rail");
  });

  it("keeps the two bands independent", () => {
    const preference = withRailState(withRailState({}, "wide", "rail"), "narrow", "standard");
    expect(resolveRailState(preference, { width: 1_440, hoverCapable: true })).toBe("rail");
    expect(resolveRailState(preference, { width: 1_024, hoverCapable: true })).toBe("standard");
  });

  it("toggles between the two states a person can navigate with", () => {
    expect(toggledRailState("standard")).toBe("rail");
    expect(toggledRailState("rail")).toBe("standard");
    // Leaving focus returns to the labelled rail rather than the icon one:
    // focus is entered to hide chrome, and exiting it is a request for chrome.
    expect(toggledRailState("focus")).toBe("standard");
  });
});

describe("persistence", () => {
  function memoryStorage() {
    const entries = new Map<string, string>();
    return {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      entries,
    };
  }

  it("round-trips both bands", () => {
    const storage = memoryStorage();
    saveRailPreference({ wide: "rail", narrow: "standard" }, storage);
    expect(loadRailPreference(storage)).toEqual({ wide: "rail", narrow: "standard" });
  });

  it("drops unknown states rather than painting an unreachable rail", () => {
    const storage = memoryStorage();
    storage.setItem(RAIL_PREFERENCE_STORAGE_KEY, JSON.stringify({ wide: "hidden", narrow: "rail" }));
    expect(loadRailPreference(storage)).toEqual({ narrow: "rail" });
  });

  it("survives a corrupt entry with no preference at all", () => {
    const storage = memoryStorage();
    storage.setItem(RAIL_PREFERENCE_STORAGE_KEY, "{not json");
    expect(loadRailPreference(storage)).toEqual({});
    expect(loadRailPreference(undefined)).toEqual({});
  });
});

describe("the collapse chord", () => {
  it("is Meta or Ctrl and backslash, and nothing else", () => {
    expect(isRailToggleChord(chord("\\", { metaKey: true }))).toBe(true);
    expect(isRailToggleChord(chord("\\", { ctrlKey: true }))).toBe(true);
    expect(isRailToggleChord(chord("\\"))).toBe(false);
    expect(isRailToggleChord(chord("\\", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isRailToggleChord(chord("\\", { metaKey: true, altKey: true }))).toBe(false);
    expect(isRailToggleChord(chord("k", { metaKey: true }))).toBe(false);
  });
});

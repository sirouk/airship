import { describe, expect, it } from "vitest";
import { LOCAL_FOLDER_MAX_ENTRIES, LocalFolderAccessError } from "../workspace/local-folder";
import {
  LOCAL_FOLDER_BOUNDS_NOTE,
  LOCAL_FOLDER_FACT_ROWS,
  LOCAL_FOLDER_FORGET_NOTE,
  LOCAL_FOLDER_TIER,
  localFolderAttachedSummary,
  localFolderFailureNotice,
} from "./local-folder-panel";
import { PROVIDER_FACT_ROWS } from "./vault-view";

describe("the folder tier's wording", () => {
  /*
   * The tier has to be readable against the destinations on #vault. Same
   * questions, same order, same words for the questions — otherwise a person
   * comparing "Local Device" with "Folder on this device" is comparing two
   * tables, not two answers.
   */
  it("answers the same six questions the Vault destinations answer, in the same order", () => {
    expect(LOCAL_FOLDER_FACT_ROWS.map(([key, label]) => [key, label]))
      .toEqual(PROVIDER_FACT_ROWS.map(([key, label]) => [key, label]));
    for (const [key] of LOCAL_FOLDER_FACT_ROWS) {
      expect(LOCAL_FOLDER_TIER.facts[key], key).toMatch(/\S/u);
    }
  });

  it("states the tier's promise as a promise, not as an implementation detail", () => {
    expect(LOCAL_FOLDER_TIER.note).toContain("This device, this browser, revocable");
    expect(LOCAL_FOLDER_TIER.note).toContain("copies the folder nowhere");
    // Named because it is the one door an indexed workspace still has into the
    // Vault: an explicit context publication uploads chunked file text.
    expect(LOCAL_FOLDER_TIER.note).toContain("not added to the searchable index");
    expect(LOCAL_FOLDER_TIER.facts.keep).toContain("Airship keeps no copy");
  });

  it("says that an agent write into a folder is still an approved write", () => {
    const summary = localFolderAttachedSummary("airship", "/workspace/local/airship");
    expect(summary).toContain("“airship” is open at /workspace/local/airship.");
    expect(summary).toContain("Every agent write still goes through approvals");
  });

  it("says what forgetting does and, exactly, what it does not do", () => {
    expect(LOCAL_FOLDER_FORGET_NOTE).toContain("Nothing on your device is deleted or moved");
  });

  it("prints the listing bound it actually enforces", () => {
    expect(LOCAL_FOLDER_BOUNDS_NOTE).toContain(LOCAL_FOLDER_MAX_ENTRIES.toLocaleString("en-US"));
    expect(LOCAL_FOLDER_BOUNDS_NOTE).toContain("refused rather than shown in part");
  });

  it("carries the port's own sentence forward rather than inventing one", () => {
    const refusal = new LocalFolderAccessError("permission-required", "Airship needs your permission again.");
    expect(localFolderFailureNotice(refusal)).toBe("Airship needs your permission again.");
    expect(localFolderFailureNotice(new Error("disk went away"))).toBe("Airship could not complete that: disk went away");
    expect(localFolderFailureNotice("nope")).toMatch(/the browser gave no reason/u);
  });
});

import { readFileSync } from "node:fs";
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
    expect(LOCAL_FOLDER_TIER.note).toContain("stores no copy of the folder");
    // Named because it is the one door an indexed workspace still has into the
    // Vault: an explicit context publication uploads chunked file text.
    expect(LOCAL_FOLDER_TIER.note).toContain("not added to the searchable index");
    expect(LOCAL_FOLDER_TIER.facts.keep).toContain("Airship stores no copy of it");
  });

  /*
   * The fourth door.
   *
   * Measured: a token placed in a folder file, never typed, read once by the
   * agent, came out in the clear inside an exported readable bundle — because
   * the conversation journal holds tool results, and the three fences this
   * tier named (the Vault, Airship's Git, this device) do not cover it.
   *
   * The tool payload is not fenced: it is the provenance that makes a
   * conversation auditable, and hiding it would make every transcript a claim
   * nobody could check. What was wrong was the sentence. So the promise now
   * says precisely what is not copied — the folder — and says that a file the
   * agent reads becomes part of the conversation, which a bundle carries.
   */
  it("does not promise that a file the agent reads stays out of the conversation", () => {
    const claims = [LOCAL_FOLDER_TIER.note, LOCAL_FOLDER_TIER.facts.keep].join(" ");
    // The old, unkeepable wording, in both places it was written.
    expect(claims).not.toContain("copies the folder nowhere");
    expect(claims).not.toContain("Airship keeps no copy");
    expect(claims).not.toMatch(/Everything\b/u);
    // What is actually true, said in both directions.
    expect(LOCAL_FOLDER_TIER.note).toContain("becomes part of that conversation");
    expect(LOCAL_FOLDER_TIER.note).toContain("bundle");
    expect(LOCAL_FOLDER_TIER.facts.keep).toContain("in that conversation");
    expect(localFolderAttachedSummary("airship", "/workspace/local/airship"))
      .toContain("A file read from here becomes part of that conversation.");
  });

  it("says that an agent write into a folder is still an approved write", () => {
    const summary = localFolderAttachedSummary("airship", "/workspace/local/airship");
    expect(summary).toContain("“airship” is open at /workspace/local/airship for this profile only.");
    expect(summary).toContain("Every agent write still goes through approvals");
    // Wording matches behaviour: the mode fence and the Terminal fence are real.
    expect(summary).toContain("reviewed in every approval mode");
    expect(summary).toContain("The Terminal does not carry it at all.");
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

/*
 * The panel's own source, because the defect this describes is structural.
 *
 * There is no DOM in this suite, so the rendered tree cannot be walked here —
 * `e2e/local-folder.spec.ts` walks it with `innerText` and with
 * `expectNothingHiddenFromView`. What can be pinned here is the shape that made
 * the defect possible: a `<details>` that nothing opens, and a live region that
 * nothing renders.
 */
describe("the folder tier's panel is not a disclosure", () => {
  const source = readFileSync(new URL("./local-folder-panel.tsx", import.meta.url), "utf8");
  /*
   * Comments are prose about the defect and name the very markup the assertions
   * below refuse, so they are removed before anything is matched. Otherwise the
   * paragraph explaining why there is no `<details>` is what fails the test.
   */
  const code = source.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  const render = code.slice(code.indexOf("export function LocalFolderPanel"));

  it("renders no <details>, so nothing it says can be closed on load", () => {
    /*
     * Measured before this landed, on the built tree at 390×664: the panel's
     * `innerText` was "Folder on this device / None open / Open a folder…" — 46
     * characters — and its `textContent` was 1,041. The mount path, "Every
     * agent write still goes through approvals", "The Terminal does not carry
     * it at all" and all six comparison answers were in the second number and
     * not the first, in every state, including after a real directory was
     * attached.
     */
    expect(render).not.toContain("<details");
    expect(render).not.toContain("<summary");
  });

  it("renders exactly one live region, and it is the sentence on screen", () => {
    // The panel used to hold `const live = useRef<string>("")`, assign it on
    // attach and on forget, and render it nowhere — so both events were silent.
    expect(render).not.toContain("useRef");
    expect(code).not.toContain("live.current");
    expect(render.match(/role="status"/gu)).toHaveLength(1);
    expect(render).toContain('<p class="local-folder__status" role="status" aria-live="polite">');
  });

  it("prints the terms before a folder can be attached, not after", () => {
    /*
     * `Open a folder…` sets the state that renders the terms; the picker is
     * opened by the second button, which is a user gesture of its own. A single
     * press that reaches `openLocalFolder` would put the promise after the
     * directory handle, which is where the disclosure had it.
     */
    expect(render).toContain("const terms = deciding || state.kind !== \"absent\";");
    expect(render).toContain("onClick={() => setDeciding(true)}");
    expect(render).toContain(">Open a folder…</button>");
    expect(render).toContain("data-local-folder-open onClick={pick}>Choose a folder…</button>");
    const terms = render.slice(render.indexOf("{terms ? <>"));
    expect(terms).toContain("{LOCAL_FOLDER_TIER.note}");
    expect(terms).toContain("LOCAL_FOLDER_FACT_ROWS.map");
    expect(terms).toContain("LOCAL_FOLDER_BOUNDS_NOTE");
    expect(terms).toContain("LOCAL_FOLDER_FORGET_NOTE");
    // Attached and blocked are `state.kind !== "absent"`, so an attached folder
    // carries every one of them for as long as it is attached.
    expect(render).not.toContain("deciding && ");
  });

  it("bounds the terms on a phone by height, never by hiding words", () => {
    const css = readFileSync(new URL("./editor-view.css", import.meta.url), "utf8");
    const band = css.slice(css.indexOf(".local-folder__terms {"));
    expect(band).toContain("max-height: 20vh");
    expect(band).toContain("overflow-y: auto");
    // `display: none` and `visibility: hidden` are how text stops being text.
    expect(band.slice(0, band.indexOf("}"))).not.toContain("display: none");
  });
});

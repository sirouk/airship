import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enforcedMemoryScope } from "../profiles/domain";
import {
  PROFILE_APPROVAL_LABELS,
  PROFILE_BOUNDARY_NOTE,
  PROFILE_MEMORY_SCOPE_LABELS,
  profileGovernanceCellLabel,
  profileGovernanceCells,
  type ProfileGovernanceInput,
} from "./profiles-governance";

function input(overrides: Partial<ProfileGovernanceInput> = {}): ProfileGovernanceInput {
  return {
    systemPromptLength: 419,
    themeName: "Foundry",
    memoryScope: "profile",
    approvalMode: "ask-first",
    skillCount: 3,
    ...overrides,
  };
}

describe("profileGovernanceCells", () => {
  it("makes all five governed things legible with zero clicks", () => {
    expect(profileGovernanceCells(input()).map((cell) => `${cell.label} ${cell.value}`)).toEqual([
      "Instructions 419 ch",
      "Theme Foundry",
      "Memory This profile",
      "Approvals Ask First",
      "Skills 3",
    ]);
  });

  it("never prints a raw enum where the editor prints a sentence", () => {
    const cells = profileGovernanceCells(input({ memoryScope: "session" }));
    const values = cells.map((cell) => cell.value);
    expect(values).toContain("This conversation");
    for (const value of values) expect(value).not.toMatch(/[a-z]+-[a-z]+/u);
  });

  /*
   * The strip used to label a stored `workspace` scope "Shared workspace" — a
   * boundary no reader enforces, since `enforcedMemoryScope` resolves it to
   * `profile`. Rendering it was a claim about the silo that was simply false.
   */
  it("cannot label a memory scope the runtime does not enforce", () => {
    expect(Object.keys(PROFILE_MEMORY_SCOPE_LABELS)).toEqual(["session", "profile"]);
    expect(Object.values(PROFILE_MEMORY_SCOPE_LABELS)).not.toContain("Shared workspace");
    // Untypeable, not merely unrendered: the withdrawn member cannot reach the
    // strip at all, so no future caller can reintroduce the false label by
    // forwarding a raw stored scope. @ts-expect-error fails the build if this
    // ever starts compiling again.
    // @ts-expect-error the withdrawn scope is not a member of the input type
    const withdrawn: ProfileGovernanceInput = { ...input(), memoryScope: "workspace" };
    expect(withdrawn.memoryScope).toBe("workspace");
    // And `enforcedMemoryScope` is the only door in, so a stored revision still
    // has exactly one legible answer.
    expect(PROFILE_MEMORY_SCOPE_LABELS[enforcedMemoryScope("workspace") as "profile"]).toBe("This profile");
  });

  it("keeps the three approval labels in the Title Case eight e2e assertions pin", () => {
    for (const [mode, label] of [["ask-first", "Ask First"], ["auto-approve", "Auto Approve"], ["full-access", "Full Access"]] as const) {
      const cell = profileGovernanceCells(input({ approvalMode: mode })).find((item) => item.key === "approvals");
      expect(cell?.value).toBe(label);
    }
  });

  it("gives the skill count somewhere to go", () => {
    const cell = profileGovernanceCells(input()).find((item) => item.key === "skills");
    expect(cell?.link).toBe("#skills");
  });

  it("returns frozen records so a caller cannot re-word a field name in place", () => {
    const cells = profileGovernanceCells(input());
    expect(Object.isFrozen(cells)).toBe(true);
    expect(Object.isFrozen(cells[0])).toBe(true);
  });
});

describe("profileGovernanceCellLabel", () => {
  it("says the field, its value and what opening it does", () => {
    const cell = profileGovernanceCells(input())[2]!;
    expect(profileGovernanceCellLabel(cell)).toBe("Memory: This profile. Choose how far this profile's memory reaches.");
  });
});

describe("PROFILE_BOUNDARY_NOTE", () => {
  it("no longer points below itself at a control that is above it", () => {
    expect(PROFILE_BOUNDARY_NOTE).not.toContain("below");
    expect(PROFILE_BOUNDARY_NOTE).toContain("copied into each new conversation");
    expect(PROFILE_BOUNDARY_NOTE).toContain("keep their original pin");
  });

  it("calls the Chat thread a conversation in both of its two sentences", () => {
    /*
     * docs/CANON.md splits the nouns: "Conversation — the user-facing thread
     * shown under Chat" and "Session — a pinned runtime identity, manifest,
     * journal, and receipt chain". This note used both for one object in
     * consecutive sentences, inside the module whose stated purpose is that a
     * value has one name at rest and the same name while you change it. A
     * newcomer reading it cannot tell whether a session is a second thing they
     * also have.
     */
    expect(PROFILE_BOUNDARY_NOTE).not.toMatch(/session/iu);
    for (const cell of profileGovernanceCells(input())) {
      expect(`${cell.label} ${cell.value} ${cell.detail}`, `${cell.key} names the thread once`)
        .not.toMatch(/session/iu);
    }
  });
});

/**
 * The label maps against the editor that is supposed to share them.
 *
 * The module's whole claim is "every label here is the label the *editor* uses,
 * so a value has one name at rest and the same name while you change it". While
 * the profile editor lives inline in `app.tsx` and spells its option labels by
 * hand, that claim was asserted in a docblock and enforced by nothing: the maps
 * had no production reader, so either side could be re-worded and only the
 * screen would disagree. Reading the editor's own source is how the claim
 * becomes a contract — the same technique `model-control.test.ts` and
 * `vault-provider-feasibility.test.ts` use for the other values app.tsx spells.
 */
describe("the editor's own labels", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

  /** The `value → label` pairs of one `MenuSelect` in the profile editor. */
  function editorOptions(ariaLabel: string): Record<string, string> {
    const control = app.indexOf(`ariaLabel="${ariaLabel}"`);
    expect(control, `the profile editor no longer renders a MenuSelect named "${ariaLabel}"`).toBeGreaterThan(-1);
    const open = app.indexOf("options={[", control);
    const block = app.slice(open, app.indexOf("]}", open));
    // Tolerant of an option written across several lines. The first spelling
    // demanded `{ value: "x", label: "y"` on one line, so the moment an option
    // grew a computed description it stopped being seen at all — and a parser
    // that silently skips an option cannot enforce "the editor spells what this
    // module spells" for the option most likely to have just changed.
    const pairs = [...block.matchAll(/value:\s*"([^"]+)",\s*label:\s*"([^"]+)"/gu)];
    expect(pairs.length, `no option literals found for "${ariaLabel}"`).toBeGreaterThan(0);
    return Object.fromEntries(pairs.map(([, value, label]) => [value, label]));
  }

  it("spells the memory scopes exactly as this module labels them, and offers no third", () => {
    // Also the guard against the withdrawn silo coming back through the editor:
    // `workspace` is untypeable here, so if the select reintroduced it the map
    // could not name it and this equality is the thing that notices.
    expect(editorOptions("Profile memory scope")).toEqual({ ...PROFILE_MEMORY_SCOPE_LABELS });
  });

  it("spells the approval modes exactly as this module labels them", () => {
    expect(editorOptions("Profile approval policy")).toEqual({ ...PROFILE_APPROVAL_LABELS });
  });

});

/**
 * The theme card's captions, un-clamped.
 *
 * The rules are asserted against `routes.css` rather than against a sheet named
 * after this module, and that used to be a finding: `profiles-governance.css`
 * was imported only by `profiles-governance.tsx`, whose `ProfileGovernanceStrip`
 * had no caller — `app.tsx` imports the label module beside it (the `.ts`, which
 * is very much alive) and renders its own strip inline from `routes.css`'s
 * vocabulary. Nothing in that sheet reached the bundle, so a fix written there
 * would have passed every test and shipped nothing.
 *
 * Both files are now deleted, along with the one fragment of them that did
 * ship: `shell.css` carried `profile-governs__cell small` in its shared eyebrow
 * list, which was the sole `profile-governs` selector in `dist/assets/*.css`
 * and matched only the `<small>` inside the component that no longer exists.
 * The name is now pinned in `dead-selector-contract.test.ts` so it cannot
 * return as a rule for an element nothing renders. `routes.css` is therefore
 * not a second-best target here — it is the only sheet this surface has ever
 * been drawn from.
 *
 * A theme card carries a swatch and two `<small>`s: `theme.description`, which
 * is the only place the card says what the theme IS, and the presentation
 * summary, which names the typography and layout that activation will change
 * and that a 32×43 swatch cannot show. Both were held to `-webkit-line-clamp:2`
 * in `routes.css` and to `1` below 861px — a count of lines standing in for a
 * height budget this surface does not have.
 *
 * Measured on the shipped build. At laptop-1024 the library is three columns of
 * 123px and a caption at that width is three lines: 26 of the 27 captions on
 * the route read clientHeight 32 against scrollHeight 47, one 32 against 63,
 * every one cut at the end of line two. At tablet-768 the library is a single
 * column and the clamp drops to one line, so a full-width 307px card showed
 * 16px of 32 — "Curated · warm cocoa surfaces with a", and the rest of the
 * sentence was nowhere. The three phone widths showed the same single line, 17
 * of 34, across 26 captions. desktop-1440 still cut two.
 *
 * The clamp is arbitrary in both directions and provably so: it clips hardest
 * at 768, where the card is at its WIDEST and there is the most room to print
 * the sentence. Re-measured after: no caption on the route is short of its own
 * content at any of the eight device classes.
 */
describe("the theme card's captions", () => {
  const routes = readFileSync(new URL("./routes.css", import.meta.url), "utf8");

  it("lets the card be the size of the sentence that tells them apart", () => {
    const bodies = [...routes.matchAll(/\.theme-option small \{([^}]*)\}/gu)].map(([, body]) => body);
    // The caption's own rule is the one that lays it out as a `-webkit-box`;
    // the other spellings of this selector set `display:block` and the clamp.
    const caption = bodies.find((body) => body.includes("-webkit-box-orient")) ?? "";
    expect(caption).toContain("-webkit-line-clamp: none");
    expect(caption).toContain("overflow: visible");
    // And no breakpoint may re-impose one. The 861px block clamped to a single
    // line at exactly the width where the library becomes one column, so the
    // caption was cut hardest on the widest card the route ever draws.
    for (const body of bodies) {
      expect(body).not.toMatch(/-webkit-line-clamp:\s*\d/u);
      expect(body).not.toMatch(/overflow:\s*hidden/u);
      expect(body).not.toMatch(/max-height/u);
    }
  });

  /*
   * And the cap this deliberately does NOT remove. `.profile-prompt-preview`
   * clamps the profile's system prompt to two lines and measured 35px of 123 at
   * tablet-768 — a bounded box that earns its bound. It is the summary OF a
   * disclosure: `.profile-editor-disclosure[open]` hides it and the full prompt
   * appears in the textarea underneath, the clamp paints a real ellipsis rather
   * than ending mid-word, and the summary carries a `›` marker that says where
   * the rest is. A preview grown to 230px of prompt would stop being a preview.
   *
   * The distinction is the one this cluster turns on: a cap that hides content
   * with no way to reach it is a defect; a cap that summarises content with the
   * way to the rest attached is a summary. So the preview must keep both halves
   * of what makes it the second thing.
   */
  it("keeps the prompt preview a summary, with the way to the rest attached", () => {
    const routes = readFileSync(new URL("./routes.css", import.meta.url), "utf8");
    const previewStart = routes.indexOf(".profile-prompt-preview {");
    expect(previewStart).toBeGreaterThan(-1);
    expect(routes.slice(previewStart, routes.indexOf("}", previewStart))).toContain("-webkit-line-clamp: 2");
    // The withdrawal is what turns the clamp into a summary rather than a cut.
    expect(routes).toContain(".profile-editor-disclosure[open] .profile-prompt-preview { display: none; }");
    const editor = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    expect(editor).toContain('<span class="profile-prompt-preview" aria-hidden="true">{draft.systemPrompt.trim() || "No instructions set"}</span>');
    expect(editor).toContain("<textarea rows={7} value={draft.systemPrompt}");
  });
});

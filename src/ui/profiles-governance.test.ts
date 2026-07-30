import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY } from "../inference/chutes/strict-proof-capability";
import { enforcedMemoryScope } from "../profiles/domain";
import {
  PROFILE_APPROVAL_LABELS,
  PROFILE_BOUNDARY_NOTE,
  PROFILE_MEMORY_SCOPE_LABELS,
  PROFILE_POSTURE_FIELD_LABEL,
  PROFILE_POSTURE_LABELS,
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
    minimumPosture: "local",
    skillCount: 3,
    ...overrides,
  };
}

describe("profileGovernanceCells", () => {
  it("makes all six governed things legible with zero clicks", () => {
    expect(profileGovernanceCells(input()).map((cell) => `${cell.label} ${cell.value}`)).toEqual([
      "Instructions 419 ch",
      "Theme Foundry",
      "Memory This profile",
      "Approvals Ask First",
      "Minimum proof Local",
      "Skills 3",
    ]);
  });

  it("never prints a raw enum where the editor prints a sentence", () => {
    const cells = profileGovernanceCells(input({ memoryScope: "session", minimumPosture: "encrypted-attested" }));
    const values = cells.map((cell) => cell.value);
    expect(values).toContain("This conversation");
    expect(values).toContain("Attested");
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

  it("gives the minimum-proof field exactly one name", () => {
    const cell = profileGovernanceCells(input()).find((item) => item.key === "proof");
    expect(cell?.label).toBe(PROFILE_POSTURE_FIELD_LABEL);
    expect(PROFILE_POSTURE_FIELD_LABEL).toBe("Minimum proof");
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

  it("spells the postures exactly as this module labels them", () => {
    expect(editorOptions("Profile minimum proof posture")).toEqual({ ...PROFILE_POSTURE_LABELS });
  });

  /*
   * A floor nothing can reach may be offered, but not sold.
   *
   * `encrypted-attested` needs a transport built with `attestationMode:
   * "required"`, which only exists behind strict endpoint proof — and this
   * build freezes that capability `available: false`. The editor still
   * advertised "Attested — Require verified endpoint evidence" as a live
   * choice, so picking it committed a profile that threw on every new
   * conversation, while the Connection route told the same person in the same
   * session that strict fail-closed is unavailable.
   *
   * This asserts the editor asks the shared record rather than restating an
   * answer, which is what stops the two surfaces drifting apart again. It is
   * deliberately written against the capability being unavailable *today*: if
   * the verifier lands and `available` flips, this test is the thing that says
   * the option's description must go back to describing the policy.
   */
  it("does not offer a proof floor this build cannot satisfy", () => {
    expect(CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available, "strict proof became available — re-word the Attested option and this test").toBe(false);
    const control = app.indexOf('ariaLabel="Profile minimum proof posture"');
    const block = app.slice(control, app.indexOf("]}", app.indexOf("options={[", control)));
    const attested = block.slice(block.indexOf('value: "encrypted-attested"'));
    expect(attested).toContain("disabled: !strictProofCapability.available");
    expect(attested).toContain("strictProofCapability.reason");
    // The reason has to be the verifier's own words, not a second copy of them.
    expect(attested).not.toContain("Independent NVIDIA GPU verification");
  });

  it("names the minimum-proof field once, in the editor, the card and the revision strip", () => {
    // Three renderings under two names inside 400px was the original defect;
    // this is the assertion that keeps all three spelling it the same way.
    expect(app).toContain(`<span>${PROFILE_POSTURE_FIELD_LABEL}</span><MenuSelect ariaLabel="Profile minimum proof posture"`);
    // Both chips read the name from this module's constant, so the three
    // surfaces cannot be edited apart — stronger than counting two literals
    // that happen to match today.
    expect(app.match(/prefix=\{PROFILE_POSTURE_FIELD_LABEL\}/gu)).toHaveLength(2);
    expect(app).not.toContain(`prefix="${PROFILE_POSTURE_FIELD_LABEL}"`);
    expect(app).not.toContain("Minimum posture");
  });
});

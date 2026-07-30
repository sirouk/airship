import type { SecurityPosture } from "../core/contracts";
import type { ProfileMemoryScope } from "../profiles/domain";

/**
 * What a profile actually governs, in one vocabulary.
 *
 * The profile editor is four `<details>` disclosures, and collapsed it reveals
 * "419 characters", "Foundry" and "profile memory · Ask First". A person cannot
 * answer "what does this profile change?" without opening all four. Worse, one
 * field had three renderings under two names inside 400px — the catalog card
 * said *Minimum posture*, the select said *Minimum proof*, and the revision
 * strip said *Minimum proof* again 60px below the select — and the boundary
 * summary printed the raw enum `profile memory` while the select inside it
 * printed the friendly `This profile`.
 *
 * This module is the single answer to "what is this value called, and what does
 * it read as". Every label here is the label the *editor* uses, so a value has
 * one name at rest and the same name while you change it.
 */

export type ProfileGovernanceCellKey =
  | "instructions"
  | "theme"
  | "memory"
  | "approvals"
  | "proof"
  | "skills";

export type ProfileGovernanceCell = Readonly<{
  key: ProfileGovernanceCellKey;
  /** The field's one name. Identical to its editor's label. */
  label: string;
  /** The current value, in the editor's own words — never a raw enum. */
  value: string;
  /** What opening this cell does, said by the control that opens it. */
  detail: string;
  /**
   * A route hash for cells that are owned elsewhere. `Skills 3` was a dead
   * number with no path to the tab that owns it.
   */
  link?: string;
}>;

/**
 * The memory scope names, taken verbatim from the select that sets them.
 *
 * Two, not three. `workspace` carried the label "Shared workspace", which named
 * a widening no reader implements: every read of memory.json narrows on the
 * pinned profile ID, so `enforcedMemoryScope` resolves a stored `workspace` to
 * the `profile` it has always behaved as, and the editor no longer offers it.
 * A label for it could therefore only print a boundary the runtime does not
 * enforce — the same defect as printing a raw enum, from the other side.
 *
 * Keying `ProfileGovernanceInput["memoryScope"]` off this map is the guard: the
 * withdrawn member is not merely unrendered, it is untypeable, so a caller
 * holding a stored revision has to pass it through `enforcedMemoryScope` before
 * this module will label it. `Exclude` is stated against the domain enum so
 * that widening the silo for real fails to compile here rather than silently
 * shipping an unlabelled scope.
 */
export const PROFILE_MEMORY_SCOPE_LABELS = Object.freeze({
  session: "This conversation",
  profile: "This profile",
} as const satisfies Readonly<Record<Exclude<ProfileMemoryScope, "workspace">, string>>);

/** Title Case verbatim: eight shipped e2e assertions pin these three strings. */
export const PROFILE_APPROVAL_LABELS = Object.freeze({
  "ask-first": "Ask First",
  "auto-approve": "Auto Approve",
  "full-access": "Full Access",
} as const);

/** The minimum-proof names, taken verbatim from the select that sets them. */
export const PROFILE_POSTURE_LABELS: Readonly<Record<SecurityPosture, string>> = Object.freeze({
  local: "Local",
  "plaintext-remote": "Remote",
  "encrypted-unattested": "Encrypted",
  "encrypted-attested": "Attested",
});

/** The one name this field has, on the card, in the strip and in the editor. */
export const PROFILE_POSTURE_FIELD_LABEL = "Minimum proof";

/**
 * The boundary note, with the false direction removed.
 *
 * It read "including the minimum proof posture below" while the select it
 * pointed at was above it. The clause said nothing the sentence needed, so the
 * fix is a deletion rather than a re-aim.
 */
export const PROFILE_BOUNDARY_NOTE =
  "These settings are copied into each new session. Existing conversations keep their original pin.";

export type ProfileGovernanceInput = Readonly<{
  systemPromptLength: number;
  themeName: string;
  memoryScope: keyof typeof PROFILE_MEMORY_SCOPE_LABELS;
  approvalMode: keyof typeof PROFILE_APPROVAL_LABELS;
  minimumPosture: SecurityPosture;
  skillCount: number;
}>;

/**
 * The six things a profile governs, each legible with zero clicks.
 *
 * Order is the order a person asks about them: what it says, what it looks
 * like, what it remembers, what it may do without asking, what it refuses to
 * run on, and what tools it resolves.
 */
export function profileGovernanceCells(input: ProfileGovernanceInput): readonly ProfileGovernanceCell[] {
  return Object.freeze([
    Object.freeze({
      key: "instructions",
      label: "Instructions",
      value: `${input.systemPromptLength.toLocaleString()} ch`,
      detail: "Edit the system instructions this profile pins into every new session.",
    }),
    Object.freeze({
      key: "theme",
      label: "Theme",
      value: input.themeName,
      detail: "Choose the interface theme this profile applies.",
    }),
    Object.freeze({
      key: "memory",
      label: "Memory",
      value: PROFILE_MEMORY_SCOPE_LABELS[input.memoryScope],
      detail: "Choose how far this profile's memory reaches.",
    }),
    Object.freeze({
      key: "approvals",
      label: "Approvals",
      value: PROFILE_APPROVAL_LABELS[input.approvalMode],
      detail: "Choose what this profile may do before it asks.",
    }),
    Object.freeze({
      key: "proof",
      label: PROFILE_POSTURE_FIELD_LABEL,
      value: PROFILE_POSTURE_LABELS[input.minimumPosture],
      detail: "Choose the weakest runtime posture this profile will start on.",
    }),
    Object.freeze({
      key: "skills",
      label: "Skills",
      value: String(input.skillCount),
      detail: "Open the Skills tab scoped to this profile.",
      link: "#skills",
    }),
  ]);
}

/**
 * The accessible name of a governance cell's control.
 *
 * A disclosure that does not say what it contains is a place to bury things, so
 * the field's name, its current value and what opening it does are all in the
 * name — not only in a glyph and a colour.
 */
export function profileGovernanceCellLabel(cell: ProfileGovernanceCell): string {
  return `${cell.label}: ${cell.value}. ${cell.detail}`;
}

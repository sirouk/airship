import type { ProfileMemoryScope } from "../profiles/domain";

/**
 * What a profile actually governs, in one vocabulary.
 *
 * The profile editor is four `<details>` disclosures, and collapsed it reveals
 * "419 characters", "Foundry" and "profile memory · Ask First". A person cannot
 * answer "what does this profile change?" without opening all four. Worse, the
 * boundary summary printed the raw enum `profile memory` while the select
 * inside it printed the friendly `This profile`.
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

/**
 * The boundary note, with one noun for one thing.
 *
 * It used to name the same object twice in two adjacent sentences — "copied
 * into each new session. Existing conversations keep their original pin." —
 * inside the one module that exists so a value has one name at rest and the
 * same name while you change it. docs/CANON.md makes the split explicit: a
 * Conversation is the user-facing thread under Chat, a Session is the
 * immutable runtime identity (manifest, journal, receipt chain). What this
 * sentence describes is the thread a person starts, so it says conversation
 * both times; "session" survives here only where receipts and pins are the
 * subject.
 */
export const PROFILE_BOUNDARY_NOTE =
  "These settings are copied into each new conversation. Existing conversations keep their original pin.";

export type ProfileGovernanceInput = Readonly<{
  systemPromptLength: number;
  themeName: string;
  memoryScope: keyof typeof PROFILE_MEMORY_SCOPE_LABELS;
  approvalMode: keyof typeof PROFILE_APPROVAL_LABELS;
  skillCount: number;
}>;

/**
 * The five things a profile governs, each legible with zero clicks.
 *
 * Order is the order a person asks about them: what it says, what it looks
 * like, what it remembers, what it may do without asking, and what tools it
 * resolves.
 */
export function profileGovernanceCells(input: ProfileGovernanceInput): readonly ProfileGovernanceCell[] {
  return Object.freeze([
    Object.freeze({
      key: "instructions",
      label: "Instructions",
      value: `${input.systemPromptLength.toLocaleString()} ch`,
      // Same object, same noun as the boundary note 25 lines above: this pins
      // into the thread a person starts, which Chat calls a conversation.
      detail: "Edit the system instructions this profile pins into every new conversation.",
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

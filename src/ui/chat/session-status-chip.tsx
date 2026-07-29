import { Popover } from "../popover";
import { ClaimRows, type ClaimRow } from "../platform-shell";
import { Seal, type SealState } from "../seal";

/**
 * One chip for the whole posture of one conversation.
 *
 * The session bar used to render this as four separate objects — an attestation
 * button, a lifecycle dot, a durability pill and (in the topbar, 140px away) a
 * connection pill — which is how the same claim ended up truncated in one place
 * and duplicated in another. The chip states the weakest of them at rest and
 * expands to all of them in full, so subtraction here is re-presentation, never
 * amputation: every string the four objects rendered is in the popover verbatim.
 */

export type SessionStatusFactId = "posture" | "attestation" | "durability" | "lifecycle";

export type SessionStatusFact = Readonly<{
  id: SessionStatusFactId;
  state: SealState;
  /** The full claim, verbatim from the vocabulary that owns it. */
  label: string;
  /** The full sentence. Visible in the popover, never hover-only. */
  detail: string;
  /** ≤14 characters, so the resting chip can never truncate its own verdict. */
  short: string;
  /** Rung L2. A chip that hides a fact must still reach the route that owns it. */
  action?: Readonly<{ label: string; onSelect(): void }>;
}>;

/**
 * Severity, shared with `worstTrustAxis`. Duplicated as a local constant rather
 * than imported because these facts are session-scoped and are deliberately not
 * `TrustAxis` values: the ranking is the same, the vocabulary is not.
 */
const SESSION_STATE_SEVERITY: Readonly<Record<SealState, number>> = Object.freeze({
  failed: 7, attention: 6, stale: 5, asserted: 4, none: 3, checking: 2, verified: 1,
});

/** Ties break toward attestation: it is the claim a user is least able to infer. */
const TIE_ORDER: readonly SessionStatusFactId[] = Object.freeze([
  "attestation", "posture", "durability", "lifecycle",
]);

/**
 * The single fact the resting chip speaks for.
 *
 * Precedence is stated as a rule rather than a sort so it stays auditable: an
 * alarming fact outranks everything, a turn actually in flight outranks a
 * resting posture (it is the only fact that is still changing), and otherwise
 * the weaker of the two evidence claims wins. Nothing about this ranking hides
 * the others — they are all one gesture away.
 */
export function worstSessionFact(facts: readonly SessionStatusFact[]): SessionStatusFact | undefined {
  const alarming = facts.filter((fact) => fact.state === "failed" || fact.state === "attention");
  if (alarming.length > 0) return rank(alarming);
  const running = facts.find((fact) => fact.id === "lifecycle" && fact.state === "checking");
  if (running) return running;
  const evidence = facts.filter((fact) => fact.id === "posture" || fact.id === "attestation");
  return evidence.length > 0 ? rank(evidence) : rank(facts);
}

function rank(facts: readonly SessionStatusFact[]): SessionStatusFact | undefined {
  return facts.reduce<SessionStatusFact | undefined>((worst, candidate) => {
    if (!worst) return candidate;
    const difference = SESSION_STATE_SEVERITY[candidate.state] - SESSION_STATE_SEVERITY[worst.state];
    if (difference > 0) return candidate;
    if (difference < 0) return worst;
    return TIE_ORDER.indexOf(candidate.id) < TIE_ORDER.indexOf(worst.id) ? candidate : worst;
  }, undefined);
}

/**
 * The longest verdict the resting chip can render without a shed label.
 *
 * Measured against the narrowest track the right cluster gets (a 430px phone,
 * where the model chip, this chip, the journal chip and `+` share one row).
 */
export const SESSION_STATUS_SHORT_MAX = 14;

/**
 * The band this one defers to, named rather than restated.
 *
 * The scope rule cuts both ways: this popover states the conversation's claims
 * in full and says nothing about where the kernel runs or whether a vault has
 * been adopted, because those are true of the browser tab and the topbar chip
 * states them. Saying so is the difference between a scope boundary and a
 * missing fact — a reader who wants the other two now knows they exist and
 * where they are, instead of concluding this list is everything Airship knows.
 */
export const SESSION_STATUS_TAB_SCOPE_NOTE =
  // Kept short on purpose: the popover body caps at 420px and scrolls, and a
  // pointer that is itself half-scrolled off the bottom edge is not a pointer.
  // "Opens them" rather than "states them" — the chip states the weakest tab
  // claim and opens the sheet that holds both, which is what actually happens.
  "Runtime location and vault adoption belong to this browser tab, not this conversation. The topbar chip opens them.";

/**
 * The resting word for a claim whose full label is longer than the chip.
 *
 * A verdict is the one string in the disclosure ladder that may never be
 * truncated — `Secure hardw…` states nothing — so a label that does not fit is
 * replaced by its own state's word from the single seal vocabulary rather than
 * cut. The full label is always one gesture away in the popover, which is the
 * difference between shortening a claim and losing one.
 */
export function sessionStatusShort(label: string, fallback: string): string {
  const head = label.split(" · ")[0]?.trim() ?? "";
  return head.length > 0 && head.length <= SESSION_STATUS_SHORT_MAX ? head : fallback;
}

/**
 * The accessible name is a shipped contract, not a description.
 *
 * `e2e/responsive-breakpoints.spec.ts` reads
 * `/Session\. Ephemeral · this page only\./` on this control, and a screen
 * reader user gets the durability claim before anything else for the same
 * reason the sighted layout gives it a chip: it is the fact that decides
 * whether closing the tab loses the conversation.
 */
export function sessionStatusName(
  facts: readonly SessionStatusFact[],
  durabilityLabel: string,
): string {
  const worst = worstSessionFact(facts);
  const claim = worst ? ` ${worst.label}. ${worst.detail}` : "";
  return `Session. ${durabilityLabel}.${claim} ${String(facts.length)} facts.`;
}

export function SessionStatusChip({
  facts,
  durabilityLabel,
}: Readonly<{ facts: readonly SessionStatusFact[]; durabilityLabel: string }>) {
  const worst = worstSessionFact(facts);
  if (!worst) return null;
  const rows: readonly ClaimRow[] = facts.map((fact) => Object.freeze({
    id: fact.id,
    state: fact.state,
    label: fact.label,
    detail: fact.detail,
    action: fact.action,
  }));
  return (
    <Popover
      class="session-status-popover"
      triggerClass="session-status-chip"
      label={sessionStatusName(facts, durabilityLabel)}
      heading="Session state"
      trigger={<>
        {/* `dot` density, so the chip renders one glyph and one word rather
            than the two stacked seals the mobile details button used to show. */}
        <Seal state={worst.state} density="dot" size={16} label={worst.label} acting={worst.state === "checking"} />
        <span class="session-status-chip__word" data-state={worst.state}>{worst.short}</span>
        {/* Same rule as the journal chip: the count states its own unit in
            text, so the two adjacent chips never read as two bare numbers. */}
        <small class="session-status-chip__count">
          {facts.length}{" "}
          <span class="session-status-chip__unit">{facts.length === 1 ? "claim" : "claims"}</span>
        </small>
      </>}
    >
      <ClaimRows rows={rows} />
      <p class="popover__scope-note">{SESSION_STATUS_TAB_SCOPE_NOTE}</p>
    </Popover>
  );
}

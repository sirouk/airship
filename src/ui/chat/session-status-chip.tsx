import { Popover } from "../popover";
import { DetailRows, type DetailRow } from "../platform-shell";
import { StatusMark, type StatusMarkState } from "../status-mark";

export type SessionStatusFactId = "durability" | "lifecycle";

export type SessionStatusFact = Readonly<{
  id: SessionStatusFactId;
  state: StatusMarkState;
  label: string;
  detail: string;
  short: string;
  action?: Readonly<{ label: string; onSelect(): void }>;
}>;


const SESSION_STATE_SEVERITY: Readonly<Record<StatusMarkState, number>> = Object.freeze({
  failed: 7,
  attention: 6,
  stale: 5,
  asserted: 4,
  none: 3,
  checking: 2,
  verified: 1,
});

const TIE_ORDER: readonly SessionStatusFactId[] = Object.freeze(["lifecycle", "durability"]);
const LIFECYCLE_PRIORITY_STATES = new Set<StatusMarkState>(["checking", "attention", "failed"]);

export function worstSessionFact(facts: readonly SessionStatusFact[]): SessionStatusFact | undefined {
  const lifecycle = rank(facts.filter((fact) => fact.id === "lifecycle" && LIFECYCLE_PRIORITY_STATES.has(fact.state)));
  if (lifecycle) return lifecycle;
  const durability = rank(facts.filter((fact) => fact.id === "durability"));
  if (durability) return durability;
  return rank(facts);
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

export const SESSION_STATUS_SHORT_MAX = 14;

export function sessionStatusShort(label: string, fallback: string): string {
  const head = label.split(" · ")[0]?.trim() ?? "";
  return head.length > 0 && head.length <= SESSION_STATUS_SHORT_MAX ? head : fallback;
}

export function sessionStatusName(
  facts: readonly SessionStatusFact[],
  durabilityLabel: string,
): string {
  const worst = worstSessionFact(facts);
  const status = worst
    ? worst.id === "durability" ? ` ${worst.detail}` : ` ${worst.label}. ${worst.detail}`
    : "";
  return `Session. ${durabilityLabel}.${status} ${String(facts.length)} details.`;
}

export function SessionStatusChip({
  facts,
  durabilityLabel,
}: Readonly<{ facts: readonly SessionStatusFact[]; durabilityLabel: string }>) {
  const worst = worstSessionFact(facts);
  if (!worst) return null;
  const rows: readonly DetailRow[] = facts.map((fact) => Object.freeze({
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
      heading="Session status"
      trigger={<>
        <StatusMark state={worst.state} density="dot" size={16} label={worst.label} acting={worst.state === "checking"} />
        <span class="session-status-chip__word" data-state={worst.state}>{worst.short}</span>
        <small class="session-status-chip__count">
          {facts.length}{" "}
          <span class="session-status-chip__unit">{facts.length === 1 ? "detail" : "details"}</span>
        </small>
      </>}
    >
      <DetailRows rows={rows} />
    </Popover>
  );
}

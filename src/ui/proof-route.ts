import type { ConversationReceipt } from "../receipts/types";

const MAX_SESSION_ID_LENGTH = 512;
const MAX_TURN_ID_LENGTH = 512;
const MAX_RECEIPT_ID_LENGTH = 2_048;

export type ProofSelection = Readonly<{
  sessionId: string;
  receiptId?: string;
  turnId?: string;
}>;

export type ProofSection = "summary" | "attestations";

export function proofSelectionForReceipt(
  receipt: Pick<ConversationReceipt, "sessionId" | "receiptId" | "turnId">,
): ProofSelection {
  return Object.freeze({
    sessionId: receipt.sessionId,
    receiptId: receipt.receiptId,
    turnId: receipt.turnId,
  });
}

export function proofSelectionForSession(sessionId: string | undefined): ProofSelection | undefined {
  const bounded = boundedIdentifier(sessionId, MAX_SESSION_ID_LENGTH);
  return bounded ? Object.freeze({ sessionId: bounded }) : undefined;
}

export function proofHash(selection?: ProofSelection, section: ProofSection = "summary"): string {
  const parameters = new URLSearchParams();
  if (selection) {
    parameters.set("session", selection.sessionId);
    if (selection.receiptId) parameters.set("receipt", selection.receiptId);
    if (selection.turnId) parameters.set("turn", selection.turnId);
  }
  if (section === "attestations") parameters.set("section", "attestations");
  const query = parameters.toString();
  return query ? `#proof?${query}` : "#proof";
}

/** Legacy #attestations links open the evidence section of the unified Proof route. */
export function proofSectionFromHash(hash: string): ProofSection {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = normalized.indexOf("?");
  const route = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  if (route === "attestations") return "attestations";
  if (route !== "proof") return "summary";
  const parameters = new URLSearchParams(queryIndex === -1 ? "" : normalized.slice(queryIndex + 1));
  return parameters.get("section") === "attestations" ? "attestations" : "summary";
}

export function proofSelectionFromHash(hash: string): ProofSelection | undefined {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = normalized.indexOf("?");
  const route = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  if (route !== "proof") return undefined;

  const parameters = new URLSearchParams(queryIndex === -1 ? "" : normalized.slice(queryIndex + 1));
  const sessionId = boundedIdentifier(parameters.get("session"), MAX_SESSION_ID_LENGTH);
  if (!sessionId) return undefined;

  const receiptId = boundedIdentifier(parameters.get("receipt"), MAX_RECEIPT_ID_LENGTH);
  const turnId = boundedIdentifier(parameters.get("turn"), MAX_TURN_ID_LENGTH);
  return Object.freeze({
    sessionId,
    ...(receiptId ? { receiptId } : {}),
    ...(turnId ? { turnId } : {}),
  });
}

export function resolveProofReceipt(
  receipts: readonly ConversationReceipt[],
  selection: ProofSelection | undefined,
  fallback?: ConversationReceipt,
): ConversationReceipt | undefined {
  if (selection?.receiptId || selection?.turnId) {
    if (!selection.receiptId || !selection.turnId) return undefined;
    return receipts.find((receipt) =>
      receipt.sessionId === selection.sessionId &&
      receipt.receiptId === selection.receiptId &&
      receipt.turnId === selection.turnId
    );
  }

  if (selection?.sessionId) {
    if (fallback?.sessionId === selection.sessionId) return fallback;
    return [...receipts].reverse().find((receipt) => receipt.sessionId === selection.sessionId);
  }
  return fallback;
}

function boundedIdentifier(value: string | null | undefined, maxLength: number): string | undefined {
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

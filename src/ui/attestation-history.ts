import type { ConversationReceipt } from "../receipts/types";

/** Matches the bounded receipt ledger retained by the attestation presenter. */
export const MAX_SESSION_ATTESTATION_RECEIPTS = 128;

export type ReceiptBearingMessage = Readonly<{
  receipt?: ConversationReceipt;
}>;

export type SessionAttestationReceiptInput = Readonly<{
  messages: readonly ReceiptBearingMessage[];
  sessionId?: string;
  selectedRecordId?: string;
}>;

/**
 * Builds the bounded, session-local receipt page passed to the assertion-only
 * attestation presenter. The selected receipt is retained when it falls
 * outside the newest window so a message deep link cannot select another
 * record by accident.
 */
export function sessionAttestationReceipts(
  input: SessionAttestationReceiptInput,
): readonly ConversationReceipt[] {
  if (!input.sessionId) return Object.freeze([]);

  const page: ConversationReceipt[] = [];
  const retainedIds = new Set<string>();
  const selectedReceiptId = selectedConversationReceiptId(input.selectedRecordId);
  let selectedOutsidePage: ConversationReceipt | undefined;

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const receipt = input.messages[index]?.receipt;
    if (!receipt || receipt.sessionId !== input.sessionId) continue;

    if (page.length < MAX_SESSION_ATTESTATION_RECEIPTS) {
      if (retainedIds.has(receipt.receiptId)) continue;
      retainedIds.add(receipt.receiptId);
      page.push(receipt);
      if (receipt.receiptId === selectedReceiptId) selectedOutsidePage = receipt;
      if (
        page.length === MAX_SESSION_ATTESTATION_RECEIPTS &&
        (!selectedReceiptId || retainedIds.has(selectedReceiptId))
      ) break;
      continue;
    }

    if (!selectedReceiptId || retainedIds.has(selectedReceiptId)) break;
    if (receipt.receiptId === selectedReceiptId) {
      selectedOutsidePage = receipt;
      break;
    }
  }

  if (!selectedOutsidePage || retainedIds.has(selectedOutsidePage.receiptId)) return Object.freeze(page);
  return Object.freeze([...page.slice(0, MAX_SESSION_ATTESTATION_RECEIPTS - 1), selectedOutsidePage]);
}

/** Conversation receipts are normalized under this stable presenter ID. */
export function attestationRecordIdForReceipt(receipt: Pick<ConversationReceipt, "receiptId">): string {
  return `receipt:${receipt.receiptId}`;
}

function selectedConversationReceiptId(recordId: string | undefined): string | undefined {
  if (!recordId?.startsWith("receipt:")) return undefined;
  const receiptId = recordId.slice("receipt:".length);
  return receiptId || undefined;
}

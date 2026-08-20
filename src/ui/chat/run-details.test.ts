import { readFile } from "node:fs/promises";
import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it } from "vitest";
import type { ConversationReceipt } from "../../core/conversation-receipt";
import {
  RECEIPT_TRACE_CAVEAT,
  ReceiptTraceDetails,
  receiptOriginLabel,
  receiptTraceFields,
  runDetailsLabel,
} from "./run-details";

const RECEIPT: ConversationReceipt = Object.freeze({
  version: 1,
  origin: "local",
  attestation: "none",
  receiptId: "urn:receipt:11111111-2222-4333-8444-555555555555",
  sessionId: "session-1",
  turnId: "turn-1",
  createdAt: "2026-08-20T16:23:05.000Z",
  startedAt: "2026-08-20T16:23:05.100Z",
  completedAt: "2026-08-20T16:23:06.000Z",
  provider: "provider-route",
  model: "models/one",
  requestDigest: `sha256:${"a".repeat(43)}`,
  responseDigest: `sha256:${"b".repeat(43)}`,
  timings: Object.freeze({ totalMs: 900 }),
  toolCalls: Object.freeze([Object.freeze({ id: "call-1", name: "read_file" })]),
});

function renderedText(value: ComponentChildren | VNode | unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join(" ");
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  return renderedText((value as VNode).props.children);
}

describe("RunDetails receipt disclosure", () => {
  it("keeps every recorded identity, timestamp and available digest in one stable model", () => {
    expect(receiptTraceFields(RECEIPT).map(({ label, value }) => [label, value])).toEqual([
      ["Origin", "Local run record"],
      ["Provider", "provider-route"],
      ["Model", "models/one"],
      ["Receipt ID", RECEIPT.receiptId],
      ["Conversation ID", "session-1"],
      ["Turn ID", "turn-1"],
      ["Created", "2026-08-20T16:23:05.000Z"],
      ["Started", "2026-08-20T16:23:05.100Z"],
      ["Completed", "2026-08-20T16:23:06.000Z"],
      ["Request digest", RECEIPT.requestDigest],
      ["Response digest", RECEIPT.responseDigest],
      ["Receipt format", "v1"],
      ["Timing · totalMs", "900"],
      ["Tool call 1", "read_file · call-1"],
    ]);
  });

  it("renders the no-upgrade caveat as ordinary component text", () => {
    const text = renderedText(ReceiptTraceDetails({ receipt: RECEIPT }));
    expect(text).toContain("Structural linkage only.");
    expect(text).toContain("Digests not recomputed.");
    expect(text).toContain("Authenticity not proven.");
    expect(text).toContain(RECEIPT.receiptId);
    expect(RECEIPT_TRACE_CAVEAT).toBe(
      "Structural linkage only. Digests not recomputed. Authenticity not proven.",
    );
  });

  it("names origin without treating provider metadata as authenticity", () => {
    expect(receiptOriginLabel(RECEIPT)).toBe("Local run record");
    expect(receiptOriginLabel({ ...RECEIPT, origin: "provider" })).toBe("Provider metadata");
    expect(runDetailsLabel(RECEIPT)).toContain("Opens recorded origin, timestamps, identifiers, available digests, and assessment limits.");
  });

  it("uses the shared operable disclosure instead of a title-only note", async () => {
    const source = await readFile(new URL("./run-details.tsx", import.meta.url), "utf8");
    expect(source).toContain("<Popover");
    expect(source).toContain('triggerClass="receipt-chip"');
    expect(source).not.toContain('role="note"');
    expect(source).not.toContain("title={");
  });
});

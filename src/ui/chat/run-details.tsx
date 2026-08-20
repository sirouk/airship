import type { ConversationReceipt } from "../../core/conversation-receipt";
import { densityAllows, usePresentationDensity } from "../density";
import { Popover } from "../popover";

export type RunDetailsProps = Readonly<{
  receipt: Readonly<ConversationReceipt>;
}>;

export type ReceiptTraceField = Readonly<{
  key: string;
  label: string;
  value: string;
  kind: "text" | "code" | "timestamp";
}>;

/** The compact limit carried with every receipt surface. */
const RECEIPT_TRACE_SCOPE = "Structural linkage only.";
const RECEIPT_TRACE_LIMIT = "Digests not recomputed. Authenticity not proven.";
export const RECEIPT_TRACE_CAVEAT = `${RECEIPT_TRACE_SCOPE} ${RECEIPT_TRACE_LIMIT}`;

export function receiptOriginLabel(receipt: Readonly<ConversationReceipt>): string {
  return receipt.origin === "provider" ? "Provider metadata" : "Local run record";
}

/** A stable presentation model shared by the turn disclosure and Sessions. */
export function receiptTraceFields(
  receipt: Readonly<ConversationReceipt>,
): readonly ReceiptTraceField[] {
  const fields: ReceiptTraceField[] = [
    { key: "origin", label: "Origin", value: receiptOriginLabel(receipt), kind: "text" },
    { key: "provider", label: "Provider", value: receipt.provider, kind: "text" },
    ...(receipt.model
      ? [{ key: "model", label: "Model", value: receipt.model, kind: "code" as const }]
      : []),
    { key: "receipt-id", label: "Receipt ID", value: receipt.receiptId, kind: "code" },
    { key: "session-id", label: "Conversation ID", value: receipt.sessionId, kind: "code" },
    { key: "turn-id", label: "Turn ID", value: receipt.turnId, kind: "code" },
    { key: "created", label: "Created", value: receipt.createdAt, kind: "timestamp" },
    ...(receipt.startedAt
      ? [{ key: "started", label: "Started", value: receipt.startedAt, kind: "timestamp" as const }]
      : []),
    ...(receipt.completedAt
      ? [{ key: "completed", label: "Completed", value: receipt.completedAt, kind: "timestamp" as const }]
      : []),
    ...(receipt.requestDigest
      ? [{ key: "request-digest", label: "Request digest", value: receipt.requestDigest, kind: "code" as const }]
      : []),
    ...(receipt.responseDigest
      ? [{ key: "response-digest", label: "Response digest", value: receipt.responseDigest, kind: "code" as const }]
      : []),
    { key: "format", label: "Receipt format", value: `v${receipt.version}`, kind: "text" },
    ...Object.entries(receipt.timings ?? {}).map(([key, value]) => ({
      key: `timing:${key}`,
      label: `Timing · ${key}`,
      value: String(value),
      kind: "text" as const,
    })),
    ...(receipt.toolCalls ?? []).map((toolCall, index) => ({
      key: `tool:${index}:${toolCall.id}`,
      label: `Tool call ${index + 1}`,
      value: `${toolCall.name} · ${toolCall.id}`,
      kind: "code" as const,
    })),
  ];
  return Object.freeze(fields.map((field) => Object.freeze(field)));
}

export function runDetailsLabel(receipt: Readonly<ConversationReceipt>): string {
  return `Run details. Provider ${receipt.provider}. Run ${receipt.receiptId}. Opens recorded origin, timestamps, identifiers, available digests, and assessment limits.`;
}

export function ReceiptTraceDetails({
  receipt,
  includeAssessmentScope = true,
}: Readonly<{
  receipt: Readonly<ConversationReceipt>;
  includeAssessmentScope?: boolean;
}>) {
  return (
    <div class="receipt-trace">
      <dl class="receipt-trace__fields">
        {receiptTraceFields(receipt).map((field) => (
          <div class="receipt-trace__field" data-field={field.key} key={field.key}>
            <dt>{field.label}</dt>
            <dd>
              {field.kind === "timestamp" ? (
                <time dateTime={field.value}>{field.value}</time>
              ) : field.kind === "code" ? (
                <code>{field.value}</code>
              ) : field.value}
            </dd>
          </div>
        ))}
      </dl>
      {includeAssessmentScope ? (
        <p class="receipt-trace__scope">
          <strong>{RECEIPT_TRACE_SCOPE}</strong> {RECEIPT_TRACE_LIMIT}
        </p>
      ) : null}
    </div>
  );
}

/** Neutral, local trace metadata shared by turn cards and session markers. */
export function RunDetails({ receipt }: RunDetailsProps) {
  const density = usePresentationDensity();
  if (!densityAllows("telemetry", density)) return null;
  return (
    <div class="run-details">
      {receipt.model ? <span class="message-model">{receipt.model}</span> : null}
      <Popover
        class="run-details__disclosure"
        triggerClass="receipt-chip"
        label={runDetailsLabel(receipt)}
        heading="Run details"
        trigger={<span>Run · {receipt.provider} · {receipt.receiptId.slice(-8)}</span>}
      >
        <ReceiptTraceDetails receipt={receipt} />
      </Popover>
    </div>
  );
}

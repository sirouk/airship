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

type ReceiptTraceRow = readonly [
  key: string,
  label: string,
  value: string,
  /** 1 renders code; 2 renders a machine-readable timestamp. */
  kind?: 1 | 2,
];

/** Compact rows keep the disclosure and its public presentation model aligned. */
function receiptTraceRows(receipt: Readonly<ConversationReceipt>): readonly ReceiptTraceRow[] {
  return [
    ["origin", "Origin", receiptOriginLabel(receipt)],
    ["provider", "Provider", receipt.provider],
    receipt.model && ["model", "Model", receipt.model, 1],
    ["receipt-id", "Receipt ID", receipt.receiptId, 1],
    ["session-id", "Conversation ID", receipt.sessionId, 1],
    ["turn-id", "Turn ID", receipt.turnId, 1],
    ["created", "Created", receipt.createdAt, 2],
    receipt.startedAt && ["started", "Started", receipt.startedAt, 2],
    receipt.completedAt && ["completed", "Completed", receipt.completedAt, 2],
    receipt.requestDigest && ["request-digest", "Request digest", receipt.requestDigest, 1],
    receipt.responseDigest && ["response-digest", "Response digest", receipt.responseDigest, 1],
    ["format", "Receipt format", `v${receipt.version}`],
    ...Object.entries(receipt.timings || {}).map(([key, value]) =>
      [`timing:${key}`, `Timing · ${key}`, `${value}`] as const),
    ...(receipt.toolCalls || []).map((toolCall, index) => [
      `tool:${index}:${toolCall.id}`,
      `Tool call ${index + 1}`,
      `${toolCall.name} · ${toolCall.id}`,
      1,
    ] as const),
  ].filter(Boolean) as ReceiptTraceRow[];
}

/** A stable presentation model shared by the turn disclosure and Sessions. */
export function receiptTraceFields(
  receipt: Readonly<ConversationReceipt>,
): readonly ReceiptTraceField[] {
  return Object.freeze(receiptTraceRows(receipt).map(([key, label, value, kind]) =>
    Object.freeze({
      key,
      label,
      value,
      kind: kind === 1 ? "code" : kind === 2 ? "timestamp" : "text",
    })));
}

function detailsLabel(receipt: Readonly<ConversationReceipt>): string {
  return `Run details. Provider ${receipt.provider}. Run ${receipt.receiptId}. Opens recorded origin, timestamps, identifiers, available digests, and assessment limits.`;
}

/** Public label helper over the same copy used by the operable disclosure. */
export function runDetailsLabel(receipt: Readonly<ConversationReceipt>): string {
  return detailsLabel(receipt);
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
        {receiptTraceRows(receipt).map(([key, label, value, kind]) => (
          <div class="receipt-trace__field" data-field={key} key={key}>
            <dt>{label}</dt>
            <dd>
              {kind === 2 ? (
                <time dateTime={value}>{value}</time>
              ) : kind === 1 ? (
                <code>{value}</code>
              ) : value}
            </dd>
          </div>
        ))}
      </dl>
      {includeAssessmentScope && (
        <p class="receipt-trace__scope">
          <strong>{RECEIPT_TRACE_SCOPE}</strong> {RECEIPT_TRACE_LIMIT}
        </p>
      )}
    </div>
  );
}

/** Neutral, local trace metadata shared by turn cards and session markers. */
export function RunDetails({ receipt }: RunDetailsProps) {
  const density = usePresentationDensity();
  if (!densityAllows("telemetry", density)) return null;
  return (
    <div class="run-details">
      {receipt.model && <span class="message-model">{receipt.model}</span>}
      <Popover
        class="run-details__disclosure"
        triggerClass="receipt-chip"
        label={detailsLabel(receipt)}
        heading="Run details"
        trigger={<span>Run · {receipt.provider} · {receipt.receiptId.slice(-8)}</span>}
      >
        <ReceiptTraceDetails receipt={receipt} />
      </Popover>
    </div>
  );
}

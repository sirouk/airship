import { Icon } from "../icons";
import { Seal, type SealState } from "../seal";
import type { MessagePart } from "./message-parts";
import { MarkdownView } from "./markdown";
import "./message-parts-view.css";

export const DEFAULT_OPERATION_RENDER_LIMIT = 12;

export function MessagePartsView({
  parts,
  streamedContent,
  streaming = false,
}: {
  parts: readonly MessagePart[];
  streamedContent?: string;
  streaming?: boolean;
}) {
  const tail = streamedMessageTail(parts, streamedContent ?? "", streaming);
  const bounded = boundedMessageParts(parts);
  return (
    <div class="message-parts" aria-label="Message contents">
      {bounded.visible.map((part) => <MessagePartView key={part.id} part={part} />)}
      {bounded.overflow.length ? (
        <details class="message-part operation-overflow">
          <summary>{DEFAULT_OPERATION_RENDER_LIMIT} of {bounded.operationCount} tool steps shown · Show chronological remainder</summary>
          {bounded.overflow.map((part) => <MessagePartView key={part.id} part={part} />)}
        </details>
      ) : null}
      {tail ? <div class="message-part text streaming" aria-live="polite"><MarkdownView source={tail} streaming /></div> : null}
    </div>
  );
}

/**
 * Bounds the transcript at the first operation beyond the limit. The complete
 * chronological suffix moves into one disclosure so later prose, citations,
 * and results can never leap ahead of the tool step they depend on.
 */
export function boundedMessageParts(parts: readonly MessagePart[], limit = DEFAULT_OPERATION_RENDER_LIMIT): Readonly<{
  visible: readonly MessagePart[];
  overflow: readonly MessagePart[];
  operationCount: number;
}> {
  let operations = 0;
  let boundary = parts.length;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isOperationPart(parts[index]!)) continue;
    operations += 1;
    if (operations > limit) { boundary = index; break; }
  }
  return Object.freeze({
    visible: Object.freeze(parts.slice(0, boundary)),
    overflow: Object.freeze(parts.slice(boundary)),
    operationCount: parts.filter(isOperationPart).length,
  });
}

export function streamedMessageTail(
  _parts: readonly MessagePart[],
  streamedContent: string,
  streaming: boolean,
): string {
  return streaming ? streamedContent : "";
}

function MessagePartView({ part }: { part: MessagePart }) {
  if (part.kind === "text") {
    return <div class="message-part text"><MarkdownView source={part.content} /></div>;
  }

  if (part.kind === "tool-call") {
    const open = part.status === "running" || part.status === "failed" || part.status === "denied";
    return (
      <details class={`message-part operation tool-call ${part.status}`} open={open}>
        <summary>
          <Seal state={operationSeal(part.status)} label={toolStatusLabel(part.status)} size={16} compact />
          <span class="operation-title"><small>Tool call</small><strong>{part.name}</strong></span>
          <span class={`operation-state ${part.status}`}>{part.status}</span>
        </summary>
        <div class="operation-body">
          <span class="operation-label">Arguments · bounded display</span>
          <pre>{part.argumentsSummary || "No arguments"}</pre>
          <code class="operation-id">{part.callId}</code>
        </div>
      </details>
    );
  }

  if (part.kind === "tool-result") {
    return (
      <details class={`message-part operation tool-result ${part.status}`} open={part.status !== "success"}>
        <summary>
          <Seal state={operationSeal(part.status)} label={toolStatusLabel(part.status)} size={16} compact />
          <span class="operation-title"><small>Tool result</small><strong>{part.name ?? part.callId}</strong></span>
          <span class={`operation-state ${part.status}`}>{part.status}</span>
        </summary>
        <div class="operation-body">
          <pre>{part.summary || "No visible output"}</pre>
          {part.metadataSummary ? <><span class="operation-label">Metadata · bounded display</span><pre>{part.metadataSummary}</pre></> : null}
        </div>
      </details>
    );
  }

  if (part.kind === "reasoning-summary") {
    return (
      <details class="message-part reasoning-summary">
        <summary><Icon name="context" size={14} /><span>{part.label ?? "Reasoning summary"}</span><small>Public summary</small></summary>
        <p>{part.summary}</p>
      </details>
    );
  }

  if (part.kind === "citation") {
    return (
      <article class="message-part reference citation">
        <header><Icon name="source" size={14} /><span>Citation</span><strong>{part.label}</strong></header>
        {part.excerpt ? <p>{part.excerpt}</p> : null}
        {part.reference ? <code>{part.reference}</code> : null}
      </article>
    );
  }

  if (part.kind === "attachment") {
    return (
      <article class={`message-part reference attachment ${part.status}`}>
        <header><Icon name="file" size={14} /><span>Attachment</span><strong>{part.name}</strong><small>{part.status}</small></header>
        {part.previewUrl ? <details class="attachment-preview"><summary aria-label={`Preview ${part.name}`}><img src={part.previewUrl} alt="" /></summary><img src={part.previewUrl} alt={`Attached image ${part.name}`} /></details> : null}
        <div class="attachment-meta">
          {part.mediaType ? <span>{part.mediaType}</span> : null}
          {part.sizeBytes !== undefined ? <span>{formatBytes(part.sizeBytes)}</span> : null}
        </div>
        {part.summary ? <p>{part.summary}</p> : null}
        {part.reference ? <code>{part.reference}</code> : null}
      </article>
    );
  }

  if (part.kind === "error") {
    return (
      <div class="message-part part-error" role="alert">
        <Icon name="warning" size={15} />
        <div><strong>{part.code ?? "Turn stopped safely"}</strong><p>{part.summary}</p>{part.retryable ? <small>Retry is available.</small> : null}</div>
      </div>
    );
  }

  return (
    <footer class="message-part part-footer">
      <span>{part.summary}</span>
      {part.recordedAt ? <time dateTime={part.recordedAt}>{formatRecordedAt(part.recordedAt)}</time> : null}
    </footer>
  );
}

function isOperationPart(part: MessagePart): boolean {
  return part.kind === "tool-call" || part.kind === "tool-result";
}

function operationSeal(status: string): SealState {
  if (status === "completed" || status === "success" || status === "approved") return "verified";
  if (status === "failed" || status === "error" || status === "denied") return "failed";
  if (status === "running") return "checking";
  return "none";
}

function toolStatusLabel(status: string): string {
  if (status === "success" || status === "completed") return "Tool step completed";
  if (status === "failed" || status === "error") return "Tool step failed";
  if (status === "denied") return "Tool step denied";
  if (status === "running") return "Tool step running";
  if (status === "approved") return "Tool step approved";
  return "Tool step not checked";
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${String(size)} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`;
  return `${(size / 1_048_576).toFixed(1)} MiB`;
}

function formatRecordedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp)
    : "Recorded";
}

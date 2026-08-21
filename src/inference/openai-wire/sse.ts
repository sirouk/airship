import { OpenAiWireError } from "./errors";

export type SseMessage = {
  data: string;
  event?: string;
  id?: string;
};

/** Incremental, bounded SSE parser supporting CRLF, CR, LF, comments and multi-line data. */
export class BoundedSseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName?: string;
  private eventId?: string;
  private eventChars = 0;
  private firstChunk = true;

  constructor(private readonly maxEventChars: number) {
    if (!Number.isSafeInteger(maxEventChars) || maxEventChars < 1) {
      throw new TypeError("maxEventChars must be a positive safe integer");
    }
  }

  push(chunk: string, final = false): SseMessage[] {
    if (this.firstChunk) {
      this.firstChunk = false;
      chunk = chunk.replace(/^\uFEFF/, "");
    }
    this.buffer += chunk;
    if (this.buffer.length + this.eventChars > this.maxEventChars) this.limitExceeded();

    const messages: SseMessage[] = [];
    let cursor = 0;
    for (;;) {
      const lineEnd = findLineEnd(this.buffer, cursor);
      if (!lineEnd) break;
      const line = this.buffer.slice(cursor, lineEnd.index);
      cursor = lineEnd.next;
      this.processLine(line, messages);
    }
    this.buffer = this.buffer.slice(cursor);

    if (final) {
      if (this.buffer.endsWith("\r")) this.processLine(this.buffer.slice(0, -1), messages);
      else if (this.buffer) this.processLine(this.buffer, messages);
      this.buffer = "";
      this.dispatch(messages);
    }
    return messages;
  }

  private processLine(line: string, messages: SseMessage[]) {
    if (!line) {
      this.dispatch(messages);
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      this.eventChars += value.length + 1;
      if (this.eventChars > this.maxEventChars) this.limitExceeded();
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventName = value;
    } else if (field === "id" && !value.includes("\0")) {
      this.eventId = value;
    }
  }

  private dispatch(messages: SseMessage[]) {
    if (this.dataLines.length) {
      messages.push({
        data: this.dataLines.join("\n"),
        event: this.eventName,
        id: this.eventId,
      });
    }
    this.dataLines = [];
    this.eventName = undefined;
    this.eventChars = 0;
  }

  private limitExceeded(): never {
    throw new OpenAiWireError(
      "sse-limit",
      `SSE event exceeds the configured ${this.maxEventChars}-character limit.`,
    );
  }
}

function findLineEnd(value: string, start: number): { index: number; next: number } | undefined {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) return { index, next: index + 1 };
    if (code === 13) {
      if (index + 1 >= value.length) return undefined;
      return { index, next: value.charCodeAt(index + 1) === 10 ? index + 2 : index + 1 };
    }
  }
  return undefined;
}

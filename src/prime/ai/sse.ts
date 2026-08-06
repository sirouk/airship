/**
 * Incremental Server-Sent-Events parser. Feeds provider adapters with
 * (event, data) records from a streaming fetch body. Dependency-free and
 * worker-safe.
 */

export type SseRecord = { event?: string; data: string };

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventType: string | undefined;

  /** Feed a decoded string chunk; returns complete records observed. */
  feed(chunk: string): SseRecord[] {
    this.buffer += chunk;
    const out: SseRecord[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const rec = this.line(line);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** Flush any tail (generally only for malformed streams missing \n). */
  flush(): SseRecord[] {
    const out: SseRecord[] = [];
    if (this.buffer.length > 0) {
      const rec = this.line(this.buffer);
      if (rec) out.push(rec);
      this.buffer = "";
    }
    const end = this.dispatch();
    if (end) out.push(end);
    return out;
  }

  private line(line: string): SseRecord | undefined {
    if (line === "") {
      return this.dispatch();
    }
    if (line.startsWith(":")) return undefined; // comment / keep-alive
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
      return undefined;
    }
    if (line.startsWith("event:")) {
      this.eventType = line.slice(6).replace(/^ /, "");
      return undefined;
    }
    // id:/retry: and unknown fields are ignored, matching prime-agent behavior.
    return undefined;
  }

  private dispatch(): SseRecord | undefined {
    if (this.dataLines.length === 0) {
      this.eventType = undefined;
      return undefined;
    }
    const rec: SseRecord = { event: this.eventType, data: this.dataLines.join("\n") };
    this.dataLines = [];
    this.eventType = undefined;
    return rec;
  }
}

/** Iterate SSE records from a web ReadableStream of bytes. */
export async function* sseRecords(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) return;
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    yield* parser.feed(decoder.decode());
    yield* parser.flush();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

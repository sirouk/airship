import { AIRSHIP_SH_MAX_PIPE_BYTES } from "./contract";
import { ShellFatalError } from "./errors";

/**
 * Streams carry bytes, not strings.
 *
 * `WorkspacePort` content is a reversible byte envelope, so a shell that
 * decoded everything to UTF-8 would corrupt `cat binary > copy`. Text-oriented
 * utilities decode at their own boundary instead.
 */
export interface ByteSink {
  write(bytes: Uint8Array): void;
}

const encoder = new TextEncoder();
/** Non-fatal: a shell prints what it is given, it does not validate encodings. */
const decoder = new TextDecoder("utf-8", { fatal: false });

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * The job's own stdout/stderr. Output is emitted to the observer as it is
 * produced — the script is never buffered to completion — while the durable
 * result stays inside a fixed byte budget. Dropped bytes are counted rather
 * than silently discarded.
 */
export class BoundedOutputStream implements ByteSink {
  private readonly chunks: Uint8Array[] = [];
  private accepted = 0;
  private dropped = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly observe?: (text: string) => void,
  ) {}

  write(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const room = this.limitBytes - this.accepted;
    if (room <= 0) {
      this.dropped += bytes.byteLength;
      return;
    }
    const admitted = bytes.byteLength <= room ? bytes : bytes.subarray(0, room);
    this.dropped += bytes.byteLength - admitted.byteLength;
    this.accepted += admitted.byteLength;
    this.chunks.push(admitted.slice());
    this.observe?.(decodeText(admitted));
  }

  get acceptedBytes(): number {
    return this.accepted;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  text(): string {
    return decodeText(concatBytes(this.chunks));
  }
}

/**
 * A pipe stage's output.
 *
 * Pipeline stages run in sequence with a bounded buffer between them rather
 * than as concurrent coroutines. That is a real semantic difference from a
 * process-based shell — an unbounded producer feeding `head` fails the run
 * instead of receiving SIGPIPE — so the buffer is explicitly capped and the
 * boundary is documented rather than hidden.
 */
export class PipeBuffer implements ByteSink {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly limitBytes = AIRSHIP_SH_MAX_PIPE_BYTES) {}

  write(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.size += bytes.byteLength;
    if (this.size > this.limitBytes) {
      throw new ShellFatalError("budget", `airship-sh: pipe buffer exceeded ${this.limitBytes} bytes.`);
    }
    this.chunks.push(bytes.slice());
  }

  bytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

/** Discards writes. Used by `>/dev/null` and by a closed descriptor. */
export const NULL_SINK: ByteSink = Object.freeze({ write(): void {} });


/**
 * A fully materialized input. Every stdin in this interpreter comes from a
 * here-document, a file, or a completed pipe stage, so a cursor over bytes is
 * the whole contract; there is no interactive input and `read` reports EOF.
 */
export class ByteReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  static empty(): ByteReader {
    return new ByteReader(new Uint8Array());
  }

  static fromText(text: string): ByteReader {
    return new ByteReader(encodeText(text));
  }

  atEnd(): boolean {
    return this.offset >= this.data.byteLength;
  }

  readAll(): Uint8Array {
    const rest = this.data.subarray(this.offset);
    this.offset = this.data.byteLength;
    return rest;
  }

  /** Consumes through the newline; the returned bytes exclude it. */
  readLine(): Uint8Array | undefined {
    if (this.atEnd()) return undefined;
    const index = this.data.indexOf(0x0a, this.offset);
    if (index === -1) {
      const rest = this.data.subarray(this.offset);
      this.offset = this.data.byteLength;
      return rest;
    }
    const line = this.data.subarray(this.offset, index);
    this.offset = index + 1;
    return line;
  }
}

/** Splits input into lines, preserving whether a final newline was present. */
export function splitLines(bytes: Uint8Array): Readonly<{ lines: readonly string[]; trailingNewline: boolean }> {
  const text = decodeText(bytes);
  if (text.length === 0) return Object.freeze({ lines: Object.freeze([]), trailingNewline: false });
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return Object.freeze({ lines: Object.freeze(body.split("\n")), trailingNewline });
}

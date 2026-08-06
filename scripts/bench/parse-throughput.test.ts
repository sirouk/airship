/**
 * Streaming-parse microbenchmark for docs/prime/DETERMINATION.md: provider-
 * realistic SSE and stream-json throughput through the ported parsers.
 */
import { describe, expect, it } from "vitest";
import { SseParser } from "../../src/prime/ai/sse";
import { parseStreamingJson } from "../../src/prime/ai/stream-json";

const N_EVENTS = 200_000;
const N_PARTIAL = 100_000;

function makeEvents(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`data: {"id":"chatcmpl-${i}","choices":[{"delta":{"content":"tok${i} "}}]}\r\n\r\n`);
  }
  return parts.join("");
}

describe("parse throughput (docs/prime/DETERMINATION.md)", () => {
  it("sse + stream-json throughput", () => {
    const blob = makeEvents(200_000);
    const bytes = new TextEncoder().encode(blob);
    const parser = new SseParser();
    let count = 0;
    const t0 = performance.now();
    const decoder = new TextDecoder();
    for (let off = 0; off < bytes.length; off += 16 * 1024) {
      const text = decoder.decode(bytes.slice(off, off + 16 * 1024), { stream: true });
      for (const rec of parser.feed(text)) if (rec.data.startsWith("{")) count++;
    }
    for (const rec of parser.flush()) count++;
    const t1 = performance.now();
    console.log(
      `sse: ${count} records in ${(t1 - t0).toFixed(0)}ms -> ${(bytes.length / (t1 - t0) / 1000).toFixed(1)} MB/s, ${(200_000 / (t1 - t0) * 1000).toFixed(0)} ev/s`,
    );
    expect(count).toBe(N_EVENTS);

    const arg = `{"path":"/workspace/src/a-file-${"x".repeat(120)}.ts","content":"${"line\n".repeat(200)}"}`;
    let ok = 0;
    const t2 = performance.now();
    for (let i = 0; i < N_PARTIAL; i++) {
      if (parseStreamingJson(arg.slice(0, Math.ceil(arg.length * ((i % 97) / 97)) || 2)) !== undefined) ok++;
    }
    const t3 = performance.now();
    console.log(`stream-json: ${ok} parses in ${(t3 - t2).toFixed(0)}ms -> ${(N_PARTIAL / (t3 - t2) * 1000).toFixed(0)} parses/s`);
    expect(ok).toBe(N_PARTIAL);
  });
});

import { describe, expect, it } from "vitest";
import { ChutesTransportError } from "./errors";
import { BoundedSseParser } from "./sse";

describe("BoundedSseParser", () => {
  it("handles chunking, BOM, comments, CRLF and multi-line data", () => {
    const parser = new BoundedSseParser(1_024);
    expect(parser.push("\uFEFF: heartbeat\r\nevent: token\r\ndata: one\r")).toEqual([]);
    expect(parser.push("\ndata:two\r\n\r\n")).toEqual([
      { data: "one\ntwo", event: "token", id: undefined },
    ]);
  });

  it("assembles an event whose authenticated data line and delimiter arrive separately", () => {
    const parser = new BoundedSseParser(1_024);
    expect(parser.push('data: {"ok":true}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([
      { data: '{"ok":true}', event: undefined, id: undefined },
    ]);
  });

  it("emits zero or many messages for authenticated plaintext chunks", () => {
    const parser = new BoundedSseParser(1_024);
    expect(parser.push(": authenticated heartbeat\n\n")).toEqual([]);
    expect(parser.push("data: one\n\ndata: two\n\n")).toEqual([
      { data: "one", event: undefined, id: undefined },
      { data: "two", event: undefined, id: undefined },
    ]);
  });

  it("fails closed at the configured event bound", () => {
    const parser = new BoundedSseParser(8);
    expect(() => parser.push("data: 123456789\n\n")).toThrowError(
      expect.objectContaining<Partial<ChutesTransportError>>({ code: "SSE_LIMIT" }),
    );
  });

  it("enforces the event bound across independently authenticated fragments", () => {
    const parser = new BoundedSseParser(16);
    expect(parser.push("data: 12345678")).toEqual([]);
    expect(() => parser.push("901234567\n\n")).toThrowError(
      expect.objectContaining<Partial<ChutesTransportError>>({ code: "SSE_LIMIT" }),
    );
  });
});

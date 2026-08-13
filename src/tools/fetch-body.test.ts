import { describe, expect, it } from "vitest";
import {
  base64FromBytes,
  downloadPathFor,
  fetchBodyKind,
  isTextualContentType,
  looksTextual,
} from "./fetch-body";

const utf8 = (value: string) => new TextEncoder().encode(value);

describe("what a header is worth", () => {
  it("recognises the textual families without enumerating every spelling", () => {
    expect(isTextualContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextualContentType("application/vnd.api+json")).toBe(true);
    expect(isTextualContentType("application/atom+xml")).toBe(true);
    expect(isTextualContentType("APPLICATION/JSON")).toBe(true);
    expect(isTextualContentType("application/pdf")).toBe(false);
  });

  it("knows the legacy JavaScript label DuckDuckGo serves JSON under", () => {
    expect(isTextualContentType("application/x-javascript")).toBe(true);
  });
});

describe("what the bytes are worth, which is more", () => {
  it("reads plain and multi-byte text as text", () => {
    expect(looksTextual(utf8("hello"))).toBe(true);
    expect(looksTextual(utf8("λόγος — ünïcode ✓"))).toBe(true);
    expect(looksTextual(utf8("id,name\n1,airship\n"))).toBe(true);
    expect(looksTextual(new Uint8Array())).toBe(true);
  });

  it("refuses bytes that are not valid UTF-8 at all", () => {
    expect(looksTextual(new Uint8Array([0xc3, 0x28]))).toBe(false);
    expect(looksTextual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });

  it("treats a NUL as decisive, because text does not carry one", () => {
    expect(looksTextual(new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69]))).toBe(false);
  });

  it("tolerates the control characters text really does use", () => {
    expect(looksTextual(utf8("a\tb\r\nc\f"))).toBe(true);
  });

  it("refuses a body dense with other control bytes", () => {
    const noisy = new Uint8Array(1_000);
    for (let index = 0; index < noisy.length; index += 1) noisy[index] = index % 10 === 0 ? 0x07 : 0x61;
    expect(looksTextual(noisy)).toBe(false);
  });
});

describe("the disposition of a body", () => {
  // The DuckDuckGo case: a healthy 200 whose only fault was its label.
  it("reads JSON that came back under a JavaScript content type", () => {
    expect(fetchBodyKind("application/x-javascript", utf8('{"AbstractText":"an airship"}'))).toBe("text");
  });

  it("reads text that came back as octet-stream, because the header cannot demote", () => {
    expect(fetchBodyKind("application/octet-stream", utf8("# Title\n\nbody\n"))).toBe("text");
  });

  it("does not read a zip as text just because the origin claimed text/plain", () => {
    expect(fetchBodyKind("text/plain", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe]))).toBe("binary");
  });

  it("has no third answer, so nothing can be classified as unsupported", () => {
    for (const type of ["application/pdf", "image/png", "", "application/x-shockwave-flash"]) {
      expect(["text", "binary"]).toContain(fetchBodyKind(type, new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
    }
  });
});

describe("where a body that is not text goes", () => {
  it("keeps the name the URL gave it, under one findable directory", () => {
    expect(downloadPathFor(new URL("https://example.com/docs/paper.pdf"), "application/pdf"))
      .toBe("/workspace/.airship/downloads/paper.pdf");
  });

  it("supplies an extension the address omitted, from the content type", () => {
    expect(downloadPathFor(new URL("https://example.com/assets/logo"), "image/png"))
      .toBe("/workspace/.airship/downloads/logo.png");
  });

  it("does not double an extension the address already carried", () => {
    expect(downloadPathFor(new URL("https://example.com/a/archive.zip"), "application/zip"))
      .toBe("/workspace/.airship/downloads/archive.zip");
  });

  it("falls back to the host when the path names nothing", () => {
    expect(downloadPathFor(new URL("https://example.com/"), "application/pdf"))
      .toBe("/workspace/.airship/downloads/example.com.pdf");
  });

  it("separates two objects that differ only in their query, before the extension", () => {
    const one = downloadPathFor(new URL("https://example.com/render?page=1"), "image/png");
    const two = downloadPathFor(new URL("https://example.com/render?page=2"), "image/png");
    expect(one).not.toBe(two);
    expect(one.endsWith(".png")).toBe(true);
    expect(two.endsWith(".png")).toBe(true);
  });

  it("refetching the same address overwrites rather than accumulating", () => {
    const address = new URL("https://example.com/data/report.pdf");
    expect(downloadPathFor(address, "application/pdf")).toBe(downloadPathFor(address, "application/pdf"));
  });

  it("cannot be talked out of the downloads directory by a hostile path", () => {
    const path = downloadPathFor(new URL("https://example.com/a/..%2f..%2f..%2fetc%2fpasswd"), "application/octet-stream");
    expect(path.startsWith("/workspace/.airship/downloads/")).toBe(true);
    expect(path).not.toContain("..");
  });

  it("survives a path segment that is nothing but separators", () => {
    const path = downloadPathFor(new URL("https://example.com/%2F%2F%2F"), "application/pdf");
    expect(path.startsWith("/workspace/.airship/downloads/")).toBe(true);
  });
});

describe("inlining", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(512);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const decoded = Uint8Array.from(atob(base64FromBytes(bytes)), (character) => character.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});

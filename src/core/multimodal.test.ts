import { describe, expect, it } from "vitest";
import { boundInferenceHistoryImages, canonicalImageInputs } from "./multimodal-contract";

describe("canonicalImageInputs", () => {
  it("accepts exact inline base64 bytes and returns an immutable clone", () => {
    const source = [{
      type: "image",
      name: "diagram.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AQID",
      sizeBytes: 3,
    }];

    const result = canonicalImageInputs(source);
    expect(result).toEqual(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.[0])).toBe(true);
  });

  it.each([
    [{ type: "image", name: "remote", mediaType: "image/png", dataUrl: "https://example.test/a.png", sizeBytes: 3 }],
    [{ type: "image", name: "wrong-size", mediaType: "image/png", dataUrl: "data:image/png;base64,AQID", sizeBytes: 4 }],
    [{ type: "image", name: "not-image", mediaType: "text/plain", dataUrl: "data:text/plain;base64,AQID", sizeBytes: 3 }],
  ])("rejects malformed or non-inline inputs", (value) => {
    expect(canonicalImageInputs(value)).toBeUndefined();
  });

  it("keeps only the newest inline images without dropping surrounding text", () => {
    const image = (name: string) => ({
      type: "image" as const,
      name,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AQID",
      sizeBytes: 3,
    });
    const messages = boundInferenceHistoryImages([
      { role: "user", content: "old", images: [image("old.png")] },
      { role: "assistant", content: "noted" },
      { role: "user", content: "new", images: [image("new-a.png"), image("new-b.png")] },
    ]);

    expect(messages.map((message) => message.content)).toEqual(["old", "noted", "new"]);
    expect(messages[0]!.images).toBeUndefined();
    expect(messages[2]!.images?.map((item) => item.name)).toEqual(["new-a.png", "new-b.png"]);
  });
});

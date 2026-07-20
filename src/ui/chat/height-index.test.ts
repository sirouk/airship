import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_OVERSCAN,
  TRANSCRIPT_VIRTUALIZATION_THRESHOLD,
  TranscriptHeightIndex,
  type HeightIndexItem,
} from "./height-index";

describe("TranscriptHeightIndex", () => {
  it("renders the complete transcript through 60 messages and windows only above it", () => {
    const index = new TranscriptHeightIndex();
    index.setItems(items(TRANSCRIPT_VIRTUALIZATION_THRESHOLD, 10));

    expect(index.windowForViewport(250, 30)).toMatchObject({
      virtualized: false,
      startIndex: 0,
      endIndex: 60,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    });

    index.setItems(items(TRANSCRIPT_VIRTUALIZATION_THRESHOLD + 1, 10));
    expect(index.windowForViewport(250, 30)).toMatchObject({
      virtualized: true,
      visibleStartIndex: 25,
      visibleEndIndex: 28,
      startIndex: 25 - TRANSCRIPT_OVERSCAN,
      endIndex: 28 + TRANSCRIPT_OVERSCAN,
      topSpacerHeight: 170,
      bottomSpacerHeight: 250,
    });
  });

  it("binary-searches variable measured heights at exact item boundaries", () => {
    const index = new TranscriptHeightIndex();
    index.setItems([
      item("a", 20),
      item("b", 80),
      item("c", 30),
      item("d", 70),
    ]);

    expect(index.totalHeight()).toBe(200);
    expect(index.indexAtOffset(0)).toBe(0);
    expect(index.indexAtOffset(19.99)).toBe(0);
    expect(index.indexAtOffset(20)).toBe(1);
    expect(index.indexAtOffset(99.99)).toBe(1);
    expect(index.indexAtOffset(100)).toBe(2);
    expect(index.indexAtOffset(130)).toBe(3);
    expect(index.indexAtOffset(10_000)).toBe(3);

    expect(index.measure("b", 1, 100, 0)).toMatchObject({ accepted: true, delta: 20 });
    expect(index.totalHeight()).toBe(220);
    expect(index.offsetAt(2)).toBe(120);
    expect(index.indexAtOffset(119.99)).toBe(1);
    expect(index.indexAtOffset(120)).toBe(2);
  });

  it("preserves live measurements across reorder and prunes removed or superseded revisions", () => {
    const index = new TranscriptHeightIndex();
    index.setItems([item("a", 40), item("b", 40)]);
    index.measure("a", 1, 75, 0);
    index.measure("b", 1, 90, 0);
    expect(index.measurementCount).toBe(2);

    index.setItems([item("b", 40), item("a", 40)]);
    expect(index.heightAt(0)).toBe(90);
    expect(index.heightAt(1)).toBe(75);
    expect(index.measurementCount).toBe(2);

    index.setItems([item("b", 55, 2), item("c", 30)]);
    expect(index.measurementCount).toBe(0);
    expect(index.heightAt(0)).toBe(55);
    expect(index.totalHeight()).toBe(85);
    expect(index.measure("b", 1, 200, 0)).toMatchObject({ accepted: false, changed: false });
  });

  it("returns scroll compensation only for resized rows above the visible anchor", () => {
    const index = new TranscriptHeightIndex();
    index.setItems(items(100, 40));

    expect(index.measure("message-5", 1, 60, 20)).toMatchObject({
      delta: 20,
      scrollAdjustment: 20,
    });
    expect(index.measure("message-20", 1, 70, 20)).toMatchObject({
      delta: 30,
      scrollAdjustment: 0,
    });
    expect(index.measure("message-3", 1, 20, 20)).toMatchObject({
      delta: -20,
      scrollAdjustment: -20,
    });
    expect(index.measure("missing", 1, 80, 20)).toMatchObject({
      accepted: false,
      scrollAdjustment: 0,
    });
  });

  it("keeps a 2,000-message window bounded to visible rows plus eight on each side", () => {
    const index = new TranscriptHeightIndex();
    index.setItems(items(2_000, 60));

    const window = index.windowForViewport(60_000, 600);
    expect(window).toEqual({
      virtualized: true,
      visibleStartIndex: 1_000,
      visibleEndIndex: 1_010,
      startIndex: 992,
      endIndex: 1_018,
      topSpacerHeight: 59_520,
      bottomSpacerHeight: 58_920,
      totalHeight: 120_000,
    });
    expect(window.endIndex - window.startIndex).toBe(10 + (2 * TRANSCRIPT_OVERSCAN));
  });

  it("bounds overscan at the beginning and end of the transcript", () => {
    const index = new TranscriptHeightIndex();
    index.setItems(items(100, 10));

    expect(index.windowForViewport(0, 20)).toMatchObject({
      visibleStartIndex: 0,
      visibleEndIndex: 2,
      startIndex: 0,
      endIndex: 10,
    });
    expect(index.windowForViewport(980, 20)).toMatchObject({
      visibleStartIndex: 98,
      visibleEndIndex: 100,
      startIndex: 90,
      endIndex: 100,
    });
  });

  it("rejects malformed descriptors and duplicate keys", () => {
    const index = new TranscriptHeightIndex();
    expect(() => index.setItems([item("", 40)])).toThrow("must not be empty");
    expect(() => index.setItems([item("same", 40), item("same", 40)])).toThrow("Duplicate");
    expect(() => index.setItems([item("bad", 0)])).toThrow("invalid estimated height");
  });
});

function items(count: number, estimatedHeight: number): HeightIndexItem[] {
  return Array.from({ length: count }, (_, index) => item(`message-${index}`, estimatedHeight));
}

function item(key: string, estimatedHeight: number, revision = 1): HeightIndexItem {
  return Object.freeze({ key, revision, estimatedHeight });
}

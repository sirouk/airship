export const TRANSCRIPT_VIRTUALIZATION_THRESHOLD = 60;
export const TRANSCRIPT_OVERSCAN = 8;
export const ASSISTANT_MESSAGE_ESTIMATE = 96;
export const USER_MESSAGE_ESTIMATE = 60;

export type TranscriptItemRevision = string | number;

export type HeightIndexItem = Readonly<{
  key: string;
  revision: TranscriptItemRevision;
  estimatedHeight: number;
}>;

export type TranscriptWindow = Readonly<{
  virtualized: boolean;
  visibleStartIndex: number;
  visibleEndIndex: number;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
}>;

export type HeightMeasurementResult = Readonly<{
  accepted: boolean;
  changed: boolean;
  index: number;
  previousHeight: number;
  measuredHeight: number;
  delta: number;
  scrollAdjustment: number;
}>;

type CachedHeight = Readonly<{
  revision: TranscriptItemRevision;
  height: number;
}>;

const NO_DIRTY_PREFIX = Number.POSITIVE_INFINITY;

/**
 * Cumulative variable-height index for the transcript window.
 *
 * Measurements survive reorderings while an item's key and revision remain
 * stable. Removed items and superseded revisions are pruned on `setItems`, so
 * a long streaming session cannot leave an unbounded measurement history.
 */
export class TranscriptHeightIndex {
  private items: HeightIndexItem[] = [];
  private positions = new Map<string, number>();
  private measurements = new Map<string, CachedHeight>();
  private heights: number[] = [];
  private prefix: number[] = [0];
  private dirtyPrefixFrom = NO_DIRTY_PREFIX;

  get itemCount(): number {
    return this.items.length;
  }

  get measurementCount(): number {
    return this.measurements.size;
  }

  setItems(nextItems: readonly HeightIndexItem[]): void {
    const items: HeightIndexItem[] = [];
    const positions = new Map<string, number>();

    for (let index = 0; index < nextItems.length; index += 1) {
      const item = nextItems[index]!;
      validateItem(item);
      if (positions.has(item.key)) throw new Error(`Duplicate transcript item key: ${item.key}`);
      const copy = Object.freeze({ ...item });
      items.push(copy);
      positions.set(copy.key, index);
    }

    for (const [key, cached] of this.measurements) {
      const position = positions.get(key);
      const item = position === undefined ? undefined : items[position];
      if (!item || !Object.is(item.revision, cached.revision)) this.measurements.delete(key);
    }

    this.items = items;
    this.positions = positions;
    this.heights = items.map((item) => this.measurements.get(item.key)?.height ?? item.estimatedHeight);
    this.prefix = new Array(items.length + 1).fill(0);
    this.dirtyPrefixFrom = 0;
  }

  /** Returns the current estimated or measured height for one item. */
  heightAt(index: number): number {
    assertItemIndex(index, this.items.length);
    return this.heights[index]!;
  }

  /** Returns the cumulative offset at an item boundary, including the end. */
  offsetAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.items.length) {
      throw new RangeError(`Transcript boundary index ${String(index)} is out of range.`);
    }
    this.ensurePrefix();
    return this.prefix[index]!;
  }

  totalHeight(): number {
    return this.offsetAt(this.items.length);
  }

  /**
   * Finds the item containing a virtual offset with a binary search over
   * cumulative heights. An offset on a boundary belongs to the following row.
   */
  indexAtOffset(offset: number): number {
    if (this.items.length === 0) return -1;
    this.ensurePrefix();
    const total = this.prefix[this.items.length]!;
    const target = finiteNonNegative(offset);
    if (target >= total) return this.items.length - 1;

    let low = 0;
    let high = this.items.length - 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.prefix[middle + 1]! <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  windowForViewport(scrollTop: number, viewportHeight: number): TranscriptWindow {
    const count = this.items.length;
    if (count === 0) return emptyWindow();

    this.ensurePrefix();
    const top = finiteNonNegative(scrollTop);
    const height = finiteNonNegative(viewportHeight);
    const visibleStartIndex = this.indexAtOffset(top);
    const visibleBottom = top + height;
    const visibleEndIndex = height === 0
      ? Math.min(count, visibleStartIndex + 1)
      : Math.max(visibleStartIndex + 1, this.firstIndexStartingAtOrAfter(visibleBottom));
    const virtualized = count > TRANSCRIPT_VIRTUALIZATION_THRESHOLD;
    const startIndex = virtualized
      ? Math.max(0, visibleStartIndex - TRANSCRIPT_OVERSCAN)
      : 0;
    const endIndex = virtualized
      ? Math.min(count, visibleEndIndex + TRANSCRIPT_OVERSCAN)
      : count;
    const totalHeight = this.prefix[count]!;

    return Object.freeze({
      virtualized,
      visibleStartIndex,
      visibleEndIndex,
      startIndex,
      endIndex,
      topSpacerHeight: this.prefix[startIndex]!,
      bottomSpacerHeight: totalHeight - this.prefix[endIndex]!,
      totalHeight,
    });
  }

  /**
   * Records a measured border-box height. The returned scroll adjustment keeps
   * the same visible anchor in place when a row strictly above it changes.
   */
  measure(
    key: string,
    revision: TranscriptItemRevision,
    measuredHeight: number,
    anchorIndex: number,
  ): HeightMeasurementResult {
    const index = this.positions.get(key);
    if (index === undefined) return rejectedMeasurement(measuredHeight);
    const item = this.items[index]!;
    if (
      !Object.is(item.revision, revision) ||
      !Number.isFinite(measuredHeight) ||
      measuredHeight <= 0
    ) {
      return rejectedMeasurement(measuredHeight);
    }

    const previousHeight = this.heights[index]!;
    const delta = measuredHeight - previousHeight;
    this.measurements.set(key, Object.freeze({ revision, height: measuredHeight }));
    if (delta === 0) {
      return Object.freeze({
        accepted: true,
        changed: false,
        index,
        previousHeight,
        measuredHeight,
        delta: 0,
        scrollAdjustment: 0,
      });
    }

    this.heights[index] = measuredHeight;
    this.dirtyPrefixFrom = Math.min(this.dirtyPrefixFrom, index + 1);
    return Object.freeze({
      accepted: true,
      changed: true,
      index,
      previousHeight,
      measuredHeight,
      delta,
      scrollAdjustment: index < normalizedAnchorIndex(anchorIndex, this.items.length) ? delta : 0,
    });
  }

  private firstIndexStartingAtOrAfter(offset: number): number {
    const target = finiteNonNegative(offset);
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.prefix[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private ensurePrefix(): void {
    if (this.dirtyPrefixFrom === NO_DIRTY_PREFIX) return;
    const start = Math.max(1, this.dirtyPrefixFrom);
    this.prefix[0] = 0;
    for (let boundary = start; boundary <= this.heights.length; boundary += 1) {
      this.prefix[boundary] = this.prefix[boundary - 1]! + this.heights[boundary - 1]!;
    }
    this.dirtyPrefixFrom = NO_DIRTY_PREFIX;
  }
}

function validateItem(item: HeightIndexItem): void {
  if (!item.key) throw new Error("Transcript item keys must not be empty.");
  if (!Number.isFinite(item.estimatedHeight) || item.estimatedHeight <= 0) {
    throw new Error(`Transcript item ${item.key} has an invalid estimated height.`);
  }
  if (typeof item.revision !== "string" && typeof item.revision !== "number") {
    throw new Error(`Transcript item ${item.key} has an invalid revision.`);
  }
  if (typeof item.revision === "number" && !Number.isFinite(item.revision)) {
    throw new Error(`Transcript item ${item.key} has an invalid revision.`);
  }
}

function assertItemIndex(index: number, count: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`Transcript item index ${String(index)} is out of range.`);
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizedAnchorIndex(value: number, count: number): number {
  if (!Number.isSafeInteger(value)) return 0;
  return Math.min(count, Math.max(0, value));
}

function rejectedMeasurement(measuredHeight: number): HeightMeasurementResult {
  return Object.freeze({
    accepted: false,
    changed: false,
    index: -1,
    previousHeight: 0,
    measuredHeight,
    delta: 0,
    scrollAdjustment: 0,
  });
}

function emptyWindow(): TranscriptWindow {
  return Object.freeze({
    virtualized: false,
    visibleStartIndex: 0,
    visibleEndIndex: 0,
    startIndex: 0,
    endIndex: 0,
    topSpacerHeight: 0,
    bottomSpacerHeight: 0,
    totalHeight: 0,
  });
}

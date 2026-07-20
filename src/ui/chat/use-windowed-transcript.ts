import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  TranscriptHeightIndex,
  type HeightIndexItem,
  type TranscriptItemRevision,
  type TranscriptWindow,
} from "./height-index";

export type TranscriptScrollRef = Readonly<{
  current: HTMLElement | null;
}>;

export type UseWindowedTranscriptOptions<T> = Readonly<{
  items: readonly T[];
  scrollContainerRef: TranscriptScrollRef;
  getKey: (item: T) => string;
  getRevision: (item: T) => TranscriptItemRevision;
  estimateHeight: (item: T) => number;
  leadingOffset?: number;
}>;

export type WindowedTranscriptEntry<T> = Readonly<{
  item: T;
  index: number;
  key: string;
  revision: TranscriptItemRevision;
}>;

export type WindowedTranscriptResult<T> = TranscriptWindow & Readonly<{
  entries: readonly WindowedTranscriptEntry<T>[];
  observeElement: (
    key: string,
    revision: TranscriptItemRevision,
    element: Element | null,
  ) => void;
  offsetForIndex: (index: number) => number;
}>;

type ViewportState = Readonly<{
  scrollTop: number;
  viewportHeight: number;
}>;

type ElementMetadata = Readonly<{
  key: string;
  revision: TranscriptItemRevision;
}>;

type PendingMeasurement = ElementMetadata & Readonly<{
  height: number;
}>;

const EMPTY_VIEWPORT: ViewportState = Object.freeze({ scrollTop: 0, viewportHeight: 0 });

/**
 * Variable-height transcript windowing with a measured-height cache.
 *
 * The hook owns no message state and introduces no scheduling dependency beyond
 * Preact and browser primitives. It applies scroll-anchor compensation when a
 * mounted overscan row above the first visible row changes height.
 */
export function useWindowedTranscript<T>(
  options: UseWindowedTranscriptOptions<T>,
): WindowedTranscriptResult<T> {
  const { items, scrollContainerRef, getKey, getRevision, estimateHeight, leadingOffset = 0 } = options;
  const indexRef = useRef<TranscriptHeightIndex>();
  if (!indexRef.current) indexRef.current = new TranscriptHeightIndex();

  const descriptors = useMemo<readonly HeightIndexItem[]>(() => items.map((item) => Object.freeze({
    key: getKey(item),
    revision: getRevision(item),
    estimatedHeight: estimateHeight(item),
  })), [estimateHeight, getKey, getRevision, items]);
  const indexedDescriptors = useRef<readonly HeightIndexItem[]>();
  if (indexedDescriptors.current !== descriptors) {
    indexRef.current.setItems(descriptors);
    indexedDescriptors.current = descriptors;
  }

  const [viewport, setViewport] = useState<ViewportState>(EMPTY_VIEWPORT);
  const [, setMeasurementEpoch] = useState(0);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const observerRef = useRef<ResizeObserver>();
  const elementsByKey = useRef(new Map<string, Element>());
  const metadataByElement = useRef(new WeakMap<Element, ElementMetadata>());

  const commitMeasurements = useCallback((pending: readonly PendingMeasurement[]): void => {
    if (pending.length === 0) return;
    const index = indexRef.current!;
    const currentViewport = viewportRef.current;
    const anchorIndex = index.indexAtOffset(Math.max(0, currentViewport.scrollTop - leadingOffset));
    let scrollAdjustment = 0;
    let changed = false;

    for (const measurement of pending) {
      const result = index.measure(
        measurement.key,
        measurement.revision,
        measurement.height,
        anchorIndex,
      );
      if (!result.changed) continue;
      changed = true;
      scrollAdjustment += result.scrollAdjustment;
    }
    if (!changed) return;

    const scrollElement = scrollContainerRef.current;
    if (scrollElement && scrollAdjustment !== 0) scrollElement.scrollTop += scrollAdjustment;
    if (scrollElement) {
      const nextViewport = viewportSnapshot(scrollElement);
      viewportRef.current = nextViewport;
      setViewport((current) => sameViewport(current, nextViewport) ? current : nextViewport);
    }
    setMeasurementEpoch((value) => value + 1);
  }, [leadingOffset, scrollContainerRef]);

  const observeElement = useCallback((
    key: string,
    revision: TranscriptItemRevision,
    element: Element | null,
  ): void => {
    const previous = elementsByKey.current.get(key);
    if (!element) {
      const previousMetadata = previous ? metadataByElement.current.get(previous) : undefined;
      if (previous && previousMetadata && Object.is(previousMetadata.revision, revision)) {
        observerRef.current?.unobserve(previous);
        elementsByKey.current.delete(key);
        metadataByElement.current.delete(previous);
      }
      return;
    }

    if (previous && previous !== element) {
      observerRef.current?.unobserve(previous);
      metadataByElement.current.delete(previous);
    }
    const metadata = Object.freeze({ key, revision });
    elementsByKey.current.set(key, element);
    metadataByElement.current.set(element, metadata);
    observerRef.current?.observe(element);
  }, []);

  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const pendingByKey = new Map<string, PendingMeasurement>();
    let measurementFrame: number | undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const metadata = metadataByElement.current.get(entry.target);
        if (!metadata) continue;
        const borderBoxHeight = entry.borderBoxSize[0]?.blockSize;
        const height = borderBoxHeight && Number.isFinite(borderBoxHeight)
          ? borderBoxHeight
          : entry.target.getBoundingClientRect().height;
        pendingByKey.set(metadata.key, { ...metadata, height });
      }
      // ResizeObserver callbacks run inside the browser's resize-delivery
      // phase. Deferring Preact state and scroll-anchor writes to the next
      // frame prevents a measurement -> layout -> measurement feedback loop.
      if (measurementFrame === undefined && pendingByKey.size > 0) {
        measurementFrame = requestFrame(() => {
          measurementFrame = undefined;
          const pending = [...pendingByKey.values()];
          pendingByKey.clear();
          commitMeasurements(pending);
        });
      }
    });
    observerRef.current = observer;
    for (const element of elementsByKey.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (measurementFrame !== undefined) cancelFrame(measurementFrame);
      pendingByKey.clear();
      if (observerRef.current === observer) observerRef.current = undefined;
    };
  }, [commitMeasurements]);

  useLayoutEffect(() => {
    const liveKeys = new Set(descriptors.map((descriptor) => descriptor.key));
    for (const [key, element] of elementsByKey.current) {
      if (liveKeys.has(key)) continue;
      observerRef.current?.unobserve(element);
      metadataByElement.current.delete(element);
      elementsByKey.current.delete(key);
    }

    const pending = descriptors.flatMap((descriptor): PendingMeasurement[] => {
      const element = elementsByKey.current.get(descriptor.key);
      if (!element) return [];
      const metadata = Object.freeze({ key: descriptor.key, revision: descriptor.revision });
      metadataByElement.current.set(element, metadata);
      return [{ ...metadata, height: element.getBoundingClientRect().height }];
    });
    commitMeasurements(pending);
  }, [commitMeasurements, descriptors]);

  useLayoutEffect(() => {
    const scrollElement = scrollContainerRef.current;
    if (!scrollElement) return;
    let frame: number | undefined;

    const readViewport = () => {
      frame = undefined;
      const nextViewport = viewportSnapshot(scrollElement);
      viewportRef.current = nextViewport;
      setViewport((current) => sameViewport(current, nextViewport) ? current : nextViewport);
    };
    const scheduleViewportRead = () => {
      if (frame !== undefined) return;
      frame = requestFrame(readViewport);
    };

    readViewport();
    scrollElement.addEventListener("scroll", scheduleViewportRead, { passive: true });
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(scheduleViewportRead)
      : undefined;
    resizeObserver?.observe(scrollElement);
    return () => {
      scrollElement.removeEventListener("scroll", scheduleViewportRead);
      resizeObserver?.disconnect();
      if (frame !== undefined) cancelFrame(frame);
    };
  }, [scrollContainerRef]);

  const window = indexRef.current.windowForViewport(
    Math.max(0, viewport.scrollTop - leadingOffset),
    viewport.viewportHeight,
  );
  const entries = useMemo<readonly WindowedTranscriptEntry<T>[]>(() => Object.freeze(
    items.slice(window.startIndex, window.endIndex).map((item, offset) => {
      const index = window.startIndex + offset;
      const descriptor = descriptors[index]!;
      return Object.freeze({
        item,
        index,
        key: descriptor.key,
        revision: descriptor.revision,
      });
    }),
  ), [descriptors, items, window.endIndex, window.startIndex]);
  const offsetForIndex = useCallback(
    (index: number) => leadingOffset + indexRef.current!.offsetAt(index),
    [leadingOffset],
  );

  return Object.freeze({
    ...window,
    entries,
    observeElement,
    offsetForIndex,
  });
}

function viewportSnapshot(element: HTMLElement): ViewportState {
  return Object.freeze({
    scrollTop: finiteNonNegative(element.scrollTop),
    viewportHeight: finiteNonNegative(element.clientHeight),
  });
}

function sameViewport(left: ViewportState, right: ViewportState): boolean {
  return left.scrollTop === right.scrollTop && left.viewportHeight === right.viewportHeight;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  else globalThis.clearTimeout(frame);
}

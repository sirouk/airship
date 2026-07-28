import { describe, expect, it } from "vitest";
import {
  SCROLL_EDGE_EPSILON,
  observeScrollEdges,
  scrollEdges,
  type ScrollAffordanceElement,
} from "./scroll-affordance";

describe("scrollEdges", () => {
  it("reports no affordance when the content fits", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toBe("none");
  });

  it("treats a sub-pixel overflow as not scrollable", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 400.6, clientHeight: 400 })).toBe("none");
  });

  it("reports a trailing edge while resting at the top of a taller rail", () => {
    // Measured 1440x800 sidebar geometry: 785px of nav inside a 602px box.
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 785, clientHeight: 602 })).toBe("end");
  });

  it("reports both edges mid-scroll", () => {
    expect(scrollEdges({ scrollTop: 90, scrollHeight: 785, clientHeight: 602 })).toBe("both");
  });

  it("reports only the leading edge at rest against the bottom", () => {
    expect(scrollEdges({ scrollTop: 183, scrollHeight: 785, clientHeight: 602 })).toBe("start");
    expect(scrollEdges({ scrollTop: 183 - SCROLL_EDGE_EPSILON, scrollHeight: 785, clientHeight: 602 })).toBe("start");
  });

  it("never paints an affordance on non-finite geometry", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: Number.NaN, clientHeight: 602 })).toBe("none");
    expect(scrollEdges({ scrollTop: Number.NaN, scrollHeight: 785, clientHeight: 602 })).toBe("end");
  });
});

describe("observeScrollEdges", () => {
  it("publishes the initial state and each distinct transition exactly once", () => {
    const element = stubElement({ scrollTop: 0, scrollHeight: 785, clientHeight: 602 });
    const view = stubView();
    const seen: string[] = [];
    const stop = observeScrollEdges(element.node, (edges) => seen.push(edges), view.node);
    expect(seen).toEqual(["end"]);

    element.scrollTo(90);
    element.scrollTo(120);
    expect(seen).toEqual(["end", "both"]);

    element.scrollTo(183);
    expect(seen).toEqual(["end", "both", "start"]);

    stop();
    element.scrollTo(0);
    expect(seen).toEqual(["end", "both", "start"]);
    expect(element.listeners()).toBe(0);
    expect(view.listeners()).toBe(0);
  });

  it("re-reports when the box shrinks without a scroll event", () => {
    const element = stubElement({ scrollTop: 0, scrollHeight: 785, clientHeight: 785 });
    const view = stubView();
    const seen: string[] = [];
    observeScrollEdges(element.node, (edges) => seen.push(edges), view.node);
    expect(seen).toEqual(["none"]);

    element.resizeTo(602);
    view.emitResize();
    expect(seen).toEqual(["none", "end"]);
  });

  it("runs without a box observer and still tracks scrolling", () => {
    const element = stubElement({ scrollTop: 0, scrollHeight: 785, clientHeight: 602 });
    const seen: string[] = [];
    const stop = observeScrollEdges(element.node, (edges) => seen.push(edges), undefined);
    element.scrollTo(183);
    stop();
    expect(seen).toEqual(["end", "start"]);
  });

  // Content growth — an expanded conversation group — changes overflow without
  // firing either a scroll or a resize event, so the box observer is the only
  // signal. The window-resize test above cannot exercise this path.
  it("re-reports when observed content grows with no scroll or resize event", () => {
    const element = stubElement({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
    const observer = stubResizeObserver();
    const view = stubView(observer.Constructor);
    const seen: string[] = [];
    const stop = observeScrollEdges(element.node, (edges) => seen.push(edges), view.node);
    expect(seen).toEqual(["none"]);

    element.growTo(785);
    expect(seen).toEqual(["none"]);
    observer.emit();
    expect(seen).toEqual(["none", "end"]);

    stop();
    expect(observer.constructions()).toBe(1);
    expect(observer.disconnects()).toBe(1);
  });

  it("observes the scroll box and each of its groups, not just the box", () => {
    const groups = [element("group-a"), element("group-b")];
    const box = stubElement({ scrollTop: 0, scrollHeight: 785, clientHeight: 602 }, groups);
    const observer = stubResizeObserver();
    const stop = observeScrollEdges(box.node, () => {}, stubView(observer.Constructor).node);
    expect(observer.observed()).toEqual([box.node, ...groups]);
    stop();
  });
});

function stubElement(
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
  children: readonly Element[] = [],
) {
  const listeners = new Set<() => void>();
  const node: ScrollAffordanceElement = {
    ...geometry,
    children,
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  const mutable = node as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
  return {
    node,
    listeners: () => listeners.size,
    scrollTo(top: number) {
      mutable.scrollTop = top;
      for (const listener of listeners) listener();
    },
    resizeTo(clientHeight: number) {
      mutable.clientHeight = clientHeight;
    },
    /** Content growth emits no scroll or resize event; only the box observer sees it. */
    growTo(scrollHeight: number) {
      mutable.scrollHeight = scrollHeight;
    },
  };
}

/** A distinguishable stand-in for a child group; only its identity is read. */
function element(name: string): Element {
  return { name } as unknown as Element;
}

function stubView(Observer?: typeof ResizeObserver) {
  const listeners = new Set<() => void>();
  return {
    node: {
      addEventListener: (_type: "resize", listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: "resize", listener: () => void) => void listeners.delete(listener),
      ...(Observer ? { ResizeObserver: Observer } : {}),
    },
    listeners: () => listeners.size,
    emitResize() {
      for (const listener of listeners) listener();
    },
  };
}

/**
 * A ResizeObserver the test drives by hand. The runtime has none, so without
 * this the box-observer branch of `observeScrollEdges` never runs at all.
 */
function stubResizeObserver() {
  const observed: Element[] = [];
  let callbacks = 0;
  let disconnects = 0;
  let notify: ResizeObserverCallback | undefined;
  class Stub implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks += 1;
      notify = callback;
    }
    observe(target: Element): void { observed.push(target); }
    unobserve(target: Element): void { observed.splice(observed.indexOf(target), 1); }
    disconnect(): void { disconnects += 1; }
  }
  return {
    Constructor: Stub,
    observed: (): readonly unknown[] => observed,
    constructions: () => callbacks,
    disconnects: () => disconnects,
    emit() {
      if (!notify) throw new Error("observeScrollEdges never constructed the box observer.");
      notify([], this.Constructor.prototype as unknown as ResizeObserver);
    },
  };
}

import { describe, expect, it } from "vitest";
import {
  bindCanvasInteractions,
  calculateMemoryGraphBounds,
  centeredMemoryGraphViewport,
  canvasToGraphPoint,
  createMemoryNodeSpatialIndex,
  createViewportControls,
  drawNodeLabels,
  fitMemoryGraphViewport,
  graphToCanvasPoint,
  hitTestMemoryNode,
  memoryGraphViewportBounds,
  panMemoryGraphViewport,
  queryMemoryNodeSpatialIndex,
  zoomMemoryGraphViewport,
  type CanvasEngine,
} from "./canvas-renderer";
import type { MemoryGraphNode } from "./types";

function node(id: string, x: number, y: number, size = 5): MemoryGraphNode {
  return {
    id,
    kind: "term",
    key: id,
    label: id,
    metadata: {},
    size,
    color: "#fff",
    x,
    y,
  };
}

describe("Canvas memory graph viewport", () => {
  it("centers a selected node without changing scale or dimensions", () => {
    const viewport = { centerX: 0, centerY: 0, scale: 2, width: 800, height: 600 };
    expect(centeredMemoryGraphViewport(viewport, { x: 14, y: -9 })).toEqual({ ...viewport, centerX: 14, centerY: -9 });
  });
  it("fits finite graph bounds and round-trips graph coordinates", () => {
    const bounds = calculateMemoryGraphBounds([node("left", -5, -2), node("right", 5, 2)]);
    const viewport = fitMemoryGraphViewport(bounds, 1_000, 500, 50);

    expect(viewport).toMatchObject({ centerX: 0, centerY: 0, width: 1_000, height: 500, scale: 90 });
    expect(graphToCanvasPoint({ x: -5, y: 0 }, viewport)).toEqual({ x: 50, y: 250 });
    const point = { x: 2.25, y: -1.5 };
    const roundTrip = canvasToGraphPoint(graphToCanvasPoint(point, viewport), viewport);
    expect(roundTrip.x).toBeCloseTo(point.x, 12);
    expect(roundTrip.y).toBeCloseTo(point.y, 12);
  });

  it("keeps the graph coordinate under the pointer fixed while zooming", () => {
    const viewport = fitMemoryGraphViewport({ minX: -5, minY: -5, maxX: 5, maxY: 5 }, 800, 600);
    const anchor = { x: 173, y: 411 };
    const before = canvasToGraphPoint(anchor, viewport);
    const zoomed = zoomMemoryGraphViewport(viewport, anchor, 2, viewport.scale / 2, viewport.scale * 4);
    const after = canvasToGraphPoint(anchor, zoomed);

    expect(zoomed.scale).toBe(viewport.scale * 2);
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
    expect(graphToCanvasPoint({ x: 0, y: 0 }, panMemoryGraphViewport(viewport, 20, -10))).toEqual({
      x: 420,
      y: 290,
    });
  });

  it("derives padded graph-space bounds for viewport culling", () => {
    expect(memoryGraphViewportBounds({ centerX: 2, centerY: -1, scale: 100, width: 200, height: 100 }, 10)).toEqual({
      minX: 0.9,
      minY: -1.6,
      maxX: 3.1,
      maxY: -0.4,
    });
  });
});

describe("Canvas memory graph spatial index", () => {
  it("queries only intersecting grid cells and excludes out-of-bounds nodes", () => {
    const nodes = [
      node("origin", 0, 0),
      node("near", 0.4, 0.3),
      node("same-cell-outside", 1.2, 1.2),
      node("far", 20, -20),
    ];
    const index = createMemoryNodeSpatialIndex(nodes, 2);
    const found = queryMemoryNodeSpatialIndex(index, { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 });

    expect(found.map((candidate) => candidate.id).sort()).toEqual(["near", "origin"]);
    expect(index.cells.size).toBeLessThan(nodes.length);
  });

  it("hit-tests a local candidate set in screen-pixel distance", () => {
    const index = createMemoryNodeSpatialIndex([
      node("small", 0, 0, 4),
      node("large", 0.5, 0, 10),
      node("remote", 100, 100, 40),
    ]);

    expect(hitTestMemoryNode(index, { x: 0.02, y: 0 }, 100)?.id).toBe("small");
    expect(hitTestMemoryNode(index, { x: 0.48, y: 0 }, 100)?.id).toBe("large");
    expect(hitTestMemoryNode(index, { x: 3, y: 3 }, 100)).toBeUndefined();
  });
});

/**
 * Zoom must be reachable by more than a wheel.
 *
 * The surface itself needs a browser, so the engine is driven directly here:
 * what actually broke on touch was the gesture arithmetic and the single-slot
 * pointer record, and both are assertable without a DOM.
 */
describe("Canvas memory graph gestures", () => {
  it("scales about the two-pointer midpoint and holds that graph coordinate still", () => {
    const harness = mountEngine();
    const { engine } = harness;
    harness.dispatch("pointerdown", { pointerId: 1, clientX: 300, clientY: 300 });
    harness.dispatch("pointerdown", { pointerId: 2, clientX: 500, clientY: 300 });
    // The anchor is the midpoint the second move produces: 300 and 700.
    const anchor = { x: 500, y: 300 };
    const before = canvasToGraphPoint(anchor, engine.viewport);

    harness.dispatch("pointermove", { pointerId: 2, clientX: 700, clientY: 300 });

    expect(engine.viewport.scale).toBeCloseTo(engine.fittedScale * 2, 6);
    const after = canvasToGraphPoint(anchor, engine.viewport);
    expect(Math.abs(after.x - before.x) * engine.viewport.scale).toBeLessThan(1);
    expect(Math.abs(after.y - before.y) * engine.viewport.scale).toBeLessThan(1);
    harness.release();
  });

  it("clamps a runaway pinch to the fitted scale range", () => {
    const harness = mountEngine();
    const { engine } = harness;
    harness.dispatch("pointerdown", { pointerId: 1, clientX: 380, clientY: 300 });
    harness.dispatch("pointerdown", { pointerId: 2, clientX: 420, clientY: 300 });

    for (let step = 1; step <= 10; step += 1) {
      harness.dispatch("pointermove", { pointerId: 2, clientX: 420 + step * 200, clientY: 300 });
    }
    expect(engine.viewport.scale).toBeCloseTo(engine.fittedScale * 16, 6);

    for (let step = 1; step <= 10; step += 1) {
      harness.dispatch("pointermove", { pointerId: 2, clientX: 380 + 2_000 / 2 ** step, clientY: 300 });
    }
    expect(engine.viewport.scale).toBeCloseTo(engine.fittedScale * 0.35, 6);
    harness.release();
  });

  it("never reads a pinch as a tap-to-select when a finger lifts", () => {
    const harness = mountEngine();
    harness.dispatch("pointerdown", { pointerId: 1, clientX: 300, clientY: 300 });
    harness.dispatch("pointerdown", { pointerId: 2, clientX: 500, clientY: 300 });
    harness.dispatch("pointermove", { pointerId: 2, clientX: 560, clientY: 300 });
    harness.dispatch("pointerup", { pointerId: 2, clientX: 560, clientY: 300 });
    harness.dispatch("pointerup", { pointerId: 1, clientX: 300, clientY: 300 });

    expect(harness.selections).toEqual([]);
    expect(harness.engine.pointers.size).toBe(0);
    expect(harness.engine.pinchDistance).toBeUndefined();
    harness.release();
  });

  it("returns a zoomed viewport to the fit through the published controls", () => {
    const harness = mountEngine();
    const controls = createViewportControls(harness.engine);
    const fitted = fitMemoryGraphViewport(
      harness.engine.bounds,
      harness.engine.viewport.width,
      harness.engine.viewport.height,
    );

    controls.zoomIn();
    expect(controls.scale()).toBeGreaterThan(fitted.scale);
    controls.zoomOut();
    controls.zoomOut();
    expect(controls.scale()).toBeLessThan(fitted.scale);

    controls.fit();
    expect(harness.engine.viewport).toEqual(fitted);
    expect(harness.engine.userViewport).toBe(false);
    harness.release();
  });
});

/**
 * Where the labels land, which is the half of the graph a still frame judges.
 *
 * The renderer's own collision grid is what decides this, and it was quantising
 * each label's *centre* into one 16px row: two labels four pixels apart claimed
 * adjacent rows, agreed they did not touch, and printed through each other. The
 * arithmetic is assertable without a browser — only `measureText` and
 * `fillText` are needed — so these drive `drawNodeLabels` directly.
 */
describe("Canvas memory graph labels", () => {
  it("drops the second of two labels whose ink overlaps, rather than printing them through each other", () => {
    // The #context frame this is written from: "notes/retrieval.md" was drawn
    // four pixels below "README.md" with their spans overlapping, and both
    // words became unreadable. Four pixels is one row apart under the old
    // quantisation and no overlap at all under it.
    const harness = labelHarness([
      node("README.md", 0, 0, 8),
      node("notes/retrieval.md", -3, 4, 6),
    ]);

    drawNodeLabels(harness.engine, harness.nodes, undefined, new Set(), false);

    expect(harness.drawn).toEqual(["README.md"]);
  });

  it("keeps both labels once their ink no longer overlaps, which one row per centre could not tell", () => {
    // Fifteen pixels apart: two clear, disjoint 12px bands. Both centres landed
    // in the same 16px row, so the old grid suppressed the second — the loss
    // the coarse row was quietly paying for alongside the overlap it missed.
    const harness = labelHarness([
      node("README.md", 0, -12, 7),
      node("notes/retrieval.md", -3, 3, 6),
    ]);

    drawNodeLabels(harness.engine, harness.nodes, undefined, new Set(), false);

    expect(harness.drawn).toEqual(["README.md", "notes/retrieval.md"]);
  });

  it("stops a label short of the node it would have crossed instead of erasing the name", () => {
    // "docs/architecture.md" spans x=276..396 and the "General session" node it
    // crosses is a disc over x=390..410, so the two really do overlap on the
    // canvas — while the labels themselves do not touch, which is why a
    // label-only reservation reported no collision and drew it anyway.
    //
    // Refusing it outright was the over-correction: on phone-320 that left all
    // three workspace files as bare squares with no name anywhere on screen. It
    // is the CROSSING that has to stop, not the naming, so the label is cut to
    // the room in front of the disc and keeps saying which file this is.
    const harness = labelHarness([
      node("General session", 0, 0, 10),
      node("docs/architecture.md", -136, 0, 6),
    ]);

    drawNodeLabels(harness.engine, harness.nodes, undefined, new Set(), false);

    expect(harness.drawn).toEqual(["General session", "docs/architectur…"]);
    const stub = harness.calls[1]!;
    // Ends before the disc at x=390 — cut short of it, not printed over it.
    expect(stub.x + stub.width).toBeLessThan(390);
  });

  it("cuts an oversized label to fit rather than condensing it into micro-type", () => {
    // tablet-768: `fillText`'s maxWidth argument does not drop characters, it
    // squeezes them. This 83-character preview measures 498px here and was
    // asked to occupy 190 — 2px-wide letters at full height, a sentence-shaped
    // smear across the graph body. The cut has to happen in the string.
    const harness = labelHarness([
      node("assistant: The edge runtime is ready. The workspace, editor, terminal and browser-…", 0, 0, 8),
    ]);

    drawNodeLabels(harness.engine, harness.nodes, undefined, new Set(), false);

    expect(harness.drawn).toEqual(["assistant: The edge runtime is…"]);
    // Three arguments: no maxWidth reaches the canvas, so nothing can condense.
    expect(harness.calls[0]!.argumentCount).toBe(3);
    expect(harness.calls[0]!.width).toBeLessThanOrEqual(190);
  });

  it("never lets a cut-down label take room from one already placed at full width", () => {
    // The cost of the second pass, measured rather than asserted. "term" is the
    // lowest-priority node here and its full label lands inside the gap the
    // refused "docs/architecture.md" would want. The full-width pass finishes
    // first, so "term" is placed whole and the gap left for the stub is 3px —
    // under the floor, so no stub is drawn. Recovering a name never costs one.
    const harness = labelHarness([
      node("General session", 0, 0, 10),
      node("docs/architecture.md", -136, 0, 7),
      node("term", -111, 0, 6),
    ]);

    drawNodeLabels(harness.engine, harness.nodes, undefined, new Set(), false);

    expect(harness.drawn).toEqual(["General session", "term"]);
  });
});

/**
 * The 2D context reduced to what label placement asks of it. `measureText`
 * returns six pixels per character — close enough to the 11px face to make the
 * spans in these cases the spans the product had.
 */
function labelHarness(nodes: readonly MemoryGraphNode[]) {
  const drawn: string[] = [];
  // Where each label landed and how it was asked for: a fourth argument to
  // `fillText` is the condensing one, so the count is worth keeping.
  const calls: { text: string; x: number; width: number; argumentCount: number }[] = [];
  const measure = (text: string) => text.length * 6;
  const context = {
    font: "",
    textBaseline: "",
    fillStyle: "",
    globalAlpha: 1,
    measureText: (text: string) => ({ width: measure(text) }),
    fillText: (...args: [text: string, x: number, y: number, maxWidth?: number]) => {
      drawn.push(args[0]);
      calls.push({ text: args[0], x: args[1], width: measure(args[0]), argumentCount: args.length });
    },
  } as unknown as CanvasRenderingContext2D;
  const engine = {
    context,
    graph: { nodes } as never,
    palette: { inkMuted: "#fff" } as never,
    viewport: { centerX: 0, centerY: 0, scale: 1, width: 800, height: 600 },
    hoverId: undefined,
  } as unknown as CanvasEngine;
  return { engine, nodes, drawn, calls };
}

/**
 * The engine without a browser: only the canvas members the interaction layer
 * touches are provided. `disposed` keeps requestAnimationFrame — and therefore
 * drawing, which does need a real 2D context — out of the way.
 */
function mountEngine() {
  const listeners = new Map<string, (event: never) => void>();
  const canvas = {
    style: { cursor: "grab" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    addEventListener: (type: string, listener: (event: never) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as HTMLCanvasElement;
  const nodes = [node("a", -5, -5), node("b", 5, 5)];
  const bounds = calculateMemoryGraphBounds(nodes);
  const viewport = fitMemoryGraphViewport(bounds, 800, 600);
  const engine: CanvasEngine = {
    canvas,
    context: {} as CanvasRenderingContext2D,
    graph: { nodes } as never,
    bounds,
    index: createMemoryNodeSpatialIndex(nodes),
    edges: [],
    palette: {} as never,
    viewport,
    fittedScale: viewport.scale,
    userViewport: false,
    dpr: 1,
    pointers: new Map(),
    reducedMotion: true,
    disposed: true,
    fail: () => undefined,
    selected: () => undefined,
    neighbors: () => new Set<string>(),
    hiddenKinds: () => new Set<string>(),
    hiddenNodeIds: () => new Set<string>(),
  };
  const selections: (string | undefined)[] = [];
  const release = bindCanvasInteractions(engine, (nodeId) => selections.push(nodeId));
  return {
    engine,
    selections,
    release,
    dispatch: (type: string, init: Readonly<{ pointerId: number; clientX: number; clientY: number }>) => {
      listeners.get(type)?.({ button: 0, preventDefault: () => undefined, ...init } as never);
    },
  };
}

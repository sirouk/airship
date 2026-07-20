import { describe, expect, it } from "vitest";
import {
  calculateMemoryGraphBounds,
  centeredMemoryGraphViewport,
  canvasToGraphPoint,
  createMemoryNodeSpatialIndex,
  fitMemoryGraphViewport,
  graphToCanvasPoint,
  hitTestMemoryNode,
  memoryGraphViewportBounds,
  panMemoryGraphViewport,
  queryMemoryNodeSpatialIndex,
  zoomMemoryGraphViewport,
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

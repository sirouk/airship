import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MemoryGraphRendererProps } from "./renderer";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryRelationshipGraph } from "./types";
import { KIND_VISUAL } from "./kind-visual";

export type CanvasPoint = Readonly<{ x: number; y: number }>;

export type MemoryGraphBounds = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

export type MemoryGraphViewport = Readonly<{
  centerX: number;
  centerY: number;
  scale: number;
  width: number;
  height: number;
}>;

export type MemoryNodeSpatialIndex = Readonly<{
  cellSize: number;
  cells: ReadonlyMap<string, readonly MemoryGraphNode[]>;
  minCellX: number;
  minCellY: number;
  maxCellX: number;
  maxCellY: number;
  maxNodeSize: number;
}>;

type SurfaceStatus = "loading" | "ready" | "empty" | "unsupported" | "error";

type RendererPalette = Readonly<{
  surfaceSoft: string;
  inkMuted: string;
  accent: string;
  signal: string;
  visualColors: Readonly<Record<string, string>>;
}>;

type PreparedEdge = Readonly<{
  edge: MemoryGraphEdge;
  source: MemoryGraphNode;
  target: MemoryGraphNode;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

type ActivePointer = {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
};

/**
 * The viewport as a command surface rather than a wheel-only affordance.
 *
 * Scale used to be reachable from exactly one input class. Everything that can
 * change it — wheel, pinch, and the route's own buttons — now goes through this
 * one handle, so a keyboard, a touch screen and assistive technology reach the
 * same clamped operation the mouse does.
 */
export type MemoryGraphViewportControls = Readonly<{
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Current scale, so a caller can report or assert what the gesture did. */
  scale: () => number;
}>;

/** One press of a zoom control. Matched to roughly three wheel notches. */
const ZOOM_STEP = 1.35;

/**
 * The widest a label may be drawn, and the narrowest stub still worth drawing.
 *
 * The floor is about six characters and the ellipsis that admits the cut. Below
 * it the text names nothing the node's own shape and colour had not already
 * said, while still spending ink, a reservation, and the reader's attention.
 */
const MAX_LABEL_WIDTH = 190;
const MIN_LABEL_WIDTH = 44;

export type CanvasEngine = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  graph: MemoryRelationshipGraph;
  bounds: MemoryGraphBounds;
  index: MemoryNodeSpatialIndex;
  edges: readonly PreparedEdge[];
  palette: RendererPalette;
  viewport: MemoryGraphViewport;
  fittedScale: number;
  userViewport: boolean;
  dpr: number;
  frame?: number;
  centerFrame?: number;
  hoverId?: string;
  /** Every pointer currently down, so a two-finger gesture is representable. */
  pointers: Map<number, ActivePointer>;
  /** Distance between the two pinching pointers at the previous move. */
  pinchDistance?: number;
  reducedMotion: boolean;
  disposed: boolean;
  fail: (error: unknown) => void;
  selected: () => string | undefined;
  neighbors: () => ReadonlySet<string>;
  hiddenKinds: () => ReadonlySet<string>;
  hiddenNodeIds: () => ReadonlySet<string>;
};

type CanvasMemoryGraphSurfaceProps = Pick<MemoryGraphRendererProps, "graph" | "selectedNodeId" | "onSelect" | "hiddenKinds" | "hiddenNodeIds" | "onViewportControls">;

export function CanvasMemoryGraphSurface({ graph, selectedNodeId, onSelect, hiddenKinds, hiddenNodeIds, onViewportControls }: CanvasMemoryGraphSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CanvasEngine>();
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const selectedRef = useRef<string | undefined>();
  const neighborIdsRef = useRef<ReadonlySet<string>>(new Set());
  const controlledRef = useRef(selectedNodeId !== undefined);
  const onSelectRef = useRef(onSelect);
  const hiddenKindsRef = useRef<ReadonlySet<string>>(hiddenKinds ?? new Set());
  const hiddenNodeIdsRef = useRef<ReadonlySet<string>>(hiddenNodeIds ?? new Set());
  const onViewportControlsRef = useRef(onViewportControls);
  onViewportControlsRef.current = onViewportControls;
  hiddenKindsRef.current = hiddenKinds ?? new Set();
  hiddenNodeIdsRef.current = hiddenNodeIds ?? new Set();
  const [internalSelection, setInternalSelection] = useState<string>();
  const [status, setStatus] = useState<SurfaceStatus>(graph.nodes.length === 0 ? "empty" : "loading");
  const [errorMessage, setErrorMessage] = useState<string>();

  const selectionCandidate = selectedNodeId ?? internalSelection;
  const effectiveSelection = selectionCandidate && graph.getNode(selectionCandidate) ? selectionCandidate : undefined;
  selectedRef.current = effectiveSelection;
  neighborIdsRef.current = new Set(effectiveSelection ? graph.getNeighbors(effectiveSelection).map((node) => node.id) : []);
  controlledRef.current = selectedNodeId !== undefined;
  onSelectRef.current = onSelect;

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.graph = graph;
    engine.bounds = calculateMemoryGraphBounds(graph.nodes);
    engine.index = createMemoryNodeSpatialIndex(graph.nodes);
    engine.edges = prepareEdges(graph);
    if (!engine.userViewport) {
      engine.viewport = fitMemoryGraphViewport(engine.bounds, engine.viewport.width, engine.viewport.height);
      engine.fittedScale = engine.viewport.scale;
    }
    requestCanvasDraw(engine);
  }, [effectiveSelection, graph.revision, hiddenKinds, hiddenNodeIds]);

  useEffect(() => {
    const engine = engineRef.current;
    const node = effectiveSelection ? graph.getNode(effectiveSelection) : undefined;
    if (!engine || !node) return;
    centerEngineOnNode(engine, node);
  }, [effectiveSelection, graph.revision]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (graph.nodes.length === 0) {
      setStatus("empty");
      return;
    }

    setStatus("loading");
    setErrorMessage(undefined);
    let engine: CanvasEngine | undefined;
    try {
      const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (!context) {
        setStatus("unsupported");
        return;
      }
      const bounds = calculateMemoryGraphBounds(graph.nodes);
      const size = measureCanvas(canvas);
      const viewport = fitMemoryGraphViewport(bounds, size.width, size.height);
      const edges = prepareEdges(graph);
      const motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
      engine = {
        canvas,
        context,
        graph,
        bounds,
        index: createMemoryNodeSpatialIndex(graph.nodes),
        edges,
        palette: readRendererPalette(canvas),
        viewport,
        fittedScale: viewport.scale,
        userViewport: false,
        dpr: 1,
        pointers: new Map(),
        reducedMotion: motionQuery?.matches ?? false,
        disposed: false,
        fail: (error) => {
          setErrorMessage(error instanceof Error ? error.message : String(error));
          setStatus("error");
        },
        selected: () => selectedRef.current,
        neighbors: () => neighborIdsRef.current,
        hiddenKinds: () => hiddenKindsRef.current,
        hiddenNodeIds: () => hiddenNodeIdsRef.current,
      };
      engineRef.current = engine;

      const emitSelection = (nodeId: string | undefined) => {
        if (!controlledRef.current) setInternalSelection(nodeId);
        selectedRef.current = nodeId;
        const currentGraph = graphRef.current;
        neighborIdsRef.current = new Set(nodeId ? currentGraph.getNeighbors(nodeId).map((node) => node.id) : []);
        requestCanvasDraw(engine);
        onSelectRef.current?.(nodeId ? currentGraph.select(nodeId) : undefined);
      };
      const removeInteractions = bindCanvasInteractions(engine, emitSelection);
      const resize = () => resizeCanvasEngine(engine!);
      let resizeFrame: number | undefined;
      const scheduleResize = () => {
        if (resizeFrame !== undefined) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = undefined;
          resize();
        });
      };
      const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleResize);
      resizeObserver?.observe(canvas);
      window.addEventListener("resize", scheduleResize, { passive: true });
      const onMotionChange = (event: MediaQueryListEvent) => {
        if (engine) engine.reducedMotion = event.matches;
      };
      motionQuery?.addEventListener?.("change", onMotionChange);
      resize();
      onViewportControlsRef.current?.(createViewportControls(engine));
      setStatus("ready");

      return () => {
        if (!engine) return;
        onViewportControlsRef.current?.(undefined);
        engine.disposed = true;
        if (engine.frame !== undefined) cancelAnimationFrame(engine.frame);
        if (engine.centerFrame !== undefined) cancelAnimationFrame(engine.centerFrame);
        removeInteractions();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", scheduleResize);
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        motionQuery?.removeEventListener?.("change", onMotionChange);
        engineRef.current = undefined;
        context.clearRect(0, 0, canvas.width, canvas.height);
      };
    } catch (error) {
      if (engine) engine.disposed = true;
      engineRef.current = undefined;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStatus("error");
    }
  }, [graph.nodes.length > 0]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        /*
         * `pan-y` rather than `none`: the canvas fills the route, so claiming
         * every touch gesture made a vertical swipe that started inside it
         * scroll nothing at all. The browser keeps vertical scrolling; zoom is
         * reached by pinch or by the viewport controls beside the graph.
         */
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "pan-y", cursor: "grab" }}
      />
      {status !== "ready" ? (
        <div role={status === "error" ? "alert" : "status"} aria-live="polite" style={STATUS_STYLE}>
          {surfaceStatusText(status, graph, errorMessage)}
        </div>
      ) : null}
      <span style={VISUALLY_HIDDEN_STYLE} aria-live="polite">
        {graph.stats.nodeCount} memory nodes and {graph.stats.edgeCount} relationships.
        {effectiveSelection ? ` Selected ${graph.getNode(effectiveSelection)?.label ?? "unknown node"}.` : ""}
      </span>
    </>
  );
}

export function calculateMemoryGraphBounds(nodes: readonly Pick<MemoryGraphNode, "x" | "y">[]): MemoryGraphBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (!isFinitePoint(node)) continue;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  if (!Number.isFinite(minX)) return { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
  if (minX === maxX) {
    minX -= 0.5;
    maxX += 0.5;
  }
  if (minY === maxY) {
    minY -= 0.5;
    maxY += 0.5;
  }
  return { minX, minY, maxX, maxY };
}

export function fitMemoryGraphViewport(
  bounds: MemoryGraphBounds,
  width: number,
  height: number,
  padding = 48,
): MemoryGraphViewport {
  const safeWidth = positiveFinite(width, 1);
  const safeHeight = positiveFinite(height, 1);
  const safePadding = Math.max(0, Math.min(positiveFinite(padding, 0), Math.min(safeWidth, safeHeight) * 0.45));
  const spanX = Math.max(0.001, bounds.maxX - bounds.minX);
  const spanY = Math.max(0.001, bounds.maxY - bounds.minY);
  const scale = Math.max(0.01, Math.min(160, (safeWidth - safePadding * 2) / spanX, (safeHeight - safePadding * 2) / spanY));
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    scale,
    width: safeWidth,
    height: safeHeight,
  };
}

export function graphToCanvasPoint(point: CanvasPoint, viewport: MemoryGraphViewport): CanvasPoint {
  return {
    x: (point.x - viewport.centerX) * viewport.scale + viewport.width / 2,
    y: (point.y - viewport.centerY) * viewport.scale + viewport.height / 2,
  };
}

export function centeredMemoryGraphViewport(viewport: MemoryGraphViewport, node: Pick<MemoryGraphNode, "x" | "y">): MemoryGraphViewport {
  return { ...viewport, centerX: node.x, centerY: node.y };
}

function centerEngineOnNode(engine: CanvasEngine, node: Pick<MemoryGraphNode, "x" | "y">): void {
  if (engine.centerFrame !== undefined) cancelAnimationFrame(engine.centerFrame);
  const start = engine.viewport;
  const target = centeredMemoryGraphViewport(start, node);
  engine.userViewport = true;
  if (engine.reducedMotion) { engine.viewport = target; requestCanvasDraw(engine); return; }
  const started = performance.now();
  const duration = 240;
  const step = (now: number) => {
    if (engine.disposed) return;
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    engine.viewport = { ...start, centerX: start.centerX + (target.centerX - start.centerX) * eased, centerY: start.centerY + (target.centerY - start.centerY) * eased };
    requestCanvasDraw(engine);
    if (progress < 1) engine.centerFrame = requestAnimationFrame(step);
    else engine.centerFrame = undefined;
  };
  engine.centerFrame = requestAnimationFrame(step);
}

export function canvasToGraphPoint(point: CanvasPoint, viewport: MemoryGraphViewport): CanvasPoint {
  return {
    x: (point.x - viewport.width / 2) / viewport.scale + viewport.centerX,
    y: (point.y - viewport.height / 2) / viewport.scale + viewport.centerY,
  };
}

export function panMemoryGraphViewport(
  viewport: MemoryGraphViewport,
  deltaX: number,
  deltaY: number,
): MemoryGraphViewport {
  return {
    ...viewport,
    centerX: viewport.centerX - finiteOr(deltaX, 0) / viewport.scale,
    centerY: viewport.centerY - finiteOr(deltaY, 0) / viewport.scale,
  };
}

export function zoomMemoryGraphViewport(
  viewport: MemoryGraphViewport,
  anchor: CanvasPoint,
  factor: number,
  minimumScale = 0.01,
  maximumScale = 2_560,
): MemoryGraphViewport {
  const graphAnchor = canvasToGraphPoint(anchor, viewport);
  const nextScale = Math.max(minimumScale, Math.min(maximumScale, viewport.scale * positiveFinite(factor, 1)));
  return {
    ...viewport,
    scale: nextScale,
    centerX: graphAnchor.x - (anchor.x - viewport.width / 2) / nextScale,
    centerY: graphAnchor.y - (anchor.y - viewport.height / 2) / nextScale,
  };
}

export function constrainMemoryGraphViewport(
  viewport: MemoryGraphViewport,
  bounds: MemoryGraphBounds,
): MemoryGraphViewport {
  const marginX = viewport.width / viewport.scale * 0.45;
  const marginY = viewport.height / viewport.scale * 0.45;
  return {
    ...viewport,
    centerX: clamp(viewport.centerX, bounds.minX - marginX, bounds.maxX + marginX),
    centerY: clamp(viewport.centerY, bounds.minY - marginY, bounds.maxY + marginY),
  };
}

export function memoryGraphViewportBounds(viewport: MemoryGraphViewport, paddingPixels = 0): MemoryGraphBounds {
  const xPadding = Math.max(0, paddingPixels) / viewport.scale;
  const yPadding = Math.max(0, paddingPixels) / viewport.scale;
  const halfWidth = viewport.width / viewport.scale / 2;
  const halfHeight = viewport.height / viewport.scale / 2;
  return {
    minX: viewport.centerX - halfWidth - xPadding,
    minY: viewport.centerY - halfHeight - yPadding,
    maxX: viewport.centerX + halfWidth + xPadding,
    maxY: viewport.centerY + halfHeight + yPadding,
  };
}

export function createMemoryNodeSpatialIndex(
  nodes: readonly MemoryGraphNode[],
  cellSize = 1.25,
): MemoryNodeSpatialIndex {
  const size = positiveFinite(cellSize, 1.25);
  const mutable = new Map<string, MemoryGraphNode[]>();
  let minCellX = Infinity;
  let minCellY = Infinity;
  let maxCellX = -Infinity;
  let maxCellY = -Infinity;
  let maxNodeSize = 0;
  for (const node of nodes) {
    if (!isFinitePoint(node)) continue;
    const cellX = Math.floor(node.x / size);
    const cellY = Math.floor(node.y / size);
    const key = spatialKey(cellX, cellY);
    const bucket = mutable.get(key);
    if (bucket) bucket.push(node);
    else mutable.set(key, [node]);
    minCellX = Math.min(minCellX, cellX);
    minCellY = Math.min(minCellY, cellY);
    maxCellX = Math.max(maxCellX, cellX);
    maxCellY = Math.max(maxCellY, cellY);
    maxNodeSize = Math.max(maxNodeSize, positiveFinite(node.size, 0));
  }
  const cells = new Map<string, readonly MemoryGraphNode[]>();
  for (const [key, bucket] of mutable) cells.set(key, bucket);
  return {
    cellSize: size,
    cells,
    minCellX: Number.isFinite(minCellX) ? minCellX : 0,
    minCellY: Number.isFinite(minCellY) ? minCellY : 0,
    maxCellX: Number.isFinite(maxCellX) ? maxCellX : -1,
    maxCellY: Number.isFinite(maxCellY) ? maxCellY : -1,
    maxNodeSize,
  };
}

export function queryMemoryNodeSpatialIndex(
  index: MemoryNodeSpatialIndex,
  bounds: MemoryGraphBounds,
): readonly MemoryGraphNode[] {
  if (index.maxCellX < index.minCellX || index.maxCellY < index.minCellY) return [];
  const minCellX = Math.max(index.minCellX, Math.floor(bounds.minX / index.cellSize));
  const minCellY = Math.max(index.minCellY, Math.floor(bounds.minY / index.cellSize));
  const maxCellX = Math.min(index.maxCellX, Math.floor(bounds.maxX / index.cellSize));
  const maxCellY = Math.min(index.maxCellY, Math.floor(bounds.maxY / index.cellSize));
  const result: MemoryGraphNode[] = [];
  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const bucket = index.cells.get(spatialKey(cellX, cellY));
      if (bucket) {
        for (const node of bucket) {
          if (node.x >= bounds.minX && node.x <= bounds.maxX && node.y >= bounds.minY && node.y <= bounds.maxY) {
            result.push(node);
          }
        }
      }
    }
  }
  return result;
}

export function hitTestMemoryNode(
  index: MemoryNodeSpatialIndex,
  point: CanvasPoint,
  scale: number,
  paddingPixels = 4,
): MemoryGraphNode | undefined {
  const safeScale = positiveFinite(scale, 1);
  const queryRadius = (index.maxNodeSize + Math.max(0, paddingPixels)) / safeScale;
  const candidates = queryMemoryNodeSpatialIndex(index, {
    minX: point.x - queryRadius,
    minY: point.y - queryRadius,
    maxX: point.x + queryRadius,
    maxY: point.y + queryRadius,
  });
  let closest: MemoryGraphNode | undefined;
  let closestDistance = Infinity;
  for (const node of candidates) {
    const x = (node.x - point.x) * safeScale;
    const y = (node.y - point.y) * safeScale;
    const distance = x * x + y * y;
    const radius = Math.max(3, node.size) + Math.max(0, paddingPixels);
    if (distance <= radius * radius && distance < closestDistance) {
      closest = node;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * Applies one clamped scale change to the engine's viewport.
 *
 * Wheel, pinch and the explicit controls all land here so no entry point can
 * drift away from the fitted-scale clamps the others obey.
 */
export function zoomEngineViewport(engine: CanvasEngine, factor: number, anchor?: CanvasPoint): void {
  engine.viewport = constrainMemoryGraphViewport(
    zoomMemoryGraphViewport(
      engine.viewport,
      anchor ?? { x: engine.viewport.width / 2, y: engine.viewport.height / 2 },
      factor,
      engine.fittedScale * 0.35,
      engine.fittedScale * 16,
    ),
    engine.bounds,
  );
  engine.userViewport = true;
  requestCanvasDraw(engine);
}

export function createViewportControls(engine: CanvasEngine): MemoryGraphViewportControls {
  return Object.freeze({
    zoomIn: () => zoomEngineViewport(engine, ZOOM_STEP),
    zoomOut: () => zoomEngineViewport(engine, 1 / ZOOM_STEP),
    fit: () => {
      // Fit is the inverse of every accumulated gesture, so it also drops the
      // "the user is driving" flag that suppresses automatic refitting.
      engine.viewport = fitMemoryGraphViewport(engine.bounds, engine.viewport.width, engine.viewport.height);
      engine.fittedScale = engine.viewport.scale;
      engine.userViewport = false;
      requestCanvasDraw(engine);
    },
    scale: () => engine.viewport.scale,
  });
}

export function bindCanvasInteractions(
  engine: CanvasEngine,
  emitSelection: (nodeId: string | undefined) => void,
): () => void {
  const { canvas } = engine;
  const pointForEvent = (event: PointerEvent | WheelEvent): CanvasPoint => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (engine.viewport.width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (engine.viewport.height / Math.max(1, rect.height)),
    };
  };
  const hitAt = (point: CanvasPoint) => {
    const hit = hitTestMemoryNode(
    engine.index,
    canvasToGraphPoint(point, engine.viewport),
    engine.viewport.scale,
    );
    return hit && !engine.hiddenKinds().has(hit.kind) && !engine.hiddenNodeIds().has(hit.id) ? hit : undefined;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const point = pointForEvent(event);
    engine.pointers.set(event.pointerId, {
      id: event.pointerId,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      moved: false,
    });
    // A second finger converts the gesture in flight: the pinch baseline is
    // taken now so the first move produces a ratio, not a jump.
    engine.pinchDistance = engine.pointers.size >= 2 ? pinchSpan(engine)?.distance : undefined;
    canvas.style.cursor = "grabbing";
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-cancelled pointer may not be capturable.
    }
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    const point = pointForEvent(event);
    const pointer = engine.pointers.get(event.pointerId);
    if (pointer) {
      const deltaX = point.x - pointer.lastX;
      const deltaY = point.y - pointer.lastY;
      pointer.lastX = point.x;
      pointer.lastY = point.y;
      if (Math.hypot(point.x - pointer.startX, point.y - pointer.startY) > 3) pointer.moved = true;
      const span = engine.pointers.size >= 2 ? pinchSpan(engine) : undefined;
      if (span) {
        // Two fingers scale about their midpoint. Every pointer counts as
        // moved so lifting one cannot be mistaken for a tap-to-select.
        for (const active of engine.pointers.values()) active.moved = true;
        const previous = engine.pinchDistance;
        engine.pinchDistance = span.distance;
        if (previous && previous > 0) zoomEngineViewport(engine, span.distance / previous, span.midpoint);
        return;
      }
      engine.viewport = constrainMemoryGraphViewport(
        panMemoryGraphViewport(engine.viewport, deltaX, deltaY),
        engine.bounds,
      );
      engine.userViewport = true;
      requestCanvasDraw(engine);
      return;
    }
    const hoverId = hitAt(point)?.id;
    if (hoverId !== engine.hoverId) {
      engine.hoverId = hoverId;
      canvas.style.cursor = hoverId ? "pointer" : "grab";
      requestCanvasDraw(engine);
    }
  };
  const finishPointer = (event: PointerEvent, cancelled: boolean) => {
    const pointer = engine.pointers.get(event.pointerId);
    if (!pointer) return;
    const point = pointForEvent(event);
    engine.pointers.delete(event.pointerId);
    // A surviving finger keeps panning from where it already is, so the
    // baseline is rebuilt rather than carried over from the two-finger span.
    engine.pinchDistance = engine.pointers.size >= 2 ? pinchSpan(engine)?.distance : undefined;
    if (engine.pointers.size === 0) canvas.style.cursor = engine.hoverId ? "pointer" : "grab";
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    if (!cancelled && !pointer.moved) emitSelection(hitAt(point)?.id);
    requestCanvasDraw(engine);
  };
  const onPointerUp = (event: PointerEvent) => finishPointer(event, false);
  const onPointerCancel = (event: PointerEvent) => finishPointer(event, true);
  const onPointerLeave = () => {
    if (engine.pointers.size > 0 || engine.hoverId === undefined) return;
    engine.hoverId = undefined;
    canvas.style.cursor = "grab";
    requestCanvasDraw(engine);
  };
  const onWheel = (event: WheelEvent) => {
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? engine.viewport.height
        : 1;
    const delta = clamp(event.deltaY * unit, -240, 240);
    const sensitivity = engine.reducedMotion ? 0.0008 : 0.0015;
    zoomEngineViewport(engine, Math.exp(-delta * sensitivity), pointForEvent(event));
    event.preventDefault();
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("wheel", onWheel);
  };
}

/** The first two live pointers as a midpoint and separation, or nothing. */
function pinchSpan(engine: CanvasEngine): { midpoint: CanvasPoint; distance: number } | undefined {
  const [first, second] = [...engine.pointers.values()];
  if (!first || !second) return undefined;
  const distance = Math.hypot(first.lastX - second.lastX, first.lastY - second.lastY);
  if (!Number.isFinite(distance) || distance <= 0) return undefined;
  return {
    midpoint: { x: (first.lastX + second.lastX) / 2, y: (first.lastY + second.lastY) / 2 },
    distance,
  };
}

function resizeCanvasEngine(engine: CanvasEngine): void {
  if (engine.disposed) return;
  const size = measureCanvas(engine.canvas);
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const backingWidth = Math.max(1, Math.round(size.width * dpr));
  const backingHeight = Math.max(1, Math.round(size.height * dpr));
  if (engine.canvas.width !== backingWidth) engine.canvas.width = backingWidth;
  if (engine.canvas.height !== backingHeight) engine.canvas.height = backingHeight;
  engine.dpr = dpr;
  if (!engine.userViewport) {
    engine.viewport = fitMemoryGraphViewport(engine.bounds, size.width, size.height);
    engine.fittedScale = engine.viewport.scale;
  } else {
    engine.viewport = { ...engine.viewport, width: size.width, height: size.height };
  }
  requestCanvasDraw(engine);
}

function requestCanvasDraw(engine: CanvasEngine | undefined): void {
  if (!engine || engine.disposed || engine.frame !== undefined) return;
  engine.frame = requestAnimationFrame(() => {
    engine.frame = undefined;
    if (engine.disposed) return;
    try {
      drawCanvasEngine(engine);
    } catch (error) {
      engine.disposed = true;
      engine.fail(error);
    }
  });
}

function prepareEdges(graph: MemoryRelationshipGraph): PreparedEdge[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.flatMap((edge): PreparedEdge[] => {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target || !isFinitePoint(source) || !isFinitePoint(target)) return [];
    return [{ edge, source, target, minX: Math.min(source.x, target.x), minY: Math.min(source.y, target.y), maxX: Math.max(source.x, target.x), maxY: Math.max(source.y, target.y) }];
  });
}

function drawCanvasEngine(engine: CanvasEngine): void {
  const { context, viewport, dpr } = engine;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
  context.lineCap = "round";
  const visibleBounds = memoryGraphViewportBounds(viewport, engine.index.maxNodeSize + 24);
  const hiddenKinds = engine.hiddenKinds();
  const hiddenNodeIds = engine.hiddenNodeIds();
  const visibleNodes = queryMemoryNodeSpatialIndex(engine.index, visibleBounds).filter((node) => !hiddenKinds.has(node.kind) && !hiddenNodeIds.has(node.id));
  const selected = engine.selected();
  const neighbors = engine.neighbors();
  const moving = [...engine.pointers.values()].some((pointer) => pointer.moved);

  if (!moving || engine.edges.length <= 2_000) {
    for (const prepared of engine.edges) {
      if (!boundsIntersect(prepared, visibleBounds) || hiddenKinds.has(prepared.source.kind) || hiddenKinds.has(prepared.target.kind) || hiddenNodeIds.has(prepared.source.id) || hiddenNodeIds.has(prepared.target.id)) continue;
      const source = graphToCanvasPoint(prepared.source, viewport);
      const target = graphToCanvasPoint(prepared.target, viewport);
      const adjacent = selected === undefined || prepared.edge.source === selected || prepared.edge.target === selected;
      context.globalAlpha = selected === undefined ? 0.28 : adjacent ? 0.78 : 0.1;
      context.strokeStyle = selected !== undefined && adjacent ? engine.palette.accent : engine.palette.inkMuted;
      context.lineWidth = Math.max(0.45, Math.min(2.4, prepared.edge.weight * (selected !== undefined && adjacent ? 1.35 : 1)));
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
      context.stroke();
      if (prepared.edge.directed && selected !== undefined && adjacent) drawArrowhead(context, source, target);
    }
  }

  context.globalAlpha = 1;
  for (const node of visibleNodes) {
    const point = graphToCanvasPoint(node, viewport);
    const isSelected = node.id === selected;
    const isNeighbor = selected === undefined || neighbors.has(node.id);
    const isHovered = node.id === engine.hoverId;
    const radius = Math.max(2.5, node.size) * (isSelected ? 1.45 : isHovered ? 1.18 : 1);
    context.globalAlpha = selected === undefined || isSelected || isNeighbor ? 1 : 0.18;
    drawNodeShape(context, node, point, radius, engine.palette);
    if (isSelected || isHovered) {
      context.globalAlpha = 0.95;
      context.strokeStyle = isSelected ? engine.palette.accent : engine.palette.signal;
      context.lineWidth = isSelected ? 2 : 1.25;
      context.beginPath();
      context.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
      context.stroke();
    }
  }

  drawNodeLabels(engine, visibleNodes, selected, neighbors, moving);
  context.globalAlpha = 1;
}

/**
 * The longest leading run of `label` that fits `maxWidth` at the current font,
 * ellipsised when it had to cut, or nothing when not even a cut run fits.
 *
 * Canvas will fit text to a width for you — `fillText`'s fourth argument — but
 * it does it by CONDENSING the glyphs, not by dropping any. An 83-character
 * message preview measures about 460px at this face; asked to occupy 190px it
 * came out as 2px-wide letters at full height, painted straight across the
 * graph body on tablet-768: a run of ink shaped like a sentence that nobody can
 * read. A label too small to read is not a label. So the string is cut to the
 * room available and the cut is declared with an ellipsis — the same bargain
 * `cleanLabel` in derive.ts already strikes in characters, struck here in the
 * pixels that actually decide legibility.
 */
export function fitLabelToWidth(
  context: Pick<CanvasRenderingContext2D, "measureText">,
  label: string,
  maxWidth: number,
): { text: string; width: number } | undefined {
  if (!(maxWidth > 0) || label.length === 0) return undefined;
  const full = context.measureText(label).width;
  if (full <= maxWidth) return { text: label, width: full };
  const ellipsisWidth = context.measureText("…").width;
  // Binary search the longest prefix that still leaves room for the ellipsis.
  let fits = 0;
  let over = label.length;
  while (fits < over) {
    const middle = Math.ceil((fits + over) / 2);
    if (context.measureText(label.slice(0, middle)).width + ellipsisWidth <= maxWidth) fits = middle;
    else over = middle - 1;
  }
  const kept = label.slice(0, fits).trimEnd();
  if (kept.length === 0) return undefined;
  const text = `${kept}…`;
  return { text, width: context.measureText(text).width };
}

export function drawNodeLabels(
  engine: CanvasEngine,
  visibleNodes: readonly MemoryGraphNode[],
  selected: string | undefined,
  neighbors: ReadonlySet<string>,
  moving: boolean,
): void {
  const threshold = engine.graph.nodes.length > 2_000 ? 8 : 6;
  const candidates = visibleNodes
    .filter((node) => {
      const forced = node.id === selected || node.id === engine.hoverId || (selected !== undefined && neighbors.has(node.id));
      return forced || (!moving && selected === undefined && node.size >= threshold);
    })
    .sort((left, right) => labelPriority(right, selected, engine.hoverId, neighbors) - labelPriority(left, selected, engine.hoverId, neighbors));
  /*
   * What is reserved, and where it is filed.
   *
   * Each cell holds the rectangles that touch it rather than a bare "taken"
   * flag. The lattice is a broad phase — it narrows which rectangles are worth
   * comparing — and the answer comes from comparing them, so a cell size is a
   * bucketing choice and never a geometric claim.
   *
   * It used to be the claim itself, and that is the defect this replaces. A
   * rectangle is filed in every cell its edges fall in, and both edges round
   * outward, so a flag-per-cell reserves the rectangle grown to the lattice:
   * up to a row at each edge and, far worse, up to a whole 20px column. Two
   * labels that miss each other by six pixels rounded into one column and the
   * later one was refused. Measured on the two-label harness before this
   * change: two 11px labels stop sharing ink at a 12px gap, where their bands
   * meet edge to edge, and the grid refused the second until the gap reached
   * 14, 15, 16 or 17 depending on nothing but phase. That phantom
   * separation is what erased "Evidence first" and "Concise handoff" from
   * #memory at landscape-932 while the neighbours they do not touch stayed,
   * and its dependence on phase is why the losses read as force-graph jitter
   * instead of as a rule.
   *
   * Comparing the rectangles removes the slop in both axes at once and cannot
   * introduce an overlap: a reservation is now exactly the extent it names,
   * every extent still contains the ink it protects, and the test still
   * refuses any pair that shares area. It only stops refusing pairs that never
   * shared any.
   */
  type Reservation = { minX: number; maxX: number; minY: number; maxY: number };
  const occupied = new Map<string, Reservation[]>();
  const context = engine.context;
  context.font = "500 11px ui-sans-serif, system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillStyle = engine.palette.inkMuted;
  context.globalAlpha = 0.92;
  const columnWidth = 20;
  const rowHeight = 4;
  /*
   * Touching edges do not collide. Two ±6 bands that meet edge to edge are 12px
   * apart — adjacent lines of text, which is what every paragraph is.
   */
  const intersects = (left: Reservation, right: Reservation): boolean =>
    left.minX < right.maxX && right.minX < left.maxX && left.minY < right.maxY && right.minY < left.maxY;
  /*
   * The label is drawn `textBaseline: middle` at 11px, so its ink covers about
   * six pixels either side of the node's y. Reserving that band is what makes
   * the collision test agree with what the eye sees.
   */
  const labelHalfHeight = 6;
  const cellsWithin = (area: Reservation): readonly string[] => {
    const cells: string[] = [];
    const lastColumn = Math.floor(area.maxX / columnWidth);
    const lastRow = Math.floor(area.maxY / rowHeight);
    for (let row = Math.floor(area.minY / rowHeight); row <= lastRow; row += 1) {
      for (let column = Math.floor(area.minX / columnWidth); column <= lastColumn; column += 1) cells.push(`${column}:${row}`);
    }
    return cells;
  };
  /** Every reservation filed in a cell this area touches, each considered once. */
  const nearby = (area: Reservation): readonly Reservation[] => {
    const found = new Set<Reservation>();
    for (const cell of cellsWithin(area)) for (const taken of occupied.get(cell) ?? []) found.add(taken);
    return [...found];
  };
  const isClear = (area: Reservation): boolean => !nearby(area).some((taken) => intersects(area, taken));
  const reserve = (area: Reservation): void => {
    for (const cell of cellsWithin(area)) {
      const bucket = occupied.get(cell);
      if (bucket) bucket.push(area);
      else occupied.set(cell, [area]);
    }
  };
  /**
   * The air a label keeps between itself and whatever it stands next to.
   *
   * `anchorOf` already spends it on the left, holding a name off its own node's
   * shape. A stub cut to fit a gap spends the same on the right, so it stops
   * short of the thing that stopped it rather than resting against it: text
   * abutting a disc reads as text printed on a disc, which is the failure the
   * cut exists to avoid in the first place.
   */
  const labelGutter = 6;
  /*
   * How far right of `startX` the label band stays clear, capped at `limit`.
   *
   * The second pass asks this rather than retrying a ladder of guessed widths:
   * the stub it then paints is exactly as long as the room the first pass left
   * beside the node, and cannot reach into a neighbour.
   *
   * The room is measured to the blocking rectangle's own left edge, less the
   * gutter — not back to the start of the lattice column that rectangle happens
   * to sit in. Rounding down to the column threw away up to 19px on every stub,
   * which is the difference between a name and the `MIN_LABEL_WIDTH` floor
   * declining to draw one.
   */
  const clearWidthFrom = (startX: number, minY: number, maxY: number, limit: number): number => {
    const band = { minX: startX, maxX: startX + limit, minY, maxY };
    let room = limit;
    for (const taken of nearby(band)) {
      if (taken.maxY <= minY || taken.minY >= maxY || taken.maxX <= startX) continue;
      room = Math.min(room, Math.max(0, taken.minX - labelGutter - startX));
    }
    return room;
  };
  /** Where a node's label starts: clear of the node's own shape, on its right. */
  const anchorOf = (node: MemoryGraphNode) => {
    const point = graphToCanvasPoint(node, engine.viewport);
    const radius = Math.max(2.5, node.size);
    return { point, radius, labelX: point.x + radius + labelGutter };
  };
  /** Draws one label at no more than `budget` pixels, reporting whether it went down. */
  const place = (node: MemoryGraphNode, budget: number, forced: boolean): boolean => {
    const fitted = fitLabelToWidth(context, node.label, budget);
    if (!fitted) return false;
    const { point, radius, labelX } = anchorOf(node);
    // Reserve the label's ACTUAL drawn footprint (not a coarse fixed bucket)
    // so wide labels block later ones instead of overlapping into unreadable soup.
    const labelArea = {
      minX: labelX,
      maxX: labelX + fitted.width,
      minY: point.y - labelHalfHeight,
      maxY: point.y + labelHalfHeight,
    };
    if (!forced && !isClear(labelArea)) return false;
    reserve(labelArea);
    /*
     * A drawn label also spends its own node's shape, because text is painted
     * after every node: a later label crossing an earlier node lands on the
     * glyph as well as beside the word, which is how "docs/architecture.md"
     * came to be drawn through the "General session" node that already carried
     * a label of its own.
     *
     * Only *labelled* nodes claim their shape. Reserving all 152 was measured
     * and rejected — at this graph's density a 130px label sweeps about 1.6
     * node centres, so blanket reservation deletes most of the labels the panel
     * exists to show. Small unlabelled dots may still be clipped by a passing
     * label; a label lost is worse than a dot touched.
     */
    reserve({ minX: point.x - radius, maxX: point.x + radius, minY: point.y - radius, maxY: point.y + radius });
    context.fillText(fitted.text, labelX, point.y);
    return true;
  };

  /*
   * First pass: every candidate at its full width, highest priority first. This
   * is the whole policy the collision grid was built for, and it runs to
   * completion before anything else asks for a cell, so nothing the second pass
   * does can cost it a label.
   */
  const anonymous: MemoryGraphNode[] = [];
  for (const node of candidates) {
    const forced = node.id === selected || node.id === engine.hoverId;
    if (!place(node, MAX_LABEL_WIDTH, forced)) anonymous.push(node);
  }

  /*
   * Second pass: whoever the first refused.
   *
   * Suppressing a collision by dropping the label outright throws away the fact
   * the node exists to convey. On phone-320 that turned all three workspace-file
   * nodes into bare teal squares at once — nothing on screen said which file any
   * of them was, and a still frame has no hover to fall back on. So each refused
   * node is offered whatever horizontal room the first pass happened to leave
   * beside it: enough for a readable stub of its name and the stub is drawn,
   * not enough and the node stays anonymous rather than gaining ink nobody can
   * read. Showing some of the names beats showing none of them, and the room
   * spent here is by construction room no drawn label wanted.
   */
  for (const node of anonymous) {
    const { point, labelX } = anchorOf(node);
    const room = clearWidthFrom(labelX, point.y - labelHalfHeight, point.y + labelHalfHeight, MAX_LABEL_WIDTH);
    if (room < MIN_LABEL_WIDTH) continue;
    place(node, room, false);
  }
}

function labelPriority(
  node: MemoryGraphNode,
  selected: string | undefined,
  hoverId: string | undefined,
  neighbors: ReadonlySet<string>,
): number {
  if (node.id === selected) return 10_000 + node.size;
  if (node.id === hoverId) return 9_000 + node.size;
  if (neighbors.has(node.id)) return 1_000 + node.size;
  return node.size;
}

function drawArrowhead(context: CanvasRenderingContext2D, source: CanvasPoint, target: CanvasPoint): void {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const length = 5;
  context.beginPath();
  context.moveTo(target.x, target.y);
  context.lineTo(target.x - Math.cos(angle - 0.55) * length, target.y - Math.sin(angle - 0.55) * length);
  context.lineTo(target.x - Math.cos(angle + 0.55) * length, target.y - Math.sin(angle + 0.55) * length);
  context.closePath();
  context.fillStyle = context.strokeStyle;
  context.fill();
}

function readRendererPalette(container: HTMLElement): RendererPalette {
  const computed = getComputedStyle(container);
  const root = getComputedStyle(document.documentElement);
  const read = (name: string) => computed.getPropertyValue(name).trim() || root.getPropertyValue(name).trim();
  const inkMuted = read("--ink-muted") || computed.color || "CanvasText";
  const surfaceSoft = read("--surface-soft") || computed.backgroundColor || "Canvas";
  const accent = read("--accent") || read("--brass") || inkMuted;
  const signal = read("--signal") || read("--verdigris") || accent;
  const visualColors = Object.fromEntries([...new Set(Object.values(KIND_VISUAL).map((item) => item.colorToken))].map((token) => [token, read(token)]));
  return { surfaceSoft, inkMuted, accent, signal, visualColors };
}

function drawNodeShape(context: CanvasRenderingContext2D, node: MemoryGraphNode, point: CanvasPoint, radius: number, palette: RendererPalette): void {
  const visual = KIND_VISUAL[node.kind];
  const color = nodeVisualColor(visual.colorToken, palette);
  context.beginPath();
  if (visual.shape === "square") context.rect(point.x - radius, point.y - radius, radius * 2, radius * 2);
  else if (visual.shape === "diamond") { context.moveTo(point.x, point.y - radius * 1.25); context.lineTo(point.x + radius * 1.25, point.y); context.lineTo(point.x, point.y + radius * 1.25); context.lineTo(point.x - radius * 1.25, point.y); context.closePath(); }
  else context.arc(point.x, point.y, visual.shape === "dot" ? radius * 0.72 : radius, 0, Math.PI * 2);
  if (visual.shape === "ring" || visual.shape === "hollow") {
    context.strokeStyle = color;
    context.lineWidth = visual.shape === "ring" ? 2.2 : 1.2;
    context.stroke();
  } else {
    context.fillStyle = color;
    context.fill();
  }
}

function nodeVisualColor(token: string, palette: RendererPalette): string {
  const computed = palette.visualColors[token];
  if (computed) return computed;
  if (token === "--truth-local" || token === "--ink-muted") return palette.inkMuted;
  if (token === "--v-verified") return palette.signal;
  return palette.accent;
}

function surfaceStatusText(
  status: SurfaceStatus,
  graph: MemoryRelationshipGraph,
  errorMessage: string | undefined,
): string {
  if (status === "empty") return "No session, workspace, profile, or skill relationships are available yet.";
  if (status === "unsupported") return "This device cannot create a Canvas 2D graph surface. Search and relationship selection remain available through the data API.";
  if (status === "error") return `The graph renderer could not start${errorMessage ? `: ${errorMessage}` : "."}`;
  return `Preparing ${graph.stats.nodeCount} memory nodes on this device…`;
}

function measureCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || canvas.parentElement?.clientWidth || 1),
    height: Math.max(1, rect.height || canvas.parentElement?.clientHeight || 1),
  };
}

function boundsIntersect(left: MemoryGraphBounds, right: MemoryGraphBounds): boolean {
  return left.maxX >= right.minX && left.minX <= right.maxX && left.maxY >= right.minY && left.minY <= right.maxY;
}

function isFinitePoint(point: Pick<CanvasPoint, "x" | "y">): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function spatialKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

const STATUS_STYLE: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
  padding: 24,
  color: "var(--ink-muted, currentColor)",
  background: "var(--surface-soft, Canvas)",
  textAlign: "center",
  fontSize: 12,
};

const VISUALLY_HIDDEN_STYLE: JSX.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

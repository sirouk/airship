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

type CanvasEngine = {
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
  pointer?: ActivePointer;
  reducedMotion: boolean;
  disposed: boolean;
  fail: (error: unknown) => void;
  selected: () => string | undefined;
  neighbors: () => ReadonlySet<string>;
  hiddenKinds: () => ReadonlySet<string>;
  hiddenNodeIds: () => ReadonlySet<string>;
};

type CanvasMemoryGraphSurfaceProps = Pick<MemoryGraphRendererProps, "graph" | "selectedNodeId" | "onSelect" | "hiddenKinds" | "hiddenNodeIds">;

export function CanvasMemoryGraphSurface({ graph, selectedNodeId, onSelect, hiddenKinds, hiddenNodeIds }: CanvasMemoryGraphSurfaceProps) {
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
      const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
      resizeObserver?.observe(canvas);
      window.addEventListener("resize", resize, { passive: true });
      const onMotionChange = (event: MediaQueryListEvent) => {
        if (engine) engine.reducedMotion = event.matches;
      };
      motionQuery?.addEventListener?.("change", onMotionChange);
      resize();
      setStatus("ready");

      return () => {
        if (!engine) return;
        engine.disposed = true;
        if (engine.frame !== undefined) cancelAnimationFrame(engine.frame);
        if (engine.centerFrame !== undefined) cancelAnimationFrame(engine.centerFrame);
        removeInteractions();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", resize);
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
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: "grab" }}
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

function bindCanvasInteractions(
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
    engine.pointer = {
      id: event.pointerId,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      moved: false,
    };
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
    const pointer = engine.pointer;
    if (pointer?.id === event.pointerId) {
      const deltaX = point.x - pointer.lastX;
      const deltaY = point.y - pointer.lastY;
      pointer.lastX = point.x;
      pointer.lastY = point.y;
      if (Math.hypot(point.x - pointer.startX, point.y - pointer.startY) > 3) pointer.moved = true;
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
    const pointer = engine.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = pointForEvent(event);
    engine.pointer = undefined;
    canvas.style.cursor = engine.hoverId ? "pointer" : "grab";
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
    if (engine.pointer || engine.hoverId === undefined) return;
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
    engine.viewport = constrainMemoryGraphViewport(
      zoomMemoryGraphViewport(
        engine.viewport,
        pointForEvent(event),
        Math.exp(-delta * sensitivity),
        engine.fittedScale * 0.35,
        engine.fittedScale * 16,
      ),
      engine.bounds,
    );
    engine.userViewport = true;
    requestCanvasDraw(engine);
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
  const moving = engine.pointer?.moved === true;

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

function drawNodeLabels(
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
  const occupied = new Set<string>();
  const context = engine.context;
  context.font = "500 11px ui-sans-serif, system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillStyle = engine.palette.inkMuted;
  context.globalAlpha = 0.92;
  const columnWidth = 20;
  const rowHeight = 16;
  for (const node of candidates) {
    const point = graphToCanvasPoint(node, engine.viewport);
    const forced = node.id === selected || node.id === engine.hoverId;
    const labelX = point.x + Math.max(2.5, node.size) + 6;
    // Reserve the label's ACTUAL measured footprint (not a coarse fixed bucket)
    // so wide labels block later ones instead of overlapping into unreadable soup.
    const labelWidth = Math.min(190, context.measureText(node.label).width);
    const row = Math.floor(point.y / rowHeight);
    const firstColumn = Math.floor(labelX / columnWidth);
    const lastColumn = Math.floor((labelX + labelWidth) / columnWidth);
    let collides = false;
    for (let column = firstColumn; column <= lastColumn && !collides; column += 1) {
      if (occupied.has(`${column}:${row}`)) collides = true;
    }
    if (!forced && collides) continue;
    for (let column = firstColumn; column <= lastColumn; column += 1) occupied.add(`${column}:${row}`);
    context.fillText(node.label, labelX, point.y, 190);
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

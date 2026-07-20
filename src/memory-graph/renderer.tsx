import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { MemoryGraphSelection, MemoryRelationshipGraph } from "./types";
import type { MemoryNodeKind } from "./types";

type CanvasSurface = typeof import("./canvas-renderer").CanvasMemoryGraphSurface;
type WrapperStatus = "waiting" | "loading" | "empty" | "error";

export type MemoryGraphRendererProps = {
  graph: MemoryRelationshipGraph;
  selectedNodeId?: string;
  onSelect?: (selection: MemoryGraphSelection | undefined) => void;
  class?: string;
  style?: JSX.CSSProperties;
  ariaLabel?: string;
  minHeight?: number;
  hiddenKinds?: ReadonlySet<MemoryNodeKind>;
  hiddenNodeIds?: ReadonlySet<string>;
};

/**
 * Keeps the graph engine off the entry path and does not request it until the
 * graph is close to the viewport. The loaded surface owns all canvas state.
 */
export function MemoryGraphRenderer({
  graph,
  selectedNodeId,
  onSelect,
  class: className,
  style,
  ariaLabel = "Interactive memory relationship graph",
  minHeight = 320,
  hiddenKinds,
  hiddenNodeIds,
}: MemoryGraphRendererProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [surface, setSurface] = useState<CanvasSurface>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || graph.nodes.length === 0 || surface) return;
    let active = true;
    setLoadError(undefined);
    void loadDeferredCapabilities()
      .then((module) => {
        if (active) setSurface(() => module.CanvasMemoryGraphSurface);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [graph.nodes.length, graph.revision, surface, visible]);

  const status: WrapperStatus = graph.nodes.length === 0
    ? "empty"
    : loadError
      ? "error"
      : !visible
        ? "waiting"
        : "loading";
  const Surface = surface;

  return (
    <div
      ref={hostRef}
      class={className}
      role="group"
      aria-label={ariaLabel}
      style={{ position: "relative", width: "100%", minHeight: Math.max(160, minHeight), overflow: "hidden", ...style }}
    >
      {Surface && graph.nodes.length > 0 ? (
        <Surface graph={graph} selectedNodeId={selectedNodeId} onSelect={onSelect} hiddenKinds={hiddenKinds} hiddenNodeIds={hiddenNodeIds} />
      ) : (
        <div
          role={status === "error" ? "alert" : "status"}
          aria-live="polite"
          style={STATUS_STYLE}
        >
          {wrapperStatusText(status, graph, loadError)}
        </div>
      )}
      {!Surface ? (
        <span style={VISUALLY_HIDDEN_STYLE} aria-live="polite">
          {graph.stats.nodeCount} memory nodes and {graph.stats.edgeCount} relationships.
        </span>
      ) : null}
    </div>
  );
}

/** The capability used by the current, dependency-free Canvas renderer. */
export function supportsMemoryGraphCanvas(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

/**
 * Legacy capability export retained for callers of the former WebGL renderer.
 * It now reports whether the active memory-graph surface can be created.
 */
export const supportsMemoryGraphWebGL = supportsMemoryGraphCanvas;

function wrapperStatusText(
  status: WrapperStatus,
  graph: MemoryRelationshipGraph,
  errorMessage: string | undefined,
): string {
  if (status === "empty") return "No session, workspace, profile, or skill relationships are available yet.";
  if (status === "error") return `The graph renderer could not load${errorMessage ? `: ${errorMessage}` : "."}`;
  if (status === "loading") return `Preparing ${graph.stats.nodeCount} memory nodes on this device…`;
  return "The graph renderer will load when this panel enters the viewport.";
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

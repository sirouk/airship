import { useEffect, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { ContextViewProps } from "./context-view";
import { RouteHeader } from "./route-header";
import { RouteSkeleton } from "./route-skeleton";

type ContextViewComponent = typeof import("./context-view").ContextView;

/**
 * Keeps the indexing engine out of the startup graph until a user opens Context.
 * A failed chunk fetch never mutates workspace or retrieval state: the real view
 * (and therefore its engine) has not mounted yet.
 */
export function ContextView(props: ContextViewProps) {
  const [Component, setComponent] = useState<ContextViewComponent>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void loadDeferredCapabilities()
      .then((module) => {
        if (active) setComponent(() => module.ContextView);
      })
      .catch(() => {
        if (active) setLoadError("The on-device context interface could not be loaded. Workspace data and active retrieval state were not changed.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (Component) return <Component {...props} />;

  return (
    <section class="work-view" aria-labelledby="context-route-title" aria-busy={!loadError}>
      {!props.embedded ? <RouteHeader
        routeId="context"
        density="tool"
        title="Context"
        headingId="context-route-title"
        eyebrow="On-device retrieval"
        description="Preparing the isolated workspace indexing engine in this browser."
      /> : null}
      <div class="panel" role={loadError ? "alert" : "status"} aria-live="polite">
        {loadError ? <p>{loadError}</p> : <RouteSkeleton label="Loading the client-side context engine" />}
        {loadError ? (
          <button class="small-button" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry loading Context
          </button>
        ) : null}
      </div>
    </section>
  );
}

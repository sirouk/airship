import { useEffect, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { ContextViewProps } from "./context-view";
import { RouteFailure } from "./route-failure";
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

  /*
   * This route's hand-written Retry was the only chunk-failure recovery the
   * product actually shipped, and `route-failure.tsx` was written to give the
   * other nine the same answer. Answering through it now means the verb exists
   * once: a tenth spelling of "this did not load" cannot appear here either.
   *
   * Embedded, this is a slot inside a Memory route that already rendered, so it
   * names the slot rather than issuing a second <h1> that re-titles the page.
   */
  if (loadError) {
    const retry = () => setAttempt((value) => value + 1);
    return props.embedded
      ? <RouteFailure inline title="the workspace context index" message={loadError} onRetry={retry} />
      : <RouteFailure title="Context" message={loadError} onRetry={retry} />;
  }

  return (
    // Embedded, the header is not rendered, so `aria-labelledby` pointed at an
    // id that does not exist and the section had no accessible name at all.
    // Same resolution as the loaded view (`context-view.tsx`): name the slot.
    <section
      class="work-view"
      aria-labelledby={props.embedded ? undefined : "context-route-title"}
      aria-label={props.embedded ? "Workspace context index" : undefined}
      aria-busy="true"
    >
      {!props.embedded ? <RouteHeader
        routeId="context"
        density="tool"
        title="Context"
        headingId="context-route-title"
        eyebrow="On-device retrieval"
        description="Preparing the isolated workspace indexing engine in this browser."
      /> : null}
      <div class="panel" role="status" aria-live="polite">
        <RouteSkeleton label="Loading the client-side context engine" />
      </div>
    </section>
  );
}

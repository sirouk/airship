import { useEffect, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { AccessViewProps } from "./access-view";
import { RouteHeader } from "./route-header";
import { RouteSkeleton } from "./route-skeleton";

type AccessViewComponent = typeof import("./access-view").AccessView;

/** Defers connection presentation and model discovery until Connection is opened. */
export function AccessView(props: AccessViewProps) {
  const [Component, setComponent] = useState<AccessViewComponent>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void loadDeferredCapabilities()
      .then((module) => {
        if (active) setComponent(() => module.AccessView);
      })
      .catch(() => {
        if (active) {
          setLoadError("The connection interface could not be loaded. No account, credential, model, or active session state was changed.");
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (Component) return <Component {...props} />;

  return (
    <section class="work-view access-view" aria-labelledby="access-route-title" aria-busy={!loadError}>
      {/* The same primitive, at the same density, as the loaded route — the
          placeholder used to render the 47px legacy slab where the real
          header is a 44px bar, so the title jumped 90px the moment the chunk
          arrived. Every word is the placeholder's own, verbatim. */}
      <RouteHeader
        routeId="access"
        density="tool"
        title="Connection"
        headingId="access-route-title"
        eyebrow="Direct provider connection"
        description="Preparing the client-side account, model, and inference connection controls."
      />
      <div class="panel" role={loadError ? "alert" : "status"} aria-live="polite">
        {loadError ? <p>{loadError}</p> : <RouteSkeleton label="Loading the connection interface" />}
        {loadError ? (
          <button class="small-button" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry loading Connection
          </button>
        ) : null}
      </div>
    </section>
  );
}

import { useEffect, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { AccessViewProps } from "./access-view";
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
      <header class="page-heading access-heading">
        <span class="eyebrow">Direct provider connection</span>
        <h1 id="access-route-title">Connection</h1>
        <p>Preparing the client-side account, model, and inference connection controls.</p>
      </header>
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

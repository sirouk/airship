import { useEffect, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import { RouteHeader } from "./route-header";
import { RouteSkeleton } from "./route-skeleton";

type BillingViewComponent = typeof import("./billing-view").BillingView;
type BillingViewProps = Parameters<BillingViewComponent>[0];

/** Defers account presentation until Account is opened; credentials stay in App page memory. */
export function BillingView(props: BillingViewProps) {
  const [Component, setComponent] = useState<BillingViewComponent>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void loadDeferredCapabilities()
      .then((module) => {
        if (active) setComponent(() => module.BillingView);
      })
      .catch(() => {
        if (active) setLoadError("The account interface could not be loaded. No credential, balance, or billing state was changed.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (Component) return <Component {...props} />;

  return (
    <section class="work-view billing-view" aria-labelledby="billing-route-title" aria-busy={!loadError}>
      {/* Same primitive and same density as `BillingView`'s own header, so the
          title does not move when the deferred chunk lands. */}
      <RouteHeader
        routeId="account"
        density="tool"
        title="Account standing"
        headingId="billing-route-title"
        eyebrow="Direct user-scoped Chutes telemetry"
        description="Preparing the account interface without transferring credentials away from this page."
      />
      <div class="panel" role={loadError ? "alert" : "status"} aria-live="polite">
        {loadError ? <p>{loadError}</p> : <RouteSkeleton label="Loading account telemetry" />}
        {loadError ? (
          <button class="small-button" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry loading Account
          </button>
        ) : null}
      </div>
    </section>
  );
}

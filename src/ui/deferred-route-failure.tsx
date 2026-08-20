import { createDeferredComponent } from "./deferred-component";

const loadRouteFailure = () => import("./route-failure").then(({ RouteFailure }) => RouteFailure);

/** Recovery UI is fetched only after a route chunk has failed. */
export const DeferredRouteFailure = createDeferredComponent(loadRouteFailure);

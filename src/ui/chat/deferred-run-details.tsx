import { createDeferredComponent } from "../deferred-component";

const loadRunDetails = () => import("./run-details").then(({ RunDetails }) => RunDetails);

/** Receipt inspection is fetched only after a durable receipt exists. */
export const DeferredRunDetails = createDeferredComponent(loadRunDetails);

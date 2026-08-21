import { createDeferredComponent } from "./deferred-component";

const loadTabPresence = () => import("./tab-presence").then(({ TabPresenceNote }) => TabPresenceNote);

/** Cross-tab observation starts after the shell has mounted. */
export const DeferredTabPresenceNote = createDeferredComponent(loadTabPresence);

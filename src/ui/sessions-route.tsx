// Keep the session library in its own route chunk. This surface is not needed
// to render the interactive shell or begin a chat turn.
export { SessionsView } from "./sessions-view";
export type { SessionsViewProps } from "./sessions-view";

// Both surfaces are secondary state-management routes. Sharing one route
// boundary keeps their presentation code out of startup without creating an
// additional shared-runtime preload.
export { VaultView } from "./vault-view";

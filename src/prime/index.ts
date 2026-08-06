/**
 * Public surface of the ported prime-agent core inside airship.
 * `agent` joins this list when the ported loop lands; the transport bridge
 * is the seam that lets either runtime drive the other's transports.
 */

export * from "./ai/index";
export * from "./transport-adapter";

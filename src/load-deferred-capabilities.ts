export type DeferredCapabilities = typeof import("./deferred-capabilities");

let capabilityPack: Promise<DeferredCapabilities> | undefined;

/** Load Airship's advanced capability pack once per page lifetime. */
export function loadDeferredCapabilities(): Promise<DeferredCapabilities> {
  capabilityPack ??= import("./deferred-capabilities");
  return capabilityPack;
}

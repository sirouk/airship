export type DeferredCapabilities = typeof import("./deferred-capabilities");

export function createRetryableDeferredLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (cached) return cached;
    const attempt = Promise.resolve().then(load);
    cached = attempt;
    void attempt.catch(() => {
      // Clear only the failed generation. A later caller may already have
      // installed a newer attempt while this rejection was propagating.
      if (cached === attempt) cached = undefined;
    });
    return attempt;
  };
}

const loadCapabilityPack = createRetryableDeferredLoader<DeferredCapabilities>(
  () => import("./deferred-capabilities"),
);

/** Share a successful pack per page, but let a transient chunk failure retry. */
export function loadDeferredCapabilities(): Promise<DeferredCapabilities> {
  return loadCapabilityPack();
}

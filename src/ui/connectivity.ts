export const OFFLINE_RUNTIME_LABEL = "Offline · local only";
export const OFFLINE_RUNTIME_DETAIL = "Remote inference, sync, and account reads are paused";
export const OFFLINE_INLINE_REASON = "Offline · remote services are paused. Local commands, workspace, memory, and cached proof remain available.";

export type ConnectivityNavigator = Readonly<{ onLine: boolean }>;

export type ConnectivityEventSource = Readonly<{
  addEventListener: (type: "online" | "offline", listener: () => void) => void;
  removeEventListener: (type: "online" | "offline", listener: () => void) => void;
}>;

/** Browsers without a connectivity signal stay permissive; explicit offline is authoritative. */
export function readOnlineState(source: ConnectivityNavigator | undefined): boolean {
  return source?.onLine !== false;
}

/** Local slash plans are intentionally not blocked by remote connectivity posture. */
export function remoteComposerBlocked(
  online: boolean,
  remoteInference: boolean,
  localPlan: boolean,
): boolean {
  return !online && remoteInference && !localPlan;
}

/**
 * Owns the browser connectivity event pair and immediately reconciles the
 * caller with the current navigator value. The signal is reachability posture,
 * not proof that any particular provider is healthy.
 */
export function observeConnectivity(
  events: ConnectivityEventSource,
  source: ConnectivityNavigator,
  onChange: (online: boolean) => void,
): () => void {
  const reconcile = () => onChange(readOnlineState(source));
  events.addEventListener("online", reconcile);
  events.addEventListener("offline", reconcile);
  reconcile();
  return () => {
    events.removeEventListener("online", reconcile);
    events.removeEventListener("offline", reconcile);
  };
}

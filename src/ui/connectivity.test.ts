import { describe, expect, it, vi } from "vitest";
import {
  OFFLINE_INLINE_REASON,
  OFFLINE_RUNTIME_DETAIL,
  OFFLINE_RUNTIME_LABEL,
  observeConnectivity,
  readOnlineState,
  remoteComposerBlocked,
  type ConnectivityEventSource,
} from "./connectivity";

describe("runtime connectivity truth", () => {
  it("treats only an explicit browser offline signal as offline", () => {
    expect(readOnlineState(undefined)).toBe(true);
    expect(readOnlineState({ onLine: true })).toBe(true);
    expect(readOnlineState({ onLine: false })).toBe(false);
  });

  it("reconciles immediately, follows both browser events, and removes both listeners", () => {
    const listeners = new Map<string, () => void>();
    const events: ConnectivityEventSource = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    };
    const navigatorState = { onLine: true };
    const onChange = vi.fn();
    const dispose = observeConnectivity(events, navigatorState, onChange);

    expect(onChange).toHaveBeenLastCalledWith(true);
    navigatorState.onLine = false;
    listeners.get("offline")?.();
    expect(onChange).toHaveBeenLastCalledWith(false);
    navigatorState.onLine = true;
    listeners.get("online")?.();
    expect(onChange).toHaveBeenLastCalledWith(true);

    dispose();
    expect(listeners.size).toBe(0);
  });

  it("uses one consistent, bounded explanation across runtime surfaces", () => {
    expect(OFFLINE_RUNTIME_LABEL).toBe("Offline · local only");
    expect(OFFLINE_RUNTIME_DETAIL).toContain("Remote inference, sync, and account reads are paused");
    expect(OFFLINE_INLINE_REASON).toContain("Local commands, workspace, memory, and cached proof remain available");
  });

  it("blocks only remote composer work and keeps local command plans live", () => {
    expect(remoteComposerBlocked(false, true, false)).toBe(true);
    expect(remoteComposerBlocked(false, true, true)).toBe(false);
    expect(remoteComposerBlocked(false, false, false)).toBe(false);
    expect(remoteComposerBlocked(true, true, false)).toBe(false);
  });
});

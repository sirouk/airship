import { WebContainer } from "@webcontainer/api";
import { createNodeWebContainerAdapter } from "./node-webcontainer-adapter";
import type { ExecutionAdapter } from "./runtime-registry";

let instance: WebContainer | undefined;
let adapter: ExecutionAdapter | undefined;
let activation: Promise<WebContainer> | undefined;
let lateBootCleanup: Promise<void> | undefined;

/**
 * Cold-start the one WebContainer instance allowed per page. This module is a
 * second-level dynamic chunk and is never fetched by runtime inspection alone.
 */
export async function activateNodeWebContainer(signal: AbortSignal, timeoutMs = 30_000): Promise<ExecutionAdapter> {
  if (adapter) return adapter;
  const host = await activateNodeWebContainerHost(signal, timeoutMs);
  adapter = createNodeWebContainerAdapter(host);
  return adapter;
}

/** Shared page-lifetime host for the interactive terminal and bounded jobs. */
export async function activateNodeWebContainerHost(signal: AbortSignal, timeoutMs = 30_000): Promise<WebContainer> {
  if (instance) return instance;
  assertNodeWebContainerHost();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("WebContainer activation timeout must be between 1 and 30 seconds.");
  }
  if (lateBootCleanup) {
    throw new Error("The previous WebContainer boot timed out and is still settling. Reload this page before retrying.");
  }
  activation ??= (async () => {
    const boot = WebContainer.boot({
      coep: "credentialless",
      workdirName: "airship-node",
      forwardPreviewErrors: "exceptions-only",
    });
    try {
      const booted = await awaitBoundedWebContainerBoot(boot, timeoutMs, signal);
      instance = booted;
      return booted;
    } catch (error) {
      // The provider API does not expose cancellation while booting. Fence the
      // page against a second boot and tear down a late result immediately.
      lateBootCleanup = boot.then((late) => { late.teardown(); }, () => undefined).finally(() => {
        lateBootCleanup = undefined;
      });
      throw error;
    }
  })();
  try {
    return await activation;
  } catch (error) {
    activation = undefined;
    throw error;
  }
}

export async function deactivateNodeWebContainer(): Promise<void> {
  if (activation) await activation.catch(() => undefined);
  if (lateBootCleanup) await Promise.race([
    lateBootCleanup,
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  instance?.teardown();
  instance = undefined;
  adapter = undefined;
  activation = undefined;
}

export function awaitBoundedWebContainerBoot<T>(
  boot: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () => finish(new Error(`WebContainer activation exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    boot.then((value) => finish(undefined, value), finish);
    if (signal.aborted) onAbort();
  });
}

export function assertNodeWebContainerHost(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("WebContainers require a browser document.");
  }
  if (!globalThis.isSecureContext) throw new Error("WebContainers require HTTPS or a loopback secure context.");
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new Error("WebContainers require COOP/COEP cross-origin isolation and SharedArrayBuffer.");
  }
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") {
    throw new Error("WebContainers require browser Worker and WebAssembly support.");
  }
}

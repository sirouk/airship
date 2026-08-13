import { WebContainer } from "@webcontainer/api";
import { createClientNodeEgress, type ClientNodeEgressPort } from "../tools/egress/client-node-egress";
import { createNodeWebContainerAdapter, waitForNodeProcess } from "./node-webcontainer-adapter";
import type { ExecutionAdapter } from "./runtime-registry";

let instance: WebContainer | undefined;
let adapter: ExecutionAdapter | undefined;
let adapterActivation: Promise<ExecutionAdapter> | undefined;
let activation: Promise<WebContainer> | undefined;
let lateBootCleanup: Promise<void> | undefined;
let activationEvidence: NodeWebContainerActivationEvidence | undefined;
let hostGeneration = 0;
const lifecycleListeners = new Set<(event: NodeWebContainerLifecycleEvent) => void>();

export type NodeWebContainerLifecycleEvent = Readonly<{
  generation: number;
  state: "ready" | "inactive";
  reason: "activated" | "deactivated";
}>;

export type NodeWebContainerActivationEvidence = Readonly<{
  probe: "npm --version";
  npmVersion: string;
  hostGeneration: number;
  activationMs: number;
  hostReused: boolean;
}>;

export function getNodeWebContainerActivationEvidence(): NodeWebContainerActivationEvidence | undefined {
  return activationEvidence ? Object.freeze({ ...activationEvidence }) : undefined;
}

/**
 * The first-class fetch_url escalation shares this pack and its one page host;
 * no second runtime, proxy service, or eager tool-bundle payload is introduced.
 */
export function createNodeWebContainerEgress(): ClientNodeEgressPort {
  return createClientNodeEgress({
    activate: activateNodeWebContainer,
    requireBrowserHost: true,
  });
}

/**
 * Monotonic identity for the shared page host. A terminal records this value
 * when it acquires the host; any later mismatch means the terminal must be
 * marked restart-required instead of writing to a torn-down WebContainer.
 */
export function getNodeWebContainerHostGeneration(): number {
  return hostGeneration;
}

/** Subscribe to host replacement/teardown without importing terminal code. */
export function subscribeNodeWebContainerLifecycle(
  listener: (event: NodeWebContainerLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

/**
 * Cold-start the one WebContainer instance allowed per page. This module is a
 * second-level dynamic chunk and is never fetched by runtime inspection alone.
 */
export async function activateNodeWebContainer(signal: AbortSignal, timeoutMs = 30_000): Promise<ExecutionAdapter> {
  if (adapter) return adapter;
  if (!adapterActivation) {
    adapterActivation = (async () => {
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const hostReused = Boolean(instance);
      const host = await activateNodeWebContainerHost(signal, timeoutMs);
      try {
        const npmVersion = await probeNodeWebContainerRuntime(
          host,
          Math.max(1, deadline - Date.now()),
          signal,
        );
        activationEvidence = Object.freeze({
          probe: "npm --version",
          npmVersion,
          hostGeneration,
          activationMs: Math.max(0, Date.now() - startedAt),
          hostReused,
        });
        adapter = createNodeWebContainerAdapter(host, {
          invalidateHost: async () => resetNodeWebContainerState(),
        });
        return adapter;
      } catch (error) {
        await resetNodeWebContainerState();
        throw error;
      }
    })();
  }
  const pending = adapterActivation;
  try {
    return await pending;
  } finally {
    if (adapterActivation === pending) adapterActivation = undefined;
  }
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
      publishLifecycle("ready", "activated");
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
  const pendingAdapter = adapterActivation;
  if (pendingAdapter) await pendingAdapter.catch(() => undefined);
  await resetNodeWebContainerState();
}

async function resetNodeWebContainerState(): Promise<void> {
  if (activation) await activation.catch(() => undefined);
  if (lateBootCleanup) await Promise.race([
    lateBootCleanup,
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  const activeInstance = instance;
  let teardownError: unknown;
  try {
    activeInstance?.teardown();
  } catch (error) {
    teardownError = error;
  } finally {
    instance = undefined;
    adapter = undefined;
    adapterActivation = undefined;
    activation = undefined;
    activationEvidence = undefined;
    if (activeInstance) publishLifecycle("inactive", "deactivated");
  }
  if (teardownError) throw teardownError;
}

function publishLifecycle(
  state: NodeWebContainerLifecycleEvent["state"],
  reason: NodeWebContainerLifecycleEvent["reason"],
): void {
  hostGeneration += 1;
  const event = Object.freeze({ generation: hostGeneration, state, reason });
  for (const listener of lifecycleListeners) {
    try {
      listener(event);
    } catch {
      // A presentation observer cannot control runtime lifecycle.
    }
  }
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

/** A booted provider frame is not enough: readiness requires a real npm process. */
export async function probeNodeWebContainerRuntime(
  host: Pick<WebContainer, "spawn">,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("WebContainer activation left no time for its npm probe.");
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const startedAt = Date.now();
  const spawn = host.spawn("npm", ["--version"], {
    env: { AIRSHIP_RUNTIME_PROBE: "node-webcontainer" },
    terminal: { cols: 80, rows: 12 },
  });
  let process: Awaited<typeof spawn>;
  try {
    process = await awaitBoundedWebContainerBoot(spawn, timeoutMs, signal);
  } catch (error) {
    void spawn.then((lateProcess) => {
      try { lateProcess.kill(); } catch { /* The late provider process may already be gone. */ }
    }, () => undefined);
    throw error;
  }
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const result = await waitForNodeProcess(process, remainingMs, signal);
  const plainOutput = result.output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const version = plainOutput.match(/(?:^|\s)(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u)?.[1];
  if (result.exitCode !== 0 || !version) {
    throw new Error(
      `WebContainer did not pass its real npm version probe (exit ${result.exitCode}; output ${JSON.stringify(plainOutput.trim().slice(0, 512))}).`,
    );
  }
  return version;
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

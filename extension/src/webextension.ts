/**
 * The slice of the WebExtension API this extension actually uses.
 *
 * Hand-written rather than pulled from `@types/chrome` so the surface stays
 * visible: anything not declared here cannot be called by accident. The
 * ciphertext cache uses ordinary extension-origin IndexedDB in its isolated
 * companion module; provider relay code has no storage API here.
 */

import type { SenderLike } from "./policy";
import type { DeclarativeNetRequestApi, WebRequestApi } from "./user-agent";

export type Listenable<T> = Readonly<{
  addListener(listener: T): void;
}>;

export type ExtensionPort = Readonly<{
  name: string;
  sender?: SenderLike;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Listenable<(message: unknown) => void>;
  onDisconnect: Listenable<() => void>;
}>;

export type WebExtensionApi = Readonly<{
  runtime: Readonly<{
    onConnect: Listenable<(port: ExtensionPort) => void>;
    connect(info: Readonly<{ name: string }>): ExtensionPort;
  }>;
  permissions?: Readonly<{
    contains(query: Readonly<{ origins: readonly string[] }>): Promise<boolean>;
  }>;
  declarativeNetRequest?: DeclarativeNetRequestApi;
  webRequest?: WebRequestApi;
}>;

/**
 * Firefox and Safari expose the promise-based `browser` namespace; Chromium
 * exposes `chrome`, whose MV3 methods also return promises. Both are read
 * through `typeof` so a missing namespace is a value, not a ReferenceError.
 */
export function resolveExtensionApi(scope: Readonly<Record<string, unknown>>): WebExtensionApi | undefined {
  const candidate = (scope.browser ?? scope.chrome) as WebExtensionApi | undefined;
  return candidate && typeof candidate === "object" && "runtime" in candidate ? candidate : undefined;
}

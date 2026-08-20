import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_WORKER_AMBIENT_GLOBALS,
  DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
  DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
  disposableWorkerIsolationPreludeSource,
} from "./disposable-worker-isolation-source";

describe("disposable worker isolation source", () => {
  it("freezes the canonical ambient and controller vocabularies", () => {
    expect(Object.isFrozen(DISPOSABLE_WORKER_AMBIENT_GLOBALS)).toBe(true);
    expect(Object.isFrozen(DISPOSABLE_WORKER_CONTROLLER_GLOBALS)).toBe(true);
    expect(Object.isFrozen(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS)).toBe(true);
    expect(DISPOSABLE_WORKER_AMBIENT_GLOBALS).toEqual(expect.arrayContaining([
      "fetch", "XMLHttpRequest", "WebSocket", "indexedDB", "caches",
      "localStorage", "sessionStorage", "Worker", "SharedWorker",
      "BroadcastChannel", "RTCPeerConnection", "webkitRTCPeerConnection",
      "webkitRequestFileSystem", "webkitResolveLocalFileSystemURL",
      "FontFace", "fonts",
    ]));
    expect(DISPOSABLE_WORKER_CONTROLLER_GLOBALS).toEqual([
      "postMessage", "onmessage", "onmessageerror", "close",
    ]);
    expect(DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS).toEqual([
      "addEventListener", "removeEventListener", "dispatchEvent",
    ]);
  });

  it("emits inherited-owner scrubbing, fail-closed checks, and receiver guards", () => {
    const source = disposableWorkerIsolationPreludeSource();
    for (const name of [
      ...DISPOSABLE_WORKER_AMBIENT_GLOBALS,
      ...DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
      ...DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
    ]) {
      expect(source).toContain(JSON.stringify(name));
    }
    expect(source).toContain("target = __getPrototypeOf(__controllerGlobal)");
    expect(source).toContain("Worker isolation could not hide");
    expect(source).toContain("this === __controllerGlobal");
    expect(source).toContain("target !== eventTargetPrototype");
  });
});

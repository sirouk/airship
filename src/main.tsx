import { render } from "preact";
import { App } from "./ui/app";
import { applyPreferenceOverrides, loadPreferenceOverrides } from "./ui/platform-shell";
import "./ui/styles.css";

/*
 * Presentation before the first frame, not after the runtime boots.
 *
 * These preferences are a synchronous localStorage read, but they used to be
 * applied by an effect gated on a resolved profile theme — the end of a
 * multi-await runtime boot. So `<html>` carried no mode or density attribute
 * for the entire boot window, and a reader who chose Paper got a full-screen
 * dark boot screen off the default type and density ramp before the app
 * corrected itself. Applied here, the very first render already sits on the
 * right sheet; `app.tsx` keeps it true for every later change.
 */
applyPreferenceOverrides(loadPreferenceOverrides());

render(<App />, document.getElementById("app")!);

// The capability probe chooses the semantic backend, the ORT thread count and
// the GPU power preference, so start it at boot. Correctness does not depend on
// this call: every consumer awaits the registry rather than sampling a cold
// snapshot. It only keeps the probe off the first embed's critical path.
void import("./capabilities/browser-runtime")
  .then(({ getBrowserCapabilityRegistry }) => getBrowserCapabilityRegistry().refresh())
  .catch(() => undefined);

const AIRSHIP_BASE_PATH = import.meta.env.BASE_URL;
const AIRSHIP_SERVICE_WORKER_PATH = `${AIRSHIP_BASE_PATH}sw.js`;
const AIRSHIP_SHELL_CACHE_PREFIX = "airship-shell-";

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      const scriptUrl = trustedServiceWorkerUrl();
      void navigator.serviceWorker.register(scriptUrl as string, { scope: AIRSHIP_BASE_PATH }).catch((error: unknown) => {
        console.warn("Airship cache unavailable.", error);
      });
    });
  } else {
    // A static preview may previously have claimed localhost. Vite does not
    // register a worker, so release only Airship's own worker and shell caches
    // before they can restore a stale offline document during development.
    void clearDevelopmentShell();
  }
}

function trustedServiceWorkerUrl(): string | object {
  const approved = new URL(AIRSHIP_SERVICE_WORKER_PATH, window.location.origin);
  approved.searchParams.set(
    "revision",
    new URL(import.meta.url).pathname.split("/").pop() || "build",
  );
  const value = approved.href;
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy(
        name: string,
    rules: { createScriptURL(input: string): string },
      ): { createScriptURL(input: string): object };
    };
  }).trustedTypes;
  if (!factory) return value;
  const policy = factory.createPolicy("airship-static", {
    createScriptURL(input) {
      if (input !== value) throw new TypeError("Invalid worker URL.");
      return input;
    },
  });
  return policy.createScriptURL(value);
}

async function clearDevelopmentShell(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration(AIRSHIP_BASE_PATH);
    const workers = registration
      ? [registration.active, registration.installing, registration.waiting].filter(Boolean)
      : [];
    const ownsRegistration = workers.some((worker) => isAirshipWorker(worker?.scriptURL));
    if (ownsRegistration) await registration?.unregister();
    if ("caches" in globalThis) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(AIRSHIP_SHELL_CACHE_PREFIX))
          .map((key) => caches.delete(key)),
      );
    }
    if (ownsRegistration && isAirshipWorker(navigator.serviceWorker.controller?.scriptURL)) {
      window.location.reload();
    }
  } catch {
    // Development remains network-only even when private browsing prevents
    // service-worker or Cache Storage inspection.
  }
}

function isAirshipWorker(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const candidate = new URL(rawUrl);
    return candidate.origin === window.location.origin
      && candidate.pathname === AIRSHIP_SERVICE_WORKER_PATH;
  } catch {
    return false;
  }
}

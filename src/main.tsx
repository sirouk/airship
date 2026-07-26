import { render } from "preact";
import { App } from "./ui/app";
import "./ui/styles.css";
import "./ui/durability-indicator.css";

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

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const scriptUrl = trustedServiceWorkerUrl();
    void navigator.serviceWorker.register(scriptUrl as string, { scope: AIRSHIP_BASE_PATH }).catch((error: unknown) => {
      console.warn("Airship service worker registration failed; offline shell caching is unavailable.", error);
    });
  });
}

function trustedServiceWorkerUrl(): string | object {
  const value = new URL(AIRSHIP_SERVICE_WORKER_PATH, window.location.origin).href;
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
      const candidate = new URL(input, window.location.origin);
      if (
        candidate.origin !== window.location.origin ||
        candidate.pathname !== AIRSHIP_SERVICE_WORKER_PATH ||
        candidate.search ||
        candidate.hash
      ) {
        throw new TypeError("Airship refused an unapproved script URL.");
      }
      return candidate.href;
    },
  });
  return policy.createScriptURL(value);
}

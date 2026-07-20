import { render } from "preact";
import { App } from "./ui/app";
import "./ui/styles.css";
import "./ui/durability-indicator.css";

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const scriptUrl = trustedServiceWorkerUrl();
    void navigator.serviceWorker.register(scriptUrl as string, { scope: "/" }).catch((error: unknown) => {
      console.warn("Airship service worker registration failed; offline shell caching is unavailable.", error);
    });
  });
}

function trustedServiceWorkerUrl(): string | object {
  const value = new URL("/sw.js", window.location.origin).href;
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
        candidate.pathname !== "/sw.js" ||
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

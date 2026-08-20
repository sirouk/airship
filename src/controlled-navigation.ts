const CONTROLLED_NAVIGATION_MARKER_PREFIX = "airship.controlled-navigation.v1:";

type ControlledNavigationOptions = Readonly<{
  basePath: string;
  revision: string;
  serviceWorkerPath: string;
}>;

/**
 * A meta CSP cannot enforce `frame-ancestors`. A headerless static host must
 * therefore not render Airship on its first, uncontrolled response. The
 * current release worker claims that inert document, then this boundary reloads
 * it. Only the worker-controlled navigation response carries the reviewed CSP.
 *
 * A versioned session marker distinguishes a controller that handled the
 * navigation from one that claimed the document after its headerless response.
 * The marker is written only immediately before a reload under the exact
 * release worker. If storage is unavailable, staying inert is safer than
 * guessing or entering a reload loop.
 */
export async function establishControlledNavigationBoundary({
  basePath,
  revision,
  serviceWorkerPath,
}: ControlledNavigationOptions): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    refuseUncontrolledNavigation("This browser cannot establish Airship's protected navigation boundary.");
    return false;
  }

  const approved = trustedServiceWorkerUrl(serviceWorkerPath, revision);
  const markerKey = `${CONTROLLED_NAVIGATION_MARKER_PREFIX}${approved.href}`;
  const controlledByRelease = () => navigator.serviceWorker.controller?.scriptURL === approved.href;
  const markerMatches = () => {
    try {
      return sessionStorage.getItem(markerKey) === approved.href;
    } catch {
      return false;
    }
  };
  const markReloadBoundary = () => {
    try {
      sessionStorage.setItem(markerKey, approved.href);
      return true;
    } catch {
      refuseUncontrolledNavigation("Airship cannot validate a protected reload in this storage mode.");
      return false;
    }
  };

  if (controlledByRelease()) {
    if (markerMatches()) return true;
    if (markReloadBoundary()) window.location.reload();
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChange);
      resolve(ready);
    };
    const controllerChange = () => {
      if (!controlledByRelease()) return;
      if (markReloadBoundary()) window.location.reload();
      finish(false);
    };
    const promote = (worker: ServiceWorker | null) => {
      if (!worker) return;
      if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      else worker.addEventListener("statechange", () => {
        if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      });
    };
    const timeout = window.setTimeout(() => {
      refuseUncontrolledNavigation("Airship could not establish its protected navigation boundary.");
      finish(false);
    }, 30_000);

    navigator.serviceWorker.addEventListener("controllerchange", controllerChange);
    void navigator.serviceWorker.register(approved.scriptUrl as string, { scope: basePath })
      .then((registration) => {
        promote(registration.installing);
        promote(registration.waiting);
        registration.addEventListener("updatefound", () => promote(registration.installing));
        if (controlledByRelease()) controllerChange();
      })
      .catch((error: unknown) => {
        console.warn("Airship cache unavailable.", error);
        refuseUncontrolledNavigation("Airship could not install its protected navigation boundary.");
        finish(false);
      });
  });
}

function refuseUncontrolledNavigation(message: string): void {
  const app = document.getElementById("app");
  if (app) app.textContent = message;
  document.documentElement.dataset.airshipNavigation = "refused";
}

function trustedServiceWorkerUrl(serviceWorkerPath: string, revision: string): Readonly<{
  href: string;
  scriptUrl: string | object;
}> {
  const approved = new URL(serviceWorkerPath, window.location.origin);
  approved.searchParams.set("revision", revision);
  const value = approved.href;
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy(
        name: string,
        rules: { createScriptURL(input: string): string },
      ): { createScriptURL(input: string): object };
    };
  }).trustedTypes;
  if (!factory) return Object.freeze({ href: value, scriptUrl: value });
  const policy = factory.createPolicy("airship-static", {
    createScriptURL(input) {
      if (input !== value) throw new TypeError("Invalid worker URL.");
      return input;
    },
  });
  return Object.freeze({ href: value, scriptUrl: policy.createScriptURL(value) });
}

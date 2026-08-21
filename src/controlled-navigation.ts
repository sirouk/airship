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
    return refuseUncontrolledNavigation("This browser cannot establish Airship's protected navigation boundary.");
  }

  const workers = navigator.serviceWorker;
  const approved = new URL(serviceWorkerPath, location.origin);
  approved.searchParams.set("revision", revision);
  const href = approved.href;
  const marker = `airship.cn:${href}`;
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy(
        name: string,
        rules: { createScriptURL(input: string): string },
      ): { createScriptURL(input: string): object };
    };
  }).trustedTypes;
  const scriptUrl = factory
    ? factory.createPolicy("airship-static", {
      createScriptURL(input) {
        if (input !== href) throw new TypeError("Invalid worker URL.");
        return input;
      },
    }).createScriptURL(href)
    : href;
  const controlledByRelease = () => workers.controller?.scriptURL === href;
  const reloadControlled = () => {
    try {
      sessionStorage.setItem(marker, href);
    } catch {
      return refuseUncontrolledNavigation("Airship cannot validate a protected reload in this storage mode.");
    }
    location.reload();
    return false;
  };

  if (controlledByRelease()) {
    try {
      if (sessionStorage.getItem(marker) === href) return true;
    } catch {
      // Rewriting the exact marker below either succeeds or leaves the page inert.
    }
    return reloadControlled();
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      workers.removeEventListener("controllerchange", controllerChange);
      resolve(false);
    };
    const controllerChange = () => {
      if (!controlledByRelease()) return;
      reloadControlled();
      finish();
    };
    const promote = (worker: ServiceWorker | null) => {
      if (!worker) return;
      if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      else worker.addEventListener("statechange", () => {
        if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      });
    };
    const timeout = window.setTimeout(() => {
      refuseUncontrolledNavigation();
      finish();
    }, 30_000);

    workers.addEventListener("controllerchange", controllerChange);
    void workers.register(scriptUrl as string, { scope: basePath })
      .then((registration) => {
        promote(registration.installing);
        promote(registration.waiting);
        registration.addEventListener("updatefound", () => promote(registration.installing));
        if (controlledByRelease()) controllerChange();
      })
      .catch(() => {
        refuseUncontrolledNavigation();
        finish();
      });
  });
}

function refuseUncontrolledNavigation(
  message = "Airship could not establish its protected navigation boundary.",
): false {
  const app = document.getElementById("app");
  if (app) app.textContent = message;
  document.documentElement.dataset.airshipNavigation = "refused";
  return false;
}

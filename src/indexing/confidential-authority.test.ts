import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasConfidentialAuthority,
  readConfidentialAuthority,
  setConfidentialAuthority,
  subscribeConfidentialAuthority,
} from "./confidential-authority";

afterEach(() => setConfidentialAuthority(undefined));

describe("the confidential embedding authority", () => {
  it("reports installation and withdrawal", () => {
    expect(hasConfidentialAuthority()).toBe(false);
    setConfidentialAuthority(() => "cpk_live");
    expect(hasConfidentialAuthority()).toBe(true);
    expect(readConfidentialAuthority()?.()).toBe("cpk_live");
    setConfidentialAuthority(undefined);
    expect(hasConfidentialAuthority()).toBe(false);
    expect(readConfidentialAuthority()).toBeUndefined();
  });

  it("announces only the presence transition, so a token rotation is not a UI event", () => {
    const listener = vi.fn();
    subscribeConfidentialAuthority(listener);

    setConfidentialAuthority(() => "cpk_first");
    setConfidentialAuthority(() => "cpk_rotated");
    setConfidentialAuthority(() => "cpk_rotated_again");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    setConfidentialAuthority(undefined);
    setConfidentialAuthority(undefined);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("stops notifying an unsubscribed listener", () => {
    const listener = vi.fn();
    subscribeConfidentialAuthority(listener)();
    setConfidentialAuthority(() => "cpk_live");
    expect(listener).not.toHaveBeenCalled();
  });

  /*
   * A component unmounting in response to this signal is the ordinary case, not
   * an exotic one: withdrawing the authority hides the control whose effect
   * holds the subscription. Iterating the live set would skip the next listener.
   */
  it("survives a listener that unsubscribes itself while being notified", () => {
    const order: string[] = [];
    const first = subscribeConfidentialAuthority(() => { order.push("first"); first(); });
    subscribeConfidentialAuthority(() => order.push("second"));

    setConfidentialAuthority(() => "cpk_live");
    expect(order).toEqual(["first", "second"]);

    setConfidentialAuthority(undefined);
    expect(order).toEqual(["first", "second", "second"]);
  });
});

/*
 * The defect this module was extracted to fix was not a bug in the setter — it
 * was that the setter had no caller at all, so `hasConfidentialAuthority()` was
 * permanently false and the whole `chutes` embedding mode was unreachable.
 * These bind the writer to the page-memory credential it must read, because a
 * writer that installs a captured copy of the token would keep serving a
 * released credential.
 */
describe("the writer", () => {
  const app = readFileSync(new URL("../ui/app.tsx", import.meta.url), "utf8");

  it("installs a supplier that reads the live credential ref, not a copy of it", () => {
    expect(app).toContain("setConfidentialAuthority(() => providerCredential.current)");
  });

  it("withdraws it when Chutes is released and when the page tears down", () => {
    const install = app.indexOf("setConfidentialAuthority(() => providerCredential.current)");
    expect(install).toBeGreaterThan(0);
    // The guarded early return, the effect cleanup, and the unmount teardown.
    expect(app.split("setConfidentialAuthority(undefined)").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("keys the authority on the connection rather than on the pinned session", () => {
    const install = app.indexOf("setConfidentialAuthority(() => providerCredential.current)");
    const guard = app.lastIndexOf("useEffect(() => {", install);
    const body = app.slice(guard, app.indexOf("}, [", install) + 16);

    /*
     * A workspace index may be rebuilt while the open session is a local one,
     * so `activeChutesConnection` — which additionally requires the *session's*
     * pinned binding to match this connection — would withdraw the authority
     * for a connection that is still live.
     */
    expect(body).toContain("if (!isChutesConnected(connection))");
    expect(body).toContain("}, [connection]");
  });
});

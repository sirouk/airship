import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasConfidentialAuthority,
  readConfidentialAuthority,
  setConfidentialAuthority,
  subscribeConfidentialAuthority,
} from "./confidential-authority";

afterEach(() => setConfidentialAuthority(undefined));

function invocation() {
  return { chuteId: "chute-a", path: "/v1/embeddings", payload: { input: ["x"] } };
}

describe("the confidential embedding authority", () => {
  it("reports installation and withdrawal", async () => {
    expect(hasConfidentialAuthority()).toBe(false);
    setConfidentialAuthority(async () => "sealed");
    expect(hasConfidentialAuthority()).toBe(true);
    await expect(readConfidentialAuthority()?.(invocation())).resolves.toBe("sealed");
    setConfidentialAuthority(undefined);
    expect(hasConfidentialAuthority()).toBe(false);
    expect(readConfidentialAuthority()).toBeUndefined();
  });

  it("announces only the presence transition, so a token rotation is not a UI event", () => {
    const listener = vi.fn();
    subscribeConfidentialAuthority(listener);

    setConfidentialAuthority(async () => "first");
    setConfidentialAuthority(async () => "rotated");
    setConfidentialAuthority(async () => "rotated again");
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
    setConfidentialAuthority(async () => "sealed");
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

    setConfidentialAuthority(async () => "sealed");
    expect(order).toEqual(["first", "second"]);

    setConfidentialAuthority(undefined);
    expect(order).toEqual(["first", "second", "second"]);
  });
});

/*
 * The defect this module was extracted to fix was not a bug in the setter — it
 * was that the setter had no caller at all, so `hasConfidentialAuthority()` was
 * permanently false and the whole `chutes` embedding mode was unreachable.
 * These bind the writer to the live E2EE transport it must read, because a
 * writer that installs a captured reference would keep invoking through a
 * released connection.
 */
describe("the writer", () => {
  const app = readFileSync(new URL("../ui/app.tsx", import.meta.url), "utf8");
  const install = app.indexOf("setConfidentialAuthority((request) => {");

  it("installs an invoker that reads the live transport ref, not a copy of it", () => {
    expect(install).toBeGreaterThan(0);
    const body = app.slice(install, app.indexOf("}, [", install));
    expect(body).toContain("const transport = chutesTransport.current;");
    expect(body).toContain("transport.invokeJson(");
  });

  /*
   * The whole point of moving embeddings onto the encrypted transport: the
   * indexing side is handed the capability to invoke, never the bearer. A
   * writer that reached for `providerCredential` here would put the raw key
   * back into a module whose job is to embed a corpus.
   */
  it("hands over a capability, never the bearer token", () => {
    const body = app.slice(install, app.indexOf("}, [", install));
    expect(body).not.toContain("providerCredential");
    expect(body).not.toContain("Bearer");
  });

  it("withdraws it when Chutes is released and when the page tears down", () => {
    expect(install).toBeGreaterThan(0);
    // The guarded early return, the effect cleanup, and the unmount teardown.
    expect(app.split("setConfidentialAuthority(undefined)").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("keys the authority on the connection rather than on the pinned session", () => {
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

import { describe, expect, it, vi } from "vitest";
import {
  refreshChutesOAuthToken,
  type ChutesOAuthTokenSet,
} from "./chutes-oauth";
import {
  ChutesCredentialBroker,
  ChutesCredentialBrokerError,
} from "./chutes-credential-broker";

const BASELINE_SCOPES = ["profile", "chutes:invoke", "billing:read"] as const;
const START = 2_000_000;

describe("ChutesCredentialBroker", () => {
  it("owns an API key without serializing it and fails closed for OAuth-only use", async () => {
    const broker = new ChutesCredentialBroker({ now: () => START });
    const key = "cpk_page-memory-only.value";

    const metadata = broker.installApiKey(key);

    expect(metadata).toEqual({
      status: "connected",
      revision: 1,
      credentialKind: "inference-api-key",
      installedAt: START,
      scopes: [],
      expiresAt: undefined,
      refreshable: false,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.keys(broker)).toEqual([]);
    expect(JSON.stringify(broker)).toBe("{}");
    expect(JSON.stringify(metadata)).not.toContain(key);
    await expect(broker.getBearerToken({ expectedKind: "inference-api-key" })).resolves.toBe(key);
    await expect(broker.getBearerToken({ expectedKind: "oauth-user-token" })).rejects.toMatchObject({
      code: "wrong-kind",
    });
    await expect(broker.getBearerToken({ requiredScopes: ["chutes:invoke"] })).rejects.toMatchObject({
      code: "missing-scope",
    });
    expect(() => broker.installApiKey("cak_wrong-credential-class")).toThrow("expected a cpk_");
  });

  it("owns a scoped OAuth token set while exposing only frozen nonsecret metadata", async () => {
    const broker = new ChutesCredentialBroker({ now: () => START });
    const accessToken = "cak_access.page-memory";
    const refreshToken = "crt_refresh.never-exposed";
    const sourceScopes = [...BASELINE_SCOPES, "openid"];
    const tokenSet = {
      accessToken,
      refreshToken,
      expiresAt: START + 60_000,
      scopes: sourceScopes,
    };

    const metadata = broker.installOAuthTokenSet(tokenSet);
    sourceScopes.splice(0);
    tokenSet.accessToken = "cak_mutated.after-install";
    tokenSet.refreshToken = "crt_mutated.after-install";

    expect(metadata).toEqual({
      status: "connected",
      revision: 1,
      credentialKind: "oauth-user-token",
      installedAt: START,
      scopes: [...BASELINE_SCOPES, "openid"],
      expiresAt: START + 60_000,
      refreshable: true,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.status === "connected" ? metadata.scopes : undefined)).toBe(true);
    const serialized = JSON.stringify({ broker, metadata });
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
    await expect(broker.getBearerToken({
      expectedKind: "oauth-user-token",
      requiredScopes: ["billing:read"],
      minimumValidityMs: 0,
    })).resolves.toBe(accessToken);
  });

  it("rejects wrong-class, expired, malformed, or under-scoped OAuth installs without replacing a valid state", async () => {
    const broker = new ChutesCredentialBroker({ now: () => START });
    broker.installApiKey("cpk_valid.existing");

    expect(() => broker.installOAuthTokenSet(oauthSet({ accessToken: "cpk_wrong.class" }))).toThrow("cak_");
    expect(() => broker.installOAuthTokenSet(oauthSet({ expiresAt: START }))).toThrow("expiry");
    expect(() => broker.installOAuthTokenSet(oauthSet({ refreshToken: "crt_" }))).toThrow("refresh token");
    expect(() => broker.installOAuthTokenSet(oauthSet({ scopes: ["profile", "chutes:invoke"] }))).toThrowError(
      expect.objectContaining({ code: "missing-scope" }),
    );
    await expect(broker.getBearerToken({ expectedKind: "inference-api-key" })).resolves.toBe("cpk_valid.existing");
    expect(broker.metadata()).toMatchObject({ credentialKind: "inference-api-key", revision: 1 });
  });

  it("never returns an expired OAuth bearer and clears an unrefreshable expired session", async () => {
    let now = START;
    const broker = new ChutesCredentialBroker({ now: () => now, minimumValidityMs: 0 });
    broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 10, refreshToken: undefined }));

    await expect(broker.getBearerToken({ minimumValidityMs: 0 })).resolves.toBe("cak_initial.access");
    now = START + 10;
    await expect(broker.getBearerToken({ minimumValidityMs: 0 })).rejects.toMatchObject({ code: "expired" });
    expect(broker.metadata()).toEqual({ status: "disconnected", revision: 2 });
  });

  it("coalesces concurrent refreshes, rotates both tokens, and increments the nonsecret revision", async () => {
    let now = START;
    const refresh = vi.fn(async (_request: Parameters<typeof refreshChutesOAuthToken>[0]) => oauthSet({
      accessToken: "cak_rotated.access",
      refreshToken: "crt_rotated.refresh",
      expiresAt: START + 3_600_000,
    }));
    const broker = new ChutesCredentialBroker({ now: () => now, refresh, minimumValidityMs: 30_000 });
    broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 20_000 }));

    const bearers = await Promise.all(Array.from({ length: 12 }, () => broker.getBearerToken({
      expectedKind: "oauth-user-token",
      requiredScopes: ["chutes:invoke"],
    })));

    expect(new Set(bearers)).toEqual(new Set(["cak_rotated.access"]));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toMatchObject({
      clientId: "cid_n2tusjazqmkkwon12jy3bo3u",
      refreshToken: "crt_initial.refresh",
    });
    expect(refresh.mock.calls[0]![0]).not.toHaveProperty("clientSecret");
    expect(broker.metadata()).toMatchObject({ revision: 2, expiresAt: START + 3_600_000, refreshable: true });

    now = START + 100;
    await expect(broker.getBearerToken()).resolves.toBe("cak_rotated.access");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fences a late refresh after clear and never resurrects the cleared session", async () => {
    const pending = deferred<ChutesOAuthTokenSet>();
    const broker = new ChutesCredentialBroker({
      now: () => START,
      refresh: vi.fn(async () => pending.promise),
      minimumValidityMs: 30_000,
    });
    broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 1 }));

    const bearer = broker.getBearerToken();
    expect(broker.clear()).toEqual({ status: "disconnected", revision: 2 });
    pending.resolve(oauthSet({
      accessToken: "cak_stale.must-not-return",
      refreshToken: "crt_stale.must-not-install",
      expiresAt: START + 60_000,
    }));

    await expect(bearer).rejects.toMatchObject({ code: "refresh-invalidated" });
    expect(broker.metadata()).toEqual({ status: "disconnected", revision: 2 });
    await expect(broker.getBearerToken()).rejects.toMatchObject({ code: "disconnected" });
  });

  it("fences a late refresh after API-key or OAuth account replacement", async () => {
    for (const replacement of ["api-key", "oauth"] as const) {
      const pending = deferred<ChutesOAuthTokenSet>();
      const broker = new ChutesCredentialBroker({
        now: () => START,
        refresh: vi.fn(async () => pending.promise),
      });
      broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 1 }));
      const oldBearer = broker.getBearerToken();

      if (replacement === "api-key") {
        broker.installApiKey("cpk_new.account");
      } else {
        broker.installOAuthTokenSet(oauthSet({
          accessToken: "cak_new.account",
          refreshToken: "crt_new.account",
          expiresAt: START + 60_000,
        }));
      }
      pending.resolve(oauthSet({
        accessToken: "cak_old.stale-result",
        refreshToken: "crt_old.stale-result",
        expiresAt: START + 60_000,
      }));

      await expect(oldBearer).rejects.toMatchObject({ code: "refresh-invalidated" });
      await expect(broker.getBearerToken({ minimumValidityMs: 0 })).resolves.toBe(
        replacement === "api-key" ? "cpk_new.account" : "cak_new.account",
      );
    }
  });

  it("clears the session on refresh rejection instead of falling back to the old bearer", async () => {
    const oldAccess = "cak_old.must-not-fallback";
    const broker = new ChutesCredentialBroker({
      now: () => START,
      refresh: vi.fn(async () => { throw new Error("provider text crt_secret-must-not-reflect"); }),
      minimumValidityMs: 30_000,
    });
    broker.installOAuthTokenSet(oauthSet({ accessToken: oldAccess, expiresAt: START + 20_000 }));

    const calls = await Promise.allSettled([broker.getBearerToken(), broker.getBearerToken()]);

    expect(calls).toHaveLength(2);
    for (const result of calls) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "refresh-failed" });
        expect(String(result.reason)).not.toContain("crt_secret");
      }
    }
    expect(broker.metadata()).toEqual({ status: "disconnected", revision: 2 });
    await expect(broker.getBearerToken()).rejects.toMatchObject({ code: "disconnected" });
  });

  it("rejects replayed refresh grants, missing scopes, and insufficient refreshed lifetime", async () => {
    const badResults: ChutesOAuthTokenSet[] = [
      oauthSet({ accessToken: "cak_replay.access", refreshToken: "crt_initial.refresh" }),
      oauthSet({ accessToken: "cak_scopeless.access", refreshToken: "crt_scopeless.refresh", scopes: ["profile"] }),
      oauthSet({ accessToken: "cak_short.access", refreshToken: "crt_short.refresh", expiresAt: START + 20_000 }),
    ];

    for (const result of badResults) {
      const broker = new ChutesCredentialBroker({
        now: () => START,
        refresh: vi.fn(async () => result),
        minimumValidityMs: 30_000,
      });
      broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 1 }));

      await expect(broker.getBearerToken()).rejects.toMatchObject({ code: "refresh-failed" });
      expect(broker.metadata()).toMatchObject({ status: "disconnected" });
    }
  });

  it("rejects replay of a refresh token retired by an earlier successful rotation", async () => {
    let now = START;
    const refresh = vi.fn(async () => refresh.mock.calls.length === 1
      ? oauthSet({
          accessToken: "cak_second.access",
          refreshToken: "crt_second.refresh",
          expiresAt: START + 60_000,
        })
      : oauthSet({
          accessToken: "cak_third.access",
          refreshToken: "crt_initial.refresh",
          expiresAt: START + 120_000,
        }));
    const broker = new ChutesCredentialBroker({ now: () => now, refresh, minimumValidityMs: 30_000 });
    broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 1 }));

    await expect(broker.getBearerToken()).resolves.toBe("cak_second.access");
    now = START + 40_000;
    await expect(broker.getBearerToken()).rejects.toMatchObject({ code: "refresh-failed" });

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(broker.metadata()).toMatchObject({ status: "disconnected" });
  });

  it("lets one waiter abort without poisoning the shared refresh for another waiter", async () => {
    const pending = deferred<ChutesOAuthTokenSet>();
    const refresh = vi.fn(async () => pending.promise);
    const broker = new ChutesCredentialBroker({ now: () => START, refresh });
    broker.installOAuthTokenSet(oauthSet({ expiresAt: START + 1 }));
    const controller = new AbortController();

    const aborted = broker.getBearerToken({ signal: controller.signal });
    const surviving = broker.getBearerToken();
    controller.abort(new DOMException("Caller left.", "AbortError"));
    pending.resolve(oauthSet({
      accessToken: "cak_surviving.access",
      refreshToken: "crt_surviving.refresh",
      expiresAt: START + 60_000,
    }));

    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await expect(surviving).resolves.toBe("cak_surviving.access");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("clears idempotently, rejects invalid request scopes, and reports only typed safe errors", async () => {
    const broker = new ChutesCredentialBroker({ now: () => START });
    expect(broker.clear()).toEqual({ status: "disconnected", revision: 1 });
    expect(broker.clear()).toEqual({ status: "disconnected", revision: 2 });
    broker.installApiKey("cpk_final.value");

    await expect(broker.getBearerToken({ requiredScopes: ["bad scope"] })).rejects.toThrow("operation scopes");
    const error = await broker.getBearerToken({ expectedKind: "oauth-user-token" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChutesCredentialBrokerError);
    expect(error).toMatchObject({ code: "wrong-kind", name: "ChutesCredentialBrokerError" });
    expect(String(error)).not.toContain("cpk_final.value");
  });
});

function oauthSet(overrides: Partial<ChutesOAuthTokenSet> = {}): ChutesOAuthTokenSet {
  return {
    accessToken: "cak_initial.access",
    refreshToken: "crt_initial.refresh",
    expiresAt: START + 60_000,
    scopes: BASELINE_SCOPES,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

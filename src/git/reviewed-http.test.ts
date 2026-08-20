import type { GitHttpRequest } from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewedGitHttp } from "./reviewed-http";

const origin = "https://git.example.test";
const remoteUrl = `${origin}/owner/repository.git`;
const requestUrl = `${remoteUrl}/info/refs?service=git-upload-pack`;

afterEach(() => vi.unstubAllGlobals());

describe("reviewed Git HTTP adapter", () => {
  it("omits ambient cookies and fixes every browser authority option immediately after review", async () => {
    const response = responseAt(requestUrl, 200);
    const fetch = vi.fn().mockResolvedValue(response);
    const reviewAuthority = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetch);
    const http = createReviewedGitHttp({ remoteUrl, reviewAuthority });

    // Extra Fetch-shaped properties are adversarial input. isomorphic-git's
    // request type does not declare them, and the adapter must never inherit
    // ambient-cookie or redirect authority from a widened caller.
    const request = {
      url: requestUrl,
      method: "GET",
      headers: { Accept: "application/x-git-upload-pack-advertisement" },
      credentials: "include",
      redirect: "follow",
      cache: "force-cache",
      referrerPolicy: "unsafe-url",
    } as GitHttpRequest;
    await http.request(request);

    expect(reviewAuthority).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(requestUrl, expect.objectContaining({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }));
    expect(reviewAuthority.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]!);
  });

  it.each([307, 308])("refuses an adversarial %s redirect without following it", async (status) => {
    const fetch = vi.fn().mockResolvedValue(responseAt(requestUrl, status, {
      Location: "https://evil.example.test/stolen.git",
    }));
    vi.stubGlobal("fetch", fetch);
    const http = createReviewedGitHttp({ remoteUrl, reviewAuthority: vi.fn() });

    await expect(http.request({ url: requestUrl })).rejects.toMatchObject({
      code: "git-http-redirect-refused",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });

  it("fails closed when Fetch reports a final response URL on another origin", async () => {
    const fetch = vi.fn().mockResolvedValue(responseAt(
      "https://evil.example.test/owner/repository.git/info/refs",
      200,
    ));
    vi.stubGlobal("fetch", fetch);
    const http = createReviewedGitHttp({ remoteUrl, reviewAuthority: vi.fn() });

    await expect(http.request({ url: requestUrl })).rejects.toMatchObject({
      code: "git-http-response-authority-mismatch",
    });
  });

  it.each([
    `${origin}/attacker/repository.git/git-receive-pack`,
    `${remoteUrl}.attacker/git-upload-pack`,
    `${origin}/owner%2Frepository.git/git-upload-pack`,
    `${remoteUrl}/objects/info/packs`,
    `${remoteUrl}/info/refs?service=git-upload-pack&service=git-receive-pack`,
  ])("rejects same-origin request authority outside the exact reviewed Smart HTTP path: %s", async (url) => {
    const fetch = vi.fn();
    const reviewAuthority = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const http = createReviewedGitHttp({ remoteUrl, reviewAuthority });

    await expect(http.request({ url, method: url.includes("info/refs") ? "GET" : "POST", headers: {
      authorization: "Basic MEMORY_ONLY_SECRET",
    } })).rejects.toMatchObject({ code: "git-http-request-authority-mismatch" });
    expect(reviewAuthority).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a same-origin final response path that differs from the reviewed request", async () => {
    const fetch = vi.fn().mockResolvedValue(responseAt(
      `${origin}/attacker/repository.git/info/refs?service=git-upload-pack`,
      200,
    ));
    vi.stubGlobal("fetch", fetch);
    const http = createReviewedGitHttp({ remoteUrl, reviewAuthority: vi.fn() });

    await expect(http.request({ url: requestUrl })).rejects.toMatchObject({
      code: "git-http-response-authority-mismatch",
    });
  });

  it("rejects an isomorphic-git request outside the prevalidated origin before authority review", async () => {
    const fetch = vi.fn();
    const reviewAuthority = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const http = createReviewedGitHttp({ remoteUrl, reviewAuthority });

    await expect(http.request({
      url: "https://evil.example.test/owner/repository.git/info/refs",
    })).rejects.toMatchObject({ code: "git-http-request-authority-mismatch" });
    expect(reviewAuthority).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

function responseAt(url: string, status: number, headers: HeadersInit = {}): Response {
  const response = new Response("git-response", { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

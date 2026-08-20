import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { GitDomainError, GitValidationError } from "./errors";

export type ReviewedGitHttpOptions = Readonly<{
  /** Exact canonical HTTPS repository URL approved by the Git egress policy. */
  remoteUrl: string;
  /**
   * Re-read and verify the configured remote authority. This runs after an
   * upload body is ready and immediately before every browser fetch call.
   */
  reviewAuthority: () => void | Promise<void>;
}>;

/**
 * Browser Smart HTTP transport with a closed redirect and ambient-authority
 * boundary. The caller supplies one prevalidated repository URL; neither
 * isomorphic-git nor Fetch may widen its origin or repository path.
 */
export function createReviewedGitHttp(options: ReviewedGitHttpOptions): HttpClient {
  const remoteUrl = options.remoteUrl;
  const reviewAuthority = options.reviewAuthority;
  const authority = exactHttpsRemote(remoteUrl);
  if (typeof reviewAuthority !== "function") {
    throw new GitValidationError("Reviewed Git HTTP authority callback is invalid.");
  }
  return Object.freeze({
    request: async (request: GitHttpRequest): Promise<GitHttpResponse> => {
      // Snapshot every caller-owned request field before body collection or
      // authority review can yield. In particular, credentials cannot be
      // swapped after the reviewed URL is selected.
      const rawUrl = request.url;
      const rawMethod = request.method;
      const rawHeaders = request.headers;
      const rawBody = request.body;
      const requestUrl = reviewedRequestUrl(rawUrl, authority);
      const method = rawMethod ?? "GET";
      if (
        (method !== "GET" && method !== "POST")
        || (method === "GET" && !requestUrl.pathname.endsWith("/info/refs"))
        || (method === "POST" && requestUrl.pathname.endsWith("/info/refs"))
      ) {
        throw new GitDomainError("git-http-request-method-invalid", "Git Smart HTTP refused an invalid request method.");
      }
      const requestHeaders = snapshotRequestHeaders(rawHeaders);
      const browserFetch = globalThis.fetch;
      if (typeof browserFetch !== "function") {
        throw new GitDomainError("git-http-unavailable", "This runtime has no browser Fetch implementation for Git Smart HTTP.");
      }
      const body = rawBody ? await collectBody(rawBody) : undefined;

      // This is deliberately the final await before fetch. Workspace callers
      // use it to re-read remote.<name>.url from .git/config, compare it with
      // the registry, and rerun the exact-origin Git policy.
      await reviewAuthority();
      const response = await browserFetch.call(globalThis, requestUrl.href, {
        method,
        headers: requestHeaders,
        ...(body ? { body } : {}),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });

      const finalUrl = responseUrl(response.url, requestUrl);
      if (response.status >= 300 && response.status < 400) {
        throw new GitDomainError(
          "git-http-redirect-refused",
          `Git Smart HTTP refused redirect response ${response.status}; the reviewed repository remains ${authority.remoteUrl}.`,
        );
      }

      const responseHeaders = Object.fromEntries(response.headers.entries());
      return {
        url: finalUrl.href,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: responseHeaders,
        body: responseBody(response),
      };
    },
  });
}

type ReviewedRemoteAuthority = Readonly<{
  remoteUrl: string;
  origin: string;
  repositoryPath: string;
  requestRepositoryPath: string;
}>;

function exactHttpsRemote(value: string): ReviewedRemoteAuthority {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new GitValidationError("Reviewed Git HTTP repository URL is invalid."); }
  const requestRepositoryPath = parsed.pathname;
  const repositoryPath = requestRepositoryPath.endsWith("/")
    ? requestRepositoryPath.slice(0, -1)
    : requestRepositoryPath;
  const remoteUrl = `${parsed.origin}${repositoryPath}`;
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || repositoryPath.length < 2
    || repositoryPath.endsWith("/")
    || parsed.href !== value
  ) {
    throw new GitValidationError("Reviewed Git HTTP repository URL must be one exact canonical HTTPS repository path.");
  }
  return Object.freeze({ remoteUrl, origin: parsed.origin, repositoryPath, requestRepositoryPath });
}

function reviewedRequestUrl(value: unknown, authority: ReviewedRemoteAuthority): URL {
  let parsed: URL;
  try {
    if (typeof value !== "string") throw new TypeError();
    parsed = new URL(value);
  } catch {
    throw new GitDomainError("git-http-request-url-invalid", "Git Smart HTTP refused an invalid request URL.");
  }
  if (parsed.origin !== authority.origin || parsed.username || parsed.password || parsed.hash) {
    throw requestAuthorityMismatch(authority);
  }
  if (
    authority.requestRepositoryPath !== authority.repositoryPath
    && parsed.pathname.startsWith(`${authority.requestRepositoryPath}/`)
  ) {
    parsed.pathname = `${authority.repositoryPath}${parsed.pathname.slice(authority.requestRepositoryPath.length)}`;
  }
  const suffix = parsed.pathname.slice(authority.repositoryPath.length);
  if (!parsed.pathname.startsWith(`${authority.repositoryPath}/`)) {
    throw requestAuthorityMismatch(authority);
  }
  if (suffix === "/info/refs") {
    const keys = [...parsed.searchParams.keys()];
    const service = parsed.searchParams.get("service");
    if (
      keys.length !== 1
      || keys[0] !== "service"
      || (service !== "git-upload-pack" && service !== "git-receive-pack")
    ) throw requestAuthorityMismatch(authority);
  } else if (suffix === "/git-upload-pack" || suffix === "/git-receive-pack") {
    if (parsed.search) throw requestAuthorityMismatch(authority);
  } else {
    throw requestAuthorityMismatch(authority);
  }
  return parsed;
}

function requestAuthorityMismatch(authority: ReviewedRemoteAuthority): GitDomainError {
  return new GitDomainError(
    "git-http-request-authority-mismatch",
    `Git Smart HTTP refused a request outside the reviewed repository ${authority.remoteUrl}.`,
  );
}

function responseUrl(value: string, requestUrl: URL): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch {
    throw new GitDomainError(
      "git-http-response-url-invalid",
      "Git Smart HTTP refused a response whose final URL could not be verified.",
    );
  }
  if (parsed.href !== requestUrl.href) {
    throw new GitDomainError(
      "git-http-response-authority-mismatch",
      "Git Smart HTTP refused a response whose final URL differed from the reviewed request.",
    );
  }
  return parsed;
}

function invalidRequestHeaders(reason = "invalid"): GitDomainError {
  return new GitDomainError("git-http-request-headers-invalid", `Git Smart HTTP refused ${reason} request headers.`);
}

function snapshotRequestHeaders(value: GitHttpRequest["headers"]): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequestHeaders();
  }
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalidRequestHeaders();
  }
  const headers: Record<string, string> = {};
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 64) {
    throw invalidRequestHeaders("too many");
  }
  for (const key of keys) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (
      typeof key !== "string"
      || !descriptor
      || !("value" in descriptor)
      || !descriptor.enumerable
      || typeof descriptor.value !== "string"
      || key.length === 0
      || key.length > 128
      || descriptor.value.length > 8_192
      || /[\u0000-\u001f\u007f]/u.test(key)
      || /[\u0000\u000a\u000d]/u.test(descriptor.value)
    ) {
      throw invalidRequestHeaders();
    }
    headers[key] = descriptor.value;
  }
  return Object.freeze(headers);
}

async function collectBody(body: AsyncIterableIterator<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const collected = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return collected.buffer;
}

async function* responseBody(response: Response): AsyncIterableIterator<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength) yield bytes;
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      if (item.value) yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

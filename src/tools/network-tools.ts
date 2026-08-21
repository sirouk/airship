import { objectArguments, requiredString } from "./schema";
import type { JsonValue, Tool } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { BrowserGitClient } from "../git/client";
import { rememberSourceRepository } from "../git/source-selection";
import type { ToolRegistry } from "./registry";
import { importAndAdmitGithubRepository } from "./repository-admission";
import type { ClientNodeEgressPort, NodeEgressResult } from "./egress/client-node-egress";
import type { ProfileWebBodies, ProfileWebEgress } from "../profiles/domain";
import { base64FromBytes, downloadPathFor, fetchBodyKind, FETCH_DOWNLOAD_DIRECTORY } from "./fetch-body";
import { encodeWorkspaceBytes } from "../workspace/content-codec";

// This is the WebContainer workspace-delta invariant, not a crawler policy.
// Use the whole reviewed channel by default; callers can choose a smaller read,
// but fetch_url must not silently restore an arbitrary pre-egress half-MiB cap.
const MAX_FETCH_LIMIT = 8 * 1_024 * 1_024;
const DEFAULT_FETCH_LIMIT = MAX_FETCH_LIMIT;
const NODE_WEBCONTAINER_ROUTE = "node-webcontainer";


type EgressAttempt = Readonly<{
  route: "browser" | "node-webcontainer";
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  transportAttempts?: number;
}>;

let sharedClientNodeEgress: Promise<ClientNodeEgressPort> | undefined;

/**
 * The tool definition stays light: the engine, embedded relay, MemoryWorkspace,
 * and WebContainer pack are one deferred client capability fetched only if the
 * ladder actually escalates beyond browser-direct.
 */
const lazyClientNodeEgress: ClientNodeEgressPort = {
  async fetch(target, init) {
    sharedClientNodeEgress ??= import("../execution/node-webcontainer-pack")
      .then(({ createNodeWebContainerEgress }) => createNodeWebContainerEgress());
    return (await sharedClientNodeEgress).fetch(target, init);
  },
};

export function registerNetworkTools(
  registry: ToolRegistry,
  workspace: WorkspacePort,
  git?: BrowserGitClient,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  clientNodeEgress?: ClientNodeEgressPort,
  webEgress: ProfileWebEgress = "node-first",
  // Wide open unless a profile deliberately narrows it. A body the origin
  // actually sent is the agent's to judge, so the client does not get a vote
  // by default — this parameter exists so a profile can take one back.
  webBodies: ProfileWebBodies = "any",
): void {
  const profileBodyDescription = webBodies === "any"
    ? `Content type never causes a refusal: a body that reads as text is returned as text whatever the origin labelled it, and one that does not is written to ${FETCH_DOWNLOAD_DIRECTORY}/ and returned as a path for you to read, decode or run over — set as:"base64" to inline it instead (that costs context proportional to maxBytes, so lower maxBytes when you do).`
    : "This Agent Profile restricted fetch_url to textual bodies; a response whose bytes are not text is reported as unsupported-content rather than returned, and as:\"base64\" is not available.";
  const profileRouteDescription = webEgress === "node-first"
    ? "This Agent Profile uses the client-side Node/WebContainer relay first for every request, with browser-direct as the automatic fallback."
    : "This Agent Profile opted out of client-side Node egress; requests stay browser-direct and remain subject to CORS.";
  const fetchUrl: Tool = {
    definition: {
      name: "fetch_url",
      description: `Fetch bounded HTTPS content (or loopback HTTP)${webBodies === "any" ? " in any format" : ", textual only"}. This is Airship's sole HTTP-egress interface. ${profileBodyDescription} ${profileRouteDescription} The relay uses core Node http/https and retries transient resets with a bare compatibility request; never call install_execution_runtime or execute_node_project to recreate web requests. ${webEgress === "node-first" ? 'Use via:"browser" for a one-request opt-out or via:"node-webcontainer" to force the profile default without browser fallback.' : 'This profile does not expose via:"node-webcontainer".'} maxBytes defaults to the full 8388608-byte return channel and may be lowered. After an exhausted provider reset, retry fetch_url once or choose another source/canonical REST endpoint; manual Node is not a different egress path.`,
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, maxLength: 8_192 },
          maxBytes: { type: "integer", minimum: 1_024, maximum: MAX_FETCH_LIMIT },
          ...(webBodies === "any" ? { as: { type: "string", enum: ["auto", "text", "base64"] } } : {}),
          via: { type: "string", enum: webEgress === "node-first"
            ? ["auto", "browser", NODE_WEBCONTAINER_ROUTE]
            : ["auto", "browser"] },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const url = safeHttpUrl(requiredString(args.url, "url"));
      const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : DEFAULT_FETCH_LIMIT;
      const as: DeliveryPreference = webBodies === "text-only"
        ? "text-only"
        : args.as === "text" || args.as === "base64" ? args.as : "auto";
      const via = args.via === "browser"
        ? "browser"
        : args.via === NODE_WEBCONTAINER_ROUTE && webEgress === "node-first"
          ? NODE_WEBCONTAINER_ROUTE
          : "auto";
      const attempts: EgressAttempt[] = [];

      const attemptBrowser = async () => {
        const browser = await browserRoute(url, maxBytes, as, workspace, context.signal, fetchImplementation);
        if (browser.success) return browser.success;
        attempts.push(browser.attempt);
        return undefined;
      };
      const attemptNode = async () => {
        const engine = clientNodeEgress ?? lazyClientNodeEgress;
        let engineResult: NodeEgressResult;
        try {
          engineResult = await engine.fetch(url, { maxBytes, signal: context.signal });
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason ?? error;
          engineResult = {
            ok: false,
            code: "node-egress-unavailable",
            message: error instanceof Error ? error.message : "The client Node egress engine failed without a message.",
          };
        }
        // No content-type refusal here, and none in the browser leg either.
        // A 2xx with a body is an answer; what shape it takes is the reader's
        // problem, and `deliver` solves it for both routes identically.
        if (
          engineResult.ok
          && engineResult.status >= 200
          && engineResult.status < 300
          && profileRefusesBody(as, engineResult.contentType, engineResult.bytes)
        ) {
          attempts.push(unsupportedContentAttempt(
            NODE_WEBCONTAINER_ROUTE,
            engineResult.contentType,
            engineResult.status,
            engineResult.transportAttempts,
          ));
          return undefined;
        }
        attempts.push(engineAttempt(engineResult));
        if (engineResult.ok && engineResult.status >= 200 && engineResult.status < 300) {
          return deliver({
            url: engineResult.finalUrl || url.toString(),
            requested: url,
            status: engineResult.status,
            contentType: engineResult.contentType,
            truncated: engineResult.truncated,
            bytes: engineResult.bytes,
            via: NODE_WEBCONTAINER_ROUTE,
            as,
            workspace,
            ...(engineResult.transportAttempts !== undefined
              ? { transportAttempts: engineResult.transportAttempts }
              : {}),
          });
        }
        return undefined;
      };

      if (via === "browser" || webEgress === "browser-only") {
        return await attemptBrowser() ?? egressFailure(url, attempts);
      }
      if (via === NODE_WEBCONTAINER_ROUTE) {
        return await attemptNode() ?? egressFailure(url, attempts);
      }
      // Agent Profile default: the reviewed Node http/https relay owns web
      // egress; browser-direct is the compatibility fallback when it cannot run.
      return await attemptNode() ?? await attemptBrowser() ?? egressFailure(url, attempts);
    },
  };

  const importRepository: Tool = {
    definition: {
      name: "import_github_repository",
      description: "Import a public GitHub repository snapshot into /workspace directly through browser CORS; this is a file snapshot, not full Git history.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", minLength: 1, maxLength: 2_048 },
          ref: { type: "string", minLength: 1, maxLength: 1_024 },
          destination: { type: "string", minLength: 1, maxLength: 4_096 },
          maxFiles: { type: "integer", minimum: 1, maximum: 10_000 },
          maxBytes: { type: "integer", minimum: 1_024, maximum: 128_000_000 },
        },
        required: ["repository"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const admission = await importAndAdmitGithubRepository({
        repository: requiredString(args.repository, "repository"),
        ...(typeof args.ref === "string" ? { ref: args.ref } : {}),
        ...(typeof args.destination === "string" ? { destination: args.destination } : {}),
        ...(typeof args.maxFiles === "number" ? { maxFiles: args.maxFiles } : {}),
        ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}),
        workspace,
        ...(git ? { git } : {}),
        fetch: fetchImplementation,
        signal: context.signal,
      });
      const result = admission.import;
      if (admission.repositoryId) rememberSourceRepository(admission.repositoryId);
      return {
        content: JSON.stringify({
          ...result,
          sources: admission.git ? {
            admitted: true,
            repositoryId: admission.repositoryId,
            worktreeId: admission.git.worktree?.id,
            state: admission.git.worktree?.status.length ? "changed" : "clean",
          } : {
            admitted: false,
            reason: "No browser Git adapter is attached to this runtime.",
          },
        }, null, 2),
        metadata: {
          filesWritten: result.filesWritten,
          bytesWritten: result.bytesWritten,
          destination: result.destination,
          commit: result.commit,
          gitAdmitted: Boolean(admission.git),
          ...(admission.repositoryId ? { repositoryId: admission.repositoryId } : {}),
        },
      };
    },
  };

  registry.register(fetchUrl);
  registry.register(importRepository);
}

async function browserRoute(
  url: URL,
  maxBytes: number,
  as: DeliveryPreference,
  workspace: WorkspacePort,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
): Promise<{ success?: Awaited<ReturnType<typeof deliver>>; attempt: EgressAttempt }> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      signal,
      // Ask for anything. Narrowing this made content negotiation refuse
      // bodies before the reader could decide it could hold them.
      headers: { Accept: "*/*" },
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return {
      attempt: {
        route: "browser",
        code: "cors-or-network",
        message: "The origin refused a direct cross-origin read (browser CORS enforcement) or did not answer.",
        retryable: true,
      },
    };
  }
  if (!response.ok) {
    return {
      attempt: {
        route: "browser",
        code: "http",
        message: `The origin returned HTTP ${response.status} to the direct browser read.`,
        retryable: response.status >= 500,
        status: response.status,
      },
    };
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const { bytes, truncated } = await readBounded(response, maxBytes, signal);
  if (profileRefusesBody(as, contentType, bytes)) {
    return { attempt: unsupportedContentAttempt("browser", contentType, response.status) };
  }
  return {
    success: await deliver({
      url: response.url || url.toString(),
      requested: url,
      status: response.status,
      contentType,
      truncated,
      bytes,
      via: "browser-direct",
      as,
      workspace,
    }),
    attempt: { route: "browser", code: "ok", message: "Answered.", retryable: false },
  };
}

function engineAttempt(result: NodeEgressResult): EgressAttempt {
  const common = {
    route: NODE_WEBCONTAINER_ROUTE,
    ...(result.transportAttempts !== undefined ? { transportAttempts: result.transportAttempts } : {}),
  } as const;
  if (result.ok) {
    if (result.status >= 200 && result.status < 300) {
      return { ...common, code: "ok", message: "Answered.", retryable: false };
    }
    return {
      ...common,
      code: "http",
      message: `The origin returned HTTP ${result.status} through the client Node egress engine.`,
      retryable: result.status >= 500,
      status: result.status,
    };
  }
  return {
    ...common,
    code: result.code,
    message: result.message,
    retryable: result.code !== "url" && result.code !== "config",
    ...(result.status !== undefined ? { status: result.status } : {}),
  };
}

type DeliveryPreference = "auto" | "text" | "base64" | "text-only";

/**
 * The one case where a 200 with a body does not become an answer.
 *
 * Only a profile that set `webBodies: "text-only"` reaches this, and it is
 * reported as this client's refusal rather than the origin's, with the profile
 * named — a wrong turn here used to look exactly like a broken website.
 */
function profileRefusesBody(as: DeliveryPreference, contentType: string, bytes: Uint8Array): boolean {
  return as === "text-only" && fetchBodyKind(contentType, bytes) === "binary";
}

function unsupportedContentAttempt(
  route: EgressAttempt["route"],
  contentType: string,
  status: number,
  transportAttempts?: number,
): EgressAttempt {
  return {
    route,
    code: "unsupported-content",
    message: `The origin returned ${contentType || "an unknown content type"} and this Agent Profile restricted fetch_url to textual bodies. The response was not the problem; change the profile's web bodies setting to accept any format.`,
    retryable: false,
    status,
    ...(transportAttempts !== undefined ? { transportAttempts } : {}),
  };
}

/**
 * Hand the body over in the form the agent can actually use.
 *
 * One function for both routes, because a body's shape has nothing to do with
 * which route carried it, and the two legs disagreeing about that was half of
 * the old confusion: a binary answer from the browser and the same answer from
 * the relay produced two different errors, neither of which contained the body.
 *
 *   text   — decoded and inline, exactly as before.
 *   binary — written to the downloads directory and returned as a path. The
 *            bytes survive the call at a cost of one line of context instead of
 *            four thirds of the object, and every existing file tool can reach
 *            them.
 *
 * `as` overrides the classification rather than the delivery: `text` forces a
 * lossy UTF-8 read of anything, `base64` inlines anything. Both are the agent
 * saying it knows what this payload is, which is the point of the tool.
 */
async function deliver(result: Readonly<{
  url: string;
  requested: URL;
  status: number;
  contentType: string;
  truncated: boolean;
  bytes: Uint8Array;
  via: "browser-direct" | "node-webcontainer";
  as: DeliveryPreference;
  workspace: WorkspacePort;
  transportAttempts?: number;
}>) {
  const { bytes, via, as, workspace, requested, transportAttempts, ...envelope } = result;
  const kind = as === "auto" || as === "text-only"
    ? fetchBodyKind(result.contentType, bytes)
    : as === "text" ? "text" : "binary";
  const common = {
    ...envelope,
    via,
    byteLength: bytes.byteLength,
    ...(transportAttempts !== undefined ? { transportAttempts } : {}),
  };
  const metadata = {
    byteLength: bytes.byteLength,
    truncated: result.truncated,
    status: result.status,
    via,
    ...(transportAttempts !== undefined ? { transportAttempts } : {}),
  };

  if (kind === "text") {
    return {
      content: JSON.stringify({
        ...common,
        encoding: "text",
        text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      }, null, 2),
      metadata: { ...metadata, encoding: "text" },
    };
  }

  if (as === "base64") {
    return {
      content: JSON.stringify({ ...common, encoding: "base64", base64: base64FromBytes(bytes) }, null, 2),
      metadata: { ...metadata, encoding: "base64" },
    };
  }

  const path = downloadPathFor(requested, result.contentType);
  // A workspace that refuses the write must not swallow the answer: the body
  // is still described, and the reason it is not on disk is said out loud so
  // the agent can retry with as:"base64" rather than guess.
  try {
    await workspace.write(path, encodeWorkspaceBytes(bytes));
  } catch (error) {
    return {
      content: JSON.stringify({
        ...common,
        encoding: "binary",
        saved: false,
        message: `${result.contentType || "This body"} is not text and could not be written to ${path}: ${
          error instanceof Error ? error.message : "the workspace refused the write"
        }. Re-request with as:"base64" to receive it inline.`,
      }, null, 2),
      metadata: { ...metadata, encoding: "binary", saved: false },
    };
  }
  return {
    content: JSON.stringify({
      ...common,
      encoding: "binary",
      saved: true,
      path,
      message: `${result.contentType || "This body"} is not text, so the ${String(bytes.byteLength)} bytes were written to ${path} rather than inlined. Read, decode or run over that path; re-request with as:"base64" only if you need it in the transcript.`,
    }, null, 2),
    metadata: { ...metadata, encoding: "binary", saved: true, path },
  };
}

/**
 * One honest boundary report for the whole egress ladder. The agent must see
 * every route that ran — where it stopped determines whether the fix is the
 * engine, the origin, or the address.
 */
function egressFailure(url: URL, attempts: readonly EgressAttempt[]) {
  const summary = attempts
    .map((attempt) => `${attempt.route === "browser" ? "Direct browser fetch" : "Client Node egress engine (containerized Node shipped with this client; no browser CORS)"}: ${attempt.message}`)
    .join(" ");
  const finalAttempt = attempts[attempts.length - 1];
  const nodeAttempt = attempts.find((attempt) => attempt.route === NODE_WEBCONTAINER_ROUTE);
  // Node-first is the Profile's authoritative route. Preserve its exhausted
  // provider error as the headline even when the browser fallback then hits CORS.
  const reportedAttempt = nodeAttempt ?? finalAttempt;
  const recovery = nodeAttempt?.retryable
    ? " The Node route auto-activated and already used core Node http/https; do not install the runtime or recreate this request with execute_node_project. Retry fetch_url once, or use another source or canonical REST endpoint."
    : "";
  return {
    content: JSON.stringify({
      ok: false,
      code: reportedAttempt?.code ?? "cors-or-network",
      url: url.toString(),
      message: `fetch_url ran every selected egress route and none returned the page. ${summary}${recovery} For a public GitHub repository, use import_github_repository.`,
      retryable: reportedAttempt?.retryable ?? false,
      boundary: "client-egress-ladder",
      attempts: attempts.map((attempt) => ({
        route: attempt.route,
        code: attempt.code,
        retryable: attempt.retryable,
        ...(attempt.status !== undefined ? { status: attempt.status } : {}),
        ...(attempt.transportAttempts !== undefined ? { transportAttempts: attempt.transportAttempts } : {}),
        message: attempt.message,
      })),
    }, null, 2),
    metadata: {
      code: reportedAttempt?.code ?? "cors-or-network",
      ...(reportedAttempt?.status !== undefined ? { status: reportedAttempt.status } : {}),
      ...(reportedAttempt?.transportAttempts !== undefined
        ? { transportAttempts: reportedAttempt.transportAttempts }
        : {}),
    },
    isError: true,
  };
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes: bytes.slice(0, maximum), truncated: bytes.byteLength > maximum };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.byteLength) continue;
      const remaining = maximum - total;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining));
        total = maximum;
        truncated = true;
        await reader.cancel("Airship fetch byte limit reached.");
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function safeHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be an absolute HTTPS URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Only HTTPS URLs are allowed, except HTTP loopback during local development.");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  return url;
}

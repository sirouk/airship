import type { JsonValue, Tool } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { BrowserGitClient } from "../git/client";
import { rememberSourceRepository } from "../git/source-selection";
import type { ToolRegistry } from "./registry";
import { importAndAdmitGithubRepository } from "./repository-admission";

const DEFAULT_FETCH_LIMIT = 512 * 1_024;
const MAX_FETCH_LIMIT = 2 * 1_024 * 1_024;

export function registerNetworkTools(
  registry: ToolRegistry,
  workspace: WorkspacePort,
  git?: BrowserGitClient,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): void {
  const fetchUrl: Tool = {
    definition: {
      name: "fetch_url",
      description: "Fetch bounded textual HTTPS content directly from this browser when the origin permits CORS.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, maxLength: 8_192 },
          maxBytes: { type: "integer", minimum: 1_024, maximum: MAX_FETCH_LIMIT },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const url = safeHttpUrl(stringArgument(args.url, "url"));
      const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : DEFAULT_FETCH_LIMIT;
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: "GET",
          credentials: "omit",
          redirect: "follow",
          signal: context.signal,
          headers: { Accept: "text/*, application/json, application/xml, application/xhtml+xml" },
        });
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        return networkFailure(
          url,
          "cors-or-network",
          "The browser could not read this origin directly. The site may be offline or may not grant Airship CORS access. No proxy or backend was used. For a public GitHub repository, use import_github_repository.",
        );
      }
      if (!response.ok) {
        return networkFailure(url, "http", `The origin returned HTTP ${response.status}.`, response.status);
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!isTextualContentType(contentType)) {
        return networkFailure(url, "unsupported-content", `The origin returned ${contentType || "an unknown content type"}; fetch_url reads bounded text only.`, response.status);
      }
      const { bytes, truncated } = await readBounded(response, maxBytes, context.signal);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return {
        content: JSON.stringify({
          url: response.url || url.toString(),
          status: response.status,
          contentType,
          truncated,
          text,
        }, null, 2),
        metadata: { byteLength: bytes.byteLength, truncated, status: response.status },
      };
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
        repository: stringArgument(args.repository, "repository"),
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
            state: "unstaged",
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

function networkFailure(url: URL, code: string, message: string, status?: number) {
  return {
    content: JSON.stringify({
      ok: false,
      code,
      url: url.toString(),
      message,
      retryable: code === "cors-or-network" || (status !== undefined && status >= 500),
      boundary: "direct-browser-fetch",
    }, null, 2),
    metadata: { code, ...(status !== undefined ? { status } : {}) },
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

function isTextualContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
  ].includes(contentType) || contentType.endsWith("+json") || contentType.endsWith("+xml");
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

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

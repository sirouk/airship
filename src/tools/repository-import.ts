import { normalizeWorkspacePath, type WorkspacePort } from "../workspace/contracts";

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_BYTES = 32 * 1_024 * 1_024;
const MAX_SINGLE_FILE_BYTES = 8 * 1_024 * 1_024;
const FETCH_CONCURRENCY = 10;

type GithubTreeEntry = Readonly<{
  path: string;
  type: "blob";
  size?: number;
}>;

type StagedFile = Readonly<{
  path: string;
  content: string;
  byteLength: number;
}>;

export type RepositoryImportResult = Readonly<{
  repository: string;
  ref: string;
  commit: string;
  destination: string;
  filesWritten: number;
  bytesWritten: number;
  skippedBinary: number;
  skippedUnsafe: number;
  /** Exact committed set used to fence Git admission and compensating rollback. */
  committed: readonly Readonly<{ path: string; revision: string }>[];
}>;

export type RepositoryImportProgress = Readonly<{
  phase: "resolving" | "tree" | "fetching" | "writing" | "complete";
  completed: number;
  total?: number;
  bytes?: number;
  detail: string;
}>;

/**
 * Import a public GitHub snapshot using only browser-CORS-safe endpoints.
 *
 * GitHub's tarball API redirects to codeload.github.com, which intentionally
 * does not grant arbitrary browser origins CORS access. Airship therefore
 * resolves one immutable commit/tree through api.github.com and reads pinned
 * blobs through raw.githubusercontent.com. Every byte is staged and validated
 * before the workspace is mutated; a failed write rolls back this import.
 */
export async function importGithubRepository(options: Readonly<{
  repository: string;
  ref?: string;
  destination?: string;
  maxFiles?: number;
  maxBytes?: number;
  workspace: WorkspacePort;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  onProgress?: (progress: RepositoryImportProgress) => void;
}>): Promise<RepositoryImportResult> {
  // Chromium's Window.fetch requires its platform receiver. Binding at the
  // boundary prevents callers passing a bare function from causing an
  // `Illegal invocation` before any HTTP request is made.
  const fetchImplementation = options.fetch.bind(globalThis);
  const identity = parseGithubRepository(options.repository);
  const maximumFiles = boundedInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 10_000, "maxFiles");
  const maximumBytes = boundedInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 1_024, 128_000_000, "maxBytes");
  const destination = normalizeWorkspacePath(options.destination ?? `/workspace/sources/${identity.name}`);
  if (destination === "/workspace") throw new Error("Repository imports require a destination below /workspace.");
  if ((await options.workspace.list(destination)).length > 0) {
    throw new Error(`Import destination is not empty: ${destination}. Choose a new destination or remove it explicitly.`);
  }

  emitProgress(options.onProgress, { phase: "resolving", completed: 0, detail: "Resolving repository and immutable commit" });

  const repositoryMetadata = await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`,
    fetchImplementation,
    options.signal,
  );
  const ref = options.ref?.trim() || stringProperty(repositoryMetadata, "default_branch");
  const commitMetadata = await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}/commits/${encodeURIComponent(ref)}`,
    fetchImplementation,
    options.signal,
  );
  const commit = stringProperty(commitMetadata, "sha");
  emitProgress(options.onProgress, { phase: "tree", completed: 0, detail: `Reading tree at ${commit.slice(0, 12)}` });
  const treeMetadata = await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
    fetchImplementation,
    options.signal,
  );
  if (treeMetadata.truncated === true) {
    throw new Error("GitHub truncated the recursive tree. Import a smaller subproject or use a native Git bridge.");
  }
  if (!Array.isArray(treeMetadata.tree)) throw new Error("GitHub returned malformed repository tree metadata.");

  let skippedUnsafe = 0;
  const blobs: GithubTreeEntry[] = [];
  for (const value of treeMetadata.tree) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "blob" || typeof entry.path !== "string") continue;
    if (!safeRelativePath(entry.path)) {
      skippedUnsafe += 1;
      continue;
    }
    const size = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0
      ? entry.size
      : undefined;
    if (size !== undefined && size > MAX_SINGLE_FILE_BYTES) {
      skippedUnsafe += 1;
      continue;
    }
    blobs.push(Object.freeze({ path: entry.path, type: "blob", ...(size !== undefined ? { size } : {}) }));
  }
  blobs.sort((left, right) => left.path.localeCompare(right.path));
  if (blobs.length > maximumFiles) throw new Error(`Repository exceeds the configured ${maximumFiles}-file import limit.`);
  const declaredBytes = blobs.reduce((total, entry) => total + (entry.size ?? 0), 0);
  if (declaredBytes > maximumBytes) throw new Error(`Repository exceeds the configured ${maximumBytes}-byte text import limit.`);

  let fetchedCount = 0;
  let fetchedBytes = 0;
  emitProgress(options.onProgress, { phase: "fetching", completed: 0, total: blobs.length, bytes: 0, detail: "Fetching pinned text files" });
  const fetched = await concurrentMap(blobs, FETCH_CONCURRENCY, options.signal, async (entry) => {
    const rawUrl = rawGithubUrl(identity.owner, identity.name, commit, entry.path);
    const response = await fetchImplementation(rawUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      signal: options.signal,
      headers: { Accept: "text/plain, application/octet-stream" },
    });
    if (!response.ok) throw new Error(`GitHub file read failed with HTTP ${response.status}: ${entry.path}.`);
    const maximum = Math.min(MAX_SINGLE_FILE_BYTES, maximumBytes);
    const bytes = await boundedResponseBytes(response, maximum, options.signal, entry.path);
    const file = looksBinary(bytes) ? undefined : Object.freeze({
      path: normalizeWorkspacePath(`${destination}/${entry.path}`),
      content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      byteLength: bytes.byteLength,
    } satisfies StagedFile);
    fetchedCount += 1;
    fetchedBytes += bytes.byteLength;
    emitProgress(options.onProgress, { phase: "fetching", completed: fetchedCount, total: blobs.length, bytes: fetchedBytes, detail: entry.path });
    return file;
  });

  const staged = fetched.filter((file): file is StagedFile => file !== undefined);
  const skippedBinary = fetched.length - staged.length;
  const bytesWritten = staged.reduce((total, file) => total + file.byteLength, 0);
  if (bytesWritten > maximumBytes) throw new Error(`Repository exceeds the configured ${maximumBytes}-byte text import limit.`);

  const manifestPath = normalizeWorkspacePath(`${destination}/.airship-import.json`);
  const manifest = `${JSON.stringify({
    version: 1,
    source: `https://github.com/${identity.owner}/${identity.name}`,
    ref,
    commit,
    importedAt: new Date().toISOString(),
    kind: "github-source-snapshot",
    history: "not-imported",
    transport: "github-tree+raw-cors-v1",
  }, null, 2)}\n`;
  const writes = [...staged, { path: manifestPath, content: manifest, byteLength: new TextEncoder().encode(manifest).byteLength }];
  const committed: Array<{ path: string; revision: string }> = [];
  emitProgress(options.onProgress, { phase: "writing", completed: 0, total: writes.length, bytes: bytesWritten, detail: "Committing staged snapshot to workspace" });
  try {
    for (const file of writes) {
      throwIfAborted(options.signal);
      const written = await options.workspace.write(file.path, file.content, { expectedRevision: null });
      committed.push({ path: written.path, revision: written.revision });
      emitProgress(options.onProgress, { phase: "writing", completed: committed.length, total: writes.length, bytes: bytesWritten, detail: file.path });
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const file of committed.reverse()) {
      try {
        await options.workspace.remove(file.path, { expectedRevision: file.revision });
      } catch {
        rollbackFailures.push(file.path);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(`Repository import failed and ${rollbackFailures.length} staged file(s) require explicit cleanup.`, { cause: error });
    }
    throw error;
  }

  const result = Object.freeze({
    repository: `${identity.owner}/${identity.name}`,
    ref,
    commit,
    destination,
    filesWritten: staged.length,
    bytesWritten,
    skippedBinary,
    skippedUnsafe,
    committed: Object.freeze(committed.map((entry) => Object.freeze({ ...entry }))),
  });
  emitProgress(options.onProgress, { phase: "complete", completed: writes.length, total: writes.length, bytes: bytesWritten, detail: `Pinned ${commit}` });
  return result;
}

function emitProgress(listener: ((progress: RepositoryImportProgress) => void) | undefined, progress: RepositoryImportProgress): void {
  if (!listener) return;
  try { listener(Object.freeze(progress)); } catch { /* Progress observers cannot alter import semantics. */ }
}

async function githubJson(url: string, fetchImplementation: typeof globalThis.fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      credentials: "omit",
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw browserFetchError("GitHub metadata", error);
  }
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned malformed repository metadata.");
  return value as Record<string, unknown>;
}

async function boundedResponseBytes(response: Response, maximum: number, signal: AbortSignal, label: string): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maximum) throw new Error(`${label} exceeds the ${maximum}-byte per-file limit.`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new Error(`${label} exceeds the ${maximum}-byte per-file limit.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel("Airship repository file limit reached.");
        throw new Error(`${label} exceeds the ${maximum}-byte per-file limit.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function concurrentMap<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  signal: AbortSignal,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await map(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return output;
}

function rawGithubUrl(owner: string, repository: string, commit: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(commit)}/${encodedPath}`;
}

function parseGithubRepository(value: string): { owner: string; name: string } {
  const trimmed = value.trim().replace(/\.git$/u, "");
  let owner: string | undefined;
  let name: string | undefined;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trimmed)) {
    [owner, name] = trimmed.split("/", 2);
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("repository must be owner/name or an https://github.com/owner/name URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
      throw new Error("Only public github.com HTTPS repositories can be imported directly.");
    }
    [owner, name] = url.pathname.split("/").filter(Boolean);
  }
  if (!owner || !name || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(name)) {
    throw new Error("repository must identify one GitHub owner and repository.");
  }
  return { owner, name };
}

function safeRelativePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8_192);
  for (let index = 0; index < limit; index += 1) if (bytes[index] === 0) return true;
  return false;
}

function stringProperty(value: Record<string, unknown>, name: string): string {
  const property = value[name];
  if (typeof property !== "string" || !property.trim()) throw new Error(`GitHub response omitted ${name}.`);
  return property;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside its supported bounds.`);
  return value;
}

function browserFetchError(label: string, error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  return new Error(`${label} could not be read directly by this browser. Check connectivity and the origin's CORS policy.`, { cause: error });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

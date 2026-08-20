import type { WorkspaceRootKey } from "./encrypted-envelope";
import type { GoogleAccessTokenProvider } from "./google-drive-auth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_DRIVE_JSON_BYTES = 512 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type GoogleDriveWorkspace = Readonly<{
  workspaceFolderId: string;
  workspaceName: string;
  rootFolderId: string;
  segmentsFolderId: string;
  webViewLink?: string;
  namespaceId: string;
}>;

type DriveFile = { id: string; name: string; mimeType: string; webViewLink?: string; appProperties?: Record<string, string> };

/** Locates one app-created, user-visible workspace hierarchy using drive.file. */
export class GoogleDriveWorkspaceManager {
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly tokenProvider: GoogleAccessTokenProvider,
    private readonly key: WorkspaceRootKey,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.fetchImplementation = fetchImplementation.bind(globalThis);
  }

  async connectOrCreate(name = "Airship Workspace", signal?: AbortSignal): Promise<GoogleDriveWorkspace> {
    const workspaceName = validFolderName(name);
    const namespaceId = await this.key.opaqueObjectId("airship/google-drive-workspace/v1");
    const workspace = await this.findOrCreateFolder(workspaceName, "root", "workspace", namespaceId, signal);
    const root = await this.findOrCreateFolder("root", workspace.id, "root", namespaceId, signal);
    const segments = await this.findOrCreateFolder("segments", root.id, "segments", namespaceId, signal);
    return workspaceDescriptor(workspace, root, segments, namespaceId);
  }

  /**
   * Recover an existing hierarchy without creating any folders.
   *
   * A recovery value is decryption authority, not evidence that the currently
   * selected Google account owns the matching ciphertext. Creating a blank
   * hierarchy on a miss would make a wrong-account selection look like a
   * successful recovery and establish a second authority. Imported recovery
   * therefore uses this fail-closed path exclusively.
   */
  async connectExisting(signal?: AbortSignal): Promise<GoogleDriveWorkspace> {
    const namespaceId = await this.key.opaqueObjectId("airship/google-drive-workspace/v1");
    const workspace = await this.findFolder("root", "workspace", namespaceId, signal);
    if (!workspace) throw workspaceNotFoundError();
    const root = await this.findFolder(workspace.id, "root", namespaceId, signal);
    if (!root) throw incompleteWorkspaceError("root");
    const segments = await this.findFolder(root.id, "segments", namespaceId, signal);
    if (!segments) throw incompleteWorkspaceError("segments");
    return workspaceDescriptor(workspace, root, segments, namespaceId);
  }

  private async findOrCreateFolder(
    name: string,
    parentId: string,
    role: string,
    namespaceId: string,
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const existing = await this.findFolder(parentId, role, namespaceId, signal);
    if (existing) return existing;
    await this.createFolder(name, parentId, role, namespaceId, signal);
    // Drive folder names are not unique. Re-list after creation so concurrent
    // initializers cannot silently establish competing authority hierarchies.
    const winner = await this.findFolder(parentId, role, namespaceId, signal);
    if (!winner) throw new Error(`Google Drive ${role} folder disappeared after creation.`);
    return winner;
  }

  async rename(workspace: GoogleDriveWorkspace, nextName: string, signal?: AbortSignal): Promise<GoogleDriveWorkspace> {
    const name = validFolderName(nextName);
    const response = await this.authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(workspace.workspaceFolderId)}?fields=id,name,mimeType,webViewLink,appProperties`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    });
    const file = await driveJson(response, "rename Google Drive workspace", signal);
    assertFolder(file);
    return Object.freeze({ ...workspace, workspaceName: file.name, webViewLink: file.webViewLink });
  }

  private async findFolder(parentId: string, role: string, namespaceId: string, signal?: AbortSignal): Promise<DriveFile | undefined> {
    const q = [
      `'${escapeDriveQuery(parentId)}' in parents`,
      `mimeType = '${FOLDER_MIME}'`,
      "trashed = false",
      `appProperties has { key='airshipNamespace' and value='${escapeDriveQuery(namespaceId)}' }`,
      `appProperties has { key='airshipRole' and value='${escapeDriveQuery(role)}' }`,
    ].join(" and ");
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("pageSize", "10");
    url.searchParams.set("orderBy", "createdTime");
    url.searchParams.set("fields", "files(id,name,mimeType,webViewLink,appProperties)");
    const response = await this.authorizedFetch(url, { signal });
    const body = await driveJson<{ files?: DriveFile[] }>(response, "locate Google Drive workspace folder", signal);
    const matches = (body.files ?? []).filter((file) => file.appProperties?.airshipNamespace === namespaceId && file.appProperties.airshipRole === role);
    for (const file of matches) assertFolder(file);
    if (matches.length > 1) throw ambiguousFolderError(role, matches.length);
    return matches.sort((left, right) => left.id.localeCompare(right.id))[0];
  }

  private async createFolder(name: string, parentId: string, role: string, namespaceId: string, signal?: AbortSignal): Promise<DriveFile> {
    const response = await this.authorizedFetch(`${DRIVE_API}/files?fields=id,name,mimeType,webViewLink,appProperties`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
        appProperties: { airshipNamespace: namespaceId, airshipRole: role },
      }),
      signal,
    });
    const file = await driveJson(response, "create Google Drive workspace folder", signal);
    assertFolder(file);
    return file;
  }

  private async authorizedFetch(input: string | URL, init: RequestInit): Promise<Response> {
    const token = await this.tokenProvider.getAccessToken(init.signal ?? undefined);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    return this.fetchImplementation(input, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  }
}

function workspaceDescriptor(
  workspace: DriveFile,
  root: DriveFile,
  segments: DriveFile,
  namespaceId: string,
): GoogleDriveWorkspace {
  return Object.freeze({
    workspaceFolderId: workspace.id,
    workspaceName: workspace.name,
    rootFolderId: root.id,
    segmentsFolderId: segments.id,
    webViewLink: workspace.webViewLink,
    namespaceId,
  });
}

function workspaceNotFoundError(): Error {
  const error = new Error("No Airship workspace matching this recovery key exists in the selected Google account. Switch accounts or verify the recovery key; no new folder was created.");
  error.name = "GoogleDriveWorkspaceNotFoundError";
  return error;
}

function incompleteWorkspaceError(role: "root" | "segments"): Error {
  const error = new Error(`The recovered Google Drive workspace is missing its ${role} encrypted-data folder. Restore the original app-created hierarchy before reconnecting; Airship did not replace it.`);
  error.name = "GoogleDriveWorkspaceIncompleteError";
  return error;
}

function ambiguousFolderError(role: string, count: number): Error {
  const error = new Error(`Google Drive returned ${count} matching ${role} folders; folder authority is ambiguous.`);
  error.name = "GoogleDriveAmbiguousFolderError";
  return error;
}

function validFolderName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f]/u.test(name)) throw new Error("Google Drive workspace name must be 1 to 120 printable characters.");
  return name;
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function assertFolder(value: unknown): asserts value is DriveFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google Drive returned invalid folder metadata.");
  const file = value as Partial<DriveFile>;
  if (typeof file.id !== "string" || !/^[A-Za-z0-9_-]{8,256}$/u.test(file.id) || typeof file.name !== "string" || file.mimeType !== FOLDER_MIME) {
    throw new Error("Google Drive returned invalid folder metadata.");
  }
}

async function driveJson<T = DriveFile>(response: Response, operation: string, signal?: AbortSignal): Promise<T> {
  if (!response.ok) throw await driveError(response, operation);
  try { return JSON.parse(decoder.decode(await boundedDriveBytes(response, signal))) as T; }
  catch { throw new Error(`Google Drive returned invalid JSON while attempting to ${operation}.`); }
}

async function driveError(response: Response, operation: string): Promise<Error> {
  const requestId = response.headers.get("x-guploader-uploadid") ?? response.headers.get("x-request-id");
  void response.body?.cancel().catch(() => undefined);
  const error = new Error(`Google Drive could not ${operation} (${response.status})${requestId ? ` [${requestId.slice(0, 128)}]` : ""}.`);
  error.name = "GoogleDriveStorageError";
  return error;
}

async function boundedDriveBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (
    !/^\d+$/u.test(declared) ||
    !Number.isSafeInteger(Number(declared)) ||
    Number(declared) > MAX_DRIVE_JSON_BYTES
  )) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Google Drive JSON response exceeded the client limit.");
  }
  if (!response.body) throw new Error("Google Drive returned an empty JSON response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DRIVE_JSON_BYTES) {
        await reader.cancel("Google Drive JSON response exceeded the client limit.").catch(() => undefined);
        throw new Error("Google Drive JSON response exceeded the client limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* an aborted body may retain its reader */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Google Drive request was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Google Drive request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

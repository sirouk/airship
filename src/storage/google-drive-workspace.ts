import type { WorkspaceRootKey } from "./encrypted-envelope";
import type { GoogleAccessTokenProvider } from "./google-drive-auth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

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
    return Object.freeze({
      workspaceFolderId: workspace.id,
      workspaceName: workspace.name,
      rootFolderId: root.id,
      segmentsFolderId: segments.id,
      webViewLink: workspace.webViewLink,
      namespaceId,
    });
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
    const file = await driveJson(response, "rename Google Drive workspace");
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
    const body = await driveJson<{ files?: DriveFile[] }>(response, "locate Google Drive workspace folder");
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
    const file = await driveJson(response, "create Google Drive workspace folder");
    assertFolder(file);
    return file;
  }

  private async authorizedFetch(input: string | URL, init: RequestInit): Promise<Response> {
    const token = await this.tokenProvider.getAccessToken(init.signal ?? undefined);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    return this.fetchImplementation(input, { ...init, headers });
  }
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

async function driveJson<T = DriveFile>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw await driveError(response, operation);
  try { return await response.json() as T; }
  catch { throw new Error(`Google Drive returned invalid JSON while attempting to ${operation}.`); }
}

async function driveError(response: Response, operation: string): Promise<Error> {
  const requestId = response.headers.get("x-guploader-uploadid") ?? response.headers.get("x-request-id");
  const error = new Error(`Google Drive could not ${operation} (${response.status})${requestId ? ` [${requestId.slice(0, 128)}]` : ""}.`);
  error.name = "GoogleDriveStorageError";
  return error;
}

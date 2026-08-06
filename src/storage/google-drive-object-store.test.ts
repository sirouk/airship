import { describe, expect, it } from "vitest";
import { ownedArrayBuffer } from "../core/bytes";
import { runObjectStoreConformance } from "./conformance";
import { WorkspaceRootKey } from "./encrypted-envelope";
import { GOOGLE_ACCOUNT_SCOPES, MemoryOnlyGoogleAccessTokenProvider } from "./google-drive-auth";
import { GoogleDriveObjectStore } from "./google-drive-object-store";
import { GoogleDriveWorkspaceManager } from "./google-drive-workspace";

describe("Google Drive encrypted ObjectStore", () => {
  it("passes the strict object contract through a visible renameable workspace hierarchy", async () => {
    const drive = new FakeDrive();
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const { key } = await WorkspaceRootKey.generate();
    const manager = new GoogleDriveWorkspaceManager(provider, key, drive.fetch);
    const workspace = await manager.connectOrCreate("Airship Test Workspace");
    expect(workspace.workspaceName).toBe("Airship Test Workspace");
    const renamed = await manager.rename(workspace, "Airship Renamed Workspace");
    expect(renamed.workspaceName).toBe("Airship Renamed Workspace");

    const store = new GoogleDriveObjectStore({ tokenProvider: provider, workspace: renamed, workspaceKey: key, fetchImplementation: drive.fetch });
    const result = await runObjectStoreConformance({ store, prefix: "probe", nonce: "driveprobe123" });
    expect(result.checks.map((check) => check.name)).toContain("concurrent CAS serialization");
    expect(await store.list("probe/driveprobe123/")).not.toHaveLength(0);
    // The adapter's routing index is encrypted. Production composition passes
    // already-enveloped journal/workspace/vector segments into ObjectStore;
    // this bare conformance probe intentionally uses known plaintext payloads.
    expect(new TextDecoder().decode(drive.filesByRole("object-index-v1")[0]!.bytes)).not.toContain("probe/driveprobe123");
    expect(drive.filesByRole("object-index-v1")).toHaveLength(1);
    expect(drive.filesByRole("encrypted-segment-v1").length).toBeGreaterThan(1);
  });

  it("reopens the same renamed workspace from recovery material without relying on its display name", async () => {
    const drive = new FakeDrive();
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const { key, recoveryBytes } = await WorkspaceRootKey.generate();
    const firstManager = new GoogleDriveWorkspaceManager(provider, key, drive.fetch);
    const created = await firstManager.connectOrCreate("Original Airship workspace");
    const renamed = await firstManager.rename(created, "Renamed in Drive");

    // This mirrors a new browser importing the saved recovery material. The
    // namespace derives from the root key, so the folder identity survives a
    // user-facing rename and a different suggested name at reconnect.
    const recoveredKey = await WorkspaceRootKey.import(recoveryBytes.slice());
    recoveryBytes.fill(0);
    const reopened = await new GoogleDriveWorkspaceManager(provider, recoveredKey, drive.fetch)
      .connectExisting();

    expect(reopened).toMatchObject({
      workspaceFolderId: renamed.workspaceFolderId,
      rootFolderId: renamed.rootFolderId,
      segmentsFolderId: renamed.segmentsFolderId,
      namespaceId: renamed.namespaceId,
      workspaceName: "Renamed in Drive",
    });
  });

  it("never creates a replacement hierarchy when imported recovery misses the selected account", async () => {
    const drive = new FakeDrive();
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const { key } = await WorkspaceRootKey.generate();
    const manager = new GoogleDriveWorkspaceManager(provider, key, drive.fetch);

    await expect(manager.connectExisting()).rejects.toMatchObject({
      name: "GoogleDriveWorkspaceNotFoundError",
      message: expect.stringContaining("no new folder was created"),
    });
    expect(drive.filesByRole("workspace")).toHaveLength(0);
    expect(drive.filesByRole("root")).toHaveLength(0);
    expect(drive.filesByRole("segments")).toHaveLength(0);
  });

  it("fails closed when more than one authority index exists", async () => {
    const { drive, provider, key, workspace, store } = await driveFixture();
    await store.list("");
    drive.duplicateObjectIndexRoot();
    const reconnecting = new GoogleDriveObjectStore({ tokenProvider: provider, workspace, workspaceKey: key, fetchImplementation: drive.fetch });
    await expect(reconnecting.list("")).rejects.toMatchObject({ name: "GoogleDriveAmbiguousRootError" });
    await expect(store.putIfAbsent("must-not-commit", new Uint8Array([1]))).rejects.toMatchObject({ name: "GoogleDriveAmbiguousRootError" });
  });

  it("reclaims indexed objects entry-first and confirms each removal with Drive", async () => {
    const { drive, store } = await driveFixture();
    await store.putIfAbsent("probe/alpha", new TextEncoder().encode("alpha"));
    await store.putIfAbsent("probe/beta", new TextEncoder().encode("beta"));
    await store.putIfAbsent("keep/gamma", new TextEncoder().encode("gamma"));
    const liveBefore = drive.liveFilesByRole("encrypted-segment-v1").length;

    const receipt = await store.trash(["probe/alpha", "probe/beta", "probe/never-written"]);
    expect(receipt).toMatchObject({
      requested: 3,
      reclaimed: ["probe/alpha", "probe/beta"],
      retained: ["probe/never-written"],
    });
    expect(receipt.outcomes).toContainEqual({ key: "probe/never-written", reclaimed: false, reason: "not-indexed" });

    // The index entry is gone and the body is out of the live listing.
    expect(await store.list("probe/")).toEqual([]);
    expect(await store.get("probe/alpha")).toBeUndefined();
    expect(drive.liveFilesByRole("encrypted-segment-v1")).toHaveLength(liveBefore - 2);
    // Untouched objects stay fully readable.
    expect(new TextDecoder().decode((await store.get("keep/gamma"))!.bytes)).toBe("gamma");
  });

  it("never claims a removal Drive refused, and still leaves no dangling index reference", async () => {
    const { drive, store } = await driveFixture();
    await store.putIfAbsent("probe/refused", new TextEncoder().encode("refused"));
    drive.refuseTrash = true;

    const receipt = await store.trash(["probe/refused"]);
    expect(receipt).toMatchObject({ requested: 1, reclaimed: [], retained: ["probe/refused"] });
    expect(receipt.outcomes).toEqual([{ key: "probe/refused", reclaimed: false, reason: "refused" }]);
    // Entry-first ordering means the leak is an untracked file, never a live
    // reference whose get() would hard-fail.
    expect(await store.list("probe/")).toEqual([]);
    expect(await store.get("probe/refused")).toBeUndefined();
    expect(drive.liveFilesByRole("encrypted-segment-v1").length).toBeGreaterThan(0);
  });

it("enumerates paged bodies no index entry names, and nothing else", async () => {
    const { drive, store, workspace } = await driveFixture();
    // Two live, index-committed objects: enumeration must never surface them.
    await store.putIfAbsent("live/one", new TextEncoder().encode("one"));
    await store.putIfAbsent("live/two", new TextEncoder().encode("two"));

    const planted = [
      drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } }),
      drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } }),
      drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } }),
    ];
    // Foreign bodies in the same folder are not this Vault's problem to report.
    drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: "someone-elses-namespace", airshipRole: "encrypted-segment-v1" } });
    drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "unrelated-role" } });

    // Provider pages hold whatever the query matches — tracked bodies included
    // — so a page can be legitimately empty of untracked objects. The contract
    // is: follow the token to the end and the union names exactly the crash
    // windows, never a live object.
    const enumerated = new Map<string, { size: number; createdAt?: string }>();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await store.listUntrackedProviderObjects({ pageSize: 2, pageToken });
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
      for (const object of page.objects) {
        expect(object.size).toBe(3);
        expect(typeof object.createdAt).toBe("string");
        enumerated.set(object.providerObjectId, object);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    expect(pages).toBeGreaterThan(1);
    expect([...enumerated.keys()].sort()).toEqual(planted.map((file) => file.id).sort());
  });

  it("trashes untracked bodies by provider id, sparing anything a fresh index now names", async () => {
    const { drive, store, workspace } = await driveFixture();
    await store.putIfAbsent("live/object", new TextEncoder().encode("live"));
    const trackedFileId = drive.filesByRole("encrypted-segment-v1")[0]!.id;

    const planted = [
      drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } }),
      drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } }),
    ];

    const receipt = await store.trashUntrackedProviderObjects([
      planted[0]!.id,
      planted[1]!.id,
      trackedFileId,
      "drive_file_never_existed",
    ]);
    expect(receipt.requested).toBe(4);
    expect([...receipt.reclaimed].sort()).toEqual([planted[0]!.id, planted[1]!.id, "drive_file_never_existed"].sort());
    expect(receipt.retained).toEqual([trackedFileId]);
    expect(receipt.outcomes).toContainEqual({ providerObjectId: trackedFileId, reclaimed: false, reason: "became-tracked" });

    // The live object survived the sweep untouched; both orphans left the live listing.
    expect(new TextDecoder().decode((await store.get("live/object"))!.bytes)).toBe("live");
    expect(drive.liveFilesByRole("encrypted-segment-v1")).toHaveLength(1);

    // A provider refusal is reported as retained, never swept into the reclaimed count.
    const refused = drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } });
    drive.refuseTrash = true;
    const refusedReceipt = await store.trashUntrackedProviderObjects([refused.id]);
    expect(refusedReceipt).toMatchObject({ requested: 1, reclaimed: [], retained: [refused.id] });
    expect(refusedReceipt.outcomes).toEqual([{ providerObjectId: refused.id, reclaimed: false, reason: "refused" }]);
  });

  it("reclaims exactly the crash-window body after the recovered write commits a replacement", async () => {
    const { drive, store, workspace } = await driveFixture();
    // The crash window itself: the upload landed; its index commit never did.
    const orphan = drive.plantRaw({ parents: [workspace.segmentsFolderId], appProperties: { airshipNamespace: workspace.namespaceId, airshipRole: "encrypted-segment-v1" } });

    // The retry the product actually runs: a fresh immutable upload that does
    // win its index commit. Both bodies now sit in the segments folder.
    const recovered = await store.putIfAbsent("live/replacement", new TextEncoder().encode("replacement"));
    expect(recovered.created).toBe(true);

    // Enumeration still names only the window's residue, and the sweep removes
    // exactly it — the recovered object is not offered up, not touched.
    expect((await store.listUntrackedProviderObjects()).objects.map((object) => object.providerObjectId)).toEqual([orphan.id]);
    const receipt = await store.trashUntrackedProviderObjects([orphan.id]);
    expect(receipt).toMatchObject({ requested: 1, reclaimed: [orphan.id], retained: [] });
    expect(new TextDecoder().decode((await store.get("live/replacement"))!.bytes)).toBe("replacement");
    expect((await store.listUntrackedProviderObjects()).objects).toEqual([]);
  });

  it("fails closed when a duplicate matching workspace hierarchy folder exists", async () => {
    const { drive, provider, key, workspace } = await driveFixture();
    drive.duplicateFolderByRole("workspace", "root");
    await expect(new GoogleDriveWorkspaceManager(provider, key, drive.fetch).connectOrCreate()).rejects.toMatchObject({
      name: "GoogleDriveAmbiguousFolderError",
    });

    drive.removeDuplicateFolderByRole("workspace", "root");
    drive.duplicateFolderByRole("root", workspace.workspaceFolderId);
    await expect(new GoogleDriveWorkspaceManager(provider, key, drive.fetch).connectOrCreate()).rejects.toMatchObject({
      name: "GoogleDriveAmbiguousFolderError",
    });

    drive.removeDuplicateFolderByRole("root", workspace.workspaceFolderId);
    drive.duplicateFolderByRole("segments", workspace.rootFolderId);
    await expect(new GoogleDriveWorkspaceManager(provider, key, drive.fetch).connectOrCreate()).rejects.toMatchObject({
      name: "GoogleDriveAmbiguousFolderError",
    });
  });

  it("coalesces concurrent range-reader index downloads while writes force freshness", async () => {
    const { drive, provider, key, workspace, store } = await driveFixture();
    const bytes = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");
    await store.putIfAbsent("range/expert.bin", bytes);
    const reader = new GoogleDriveObjectStore({ tokenProvider: provider, workspace, workspaceKey: key, fetchImplementation: drive.fetch });
    drive.resetIndexMediaReads();
    const ranges = await Promise.all([
      reader.getRange("range/expert.bin", 0, 8),
      reader.getRange("range/expert.bin", 8, 16),
      reader.getRange("range/expert.bin", 16, 24),
    ]);
    expect(ranges.map((range) => new TextDecoder().decode(range?.bytes))).toEqual(["01234567", "89abcdef", "ghijklmn"]);
    expect(drive.indexMediaReads).toBe(1);

    const current = await reader.get("range/expert.bin");
    await reader.compareAndSwap("range/expert.bin", current!.etag, new TextEncoder().encode("updated"));
    expect(drive.indexMediaReads).toBeGreaterThan(1);
  });

  it("resumes a large immutable shard within the active call without persisting the session capability", async () => {
    const { drive, store } = await driveFixture();
    const bytes = new Uint8Array(9 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    const result = await store.putIfAbsent("context/large-shard.enc", bytes);
    expect(result.created).toBe(true);
    expect(store.capabilities.upload).toEqual({
      mode: "resumable-active-call",
      interruptionRecovery: "resume-current-call",
      persistsResumeCapability: false,
    });
    expect(drive.resumableInitiations).toBe(1);
    expect(drive.resumableStatusQueries).toBeGreaterThan(0);
    expect(drive.resumableChunkWrites).toBeGreaterThanOrEqual(3);
    expect(drive.discardedResumableBodies).toBeGreaterThanOrEqual(3);
    expect((await store.getRange("context/large-shard.enc", 4 * 1024 * 1024, 4 * 1024 * 1024 + 64))?.bytes)
      .toEqual(bytes.slice(4 * 1024 * 1024, 4 * 1024 * 1024 + 64));
  });

  it("rejects an oversized chunked Drive metadata body before parsing it", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const { key } = await WorkspaceRootKey.generate();
    const store = new GoogleDriveObjectStore({
      tokenProvider: provider,
      workspace: {
        workspaceFolderId: "drive_workspace_bounded",
        workspaceName: "Bounded Drive",
        rootFolderId: "drive_root_bounded",
        segmentsFolderId: "drive_segments_bounded",
        namespaceId: "opaque-drive-bounded-response",
      },
      workspaceKey: key,
      fetchImplementation: async () => new Response(JSON.stringify({
        files: [],
        ignoredPadding: "x".repeat(600 * 1024),
      }), { headers: { "content-type": "application/json" } }),
    });

    await expect(store.list("")).rejects.toThrow("invalid JSON");
  });

  it("rejects oversized workspace-discovery metadata before folder creation", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const { key } = await WorkspaceRootKey.generate();
    const manager = new GoogleDriveWorkspaceManager(provider, key, async () => new Response(JSON.stringify({
      files: [],
      ignoredPadding: "x".repeat(600 * 1024),
    }), { headers: { "content-type": "application/json" } }));

    await expect(manager.connectOrCreate()).rejects.toThrow("invalid JSON");
  });
});

async function driveFixture() {
  const drive = new FakeDrive();
  const provider = new MemoryOnlyGoogleAccessTokenProvider();
  provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
  const { key } = await WorkspaceRootKey.generate();
  const workspace = await new GoogleDriveWorkspaceManager(provider, key, drive.fetch).connectOrCreate();
  const store = new GoogleDriveObjectStore({ tokenProvider: provider, workspace, workspaceKey: key, fetchImplementation: drive.fetch });
  return { drive, provider, key, workspace, store };
}

type StoredFile = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  bytes: Uint8Array;
  createdTime: string;
  modifiedTime: string;
  etag: string;
  trashed: boolean;
};

class FakeDrive {
  private sequence = 10_000;
  private readonly files = new Map<string, StoredFile>();
  private readonly uploadSessions = new Map<string, {
    metadata: { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
    total: number;
    bytes: Uint8Array;
    injectedUnknownCommit: boolean;
  }>();
  indexMediaReads = 0;
  resumableInitiations = 0;
  resumableStatusQueries = 0;
  resumableChunkWrites = 0;
  discardedResumableBodies = 0;
  refuseTrash = false;
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== "Bearer temporary-google-token") return new Response("", { status: 401 });
    const method = init.method ?? "GET";
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    const uploadMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    const resumableMatch = /^\/upload\/drive\/v3\/sessions\/([^/]+)$/u.exec(url.pathname);

    if (method === "GET" && url.pathname === "/drive/v3/files") return this.list(url);
    if (method === "POST" && url.pathname === "/drive/v3/files") return this.createFolder(init);
    if (method === "POST" && url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
      return this.startResumable(url, init);
    }
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") return this.createMultipart(init);
    if (method === "PUT" && resumableMatch) return this.writeResumable(decodeURIComponent(resumableMatch[1]!), init);
    if (method === "PATCH" && fileMatch) return this.patchMetadata(decodeURIComponent(fileMatch[1]!), init);
    if (method === "PATCH" && uploadMatch) return this.updateMedia(decodeURIComponent(uploadMatch[1]!), init);
    if (method === "GET" && fileMatch && url.searchParams.get("alt") === "media") return this.media(decodeURIComponent(fileMatch[1]!), headers);
    return new Response("", { status: 404 });
  };

  private startResumable(url: URL, init: RequestInit): Response {
    const metadata = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
    const total = Number(new Headers(init.headers).get("x-upload-content-length"));
    if (!Number.isSafeInteger(total) || total < 1) return new Response("", { status: 400 });
    const id = `resume_${++this.sequence}`;
    this.uploadSessions.set(id, { metadata, total, bytes: new Uint8Array(), injectedUnknownCommit: false });
    this.resumableInitiations += 1;
    const location = new URL(`/upload/drive/v3/sessions/${id}`, url.origin).href;
    return this.resumableControlResponse(200, { location });
  }

  private async writeResumable(id: string, init: RequestInit): Promise<Response> {
    const session = this.uploadSessions.get(id);
    if (!session) return new Response("", { status: 404 });
    const contentRange = new Headers(init.headers).get("content-range") ?? "";
    if (contentRange === `bytes */${session.total}`) {
      this.resumableStatusQueries += 1;
      return this.resumableControlResponse(308,
        session.bytes.byteLength ? { range: `bytes=0-${session.bytes.byteLength - 1}` } : undefined);
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange);
    if (!match || Number(match[1]) !== session.bytes.byteLength || Number(match[3]) !== session.total) {
      return new Response("", { status: 400 });
    }
    const chunk = new Uint8Array(await new Response(init.body).arrayBuffer());
    if (chunk.byteLength !== Number(match[2]) - Number(match[1]) + 1) return new Response("", { status: 400 });
    const next = new Uint8Array(session.bytes.byteLength + chunk.byteLength);
    next.set(session.bytes);
    next.set(chunk, session.bytes.byteLength);
    session.bytes = next;
    this.resumableChunkWrites += 1;
    // Model a dropped/5xx acknowledgement after Drive committed the first
    // chunk. The adapter must query Range and continue from the server offset.
    if (!session.injectedUnknownCommit) {
      session.injectedUnknownCommit = true;
      return this.resumableControlResponse(503);
    }
    if (session.bytes.byteLength < session.total) {
      return this.resumableControlResponse(308, { range: `bytes=0-${session.bytes.byteLength - 1}` });
    }
    if (session.bytes.byteLength !== session.total) return new Response("", { status: 400 });
    const file = this.insert(session.metadata, session.bytes);
    this.uploadSessions.delete(id);
    return Response.json(this.metadata(file));
  }

  private resumableControlResponse(status: number, headers?: HeadersInit): Response {
    const drive = this;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([0])); },
      cancel() { drive.discardedResumableBodies += 1; },
    }), { status, headers });
  }

  /** Plant bodies the way crash windows do: present in Drive, uncommitted to any index. */
  plantRaw(
    metadata: { name?: string; mimeType?: string; parents: string[]; appProperties: Record<string, string> },
    bytes: Uint8Array = new Uint8Array([7, 7, 7]),
  ): StoredFile {
    return this.insert({
      name: metadata.name ?? `planted_${this.files.size}.enc`,
      mimeType: metadata.mimeType ?? "application/vnd.airship.encrypted-segment",
      parents: metadata.parents,
      appProperties: metadata.appProperties,
    }, bytes);
  }

  filesByRole(role: string): StoredFile[] {
    return [...this.files.values()].filter((file) => file.appProperties.airshipRole === role);
  }

  liveFilesByRole(role: string): StoredFile[] {
    return this.filesByRole(role).filter((file) => !file.trashed);
  }

  plaintextBodies(): string {
    return [...this.files.values()].map((file) => new TextDecoder().decode(file.bytes)).join("\n");
  }

  resetIndexMediaReads(): void {
    this.indexMediaReads = 0;
  }

  duplicateObjectIndexRoot(): void {
    const source = this.filesByRole("object-index-v1")[0];
    if (!source) throw new Error("object index is missing");
    this.insert({
      name: source.name,
      mimeType: source.mimeType,
      parents: [...source.parents],
      appProperties: { ...source.appProperties },
    }, source.bytes.slice());
  }

  duplicateFolderByRole(role: string, parentId: string): void {
    const source = [...this.files.values()].find((file) =>
      file.mimeType === "application/vnd.google-apps.folder"
      && file.appProperties.airshipRole === role
      && file.parents.includes(parentId),
    );
    if (!source) throw new Error(`folder role is missing: ${role}`);
    this.insert({
      name: source.name,
      mimeType: source.mimeType,
      parents: [...source.parents],
      appProperties: { ...source.appProperties },
    }, new Uint8Array());
  }

  removeDuplicateFolderByRole(role: string, parentId: string): void {
    const matches = [...this.files.values()].filter((file) =>
      file.mimeType === "application/vnd.google-apps.folder"
      && file.appProperties.airshipRole === role
      && file.parents.includes(parentId),
    ).sort((left, right) => left.id.localeCompare(right.id));
    for (const duplicate of matches.slice(1)) this.files.delete(duplicate.id);
  }

  private list(url: URL): Response {
    const query = url.searchParams.get("q") ?? "";
    const parent = /'([^']+)' in parents/u.exec(query)?.[1];
    const role = /key='airshipRole' and value='([^']+)'/u.exec(query)?.[1];
    const namespace = /key='airshipNamespace' and value='([^']+)'/u.exec(query)?.[1];
    const excludeTrashed = query.includes("trashed = false");
    let files = [...this.files.values()].filter((file) =>
      (!excludeTrashed || !file.trashed)
      && (!parent || file.parents.includes(parent)) && (!role || file.appProperties.airshipRole === role) && (!namespace || file.appProperties.airshipNamespace === namespace),
    );
    // Drive pages list responses. Tokens are offsets here; real Drive tokens
    // are opaque, which the adapter only ever forwards, never interprets.
    const pageSizeParam = url.searchParams.get("pageSize");
    const pageSize = pageSizeParam ? Number(pageSizeParam) : files.length;
    const start = Number(url.searchParams.get("pageToken") ?? "0");
    const nextPageToken = start + pageSize < files.length ? String(start + pageSize) : undefined;
    files = files.slice(start, pageSize ? start + pageSize : undefined);
    return Response.json({
      files: files.map((file) => this.metadata(file)),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  private async createFolder(init: RequestInit): Promise<Response> {
    const metadata = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
    return Response.json(this.metadata(this.insert(metadata, new Uint8Array())));
  }

  private async createMultipart(init: RequestInit): Promise<Response> {
    const contentType = new Headers(init.headers).get("content-type") ?? "";
    const boundary = /boundary=([^;]+)/u.exec(contentType)?.[1];
    if (!boundary || !(init.body instanceof Blob)) return new Response("", { status: 400 });
    const body = new Uint8Array(await init.body.arrayBuffer());
    const firstHeaderEnd = find(body, new TextEncoder().encode("\r\n\r\n"), 0);
    const nextBoundary = find(body, new TextEncoder().encode(`\r\n--${boundary}`), firstHeaderEnd + 4);
    const metadata = JSON.parse(new TextDecoder().decode(body.slice(firstHeaderEnd + 4, nextBoundary))) as { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
    const secondHeaderEnd = find(body, new TextEncoder().encode("\r\n\r\n"), nextBoundary + boundary.length + 4);
    const finalBoundary = find(body, new TextEncoder().encode(`\r\n--${boundary}--`), secondHeaderEnd + 4);
    const file = this.insert(metadata, body.slice(secondHeaderEnd + 4, finalBoundary));
    return Response.json(this.metadata(file), { headers: { etag: file.etag } });
  }

  private async patchMetadata(id: string, init: RequestInit): Promise<Response> {
    const file = this.files.get(id);
    if (!file) return new Response("", { status: 404 });
    const patch = JSON.parse(String(init.body)) as { name?: string; trashed?: boolean };
    if (patch.name) file.name = patch.name;
    if (patch.trashed === true) {
      if (this.refuseTrash) return new Response("", { status: 403 });
      file.trashed = true;
    }
    file.modifiedTime = new Date().toISOString();
    return Response.json({ ...this.metadata(file), trashed: file.trashed });
  }

  private async updateMedia(id: string, init: RequestInit): Promise<Response> {
    const file = this.files.get(id);
    if (!file) return new Response("", { status: 404 });
    if (new Headers(init.headers).get("if-match") !== file.etag) return new Response("", { status: 412 });
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    file.bytes = bytes;
    file.etag = `"version-${++this.sequence}"`;
    file.modifiedTime = new Date().toISOString();
    return Response.json({ id }, { headers: { etag: file.etag } });
  }

  private media(id: string, headers: Headers): Response {
    const file = this.files.get(id);
    if (!file) return new Response("", { status: 404 });
    if (file.appProperties.airshipRole === "object-index-v1") this.indexMediaReads += 1;
    const range = /^bytes=(\d+)-(\d+)$/u.exec(headers.get("range") ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const bytes = file.bytes.slice(start, end + 1);
      return new Response(ownedArrayBuffer(bytes), { status: 206, headers: { etag: file.etag, "content-length": String(bytes.byteLength), "content-range": `bytes ${start}-${end}/${file.bytes.byteLength}` } });
    }
    return new Response(ownedArrayBuffer(file.bytes), { headers: { etag: file.etag, "content-length": String(file.bytes.byteLength) } });
  }

  private insert(metadata: { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> }, bytes: Uint8Array): StoredFile {
    const id = `drive_file_${++this.sequence}`;
    const createdTime = new Date().toISOString();
    const file: StoredFile = { id, ...metadata, bytes, createdTime, modifiedTime: createdTime, etag: `"version-${this.sequence}"`, trashed: false };
    this.files.set(id, file);
    return file;
  }

  private metadata(file: StoredFile): Record<string, unknown> {
    return { id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.bytes.byteLength), createdTime: file.createdTime, modifiedTime: file.modifiedTime, appProperties: file.appProperties, webViewLink: `https://drive.google.test/open?id=${file.id}` };
  }
}

function find(haystack: Uint8Array, needle: Uint8Array, start: number): number {
  outer: for (let index = start; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) if (haystack[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  throw new Error("multipart delimiter not found");
}

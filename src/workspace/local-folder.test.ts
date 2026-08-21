import { beforeEach, describe, expect, it } from "vitest";
import {
  isLocalFolderMountPath,
  localFolderAttachmentKey,
  LOCAL_FOLDER_ATTACHMENT_KEY,
  LOCAL_FOLDER_MOUNT_ROOT,
  WorkspaceConflictError,
} from "./contracts";
import { MemoryWorkspace } from "./memory";
import {
  LocalFolderAccessError,
  LOCAL_FOLDER_MAX_ENTRIES,
  LocalFolderWorkspacePort,
  MountedLocalFolderWorkspace,
  forgetLocalFolder,
  localFolderAttachmentRecorded,
  localFolderMountPath,
  localFolderPermission,
  localFolderPermissionRefusal,
  localFolderPickerAvailable,
  openLocalFolder,
  recallLocalFolder,
  reconnectLocalFolder,
  rememberLocalFolder,
  restoreLocalFolder,
  trimPartialUtf8,
  type LocalDirectoryHandleLike,
  type LocalFileHandleLike,
  type LocalFileLike,
  type LocalFolderPermissionState,
} from "./local-folder";

const encoder = new TextEncoder();

function notFound(): Error {
  return Object.assign(new Error("A requested file or directory could not be found."), { name: "NotFoundError" });
}

class FakeFileHandle {
  readonly kind = "file" as const;
  bytes: Uint8Array;
  lastModified: number;

  constructor(readonly name: string, contents: string | Uint8Array, lastModified = 1_000) {
    this.bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
    this.lastModified = lastModified;
  }

  async getFile(): Promise<LocalFileLike> {
    const bytes = this.bytes;
    const lastModified = this.lastModified;
    return Object.freeze({
      lastModified,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer,
      slice: (start: number, end: number) => Object.freeze({
        arrayBuffer: async () => bytes.slice(start, end).buffer,
      }),
    });
  }

  async createWritable() {
    const handle = this;
    const chunks: Uint8Array[] = [];
    return Object.freeze({
      async write(data: Uint8Array) { chunks.push(data); },
      async close() {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
        handle.bytes = merged;
        handle.lastModified += 1;
      },
    });
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  permissionState: LocalFolderPermissionState = "granted";
  requested = 0;

  constructor(readonly name: string) {}

  async queryPermission(): Promise<LocalFolderPermissionState> { return this.permissionState; }

  async requestPermission(): Promise<LocalFolderPermissionState> {
    this.requested += 1;
    if (this.permissionState === "prompt") this.permissionState = "granted";
    return this.permissionState;
  }

  async *entries(): AsyncIterableIterator<readonly [string, LocalFileHandleLike | LocalDirectoryHandleLike]> {
    for (const [name, handle] of [...this.children.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      yield [name, handle as unknown as LocalFileHandleLike | LocalDirectoryHandleLike];
    }
  }

  async getDirectoryHandle(name: string, options?: Readonly<{ create?: boolean }>) {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing as unknown as LocalDirectoryHandleLike;
    if (existing) throw Object.assign(new Error("not a directory"), { name: "TypeMismatchError" });
    if (!options?.create) throw notFound();
    const created = new FakeDirectoryHandle(name);
    this.children.set(name, created);
    return created as unknown as LocalDirectoryHandleLike;
  }

  async getFileHandle(name: string, options?: Readonly<{ create?: boolean }>) {
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) return existing as unknown as LocalFileHandleLike;
    if (existing) throw Object.assign(new Error("not a file"), { name: "TypeMismatchError" });
    if (!options?.create) throw notFound();
    const created = new FakeFileHandle(name, "");
    this.children.set(name, created);
    return created as unknown as LocalFileHandleLike;
  }

  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw notFound();
  }
}

function fakeTree(): FakeDirectoryHandle {
  const root = new FakeDirectoryHandle("airship");
  root.children.set("README.md", new FakeFileHandle("README.md", "# airship\n"));
  const src = new FakeDirectoryHandle("src");
  src.children.set("main.ts", new FakeFileHandle("main.ts", "export const answer = 41;\n"));
  root.children.set("src", src);
  const git = new FakeDirectoryHandle(".git");
  git.children.set("HEAD", new FakeFileHandle("HEAD", "ref: refs/heads/main\n"));
  root.children.set(".git", git);
  return root;
}

function port(root: FakeDirectoryHandle = fakeTree()): LocalFolderWorkspacePort {
  return new LocalFolderWorkspacePort(root as unknown as LocalDirectoryHandleLike, localFolderMountPath(root.name));
}

/* An IndexedDB just large enough to be the store this module actually uses. */
function fakeIndexedDb(): IDBFactory {
  const data = new Map<string, unknown>();
  const request = <T>(result: T) => {
    const value = { result, error: null, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    queueMicrotask(() => value.onsuccess?.());
    return value as unknown as IDBRequest<T>;
  };
  const store = {
    put: (value: unknown, key: string) => { data.set(key, value); return request(undefined); },
    get: (key: string) => request(data.get(key)),
    delete: (key: string) => { data.delete(key); return request(undefined); },
  };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
    close: () => undefined,
  };
  return {
    open: () => {
      const open = { result: database, error: null, onsuccess: null as null | (() => void), onupgradeneeded: null, onerror: null };
      queueMicrotask(() => open.onsuccess?.());
      return open as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe("LocalFolderWorkspacePort", () => {
  it("presents the picked folder under its own name inside the reserved mount", async () => {
    const local = port();
    expect(local.mountPath).toBe("/workspace/local/airship");
    expect(isLocalFolderMountPath(local.mountPath)).toBe(true);
    expect(localFolderMountPath("../escape")).toBe(`${LOCAL_FOLDER_MOUNT_ROOT}/folder`);
    expect(localFolderMountPath("Some Folder")).toBe(`${LOCAL_FOLDER_MOUNT_ROOT}/folder`);

    expect((await local.list()).map(({ path }) => path)).toEqual([
      "/workspace/local/airship/README.md",
      "/workspace/local/airship/src/main.ts",
    ]);
    expect((await local.read("/workspace/local/airship/src/main.ts"))?.content).toBe("export const answer = 41;\n");
    expect(await local.read("/workspace/local/airship/missing.txt")).toBeUndefined();
  });

  it("reports the file's own bytes and the filesystem's own revision", async () => {
    const local = port();
    const file = await local.read("/workspace/local/airship/README.md");
    expect(file?.size).toBe(10);
    expect(file?.contentByteLength).toBe(10);
    expect(file?.revision).toBe("1000:10");
    expect(file?.updatedAt).toBe(new Date(1_000).toISOString());
    const entry = (await local.list()).find(({ path }) => path.endsWith("README.md"));
    expect(entry?.revision).toBe(file?.revision);
  });

  it("writes into the real directory tree and creates the folders a path names", async () => {
    const root = fakeTree();
    const local = port(root);
    const written = await local.write("/workspace/local/airship/docs/notes.md", "hello");
    expect(written.path).toBe("/workspace/local/airship/docs/notes.md");
    const docs = root.children.get("docs") as FakeDirectoryHandle;
    expect(new TextDecoder().decode((docs.children.get("notes.md") as FakeFileHandle).bytes)).toBe("hello");
    expect((await local.read("/workspace/local/airship/docs/notes.md"))?.content).toBe("hello");
  });

  it("refuses a write whose expected revision no longer matches the file on disk", async () => {
    const root = fakeTree();
    const local = port(root);
    const before = await local.read("/workspace/local/airship/README.md");
    (root.children.get("README.md") as FakeFileHandle).lastModified = 9_999;
    await expect(local.write("/workspace/local/airship/README.md", "x", { expectedRevision: before!.revision }))
      .rejects.toBeInstanceOf(WorkspaceConflictError);
    await expect(local.write("/workspace/local/airship/README.md", "x", { expectedRevision: null }))
      .rejects.toBeInstanceOf(WorkspaceConflictError);
    await expect(local.write("/workspace/local/airship/new.md", "x", { expectedRevision: null })).resolves.toBeDefined();
  });

  it("removes only the file it was given, and only at the revision it was given", async () => {
    const root = fakeTree();
    const local = port(root);
    const file = await local.read("/workspace/local/airship/README.md");
    await expect(local.remove("/workspace/local/airship/README.md", { expectedRevision: "0:0" }))
      .rejects.toBeInstanceOf(WorkspaceConflictError);
    await local.remove("/workspace/local/airship/README.md", { expectedRevision: file!.revision });
    expect(root.children.has("README.md")).toBe(false);
    expect(root.children.has("src")).toBe(true);
    await expect(local.remove("/workspace/local/airship/README.md")).resolves.toBeUndefined();
  });

  it("keeps a bounded read bounded, and keeps its reported size the whole file", async () => {
    const root = new FakeDirectoryHandle("data");
    root.children.set("long.txt", new FakeFileHandle("long.txt", "héllo world"));
    const local = port(root);
    const bounded = await local.readBounded("/workspace/local/data/long.txt", 3);
    expect(bounded?.content).toBe("hé");
    expect(bounded?.size).toBe(12);
    expect(trimPartialUtf8(encoder.encode("hé").slice(0, 2))).toEqual(encoder.encode("h"));
  });

  it("never lists Airship's Git objects or a person's own .git directory", async () => {
    const local = port();
    expect((await local.list()).some(({ path }) => path.includes("/.git/"))).toBe(false);
  });

  it("refuses a folder too large to list instead of showing part of it", async () => {
    const root = new FakeDirectoryHandle("huge");
    for (let index = 0; index <= LOCAL_FOLDER_MAX_ENTRIES; index += 1) {
      root.children.set(`f${index}.txt`, new FakeFileHandle(`f${index}.txt`, "x"));
    }
    await expect(port(root).list()).rejects.toThrow(/holds more than 5000 files/u);
    await expect(port(root).list()).rejects.toBeInstanceOf(LocalFolderAccessError);
  });

  it("says which file left the device rather than answering as if it were empty", async () => {
    const root = fakeTree();
    const local = port(root);
    const handle = root.children.get("README.md") as FakeFileHandle;
    handle.getFile = async () => { throw notFound(); };
    await expect(local.read("/workspace/local/airship/README.md")).rejects.toThrow(/no longer in “airship” on this device/u);
  });

  it("turns a revoked grant into the sentence and the control that fixes it", async () => {
    const root = fakeTree();
    const local = port(root);
    (root.children.get("src") as FakeDirectoryHandle).getFileHandle = async () => {
      throw Object.assign(new Error("The request is not allowed"), { name: "NotAllowedError" });
    };
    await expect(local.read("/workspace/local/airship/src/main.ts"))
      .rejects.toThrow(/needs your permission again to read and write “airship”\. Choose Reconnect folder/u);
    root.permissionState = "denied";
    expect(await localFolderPermission(root as unknown as LocalDirectoryHandleLike)).toBe("denied");
    expect(localFolderPermissionRefusal("airship", "denied").message)
      .toMatch(/Choose Reconnect folder to ask again, or Forget folder/u);
  });

  it("refuses any path outside the folder it was attached to", async () => {
    const local = port();
    await expect(local.read("/workspace/README.md")).rejects.toThrow(/not inside the folder attached at/u);
    await expect(local.write("/workspace/local/other/x.txt", "x")).rejects.toThrow(/not inside the folder attached at/u);
  });
});

describe("MountedLocalFolderWorkspace", () => {
  it("routes by path, lists both tiers once, and copies nothing between them", async () => {
    const backing = new MemoryWorkspace();
    await backing.write("README.md", "vault");
    const composed = new MountedLocalFolderWorkspace(backing, port());

    /* One list, in the same locale order `ProfileWorkspacePort` already sorts by. */
    expect((await composed.list()).map(({ path }) => path)).toEqual([
      "/workspace/local/airship/README.md",
      "/workspace/local/airship/src/main.ts",
      "/workspace/README.md",
    ]);
    expect((await composed.read("/workspace/README.md"))?.content).toBe("vault");
    expect((await composed.read("/workspace/local/airship/README.md"))?.content).toBe("# airship\n");

    await composed.write("/workspace/local/airship/src/main.ts", "export const answer = 42;\n");
    expect(await backing.read("/workspace/local/airship/src/main.ts")).toBeUndefined();
    expect((await backing.list()).map(({ path }) => path)).toEqual(["/workspace/README.md"]);
  });

  it("carries the backing authority's encryption marker and nothing the folder cannot support", async () => {
    class Encrypted extends MemoryWorkspace { readonly encryptionBoundary = "airship-client-envelope-v1" as const; }
    expect(new MountedLocalFolderWorkspace(new Encrypted(), port()).encryptionBoundary)
      .toBe("airship-client-envelope-v1");
    expect(new MountedLocalFolderWorkspace(new MemoryWorkspace(), port()).encryptionBoundary).toBeUndefined();
  });

  it("scopes a listing of the mount to the folder alone", async () => {
    const backing = new MemoryWorkspace();
    await backing.write("README.md", "vault");
    const composed = new MountedLocalFolderWorkspace(backing, port());
    expect((await composed.list("/workspace/local/airship/src")).map(({ path }) => path))
      .toEqual(["/workspace/local/airship/src/main.ts"]);
  });
});

describe("the remembered folder", () => {
  let factory: IDBFactory;

  beforeEach(() => {
    factory = fakeIndexedDb();
  });

  it("survives a reload while the grant does, and states the refusal when it does not", async () => {
    const root = fakeTree();
    await rememberLocalFolder({
      handle: root as unknown as LocalDirectoryHandleLike,
      name: root.name,
      mountPath: localFolderMountPath(root.name),
      attachedAt: new Date(0).toISOString(),
      profileId: "general",
    }, factory);

    expect((await recallLocalFolder("general", factory))?.name).toBe("airship");
    const restored = await restoreLocalFolder("general", factory);
    expect(restored.state).toBe("attached");
    if (restored.state !== "attached") throw new Error("unreachable");
    expect((await restored.port.list()).length).toBe(2);

    root.permissionState = "prompt";
    const blocked = await restoreLocalFolder("general", factory);
    expect(blocked.state).toBe("blocked");
    if (blocked.state !== "blocked") throw new Error("unreachable");
    expect(blocked.reason.code).toBe("permission-required");
    expect(root.requested).toBe(0);

    const reconnected = await reconnectLocalFolder(blocked.record);
    expect(root.requested).toBe(1);
    expect(reconnected.mountPath).toBe("/workspace/local/airship");

    await forgetLocalFolder("general", factory);
    expect(await recallLocalFolder("general", factory)).toBeUndefined();
    expect((await restoreLocalFolder("general", factory)).state).toBe("absent");
  });

  it("refuses to reconnect a folder whose grant is denied", async () => {
    const root = fakeTree();
    root.permissionState = "denied";
    await expect(reconnectLocalFolder({
      handle: root as unknown as LocalDirectoryHandleLike,
      name: root.name,
      mountPath: localFolderMountPath(root.name),
      attachedAt: new Date(0).toISOString(),
      profileId: "general",
    })).rejects.toMatchObject({ code: "permission-denied" });
  });
});

describe("opening a folder", () => {
  it("tells a browser without the API the truth, once", async () => {
    expect(localFolderPickerAvailable({})).toBe(false);
    expect(localFolderPickerAvailable({ showDirectoryPicker: () => undefined })).toBe(true);
    await expect(openLocalFolder({ profileId: "general", scope: {} })).rejects.toMatchObject({ code: "unsupported" });
    await expect(openLocalFolder({ profileId: "general", scope: {} })).rejects.toThrow(/only Chromium browsers/u);
  });

  it("treats a cancelled picker as a decision, not a failure", async () => {
    await expect(openLocalFolder({
      profileId: "general",
      scope: { showDirectoryPicker: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } },
    })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("asks for the write grant at the moment of the pick, and remembers the handle", async () => {
    const root = fakeTree();
    root.permissionState = "prompt";
    const factory = fakeIndexedDb();
    const opened = await openLocalFolder({
      profileId: "general",
      scope: { showDirectoryPicker: async () => root as unknown as LocalDirectoryHandleLike },
      indexedDB: factory,
    });
    expect(root.requested).toBe(1);
    expect(opened.mountPath).toBe("/workspace/local/airship");
    expect((await recallLocalFolder("general", factory))?.mountPath).toBe("/workspace/local/airship");
  });

  it("refuses to attach a folder whose grant was refused", async () => {
    const root = fakeTree();
    root.permissionState = "denied";
    await expect(openLocalFolder({
      profileId: "general",
      scope: { showDirectoryPicker: async () => root as unknown as LocalDirectoryHandleLike },
      indexedDB: fakeIndexedDb(),
    })).rejects.toMatchObject({ code: "permission-denied" });
  });
});

/*
 * F5. Every other storage tier a Profile has is siloed to it — its workspace
 * subtree, its Git object database, its memory scope, its terminal metadata.
 * The attached folder was not: one IndexedDB key and one `localStorage` marker
 * meant a folder opened while reading under one Profile was composed into
 * `/workspace/local` for every other Profile in the browser.
 */
describe("a folder belongs to the Profile that opened it", () => {
  /** The marker store the shell reads synchronously on every boot. */
  function stubLocalStorage(): void {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, value); },
        removeItem: (key: string) => { entries.delete(key); },
      },
    });
  }

  it("is not recalled, restored or forgotten by another Profile", async () => {
    stubLocalStorage();
    const factory = fakeIndexedDb();
    const root = fakeTree();
    await rememberLocalFolder({
      handle: root as unknown as LocalDirectoryHandleLike,
      name: root.name,
      mountPath: localFolderMountPath(root.name),
      attachedAt: new Date(0).toISOString(),
      profileId: "general",
    }, factory);

    expect((await recallLocalFolder("general", factory))?.name).toBe("airship");
    expect((await restoreLocalFolder("general", factory)).state).toBe("attached");

    // The second Profile in the same browser sees no folder at all.
    expect(await recallLocalFolder("research", factory)).toBeUndefined();
    expect((await restoreLocalFolder("research", factory)).state).toBe("absent");

    // And the marker the shell reads synchronously is per Profile too, so a
    // Profile that never attached one never fetches this pack.
    expect(localFolderAttachmentRecorded("general")).toBe(true);
    expect(localFolderAttachmentRecorded("research")).toBe(false);
    expect(globalThis.localStorage.getItem(localFolderAttachmentKey("general"))).toBe("attached");
    // The one shared marker the shell used to read for every Profile.
    expect(globalThis.localStorage.getItem(LOCAL_FOLDER_ATTACHMENT_KEY)).toBeNull();

    // Forgetting is scoped as well: one Profile cannot drop another's folder.
    await forgetLocalFolder("research", factory);
    expect((await recallLocalFolder("general", factory))?.name).toBe("airship");
    expect(localFolderAttachmentRecorded("general")).toBe(true);
  });

  it("refuses a stored record that names a different Profile", async () => {
    const factory = fakeIndexedDb();
    const root = fakeTree();
    await rememberLocalFolder({
      handle: root as unknown as LocalDirectoryHandleLike,
      name: root.name,
      mountPath: localFolderMountPath(root.name),
      attachedAt: new Date(0).toISOString(),
      profileId: "research",
    }, factory);
    // Written under `research`'s own key, so `general` cannot reach it — and
    // the record names its Profile as well, so a reader that did would refuse.
    expect(await recallLocalFolder("general", factory)).toBeUndefined();
  });
});

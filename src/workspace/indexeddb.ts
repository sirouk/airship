import { randomUuid } from "../core/id";
import { checkRevision } from "./memory";
import {
  normalizeWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspacePort,
} from "./contracts";

const FILES = "files";

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Workspace transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Workspace transaction failed")), {
      once: true,
    });
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Workspace request failed")), {
      once: true,
    });
  });
}

export class IndexedDbWorkspace implements WorkspacePort {
  private databasePromise?: Promise<IDBDatabase>;

  constructor(private readonly databaseName = "airship-workspace-v1") {}

  async read(path: string): Promise<WorkspaceFile | undefined> {
    const database = await this.database();
    const transaction = database.transaction(FILES, "readonly");
    const done = transactionDone(transaction);
    const file = (await requestResult(transaction.objectStore(FILES).get(normalizeWorkspacePath(path)))) as
      | WorkspaceFile
      | undefined;
    await done;
    return file;
  }

  async list(path = "/workspace"): Promise<WorkspaceEntry[]> {
    const prefix = normalizeWorkspacePath(path);
    const database = await this.database();
    const transaction = database.transaction(FILES, "readonly");
    const done = transactionDone(transaction);
    const files = (await requestResult(transaction.objectStore(FILES).getAll())) as WorkspaceFile[];
    await done;
    return files
      .filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`))
      .map(({ content: _content, ...entry }) => entry)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async write(
    path: string,
    content: string,
    options: { expectedRevision?: string | null } = {},
  ): Promise<WorkspaceFile> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/workspace") throw new Error("Cannot write to the workspace root.");
    const database = await this.database();
    const transaction = database.transaction(FILES, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(FILES);
    const current = (await requestResult(store.get(normalized))) as WorkspaceFile | undefined;
    checkRevision(current, options.expectedRevision);
    const file: WorkspaceFile = {
      path: normalized,
      content,
      revision: randomUuid(),
      updatedAt: new Date().toISOString(),
      size: new TextEncoder().encode(content).byteLength,
    };
    store.put(file);
    await done;
    return file;
  }

  async remove(path: string, options: { expectedRevision?: string } = {}): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const database = await this.database();
    const transaction = database.transaction(FILES, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(FILES);
    const current = (await requestResult(store.get(normalized))) as WorkspaceFile | undefined;
    if (current) {
      checkRevision(current, options.expectedRevision);
      store.delete(normalized);
    }
    await done;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.addEventListener(
        "upgradeneeded",
        () => {
          if (!request.result.objectStoreNames.contains(FILES)) {
            request.result.createObjectStore(FILES, { keyPath: "path" });
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Unable to open workspace")), {
        once: true,
      });
    });
    return this.databasePromise;
  }
}

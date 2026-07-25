import { fromBase64Url, toBase64Url } from "../core/hash";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";

const RECOVERY_PREFIX = "airship-wrk-v1.";

/**
 * Provider-neutral, one-time recovery display plus a non-extractable runtime
 * key. Google Drive and S3 are transports for the same encrypted workspace;
 * neither provider owns or derives this material.
 */
export class WorkspaceRecoveryMaterial {
  #workspaceKey?: WorkspaceRootKey;
  #recoveryBytes?: Uint8Array;
  #displayValue?: string;

  private constructor(key: WorkspaceRootKey, recoveryBytes: Uint8Array) {
    this.#workspaceKey = key;
    this.#recoveryBytes = recoveryBytes;
    this.#displayValue = `${RECOVERY_PREFIX}${toBase64Url(recoveryBytes)}`;
  }

  static async generate(): Promise<WorkspaceRecoveryMaterial> {
    const { key, recoveryBytes } = await WorkspaceRootKey.generate();
    return new WorkspaceRecoveryMaterial(key, recoveryBytes);
  }

  get workspaceKey(): WorkspaceRootKey {
    if (!this.#workspaceKey) throw new DOMException("Recovery material was cleared.", "InvalidStateError");
    return this.#workspaceKey;
  }

  get displayValue(): string {
    if (!this.#displayValue) throw new DOMException("Recovery material was cleared.", "InvalidStateError");
    return this.#displayValue;
  }

  get cleared(): boolean {
    return !this.#workspaceKey;
  }

  clear(): void {
    this.#recoveryBytes?.fill(0);
    this.#recoveryBytes = undefined;
    this.#displayValue = undefined;
    this.#workspaceKey = undefined;
  }

  toJSON(): { kind: "workspace-recovery"; available: boolean; persistence: "memory-only" } {
    return { kind: "workspace-recovery", available: !this.cleared, persistence: "memory-only" };
  }
}

export async function importWorkspaceRecoveryKey(value: string): Promise<WorkspaceRootKey> {
  const normalized = value.trim();
  if (!normalized.startsWith(RECOVERY_PREFIX)) throw new Error("Airship recovery key version is invalid.");
  const encoded = normalized.slice(RECOVERY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error("Airship recovery key encoding is invalid.");
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(encoded);
  } catch {
    throw new Error("Airship recovery key encoding is invalid.");
  }
  if (bytes.byteLength !== 32 || toBase64Url(bytes) !== encoded) {
    bytes.fill(0);
    throw new Error("Airship recovery key encoding is invalid.");
  }
  try {
    return await WorkspaceRootKey.import(bytes);
  } finally {
    bytes.fill(0);
  }
}

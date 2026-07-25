import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import type { S3TemporaryCredentials } from "../storage/s3-object-store";
import {
  validateVaultS3Configuration,
  type VaultS3ConfigurationInput,
} from "./config";
import type {
  ConfigureVaultRequest,
  ResettableVaultCredentialProvider,
} from "./coordinator";

const MAX_ACCESS_KEY_BYTES = 256;
const MAX_SECRET_KEY_BYTES = 4_096;

export type LocalLabConfigurationInput = {
  endpoint: string;
  region: string;
  bucket: string;
  namespace: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type CreateLocalLabRequest = LocalLabConfigurationInput & {
  workspaceKey: WorkspaceRootKey;
  recoveryKeySavedAcknowledged: true;
  ownLoopbackServiceAcknowledged: true;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

/**
 * Permanent-shaped credentials are permitted only because VaultCoordinator
 * independently confines this provider to loopback local-development mode.
 * Native private fields keep secrets out of ordinary enumeration/serialization.
 */
export class MemoryOnlyLocalLabCredentialProvider implements ResettableVaultCredentialProvider {
  #accessKeyId?: string;
  #secretAccessKey?: string;

  constructor(accessKeyId: string, secretAccessKey: string) {
    this.#accessKeyId = localCredential(accessKeyId, "Local S3 access key", MAX_ACCESS_KEY_BYTES, 3);
    this.#secretAccessKey = localCredential(secretAccessKey, "Local S3 secret key", MAX_SECRET_KEY_BYTES, 8);
  }

  get active(): boolean {
    return this.#accessKeyId !== undefined && this.#secretAccessKey !== undefined;
  }

  async getCredentials(signal?: AbortSignal): Promise<S3TemporaryCredentials> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Local credential request was aborted.", "AbortError");
    if (!this.#accessKeyId || !this.#secretAccessKey) {
      throw new DOMException("Local lab credentials were cleared.", "InvalidStateError");
    }
    return {
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
    };
  }

  reset(): void {
    this.#accessKeyId = undefined;
    this.#secretAccessKey = undefined;
  }

  toJSON(): { kind: "local-development"; active: boolean; persistence: "memory-only" } {
    return { kind: "local-development", active: this.active, persistence: "memory-only" };
  }
}

// Backward-compatible names for the original local-lab callers. Recovery is a
// workspace authority shared by every provider, not an S3-specific concept.
export {
  WorkspaceRecoveryMaterial as LocalLabRecoveryMaterial,
  importWorkspaceRecoveryKey as importLocalLabRecoveryKey,
} from "./recovery";

/**
 * Produces a coordinator request but performs no network call and runs no
 * conformance probe. Both human acknowledgements are runtime-enforced.
 */
export function createLocalLabConfigureRequest(input: CreateLocalLabRequest): ConfigureVaultRequest {
  if (input.ownLoopbackServiceAcknowledged !== true) {
    throw new Error("Confirm that these credentials belong only to your own loopback S3-compatible service.");
  }
  if (input.recoveryKeySavedAcknowledged !== true) {
    throw new Error("Confirm that the generated recovery key was saved before handing off the vault.");
  }
  const proposed: VaultS3ConfigurationInput = {
    mode: "local-development",
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    namespace: input.namespace,
    forcePathStyle: true,
    credentialSource: {
      kind: "local-development",
      displayName: "User-owned loopback S3 lab",
      authorityOrigins: [],
    },
  };
  const validated = validateVaultS3Configuration(proposed);
  const configuration: VaultS3ConfigurationInput = {
    mode: validated.mode,
    endpoint: validated.endpoint,
    region: validated.region,
    bucket: validated.bucket,
    namespace: validated.namespace,
    probePrefix: validated.probePrefix,
    forcePathStyle: true,
    credentialSource: {
      kind: "local-development",
      displayName: validated.credentialSource.displayName,
      authorityOrigins: [],
    },
  };
  Object.freeze(configuration.credentialSource.authorityOrigins);
  Object.freeze(configuration.credentialSource);
  Object.freeze(configuration);

  const credentialProvider = new MemoryOnlyLocalLabCredentialProvider(input.accessKeyId, input.secretAccessKey);
  const request: ConfigureVaultRequest = {
    configuration,
    credentialProvider,
    workspaceKey: input.workspaceKey,
    fetchImplementation: input.fetchImplementation,
    now: input.now,
  };
  return Object.freeze(request);
}

function localCredential(value: string, label: string, maximumBytes: number, minimumBytes: number): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (
    value !== value.trim() ||
    bytes < minimumBytes ||
    bytes > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

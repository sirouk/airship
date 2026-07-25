import type {
  InferenceRequest,
  InferenceTransport,
  SecurityPosture,
} from "../core/contracts";

/**
 * A credential-free placeholder for a semantically pinned remote runtime.
 *
 * Losing remote authority must not rewrite the active conversation or change
 * its provider/model manifest.  At the same time, retaining the old transport
 * would retain a direct API key inside that transport.  This replacement keeps
 * only the non-secret runtime identity and fails every attempted invocation.
 */
export class CredentialUnavailableTransport implements InferenceTransport {
  readonly id: string;
  readonly posture: SecurityPosture;

  constructor(identity: Readonly<{ id: string; posture: SecurityPosture }>) {
    this.id = identity.id;
    this.posture = identity.posture;
  }

  async *stream(_request: InferenceRequest, signal: AbortSignal) {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Inference cancelled.", "AbortError");
    }
    throw new Error("Remote inference is unavailable until its memory-only credential is reconnected.");
  }
}

/** Extract only public semantic identity; never close over the old transport. */
export function withoutCredential(transport: InferenceTransport): InferenceTransport {
  return new CredentialUnavailableTransport({ id: transport.id, posture: transport.posture });
}

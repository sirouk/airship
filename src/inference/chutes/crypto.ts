import initWasm, {
  build_e2ee_request,
  type E2eeRequestContext,
  type E2eeStreamContext,
} from "./wasm/chutes_e2ee_wasm.js";

export interface E2eeStreamCryptoContext {
  decrypt_chunk(encryptedChunkBase64: string): string;
  finish(): void;
  free(): void;
  readonly finished: boolean;
  readonly chunks_decrypted: number;
}

export interface E2eeRequestCryptoContext {
  take_blob(): Uint8Array;
  decrypt_response(responseBlob: Uint8Array): string;
  open_stream(streamInitBase64: string): E2eeStreamCryptoContext;
  free(): void;
  readonly consumed: boolean;
  readonly blob_taken: boolean;
}

export interface ChutesE2eeCrypto {
  buildRequest(e2ePublicKeyBase64: string, payloadJson: string): Promise<E2eeRequestCryptoContext>;
}

export class WasmChutesE2eeCrypto implements ChutesE2eeCrypto {
  private ready?: Promise<void>;

  constructor(private readonly moduleOrPath?: Parameters<typeof initWasm>[0]) {}

  async buildRequest(
    e2ePublicKeyBase64: string,
    payloadJson: string,
  ): Promise<E2eeRequestCryptoContext> {
    await this.initialize();
    return new WasmRequestContext(build_e2ee_request(e2ePublicKeyBase64, payloadJson));
  }

  private initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = initWasm(this.moduleOrPath)
        .then(() => undefined)
        .catch((error) => {
          this.ready = undefined;
          throw error;
        });
    }
    return this.ready;
  }
}

class WasmRequestContext implements E2eeRequestCryptoContext {
  constructor(private readonly inner: E2eeRequestContext) {}

  get consumed() {
    return this.inner.consumed;
  }

  get blob_taken() {
    return this.inner.blob_taken;
  }

  take_blob() {
    return this.inner.take_blob();
  }

  decrypt_response(responseBlob: Uint8Array) {
    return this.inner.decrypt_response(responseBlob);
  }

  open_stream(streamInitBase64: string): E2eeStreamCryptoContext {
    return new WasmStreamContext(this.inner.open_stream(streamInitBase64));
  }

  free() {
    this.inner.free();
  }
}

class WasmStreamContext implements E2eeStreamCryptoContext {
  constructor(private readonly inner: E2eeStreamContext) {}

  get finished() {
    return this.inner.finished;
  }

  get chunks_decrypted() {
    return this.inner.chunks_decrypted;
  }

  decrypt_chunk(encryptedChunkBase64: string) {
    return this.inner.decrypt_chunk(encryptedChunkBase64);
  }

  finish() {
    this.inner.finish();
  }

  free() {
    this.inner.free();
  }
}

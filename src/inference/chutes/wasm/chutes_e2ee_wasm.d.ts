/* tslint:disable */
/* eslint-disable */

/**
 * Opaque one-request capability. It owns the response decapsulation seed and
 * never exports it to JavaScript. A response attempt or stream-open attempt
 * consumes that seed even when authentication fails.
 */
export class E2eeRequestContext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypts one non-stream v1 response and consumes the response secret.
     */
    decrypt_response(response_blob: Uint8Array): string;
    /**
     * Consumes the response secret, authenticates the v1 stream init, and
     * returns an opaque stream context. A failed open is not retryable.
     */
    open_stream(mlkem_ct_b64: string): E2eeStreamContext;
    /**
     * Moves the encrypted request body into JavaScript exactly once.
     */
    take_blob(): Uint8Array;
    /**
     * True after `take_blob` has moved out the request frame.
     */
    readonly blob_taken: boolean;
    /**
     * True after `decrypt_response` or `open_stream` has consumed the secret.
     */
    readonly consumed: boolean;
}

/**
 * Opaque v1 stream decryptor. It rejects duplicate authenticated nonces and
 * bounds record count/size. V1 has no sequence number or authenticated FIN,
 * so ordering and completeness cannot be proven by this context.
 */
export class E2eeStreamContext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Authenticates and decrypts one base64 v1 `nonce || ciphertext || tag`
     * record. Duplicate successfully authenticated nonces are rejected.
     */
    decrypt_chunk(enc_chunk_b64: string): string;
    /**
     * Immediately destroys the stream key. This is local disposal only; v1
     * does not provide an authenticated final record to verify here.
     */
    finish(): void;
    readonly chunks_decrypted: number;
    readonly finished: boolean;
}

/**
 * Builds a Chutes E2EE v1 request. The returned context exposes only the
 * encrypted body; response key material remains inside the opaque context.
 */
export function build_e2ee_request(e2e_pubkey_b64: string, payload_json: string): E2eeRequestContext;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_e2eerequestcontext_free: (a: number, b: number) => void;
    readonly __wbg_e2eestreamcontext_free: (a: number, b: number) => void;
    readonly build_e2ee_request: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly e2eerequestcontext_blob_taken: (a: number) => number;
    readonly e2eerequestcontext_consumed: (a: number) => number;
    readonly e2eerequestcontext_decrypt_response: (a: number, b: number, c: number) => [number, number, number, number];
    readonly e2eerequestcontext_open_stream: (a: number, b: number, c: number) => [number, number, number];
    readonly e2eerequestcontext_take_blob: (a: number) => [number, number, number, number];
    readonly e2eestreamcontext_chunks_decrypted: (a: number) => number;
    readonly e2eestreamcontext_decrypt_chunk: (a: number, b: number, c: number) => [number, number, number, number];
    readonly e2eestreamcontext_finish: (a: number) => void;
    readonly e2eestreamcontext_finished: (a: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

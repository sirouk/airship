/* tslint:disable */
/* eslint-disable */

/**
 * Fetch a complete Intel collateral bundle in the browser. The PCCS is only
 * transport: dcap-qvl validates Intel signatures, chains, CRLs, identities,
 * TCB status, and validity windows before returning a verified report.
 */
export function get_collateral(pccs_url: any, raw_quote: any): Promise<any>;

export function js_get_collateral(pccs_url: any, raw_quote: any): Promise<any>;

export function js_verify(raw_quote: any, quote_collateral: any, now: bigint): any;

export function js_verify_with_root_ca(raw_quote: any, quote_collateral: any, root_ca_der: any, now: bigint): any;

/**
 * Parse and normalize Intel TDX quote v4/v5 using the exact same Rust parser
 * used by the verifier. This prevents the browser from inventing offsets for
 * quote-v5 TDX 1.0/1.5 bodies.
 */
export function parse_quote(raw_quote: any): any;

/**
 * Run Phala's pure-Rust Intel DCAP QVL locally inside the browser.
 */
export function verify_quote(raw_quote: any, quote_collateral: any, now_seconds: bigint): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_collateral: (a: number, b: number) => number;
    readonly parse_quote: (a: number, b: number) => void;
    readonly js_get_collateral: (a: number, b: number) => number;
    readonly js_verify: (a: number, b: number, c: number, d: bigint) => void;
    readonly js_verify_with_root_ca: (a: number, b: number, c: number, d: number, e: bigint) => void;
    readonly verify_quote: (a: number, b: number, c: number, d: bigint) => void;
    readonly __wasm_bindgen_func_elem_1610: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1672: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_2889: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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

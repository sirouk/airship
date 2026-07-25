export const BROWSER_WASI_SHIM_VERSION = "0.4.2";
export const WASI_PREVIEW1_MAX_ARTIFACT_BYTES = 4 * 1_024 * 1_024;
export const WASI_PREVIEW1_MAX_OUTPUT_BYTES = 256 * 1_024;
export const WASI_PREVIEW1_MAX_FILES = 256;
export const WASI_PREVIEW1_MAX_FILE_BYTES = 512 * 1_024;
export const WASI_PREVIEW1_MAX_WORKSPACE_BYTES = 4 * 1_024 * 1_024;
export const WASI_PREVIEW1_EXCLUDED_SEGMENTS = Object.freeze([".airship", ".git", "node_modules"] as const);


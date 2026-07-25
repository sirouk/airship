export const WASMER_SDK_VERSION = "0.10.0";
export const WASIX_BASH_SPEC = "sharrattj/bash@1.0.18";
export const WASIX_BASH_WEBC_SHA256 = "2d71072b8f2eff804bba8f3edeadca8d52855f31e474b8c4d40b8b898f5fcb39";
export const WASIX_BASH_ATOM_SIGNATURE = "sha256:oCCm+II0opBqUqJwOgWmXyvQR6ARHZ1VaMRaTsVTIzQ=";
export const WASIX_COREUTILS_SPEC = "wasmer/coreutils@1.0.25";
export const WASIX_COREUTILS_WEBC_SHA256 = "36ea48f185ca15fe8454b1defb6a11754659dbed6330549662b62874d509f95f";
export const WASIX_COREUTILS_ATOM_SIGNATURE = "sha256:QSc/lGYs4w8S2u1+I+axCxAERMSPehd47YGXifeHZ3E=";
export const WASIX_REGISTRY_ORIGIN = "https://registry.wasmer.io";
export const WASIX_CDN_ORIGIN = "https://cdn.wasmer.io";
export const WASIX_MAX_FILES = 256;
export const WASIX_MAX_FILE_BYTES = 512 * 1_024;
export const WASIX_MAX_WORKSPACE_BYTES = 4 * 1_024 * 1_024;
export const WASIX_MAX_OUTPUT_BYTES = 256 * 1_024;
export const WASIX_STREAM_DRAIN_GRACE_MS = 250;
export const WASIX_MAX_DIRECTORY_ENTRIES = WASIX_MAX_FILES * 2;
export const WASIX_EXCLUDED_SEGMENTS = Object.freeze([".airship", ".git", "node_modules"] as const);

export const WASIX_PINNED_WEBC = Object.freeze(new Map([
  [`${WASIX_CDN_ORIGIN}/webcimages/${WASIX_BASH_WEBC_SHA256}.webc`, WASIX_BASH_WEBC_SHA256],
  [`${WASIX_CDN_ORIGIN}/webcimages/${WASIX_COREUTILS_WEBC_SHA256}.webc`, WASIX_COREUTILS_WEBC_SHA256],
]));

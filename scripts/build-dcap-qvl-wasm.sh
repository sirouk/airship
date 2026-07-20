#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
crate_dir="$repo_dir/crates/dcap-qvl-wasm"
out_dir="$repo_dir/src/attestation/dcap/qvl-wasm"
target_dir="$crate_dir/target"

cargo build --manifest-path "$crate_dir/Cargo.toml" --target wasm32-unknown-unknown --release
mkdir -p "$out_dir"
wasm-bindgen \
  --target web \
  --out-dir "$out_dir" \
  --out-name airship_dcap_qvl \
  "$target_dir/wasm32-unknown-unknown/release/airship_dcap_qvl_wasm.wasm"

node --input-type=module - "$out_dir/airship_dcap_qvl_bg.wasm" <<'NODE'
import { readFileSync } from "node:fs";

const wasmPath = process.argv[2];
const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(wasmPath)));
const unexpected = imports.filter(({ module }) => module !== "./airship_dcap_qvl_bg.js");
if (unexpected.length > 0) {
  throw new Error(`DCAP QVL WASM contains unsupported imports: ${unexpected
    .map(({ module, name }) => `${module}:${name}`)
    .join(", ")}`);
}
NODE

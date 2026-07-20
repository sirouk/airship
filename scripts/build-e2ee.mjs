import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const crateDir = join(projectRoot, "crates", "chutes-e2ee-wasm");
const outputDir = join(projectRoot, "src", "inference", "chutes", "wasm");

if (!existsSync(join(crateDir, "Cargo.toml"))) {
  throw new Error(`Missing E2EE crate: ${crateDir}`);
}

mkdirSync(outputDir, { recursive: true });
const wasmPack = findWasmPack();
const result = spawnSync(
  wasmPack,
  ["build", crateDir, "--target", "web", "--out-dir", outputDir, "--no-pack", "--no-opt"],
  { cwd: projectRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// wasm-pack writes `*` here for publish-oriented packages. Airship intentionally
// checks in the generated browser ABI and WASM artifact, so remove that ignore.
rmSync(join(outputDir, ".gitignore"), { force: true });

// A successful Rust/wasm-bindgen build can still leave unresolved native
// imports that only fail once a browser or bundler loads the artifact. Keep
// the checked-in E2EE primitive browser-only and fail the build at its source.
const wasmPath = join(outputDir, "chutes_e2ee_wasm_bg.wasm");
const wasmImports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(wasmPath)));
const unexpectedImports = wasmImports.filter(({ module }) => module !== "./chutes_e2ee_wasm_bg.js");
if (unexpectedImports.length > 0) {
  throw new Error(
    `Chutes E2EE WASM contains unsupported imports: ${unexpectedImports
      .map(({ module, name }) => `${module}:${name}`)
      .join(", ")}`,
  );
}

function findWasmPack() {
  const candidates = [
    process.env.WASM_PACK_BIN,
    "wasm-pack",
    resolve(projectRoot, "..", "e2ee-test", "node_modules", ".bin", "wasm-pack"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error(
    "wasm-pack was not found. Install it, set WASM_PACK_BIN, or keep ../e2ee-test/node_modules available.",
  );
}

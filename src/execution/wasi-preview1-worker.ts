/// <reference lib="webworker" />

import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
  type Inode,
} from "@bjorn3/browser_wasi_shim";
import {
  WASI_PREVIEW1_MAX_ARTIFACT_BYTES,
  WASI_PREVIEW1_MAX_FILE_BYTES,
  WASI_PREVIEW1_MAX_FILES,
  WASI_PREVIEW1_MAX_OUTPUT_BYTES,
  WASI_PREVIEW1_MAX_WORKSPACE_BYTES,
} from "./wasi-preview1-contract";

type WorkspaceInput = Readonly<{ path: string; bytes: Uint8Array }>;
type RunMessage = Readonly<{
  type: "run";
  wasmBase64: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  files: readonly WorkspaceInput[];
}>;

const scope = self as DedicatedWorkerGlobalScope;
let started = false;

scope.onmessage = (event: MessageEvent<RunMessage>) => {
  if (started || event.data?.type !== "run") {
    post({ type: "failed", error: "A disposable WASI Worker accepts exactly one command." });
    return;
  }
  started = true;
  void run(event.data).catch((error) => {
    post({ type: "failed", error: error instanceof Error ? error.message : String(error) });
  });
};

async function run(message: RunMessage): Promise<void> {
  const binary = decodeArtifact(message.wasmBase64);
  if (!WebAssembly.validate(binary as BufferSource)) throw new Error("The WASI command artifact is not valid WebAssembly.");

  const root = materializeRoot(message.files);
  const preopen = new PreopenDirectory(".", root.contents);
  const stdout = captureOutput("stdout");
  const stderr = captureOutput("stderr");
  const argv = ["airship-wasi", ...message.args];
  const environment = Object.entries(message.env).map(([key, value]) => `${key}=${value}`);
  const wasi = new WASI(argv, environment, [
    new OpenFile(new File([])),
    new ConsoleStdout(stdout.write),
    new ConsoleStdout(stderr.write),
    preopen,
  ]);

  // The shim and artifact have already loaded. Guest execution receives no
  // ambient browser network, storage, DOM, or nested-worker authority.
  for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches",
    "importScripts", "Worker", "SharedWorker",
  ]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }

  const module = await WebAssembly.compile(binary as BufferSource);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
    wasi_unstable: wasi.wasiImport,
  });
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("WASI command must export linear memory.");
  if (memory.buffer.byteLength > 64 * 1_024 * 1_024) throw new Error("WASI command initial memory exceeds 64 MiB.");
  if (typeof instance.exports._start !== "function") throw new Error("WASI command must export _start.");

  const exitCode = wasi.start(instance as Parameters<WASI["start"]>[0]);
  stdout.flush();
  stderr.flush();
  if (memory.buffer.byteLength > 64 * 1_024 * 1_024) throw new Error("WASI command memory exceeded 64 MiB.");
  post({
    type: "completed",
    exitCode,
    stdout: stdout.value(),
    stderr: stderr.value(),
    files: collectFiles(preopen.dir),
  });
}

function decodeArtifact(value: string): Uint8Array {
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("The WASI command artifact is not valid base64."); }
  if (binary.length > WASI_PREVIEW1_MAX_ARTIFACT_BYTES) throw new Error("The WASI command artifact exceeds 4 MiB.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function materializeRoot(files: readonly WorkspaceInput[]): Directory {
  if (files.length > WASI_PREVIEW1_MAX_FILES) throw new Error("WASI workspace input exceeds 256 files.");
  type Node = { files: Map<string, Uint8Array>; directories: Map<string, Node> };
  const tree: Node = { files: new Map(), directories: new Map() };
  let total = 0;
  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("\\") || !(file.bytes instanceof Uint8Array)) {
      throw new Error("WASI workspace input contains an invalid relative file.");
    }
    const segments = file.path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("WASI workspace input contains an invalid relative path.");
    }
    if (file.bytes.byteLength > WASI_PREVIEW1_MAX_FILE_BYTES) throw new Error(`WASI workspace file exceeds 512 KiB: ${file.path}`);
    total += file.bytes.byteLength;
    if (total > WASI_PREVIEW1_MAX_WORKSPACE_BYTES) throw new Error("WASI workspace input exceeds 4 MiB.");
    let node = tree;
    for (const segment of segments.slice(0, -1)) {
      if (node.files.has(segment)) throw new Error(`WASI workspace path collides with a file: ${file.path}`);
      let child = node.directories.get(segment);
      if (!child) {
        child = { files: new Map(), directories: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    const name = segments.at(-1)!;
    if (node.files.has(name) || node.directories.has(name)) throw new Error(`WASI workspace contains a duplicate path: ${file.path}`);
    node.files.set(name, file.bytes);
  }
  const materialize = (node: Node): Directory => new Directory(new Map<string, Inode>([
    ...[...node.directories].map(([name, child]) => [name, materialize(child)] as const),
    ...[...node.files].map(([name, bytes]) => [name, new File(bytes)] as const),
  ]));
  return materialize(tree);
}

function collectFiles(root: Directory): readonly WorkspaceInput[] {
  const files: WorkspaceInput[] = [];
  let total = 0;
  const visit = (directory: Directory, prefix: string) => {
    for (const [name, entry] of [...directory.contents].sort(([left], [right]) => left.localeCompare(right))) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry instanceof Directory) {
        visit(entry, path);
      } else if (entry instanceof File) {
        if (entry.data.byteLength > WASI_PREVIEW1_MAX_FILE_BYTES) throw new Error(`WASI output file exceeds 512 KiB: ${path}`);
        total += entry.data.byteLength;
        if (files.length >= WASI_PREVIEW1_MAX_FILES || total > WASI_PREVIEW1_MAX_WORKSPACE_BYTES) {
          throw new Error("WASI workspace output exceeds its 256-file or 4-MiB budget.");
        }
        files.push({ path, bytes: entry.data.slice() });
      }
    }
  };
  visit(root, "");
  return files;
}

function captureOutput(stream: "stdout" | "stderr"): Readonly<{
  write(bytes: Uint8Array): void;
  flush(): void;
  value(): string;
}> {
  const decoder = new TextDecoder();
  let output = "";
  let acceptedBytes = 0;
  const append = (bytes: Uint8Array, final = false) => {
    const remaining = WASI_PREVIEW1_MAX_OUTPUT_BYTES - acceptedBytes;
    const accepted = bytes.subarray(0, Math.max(0, remaining));
    acceptedBytes += accepted.byteLength;
    const text = decoder.decode(accepted, { stream: !final });
    output += text;
    if (text) post({ type: "output", stream, text });
  };
  return {
    write(bytes) { append(bytes); },
    flush() { append(new Uint8Array(), true); },
    value() { return output; },
  };
}

function post(message: unknown): void {
  scope.postMessage(message);
}

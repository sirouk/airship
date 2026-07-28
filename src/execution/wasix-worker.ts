/// <reference lib="webworker" />

import {
  WASIX_BASH_ATOM_SIGNATURE,
  WASIX_BASH_SPEC,
  WASIX_BASH_WEBC_SHA256,
  WASIX_CDN_ORIGIN,
  WASIX_COREUTILS_ATOM_SIGNATURE,
  WASIX_COREUTILS_WEBC_SHA256,
  WASIX_EXCLUDED_SEGMENTS,
  WASIX_MAX_DIRECTORY_ENTRIES,
  WASIX_MAX_FILE_BYTES,
  WASIX_MAX_FILES,
  WASIX_MAX_OUTPUT_BYTES,
  WASIX_MAX_WORKSPACE_BYTES,
  WASIX_PINNED_WEBC,
  WASIX_REGISTRY_ORIGIN,
  WASIX_STREAM_DRAIN_GRACE_MS,
} from "./wasix-contract";

type RunMessage = Readonly<{
  type: "run";
  script: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  workspaceRoot?: string;
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}>;

type CapturedOutput = Readonly<{
  stdout: string;
  stderr: string;
}>;

type CancelMessage = Readonly<{ type: "cancel" }>;

const scope = self as DedicatedWorkerGlobalScope;
const NativeWorker = (globalThis as unknown as { Worker: typeof Worker }).Worker;
const nativeFetch = scope.fetch.bind(scope);
const trackedWorkers = new Set<Worker>();
const excludedSegments = new Set<string>(WASIX_EXCLUDED_SEGMENTS);
let started = false;
let closed = false;

const workerPolicy = (scope as typeof scope & {
  trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): unknown } };
}).trustedTypes?.createPolicy("airship-wasix-worker", {
  createScriptURL(value) {
    const url = new URL(value, scope.location.href);
    if (url.protocol !== "blob:" && url.origin !== scope.location.origin) {
      throw new TypeError("WASIX child Workers must use a blob or same-origin release asset.");
    }
    return value;
  },
});

const TrackedWorker = new Proxy(NativeWorker, {
  construct(target, argumentsList) {
    const next = [...argumentsList];
    if (typeof next[0] === "string" || next[0] instanceof URL) {
      const candidate = next[0].toString();
      assertTrustedChildWorkerUrl(candidate);
      if (workerPolicy) next[0] = workerPolicy.createScriptURL(candidate);
    }
    const worker = Reflect.construct(target, next, target) as Worker;
    trackedWorkers.add(worker);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      trackedWorkers.delete(worker);
      terminate();
    };
    return worker;
  },
});
Object.defineProperty(scope, "Worker", { value: TrackedWorker, configurable: false, writable: false });

scope.fetch = guardedFetch as typeof fetch;

scope.onmessage = (event: MessageEvent<RunMessage | CancelMessage>) => {
  if (event.data.type === "cancel") {
    cancelWorkerTree("cancelled");
    return;
  }
  if (started) {
    post({ type: "failed", error: "A disposable WASIX Worker accepts exactly one job." });
    return;
  }
  started = true;
  void run(event.data).catch((error) => {
    post({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    cancelWorkerTree("failed");
  });
};

async function run(message: RunMessage): Promise<void> {
  post({ type: "phase", phase: "loading-sdk" });
  const sdk = await import("@wasmer/sdk");
  await sdk.init();
  post({ type: "phase", phase: "sdk-ready" });
  const statusNonce = randomNonce();
  // Keep child status and output outside the user WorkspacePort.
  const directory = new sdk.Directory(Object.fromEntries(
    // Wasmer DirectoryInit paths are directory-absolute. Relative keys are
    // accepted by the JS type but do not materialize at the mounted guest path
    // in SDK 0.10, which made a healthy mount look empty and discarded writes.
    message.files.map(({ path, bytes }) => [`/${path}`, bytes]),
  ));
  const controlDirectory = new sdk.Directory({
    "/stdout": new Uint8Array(),
    "/stderr": new Uint8Array(),
    "/status": new Uint8Array(),
  });
  // Loading the bare Bash WebC with `fromFile()` drops the package dependency
  // graph. Bash itself starts, but external commands (including the mounted
  // filesystem helpers used by its redirection path) then fail inside the SDK
  // with provider status 45. `fromRegistry()` resolves Bash's declared,
  // side-loaded coreutils package. The guarded fetch boundary below still
  // verifies the exact registry record, artifact URL, atom signature, and WebC
  // digest before any byte reaches the runtime.
  const pkg = await sdk.Wasmer.fromRegistry(WASIX_BASH_SPEC);
  post({ type: "phase", phase: "package-verified" });
  if (!pkg.entrypoint || pkg.entrypoint.name !== "bash") throw new Error("Pinned WASIX package has no Bash entrypoint.");
  // The logical Airship path never leaks into the guest.
  const mountRoot = "/workspace";
  const controlRoot = "/airship-control";
  const wrapper = [
    `( eval -- ${shellSingleQuote(message.script)} ) > ${controlRoot}/stdout 2> ${controlRoot}/stderr`,
    "__airship_status=$?",
    `printf 'airship-status-v1:${statusNonce}:%s\\n' "$__airship_status" > ${controlRoot}/status`,
    "exit \"$__airship_status\"",
  ].join("\n");
  const instance = await pkg.entrypoint.run({
    args: ["--noprofile", "--norc", "-c", wrapper, "airship-wasix", ...message.args],
    env: { ...message.env },
    mount: { [mountRoot]: directory, [controlRoot]: controlDirectory },
    cwd: mountRoot,
  });
  post({ type: "phase", phase: "bash-spawned" });
  const providerStdout = consume(instance.stdout, "stdout", false);
  const providerStderr = consume(instance.stderr, "stderr", false);
  const captured = captureControlOutput(controlDirectory);
  const captureViolation = captured.done.then<never>(
    () => new Promise<never>(() => undefined),
    (error) => Promise.reject(error),
  );
  const output = await Promise.race([instance.wait(), captureViolation]);
  post({ type: "phase", phase: "bash-exited" });
  // Wasmer's stream handles do not close with wait(); yield once so bytes
  // already produced by child coreutils commands reach their readers, then
  // cancel the handles deterministically.
  await new Promise((resolve) => setTimeout(resolve, WASIX_STREAM_DRAIN_GRACE_MS));
  captured.stop();
  await Promise.all([providerStdout.cancel(), providerStderr.cancel()]);
  const [finalOutput, rawProviderStdout, rawProviderStderr] = await Promise.all([
    captured.done,
    providerStdout.done,
    providerStderr.done,
  ]);
  const childExitCode = await readChildExitCode(controlDirectory, statusNonce, rawProviderStdout, rawProviderStderr);
  const files = await collectDirectory(directory, "/");
  post({
    type: "completed",
    exitCode: childExitCode,
    providerExitCode: output.code,
    stdout: finalOutput.stdout,
    stderr: finalOutput.stderr,
    files,
  });
  cancelWorkerTree("completed");
}

function consume(
  stream: ReadableStream,
  channel: "stdout" | "stderr",
  emit = true,
): Readonly<{ done: Promise<string>; cancel(): Promise<void> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let outputBytes = 0;
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = chunk.value as Uint8Array;
        const remaining = WASIX_MAX_OUTPUT_BYTES - outputBytes;
        if (remaining <= 0) throw new Error(`WASIX ${channel} exceeded 256 KiB.`);
        const accepted = bytes.subarray(0, remaining);
        outputBytes += accepted.byteLength;
        const text = decoder.decode(accepted, { stream: true });
        output += text;
        if (emit && text) post({ type: "output", stream: channel, text });
        if (accepted.byteLength !== bytes.byteLength) throw new Error(`WASIX ${channel} exceeded 256 KiB.`);
      }
      const tail = decoder.decode();
      if (tail) {
        output += tail;
        if (emit) post({ type: "output", stream: channel, text: tail });
      }
      return output;
    } finally {
      reader.releaseLock();
    }
  })();
  return Object.freeze({ done, async cancel() { await reader.cancel().catch(() => undefined); } });
}

function captureControlOutput(directory: import("@wasmer/sdk").Directory): Readonly<{
  done: Promise<CapturedOutput>;
  stop(): void;
}> {
  let stopped = false;
  const states: Record<"stdout" | "stderr", {
    bytes: Uint8Array<ArrayBufferLike>;
    decoder: TextDecoder;
    text: string;
  }> = {
    stdout: { bytes: new Uint8Array(), decoder: new TextDecoder(), text: "" },
    stderr: { bytes: new Uint8Array(), decoder: new TextDecoder(), text: "" },
  };
  const sample = async (channel: keyof typeof states): Promise<void> => {
    const next = await directory.readFile(`/${channel}`);
    const state = states[channel];
    if (next.byteLength > WASIX_MAX_OUTPUT_BYTES) throw new Error(`WASIX ${channel} exceeded 256 KiB.`);
    if (next.byteLength < state.bytes.byteLength || !equalPrefix(next, state.bytes)) {
      throw new Error(`WASIX ${channel} was rewritten after output had streamed.`);
    }
    const delta = next.subarray(state.bytes.byteLength);
    state.bytes = new Uint8Array(next);
    if (!delta.byteLength) return;
    const text = state.decoder.decode(delta, { stream: true });
    state.text += text;
    if (text) post({ type: "output", stream: channel, text });
  };
  const done = (async () => {
    while (!stopped) {
      await Promise.all([sample("stdout"), sample("stderr")]);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await Promise.all([sample("stdout"), sample("stderr")]);
    for (const channel of ["stdout", "stderr"] as const) {
      const tail = states[channel].decoder.decode();
      states[channel].text += tail;
      if (tail) post({ type: "output", stream: channel, text: tail });
    }
    return Object.freeze({ stdout: states.stdout.text, stderr: states.stderr.text });
  })();
  return Object.freeze({ done, stop() { stopped = true; } });
}

async function readChildExitCode(
  directory: import("@wasmer/sdk").Directory,
  nonce: string,
  providerStdout: string,
  providerStderr: string,
): Promise<number> {
  let record: Uint8Array;
  try {
    record = await directory.readFile("/status");
  } catch {
    throw new Error(`WASIX Bash did not write its nonce-bound child-status record.${providerFailureDetail(providerStdout, providerStderr)}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(record);
  const match = new RegExp(`^airship-status-v1:${nonce}:([0-9]{1,3})\\n$`, "u").exec(text);
  const status = Number(match?.[1] ?? Number.NaN);
  if (!Number.isInteger(status) || status < 0 || status > 255) {
    throw new Error(`WASIX Bash wrote an invalid nonce-bound child-status record.${providerFailureDetail(providerStdout, providerStderr)}`);
  }
  return status;
}

function providerFailureDetail(stdout: string, stderr: string): string {
  const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
  return detail ? ` Provider runtime output: ${detail.slice(0, 1_024)}` : "";
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shellSingleQuote(value: string): string {
  if (value.includes("\0")) throw new Error("WASIX Bash scripts cannot contain NUL bytes.");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function equalPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}

async function collectDirectory(
  directory: import("@wasmer/sdk").Directory,
  root: string,
): Promise<ReadonlyArray<Readonly<{ path: string; bytes: Uint8Array }>>> {
  const result: Array<Readonly<{ path: string; bytes: Uint8Array }>> = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await directory.readDir(path)) {
      const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      const relative = root === "/" ? child.slice(1) : child.slice(root.length + 1);
      entries += 1;
      if (entries > WASIX_MAX_DIRECTORY_ENTRIES) {
        throw new Error(`WASIX workspace output exceeded its ${WASIX_MAX_DIRECTORY_ENTRIES}-entry budget.`);
      }
      assertAllowedRelativePath(relative);
      if (entry.type === "dir") {
        await visit(child);
        continue;
      }
      if (entry.type !== "file") continue;
      const binary = await directory.readFile(child);
      if (binary.byteLength > WASIX_MAX_FILE_BYTES) throw new Error(`WASIX output file exceeds 512 KiB: ${child}`);
      bytes += binary.byteLength;
      if (result.length >= WASIX_MAX_FILES || bytes > WASIX_MAX_WORKSPACE_BYTES) {
        throw new Error("WASIX workspace output exceeded its 256-file / 4 MiB budget.");
      }
      result.push(Object.freeze({ path: relative, bytes: binary }));
    }
  };
  await visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === scope.location.origin) return nativeFetch(request);
  if (url.origin === WASIX_REGISTRY_ORIGIN && request.method === "POST") {
    const response = await nativeFetch(request);
    await verifyRegistryResponse(response.clone());
    return response;
  }
  const expected = WASIX_PINNED_WEBC.get(url.href);
  if (expected) {
    const response = await nativeFetch(request);
    if (!response.ok) throw new Error(`Pinned WASIX artifact fetch failed with HTTP ${response.status}.`);
    const digest = await sha256Hex(await response.clone().arrayBuffer());
    if (digest !== expected) throw new Error("Pinned WASIX artifact digest mismatch.");
    return response;
  }
  throw new Error(`WASIX pack blocked undeclared network origin: ${url.origin}`);
}

async function verifyRegistryResponse(response: Response): Promise<void> {
  if (!response.ok) throw new Error(`Wasmer registry failed with HTTP ${response.status}.`);
  const payload = await response.json() as {
    data?: { getPackage?: { namespace?: string; packageName?: string; versions?: Array<{ version?: string; v3?: { piritaDownloadUrl?: string; piritaSha256Hash?: string; webcManifest?: string } }> } };
  };
  const packageRecord = payload.data?.getPackage;
  const packageName = `${packageRecord?.namespace ?? ""}/${packageRecord?.packageName ?? ""}`;
  const expected = packageName === "sharrattj/bash"
    ? { version: "1.0.18", hash: WASIX_BASH_WEBC_SHA256, signature: WASIX_BASH_ATOM_SIGNATURE, atom: "bash" }
    : packageName === "wasmer/coreutils"
      ? { version: "1.0.25", hash: WASIX_COREUTILS_WEBC_SHA256, signature: WASIX_COREUTILS_ATOM_SIGNATURE, atom: "coreutils" }
      : undefined;
  if (!expected) throw new Error(`Wasmer registry returned undeclared package metadata: ${packageName}`);
  const version = packageRecord?.versions?.find((candidate) => candidate.version === expected.version);
  const manifest = JSON.parse(version?.v3?.webcManifest ?? "null") as { atoms?: Record<string, { signature?: string }> } | null;
  if (
    version?.v3?.piritaSha256Hash !== expected.hash
    || version.v3.piritaDownloadUrl !== `https://cdn.wasmer.io/webcimages/${expected.hash}.webc`
    || manifest?.atoms?.[expected.atom]?.signature !== expected.signature
  ) {
    throw new Error(`Wasmer registry metadata did not match the pinned ${packageName}@${expected.version} artifact.`);
  }
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cancelWorkerTree(reason: "cancelled" | "completed" | "failed"): void {
  if (closed) return;
  closed = true;
  const workers = [...trackedWorkers];
  for (const worker of workers) worker.terminate();
  post({ type: "worker-tree-stopped", reason, workers: workers.length });
  scope.close();
}

function post(value: unknown): void {
  if (!closed || (value as { type?: string })?.type === "worker-tree-stopped") scope.postMessage(value);
}

function assertTrustedChildWorkerUrl(value: string): void {
  const url = new URL(value, scope.location.href);
  if (url.protocol !== "blob:" && url.origin !== scope.location.origin) {
    throw new TypeError("WASIX child Workers must use a blob or same-origin release asset.");
  }
}

function assertAllowedRelativePath(path: string): void {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`WASIX returned an invalid workspace-relative path: ${path}`);
  }
  const excluded = segments.find((segment) => excludedSegments.has(segment));
  if (excluded) throw new Error(`WASIX workspace output excludes the ${excluded} path segment.`);
}

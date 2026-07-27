import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = resolve(root, ".airship-lab");
const stateFile = resolve(stateDirectory, "state.json");
const viteLog = resolve(stateDirectory, "vite.log");
const composeFile = resolve(root, "compose.local-lab.yaml");
const composeProject = "airship-local-lab";

export const LOCAL_LAB = Object.freeze({
  uiUrl: "http://localhost:4173/",
  s3Endpoint: "http://127.0.0.1:9900",
  s3Console: "http://127.0.0.1:9901",
  region: "us-east-1",
  bucket: "airship-dev",
  namespace: "airship-live-v2/local-user",
  accessKeyId: "airship-vault-probe",
  secretAccessKey: "airship-vault-probe-only-2026",
});

export const LOCAL_LAB_UI_ORIGINS = Object.freeze([
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

// This is a deliberately non-secret, syntactically valid OAuth client ID used
// only by the local browser-acceptance boundary. Real Google authorization
// still requires an operator-supplied registration whose origin matches the
// deployed app.
export const LOCAL_LAB_GOOGLE_CLIENT_ID = "123456789012-airship-browser-acceptance.apps.googleusercontent.com";

export function inspectAirshipHtml(html) {
  return Object.freeze({
    airship: /<title>\s*Airship(?:\s|<)/iu.test(html),
    localS3Csp:
      html.includes("http://127.0.0.1:9900") &&
      html.includes("http://localhost:9900"),
  });
}

export function labEnvironment(base = process.env) {
  return Object.freeze({
    ...base,
    AIRSHIP_LOCAL_S3_ENDPOINT: LOCAL_LAB.s3Endpoint,
    AIRSHIP_LOCAL_S3_REGION: LOCAL_LAB.region,
    AIRSHIP_LOCAL_S3_BUCKET: LOCAL_LAB.bucket,
    AIRSHIP_LOCAL_S3_NAMESPACE: LOCAL_LAB.namespace,
    AIRSHIP_LOCAL_S3_ACCESS_KEY: LOCAL_LAB.accessKeyId,
    AIRSHIP_LOCAL_S3_SECRET_KEY: LOCAL_LAB.secretAccessKey,
    // The ordinary product must remain Drive-first even when its disposable
    // MinIO harness is running. S3 is reachable only after the user selects
    // the explicit advanced/local-lab provider; the harness never changes the
    // storage promise visible to an ordinary browser session.
    VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER: "google-drive",
    VITE_GOOGLE_CLIENT_ID: base.VITE_GOOGLE_CLIENT_ID ?? LOCAL_LAB_GOOGLE_CLIENT_ID,
  });
}

/**
 * Report only the non-secret shape needed to decide whether an already-owned
 * Vite process can be reused. The secret itself and any derivative of it never
 * enter the lab state file.
 */
export function chutesOAuthBridgeRequest(environment = process.env) {
  const clientId = environment.AIRSHIP_CHUTES_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = environment.AIRSHIP_CHUTES_OAUTH_CLIENT_SECRET?.trim() ?? "";
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "Local Chutes OAuth requires both AIRSHIP_CHUTES_OAUTH_CLIENT_ID and AIRSHIP_CHUTES_OAUTH_CLIENT_SECRET.",
    );
  }
  return Object.freeze({ configured: Boolean(clientId), ...(clientId ? { clientId } : {}) });
}

const requiredCorsRequestHeaders = Object.freeze([
  "authorization",
  "content-type",
  "if-match",
  "if-none-match",
  "range",
  "x-amz-content-sha256",
  "x-amz-date",
]);

export function labCorsAllows(input) {
  const methods = new Set((input.allowMethods ?? "").toLowerCase().split(/\s*,\s*/u));
  const headers = new Set((input.allowHeaders ?? "").toLowerCase().split(/\s*,\s*/u));
  return Boolean(
    input.status === 204 &&
    LOCAL_LAB_UI_ORIGINS.includes(input.allowOrigin) &&
    methods.has("put") &&
    requiredCorsRequestHeaders.every((header) => headers.has(header)),
  );
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "start") return start();
  if (command === "status") return status();
  if (command === "test") return test();
  if (command === "logs") return logs();
  if (command === "stop") return stop();
  help();
  if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 2;
}

async function start() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  console.log("Starting the isolated Airship S3 lab…");
  await compose(["up", "-d", "minio"]);
  await waitFor("MinIO", inspectMinio, (result) => result.ready, 45_000);
  await compose(["run", "--rm", "minio-init"]);

  const vite = await ensureVite();
  await writeFile(
    stateFile,
    `${JSON.stringify({ version: 1, startedAt: new Date().toISOString(), vite }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const snapshot = await inspectLab();
  if (!snapshot.ui.ready || !snapshot.ui.localS3Csp || !snapshot.s3.ready || !snapshot.s3Cors.ready) {
    throw new Error("The lab started but its health contract did not become ready. Run `npm run lab:logs`.");
  }
  if (chutesOAuthBridgeRequest(process.env).configured && !snapshot.oauthBridge.ready) {
    throw new Error("The local Chutes OAuth bridge was requested but did not become ready.");
  }
  printSnapshot(snapshot);
  printVaultSetup();
  console.log("\nThe deterministic demo agent is local. Chutes remains a real optional external service; no fake TEE evidence is generated.");
}

async function status() {
  const snapshot = await inspectLab();
  printSnapshot(snapshot);
  if (snapshot.s3.ready) printVaultSetup();
  if (!snapshot.ui.ready || !snapshot.s3.ready || !snapshot.s3Cors.ready) process.exitCode = 1;
}

async function test() {
  const snapshot = await inspectLab();
  if (!snapshot.ui.ready || !snapshot.ui.localS3Csp || !snapshot.s3.ready || !snapshot.s3Cors.ready) {
    throw new Error("Start a healthy lab with `npm run lab:start` before running the full lab suite.");
  }

  console.log("\n[1/5] Airship TypeScript, security, unit, build, and release gates");
  await run("npm", ["run", "check"], { cwd: root });

  console.log("\n[2/5] Rust recovery kernel");
  await run("cargo", ["test", "--manifest-path", "crates/airship-runtime/Cargo.toml"], { cwd: root });

  console.log("\n[3/5] Rust Chutes E2EE WASM core");
  await run("cargo", ["test", "--manifest-path", "crates/chutes-e2ee-wasm/Cargo.toml"], { cwd: root });

  console.log("\n[4/5] Live disposable S3 + encrypted journal/workspace conformance");
  await run("npm", ["run", "test:vault:live"], { cwd: root, env: labEnvironment() });

  console.log("\n[5/5] Chutes evidence authorization and ingress contracts");
  const apiRoot = resolve(root, "..", "chutes-api");
  await mkdir(resolve(stateDirectory, "uv-cache"), { recursive: true, mode: 0o700 });
  await run(
    "uv",
    [
      "run",
      "pytest",
      "-q",
      "tests/unit/test_request_auth.py",
      "tests/unit/test_idp_cache_headers.py",
      "tests/unit/test_idp_public_oauth_clients.py",
      "tests/unit/test_api_ingress_cors.py",
    ],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        DEBUG: "false",
        UV_CACHE_DIR: resolve(stateDirectory, "uv-cache"),
      },
    },
  );

  console.log("\nFull local lab suite passed. Browser CORS was configured for the lab bucket; production Chutes/S3 deployment behavior remains a separate gate.");
}

async function logs() {
  const state = await readState();
  if (state?.vite?.owned) {
    console.log(`\nAirship Vite log: ${viteLog}\n`);
    try {
      console.log(await readFile(viteLog, "utf8"));
    } catch {
      console.log("No Vite log has been written.");
    }
  } else {
    console.log("Airship is using an externally started Vite server; inspect that terminal for its logs.");
  }
  await compose(["logs", "--tail", "120", "minio"]);
}

async function stop() {
  const state = await readState();
  if (state?.vite?.owned && Number.isSafeInteger(state.vite.pid)) {
    await stopProcessGroup(state.vite.pid);
    console.log("Stopped the lab-owned Airship Vite server.");
  } else {
    console.log("Leaving the externally started Airship Vite server running.");
  }
  await compose(["down", "--volumes", "--remove-orphans"]);
  await rm(stateDirectory, { recursive: true, force: true });
  console.log("Removed the disposable MinIO volume. Lab probe objects and scoped local identities are not recoverable.");
}

async function ensureVite() {
  const existing = await inspectUi();
  const previous = await readState();
  const requestedOAuth = chutesOAuthBridgeRequest(process.env);
  if (existing.ready) {
    if (!existing.localS3Csp) {
      throw new Error("Port 4173 serves Airship without the local-lab CSP. Restart that Vite process, then run `npm run lab:start` again.");
    }
    if (previous?.vite?.owned && pidAlive(previous.vite.pid)) {
      const runningOAuth = Object.freeze({
        configured: previous.vite.oauthBridgeConfigured === true,
        ...(previous.vite.oauthClientId ? { clientId: previous.vite.oauthClientId } : {}),
      });
      const needsOAuthUpgrade = requestedOAuth.configured && (
        !runningOAuth.configured || runningOAuth.clientId !== requestedOAuth.clientId
      );
      if (!needsOAuthUpgrade) return previous.vite;
      await stopProcessGroup(previous.vite.pid);
      console.log("Restarting the lab-owned Airship process with the requested local OAuth bridge.");
    } else {
      throw new Error(
        "Port 4173 already serves an unowned Airship process. Stop it before `npm run lab:start`; the lab will not adopt a listener whose network binding it cannot prove.",
      );
    }
  }

  const viteBinary = resolve(root, "node_modules", "vite", "bin", "vite.js");
  await access(viteBinary);
  const descriptor = openSync(viteLog, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [viteBinary, "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
      cwd: root,
      detached: true,
      env: labEnvironment(process.env),
      stdio: ["ignore", descriptor, descriptor],
    });
    child.unref();
  } finally {
    closeSync(descriptor);
  }
  const vite = Object.freeze({
    owned: true,
    pid: child.pid,
    oauthBridgeConfigured: requestedOAuth.configured,
    ...(requestedOAuth.clientId ? { oauthClientId: requestedOAuth.clientId } : {}),
  });
  try {
    await waitFor("Airship", inspectUi, (result) => result.ready && result.localS3Csp, 30_000);
    return vite;
  } catch (error) {
    await stopProcessGroup(child.pid);
    throw error;
  }
}

async function inspectLab() {
  const [ui, s3, s3Cors, oauthBridge] = await Promise.all([
    inspectUi(),
    inspectMinio(),
    inspectMinioCors(),
    inspectOAuthBridge(),
  ]);
  return Object.freeze({ ui, s3, s3Cors, oauthBridge });
}

async function inspectOAuthBridge() {
  try {
    const response = await fetch(`${LOCAL_LAB.uiUrl}__airship/chutes/oauth/token`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    return Object.freeze({ ready: response.status === 204, status: response.status });
  } catch {
    return Object.freeze({ ready: false, status: 0 });
  }
}

async function inspectUi() {
  try {
    const response = await fetch(LOCAL_LAB.uiUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const html = await response.text();
    const inspected = inspectAirshipHtml(html);
    return Object.freeze({ ready: response.ok && inspected.airship, localS3Csp: inspected.localS3Csp });
  } catch {
    return Object.freeze({ ready: false, localS3Csp: false });
  }
}

async function inspectMinio() {
  try {
    const response = await fetch(`${LOCAL_LAB.s3Endpoint}/minio/health/live`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    return Object.freeze({ ready: response.ok });
  } catch {
    return Object.freeze({ ready: false });
  }
}

async function inspectMinioCors() {
  const checks = await Promise.all(LOCAL_LAB_UI_ORIGINS.map(async (origin) => {
    try {
      const response = await fetch(`${LOCAL_LAB.s3Endpoint}/${LOCAL_LAB.bucket}/.airship-cors-smoke`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": requiredCorsRequestHeaders.join(","),
        },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      return Object.freeze({
        origin,
        ready: labCorsAllows({
          status: response.status,
          allowOrigin: response.headers.get("access-control-allow-origin"),
          allowMethods: response.headers.get("access-control-allow-methods"),
          allowHeaders: response.headers.get("access-control-allow-headers"),
        }),
      });
    } catch {
      return Object.freeze({ origin, ready: false });
    }
  }));
  return Object.freeze({ ready: checks.every((check) => check.ready), checks: Object.freeze(checks) });
}

function printSnapshot(snapshot) {
  console.log("\nAirship local full-system lab");
  console.log(`  UI          ${snapshot.ui.ready ? "ready" : "unreachable"}  ${LOCAL_LAB.uiUrl}`);
  console.log(`  Dev S3 CSP  ${snapshot.ui.localS3Csp ? "ready" : "missing"}`);
  console.log(`  MinIO       ${snapshot.s3.ready ? "ready" : "unreachable"}  ${LOCAL_LAB.s3Endpoint}`);
  console.log(`  S3 preflight ${snapshot.s3Cors.ready ? "ready" : "rejected"}  Origins ${LOCAL_LAB_UI_ORIGINS.join(", ")}`);
  console.log(`  Legacy OAuth handler ${snapshot.oauthBridge.ready ? "ready" : "not configured (Browser/native PKCE needs no handler)"}`);
  console.log(`  Console     ${LOCAL_LAB.s3Console}`);
}

function printVaultSetup() {
  console.log("\nVault → Storage provider → S3-compatible / MinIO → Configure vault");
  console.log(`  Endpoint    ${LOCAL_LAB.s3Endpoint}`);
  console.log(`  Region      ${LOCAL_LAB.region}`);
  console.log(`  Bucket      ${LOCAL_LAB.bucket}`);
  console.log(`  Namespace   ${LOCAL_LAB.namespace}`);
  console.log(`  Access key  ${LOCAL_LAB.accessKeyId}`);
  console.log(`  Secret key  ${LOCAL_LAB.secretAccessKey}`);
  console.log("  These known credentials are bucket-scoped, loopback-only, and disposable. Never reuse them outside this lab.");
}

async function compose(args) {
  return run("docker", ["compose", "--project-name", composeProject, "--file", composeFile, ...args], { cwd: root });
}

async function run(command, args, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited ${code ?? `from signal ${signal ?? "unknown"}`}.`));
    });
  });
}

async function waitFor(label, inspect, ready, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspect();
    if (ready(last)) return last;
    await delay(300);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1_000} seconds (${JSON.stringify(last)}).`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    return state?.version === 1 ? state : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcessGroup(pid) {
  if (!pidAlive(pid)) return;
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && pidAlive(pid)) await delay(100);
  if (pidAlive(pid)) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // The process exited between the liveness check and the signal.
    }
  }
}

function help() {
  console.log(`Airship local full-system lab

  npm run lab:start   Start lab-owned loopback Airship and isolated MinIO
  npm run lab:status  Show authoritative UI/S3 readiness and Vault fields
  npm run lab:test    Run web, Rust, live S3, and Chutes integration gates
  npm run lab:logs    Show lab-owned Vite and MinIO logs
  npm run lab:stop    Stop lab-owned processes and permanently remove lab S3 data
`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Airship local lab failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

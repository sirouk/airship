# Local full-system lab

The Airship lab is a reproducible developer environment for exercising the
static browser client, deterministic agent, workspace/tools, sessions, local
Git, context indexing, profiles/skills/themes, proof surfaces, and a real
S3-compatible encrypted-state contract. It does not fabricate Chutes TEE,
billing, OAuth, or payment responses. Connect a real memory-only `cak_` or
`cpk_` credential when those external-service paths are under test.

## Start

Requirements: Node.js 22.13+, Rust, `uv`, Docker with Compose, and the repository
dependencies installed.

```sh
cd ~/chutes-jumpmaster/airship
npm install
npm run lab:start
npm run lab:status
```

An existing confidential Chutes OAuth registration can be exercised without
changing Chutes by starting the lab with its secret in the local process only:

```sh
AIRSHIP_CHUTES_OAUTH_CLIENT_ID='cid_…' \
AIRSHIP_CHUTES_OAUTH_CLIENT_SECRET='csc_…' \
npm run lab:start
```

If the lab already owns an unconfigured Vite process, the same command safely
restarts only that process with the bridge enabled while leaving the MinIO
volume intact. The state file records the public client ID and a configured
boolean only; it never records the secret or a derivative of it.
`npm run lab:status` reports **Chutes OAuth bridge ready** after the process is
actually accepting the same-origin exchange; an unconfigured bridge remains an
explicit optional status instead of looking like a working sign-in path.

On `http://localhost:4173`, Airship sends the authorization-code and refresh
exchanges to a same-origin, development-only loopback bridge. The bridge pins
the Airship client ID, callback, origin, grant types, request fields, response
size, and upstream token endpoint before adding the secret. The secret is never
sent to JavaScript, written to the lab state file, bundled into `dist/`, logged,
or stored in MinIO. Hosted static Airship continues to use direct public-client
PKCE and therefore requires native Chutes public-client support.

Before leaving for Chutes authorization, the browser performs a no-content
same-origin readiness check. A missing process-held secret now stops locally
with configuration guidance instead of completing consent and failing on the
callback. A shared confidential secret must never be embedded in a PWA, WASM
module, or distributed companion binary: a user who controls that device can
recover it. Production edge distribution therefore uses public-client PKCE (or
a provider device flow); the confidential loopback bridge is a local operator
facility only.

`lab:start` is idempotent for a lab-owned Airship Vite server on
`http://localhost:4173`; otherwise it starts one and records its PID, log, and
non-secret bridge shape under ignored `.airship-lab/`. It refuses to adopt an unrelated process on the
port because it cannot prove that process is loopback-bound. It starts
digest-pinned MinIO and `mc` images,
binds both ports to IPv4 loopback, creates `airship-dev`, applies browser CORS,
and creates a bucket-scoped disposable identity. It never stops a Vite process
it did not start.

The lab UI is also bound to IPv4 loopback by default because its recovery-key
and credential forms are intentionally local. `npm run dev:lan` exists for a
deliberate UI-only LAN check, but the disposable S3 lab remains loopback-only;
do not expose its known fixture credentials or ports to a network.

Open <http://localhost:4173>. Google Drive remains the ordinary-user default,
even while this isolated MinIO harness is running. To exercise the disposable
S3 path, open **Vault** and select **S3-compatible / MinIO**. That explicit
selection auto-configures, probes, and adopts the baked loopback lab; wait for
**Encrypted state synced** before testing reload durability. The harness never
selects or adopts MinIO for an ordinary Google Drive browser session. If the
automatic handoff fails, `npm run lab:status` prints the exact diagnostic fields
for **Configure vault** and the manual live probe. Preferences → Durability can
switch to fully Ephemeral page memory and back; the transition migrates the
workspace, journal, browser-Git registry, and conventional `.git` state before replacing the active runtime. A
ready probe proves the tested storage primitives. It does not, by itself,
certify multi-device convergence or make MinIO a production tenant service.

MinIO's operator console is available at <http://127.0.0.1:9901>. Its root
identity is infrastructure-only. Airship receives the printed bucket-scoped
probe identity. All credentials are known local fixtures, so the service must
remain loopback-only and disposable.

## Exercise the product

1. Chat with the deterministic local provider; try `/ls`, `/read README.md`,
   and `/write notes/lab.md` followed by content.
2. Use Workspace Explorer to expand folders, open multiple editable tabs,
   save with revision fencing, move files by drag/drop or the mobile action
   sheet, then open **Workspace → Editor → Sources** for full diffs,
   branches, and source-control management. Import a public GitHub snapshot; the
   same snapshot must appear in both Editor views and remain after reload in
   Vault mode.
3. Switch profiles and themes, change global/per-profile Skills, and inspect
   the Memory relationship graph.
4. Inspect Sessions, fork a session, run Proof audit, and review the local
   receipt/attestation distinction.
5. Use `inspect_execution_runtimes`, `execute_javascript`, or `execute_code`
   with a WASI command artifact. For Python, approve
   `install_execution_runtime` with `python-pyodide` once, then use
   `execute_code`; the interpreter remains disposable and is never persisted
   to the Vault. Node projects may explicitly activate `node-webcontainer` and
   use `execute_node_project`; provider delivery may fail or exceed the bounded
   30-second boot, in which case Airship must remain non-ready.
6. Optionally use **Continue to Chutes** through the configured local OAuth
   bridge, or connect a real Chutes `cpk_`; select a model, invoke a turn, and
   open the exact receipt under **Proof → Endpoint evidence**. Missing deployed
   CORS/verifiers must remain visibly partial or unavailable; the lab never
   manufactures a green TEE badge.

## Full gate

```sh
npm run lab:test
```

This runs, in order:

- TypeScript, static-security, Vitest, production build, and release gates;
- both Rust suites;
- an actual MinIO preflight for Airship's signed PUT headers and live MinIO
  conditional create/CAS/range/list plus encrypted journal/workspace
  conformance, followed by a real `runTurn` that publishes an explicitly
  approved encrypted context generation, retrieves its selected expert over an
  exact HTTP `Range`, injects it into inference, and verifies the encrypted
  journal; and
- Chutes API evidence-scope, OAuth/IDP, and ingress-CORS regression tests.

The Node conformance runner reports browser CORS separately. The bucket itself
is configured for the browser origin, but production provider CORS/IAM and real
Chutes behavior are never inferred from this local run.

Use `npm run lab:status` for authoritative HTTP readiness and
`npm run lab:logs` for diagnostics.

For an explicit real-provider smoke test, supply a disposable credential only
to the child process (never source or browser storage):

```sh
CHUTES_TEST_API_KEY='cpk_…' \
CHUTES_TEST_MODEL='zai-org/GLM-5.2-TEE' \
npm run test:chutes:live
```

This exercises model discovery, instance/nonce acquisition, request
encryption, authenticated streaming, receipt finalization, journal persistence,
and the independent session audit. It remains opt-in and skipped without the
environment variable because it invokes a billable external service.

## Stop and destroy

```sh
npm run lab:stop
```

This stops only a Vite server owned by the lab, stops Compose, and permanently
removes the MinIO volume. All lab objects, recovery-test state, and scoped local
identities are intentionally unrecoverable. An externally started Vite server
is left running.

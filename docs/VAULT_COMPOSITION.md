# Strict browser vault composition

Status: implemented composition and deterministic tests; a deployed browser-origin
S3/Cognito conformance report is still required before a production readiness
claim.

Airship now has one evidence-gated composition root for cloud-authoritative
state:

- [`VaultCoordinator`](../src/vault/coordinator.ts) owns configuration and
  readiness transitions;
- [`EncryptedObjectWorkspace`](../src/vault/encrypted-workspace.ts) publishes
  immutable encrypted file objects before CAS-advancing one encrypted manifest;
- [`EncryptedObjectJournalBackend`](../src/storage/encrypted-object-journal.ts)
  does the same for immutable event segments and session heads; and
- [`runObjectStoreConformance`](../src/storage/conformance.ts) verifies the
  live provider's conditional create, CAS, exact range, listing, and
  read-after-write behavior.

This introduces no Airship application server. The browser calls the temporary
credential authority and S3-compatible provider directly.

## State truth

The coordinator exposes a discriminated `VaultSnapshot`:

| State | Meaning |
| --- | --- |
| `disconnected` | No endpoint, credential provider, key, or runtime is retained. |
| `configured` | Syntax and deployment requirements are valid; no provider behavior has been proved. |
| `probing` | The explicitly disposable prefix is being mutated by live checks. |
| `ready` | This browser origin passed the object-store contract plus encrypted journal/workspace smoke checks. |
| `degraded` | A required key, credential, provider behavior, or encrypted-state check failed. |

`ready` deliberately reports `dataSynchronization: "not-evaluated"`. It is not
a green “synced” icon and says nothing about whether a particular session or
workspace generation is current on another device. That requires head
comparison, session audit, and conflict/recovery UI.

## Production composition

```ts
import { CognitoIdentityCredentialProvider } from "../src/storage/cognito-identity-credentials";
import { WorkspaceRootKey } from "../src/storage/encrypted-envelope";
import { VaultCoordinator } from "../src/vault";

const credentials = new CognitoIdentityCredentialProvider({
  region: "us-east-1",
  identityPoolId: "us-east-1:POOL_UUID",
  loginProvider: "issuer.example/oidc",
  getIdToken: () => authSession.freshIdToken(),
});
const workspaceKey = await WorkspaceRootKey.import(recoveredKeyBytes);
recoveredKeyBytes.fill(0); // clear the caller-owned byte copy after import

const vault = new VaultCoordinator();
vault.configure({
  configuration: {
    mode: "strict-production",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "airship-private",
    namespace: `airship/v1/${authenticatedSubjectId}`,
    forcePathStyle: false,
    credentialSource: {
      kind: "cognito-identity",
      displayName: "Cognito Identity + OIDC",
      authorityOrigins: [
        "https://issuer.example",
        "https://cognito-identity.us-east-1.amazonaws.com",
      ],
    },
  },
  credentialProvider: credentials,
  workspaceKey,
});

const result = await vault.probe({
  acknowledgeImmutableProbeObjects: true,
});
if (result.phase !== "ready") throw new Error(result.phase);

const { journal, workspace } = vault.readyRuntime();
```

After conformance succeeds, the ready runtime wraps the provider with a
ciphertext-only accelerator. It probes dedicated-worker OPFS sync access first,
then async OPFS, IndexedDB, and page memory. The wrapper admits only immutable
workspace/Git objects and encrypted context pages; provider reads remain
mandatory for mutable heads, list operations, create-if-absent, and every CAS.
The factual result is available as `vault.readyRuntime().acceleration` and does
not change the Vault readiness or synchronization verdict. See
[CLIENT_STORAGE_ACCELERATION.md](CLIENT_STORAGE_ACCELERATION.md).

The credential provider object and non-extractable `WorkspaceRootKey` are
private coordinator fields. Snapshots, subscribers, diagnostics, and the
[`VaultView`](../src/ui/vault-view.tsx) receive neither. `disconnect()` aborts
the active probe, calls the provider's `reset()` hook, and drops coordinator
references to the provider, workspace key, store, and runtime. JavaScript
cannot promise immediate memory zeroization or revoke references retained by
the caller; account/logout code must reset every owner. Raw recovery bytes
remain the caller's responsibility and should be overwritten immediately after
WebCrypto import.

Production `S3ObjectStore` rejects credentials without both an expiring session
token and sufficient remaining lifetime. A raw access-key/secret pair is not a
coordinator configuration field and must never be rendered or persisted.

## Disposable probe lifecycle

The live gate is intentionally destructive-in-the-small. It requires the
literal acknowledgement `acknowledgeImmutableProbeObjects: true` and creates a
cryptographically unique child under:

```text
<subject namespace>/.airship-probes/v1/<run nonce>/...
```

It writes non-sensitive fixed conformance markers, races conditional creates
and CAS updates, creates an encrypted journal session, writes/reads/removes an
encrypted workspace file from its manifest, and scans stored ciphertext for
the private smoke marker. The returned evidence includes every known key and
per-check timing.

The narrow `ObjectStore` has no delete operation, so a lost conditional write can
never destroy data. Reclamation is an **optional** capability,
`ReclaimableObjectStore.trash(keys)`, implemented today only by
`GoogleDriveObjectStore` and forwarded by `CiphertextCachingObjectStore` only
when the wrapped authority has it — `isReclaimableObjectStore` therefore stays a
truthful capability report rather than a method that throws.

`VaultCoordinator` uses it for two cases. The first is sweeping a successful
probe's own objects, which nothing else can reference. It removes the index
entry by CAS first and asks the provider to trash the body second, so a crash
can only leak an untracked file and can never break a live reference. A key is
reported reclaimed only when the provider confirms it; anything unconfirmed
keeps the original out-of-band cleanup warning verbatim, and a provider with no
reclamation capability keeps that warning unchanged.

The second is the bounded reclamation sweep (`VaultCoordinator.runReclamationSweep`,
driven from the Vault route's **Reclaim storage** action). Workspace `remove()`
removes the file from the encrypted manifest but not the historical ciphertext
object, and `write()` mints a new revision-scoped object per edit. Those
superseded revisions are deliberately **not** trashed inline after a manifest
CAS, because a reader holding an older manifest generation would hard-fail on
the missing object. Instead the workspace and the context fabric now record
each supersession at commit time into one encrypted, CAS-guarded durable
queue ([reclamation-queue.ts](../src/vault/reclamation-queue.ts)). The sweep
ages queued candidates past a safety window (default seven days, adjustable
between one hour and ninety days), re-verifies every aged candidate against
the freshest committed manifest — or, for context segments, the freshest
committed routing mirror — and only then offers survivors to
`trash()` in bounded batches. A candidate the fresh root still names is
reconciled out of the queue, never offered; a candidate kind the run cannot
re-verify is skipped; and the queue is told exactly which removals the
provider confirmed, so a later run never silently re-offers them. Providers
that also expose `UntrackedObjectSweepStore` — today
`GoogleDriveObjectStore` — additionally enumerate provider-side crash-window
orphans (bodies no index entry names) by provider identifier, age them by the
provider's own creation time, and trash them by identifier with a fresh-index
recheck per call. The sweep's receipt reports provider-confirmed removals
only, and names offered-but-unconfirmed objects as retained
([reclamation.ts](../src/vault/reclamation.ts)).

What still accumulates, by design: journal segments whose append CAS lost a
race stay as recoverable ciphertext — an append retry re-mints the same key
and adopts them — and conversation deletion already trashes journal objects
head-first inline. The Local Device runtime does not record into the queue
yet and has no sweep entrypoint; encrypted leftovers there are covered by the
full wipe, and the queue hooks are designed for a follow-up sweep wiring.
Honest user-facing deletion, retention, recovery, and garbage collection
remain production gates. A failed probe cannot promise a complete inventory,
so its degraded snapshot carries both the unique run prefix and adjacent
isolation-test prefix as possible residue with `inventory: "unknown-after-failed-probe"`.

## Local S3-compatible development

A MinIO/LocalStack-style service is supported only as an explicit lab:

```ts
import { LocalLabSetup } from "../src/ui/local-lab-setup";

<LocalLabSetup onConfigure={(request) => vault.configure(request)} />
```

HTTP, path-style addressing, and non-expiring credentials are enabled only for
`localhost`, `127.0.0.1`, or `[::1]` in this mode. Passing the same credential
shape to a production endpoint fails before the first S3 request. The component:

- accepts only endpoint, region, bucket, namespace, and disposable local
  access/secret values;
- requires acknowledgement that the service and credentials belong only to the
  user on loopback, not AWS/cloud/team/shared infrastructure;
- offers an explicit **Generate new** or **Import existing** recovery path;
  generation creates a 256-bit WebCrypto key and presents its versioned
  `airship-wrk-v1...` value once, while import uses a bounded, masked,
  non-autofill textarea and canonical format validation;
- requires a recovery acknowledgement before either path can hand off;
- disables browser completion where the platform allows, keeps all fields in
  component memory, and clears every field and the recovery display immediately
  after the synchronous coordinator handoff; and
- performs no fetch, provider probe, bucket mutation, or other destructive call.

Browser/password-manager heuristics may ignore `autocomplete` hints, and copied
text can outlive the page in the operating-system clipboard. The form says so
rather than claiming control it does not have. `LocalLabRecoveryMaterial.clear()`
overwrites its retained byte array and drops its key/display references, but
JavaScript cannot guarantee immediate collection or zeroization of strings.
Switching recovery modes clears generated material and imported text. Successful
import clears the textarea before the callback is invoked.

The integration callback is deliberately narrow and synchronous:

```ts
type LocalLabSetupProps = {
  onConfigure(request: ConfigureVaultRequest): void;
};
```

The request already contains the validated local configuration, private-field
credential provider, and non-extractable workspace key. The mounted Vault route
can pass it directly to `vault.configure(request)`; setup never calls `probe()`.
Recovery helpers load only when Generate/Import is used, and the S3,
conformance, encrypted-journal, and encrypted-workspace modules load only when a
live probe begins. Merely showing Vault does not put those protocol engines on
the initial application path.

For a non-UI harness, the same handoff is available directly:

```ts
import {
  LocalLabRecoveryMaterial,
  createLocalLabConfigureRequest,
} from "../src/vault/local-lab";

const recovery = await LocalLabRecoveryMaterial.generate();
displayOnceAndSave(recovery.displayValue);

const request = createLocalLabConfigureRequest({
  endpoint: "http://127.0.0.1:9000",
  region: "auto",
  bucket: "airship-dev",
  namespace: "users/local-test",
  accessKeyId: disposableLocalAccess,
  secretAccessKey: disposableLocalSecret,
  workspaceKey: recovery.workspaceKey,
  ownLoopbackServiceAcknowledged: true,
  recoveryKeySavedAcknowledged: true,
});
vault.configure(request); // validates and retains in page memory; no network
recovery.clear();
```

`MemoryOnlyLocalLabCredentialProvider` uses native private fields, exposes a
redacted `toJSON()`, and drops its string references on `reset()`. It deliberately
returns no session token or expiry: only the S3 adapter's loopback development
escape hatch accepts that shape. `disconnect()` invokes its reset hook. The
saved recovery string can be re-imported with `importLocalLabRecoveryKey()`.

### Opt-in live loopback harness

[`local-lab-live.test.ts`](../src/vault/local-lab-live.test.ts) is skipped in an
ordinary `npm test`. The dedicated script sets only the explicit opt-in flag;
all target and credential values must already be supplied by the caller's
environment:

```sh
AIRSHIP_LOCAL_S3_ENDPOINT=http://127.0.0.1:9900 \
AIRSHIP_LOCAL_S3_REGION=auto \
AIRSHIP_LOCAL_S3_BUCKET=airship-dev \
AIRSHIP_LOCAL_S3_NAMESPACE=airship-live-v2/local-user \
AIRSHIP_LOCAL_S3_ACCESS_KEY="$LOCAL_MINIO_ACCESS" \
AIRSHIP_LOCAL_S3_SECRET_KEY="$LOCAL_MINIO_SECRET" \
npm run test:vault:live
```

Required names are exported as `LIVE_LOCAL_S3_ENVIRONMENT` in
[`local-lab-live.ts`](../src/vault/local-lab-live.ts). Do not put their values in
the repository, an `.env` file, npm configuration, screenshots, or issue logs.
Prefer a short-lived shell/session secret source; ordinary shell history and
process-environment visibility remain operating-system concerns.

The harness:

1. refuses to run unless `AIRSHIP_LIVE_LOCAL_S3=1` (the npm script supplies it);
2. accepts only an HTTP(S) loopback endpoint and the same strict local bucket,
   region, and namespace validation as the UI;
3. generates an ephemeral workspace key, zeroes its recovery bytes afterward,
   and resets the credential provider through coordinator disconnect;
4. runs the full disposable ObjectStore plus encrypted journal/workspace probe;
5. prints one `airship-local-s3-live-conformance` JSON envelope containing only
   hashed bucket/namespace identifiers, check names/timings, readiness, object
   count, cleanup requirement, bounded diagnostic codes, and an explicit
   `node-vitest` / `browserCors: "not-evaluated"` execution posture; and
6. withholds access/secret values, exact endpoint, bucket, namespace, created
   keys, raw provider messages, and public diagnostic prose.

The live probe creates immutable objects. Apply lifecycle expiry to the
configured namespace or clean them out-of-band. A verified result still says
`dataSynchronization: "not-evaluated"`; it proves the tested provider contract,
not that any user session is synchronized. Node's fetch does not enforce browser
CORS, so this harness cannot replace the deployed-origin browser conformance
run required for production.

## Browser deployment requirements

`vaultProviderRequirements(config)` is the machine-readable deployment
contract. It returns:

- exact S3 and Cognito/OIDC origins for runtime validation and deployment review;
- GET/PUT plus SigV4, conditional-write, and Range request headers for CORS;
- ETag, length, range, modification, region, and request-ID response headers;
- memory-only expiring credential/reset requirements; and
- the exact per-subject list/object IAM prefix.

The public static build accepts user-selected HTTPS endpoints under its
intentional `connect-src https:` grant. Configuration still validates exact
credential-free URLs and credentials remain scoped to those configured
endpoints. Wildcard hosts and remote plaintext origins remain prohibited. A
fixed deployment can narrow the policy to exact object, identity, and inference
origins when CSP-level egress isolation matters more than endpoint portability.

Bucket/IAM/CORS details remain normative in
[AWS_S3_REFERENCE.md](AWS_S3_REFERENCE.md). In particular, direct browser
requests use `credentials: "omit"`; CORS is transport permission, while IAM is
the tenant boundary. Cognito guest identities and shared/public funding keys
remain prohibited.

## UI integration

[`VaultView`](../src/ui/vault-view.tsx) and its isolated stylesheet accept only
the public snapshot and command callbacks:

```tsx
<VaultView
  snapshot={vaultSnapshot}
  onProbe={() => void vault.probe({ acknowledgeImmutableProbeObjects: true })}
  onCancelProbe={() => vault.cancelProbe()}
  onDisconnect={() => vault.disconnect()}
/>
```

Subscribe once to update application state. The setup dialog should construct
the credential provider and import/generate a workspace key outside the view;
there is intentionally no permanent-secret field. Display the immutable-object
warning before invoking the first live probe. Do not bind a “synced” badge to
`phase === "ready"`.

## Current boundaries

- This proves protocol behavior against the tested browser origin and prefix,
  not provider durability, tenant IAM review, multi-region scale, or future
  behavior.
- The encrypted manifest CAS prevents silent overwrite but does not implement
  automatic conflict merging, a cross-tab writer lease, historical deletion,
  or trusted rollback anchoring.
- Workspace files are UTF-8 strings capped at 16 MiB; a chunked binary/large
  file protocol belongs in a later immutable-pack layer.
- Workspace-key enrollment, wrapping, recovery, rotation, and device
  revocation are separate keyring work and are not implied by this coordinator.
- Diagnostics are intentionally bounded/redacted. Raw provider bodies stay
  ephemeral and must not be copied into journal events or support exports.

## Verification

Focused tests cover configuration rejection, exact CSP/CORS/IAM requirements,
local-development confinement, encrypted workspace confidentiality and CAS
races, immutable-object mutation, revision enforcement, full S3 conformance,
encrypted journal/workspace readiness, redacted denial, cancellation,
supersession, disconnect reset, probe acknowledgement, local credential
enumeration/reset/cancellation, side-effect-free setup handoff, acknowledgement
enforcement, and recovery-key generate/import/clear behavior.

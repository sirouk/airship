# Google Drive vault adapter

## Outcome

Google Drive is Airship's preferred zero-backend durable storage provider. S3
remains an advanced `ObjectStore` adapter. Both feed the same encrypted journal,
workspace, retrieval publisher, and index-shard composition; agent code does not
branch on the provider.

The browser creates this user-visible hierarchy with the non-sensitive
`drive.file` scope:

```text
Airship Workspace/        # user renameable
  root/
    .airship-root-v1.enc  # client-encrypted object routing index
    segments/
      <opaque-id>.enc     # encrypted composition objects
```

The folder is created by Airship and remains visible in My Drive. `drive.file`
lets Airship revisit files it created without granting access to the rest of the
user's Drive. The top folder can be renamed in Airship or Drive because folder
identity is its stable Drive file ID, not its display name.

Only the top-level folder is a human workspace affordance. `root`, `segments`,
`.airship-root-v1.enc`, and opaque `.enc` files are an implementation surface,
not a second file browser. The product must label them “Airship encrypted data”
and provide an **Open in Drive** action without inviting users to rename, move,
or edit internal objects. A missing or moved internal folder blocks adoption;
Airship does not silently rebuild it into a competing authority.

## Browser-only account flow

`GoogleIdentityServicesAuthorizer` loads the official GIS browser library only
after the Google surface is opened. One click requests:

- `openid email profile` for page-memory account context;
- `https://www.googleapis.com/auth/drive.file` for app-created files.

The connection view calls `prepare()` while it opens so the GIS script is ready;
`authorize()` then opens the token dialog synchronously inside the user's click.
The public OAuth client ID is configuration, not a secret. The access token and
UserInfo result stay in page memory. There is no client secret, refresh token,
backend exchange, or simulated silent refresh. When the short-lived token is
near expiry, storage fails with `GoogleDriveAuthorizationRequiredError`; a new
click/tap must obtain another token. Disconnect drops the token immediately.

Google account authorization does **not** derive or recover the Airship E2EE
root key. Google owns ciphertext, not decryption authority. A user must retain
the one-time recovery material for another browser/device.

`src/storage/workspace-key-handle-store.ts` implements the same-origin IndexedDB
cache for that reload case: a structured-cloned non-extractable `CryptoKey`
keyed by `google-drive:<googleSubject>` alongside the non-secret folder
descriptor and account label, in its own `airship-workspace-key-handles-v1`
database. `list()` lets a reconnect affordance render before any click, and
`adoptCachedWorkspaceKey` gates adoption on a **live** rediscovery of the
hierarchy whose ids must equal the cached ones — the stored descriptor is a
lookup hint, never the authority. Raw key bytes are never a fallback. Its
read-back validator runs in `workspace-key-handle-store.test.ts` against a
substitute IndexedDB, because Node has none; no browser has yet exercised this
database.

**Not yet reachable from the product.** The Drive setup screen still requires a
generated or pasted `airship-wrk-v1…` value on every reload; nothing calls
`rememberWorkspaceKey` or `adoptCachedWorkspaceKey` yet. Until that wiring lands
in `src/ui/google-drive-setup.tsx`, this is browser-profile unlock that exists in
the storage layer only. It must never be described as hardware-bound or as
cross-device recovery: the recovery value remains the only cross-device route.

Creation and recovery are deliberately different operations. A newly generated
key may call `connectOrCreate`; an imported key calls `connectExisting` and is
not allowed to create any folder. If the user chooses the wrong Google account,
mistypes the key, or an internal encrypted-data folder was moved, recovery fails
closed with no replacement hierarchy. This prevents an empty second vault from
masquerading as a successful cross-device recovery.

## Object-store mapping and concurrency

`GoogleDriveObjectStore` implements the existing strict interface:

- immutable object bodies are uploaded as opaque segment files;
- a client-encrypted index maps logical keys to stable Drive IDs, byte lengths,
  content digests, and timestamps;
- `putIfAbsent` and `compareAndSwap` advance only that index with HTTP
  `If-Match`;
- a lost index race leaves an unreferenced opaque segment and never acknowledges
  the losing mutation;
- exact range reads use Drive's authorized `Range` response and validate the
  returned `Content-Range` against the committed index;
- concurrent reads share one in-flight index download/decrypt and a 1.5-second
  bounded cache rather than scanning or repeatedly decrypting the root;
- every conditional write bypasses that read cache and loads a fresh root before
  applying `If-Match`.

The adapter sends `If-Match`, but Google's current Drive API documentation does
not publish an object-store-style atomic CAS guarantee for media updates. The
strict capability therefore remains **live-conformance-required**: deterministic
fakes prove Airship's reaction to `412`, not that production Drive will enforce
the precondition. Until release gates 1 and 2 pass against real Google, the
defensible concurrency mode is one active browser writer or explicit
conflict/multi-head preservation—not a production CAS claim.

Airship's journal/workspace/vector publishers already envelope content before
calling `ObjectStore`. The Drive routing index is encrypted inside the adapter.
A bare storage-conformance probe uses recognizable test bytes by design; it is
not production state.

At initial creation, concurrent browsers can each create an index candidate
because Drive filenames are not unique. Airship re-lists after creation and
fails closed if more than one candidate exists. It never selects a winner by
filename or Drive ID. An explicit repair/migration flow must inspect both roots,
prove ancestry, select authority, and retire the other before reconnection.

## Bounded and resumable work

The adapter bounds object, range, index, list, and retry sizes. Small encrypted
objects use one multipart request. Encrypted immutable shards of at least 8 MiB
use Drive's resumable upload protocol in 4 MiB chunks. If an acknowledgement is
lost or a retryable response follows a committed chunk, the client queries the
session's committed range and resumes within that same active operation.

The resumable session URI is a bearer-like capability. It is kept only on the
call stack and is never returned, logged, stored, or reused after refresh;
cross-refresh upload resumption is therefore not implemented. A failed or
expired session retries the immutable shard in a later operation. Completion
uploads only ciphertext, and the uploaded file remains an unreferenced orphan
until the separately encrypted routing index wins its `If-Match` update. Drive
resumption does not weaken or replace that sole CAS linearization point.

## Release gates

The adapter contract and deterministic fake-provider tests are necessary but
not sufficient for a production claim. Drive remains preview-only until all of
these gates pass:

1. **Real Google CAS:** a live browser test proves Drive exposes a usable ETag
   through CORS and rejects stale `If-Match` media updates with no index change.
2. **Two-context races:** two independent browser contexts, using the same
   Google account and recovery key, prove exactly one winner for create and CAS,
   observe the winner, and surface duplicate-root initialization as blocked.
3. **Garbage collection:** a bounded, resumable client job identifies only
   unreferenced opaque segments after an index snapshot, observes a safety age,
   rechecks a fresh index, and moves candidates to trash with an auditable
   receipt. Until then, losing uploads are retained ciphertext residue, and so
   is every superseded file revision — `EncryptedObjectWorkspace` mints a new
   segment per edit, which is by far the larger volume.

   **Partially landed.** `GoogleDriveObjectStore` now implements the optional
   `ReclaimableObjectStore.trash(keys)` capability, and `VaultCoordinator`
   sweeps a successful conformance run's own probe objects with it. That is
   *index-addressed* reclamation with an auditable receipt: the index entry is
   removed by CAS first, the `trashed: true` PATCH follows, and a key is
   reported reclaimed only when Drive itself echoes `trashed: true`. Because the
   entry is dropped first, a crash between the two steps can only leak an
   untracked file — it can never break a live reference.

   Still absent, and required to close this gate: enumerating the segments
   folder to find untracked lost-race orphans that no index entry names, and an
   aged candidate queue for superseded revisions. Superseded revisions are
   deliberately **not** trashed inline after a manifest CAS: a reader holding an
   older manifest generation would hard-fail on the missing object.
4. **Sharded index:** before the single encrypted root approaches its bounded
   size or practical Drive latency limit, route key prefixes into independently
   encrypted index shards under one CAS-protected directory root. Load and list
   budgets, shard split races, and recovery must pass conformance.
5. **Opaque-folder UX:** the visible workspace has clear encrypted-data
   labeling, an Open in Drive affordance, rename support for the top folder, and
   recovery guidance when internal objects were moved or edited.

No “synced,” “cross-device ready,” or production CAS badge is valid before the
real-Google and two-context gates pass.

### Deterministic browser acceptance

`npm run test:e2e:google-drive` starts an isolated strict-port Vite acceptance
server with a syntactically valid synthetic OAuth client ID. Playwright drives the real setup UI,
GIS wrapper, workspace manager, object store, coordinator probes, encrypted
composition, and runtime adoption. Only the external GIS and Google HTTP
boundaries are deterministic browser fakes. The test proves requested scopes,
Bearer authorization, encrypted writes, ranges, CAS success/rejection, adopted
UI state, and absence of token/client-secret/recovery persistence. It then opens
a storage-empty second browser context, imports only the recovery value, obtains
an independent page-memory grant, reopens the exact existing hierarchy, and
proves that no competing authority root was created. Desktop and mobile
Chromium projects run the same two-context ceremony.

The production build and artifact budgets are covered separately by
`npm run check`; this provider-boundary test does not replace that gate.

Passing this test is **not** real-Google acceptance and does not satisfy release
gates 1 or 2.

## Deployment checklist

1. Create a Google OAuth **Web application** client.
2. Add each exact Airship origin under Authorized JavaScript origins, including
   `http://localhost:4173` for the local lab.
3. Enable Google Drive API and configure the OAuth consent screen.
4. Configure the public client ID at deployment time; never add a client secret.
   Airship reads it from `VITE_GOOGLE_CLIENT_ID`.
5. Keep exact CSP grants for `accounts.google.com`, `www.googleapis.com`, and
   `openidconnect.googleapis.com`; do not use provider wildcards.
6. Run object-store conformance and encrypted composition probes before adopting
   the Drive runtime, then complete every release gate above before a production
   synchronization claim.

### An unconfigured build cannot offer Drive

`VITE_GOOGLE_CLIENT_ID` is read at build time. Vite inlines it, so an
unconfigured build has no connect branch left in the bundle and **no runtime
toggle can restore Drive on that artifact**. Because of that, the default vault
provider must move with the client ID rather than assume Drive:

- `isDeployableGoogleOAuthClientId`
  (`src/storage/google-drive-configuration.ts`) is the single source of the
  accepted shape. Both `GoogleIdentityServicesAuthorizer` and
  `resolveDefaultVaultBackend` consult it, so a missing or malformed deployment
  value cannot make an unreachable Drive provider the default. The authorizer
  still refuses invalid direct construction and normalizes an accepted value
  before it is ever sent as `client_id`.
- `.github/workflows/pages.yml` forwards `vars.VITE_GOOGLE_CLIENT_ID` and sets
  `VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER` to `google-drive` only when that
  repository variable is non-empty, and to `local-device` otherwise. **This
  repository ships unconfigured unless a maintainer sets that variable**, so the
  published GitHub Pages artifact currently defaults to the Local Device vault,
  which needs no configuration and is fully offline.
- A browser that already visited a previous build may have
  `vaultBackend="google-drive"` persisted in
  `airship.display-preferences.v1`. `loadPreferenceOverrides` revalidates that
  preference against the current build and falls back to the configured
  available provider—Local Device in an unconfigured release—rather than
  stranding the returning user on an unavailable setup surface.

The shipped application also uses `Cross-Origin-Opener-Policy: same-origin` to
unlock cross-origin-isolated WASM paths. Google's GIS setup guidance says popup
communication can require `same-origin-allow-popups` when FedCM is unavailable.
Real-provider acceptance must therefore prove the token dialog on every target
browser under the deployed headers; deterministic GIS substitution does not
clear that compatibility gate. Do not weaken the global runtime header or claim
Firefox/Safari support merely because Chromium FedCM succeeds.

## Primary references

- Google Identity Services browser token model:
  https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Google Drive scope guidance:
  https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Drive folders/files:
  https://developers.google.com/workspace/drive/api/guides/about-files
- Partial downloads:
  https://developers.google.com/workspace/drive/api/guides/manage-downloads
- Resumable uploads:
  https://developers.google.com/workspace/drive/api/guides/manage-uploads
- GIS CSP setup:
  https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid

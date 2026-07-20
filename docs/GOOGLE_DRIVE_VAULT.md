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
the one-time recovery material for another browser/device. A future same-origin
IndexedDB cache may store a non-extractable `CryptoKey` for same-browser reloads,
but it must not be described as hardware-bound or cross-device recovery.

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

The adapter bounds object, range, index, list, and retry sizes. The current
implementation uses multipart upload for already-segmented objects. Large
workspace data and vector corpora are expected to arrive as immutable shards,
so interruption retries only the affected shard. Drive resumable-upload session
URIs are intentionally not persisted yet: Google's session URL is a bearer
capability, and persisting it would require a separately reviewed encrypted
resume journal. Adding resumable uploads must preserve the same commit rule:
only a completed segment may be referenced by the encrypted CAS index.

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
   receipt. Until then, losing uploads are retained ciphertext residue.
4. **Sharded index:** before the single encrypted root approaches its bounded
   size or practical Drive latency limit, route key prefixes into independently
   encrypted index shards under one CAS-protected directory root. Load and list
   budgets, shard split races, and recovery must pass conformance.
5. **Opaque-folder UX:** the visible workspace has clear encrypted-data
   labeling, an Open in Drive affordance, rename support for the top folder, and
   recovery guidance when internal objects were moved or edited.

No “synced,” “cross-device ready,” or production CAS badge is valid before the
real-Google and two-context gates pass.

## Deployment checklist

1. Create a Google OAuth **Web application** client.
2. Add each exact Airship origin under Authorized JavaScript origins, including
   `http://localhost:4173` for the local lab.
3. Enable Google Drive API and configure the OAuth consent screen.
4. Configure the public client ID at deployment time; never add a client secret.
5. Keep exact CSP grants for `accounts.google.com`, `www.googleapis.com`, and
   `openidconnect.googleapis.com`; do not use provider wildcards.
6. Run object-store conformance and encrypted composition probes before adopting
   the Drive runtime, then complete every release gate above before a production
   synchronization claim.

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

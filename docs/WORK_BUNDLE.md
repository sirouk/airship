# Work bundles

A work bundle is one file that holds a person's conversations, and — if they
ask for it — the memory records of one profile. It is the answer to core user
job 6 in `docs/PRODUCT_SPEC.md`: *fork, resume, export, or delete work without
vendor lock-in*.

Before it existed, `downloadBytes` had exactly two callers: one workspace file,
and the whole encrypted Vault. A Vault backup is a file only Airship can read,
so a person could not get a conversation out of Airship at all.

## The readable format

A readable bundle is **one UTF-8 JSON object**. `JSON.parse` reads it. There is
no framing, no container, no compression and no Airship-only encoding.

```json
{
  "format": "airship.work-bundle",
  "version": 1,
  "exportedAt": "2026-08-21T09:00:00.000Z",
  "conversations": [
    {
      "session": { "id": "…", "title": "…", "manifest": { }, "headSequence": 4, "headDigest": "sha256:…" },
      "events": [ { "version": 1, "eventId": "…", "sequence": 1, "previousDigest": "genesis", "digest": "sha256:…", "type": "session.created", "payload": { } } ]
    }
  ],
  "memory": { "path": "/workspace/.airship/memory.json", "records": [] }
}
```

`session` is the journal's own `SessionRecord` and `events` are its own
`DurableEvent`s, unchanged. `memory` is `null` when memory did not travel.

The one field that is deliberately removed is `headIncarnation`. That is a
storage fence owned by one backend — authority metadata about where a record
lives, not portable conversation content — and a bundle that carried it would
be handing another device a claim about storage it does not have. Import
refuses a bundle that contains one.

### Verifying a bundle without Airship

Every event digest is

```
digest = SHA-256( stableStringify({
  version, eventId, sessionId, sequence, recordedAt, previousDigest,
  type, turnId: turnId ?? null, operationId: operationId ?? null, payload
}) )
```

`stableStringify` is canonical JSON with sorted object keys. Each event's
`previousDigest` is the digest before it; the first is `"genesis"`; the last
event's digest is the record's `headDigest`. Airship re-derives the whole chain
on import and refuses a bundle that does not match — see
`verifyWorkBundleChain` in `src/sessions/work-bundle.ts`.

## The sealed format

A sealed bundle is the same JSON, sealed with the active Vault's own envelope:
AES-256-GCM under a per-object key derived with HKDF-SHA-256 from the Vault's
`WorkspaceRootKey`. The file on disk is the envelope's JSON
(`encodeEnvelope`), with the plaintext in `ciphertext`.

What it costs, stated where it is offered:

- Only Airship can open it, and only against the same Vault. No other software
  can read it, and neither can Airship on a different Vault.
- Sealing needs an open Vault. On page memory there is no key, so the option is
  unavailable rather than silently degraded.

The route never sees the key. `EncryptedObjectWorkspace` implements
`PortableSealPort` (`sealPortable` / `openPortable`) so the bytes cross the
boundary, not the key.

## What a bundle is not

- **It is not a backup of your Vault key.** Losing the key still loses the
  Vault. This file cannot restore one.
- **A readable bundle is plaintext.** Every message in it can be read by anyone
  who holds the file. That is what "readable" means and it is the cost.
- It is not a workspace backup: files, repositories, profiles and skills do not
  travel in it.

## Import is a merge, not a restore

Import uses `migrateJournalState` (`src/vault/runtime-adoption.ts`) — the
primitive vault adoption already uses. It preserves session ids, event bytes,
sequence numbers and digest heads, skips a session already present, and refuses
one that conflicts. Vault `restore` is `replaceAll`; carrying a phone's work
back to a laptop with `restore` destroys the laptop's newer work. Import does
not, so laptop → phone → laptop is an ordinary repeatable move.

Before writing anything, import states:

- how many conversations the bundle holds;
- how many will be added;
- how many are already present and will be skipped;
- how many are refused, and why — a conflicting id, or a digest chain that did
  not verify;
- the memory counts, when memory travels;
- what it will not touch: the other conversations already here, workspace
  files, profiles and skills, and the Vault key.

The primitive is called once per conversation, so one refusal names one
conversation instead of aborting the whole import.

Memory records join by id: a new id is added, an identical id is skipped, and
an id already holding different content is refused rather than overwritten.
Records keep the profile they were written under, so they are recalled on the
receiving device only under that same profile id.

## Storage-neutral by construction

A bundle is a file. It can live in a Vault, a synced folder, a Git repository
or on a USB stick. No storage provider, relay or pairing service is added by
any of this.

## Where the bytes are

The move-work surface is fetched on the first press of **Move work** in *All
conversations* and never before. It is budgeted as `optionalWorkBundle` in
`scripts/release-gate.mjs`; see `docs/RELEASE_GATE.md`.

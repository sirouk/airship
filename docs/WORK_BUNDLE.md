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

### What a `session` record may not carry

A digest chain certifies itself and nothing else. Any file can mint a chain
that verifies, so a verified chain proves the events were not edited after they
were written — never who wrote them, and never what this device agreed to.

Five fields are therefore removed on export and **refused on import**
(`REFUSED_BUNDLE_PINS` in `src/sessions/work-bundle.ts`):

| Field | Why a file may not state it |
| --- | --- |
| `headIncarnation` | A storage fence owned by one backend: a claim about storage the receiving device has not made. |
| `approvalModeOverride` | The conversation's approval policy. The journal projection reads it back with the record's own value as its fallback, so a file that set `full-access` would keep it for every later append. |
| `modelOverride` | The conversation's routed model, projected the same way. |
| `contextPolicyOverride` | The compression policy that travels with that model. |
| `importedAt` | Set by the importing device, so a file can neither claim to be native nor forge a date. |

None of this loses real history. A mode or model a person actually chose is a
journaled `session.approval-policy-changed` or `session.model-changed` event,
so the projection re-derives it from the chain the bundle carries. What stops
travelling is the record's unaudited copy of it — the copy the projection falls
back to when no event says otherwise, which is exactly what a crafted file
reached.

The refusal names the field and says what to do: delete it and choose the file
again; the conversation's messages and digests import unchanged.

### The pinned system prompt

`session.manifest.systemPrompt` is sent to the provider on **every turn** the
conversation ever takes, and the record is not covered by the chain beside it.
`verifyWorkBundleChain` therefore also checks that the prompt hashes to the
`systemPromptDigest` the same manifest pins — the invariant the journal's own
audit already enforces as `SYSTEM_PROMPT_DIGEST_MISMATCH`. A bundle that fails
it is reported as unreadable and refused before anything is written.

### An imported conversation is read here and forked to continue

Import stamps every record it writes with `importedAt`, and a stamped record is
not offered as a conversation this profile can continue: its pinned
instructions, model and tool set were composed on another device and were never
agreed to here. Every message stays readable, the Sessions detail states
`ARRIVED_IN_A_BUNDLE` as its reason, and **Fork** is the way forward. This is
the same rule vault adoption already states for work carried into a Vault.

The resume comparison itself deliberately does *not* compare
`systemPromptDigest`: live browser and provider observations legitimately move
the composed prompt for a *new* session without making an existing conversation
incompatible, and a resumed conversation continues with its own immutable
prompt (`resumableProfileManifestMatches`). That rule is safe exactly while
every pinned prompt was composed here, so the fence is on where the record came
from rather than on what it says.

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

Memory is a second decision. The panel's checkbox is unchecked for every file,
including the next one inspected after the first, and the button names the
records it will add beside the conversations. Until it is checked, `Not touched`
includes your memory records and nothing in `memory.json` is written.

Memory records join by id: a new id is added, an identical id is skipped, and
an id already holding different content is refused rather than overwritten.

Import narrows to the profile doing the importing, exactly as export narrows to
the profile doing the exporting. A record addressed to any other profile — or
to none — is counted as `foreign`, stated in the plan and in the result, and
dropped. It is not rescoped to fit: rewriting someone else's note to name this
profile would forge its provenance instead of refusing it.

## Storage-neutral by construction

A bundle is a file. It can live in a Vault, a synced folder, a Git repository
or on a USB stick. No storage provider, relay or pairing service is added by
any of this.

## Where the bytes are

The move-work surface is fetched on the first press of **Move work** in *All
conversations* and never before. It is budgeted as `optionalWorkBundle` in
`scripts/release-gate.mjs`; see `docs/RELEASE_GATE.md`.

# Open WebUI clean-room chat study

Airship uses Open WebUI only as a behavioral reference. No Svelte components,
styles, icons, branding, API clients, or database contracts are copied.
Open WebUI's current license also places restrictions on removing its branding,
so a source-derived UI fork is explicitly outside this work.

## Observed interaction contracts

The reference implementation demonstrates several durable chat principles:

- Every conversation is addressable and restores its own composer draft.
- A conversation history can branch. Selecting a branch changes the visible
  ancestry without deleting siblings.
- Streaming content updates do not rebuild the entire transcript more often
  than the display can paint.
- A prompt typed during generation can enter a visible queue. Queued prompts
  can be sent next, edited, or removed.
- User and assistant messages expose role-appropriate actions without moving
  the transcript when those actions appear.
- Reasoning, tools, citations, code execution, and errors use distinct,
  progressively disclosed message parts.
- The composer grows with intent, keeps attachments visible, respects IME
  composition, and does not turn a send action into an accidental layout jump.
- Mobile retains the same functions with compact disclosures rather than
  permanently painting every action.

## Airship-native translation

Airship maps those behaviors onto different invariants:

| Reference behavior | Airship implementation |
| --- | --- |
| Mutable message-tree branch | Immutable journal session fork with ancestor digest commitment |
| Server chat ID route | `#chat/<opaque-session-id>` resolved against page memory or the active Vault |
| Server draft | Session-scoped `sessionStorage` draft; no credential or attachment bytes persist |
| Message queue | Page-memory, per-conversation queue; attachments remain `File` handles in the tab |
| Regenerate/edit | Retry in place or create an immutable conversation branch before resubmission |
| Tool/reasoning rendering | Durable `MessagePart` projections with proof-bearing source facts |
| Backend persistence | Local Device, Google Drive, or S3 Vault adapters behind the shared encrypted interfaces |

## Clean-room constraints

1. Airship's components and CSS remain independently authored.
2. No Open WebUI branding or visual theme is reproduced.
3. A behavior is included only when it preserves Airship's approval, provider,
   receipt, and edge-only execution contracts.
4. Capability labels continue to describe what the browser actually activated.
5. The reference checkout is temporary research material and is never vendored.

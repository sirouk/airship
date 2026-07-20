# Memory and context scope

Airship separates accountable conversation state from reusable workspace state.

1. The current thread transcript is primary and remains in its append-only session journal.
2. Explicit episodic memories are scoped to the immutable profile ID pinned in that session manifest. Tool arguments cannot select or override a profile.
3. Workspace files, imported source snapshots, and the on-device hybrid index are shared by every thread and profile using that workspace. Context selections retain workspace snapshot, generation, file revision, chunk, content, and selection digests.

`/workspace/.airship/memory.json` uses schema version 2. A profile memory records `profileId`, the profile revision active when it was created, and the creating session ID. Version 1 records had no scope. The parser admits them only as `legacy-unscoped`; recall never returns them automatically, and the next memory mutation rewrites the document as version 2 without assigning those records to whichever profile happened to touch the file first.

Forgetting is also profile-bound: a session cannot remove another profile's record even if the model knows its ID. Profile deletion must not delete session journals or receipts; orphaned profile memories can remain inspectable for explicit user-directed migration or deletion.

The current context engine indexes workspace files in page memory and performs hybrid lexical/dense retrieval. `.airship/memory.json` is explicitly excluded from that shared index, preventing profile records from leaking back through workspace search.

`search_memory` provides the unified agent-facing search contract without merging corpora blindly. Its response has three ordered groups: current-thread journal matches, active-profile explicit memories, and shared workspace-index hits. Thread events carry journal event/digest provenance; profile memories carry content digest, creation session, and profile revision; workspace hits carry generation, snapshot, revision, content, and chunk digests. Workspace scores are labeled as within-corpus only. Duplicate workspace path/chunk pairs are suppressed, and stale-index failures abort the federated result instead of returning a misleading partial answer.

Automatic turn preparation still injects only the current thread plus a generation-pinned workspace selection. It does not yet automatically inject explicit profile memories. Agents can call `search_memory` or `recall_memory`; a future canonical profile-memory selection must add its own bounded selection digest to the turn journal before automatic injection.

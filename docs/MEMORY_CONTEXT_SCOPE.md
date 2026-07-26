# Memory and context scope

Airship separates accountable conversation state from reusable workspace state.

1. The current thread transcript is primary and remains in its append-only session journal.
2. Explicit episodic memories are scoped to the immutable profile ID pinned in that session manifest. Tool arguments cannot select or override a profile.
3. Workspace files, imported source snapshots, and the on-device hybrid index are shared by every thread and profile using that workspace. Context selections retain workspace snapshot, generation, file revision, chunk, content, and selection digests.

`/workspace/.airship/memory.json` uses schema version 2. A profile memory records `profileId`, the profile revision active when it was created, and the creating session ID. Version 1 records had no scope. The parser admits them only as `legacy-unscoped`; recall never returns them automatically, and the next memory mutation rewrites the document as version 2 without assigning those records to whichever profile happened to touch the file first.

Forgetting is also profile-bound: a session cannot remove another profile's record even if the model knows its ID. Profile deletion must not delete session journals or receipts; orphaned profile memories can remain inspectable for explicit user-directed migration or deletion.

The current context engine indexes workspace files in page memory and performs hybrid lexical/dense retrieval. `.airship/memory.json` is explicitly excluded from that shared index, preventing profile records from leaking back through workspace search.

`search_memory` provides the unified agent-facing search contract without merging corpora blindly. Its response has three ordered groups: current-thread journal matches, active-profile explicit memories, and shared workspace-index hits. Thread events carry journal event/digest provenance; profile memories carry content digest, creation session, and profile revision; workspace hits carry generation, snapshot, revision, content, and chunk digests. Workspace scores are labeled as within-corpus only. Duplicate workspace path/chunk pairs are suppressed, and stale-index failures abort the federated result instead of returning a misleading partial answer.

Automatic turn preparation injects the current thread, a generation-pinned workspace selection, and up to three active-profile explicit memories. `FederatedTurnContextProvider` is the attached provider: the profile lane is ranked separately from the workspace lane, scores never cross corpora, and the memory hits carry their own `profile-memory` generation record (memory.json revision, source digest, extractor, chunker, index format, persistence) inside the sealed turn selection digest.

All three profile-memory paths — automatic injection, `search_memory` and `recall_memory` — now share one ranker (`src/retrieval/memory-ranking.ts`): bounded BM25 over the scoped records with a query-bigram bonus and a recency prior that reaches the injection gate at most exactly — the newest record scores 0.25 on recency alone against a 0.25 gate that is exclusive — so a genuinely unrelated turn injects nothing. `recall_memory` without a query still browses the newest records reverse-chronologically. Previously the automatic lane divided relevance by the length of the user's message and the two tools required the whole query to appear verbatim inside a record, so a normal multi-sentence question recalled nothing that a one-word query would have found.

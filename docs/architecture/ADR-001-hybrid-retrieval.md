# ADR-001 — Hybrid retrieval is Airship's default

**Status:** Accepted, and **partly implemented** as of 2026-08-04 on `main`.

The release-control and human-journey branches have landed, so this is binding
now rather than pending. Two of the three lanes in the evidence table below have
been unified onto one real BM25 in `src/retrieval/bm25.ts`:

- `src/retrieval/memory-ranking.ts` — extracted, not rewritten. Its seven tests
  pass unchanged, which is what makes it an extraction.
- `src/indexing/flat-index.ts` — the lane the agent reads on **every turn**, and
  the one that had no inverse document frequency at all. Its lexical half is now
  real BM25, with `semantic` and `lexical` modes available, and it gained the
  test file it never had.

**What is not yet done, and §4 says so explicitly.** That lane still fuses with
`denseScore * 0.72 + lexicalScore * 0.28` — the raw-score addition §4 supersedes
by name. Replacing the scorer improved the lexical evidence; it did not adopt
weighted Reciprocal Rank Fusion, and BM25 scores and cosine similarities remain
not-comparable quantities being added. Calling the current state "hybrid
retrieval per ADR-001" would overstate it. The honest description is: the lexical
lane is fixed, the fusion is not.

**Still divergent: `src/retrieval/context-driver.ts:185`.** Expert routing scores
`0.58 · semantic + 0.22 · overlap(queryTokens, expert.lexicalSketch) + 0.2 · gate`
and does not import the shared ranker. That is deliberately left open rather than
quietly claimed: it ranks *which encrypted expert pages to fetch* against a
compact sketch, not chunks against a corpus, and BM25 needs document-frequency
statistics a sketch may not carry. Whether it should share the ranker, share only
the tokenizer, or stay distinct is a real design question and wants its own
measurement — not an assumption that three lanes must mean one algorithm.
**Supersedes:** the per-route retrieval implementations described under
"Evidence" below.

## Decision

**Airship uses hybrid retrieval by default.** Hybrid means BM25/BM25F sparse
lexical retrieval and dense vector semantic retrieval, fused into one ranked
result set.

Airship must not default to vector-only search, lexical-only search, or
route-specific ad hoc search.

This applies to profile conversations and thread history, workspace files,
indexed codebases, symbols and definitions and references and imports and
configuration, Memory records, research Sources, tool and Skill documentation,
terminal and activity records where the user's scope permits them, and Proof and
receipt records where appropriate.

## Evidence — why this is a decision and not a preference

Airship already searched three ways, with three different notions of "lexical
evidence", and only one of them was BM25. Measured on this build:

| lane | lexical scorer | IDF | term frequency | length normalization |
|---|---|---|---|---|
| `src/retrieval/memory-ranking.ts` — profile memory | real BM25 | yes | yes | yes |
| `src/indexing/flat-index.ts` — workspace/context index | `matches / sqrt(\|q\| · \|d\|)` | **no** | **no** | partial |
| `src/retrieval/context-driver.ts` — federated retrieval | `matches / \|q\|` | **no** | **no** | **none** |

The consequences are not theoretical:

- **Without IDF**, a query term appearing in every document counts exactly as
  much as one appearing in a single document. "the pricing memo" is scored
  mostly on "the".
- **Without length normalization** (`context-driver`), a ten-thousand-token file
  matching one term of three scores identically to a five-token chunk matching
  one of three.
- **Without term frequency**, a document that discusses a term throughout is
  indistinguishable from one that mentions it once.

Both weaker scorers are in the lane that assembles turn context — the one whose
output the agent actually reasons over. The good implementation was sitting in
the same repository, in a sibling directory, unused by either.

That is the argument for a single retrieval authority, stated as a fact about
this codebase rather than as an aesthetic preference: three implementations
diverged silently, and the divergence landed on the most important lane.

## The canonical pipeline

```text
scope resolution
→ query analysis
→ BM25/BM25F retrieval
→ dense-vector retrieval
→ rank fusion
→ optional reranking
→ deduplication and diversity
→ provenance-bearing context selection
```

### 1. Scope before search

Resolve the active profile, workspace, runtime, permissions and corpus **before**
executing retrieval. Profile-local material stays profile-local: no cross-profile
conversation search, no cross-profile Memory retrieval, no cross-profile
workspace leakage, and no global retrieval merely because a global index is
technically convenient.

Cross-profile or global search is an explicit user action with a stated scope.

### 2. BM25 is always a first-class lane

BM25 preserves the exact-match strengths semantic retrieval routinely loses:
filenames, paths, class and function names, camelCase and snake_case
identifiers, error messages, hashes, model names, version strings, commands,
quoted phrases, ticket and finding IDs, configuration keys.

Field-aware weighting, strongest first:

```text
exact symbol / exact path
> title or heading
> filename
> code identifier
> body content
> low-signal metadata
```

Code, Markdown, chat, terminal and proof records may need different analyzers.
They feed the same retrieval contract.

### 3. Dense semantic retrieval is also default

Dense supplies conceptual recall: semantically related code, paraphrased past
discussions, relevant documentation without term overlap, architectural
relationships, previously learned facts expressed differently, sources related
by meaning rather than vocabulary.

Embedding models, dimensions, chunking rules and model versions are **pinned and
inspectable**.

**Corpus material is never sent as plaintext to anyone.** That is the actual
invariant, and it holds for both engines rather than only the local one.

The original wording here — "Airship never silently sends private corpus material
to an external embedding service", with a disclosure ceremony required before
remote embedding — described a threat that does not exist on this path, and the
ceremony it demanded bought nothing. Chutes serves every model from a TEE, and
Airship reaches it over the same end-to-end encrypted transport the chat lane
uses: the request is sealed against the instance's public key on this device, the
keys stay under the user's control on the client side, and the provider never
holds plaintext. A remote embedding computed that way is not "material leaving
for a third party to read". Treating it as one produced a worse product — an
interruption in the middle of connecting, protecting against nothing.

What must remain true, and is enforced rather than announced:

- Embeddings run either **on device**, or **inside a TEE over E2EE**. There is no
  third option, and a plaintext remote embedding endpoint is not admissible.
- The engine actually used is recorded in generation lineage and visible on the
  Index route, so which engine produced a vector is always checkable after the
  fact.
- A failure to reach the confidential engine surfaces as a failure. It never
  degrades to another engine while keeping the label.

### 4. Fuse ranks; do not add raw scores

BM25 scores and cosine similarities are not comparable quantities. Adding them
makes the blend an artifact of each lane's scale rather than of either lane's
opinion. The default fusion is **weighted Reciprocal Rank Fusion**:

```text
fused_score(d) = lexical_weight / (k + lexical_rank(d))
               + semantic_weight / (k + semantic_rank(d))
```

Query analysis may shift the weights — identifier, path and error queries favour
BM25; conceptual questions favour dense; mixed questions keep meaningful weight
in both. Neither lane is silently disabled because the other looks confident.

Any learned reranker runs **after** fusion and never removes the inspectability
of the original lexical and semantic evidence.

Note for implementation: the existing `denseScore * 0.72 + lexicalScore * 0.28`
in `flat-index.ts` is exactly the raw-score addition this section rules out. It
is superseded, not merely re-weighted.

### 5. One retrieval authority

Chat, Memory, Sources, conversation search, workspace search, codebase
understanding and agent context selection call the **same shared retrieval
service**. They may present results differently; ranking, scope, index identity,
freshness and provenance share one authority.

### 6. Retrieval is automatic for the agent

The operator never has to say "search the workspace", "look at the codebase",
"check Memory", "use BM25", "run semantic search", or "look in the file I
mentioned earlier."

Before and during a turn, Airship identifies the relevant authorized corpora,
retrieves a small evidence-bearing context set, and makes it available. This is
just-in-time retrieval, not stuffing the workspace into the prompt.

Mid-conversation changes become live immediately: a newly mounted workspace, a
connected Vault, a newly installed Skill, a changed file, a new Memory record, a
newly indexed repository, a connected Chutes runtime.

### 7. Every result carries provenance

Each selected result retains corpus and profile scope, source type, source path
or conversation, chunk or structural identity, content digest, revision or
generation, indexed time, retrieval time, lexical rank, semantic rank, fused
rank, reranker result if used, and the reason it entered context.

The ordinary interface may summarize. The full record stays inspectable, so a
person can always answer: **why did Airship use this piece of context?**

### 8. Freshness and incremental indexing

Indexing is incremental, content-hash based, revision-aware, profile-scoped,
non-blocking, performed off the main UI thread where practical, and updated
automatically after writes, imports, Git operations, Memory changes and source
ingestion.

A result is tied to the revision that produced it. **Airship does not present
stale indexed content as the current file.**

### 9. Honest degraded operation

- Dense unavailable → BM25 continues immediately.
- Sparse index rebuilding → dense continues where safe.
- Both unavailable → **state the failure**; do not imply no relevant material
  exists.

Degraded mode is visible to the agent and inspectable by the user. Capability
probing and index initialization never block first paint or ordinary chat
startup.

### 10. Evaluation and release gates

Maintain a **frozen retrieval evaluation corpus**: exact identifier queries,
filename and path queries, exact error strings, conceptual questions,
paraphrased conversation recall, mixed lexical-semantic questions, long-context
research questions, code navigation questions, adversarial cross-profile
queries, stale-index and changed-revision cases.

Measure Recall@K, MRR, nDCG@K, exact-match success, source-opening success,
profile-isolation failures, index freshness, query latency by corpus size, and
context usefulness in completed agent journeys.

Evaluate hybrid against **BM25-only**, **dense-only**, and **the previous
released retrieval behaviour**. Hybrid is the default because it proves better
coverage across exact and conceptual tasks — not because the architecture sounds
stronger.

A retrieval change **fails the gate** if it introduces a cross-profile result,
loses exact identifier retrieval, silently returns stale content, produces
untraceable context, materially regresses the frozen benchmark, or causes
unbounded indexing or query cost.

## Product presentation

A novice experiences this as *"Airship already understands the project and finds
the right material."*

A power user can inspect lexical versus semantic contribution, selected chunks,
score and rank details, index generation, filters and scopes, retrieval
diagnostics, and degraded-mode state.

Organize that depth. Do not remove it, and do not force ordinary users to manage
it.

## Implementation sequencing

**Hybrid retrieval does not go into the release-control PR, and did not.** An
exploratory implementation was begun during this pass — a shared `scoreBm25`
extracted from the memory ranker, with `flat-index` and `context-driver` rewired
onto it — and was deliberately parked so the decision could be recorded before
the code. The measurement in *Evidence* above is what that exploration produced,
and it is the part worth keeping.

After PR #3 and PR #2 are integrated:

1. Write the retrieval architecture decision. *(This document.)*
2. Define the shared retrieval service and corpus contract.
3. Establish the frozen evaluation corpus.
4. Implement BM25/BM25F and dense retrieval against common document identities.
5. Add weighted Reciprocal Rank Fusion.
6. Route existing Memory, Workspace, conversation, Sources and agent-context
   searches through it.
7. Prove profile isolation and index freshness.
8. Turn it on as the default.

No future search feature bypasses this foundation without an explicit
architectural exception, recorded as a superseding ADR.

## Relationship to other recorded work

This is the third architectural follow-up, behind two that block it:

1. **Deterministic builds** — `docs/audit/JOURNEY_CLOSEOUT.md`. Every bundle
   measurement and release manifest depends on reproducible output; a retrieval
   index shipped in a nondeterministic artifact cannot be attested.
2. **`app.tsx` decomposition** — the shared retrieval service should not be
   introduced into a 620 KB module.
3. **This decision.**

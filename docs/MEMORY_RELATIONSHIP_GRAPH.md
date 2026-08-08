# Memory Relationship Graph

Status: executable browser-only module, 2026-07-18.

## Renderer decision

Airship renders the optional visual surface with a hand-written 2D canvas component, `src/memory-graph/canvas-renderer.tsx`, and adopts no third-party graph model or rendering runtime. The derivation core already owns the graph model, so the only thing a library would have supplied is drawing, and a bounded device-local view of at most 5,000 nodes does not need a WebGL engine to draw it. The pinned runtime dependency set stays as small as it is.

### Superseded evaluation history

The library survey below is why no library was adopted. It is kept as the record of the decision, not as a description of what ships: neither Sigma nor Graphology is a dependency of this repository, and nothing under `src/` imports either name.

- Sigma's official v3 documentation describes the intended split directly: Graphology owns the graph data model and algorithms, while Sigma owns WebGL rendering and interaction. It targets graphs with thousands of nodes and edges and is MIT licensed: <https://www.sigmajs.org/>.
- Graphology provides a typed, in-memory property graph with explicit directed/multi-graph options and portable serialization: <https://graphology.github.io/instantiation.html> and <https://graphology.github.io/serialization.html>.
- Sigma v4 is currently labelled alpha by its own repository, so it is not a production dependency yet: <https://github.com/jacomyal/sigma.js>.
- Cosmograph v2 is compelling for multi-million-element analytics, but its official integration path adds asynchronous pre-indexing and an Arrow-oriented data preparation layer. That is a poor default cost for Airship's deliberately bounded, device-local memory view: <https://cosmograph.app/docs-lib/>.

There is no Neo4j, database server, graph API, analytics backend, or graph-specific persistence layer. Graph inputs are already-decrypted client state. Derivation, search, selection, layout, and rendering all execute in the browser.

## Truth model

The graph contains supplied sessions/messages, workspace files, profiles, and skills plus bounded, extractive word/phrase nodes. It creates relationships from:

- explicit IDs and references supplied by the runtime;
- session containment and message order;
- exact, unambiguous path/name mentions in bounded text scans.
- normalized tokens and adjacent phrases taken verbatim from those same bounded scans.

Term extraction applies NFKC/lowercase normalization, length/quality checks, and a fixed stopword list. Each term records occurrence count, source-document count, normalization, and extractive lineage. `mentions` edges carry exact per-source counts; undirected `co-occurs` edges carry source and occurrence counts. These are lexical observations, not semantic similarity or inferred facts.

An ambiguous basename such as `README.md` is never guessed. Invalid or missing references do not create placeholder nodes. Proposed semantics, embeddings, inferred entities, and model-generated relationships are excluded from this layer.

Node kinds are `session`, `message`, `workspace-file`, `profile`, `skill`, and `term`. Edge kinds are `contains`, `follows`, `uses-profile`, `uses-skill`, `references-file`, `mentions-profile`, `mentions-skill`, `mentions`, and `co-occurs`.

## Device limits

Defaults are intentionally finite:

- 5,000 nodes;
- 20,000 edges;
- 256 newest messages per session;
- 2,000 workspace files;
- 2,000,000 scanned text characters.
- 32,768 scanned characters per source;
- 512 term-bearing sources;
- 20 terms per source, 4,096 global candidates, and 512 materialized terms;
- 48 co-occurrence observations per source and 6,000 total term edges.

Every omitted category is reported in `graph.stats.truncated`. Positions and revisions are deterministic, so an unchanged input does not cause layout churn. The derivation/search/selection core has no third-party runtime dependency.

The canvas surface is dynamically imported only after the renderer enters a 240-pixel viewport margin. No force simulation runs. On devices where a 2D canvas context cannot be created, the component shows an honest unsupported state while the search and selection API remains functional. The probe is exactly that context creation (`supportsMemoryGraphCanvas`, src/memory-graph/renderer.tsx); `supportsMemoryGraphWebGL` survives beside it only as an alias for callers of the former WebGL renderer, and no WebGL context is ever requested.

## Public API

`deriveMemoryRelationshipGraph(input, options)` returns a `MemoryRelationshipGraph` with immutable `nodes`, `edges`, `stats`, and `revision`, plus:

- `getNode(id)`;
- `getIncidentEdges(id)`;
- `getNeighbors(id, edgeKinds?)`;
- `search(query, { kinds, limit })`;
- `select(id, { depth, maxNodes, edgeKinds })`;
- `serialize()`.

`MemoryGraphRenderer` accepts that graph, an optional controlled node selection, and an `onSelect` callback. Its canvas is an enhancement rather than the authoritative interface; readable counts and loading/error/fallback states remain in the DOM.

The module lives in `src/memory-graph/` and is exported from `src/memory-graph/index.ts`.

# Optional semantic embedding pack

Airship ships with a lightweight default indexing mode and an optional local
semantic pack.

## Current contract

- The baseline experience works without the semantic pack.
- Semantic indexing is opt-in.
- The semantic pack runs on the current device.
- If the pack is missing or unsupported, Airship stays honest and falls back to
  its non-semantic baseline instead of pretending semantic retrieval is active.

## Runtime shape

The semantic pack is delivered as reviewed static assets and loaded from the
same origin as the app build. The active generation is tied to the current
workspace/index inputs so Airship does not silently mix incompatible vector
materializations.

## User-facing rule

The UI must show which mode is active and whether the semantic pack is ready,
loading, unavailable, or failed. No hidden fallback may relabel one mode as the
other.

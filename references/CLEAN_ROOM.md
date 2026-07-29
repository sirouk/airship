# Airship clean-room reference protocol

**Status:** mandatory project policy for external reference studies  
**Scope:** every checkout catalogued in `repositories.json`, regardless of license

Airship may study public systems to understand behavior, interfaces, inputs,
outputs, invariants, failure modes, accessibility expectations, and
interoperability requirements. Airship implementation remains original. A
checkout is research material only: it is never an implementation source tree,
build input, dependency shortcut, fixture source, or place from which code is
transcribed.

This is an engineering and provenance control, not a substitute for legal
review when a release, dependency, asset, trademark, patent, or license question
requires counsel.

## Information barrier

Every reference-informed change has three artifacts or roles:

1. **Observation.** A reference researcher records only externally meaningful
   behavior and constraints. Notes may identify the repository and pinned
   revision, but contain no code snippets, distinctive internal names, copied
   prose, prompts, tests, styles, or assets.
2. **Functional specification.** The observation is normalized into Airship
   vocabulary: user goal, inputs, outputs, states, interfaces, invariants,
   failure behavior, accessibility behavior, mobile behavior, security/trust
   boundary, and black-box acceptance tests. It must be sufficient without the
   checkout being open.
3. **Original implementation.** An implementer works from the functional
   specification and Airship's own canon, architecture, tokens, and contracts.
   The implementation must not copy or mechanically translate reference source
   or distinctive organization.

When practical, different agents or people perform observation and
implementation. At minimum, close the checkout before implementation and make
the functional specification the only reference carried into the coding task.
Observations live in `studies/`, specifications in `specs/`, and the final
spec-to-diff review record in `decisions/`.

## Functional-specification template

```markdown
# <Airship behavior>

- Airship area:
- User goal:
- Reference IDs and pinned revisions:
- Observation method: public behavior | read-only source study | standard/spec
- Inputs:
- Outputs:
- States and transitions:
- Interfaces/events:
- Invariants:
- Failure and cancellation behavior:
- Accessibility and keyboard behavior:
- Mobile/responsive behavior:
- Security, privacy, and trust claims:
- Explicitly excluded reference expression:
- Black-box acceptance tests:
- Airship-specific design decisions:
```

## Implementation gate

Before merging reference-informed work, verify:

- the catalog pins URL, revision, relationship, license status, and study mode;
- a source-free functional specification exists and uses Airship vocabulary;
- a decision record binds the observation, specification, Airship baseline,
  implementer, resulting diff/commit, and review verdict;
- no checkout is imported, vendored, executed, or added to build/test paths;
- no source, prompt, prose, test, asset, branding, or distinctive naming was
  copied or mechanically translated;
- the result follows Airship's product canon, browser-first architecture,
  security model, semantic tokens, and mobile parity requirement;
- tests assert the functional behavior rather than mirroring another project's
  test structure;
- `docs/LINEAGE.md` records material influence and any deliberate package
  dependency retains its required notices;
- the final diff contains no path below `references/checkouts/`.

## Source status does not weaken the barrier

- **Open source:** safe to inspect under its license, but this project still
  uses it as idea-level clean-room reference unless a separate dependency
  decision is explicitly documented.
- **Source available/custom license:** behavior-only unless counsel and the
  project explicitly approve a different use.
- **No asserted license:** approved for read-only behavioral study only; the
  absolute no-copy/no-adaptation boundary applies.
- **Proprietary product:** public behavior and official interface documentation
  only. Do not seek or use leaked implementation material.

Reference approval means “safe to inspect under this protocol.” It never means
“safe to execute,” “safe to copy,” or “licensed for incorporation.”

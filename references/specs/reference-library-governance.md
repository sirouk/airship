# Approved reference-library governance

- Airship area: engineering provenance and external reference research
- User goal: allow pinned public repositories to inform product behavior while
  keeping Airship code, tests, prose, styles, assets, naming, and organization
  original.
- Inputs: `repositories.json`, a read-only checkout, Airship's canon, and an
  approved research question.
- Outputs: a source-free observation, a functional specification, an original
  Airship diff, and a decision record.
- States: catalogued → hydrated and verified → observed → specified →
  independently implemented → reviewed.
- Invariants:
  - checkout contents are ignored and never enter build, test, fixture, or
    release inputs;
  - checkout code is never executed under the study workflow;
  - every checkout is idea-level reference only regardless of license;
  - a no-asserted-license checkout retains an absolute no-copy/no-adaptation
    boundary;
  - implementation receives the specification and Airship canon, not the
    checkout or source-bearing observation;
  - revisions, tree hashes, license evidence, and fork relationships are pinned.
- Failure behavior: path escape, dirty or attached checkout, enabled hooks,
  revision/tree/license mismatch, missing spec/decision linkage, or tracked
  checkout content fails verification.
- Acceptance tests:
  - the verifier passes without checkouts in an ordinary CI clone;
  - strict verification passes with all ten catalogued checkouts hydrated;
  - traversal/symlink checkout targets are rejected before clone or checkout;
  - no tracked build/release input contains a checkout path;
  - every reference-informed decision resolves to existing observation and
    specification files.
- Explicitly excluded reference expression: all external code, prompts, prose,
  tests, styles, assets, branding, internal names, and distinctive organization.

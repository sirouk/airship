# External reference library

This directory makes the source studies behind Airship explicit and
reproducible. The actual repositories live under `checkouts/`, which is
gitignored. They are local research material, not vendored dependencies, build
inputs, release artifacts, or an alternative source tree for Airship.

`repositories.json` records the exact revision, upstream relationship, license
status, study areas, and reuse boundary for every checkout. The first seven
entries come directly from the Airship voice review. CocoIndex,
isomorphic-git, and xterm.js are supporting references already named by
Airship's canonical documentation or implementation and fill the closed-source
Cursor, browser-Git, and browser-terminal study areas.

## Rules

1. Treat every checkout as untrusted, read-only research. Never run its build,
   install scripts, hooks, binaries, containers, tests, or other code under this
   workflow. Black-box execution requires a separate, explicitly approved
   disposable-sandbox plan.
2. Study jobs, interaction contracts, information architecture, motion, and
   implementation tradeoffs while preserving Airship's own visual identity,
   trust model, and browser-first architecture.
3. A local checkout does not grant rights beyond its license. Airship's project
   policy is stricter than the permissions of a permissive license: treat every
   checkout as idea-level reference only. Extract a source-free functional
   specification, then implement original Airship code from that specification.
4. Every entry is a clean-room input. Do not copy or adapt source, styles,
   assets, prompts, tests, naming, branding, text, or distinctive organization.
   The mandatory information-barrier workflow and note template are in
   [`CLEAN_ROOM.md`](CLEAN_ROOM.md).
5. Never commit anything below `checkouts/`. Never add a checkout as a
   submodule, package input, test fixture, or release artifact.
6. Do not advance a checkout casually. A refresh requires reviewing changed
   provenance and license terms and then updating the pinned revision in
   `repositories.json`.

These rules refine, rather than replace, the project-wide provenance contract
in [`docs/LINEAGE.md`](../docs/LINEAGE.md) and the Open WebUI-specific boundary
in
[`docs/OPENWEBUI_CLEANROOM_CHAT.md`](../docs/OPENWEBUI_CLEANROOM_CHAT.md).

## Layout

```text
references/
├── README.md
├── CLEAN_ROOM.md
├── hydrate.sh
├── repositories.json
├── studies/                   # source-free observations
├── specs/                     # Airship-vocabulary functional specifications
├── decisions/                 # spec-to-implementation provenance records
└── checkouts/                  # ignored
    ├── open-source/
    ├── source-available/
    └── clean-room/
```

- `open-source/` contains repositories with a verified open-source license at
  the pinned revision.
- `source-available/` contains inspectable source with additional restrictions.
- `clean-room/` contains approved public behavior studies whose pinned revision
  has no asserted source license. They are safe to inspect as reference, while
  retaining an absolute no-copy/no-adaptation boundary.

ChatGPT, the Claude/Claude Code application, and Cursor remain behavioral
references only. They do not have cloneable open-source product repositories.
The official public Claude Code repository contains documentation and plugins
under Anthropic's commercial terms, not the core implementation. WebGPU,
WebNN, WebAssembly, OPFS, TDX, SEV, NVIDIA Confidential Computing, Chutes,
Google Drive, GitHub, and S3 are standards, hardware, or service integration
targets rather than product-source mirrors.

## Shaping coverage

The library is a set of lenses, not one product to imitate wholesale:

| Airship area | Primary local lenses |
| --- | --- |
| Profiles, sessions, skills, tools, permissions, live capability awareness | Hermes Agent, Codex, and the approved clean-room Claude behavior studies |
| Chat, threads, composer, attachments, message actions, branching, search, responsive presentation | Open WebUI as clean-room behavior; Codex for agent work in flight; proprietary ChatGPT and Claude remain observation-only |
| Workspace editor, Explorer, source control, diffs, history, themes, and contextual terminals | Code - OSS, isomorphic-git, xterm.js, and Codex |
| Memory, recall, graph, semantic codebase awareness, and incremental index | Hermes Agent and CocoIndex; proprietary Cursor remains observation-only |
| Vault durability, S3-compatible storage, local lab, and failure behavior | MinIO as an archived protocol/lab reference; browser storage and OPFS remain Airship-native platform integrations |
| Proof, E2EE, TDX/SEV/NVIDIA evidence, receipts, and remote Chutes execution | Airship's own protocol, threat-model, and proof documents plus authoritative platform/provider specifications; the recording named no open-source product implementation to mirror |
| Connections, accounts, OAuth/API-key posture, provider/model selection, and usage visibility | Codex and Hermes for interaction boundaries; Chutes, OpenAI, Anthropic, xAI, GitHub, and Google remain service integrations |
| Browser extension, compute/storage offload, WebGPU/WebNN/WASM runtimes, and resource monitoring | Airship's capability ladder and pinned runtime dependencies; the standards are not treated as product UI/source references |

Across every row, mobile must retain the same capability and information depth.
References may guide progressive disclosure and layout, but never justify
pruning features, evidence, controls, or advanced detail from Airship.

Reference-informed work begins in [`studies/`](studies/README.md), crosses the
information barrier through [`specs/`](specs/README.md), and is recorded in
[`decisions/`](decisions/README.md). A checkout path is never handed directly to
an implementation task.

## Hydration and verification

Hydrate every pinned checkout:

```bash
bash references/hydrate.sh
```

Hydrate only selected entries:

```bash
bash references/hydrate.sh hermes-agent openai-codex
```

The script is non-destructive: it refuses a dirty checkout, never deletes a
directory, checks out the catalogued commit in detached-HEAD state, disables
repository hooks, and verifies the resulting revision. Inspect a pin directly
with:

```bash
git -C references/checkouts/open-source/openai--codex rev-parse HEAD
```

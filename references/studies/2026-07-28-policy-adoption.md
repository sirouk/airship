# Clean-room policy adoption

- Date: 2026-07-28
- Scope: all repositories in `references/repositories.json`
- Decision: approve every pinned checkout for read-only reference under the
  clean-room protocol; no checkout is approved for execution or source reuse.
- Reclassification: `sirouk/claw-code` and `sirouk/claude-code-rs` moved from a
  quarantine label to the approved `clean-room` reference class. Their
  `NOASSERTION` license status and absolute no-copy/no-adaptation boundary did
  not change.
- Information barrier: reference observation produces a source-free functional
  specification; original Airship implementation proceeds from that artifact
  and Airship's own canon.
- Current implementation effect: none. The chat-title rename implemented in
  the same work period came directly from the Airship voice review and existing
  Airship terminal/session behavior, not from an external checkout.
- Verification: all ten checkouts matched their catalogued immutable revisions,
  were detached and clean, had repository hooks disabled, and had no
  `com.apple.quarantine` attribute at adoption time.

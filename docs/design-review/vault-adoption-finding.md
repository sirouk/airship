# Pre-existing: the local-lab vault verifies but never adopts

Localized by the lead while round 2 was building. **This predates the design
program** — `e2e/route-adversarial-audit.spec.ts` fails identically at commit
`5167526`, verified in a clean worktree.

## What happens

With the audit's own preference (`vaultBackend: "local-lab"`) and the MinIO lab
healthy, `#vault` settles on:

```
.vault-view__phase  ->  "Contract verified"   (class: vault-view__phase--ready)
```

and stays there. Probed at 5s, 10s, 15s and 20s — identical each time, so this
is **stuck, not slow**. The audit waits for `"Encrypted runtime active"` and
times out.

## Why

`src/ui/vault-view.tsx:81` renders `"Encrypted runtime active"` only when
`runtimeAdopted` is true. That prop is `vaultRuntimeAdopted` from
`src/ui/app.tsx:1226`:

```ts
const cloudVaultRuntimeAdopted = vaultSnapshot.phase === "ready"
  && runtime.current?.workspaceId.startsWith("vault+") === true
  && !runtime.current?.workspaceId.startsWith("vault+local-device://");
```

The first conjunct holds — the snapshot *is* `ready`, which is what puts
"Contract verified" on screen. The second does not: the runtime's `workspaceId`
never becomes `vault+…`. The vault verified its contract; the **runtime never
adopted it**.

There is no explicit adopt control on the route — `vault-view.tsx:154` offers
only "Configure vault" (`onOpenSetup`). So the preference alone gets a build to
"contract verified" without ever moving the runtime onto the vault.

## Why this is worse than a failing test

The route reports a green, ready-looking `"Contract verified"` while the
workspace and journal are still in page memory. A person who configured MinIO
and saw that phrase would reasonably believe their data is in the vault. That is
a durability claim outrunning the runtime state — the exact class of overclaim
this product exists to avoid.

## Two candidate fixes, for whoever owns this

1. **Adoption really should follow a verified contract for a preference-selected
   backend**, in which case the gap is in the adoption path in `app.tsx` and the
   audit's expectation was always correct.
2. **Adoption legitimately requires completing setup**, in which case
   "Contract verified" is the wrong phrase for a runtime that has not adopted —
   it should say what is actually true (the store answered; nothing is stored
   there yet) and point at the remaining step. The audit would then be asserting
   a state the flow never reaches without a user action, and should perform it.

Either way the current pairing — a `ready` phase and an unadopted runtime
sharing one green label — is not honest, and picking (2) still requires a copy
change rather than only a test change.

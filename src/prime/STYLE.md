# Prime port style

The `src/prime/` tree is a port of prime-agent core into Airship. It follows
Airship conventions, not upstream prime-agent formatting:

- 2-space indent, double quotes, semicolons, ES modules with explicit relative
  imports and no `.ts` extension in import specifiers.
- Strict TypeScript. No enums — union types plus `Object.freeze([...] as const)`
  arrays; exhaustive `Record<Kind, ...>` maps so a new kind fails to compile.
- No `node:*` APIs and no `process.env`/`require`/`__dirname`: the port must run
  in page and worker contexts. Randomness is `crypto.randomUUID`, digests are
  `crypto.subtle.digest` rendered `sha256:<base64url>`.
- Constants named `MAX_*`/`DEFAULT_*` at module top with a one-line rationale.
- Comments explain *why*, in complete sentences; narrate the failure being
  prevented or the upstream behavior being mirrored.
- Fail closed with named states and descriptive errors. Custom `Error`
  subclasses exist only where callers branch on identity
  (`OptimisticConcurrencyError`, `HarnessApplyRejectedError`).
- Classes only for genuine stateful authorities (stores, the facade);
  everything else is pure functions, `canonicalX` validators returning
  `X | undefined`, `resolveX` normalizers, `deriveX` projections.
- Colocated `<module>.test.ts` vitest files, one per module.

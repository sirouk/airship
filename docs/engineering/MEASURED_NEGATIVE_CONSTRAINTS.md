# Measured negative constraints

**Status:** Standing engineering constraints. Every entry is a thing *not* to do.
**Recovered:** 2026-08-04, from a plan document that lived only in a temp directory.
**Re-verified against:** `03af2c5`. Original measurements were taken between `d3fd7ab` and `a8c777a`.

---

## What this document is, and the one rule for adding to it

Each entry below records a course of action that looked correct, was attempted or
proposed, and was **killed by a measurement**. The measurement is the entry. The
advice is only its summary.

Every entry therefore carries three things:

1. The thing not to do, stated as an imperative.
2. **The measurement that killed it** — a number, a specific observed failure, or
   a named mechanism with a file:line.
3. The citation, re-resolved against the tree at the commit named above.

**Do not add an entry without a measurement.** Stripped of its measurement, an
entry here becomes unfalsifiable advice — general-sounding guidance that cannot
be checked, cannot expire, and cannot be argued with. This repository already has
more of that genre than it can use. An entry that cannot name what was measured
does not belong in this file; it belongs in a design document where it can be
disagreed with.

**Entries are superseded, never deleted.** When the tree closes one, the entry
stays and gains a `SUPERSEDED` marker saying what closed it. The measurement is
still the reason the shape was wrong, and deleting it loses the reason along with
the constraint.

### Citation drift

The constraints were written against a tree that has since moved 40+ commits. Every
file:line below has been re-resolved. Where a citation moved, both the original and
the current location are shown, because the original is what the measurement was
taken at. Two source trees were renamed wholesale in the interval:
`src/context/` → `src/indexing/`.

---

## 1. Do not raise or revert `expect.timeout` to address the profile-silo flake

**Measured:** the gate's own artifact showed all three attempts failing at
`Timeout 15000ms exceeded while waiting on the predicate`. The raised budget was
live and made no difference — once `openIndex(false)` latches `indexDismissed`,
the poll can never pass **at any timeout**.

**Mechanism (VERIFIED, current):** `src/ui/memory-view.tsx:729-733`

```
const openIndex = (open: boolean) => {
  setIndexExpanded(open);
  if (open) setIndexMounted(true);
  else setIndexDismissed(true);
};
```

`indexDismissed` is declared at `:538` and gates the auto-open effect at `:692`
(`if (!settled || indexDismissed || …) return;`). Once set, nothing in that effect
can re-open the disclosure.

**Constraint:** leave `playwright.config.ts` alone (the 15 s budget is still at
`playwright.config.ts:43`, unchanged). The fix removes the race, it does not
outwait it.

**Status: LIVE.** The latch is unchanged at the cited lines.

---

## 2. Do not fix the profile-silo flake at `e2e/profile-silo.spec.ts:57`

**Measured:** `scrollHeight` 2122 vs `clientHeight` 756 after
`createScrollableTranscript`, satisfied **6 ms** after the loop returns. It is not
a timing margin and needs no change. The failing line was `:87` at the full
15000 ms — a different assertion entirely.

**Citation drift (VERIFIED):** the `scrollHeight > clientHeight` poll is now
`e2e/profile-silo.spec.ts:59` (was `:57`). The genuinely failing assertion is now
`:88`, immediately after `openMemoryIndex(page)` at `:86` (was `:87`).

**Status: LIVE**, with corrected line numbers. This entry is the reason the flake
was not "fixed" at a line that was never wrong — a diagnosis that blamed a 1366px
scroll margin for what was a state-latch defect.

---

## 3. Do not add a fourth `openMemoryIndex` copy without checking the others

**Measured at the time:** two copies existed with **two different behaviours** —
`e2e/conversation-navigation.spec.ts:670` converged on open;
`e2e/live-semantic-embedding.spec.ts:114` read once and clicked once. Three copies
with two behaviours is what let this shape survive its first diagnosis: a fix
applied to one copy left the other still racing.

**Status: PARTIALLY SUPERSEDED.** Re-derived at `03af2c5`:

- The behavioural divergence is **closed**. All three copies now converge:
  `e2e/conversation-navigation.spec.ts:687`, `e2e/live-semantic-embedding.spec.ts:122`,
  `e2e/profile-silo.spec.ts:258`. The last two are byte-identical; the first carries
  the rationale comment (it failed "about one run in four under repetition").
- The **duplication is not closed** — there are now three copies, not two, and the
  constraint applies to a fourth exactly as written.

What closed the divergence: `live-semantic-embedding.spec.ts` was converted to the
converging form, which the source plan had listed under *What stays open* as
"still reads once and clicks once".

---

## 4. Do not make `RetrievalMode` per-search

**Measured:** it reads like the right seam — "a profile switch should take effect
on the next query, not the next file write" — and it silently un-anchors the
lineage receipt. `scoring` is stamped **once per generation**, printed to the
user, and sealed into the vault publication, while `generationDigest` does not
include it. Nothing downstream can detect the drift.

**Citations (VERIFIED, re-resolved — the whole tree moved from `src/context/` to
`src/indexing/`):**

| What | Original | Current |
|---|---|---|
| `scoring` stamped per generation | `client-context-engine.ts:822` | `src/indexing/client-context-engine.ts:833` |
| printed to the user | `context-view.tsx:487` | `src/ui/context-view.tsx:568` |
| `generationDigest` computed | `client-context-engine.ts:590-599` | `src/indexing/client-context-engine.ts:601-619` |

**Constraint:** if retrieval mode is ever wired, make it a property of the
generation, rebuild on change (no vector changes width, so it is only a re-embed),
and add it to the digest input.

**Status: LIVE, and still prospective.** `RetrievalMode` continues to have **zero
non-test consumers** — the only occurrences in `src/` are its own declaration at
`src/indexing/flat-index.ts:14` and the `FlatClientIndex` constructor default at
`:28`. Nothing has been wired, so nothing has been un-anchored yet.

---

## 5. Do not emit `retrievalMode: "hybrid"` unconditionally in the profile payload

**Measured:** every stored revision's digest was computed over a payload with no
such key, and `validateProfileCatalog` rebuilds and refuses a mismatch. An
unconditional emit **fails every profile in every existing encrypted catalog**
over a setting nobody changed.

**Citations (VERIFIED, re-resolved):** `validateProfileCatalog` is at
`src/profiles/persistence.ts:241`, called on every load and every save
(`:83, :92, :122, :156`) and on the conflict path at `:152`. The digest it rebuilds
against is `profileCatalogDigest` (`src/profiles/persistence.ts:215`), compared at
`:153`.

**Status: LIVE, and still prospective.** `retrievalMode` has **zero occurrences
anywhere in `src/`**. The refuse-on-mismatch mechanism is unchanged, so the
measurement still describes what would happen.

*The original entry named the emitting function `profilePayload`. No symbol by
that name exists in the tree at `03af2c5`; the constraint is about the digested
catalog payload generally, and `profileCatalogDigest` is the function that would
observe the change.*

---

## 6. Do not import from `src/indexing/` at runtime into `src/ui/access-view.tsx`

**Measured:** Rollup then emits a shared chunk **the release gate refuses to
classify**. This is why any picker copy must use a literal fenced by a test rather
than importing the constant.

**Mechanism (VERIFIED, current):** `scripts/release-gate.mjs:1393`,
`assertExclusiveArtifactClassifications` — it collects `unclassified` paths at
`:1402-1405` and `multiplyClassified` at `:1396-1401`, and **throws** at `:1408-1413`:

```
throw new Error(`JavaScript artifact classification failed:\n- ${failures.join("\n- ")}`);
```

**Status: LIVE, and currently respected.** `src/ui/access-view.tsx:52` imports
`LegacyRemoteEmbeddingModel` from the retired remote-embedding catalog — but as
`import type`, which is erased at compile time and emits no chunk. That is the
correct shape and the one this constraint permits. The original entry named
`LEGACY_REMOTE_EMBEDDING_MODEL`, a value export; **no symbol by that name exists in `src/`
at `03af2c5`**, so the specific import it warned against cannot currently be
written. The constraint generalises unchanged to any runtime import across that
boundary.

---

## 7. Do not use `safeProviderErrorMessage` in `access-view.tsx`

**Measured:** it is exported from `src/ui/provider-connections-view.tsx:575`, an
asset `app.tsx` loads **dynamically on purpose** (`void import(...)`). A static
import from `access-view.tsx` drags the deferred asset back onto the boot path.

**Constraint:** use `mapUnknownRequestFailure(caught, online).message`, already
used in that file.

**Status: LIVE, and currently respected (VERIFIED).** `safeProviderErrorMessage`
is still declared at `src/ui/provider-connections-view.tsx:575` and is referenced
outside that module only by its own test. `access-view.tsx` imports
`mapUnknownRequestFailure` from `./request-state` at `:32` and uses it at
`:697, :834, :912, :952, :981, :997` — **six sites**, not the five recorded when
the constraint was written.

---

## 8. Do not write an explicit `"inherit"` into `skillModes`

**Measured:** `"inherit"` is **inert** in `resolveSkillDecisions` and
**load-bearing** in `Object.hasOwn`. That combination is precisely how a removable
authored skill becomes **permanently undeletable**, with a refusal message that
names a profile which does not use it.

**Citation drift (VERIFIED):** the read is at `src/profiles/domain.ts:402` (was
`:372`):

```
const mode = args.skillModes[skill.skillId] ?? "inherit";
```

`resolveSkillDecisions` itself is at `src/profiles/domain.ts:394`. `SkillMode` is
declared at `src/profiles/domain.ts:48`. The `??` makes a stored `"inherit"`
indistinguishable from an absent key at the decision layer, while `Object.hasOwn`
sees a reference.

**Status: LIVE, and now pinned by a regression test.** `src/profiles/skill-authoring.test.ts:130`
carries the measurement in prose ("stored an explicit `"inherit"`, `Object.hasOwn`
counted it as a reference") and `:39` shows the correct write —
`if (mode === "inherit") delete skillModes[skillId];`. The constraint is enforced,
not merely documented. Two doc comments in the tree also cite it:
`src/profiles/catalog.ts:158` and `src/ui/app.tsx:11526`.

---

## 9. Do not document a `RELEASE_BUDGETS` entry with a `/** */` block

**Measured:** `parseDocumentedBudgets` reads `//` lines **only**. A block comment
parses as empty prose, and the placeholder survives a **green gate** — the
documentation guard reports success on an entry it never read.

**Citation drift (VERIFIED):** `parseDocumentedBudgets` is now at
`scripts/release-gate.mjs:1310` (was `:938-952`), called at `:1266`. The
comment-matching regex is at `:1319`:

```
const commentText = /^\s*\/\/ ?(.*)$/u.exec(line);
```

A `/** */` line matches neither this nor the budget-entry regex at `:1325`, so it
is skipped in silence.

**Status: LIVE.** The `//`-only parse is unchanged.

---

## 10. Do not assert the 44px floor outside a coarse-pointer guard

**Measured:** `page.setViewportSize({ width: 320 })` changes the **viewport**, not
the **pointer type**. A 44px floor asserted under a narrow viewport on a
fine-pointer project tests a rule that does not apply there.

**Status: LIVE, but the mechanism changed — copy the current guard, not the
original one.** The original entry said to copy the media-query guard from
`e2e/touch-target-floor.spec.ts:33`. At `03af2c5` that file guards at the
**project** level instead, `e2e/touch-target-floor.spec.ts:42`:

```
test.skip(({ isMobile }) => !isMobile, "the floor is a coarse-pointer rule");
```

with `const FLOOR = 44` at `:39`. The file's own header (`:8-9`) records the
measurement that produced the rule: `.popover__trigger` had `min-height: 44px`
under `(pointer: coarse)` and still **rendered 9×44** in the chat session bar at
390×844 — a correct-looking rule that a real measurement refuted.

*This spec was being edited in the working tree as this document was written —
the change adds the missing routes and writes this constraint's measurement into
the file's own header. Expect these line numbers to have moved; the guard
mechanism is what to copy, not the line.*

---

## 11. Do not put the `read_file` window notice at the tail of `content`

**Measured:** `boundToolResultContent` truncates the **tail** of a tool result, and
the notice is the **only** carrier of `nextOffsetBytes`, because `metadata` never
reaches the model. A trailing notice is therefore both the sole carrier of the
resume offset and the first thing deleted when the context budget bites — exactly
when the model most needs to know the read was partial.

**Citations (VERIFIED, re-resolved):**

| What | Original | Current |
|---|---|---|
| `boundToolResultContent` declaration | `agent.ts:664-668` | `src/core/agent.ts:886` |
| its call site | — | `src/core/agent.ts:588` |
| tool message built from `content` alone | `agent.ts:936-938` | `src/core/agent.ts:1226` |

`src/core/agent.ts:1226` is the evidence of the second half:

```
messages.push({ role: "tool", toolCallId: payload.callId, content: payload.content });
```

No `metadata` field is passed.

**Status: LIVE, and now encoded in the tree.** `src/tools/workspace-tools.ts:148-156`
carries the constraint as a doc comment ("The notice leads, and is never a
trailer") and `:157` implements it — the notice is prefixed, not appended.

> **Note for whoever owns `src/tools/workspace-tools.ts`** (not changed here; this
> document owns `docs/` only): that comment's own citations are **stale**. It cites
> `src/core/agent.ts:658-676` for `boundToolResultContent`, which now lands in the
> turn-failure `catch` block, and `:941-943` for the tool-message build, which now
> lands in `assertForkContextHistoryCompatible`. The correct lines are `:886` and
> `:1226`. The comment's *claim* is still true; only its pointers rotted.

---

## 12. Do not compile a path glob to a `RegExp`

**Measured:** it runs on the same thread as the agent, and one `exec()` **cannot be
interrupted**. `*a*a*a…*b` against a long non-matching path is a **frozen tab**.

**And the second half:** do not ship the segment-wise matcher without the
relative-pattern anchor — **measured, `src/**/*.ts` selects zero files without it.**

**Status: LIVE, and fully implemented — this constraint is now the tree's
design.** `src/workspace/content-search.ts:228-230` states it in the code:

> *Compile a path glob to a predicate, segment by segment and without a RegExp.
> This runs on the agent's own thread, and one `RegExp.exec` cannot be
> interrupted.*

The anchor is at `:240-246`, with its own measurement preserved (`:243`, "Measured:
`src/**`, …"):

```
const anchored = raw[0] === "" || /^\*\*+$/u.test(raw[0] ?? "") ? raw : ["**", ...raw];
```

The matcher itself is the two-pointer walk at `:297-313`. The user-facing
explanation of the grammar is at `src/tools/workspace-tools.ts:304`.

---

## 13. Do not write a check whose failure mode is indistinguishable from success

**This is the companion entry, and it is the general form of the other twelve.**

**Measured:** a NUL-byte scan was specified as `grep -rlP` for the byte.
**BSD grep has no `-P`.** On macOS it exits non-zero printing a usage message,
produces no output, and **reads exactly like a clean result**. A real byte scan —
written in Python, comparing bytes — then found **three literal NUL bytes in
`src/ui/tabs.tsx` immediately**, used as a join separator and written as raw bytes
instead of the ``\u0000`` escape.

Two things compound it. A source file containing a NUL **diffs as binary**, so any
change to it is invisible to review. And the flawed scan was written into the very
brief that warned against gates which measure nothing.

> **A check that reports success by failing is the same defect as a gate that
> measures nothing.**

**Constraint:** a check must be able to distinguish "ran and found nothing" from
"did not run". Assert on the exit status you expect *and* on evidence the check
executed — a count, a file list, a probe of a known-positive case. Prefer a scan
that reads bytes over a regex flag whose availability varies by platform.

**Status: LIVE.** The scan is now a byte scan in Python. At the time of the
recovering commit the recorded state was: no source file under `src/` contains a
NUL.

---

## Cross-references

The register that recovered these — `docs/audit/RECOVERED_WORK_REGISTER_2026-08-04.md`
§3.19 — cites the load-bearing ones inline against specific findings: #1/#2 for
flake latching, #4/#5 for the retrieval-mode digest, #6 for shared-chunk
classification, #7 for the dynamic-import boundary, #8 for the undeletable
authored skill, #9 for `//`-only budget parsing, #10 for coarse-pointer, #11 for
tail-truncated window notices, #12 for glob-to-RegExp.

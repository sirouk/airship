# Canon versus subsystem documentation — thirteen contradictions

## Status: FINDINGS. Nothing here has been decided or applied.

| | |
|---|---|
| **Original written at** | `3f11393`, on 2026-08-03, as §5 of a canon reconciliation report |
| **Recovered and committed** | 2026-08-04. Spot-checked against `03af2c5` |
| **Recovered from** | `CANON-FULL-REPORT.md`, which lived only in a temp directory |

### Why this was lost

A seven-agent documentation-classification fan-out logged **"classified 0 docs,
0 contradicting canon"** and the hand-written section — thirteen contradictions,
each adjudicated on tree evidence — was never merged. The automated pass reported
a clean result it had not earned, and the human result went in the bin with it.
It is a companion case to the constraint in
`docs/engineering/MEASURED_NEGATIVE_CONSTRAINTS.md` §13: a check that produces
nothing and reports success is indistinguishable from a check that ran.

---

## How to read this document

Each entry below carries a **verdict** — a judgement about which of two
disagreeing documents the tree supports. **Every verdict is a finding awaiting a
decision. None of them is a decision.**

**DO NOT BULK-APPLY THIS DOCUMENT.** Three reasons, in order of how much damage
each would do:

1. **Seven of the thirteen conclude that canon is already RIGHT** — §5.1, §5.2,
   §5.3, §5.4, §5.9, §5.11, §5.12. For these the action, if any, is to the
   *subsystem* document, and in two cases (§5.3, §5.12) the losing document has
   already conceded in its own text. Applying anything to canon here would be
   editing the correct side.

2. **§5.6 is an open question nobody has answered.** It ends *"Canon takes no
   position on this; it should."* There is nothing to apply. Writing a verdict
   into canon there **invents policy** — it manufactures a product decision about
   a third-party OAuth grant out of an audit note. That decision belongs to
   whoever owns the product claim, made deliberately, not to whoever next runs a
   reconciliation script.

3. **The verdicts were reached at `3f11393`, 47 commits ago.** Line numbers have
   moved. Some of the underlying code has moved between directories. Re-derive
   before acting.

### Verdict distribution

| Verdict | Entries |
|---|---|
| **Canon is correct; a subsystem doc is wrong** | §5.1, §5.2, §5.3, §5.4, §5.9, §5.11, §5.12 — **7 of 13** |
| **The tree is correct; canon and the doc are both behind** | §5.7 |
| **The executable gate is correct; a doc is stale** | §5.5 |
| **The shipped artefact is correct; the doc overstates** | §5.10 |
| **Canon has a coverage gap — an under-claim, not a contradiction** | §5.8, §5.13 |
| **Open question — canon takes no position and should** | §5.6 |

Note the shape of that table: the largest single group is *canon was right*, and
the second-largest is *canon under-claims what actually ships*. Only one entry
finds canon overstating anything. An automated pass that "corrects canon" against
these findings would move the document in the wrong direction most of the time.

### What was spot-checked against `03af2c5`

Seven of the thirteen were re-derived for this commit; each is marked inline.
The other six — §5.2, §5.3, §5.9, §5.11, §5.12, and the RELEASE_GATE half of
§5.5 — are **carried forward unchecked** from `3f11393`.

### Related

- `docs/audit/CANON_VERIFICATION_2026-08-03.md` — the 149-finding re-check, with
  its own derivation header. Its §2.12 reaches the same conclusion as §5.6 here.
- `docs/audit/RECOVERED_WORK_REGISTER_2026-08-04.md` §3.20 — the register entry
  that identified this section as lost, and the source of the do-not-bulk-apply
  instruction above.
- `docs/CANON.md` is bound to `3f11393` and is **47 commits behind** as of
  2026-08-04. See the drift note in the register. Reconciling canon is a separate,
  larger job and is explicitly not what this document does.

---

## The thirteen

**5.1 Storage authority — FINDING: canon is correct.** docs/CONTEXT_FABRIC.md:5-7 names "the selected encrypted `ObjectStore` — Google Drive by default, S3-compatible storage as an advanced adapter, or page memory while Ephemeral" as the authoritative substrate, omitting the encrypted Local Device Vault entirely. docs/EDGE_RUNTIME_CAPABILITY_LADDER.md:84 goes further: "S3 is authoritative. Optional device persistence stores only ciphertext…". Canon supersedes both at docs/CANON.md:1302-1307 and lists the Local Device Vault with OPFS/IndexedDB **authority** as implemented at :1043-1044. The tree sides with canon: src/vault/local-device.ts and src/storage/local-device-object-store.ts provide it, and src/ui/platform-shell.tsx:463-469 makes local-device the ordinary default when no deployable Google client is configured. **Fix the two subsystem docs.** (But see 2.7 — canon's own S3 rung still needs the loopback qualifier.)

> **[RE-DERIVED 2026-08-04 — holds.]** `resolveDefaultVaultBackend`
> (`src/ui/platform-shell.tsx:463-468`) still falls back to `local-device` unless a deployable
> Google client id is configured. **Action, if taken, is to the two subsystem docs — not canon.**

**5.2 "Google Drive is the preferred/default vault" — FINDING: canon is correct, and both documents already refute their own ledes.** *(carried forward unchecked)* docs/GOOGLE_DRIVE_VAULT.md:5 vs its own tail at ~:223-234 ("the published Pages artifact currently defaults to the Local Device vault"); docs/MASTER_PROMPT_ACCEPTANCE.md:84 titles a row "Implemented" while its body concedes the same. Canon: docs/CANON.md:561 and :1302-1307. Code: src/ui/platform-shell.tsx:463-469.

**5.3 Mobile navigation and destination count — FINDING: canon is correct, and canon names the loser.** *(carried forward unchecked)* docs/AIRSHIP_DESIGN_BLUEPRINT.md:17 locks "exactly five fixed tabs: Chat · Sessions · Workspace · Trust · More" and :20 locks "all 11 destinations"; docs/CANON.md:1285-1288 supersedes with four controls, and the tree ships them (src/ui/mobile-navigation.tsx:77-85). Already a resolved contradiction — the blueprint's own header (:3) cedes.

**5.4 Product vocabulary — FINDING: canon is correct.** docs/DESIGN_LANGUAGE.md:36 names four mobile views "Chat, Workspace, Sources, Proof" and :23 lists "Sources… Funding" as product copy. Canon: docs/CANON.md:292-294 and :1298-1299 ("Source Control is integrated into Workspace → Editor… `#sources` is only a compatibility alias"), implemented at src/ui/navigation-model.ts:401 (`if (candidate === "sources") return "editor";`). "Funding" has zero occurrences in src/ui/*.tsx; canon names that surface **Account** (docs/CANON.md:305). The visual-system half of DESIGN_LANGUAGE stays authoritative — its token claims verify (src/ui/tokens.css:178, src/ui/token-vocabulary.test.ts:194-198).

> **[RE-DERIVED 2026-08-04 — holds.]** `src/ui/navigation-model.ts:401` is still exactly
> `if (candidate === "sources") return "editor";`.

**5.5 Release budgets — FINDING: the executable gate is correct; `docs/RELEASE_GATE.md` is stale and breaks its own rule.** RELEASE_GATE.md:64-66 declares the table mirrors `scripts/release-gate.mjs` and must be updated in the same change. It is not: entry JS gzip doc 110 KiB vs scripts/release-gate.mjs:24 = 112 KiB; initial+preloads 640/132 vs :75 = 768/176; first-party 1,768/462 vs :273 = 2036/646; total backstop 2,152/643 vs :353 = 2713/834; entry CSS 160/32 vs :763 = 171/32. Related: docs/BROWSER_EXECUTION_PACKS.md:503 cites a "226 KiB application-JavaScript gate" that exists nowhere in the script, and docs/EDGE_RUNTIME_CAPABILITY_LADDER.md:174 and docs/RELEASE_GATE.md:66-68 both claim to host a 224 KiB figure.

> **[RE-DERIVED 2026-08-04 — holds, and the drift has grown.]** `docs/RELEASE_GATE.md:41`
> still documents 384 KiB / **110 KiB** for HTML-referenced entry JavaScript;
> `scripts/release-gate.mjs:35` now reads `entryJavaScript: … raw: 384 * 1024, gzip: 113 * 1024`.
> When this entry was written the gate said 112 KiB. The document has not tracked it through
> two moves. The remaining four rows of this entry were **not** re-checked.

**5.6 OpenAI OAuth descriptor — OPEN QUESTION. Do not apply a verdict here.** docs/PROVIDER_FABRIC.md:57 and docs/EXTENSION_BRIDGE.md:39 say no reviewed third-party grant is published; src/inference/providers/official-providers.ts:22-25 ships `state: "configured-public-pkce"` with the detail "Airship ships OpenAI's own Codex client with product-owner approval", rendered verbatim to the user at src/ui/provider-fabric-panel.tsx:239, backed only by an asserted review record (official-providers.ts:62-66, `openai-codex-live-cors-2026-07`). The docs' *"UI remains unavailable"* half is still true — src/ui/provider-fabric-panel.tsx:228 resolves only an `api-key` method for cloud providers. **Judgement: the user-visible approval sentence is the weaker link, not the docs.** Canon takes no position on this; it should.

> **[RE-DERIVED 2026-08-04 — the code is unchanged.]** `state: "configured-public-pkce"` at
> `src/inference/providers/official-providers.ts:23`; the "product-owner approval" sentence at
> `:25`.
>
> **This entry has no applicable verdict.** It ends by observing that canon takes no position
> and should. Writing one invents product policy. The narrower, decidable question — whether
> the user-visible sentence overclaims — is tracked as a code change in
> `docs/audit/CANON_VERIFICATION_2026-08-03.md` §2.12, which also records that
> `provider-catalog.ts` throws if `state` is changed.

**5.7 Memory graph renderer — FINDING: the tree is correct; the doc is wrong.** docs/MEMORY_RELATIONSHIP_GRAPH.md:7 and :19 specify Sigma.js v3.0.3 + Graphology v0.26.0 via dynamic import; neither appears in src/memory-graph/ or package.json. The shipped surface is a bespoke canvas renderer (src/memory-graph/canvas-renderer.tsx:171, lazily loaded at src/memory-graph/renderer.tsx:30-33), which also makes the WebGL-fallback paragraph at :20 obsolete. Everything else in that doc verifies exactly (all ten device limits against src/memory-graph/derive.ts:22-34).

> **[RE-DERIVED 2026-08-04 — holds.]** `grep -in 'sigma|graphology' package.json` returns
> nothing. The dependency the document specifies is not in the project.

**5.8 Local model providers — FINDING: canon under-claims. A coverage gap, not a contradiction.** docs/LOCAL_MODEL_PROVIDERS.md governs a shipped Ollama/LM Studio adapter (src/inference/local/endpoint-policy.ts:39-52). Canon never mentions either, and §17's implemented ledger (docs/CANON.md:1052-1054) enumerates only the Chutes connection. Add them.

> **[RE-DERIVED 2026-08-04 — holds.]** `grep -in 'ollama|lm studio' docs/CANON.md` returns
> nothing. Canon still does not mention either adapter.

**5.9 Capability tiers — FINDING: canon is correct.** *(carried forward unchecked)* docs/PRODUCT_SPEC.md:257-263 lists "Native shell" and "Remote sandbox" in a status-free table alongside two shipped browser tiers; docs/CANON.md:1122-1124 puts those under Explicitly not promised. PRODUCT_SPEC's own non-goals (:283-290) agree with canon.

**5.10 CSP allowlist — FINDING: the shipped policy is correct; the doc overstates.** docs/STORAGE_CONFORMANCE.md:59-60 claims "Airship's public default CSP allowlists only Chutes and the current Shelbynet API"; public/_headers:2 and index.html:19 allowlist api/llm.chutes.ai, auth/api.openai.com, api.anthropic.com, api.x.ai, twelve loopback origins, api.github.com, raw.githubusercontent.com, api.shelbynet.shelby.xyz, pccs.phala.network, registry/cdn.wasmer.io and three Google origins. The load-bearing part (byte-aligned policies, no wildcard) still holds.

> **[RE-DERIVED 2026-08-04 — holds, and the gap has widened.]**
> `docs/STORAGE_CONFORMANCE.md:59` still reads "allowlists only Chutes and the current
> Shelbynet". The served policy is now maintained in **three** byte-aligned places —
> `public/_headers`, `index.html`, and the `Caddyfile` (see `docs/DEPLOYMENT.md` trap #2) —
> and `./deploy.sh --verify` was run at `03af2c5`: **all three agree.** The allowlist itself
> has moved since this entry was written; `2989e70` removed a host the app no longer calls.

**5.11 Fork semantics — FINDING: canon and the tree are correct.** *(carried forward unchecked)* docs/VOICE_REVIEW_DISTILLED_2026-07-28.md:68 asks that "a fork copies the full eligible history"; docs/CANON.md:1015-1016 specifies digest-sealed bounded ancestor context instead, and src/sessions/session-fork.ts:136 sets `historyCopied: false` (typed as the literal `false` at src/sessions/library.ts:61, explained to the user at src/ui/sessions-view.tsx:1276). Canon pre-scopes this at :1272-1276; no action beyond not treating line 68 as a requirement.

**5.12 DCAP verifier — FINDING: canon is correct.** *(carried forward unchecked)* docs/FERRARI_AUDIT.md P0-05 (~:97) asserts "Current live UI explicitly has no DCAP verifier"; docs/CANON.md:1052-1054 lists local Intel DCAP verification as implemented, and the tree carries crates/dcap-qvl-wasm/ with budget entries at scripts/release-gate.mjs:728-729. FERRARI_AUDIT's own delta at :20-22 partially corrects itself.

**5.13 `airship-sh` — FINDING: canon under-records a shipped capability.** docs/MASTER_PROMPT_ACCEPTANCE.md:53 records a first-party POSIX-sh interpreter; it is real (src/execution/shell/ with interpreter.ts, lexer.ts, parser.ts, expansion.ts, arithmetic.ts, script-suite.test.ts) and registered at src/execution/runtime-registry.ts:29, :67-68 with the comment "a POSIX-sh-compatible interpreter, never GNU Bash". Canon §12.3 (docs/CANON.md:760-773) and §17 (:1029-1031) list JavaScript, WASI, Pyodide, WebContainer and the workspace-program worker and never mention it. **Add it to §17 Implemented.** Related: canon has no home for FERRARI_AUDIT P0-01 (the Rust kernel decision) in either Planned or Explicitly-not-promised.

> **[RE-DERIVED 2026-08-04 — holds.]** `grep -n airship-sh docs/CANON.md` returns nothing.
> **Caution on the related note:** this entry says canon has no home for FERRARI P0-01. At
> `03af2c5` the FERRARI P0-01 *gate* does not exist in `scripts/` either — see the §4 note in
> `docs/audit/CANON_VERIFICATION_2026-08-03.md`. Establish what the artefact is before giving
> it a canon entry.

---

---

## Next step

Triage, entry by entry, with an owner and a decision recorded per entry. The
decidable ones are the four where a subsystem document is factually wrong about
the tree: §5.1, §5.5, §5.7, §5.10. The two under-claims (§5.8, §5.13) are canon
additions and belong with the larger canon reconciliation, not here. §5.6 needs a
product decision before any document changes.

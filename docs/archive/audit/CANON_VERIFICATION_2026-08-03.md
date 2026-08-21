# Canon verification — the polish worklist, re-derived

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../SIMPLIFICATION.md`](../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

## Derivation header (read this before any row below)

| | |
|---|---|
| **Original written at** | `a8c777a` — *"canon: land the release control, the human-journey audit, and a truthful canon"* |
| **Original method** | six read-only verifiers re-checked **149 claimed-open findings** from a committed inventory; a seventh synthesised the survivors |
| **Original result** | **82 confirmed · 29 partial · 31 false positives · 7 unverifiable** — a **21% outright error rate**, 40% wrong-or-overstated |
| **This document derived at** | `03af2c5`, on 2026-08-04 — **43 commits after `a8c777a`** |
| **Recovered from** | `wf_4b52d8c4-84a/agent-a692018cb8b4f13bf.jsonl`, which lived only outside the repository |

### Why this document is not committed verbatim

The original was a re-check of an inventory whose defect was **acting on stale
citations**. Committing that re-check unqualified, 43 commits later, reproduces
exactly the failure it exists to correct. So:

**Every row below is evidence about the tree at `a8c777a` unless it carries a
`[RE-DERIVED 2026-08-04]` marker.** Rows without that marker were **carried
forward unchecked**. Treat an unmarked citation as a lead, not a fact.

**Do not act on any row without re-deriving its evidence first.** That was the
original document's own top-line instruction and it applies with more force now,
not less.

### What was personally re-derived for this commit

Twenty-one checks were run against `03af2c5`. Each is marked inline. Summary:

**Closed since `a8c777a` — the finding no longer holds:**

| Row | What closed it |
|---|---|
| §2.1 `read_file` has no offset/limit | schema now carries `offset` + `maxBytes` (`src/tools/workspace-tools.ts:112-113`); partial reads lead with a notice |
| §2.2 `search_text` has no cursor | `cursor` in the schema (`:259-262`), `nextCursor` returned in `content` (`:320`) |
| §2.3 no answer names its model | `src/ui/app.tsx:12622-12624` renders `message.receipt.model`, read from the receipt and not the active binding, exactly as the row's blind-risk note required |

**Still open, citations corrected:**

| Row | Correction at `03af2c5` |
|---|---|
| §2.4 chip has no accessible name | still open — the receipt chip button at `src/ui/app.tsx:12620-12637` still has no `aria-label` and still concatenates the Seal's name with the bare tail-8 span at `:12636` |
| §2.9 native `window.confirm` | still four sites, all moved: `src/ui/app.tsx:4038, :12853, :12903` (was `:3959, :12596, :12646`) and `src/ui/platform-overlays.tsx:204` (unchanged). `NATIVE_CONFIRM_HOLDOUTS` is now **two** entries — `app.tsx` *and* `platform-overlays.tsx` (`src/ui/destructive-confirm-contract.test.ts:20-25`), and the equality assertion is at `:42` |
| §2.22 vector search recomputes norms | the **defect is still open** — `cosine()` at `src/indexing/flat-index.ts:84-94` still recomputes both norms per chunk. But its stated precondition is **closed**: `src/indexing/flat-index.test.ts` now exists (5.2 KB), and the file is 96 lines, not 68 |
| §2.23 idempotency key never sent | still open — no idempotency header in `src/inference/chutes/transport.ts` |
| §2.12 OpenAI card overclaims | still open — `state: "configured-public-pkce"` at `src/inference/providers/official-providers.ts:23` and the "product-owner approval" sentence at `:25`, unchanged |

**§4 citations that no longer resolve as written:**

| §4 row | Status at `03af2c5` |
|---|---|
| "`javascript:alert(1)` … `authorization-code-paste.ts:163` rejects any scheme prefix" | **citation dead, claim intact.** The file exists; line `:163` is now a blank line between functions. The scheme rejection is `readBareCode` at `src/ui/connect/authorization-code-paste.ts:164-175`, with the `javascript:alert(1)` measurement preserved in its comment at `:165-168` |
| "do not delete the FERRARI P0-01 gate" | **the referenced gate is not in `scripts/` at all.** `grep -rn FERRARI scripts/` returns nothing; the string survives only in `docs/gap-audit/git.md`, `docs/audit/CANON_RECONCILIATION_2026-08-03.md` and the recovered-work register. There is no gate to preserve or delete — the row is advice about an artefact that does not exist here |
| "the cap is `176 * 1024` at `release-gate.mjs:75`" | **line moved.** `176 * 1024` is now the gzip half of `allJavaScriptAndWorkers` at `scripts/release-gate.mjs:86`. `:75` is prose in a comment — which is the same confusion the row was written to correct, now one commit further on |
| "Georgia … bound in **eleven** places in `routes.css`" | **still exactly eleven** (`src/ui/routes.css:310, 721, 1131, 1181, 1521, 1700, 1796, 1832, 1844, 2144, 2827`); a twelfth Georgia occurrence at `:4454` is a comment. Two of the eleven have moved since the recovered-work register cited them (`:2136`→`:2144`, `:2819`→`:2827`) |
| "`authorization-code.ts:217-228`" (origin check) | **file moved but the claim holds.** It is `src/auth/provider-oauth/authorization-code.ts`; the `pasted.source === "redirect-url"` origin comparison is present with its placement rationale immediately above it |
| "`tokens.css:133-140`" (the ramp) | **resolves exactly.** `--fs-micro` through `--fs-hero`, eight steps |
| "off-by-one copy count" | the egress guard is called **quadruplicated** in §5b and **triplicated** in the recovered-work register §3.18. At `03af2c5` the four named files all exist and `src/execution/workspace-egress.ts` still does not, so **four** is the correct count and the register's three is the error |

### What was NOT re-derived

Everything else. In particular: all of §2's items 5-8, 10-11, 13-21; all of §3;
the remaining ~26 rows of §4; and all of §5. Those are carried forward from
`a8c777a` unchanged and unchecked.

Two structural cautions the original itself raises, which still apply:

- **Every `docs/CANON.md` line number in the underlying reconciliation is off by
  roughly 20-40 lines**, because CANON.md was rewritten in `cff08de`/`a8c777a`
  after the `3f11393` baseline it was checked against. CANON.md is now **47
  commits** past that baseline — see the drift note in
  `docs/audit/RECOVERED_WORK_REGISTER_2026-08-04.md`.
- The three failure modes in §1 below produced almost all of the 21% error rate,
  and they will bite the same way if you work any inventory directly.

### Companion documents

- `docs/audit/CANON_CONTRADICTIONS_2026-08-03.md` — the thirteen canon-versus-subsystem
  contradictions, findings only, not decisions.
- `docs/engineering/MEASURED_NEGATIVE_CONSTRAINTS.md` — the constraints that say what
  *not* to do, each with the measurement that killed it. Several of the blind-risk
  notes below are the same constraints in a different voice.

---

## The worklist as written at `a8c777a`

> Everything from here to the end of the document is the original text.
> Rows carrying a `[RE-DERIVED 2026-08-04]` marker were personally re-checked
> against `03af2c5`; every other row is carried forward unchecked.

## 1. What the re-check changed

**31 of 149 claimed-open findings (21%) are false positives — working code the previous inventory reported as broken.** Another 29 (19%) are only partially open, usually because the mechanism shipped under a different name than the one the reviewer grepped for. **Four in ten entries in that inventory are wrong or overstated.**

Three failure modes produced almost all of it, and they will bite you the same way if you work the inventory directly:

- **Read the named file and stopped.** `provider-oauth-core.md` #3 claimed the pasted-redirect origin is unchecked at `authorization-code.ts:129-148`; the check is at `authorization-code.ts:217-228`, deliberately in the binding step, pinned by 14 passing tests. Same shape at `wasi-artifact-channel.md` issue 5 (`execution-tools.ts:1308-1312` returns, does not throw) and `DESIGN_DIRECTION` conflict 9 (looked in `styles.css`, which is a 32-line `@import` barrel).
- **Grepped for the proposed name, not the mechanism.** `tool.md` #1 grepped `execute_shell_command` and missed shipped `execute_shell` (`src/tools/execution-tools.ts:617-644`). `inference.md` #2 grepped `context.transferred`/`forkWithRoute`/`carryContext` and missed `FORK_CONTEXT_EVENT_TYPE` (`src/core/fork-context.ts:12`) and five of six shipped fix steps.
- **Stale citations throughout.** Every `docs/CANON.md` line number in the reconciliation is off by roughly 20-40 lines — CANON.md was rewritten in `cff08de`/`a8c777a` after the `3f11393` baseline it was checked against. Following those citations lands you in the wrong section (`PRODUCTION_READINESS`'s cited `CANON.md:1062-1064` is an *Implemented* bullet about the Profile cockpit).

Practical consequence: **do not act on any inventory row without re-deriving its evidence.** Sections 2-5 below are the re-derived set.

---

## 2. Fix these first — user-facing and bounded

All CONFIRMED_OPEN, all `one-line` or `bounded`, ranked by user impact.

### Breaks a user journey

**1. `read_file` has no offset/limit and hard-fails past 1 MiB with no partial content**
> **[RE-DERIVED 2026-08-04 — CLOSED]** `src/tools/workspace-tools.ts:112-113` now declares
> `offset` and `maxBytes`; the partial-read notice **leads** the content (`:157`) with the
> reasoning at `:148-156`, and `nextOffsetBytes` is reported. Implemented as the row's
> blind-risk note required.
`src/tools/workspace-tools.ts:95-105` declares `properties: { path: { type: "string" } }` only; `:108-109` calls `workspace.read(path)` whole; `:117` returns `file.content` entire. `src/tools/registry.ts:149-151` then throws *after* the read when output exceeds `MAX_TOOL_OUTPUT_BYTES` (`:15`, 1 MiB). `readBounded` exists and is used at `workspace-tools.ts:236-237` but `read_file` never calls it.
**Fix:** extend the schema to `{path, offsetBytes, maxBytes (default 262144)}`; clamp inside `read_file`; return `{offsetBytes, returnedBytes, truncated, nextOffsetBytes}` **in `content`**, not only metadata; slice on a UTF-8 boundary.
**Blind risk:** do not gate the clamp on `workspace.readBounded` existing — `GitSynchronizedWorkspace.readBounded` (`src/tools/git-synchronized-workspace.ts:18-21`) delegates to `read` when the inner port lacks it, so the method is present on the wired workspace and returns the whole file anyway. Do not convert the `registry.ts:149-151` throw into silent truncation: `list_files`, `stat_path` and `search_text` emit JSON as content, and clamped JSON reads as authoritative and malformed.

**2. `search_text` scans only the alphabetically first 512 files, and the truncation is invisible to the model**
> **[RE-DERIVED 2026-08-04 — CLOSED]** `cursor` is in the schema at
> `src/tools/workspace-tools.ts:259-262`, threaded to `searchWorkspaceContent` at `:295`,
> and `nextCursor` is returned in `content` at `:320`. The unification the row warned about
> also happened: `src/workspace/content-search.ts` now owns the scan.
`src/tools/workspace-tools.ts:14` `MAX_SEARCH_FILES = 512`; `:222-223` slices; `:258-262` computes truncation into `metadata`; `:265` `content` says only "No matches for … under …". The model never sees metadata.
**Fix:** add `cursor` to the schema (`:193-204`); drop entries with `path <= cursor` (both backends return `localeCompare`-sorted lists); return `nextCursor` **in `content`**.
**Blind risk:** any include/exclude filter must be applied *before* the `:223` slice or it reaches nothing. Improving `metadata.truncated` alone is a no-op. A second scan now exists at `src/workspace/content-search.ts` whose header (`:5-12`) claims the scan is "stated once" — it is not; `workspace-tools.ts` still owns its own limits and its own `collectLiteralMatches` (`:517`). If you unify them, note `content-search.ts:22` caps results at 50 while `workspace-tools.ts:17-18` allows 200.

**3. No answer on screen says which model produced it**
> **[RE-DERIVED 2026-08-04 — CLOSED]** `src/ui/app.tsx:12622-12624` renders
> `message.receipt.model`, guarded on presence, with a doc comment at `:12608` stating
> "Read from `message.receipt.model`, never from the active binding" — the row's blind risk,
> encoded.
`src/ui/app.tsx:12336-12344` renders `<strong>Airship</strong>` plus `Initial · {capabilityTierLabel(...)}` and nothing else; the receipt chip at `:12379` renders `receiptId.slice(-8)`. `receipt.model` exists (`app.tsx:7977`) but is rendered in exactly one place: `src/ui/proof-inspector.tsx:183`.
**Fix:** render `message.receipt.model` next to the role word at `app.tsx:12336-12344`, reusing the compact label helper at `app.tsx:11583`. Keep `Initial · {tier}` verbatim.
**Blind risk:** do **not** read the currently active binding (`activeInferenceBinding.modelId`, `app.tsx:2311`) — that relabels every historical turn with whatever is pinned now. `receipt.model` is optional (`app.tsx:7951` guards it); render nothing rather than "unknown model" when absent.

**4. Receipt/attestation chips have no accessible name of their own and swallow the whole tooltip essay**
> **[RE-DERIVED 2026-08-04 — STILL OPEN]** Line numbers moved. The receipt chip button is
> `src/ui/app.tsx:12620-12637`, still with no `aria-label`; the `<Seal>` supplies the name and
> the bare `<span>{message.receipt.receiptId.slice(-8)}</span>` at `:12636` still follows it
> with no separator. The attestation chip has the same shape at `:12638-12646`.
`src/ui/app.tsx:12372-12380`: the button has no `aria-label`, so its name is the Seal's `aria-label` (`src/ui/seal.tsx:83`, `${label}. ${detail}`, where `detail` is the full `receiptSummary` sentence from `app.tsx:13022-13025`) immediately concatenated with the bare `<span>{…slice(-8)}</span>` at `:12379` — no separator. Same shape at `:12385-12392`.
**Fix:** explicit `aria-label` on the two chip buttons ("Receipt c43f0a78, encrypted, opens Proof"), prose moved to `aria-describedby` on a visually-hidden node; `aria-hidden` the Seal **at this call site only**.
**Blind risk:** do not `aria-hidden` inside `seal.tsx` — `src/ui/seal.tsx:88-94` gives it `role="img"` and it is used standalone elsewhere where that name is the only text. Do not delete `title={detail}` (`seal.tsx:92`); that is the sighted hover affordance the same finding asked to keep.

**5. The semantic pack is never published, and even if it were it would 404 under the Pages base path** *(two edits, must land together)*
`scripts/semantic-pack-assets.ts` registers `install()` under `configureServer` (`:37`) and `configurePreviewServer` (`:40`) only — no `generateBundle`/`writeBundle`/`emitFile` in the whole 64-line file; `dist/` has no `semantic-pack`. Separately `src/indexing/semantic-transformers-loader.ts:9` is `const PACK_ROOT = "/semantic-pack/v1/"` while `public/sw.js:100` already uses `scopedPath("semantic-pack/v1/")` and `.github/workflows/pages.yml` builds with `AIRSHIP_PUBLIC_BASE_PATH=/airship/`.
**Fix:** `PACK_ROOT = \`${import.meta.env.BASE_URL}semantic-pack/v1/\`` at `:9`; add a `generateBundle()` modelled on `scripts/pyodide-assets.ts`, behind an opt-in env flag.
**Blind risk (this one is a CI landmine):** emitting into `dist/` fails the release gate twice — `release-gate.mjs:262` classifies every `.js/.mjs` under dist except sw.js/pyodide, so `transformers.web.js` (1,086,262 B) and four ORT `.mjs` files become unclassified and blow `totalJavaScriptAndWorkers`; `:254` excludes only pyodide from `wasmFiles`, so `ort-wasm-simd-threaded.wasm` (12.5 MB) and `.jsep.wasm` (25.4 MB) blow `eachWasm`/`allWasm` (1 MiB, `:613-616`). An `isOptionalSemanticPackPath()` exclusion must land in the same change. And moving `PACK_ROOT` breaks three tests (`semantic-transformers-loader.test.ts:115-116, :235-236, :239`) **and** a security boundary — the script-URL policy throws for anything not matching `/semantic-pack/v1/runtime/` (`docs/SEMANTIC_EMBEDDING_PACK.md:111`); move the allowlist to the same `BASE_URL` expression or the pack ships and is refused.

**6. Files skipped by ignore rules during repository seeding are announced only to `console.warn`**
`src/git/workspace-adapter.ts:1062-1065` says "the omission is announced instead of being inferred from an empty status"; `ignored` is computed at `:1068` and used only in the `console.warn` at `:1070-1072`. The `RepositoryRecord` at `:1050-1058` has no field for it. The user sees an empty status with no explanation.
**Fix:** add `ignoredAtSeed: readonly string[]` to what the seed path returns and surface it once in Source Control next to the empty status. If no surface is wanted, change the comment to say *logged*.
**Blind risk:** do not remove the ignore matching or force-add the paths — a seeded `.gitignore` legitimately excludes seeded files. The warn truncates at 20 paths (`:1071`); an unbounded UI list can be seeded with thousands. `.git/info/exclude` is written at `:1076` only for `/workspace`, so the ignored set differs by repository root.

### Degrades the experience

**7. The phone type scale is the desktop scale verbatim**
Every `--fs-*` step is declared once at `src/ui/tokens.css:133-140`; `--type-scale` is set only at `:87, :362, :366, :370, :374`, all keyed on the user-preference attribute, never a media query. `src/ui/routes.css:2695` puts `.mobile-nav__tab` on `--fs-micro` (11.69px), still under the 12px floor.
**Fix:** one `@media (max-width: 640px)` block in `tokens.css` re-declaring the ramp with `max(px, calc(rem * var(--type-scale)))` — the pattern already established for `--fs-field` at `tokens.css:152`.
**Blind risk:** hard-coded px breaks WCAG 1.4.4 and the rule stated at `tokens.css:130-132`, and freezes the Type-scale preference on phones. Raising `--fs-micro` moves 402 call sites; `src/ui/density-contract.test.ts` and `src/ui/type-floor.test.ts` pin the inventory.

**8. Touch-target floor sweep misses four routes, and the Terminal controls are already undersized**
`e2e/touch-target-floor.spec.ts:25-28` enumerates ten routes; `src/ui/navigation-model.ts:3-16` declares fifteen — terminal, context, capabilities, skills are never measured. `docs/design-review/screen-reviews.md:16` measures Terminal Interrupt/Restart/Close at 95x30, 80x30, 65x30.
**Fix, in this order:** raise the Terminal controls to 44px, *then* add the four routes to `ROUTES`.
**Blind risk:** the spec header at `:18-21` forbids an allowlist ("An allowlist of known-small controls is how a floor becomes a suggestion"), so adding routes plus exceptions is exactly what it was written to prevent. The Terminal bar already wraps to three lines at 390px; raising three 30px controls without collapsing the bar pushes the emulator further down a viewport that starts it at y=372 of 632.

**9. Native `window.confirm` still guards four destructive actions**
> **[RE-DERIVED 2026-08-04 — STILL OPEN, all citations moved]** The four sites are now
> `src/ui/app.tsx:4038` (draft discard), `:12853` ("Remove …"), `:12903` (dirty profile-card
> switch) and `src/ui/platform-overlays.tsx:204`. **The fix instruction below is now wrong:**
> `NATIVE_CONFIRM_HOLDOUTS` holds **two** entries, `app.tsx` and `platform-overlays.tsx`
> (`src/ui/destructive-confirm-contract.test.ts:20-25`), so deleting only `'app.tsx'` leaves
> the second holdout in place. The equality assertion is at `:42`.
`src/ui/app.tsx:3959` (draft discard), `:12596` ("Remove ${selected.name}…"), `:12646` (dirty profile-card switch), plus `src/ui/platform-overlays.tsx:204`. `ConfirmDialog` exists at `src/ui/confirm-dialog.tsx` and is adopted by five other views.
**Fix:** adopt `ConfirmDialog` at the three `app.tsx` sites and delete `'app.tsx'` from `NATIVE_CONFIRM_HOLDOUTS` in the same commit (`src/ui/destructive-confirm-contract.test.ts:20-25`).
**Blind risk:** the test asserts the offender list *equals* the holdouts, so fixing without deleting the line fails the suite — deliberately, per `:15-18`. `app.tsx:3959` and `:12646` are synchronous guards inside navigation decisions; `ConfirmDialog` is async, so the control flow must be inverted, not the call swapped.

**10. Three (not two) identifier truncation conventions are live**
Tail-8: `app.tsx:12379`, `app.tsx:12774`, `proof-view.tsx:511`. Head-8: `session-bar.tsx:328`, `:350`, `proof-view.tsx:512`, `:737`, `:746`, `platform-shell.tsx:1150`, `app.tsx:5197`, `session-message-presentation.ts:254`, `workspace-view.tsx:2702`. A third: `sessions-presentation.ts:237` (`slice(0,8)…slice(-4)`). `proof-view.tsx:210` mixes two in one expression. No comment anywhere reserves a form for a kind.
**Fix:** one `shortIdentifier(kind, value)` in `src/ui/sessions-presentation.ts` that strips the `urn:airship:receipt:` prefix before slicing.
**Blind risk:** receipt ids are URNs — naive `slice(0,8)` at `app.tsx:12379` renders `urn:airsh`. `session-bar.tsx:350`'s `Branch from #…` is documented at `:347-349` as a live e2e selector. `proof-view.tsx:511-512` also feed exported filenames.

**11. `Initial · Browser baseline` is stamped on every assistant message and defined only in a `title` attribute**
`src/ui/app.tsx:12340` puts the definition in `title=` (unreachable on touch, not a description for AT); the pill renders unconditionally at `:12337-12344`.
**Fix:** render the pill on the first assistant message of a session only, and move the definition into the trust sheet the tier chip already opens with `aria-describedby`.
**Blind risk:** `capabilityTier` must keep flowing on the message model — `src/ui/chat/transcript-intro.tsx:2` depends on it. Do not drop `title` without a replacement; that returns the finding to its original (undefined stamp) state.

**12. The OpenAI provider card tells users Airship ships Codex "with product-owner approval"; three docs say no such grant exists**
> **[RE-DERIVED 2026-08-04 — STILL OPEN]** `src/inference/providers/official-providers.ts:23`
> still sets `state: "configured-public-pkce"` and `:25` still carries the
> "product-owner approval" sentence verbatim. See also
> `docs/audit/CANON_CONTRADICTIONS_2026-08-03.md` §5.6, which reaches the same judgement and
> adds that **canon takes no position on it and should** — an open question, not a decision.
`src/inference/providers/official-providers.ts:22-25` sets `detail: "Airship ships OpenAI's own Codex client with product-owner approval. …"`, rendered verbatim to users at `src/ui/provider-fabric-panel.tsx:239`. `docs/PROVIDER_FABRIC.md:54,:57-60`, `docs/EXTENSION_BRIDGE.md:39` and `docs/INFERENCE_PROVIDER_REGISTRY.md:22` all deny it.
**Fix:** reword the string at `official-providers.ts:25` to match `INFERENCE_PROVIDER_REGISTRY.md:22` (research descriptor, no production controller, no UI sign-in). One string.
**Blind risk:** do not edit the docs to match the code — the docs are the accurate side. Do not change `state` away from `"configured-public-pkce"`: `provider-catalog.ts:227` and `connection-registry.ts:337` both throw on that invariant. Note the current mitigation is incidental — it holds only because `provider-fabric-panel.tsx:228` looks up `kind === "api-key"` and nothing else, with no test pinning it.

**13. `fetch_url` blames the remote for what is often Airship's own CSP refusal**
`src/tools/network-tools.ts:51`: "The site may be offline or may not grant Airship CORS access." `safeHttpUrl` (`:201-214`) checks only parseability, scheme and embedded credentials — never the connect-src allowlist, so a CSP block surfaces as the same opaque `TypeError` at `:46-52`.
**Fix:** reject off-allowlist origins in `safeHttpUrl` before the fetch, with a message naming Airship's own policy.
**Blind risk:** do not implement it as a CORS probe — CSP and CORS refusals are indistinguishable at `:46-47`, so a probe burns a network turn learning something already known statically.

**14. `git_remote` still offers only clone/fetch; push and worktree create/remove are withheld from the model but available to the human**
`src/tools/git-tools.ts:197` enum is exactly `["clone","fetch"]`; no worktree action in any enum; no `git_push`. The adapter has `createWorktree` (`src/git/workspace-adapter.ts:465`), `removeWorktree` (`:520`) and reports `worktree: { available: true }`, `push: remoteFeature(...)` at `:1686-1690`.
**Fix:** add `push` to `git-tools.ts:197` routed through the adapter's `permittedOrigins`, and worktree create/remove to `git_change`.
**Blind risk:** `remoteFeature("push", permittedOrigins)` is one flag for the whole build, but the decision that governs a push is per-remote (`src/ui/sources-view.tsx:148-150` says so). Wire the per-remote check, not the build flag, or the model pushes to an origin no human reviewed. `removeWorktree` shares one object/ref database with its siblings.

**15. `declareModelMetadata` is unreachable from the product — and wiring it blind writes false provenance into the pinned manifest**
`src/inference/fabric.ts:458` has no caller outside `fabric.test.ts`; `src/ui/provider-connections-view.tsx` has no declaration input (only the orphan display label at `:614`, `case "manual": return "Manual metadata"`).
**Fix (two edits, one commit):** add the context-window/max-output field pair to the model row in `provider-connections-view.tsx` and call `fabric.declareModelMetadata(...)`; **and** branch `src/ui/app.tsx:10867-10880` on `model.source.kind`.
**Blind risk:** this is the dangerous one. `declareModelMetadata` stamps `source: {kind:"manual"}` (`fabric.ts:480`), but `contextPolicyForProviderModel` (`app.tsx:10868-10881`) ignores `model.source` and stamps `{kind:"provider-catalog", field:"contextTokens"}` unconditionally. Wiring the UI alone makes every session manifest assert a provider directory published a number a human typed — a false provenance record in the immutable journal. `canonicalContextWindowSource` (`src/core/context-policy.ts:173-182`) already accepts a `runtime-config` variant. Also extend the manifest vocabulary in the same change or `src/core/session-audit.ts:1389` raises `INFERENCE_REQUEST_METADATA_INVALID`.

**16. Nothing ever tells the user context compression is unavailable**
Grep across `src/ui` for "context compression"/"no context window" returns nothing; the nearest string is `src/ui/model-picker.tsx:83` ("output limit unavailable"), a different fact. `app.tsx:10870` returns `undefined` for a model with no window and `:10780` then omits `contextPolicy` from the manifest silently.
**Fix:** where `activateExternalInference` resolves `contextPolicy === undefined` (`app.tsx:8762` → `:10780`), set a connection-card line naming the cause.
**Blind risk:** key it off the resolved `contextPolicy`, never off the provider id — `docs/PROVIDER_FABRIC.md:23` invariant 5, `src/core/agent.ts:167-168` and `src/core/context-policy.ts:12` all forbid a model-family capability table. `app.tsx:10780` spreads `contextPolicy` conditionally, so absent is currently indistinguishable from unresolved at the call site.

**17. The model is never told a model's context window or output ceiling**
`src/core/operating-charter.ts:42-46` is `{id, inputModalities?, features?}`; the emitter at `:96-107` builds facets from those two only. The only `ctx=`/`out=` producer is `modelLimitFacets` at `src/inference/providers/session-route.ts:281-289`, inside `renderInferenceAvailabilityForPrompt` — referenced only by `provider-registry.test.ts`. Hops 1-2 did land (`session-route.ts:177-181`, `model-picker.tsx:83`); the numbers stop one hop short of the prompt.
**Fix:** add `contextWindowTokens?`/`maxOutputTokens?` to the prompt definition and to `inferenceDirectoryFromAvailability` in `app.tsx`, then append facets in the emitter at `:96-107`.
**Blind risk:** do not route numbers through `promptFacet` — `operating-charter.ts:149-155` constrains facets to `^[a-z0-9][a-z0-9._+-]{0,63}$`, so a price facet containing `$` throws inside the immutable-prompt path (a session that cannot be created). Fixing `renderInferenceAvailabilityForPrompt` changes nothing — it is test-only; the live path is `inferenceDirectoryFromAvailability` → `composeAirshipOperatingPrompt` (`src/profiles/domain.ts:360`).

**18. WASI clock waits are a spin loop — any guest `sleep` pegs a core**
`node_modules/@bjorn3/browser_wasi_shim/dist/wasi.js` `poll_oneoff` does `while(endTime>getNow()){}`; `package.json:50` pins `0.4.2`. `src/execution/wasi-preview1-worker.ts:80-83` passes `wasi.wasiImport` straight through.
**Fix:** wrap the import object at `:80-83` (`{...wasi.wasiImport, poll_oneoff: ourClockPoll}`) using `Atomics.wait`.
**Blind risk:** `Atomics.wait` needs cross-origin isolation, which `docs/audit/JOURNEY_CLOSEOUT.md:167-170` records as supplied only by Playwright's own server — so a naive fix works in the harness and silently spins in deployment. Detect and degrade with a named reason. **Fix this before item 20**, or a raised timeout turns a bounded spin into a two-minute pegged core.

**19. WASI/Pyodide jobs cannot be given stdin at all**
`src/execution/wasi-preview1-worker.ts:65` builds fd 0 as `new OpenFile(new File([]))`; `ExecutionRequest` (`src/execution/runtime-registry.ts:90-112`) has no `stdin` member.
**Fix:** optional bounded `stdin?: Uint8Array` on `ExecutionRequest`, threaded through the `RunMessage` (`wasi-preview1-worker.ts:22-33`) into fd 0; expose in the `execute_code` schema (`execution-tools.ts:210-226`) and the frozen proxy.
**Blind risk:** it needs its own ceiling in `wasi-preview1-contract.ts` — `wasi-preview1-worker.ts:50-53` re-validates every payload because "a Worker must never trust an unbounded structured-clone payload". And Pyodide's stdin is deliberately *closed*, not empty (`execution-tools.ts:1644` `setStdin({ stdin: () => null })`); wiring a shared field without changing that line ships an argument that is silently discarded.

**20. `execute_code` is capped at 10 s while `execute_node_project` gets 120 s**
`src/tools/execution-tools.ts:224` `maximum: 10_000` (also `:79`, `:126`) vs `:318` `maximum: 120_000`.
**Fix:** raise the ceiling per runtime and say why in the schema description — WASI runs in a terminable disposable Worker, Pyodide cannot be interrupted mid-statement.
**Blind risk:** a blanket bump is not symmetric. `src/execution/runtime-registry.ts:96-99` names an `abort-interpreter` cancellation class precisely because Pyodide has no honest cancel path. Raise WASI first; check `wasi-preview1-contract.ts` for a lower internal ceiling before assuming the schema number binds.

**21. WASI has one preopen at the workspace root and no scratch directory**
`src/execution/wasi-preview1-worker.ts:59`, single `PreopenDirectory(".", root.contents)`, sole directory fd at `:63-68`.
**Fix:** add `PreopenDirectory("/tmp", new Map())` and exclude it from `collectFiles(preopen.dir)` at `:92`.
**Blind risk:** without the exclusion, scratch files sweep into the workspace change list, and because `files` stays *absent* rather than empty on failure (`:86-90`), a scratch-inflated collection that trips the mount budget reports a successful run as a workspace error. Adding preopens also shifts fd numbering — the table at `:63-68` is positional.

**22. Vector search recomputes both L2 norms on every comparison, on the main thread**
> **[RE-DERIVED 2026-08-04 — DEFECT OPEN, PRECONDITION CLOSED]** `cosine()` is now at
> `src/indexing/flat-index.ts:84-94` and still recomputes both norms per chunk. But the row's
> own first instruction — *add `src/indexing/flat-index.test.ts` pinning ranking order and the
> tie-break first* — is **done**: that file exists (5.2 KB). The module is 96 lines, not 68, so
> re-read it before trusting any other line number in this row.
`src/indexing/flat-index.ts` is 68 lines; `cosine()` at `:49` is called per chunk from `:20`; norms recomputed at `:51-57`; chunks held in a `Map` (`:4`), not a packed Float32Array; sole production caller `src/indexing/client-context-engine.ts:544`. No `flat-index.test.ts`.
**Fix:** cache each chunk's norm at upsert, hoist the query norm out of the map, reduce `cosine` to a dot product. **Add `src/indexing/flat-index.test.ts` pinning ranking order and the `:30` tie-break first.**
**Blind risk:** `cloneChunk` at `:44` round-trips through `structuredClone` with `vector: undefined` — a norm stored on the Float32Array will not survive it, and `all()` at `:35` hands those clones out. The `:30` sort tie-breaks on `path.localeCompare` after a fixed 0.72/0.28 blend (`:29`); scores must stay bit-comparable or retrieval silently reorders.

**23. The idempotency key is minted, digested and journaled but never sent**
> **[RE-DERIVED 2026-08-04 — STILL OPEN]** `src/inference/chutes/transport.ts` contains no
> idempotency header of any name. The row's advice — confirm Chutes honours it before sending,
> and send an opaque digest rather than `${sessionId}:${turnId}:${step}` — stands unchanged.
Minted at `src/core/agent.ts:333`, folded into the digest at `:335-341`, journaled at `:353-354`, passed to the transport at `:373`. `src/inference/chutes/transport.ts:310-317` sends Authorization, Content-Type, X-Chute-Id, X-Instance-Id, X-E2E-Nonce, X-E2E-Path, X-E2E-Stream — no idempotency header. `src/core/session-audit.ts:1387-1396` validates it locally, which is what makes it look transmitted.
**Fix:** confirm Chutes honours it first. If not, stop implying the key is an end-to-end billing guarantee.
**Blind risk:** headers ride *outside* the E2EE envelope (body is an encrypted blob at `:319`). `${sessionId}:${turnId}:${step}` as plaintext hands the endpoint a stable session id and an exact turn/step counter — metadata the E2EE posture claims to withhold. Send an opaque digest, and add the header to the CORS preflight or every invoke fails in-browser.

---

## 3. Confirmed but larger

**Features / architecture — not in part 2 because each needs new subsystems, not an edit:**

- Skill authoring/import has no product path — catalog is the six built-ins at `src/profiles/catalog.ts:115-152`; `SkillsManagerView` (`app.tsx:12806`) offers policy only. Trap: `src/profiles/domain.ts:522` and `persistence.ts:257` re-derive every persisted skill through `createSkillRevision` and compare digests — a skill that does not round-trip is silently dropped on reload.
- Terminal runtime is not a user choice — `src/terminal/manager.ts:703` is the only production host; airship-sh is never offered. Trap: the manager holds page-global single-host authority (`:690-694`).
- No live Google Drive acceptance gate — `playwright.google-drive.config.ts:3` hardcodes a fabricated client id.
- No browser cross-origin gate for the three cloud vendors — `browser-cloud.live.test.ts:4-10` says a Node pass proves nothing; no such Playwright project exists.
- No `web_search` tool anywhere; `api.tavily.com` absent from `index.html:19` and `public/_headers:2`.
- No sub-agent primitive — `src/tools/task-tools.ts` is a to-do list; `ToolRegistry` has no `subset`. Approval scoping must be designed first (`registry.ts:145`).
- No taint-aware egress gate — `src/approvals/modes.ts:47-55` auto-approves every `effect === "read"` before any mode branch. Do **not** delete that shortcut: reads are a dozen per turn and Auto Approve bills one provider request each.
- No one-writer-per-session-epoch lease — `tab-presence.tsx:39-56` is a roster; only terminals have a real lease (`terminal/manager.ts:41-45`).
- Drive key-handle store built and never wired — `workspace-key-handle-store.ts` exports have zero non-test callers; Drive still demands a recovery paste every reload (`google-drive-setup.tsx:106-107`).
- Drive full-index round-trip per write (`google-drive-object-store.ts:155,177,187,221` all `forceRefresh`); whole-manifest CAS per workspace op (`encrypted-workspace.ts:232-242`); no range reads on the workspace path (`:208-211`) and `local-device-object-store.ts:244` decrypts whole then slices. All blocked on segment-level sealing — a raw `getRange` returns unauthenticated bytes.
- No passkey/PRF unlock — zero `navigator.credentials` references in `src/`.
- rebase/cherry-pick/revert absent from `GIT_CAPABILITIES` (`src/git/types.ts:3-20`); declined explicitly at `terminal-commands.ts:828`.
- Repository import skips binaries (`repository-import.ts:143`) and sends no credential (`:132`).
- No ordinary Bash/native Git — `src/execution/shell/utilities.ts:12-17` states the bypass hazard; the fix is an approval-gated plumb, not a table entry.
- Focus rail state fully modelled (`rail-state.ts:20`, `shell.css:1339`) with deliberately no trigger (`shell.css:1330-1337`). **Do not** make `toggledRailState` cycle through it — `rail-state.test.ts:68` pins the exit path.
- `app.tsx` is 13,046 lines / 642,243 bytes; WP-0's third extraction (StageHeader) never happened. Trap: `chat-layout.test.ts:59` asserts compiled styles do *not* contain `.stage-header`.
- Build is nondeterministic across checkouts (`transcript-operations.ts` dual-imported from `platform-shell.tsx:17` and `message-parts-view.tsx:9`); `release-gate.mjs:66-75` covers both splits deliberately.
- WASIX is fail-closed on two probes (`wasix-pack.ts:87-120`). Do not soften a probe to promote it.
- 48 of 152 journey findings un-narrated (`JOURNEY_ATLAS.md:724`); both figures generated, so flipping `prose: no` closes the metric without the work.
- Rust kernel is not the browser turn loop (`load-agent-runtime.ts:9`); it has no canon home in either Planned or Explicitly-not-promised. Smallest honest action is the one-bullet canon entry, scoped to the *turn loop* (CANON.md `:508`, `:634`, `:653` name real shipped Rust/WASM).
- Twelve external launch checklist items are account-bound (`PRODUCTION_READINESS.md:151-175`). CI green proves nothing here.
- Physical-device/AT certification, remote CPU enclave, `+simd128` crate build, WebNN adapter, no SBOM/signing — all correctly labelled and correctly deferred.

**Confirmed, bounded, but internal-quality only** (safe filler work): `trapFocus`/`focusableWithin` untested despite nine modal call sites (`focus-trap.test.ts:2`); `maxWorkerConcurrency` rename (`browser-runtime.ts:94`, four pinned surfaces incl. `e2e/edge-portability.spec.ts:32,111`); four duplicate excluded-segment lists (`wasi-preview1-contract.ts:9`, `wasix-contract.ts:16`, `execution-tools.ts:38`, `shell/contract.ts:68`) and two 512-char ceilings; `shell: "none"` hardcoded at `execution-tools.ts:351,:521` against `node-webcontainer-adapter.ts:88`; three stale CANON citations in the reconciliation itself; the 14-day tombstone constant (`return-ledger.ts:114`) duplicated as prose at `:46`.

**Partially open with real residue** (excluded from part 2 only because the verdict is partial, not confirmed):
- **Prototype-poison guard is shallow and its test is vacuous.** `src/profiles/persistence.ts:227-238` recurses via `Object.values` gated by `isRecord` (`:376-378`), which returns false for arrays — so poison inside `themes[0]`, `skills[0]`, `profiles[0]` is accepted. `catalog-adversarial.test.ts:57-67` pushes the *theme object* (because `withOwnKey` returns its target, `:39-47`), so 4 of 5 nests assert on the wrong value and go green for the wrong reason. Fix the test first. Watch out: `identifier()` (`domain.ts:684`) legally accepts `constructor`/`prototype` as skill ids.
- Mid-conversation model switch: the fork-context mechanism fully shipped (`src/core/fork-context.ts:12`, five of six steps); only step 5 is missing — `app.tsx:8624` and `:8734` still do `createProfileSession + setMessages([welcome])`.
- Claim-stack rows still read identically (`proof-inspector.tsx:220-222`); `language.technical` is computed at `:213` and rendered only in the expanded detail.
- Ollama has no CORS guidance sibling to the LM Studio paragraph at `provider-connections-view.tsx:271`.

---

## 4. False positives — do not touch these

Each of these is working code the inventory reported as broken.

| Claim | Refuted by |
|---|---|
| No type ramp; 36 font sizes from em/% compounding | `src/ui/tokens.css:133-140`; every UI `font-size` resolves to a ramp token; `type-floor.test.ts:42-64` + `e2e/type-ramp.spec.ts:26-46` |
| "`scripts/type-ramp-capture.mjs` would settle the census" | That script records one `<h1>`'s size per route. The real gate is `e2e/type-ramp.spec.ts` |
| Route H1s render at 47px from a `clamp` | `routes.css:3938-3946` uses `--fs-display`; the clamp survives only in comments (`:90`, `:3936`); pinned `e2e/type-ramp.spec.ts:48-72` |
| One route template serves documents and tools | `route-header.tsx:13,:160`; `routes.css:3984-3999` |
| Empty states describe absence | `src/ui/empty-state.tsx` + `empty-state.test.ts:9-30` (`action?: ComponentChildren`) — **[RE-DERIVED 2026-08-04: citation overruns.** `src/ui/empty-state.test.ts` is **29 lines**, so `:9-30` cannot resolve; the range should read `:9-29`. The refutation itself holds — `action?: ComponentChildren` is at `src/ui/empty-state.tsx:33`.**]** |
| Claim rail arrives mid-session as a 320px column | `app.tsx:1619,:10269`; `chat.css:2022-2026`; layout switches to `no-inspector` at `:9691` |
| `javascript:alert(1)` accepted as a bare OAuth code | `authorization-code-paste.ts:163` rejects any scheme prefix; 10/10 tests pass — **[RE-DERIVED 2026-08-04: citation dead, refutation intact.** `:163` is now a blank line; the rejection is `readBareCode` at `src/ui/connect/authorization-code-paste.ts:164-175`, measurement preserved in its comment at `:165-168`.**]** |
| Pasted redirect URL origin unchecked | `authorization-code.ts:217-228`, with the placement rationale at `:210-216`; 14/14 tests pass — **[RE-DERIVED 2026-08-04: refutation intact.** Full path is `src/auth/provider-oauth/authorization-code.ts`; the `pasted.source === "redirect-url"` comparison against `registeredCallback(registration)` is present with its rationale immediately above.**]** |
| 132 KiB JS cap unmoved (`release-gate.mjs:28`) | `:28` is prose in a comment; the cap is `176 * 1024` at `:75`, raised in `f56ce7b` — **[RE-DERIVED 2026-08-04: the refutation's own citation has now moved.** `176 * 1024` is the gzip half of `allJavaScriptAndWorkers` at `scripts/release-gate.mjs:86`; `:75` is now prose in a comment — the identical confusion, one commit on.**]** |
| Optional-providers budget masks the first-party budget | `release-gate.mjs:713` (124 KiB/38 KiB) is above the measured `:709-710`; first-party asserted at `:1742-1745` |
| `createSkillRevision` callers confined to tests / no skills view | `catalog.ts:115,122,130,137,144,151`; `persistence.ts:257`; `domain.ts:522`; route at `app.tsx:12806`, mounted `:10414` |
| No shell tool (`execute_shell_command` absent) | `execute_shell` at `execution-tools.ts:617-644`, proxied at `execution-tool-proxies.ts:102`, UI card at `capabilities-view.tsx:406` |
| Python egress guard throws, contracts unreconciled | `execution-tools.ts:1308-1312` **returns** `string \| undefined`; rationale `:1299-1306`; call site `:1188-1195` |
| `maxWorkerConcurrency` gone from `e2e/` | `e2e/edge-portability.spec.ts:32` and `:111` (excluded from the default matrix, not deleted) |
| Extension user-agent vocabulary changed / `"live"` gone | Grep needed `-E`. `extension/src/user-agent.ts:216,225,247,262`; Firefox gate at `:235-241,:260`; README table `:75-84` |
| Georgia still open; bound in four places | Superseded by `DESIGN_DIRECTION.md:29,:849`; bound in **eleven** places in `routes.css` plus `tokens.css:84,338`; ceiling pinned at `view-stylesheet-contract.test.ts:50` — **[RE-DERIVED 2026-08-04: still exactly eleven** — `src/ui/routes.css:310, 721, 1131, 1181, 1521, 1700, 1796, 1832, 1844, 2144, 2827`. A twelfth occurrence at `:4454` is a comment. Two moved since the recovered-work register cited them (`:2136`→`:2144`, `:2819`→`:2827`).**]** |
| Corpus digest does not reproduce | Ran it: `sha256:7cHZr7feFeV8RSq0SxqdSWNk7sJywgkQ9cgfcYYKkJM`, byte-identical to `CONTEXT_FABRIC.md:172-178` |
| Context-engine items (1),(3)-(9) unverified | Spot-verified: `session-audit.ts:1685`; `context-summary-projection.ts:503-508`; `context-selection.ts:8-17,:179` |
| Page-side bridge: seven issues | `bridge/client.ts:200-209,:281-289`; `bridge/protocol.ts:348-362`; `oauth-transport.ts:111,:224-226`; `connect-lanes.ts:524` |
| Vault-storage remediation: seven findings | `platform-shell.tsx:463-469`; `local-lab-live.ts:61`; `client-ciphertext-cache.ts:459-471,:923-935`; `google-drive-auth.ts:115` |
| Source Control History pane unwired | `sources-view.tsx:80,:519-530` |
| lead-observations #1/#2/#5/#6 | `transcript-operations.ts:7`; `trust-language.ts:163-171`; `responsive-breakpoints.spec.ts:80-81`; `model-control.tsx:190-200` |
| HUMAN_REVIEW B3/B7/B11/M1/M9/M11 | `access-view.tsx:107,110`; `rail.tsx:23-27`; `platform-shell.tsx:463-469`; `trust-label-contract.ts:45-62`; `navigation-model.ts:217,401` |
| VISUAL_BUILD_LIST DN-2/4/5/6/7/12 | `chat.css:1042-1047`; `trust-label-contract.ts:48-62`; no `opacity: .45` in `tokens.css` |
| BROWSER_GIT lacks the CSP subsection | `docs/BROWSER_GIT.md:221-260` |
| DESIGN_BLUEPRINT has no findings ledger ("section 6") | `:53-60` is a six-item defect list; all six verified resolved (`seal.tsx:96-109`, `domain.ts:61`, `height-index.ts:143-144`, `topbar.tsx:30`, `type-floor.test.ts:10-27`, `platform-shell.tsx:493-497`) |
| JOURNEY_METHOD §1 script unwired | `scripts/journey-atlas-gate.mjs:107-126`, wired at `package.json:37,:47`, CI `.github/workflows/ci.yml:181-185` |
| CHUTES trust-tier gates are open findings | `CHUTES_ATTESTATION_EVIDENCE.md:298-317` — provider protocol capabilities, carried as Planned at `CANON.md:1159,:1379` |
| GOOGLE_DRIVE_VAULT doc inaccurate | `:65-70` matches the tree exactly; the code gap is tracked separately |
| Vault "Contract verified" overclaim | `vault-view.tsx:373-377,:868,:876-882`; `e2e/vault-auto-adoption.spec.ts:13-53` |
| BUILD_PLAN W12 shell unbuilt | See `execute_shell` row above; `MASTER_PROMPT_ACCEPTANCE.md:118-121` records it closed-differently |

> **[RE-DERIVED 2026-08-04 — the second note below is void.]** `grep -rn FERRARI scripts/`
> returns nothing at `03af2c5`. The FERRARI P0-01 gate this warns against deleting **is not in
> `scripts/` at all**; the string survives only in `docs/gap-audit/git.md`,
> `docs/audit/CANON_RECONCILIATION_2026-08-03.md` and the recovered-work register. There is no
> gate to preserve. The `--fs-hero` note was not re-checked.

**Two more do-not-touch notes:** `--fs-hero` having zero consumers was adjudicated and declined at `VISUAL_BUILD_LIST.md:385` — giving it a consumer is explicitly forbidden. And do not delete the FERRARI P0-01 gate on the strength of `ARCHITECTURE.md:18-24`; that decision closes the *scope* question, not the crate's missing canon home.

---

## 5. Still unverifiable

Seven, with exactly what settles each.

1. **FERRARI P0-02/03/04/05/07** (fault-injection and negative corpora). Settled by `npx playwright test` against a built origin for the browser halves, and `npm run check:release:live` (`package.json:41` → `scripts/release-live.mjs`) for the deployed-origin halves.
2. **lead-critique #2 — "93 elements share 1px rgba(225,217,200,0.106)".** Token layer is unified (`tokens.css:207,208,212`); the element census is a rendered-DOM property. Settled by extending `e2e/type-ramp.spec.ts`'s `sampleText` walker to collect computed border shorthand and assert a ceiling, at 1440x900 against a built origin.
3. **AR-005 crash-after-effect** (kill-during-write durability). The other two halves check out (`src/tools/schema.ts:98`; `src/core/agent.ts:778-783`). Settled by a harness that terminates the page between effect application and journal commit — CDP `Target.closeTarget` mid-write under Playwright, or a service-worker fetch abort. Neither exists in `e2e/`; `PASS3_FINDINGS.md:122-125` puts it deliberately out of scope.
4. **Three browser gates reported failing.** All three files exist and their source-level sub-claims check out (`vault-auto-adoption.spec.ts:89,:94`; `vault-provider-switch.spec.ts` no longer contains "Connect your Google Drive"). Settled by `npx playwright test e2e/vault-auto-adoption.spec.ts e2e/local-device-app-journey.spec.ts e2e/vault-provider-switch.spec.ts` against a running lab — note `vault-auto-adoption` skips off desktop-chromium at its own guard, so the project matters.
5. **lead-observations #4 — content starts ~230px down (~26% of a 900px viewport).** No content-start budget exists anywhere in `e2e/`; the vertical measurements that do exist measure the composer share (`responsive-breakpoints.spec.ts:80-81`). Settled by a headless 1440x900 run on a connected turn reading `document.querySelector('.transcript').getBoundingClientRect().top`.
6. **Phone terminal tap-to-focus.** `terminal-view.tsx:167` records only that the *keyboard-chord* path was measured; every test touching the element uses programmatic focus (`developer-workflow-seam.spec.ts:131-132` and three others), and the one in the default matrix is gated to desktop + live WebContainer (`:124-125`). Settled by a `mobile-chromium` test (`playwright.config.ts:76-78`) that navigates to `#terminal`, `.tap()`s `.terminal-emulator`, and asserts `document.activeElement` matches `textarea.xterm-helper-textarea` — plus a physical device, since emulated touch is not real touch (`EDGE_PORTABILITY_ACCEPTANCE.md:33`).
7. **"The terminal cannot be typed into on a phone."** Strengthened negative: none of the proposed remediation exists — no command-bar `<input>` in `terminal-view.tsx` (only the tab-rename field at `:623`), no tap handler on the pane (`:906-956`), no degradation caption. Whether xterm.js itself delegates a touch tap to its helper textarea is a runtime property of the vendored library. Settled by the same probe as (6), then typing `ls` + Enter and asserting the pane text changes — **run it before building the command bar**, or the terminal gets two divergent input queues.
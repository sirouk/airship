import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(root, "dist");

export const RELEASE_MANIFEST_NAME = "release-manifest.json";

export const RELEASE_BUDGETS = Object.freeze({
  // First paint on a phone, and the strictest ceiling in this file. It held at
  // 110 KiB through the whole Pass 1 audit — ~19,000 changed lines — and moved
  // here by 0.16 KiB when the profile editor stopped hand-spelling three labels
  // and started reading them from `profiles-governance`, which was already in
  // this graph. Measured 110.16 KiB gzip; one whole-KiB step, and the deferral
  // habit documented below is still the first tool to reach for.
  // The vault danger-zone work (the wipe action in app.tsx) and the vendor
  // brand marks it shipped with added 0.26 KiB to this measure: 111.26 KiB
  // gzip. It is still the strictest ceiling here, so it moves one whole-KiB
  // step with a named cause, and the deferral habit documented below is still
  // the first tool to reach for when the next few hundred bytes are asked for.
  entryJavaScript: Object.freeze({ raw: 384 * 1024, gzip: 112 * 1024 }),
  // Trust composition adds ~1.8 KiB gzip to the baseline while the actual
  // entry remains below its stricter 110 KiB limit. Heavy QVL stays deferred.
  //
  // This is the first-paint cost on a phone. It held at 132 KiB through three
  // waves of capability, each absorbed by deferring startup weight rather than
  // by raising the number — the fixture-only in-memory Git backend, and the
  // Chutes account-telemetry client that now travels with the Billing surface
  // it serves.
  //
  // The Profile cockpit, durable favourites, inline rename and the unified
  // workbench then landed in the entry chunk together and put the measured
  // baseline at 132.58 KiB, 594 bytes over. Every one of the 19 chunks in this
  // set is genuinely `modulepreload`ed, so none of it could be reclassified
  // away; `tdx` and the endpoint-evidence store were the only two that could,
  // and moving them to their real owners recovered 2.72 KiB before this.
  //
  // Raised deliberately, with headroom for the remaining waves and a hard cap
  // well under 200 KiB. It is a ceiling, not a target: the deferral habit above
  // is still the first tool to reach for, and a change that spends this
  // headroom should say what it bought. Measured 424.34 KiB raw /
  // 132.58 KiB gzip.
  //
  // The human-journey pass spends 2.14 KiB of it, and says what it bought: an
  // approval dock that describes the write it is asking about to a screen
  // reader and announces which way the decision went, and a returning person
  // being told when their previous session did not survive instead of being
  // shown a screen indistinguishable from a first visit. The deferral habit was
  // reached for first — the report, its ledger and the dock all moved out of
  // the entry chunk in this same change, which is what kept ENTRY JavaScript,
  // the ceiling that actually blocks first paint, inside 112 KiB. Measured
  // 162.14 KiB gzip.
  //
  // The eight-lane journey pass spends the rest of it, and every kilobyte is a
  // capability someone did not have: an egress record answering what has left
  // this device, a keyboard-shortcut sheet for chords that were undiscoverable,
  // turn narration for a screen reader that heard nothing at the moments that
  // mattered, chunk recovery on every deferred route, and a workspace that says
  // where a file actually is. ENTRY JavaScript held at 111.59 KiB inside its
  // unchanged 112 KiB ceiling — the message-part renderer, the approval dock,
  // the resume report and its ledger were all pushed out of it rather than the
  // number being moved.
  // Sized for both observed chunk layouts, because the build is NOT
  // deterministic across checkouts. `transcript-operations` is shared between
  // the boot path and a deferred route, and Rollup resolves it either way: two
  // clones of the identical tree — same sources, config and lockfile — emitted a
  // 350 B stub in one and a 10.5 KiB chunk in the other. This ceiling had been
  // tuned to the smaller split and failed in a clean clone. Naming the chunk in
  // `vite.config.ts` gave it a stable name for attribution but did not remove
  // the split, so this covers both forms pending a dedicated deterministic-build
  // repair. Measured 171.49 KiB gzip here, 175.56 KiB gzip from a clean clone.
  allJavaScriptAndWorkers: Object.freeze({ raw: 768 * 1024, gzip: 176 * 1024 }),
  // Provider routes, capability activation, and the stable lazy broker remain
  // absent from first paint. The broker now also exposes the canonical runtime
  // capability read used by a cold Capabilities deep link before any session
  // exists. Measured together at 398.25 KiB raw / 116.64 KiB gzip (407,804 B /
  // 119,442 B), so both ceilings moved this time — raw 398 → 400 KiB and gzip
  // 117 → 118 KiB. The build crossed the old 398 KiB raw step outright, and then
  // 399 KiB raw would have left 772 bytes while 117 KiB gzip would have left 366.
  // A ceiling a minifier rename can breach is a tripwire, not a budget — the same
  // argument the installed-total gzip ceiling below is set by — so each takes one
  // further whole-KiB step, leaving 1,796 bytes raw / 1,390 gzip. The fixed
  // first-paint cap above is what did not move: none of this loads at startup.
  //
  // Re-measured at 409,852 B raw / 120,513 B gzip after the vault usage strip
  // (the coordinator's read-only inventory call), the shipped-theme
  // reconciliation and the LM Studio server-requirements copy landed in this
  // group. gzip still clears by 1,319 B; the raw ceiling takes one further
  // whole-KiB step, leaving 2,708 bytes. Gzip — the figure that actually moves
  // over the wire — did not move.
  //
  // The human-journey pass moves both. It buys the egress record — the answer
  // to the Atlas's largest single hole, "there is no surface anywhere in
  // Airship that shows what has left the device" — on a product whose entire
  // pitch is that you can verify what happens. It also carries the connect
  // lane's honesty repairs and the brand marks beside each provider.
  // Measured 427,438 B raw / 126,873 B gzip, each the tightest whole-KiB step.
  // Nothing here is fetched before a person opens a route that needs it.
  //
  // The connection lane's second pass moves both again, and says what it bought.
  // The egress record above could not answer its own question: its boundary was
  // the page's origin, so "Check Ollama" — one request to another port on this
  // same machine — was filed under "What has left this device". It now
  // classifies same-origin, on-device loopback and remote, keeps loopback
  // visible as network activity under its own heading, and refuses to report a
  // key handed to a local model server as having left. Beside it, a pasted
  // Chutes key is offered to the provider before anything is drawn that implies
  // it was accepted — `cpk_notarealkey000000` used to reach a priced model card
  // with an availability reading, because the catalog answers anyone. Trimmed
  // first: the provider-response reader lost its JSON path, and four disclosure
  // sentences were shortened without dropping a claim, which returned 428 B.
  // Measured 425,809 B raw / 125,687 B gzip. 416 KiB raw would have left 175
  // bytes and 123 KiB gzip would have left 265 — a ceiling a minifier rename can
  // breach is a tripwire rather than a budget, the same argument every reading
  // above is set by — so each takes one further whole-KiB step, leaving 1,199
  // bytes raw / 1,289 gzip. The fixed first-paint cap above did not move: none
  // of this loads at startup.
  deferredCapabilities: Object.freeze({ raw: 418 * 1024, gzip: 124 * 1024 }),
  // Core plus every optional route except the two independently delivered
  // vendor engines. The former 384 KiB "all routes" meaning became impossible
  // once full isomorphic-git and xterm engines were deliberately installed:
  // they are mutually activated, separately cached, and already individually
  // capped. Keep 384 KiB as the stronger first-party/all-other partition.
  // Local Device custody plus the provider-neutral inference fabric add
  // independently lazy first-party packs. The reviewed installed first-party
  // aggregate now measures 1,394.99 KiB raw / 430.45 KiB gzip: the Git engine's
  // new read/history/tag/stash/merge/remote operations, the Service Worker and
  // Cache Storage probes, and the expanded Capabilities/Memory/Proof route
  // chrome are all first-party and all lazily delivered. Every cap raised in
  // this pass sits at the lowest whole KiB that clears its measurement by at
  // least ~0.5%; a ceiling a few hundred bytes above the build is a tripwire,
  // not a budget, and the former "<5% above measured" allowance was slack.
  // `airship-sh` adds a whole first-party POSIX-sh interpreter — lexer,
  // parser, expansion, arithmetic, globbing, redirection and the workspace
  // utilities it runs — measuring 96.32 KiB raw / 28.75 KiB gzip. It is a new
  // capability rather than growth in an existing one, and it is fetched only
  // when a shell command runs, so the aggregate rises by roughly its size.
  // The Connect surface then began doing two things it previously only
  // described: a live per-page-load extension-bridge handshake whose outcome
  // the Claude and Grok lanes render, and a real Ollama/LM Studio loopback
  // probe behind "Check this machine". Both are lazily delivered, and the
  // bridge client also lost its cross-chunk compression when it became shared.
  // Measured 473.96 KiB gzip against 471.56 before; raw is unchanged.
  // Addressed per-conversation drafts, immutable message forks, a tab-local
  // follow-up queue, and touch/pointer message disclosures add installed chat
  // behavior without moving any individual route or first-paint ceiling.
  // Measured 1,549.33 KiB raw / 477.36 KiB gzip; the gzip ceiling is the
  // smallest whole-KiB step that retains roughly 0.5% tripwire clearance.
  // The Memory route's restored fields, result destinations and shared
  // provenance disclosure add ~4.1 KiB gzip to the installed first-party
  // aggregate and nothing at all to the first-paint set, which is measured
  // byte-identical at 411.63 KiB raw / 131.94 KiB gzip. Measured 487.0 KiB
  // gzip; the ceiling keeps the same ~0.5% tripwire clearance as before.
  // Two blocker fixes land here and nowhere near first paint. A proof *policy*
  // stopped being rendered as a verdict on the session seal, and the transcript
  // renderer stopped throwing on the session-scoped journal events protocol-v1
  // defines without a `turnId` — a `session.renamed` that Airship writes itself
  // on the first prompt of every default-titled conversation, and which made an
  // entire vault unadoptable. The weight is disclosure, not machinery: session
  // markers carried on the presentation and rendered in sequence order, a
  // quarantine that adopts the vault and names the one conversation it could
  // not replay, and faults that state their session, sequence and event type
  // instead of a bare UUID. Measured 1,645.12 KiB raw / 513.26 KiB gzip; the
  // gzip ceiling moves to the lowest whole KiB that keeps this file's ~0.5%
  // tripwire clearance, and raw is unchanged inside its existing ceiling.
  // First paint is governed separately by the 768/160 KiB raw/gzip ceiling
  // above and is untouched by this number.
  // Profile-local conversations, VS Code-style workbench behavior, live agent
  // environment capture, OAuth, evidence scheduling, terminal audit lineage,
  // and the complete responsive capability presentation are each charged to a
  // named lazy surface. Their ownership splits remove cross-chunk compression
  // opportunities without adding first-paint weight.
  //
  // Pass 2 moved this by 28.67 KiB raw / 11.43 KiB gzip, and every kilobyte of
  // it is a capability that could not be reached before: deleting a
  // conversation (absent at all three storage layers while PRODUCT_SPEC.md
  // promised it), the browser-Git bridge's entry point (17 verb families with
  // no caller), workspace content search, retry on a failed route chunk (the
  // affordance existed on one route and was dead code for the two that needed
  // it most), and the empty/error states nine panels were missing. The
  // consolidation in the same pass paid part of it back — seven `stringArgument`
  // declarations, twenty `deepFreeze`s, nine timestamp formatters and seven byte
  // formatters became one each. Measured 1910.53 KiB raw / 599.15 KiB gzip;
  // these are the smallest whole-KiB backstops that clear it.
  //
  // The vendor-logo, vault-usage, rail, theme-library and mobile-chrome pass
  // re-measured the partition at 1920.69 KiB raw / 602.71 KiB gzip — roughly
  // ten raw KiB of reviewed lazy-route work, none of it first-paint. Both
  // backstops move to the smallest whole KiB that clear the reading.
  //
  // First paint is governed separately by the 768/160 KiB raw/gzip ceiling
  // above and is unchanged by any of it.
  // The local-device reclaim fix, vault danger zone, durable-delete e2e and
  // rail recents reclamation re-measured the partition at 1924.54 KiB raw /
  // 603.6 KiB gzip — roughly four KiB of reviewed route work, still none of it
  // first-paint.
  //
  // The journey pass added roughly half a KiB: a tab-scoped record of the
  // conversation addresses this page wrote itself, so the first screen a person
  // ever sees stops reporting a conversation lost to Airship's own boot reload.
  //
  // Its implementation wave then spent 38 KiB raw / 14 KiB gzip on the six
  // journeys the Atlas found broken, and every kilobyte is a capability a
  // person did not have: an egress record answering "what has left this
  // device", a returning person being told when their previous session did not
  // survive, an approval dock that describes the write it is asking about to a
  // screen reader and announces which way the decision went, a Proof surface
  // that counts the tool operations that actually happened, provenance that
  // travels from a memory result back into a conversation, and a Git handoff
  // where the terminal used to fail at a shell with no git binary.
  //
  // ENTRY JavaScript — the ceiling that blocks first paint — did not move, and
  // was not allowed to: the report, its ledger and the approval dock were all
  // pushed out of the entry chunk in the same change to keep it inside 112 KiB.
  // Measured 1963.16 KiB raw / 618.03 KiB gzip.
  //
  // The connection lane's second pass spends 5.5 KiB raw / 1.86 KiB gzip of the
  // same kind: the egress record learning the difference between another port
  // on this machine and another machine, so a loopback model probe stops being
  // reported as egress and a key handed to a local server stops being reported
  // as having left; a Chutes key checked with Chutes before a priced model card
  // is drawn for it; and Account stating why it lists four providers while
  // Connection counts more ways in. See `deferredCapabilities` above — every
  // byte of it lands there, behind a route. ENTRY JavaScript did not move.
  // Measured 1968.69 KiB raw / 619.91 KiB gzip; 1969 KiB raw would have left
  // 314 bytes and 620 KiB gzip 92, so both take one further whole-KiB step.
  //
  // The eight-lane journey pass — every one of the 148 routed findings — spends
  // 51 KiB raw / 19 KiB gzip of this partition. Named, because a raised ceiling
  // has to say what it bought: an egress record answering "what has left this
  // device", a Proof surface that counts the operations that actually ran, a
  // returning person told when their previous session did not survive, memory
  // provenance that travels back into a conversation, a keyboard-shortcut sheet
  // for chords that had no discovery surface at all, turn narration for a
  // screen reader that heard nothing at the moments that mattered, and a
  // workspace that prints the path a file is actually at.
  //
  // ENTRY JavaScript did not move and was not allowed to: it measures
  // 111.59 KiB against its unchanged 112 KiB ceiling, because the message-part
  // renderer, the approval dock, the resume report and its ledger were all
  // pushed out of the entry chunk instead.
  // J151/J152 add the reload-risk publisher and one shared bottom-floor
  // measurement the update banner and the capability dock now both read
  // (`bottom-floor.ts` replaces the dock's private copy, so this is smaller
  // than two fixes), and deletion forgets its return-ledger entry so a deliberate
  // removal is no longer mourned as loss. Measured 2024.00 KiB raw / 640.54 KiB
  // gzip.
  // Splitting the command palette and preferences dialog out of the entry chunk
  // adds a chunk boundary and its shared imports here while removing them from
  // first paint, which is the trade the entry ceiling exists to force.
  // Measured below.
  /*
   * Sized for the range the build actually produces, not for one machine.
   *
   * `transcript-operations` is shared between the boot path and a deferred
   * route, and Rollup resolves that either way depending on the checkout: two
   * clones of the identical tree — same sources, same config, same lockfile —
   * emitted a 350 B stub in one and a 10.5 KiB chunk in the other. These
   * ceilings had been tuned to the smaller split and failed in a clean clone,
   * which is the same class of defect as a gate that reads an untracked file:
   * it passes where it was written and nowhere else.
   *
   * Naming the chunk gave it a stable name for attribution and did not pin the
   * split, so the ceilings cover both forms and record both figures rather than
   * pretending one of them is the number.
   * Measured 2026.03 raw / 642.03 gzip here, 2035.75 raw / 645.87 gzip from a
   * clean clone. Making the split itself deterministic is worth doing and is
   * not this pass's job.
   */
  // Skill authoring spends 6.67 KiB raw / 2.36 KiB gzip of this partition, and
  // says what it bought: a Skills route that could only toggle six instructions
  // shipped by the release can now write, revise and delete its own. Before
  // this, `createSkillRevision` had no authoring caller anywhere in the tree —
  // the capability existed in the domain and had no way in.
  //
  // ENTRY JavaScript did not move past its ceiling and was not allowed to: the
  // authoring panel and its stylesheet are a separate chunk fetched only when
  // someone presses New skill or Edit (`optionalSkillEditor` below), so a
  // visitor who reads the grid pays none of it. What lands in the entry graph
  // is the grid's own two controls and the three catalog transforms behind
  // them, which the removal path has to reach from the card.
  //
  // Measured 2040.29 KiB raw / 646.84 KiB gzip on the larger of the two
  // `transcript-operations` splits described above, so the ceiling covers both
  // forms rather than the one this machine happened to emit. 2041 KiB raw would
  // have left 727 bytes and 647 KiB gzip would have left 164; both take one
  // further whole-KiB step, for the reason stated throughout this file — a
  // ceiling a minifier rename can breach is a tripwire, not a budget.
  firstPartyJavaScriptAndWorkers: Object.freeze({ raw: 2042 * 1024, gzip: 648 * 1024 }),
  // isomorphic-git and xterm are mutually activated vendor engines with their
  // own per-pack caps. The pair now measures 672.33 KiB raw / 186.61 KiB gzip:
  // the browser-Git pack grew (see optionalBrowserGit) and the Terminal pack
  // carries the in-terminal Git command surface, which Pass 2 reconnected to a
  // control after finding its 17 verb families had no caller at all. Both
  // vendor pins are unchanged, so all of the growth is first-party and
  // separately reviewable.
  // The journey pass adds the Terminal's Git handoff to this pair; both vendor
  // pins are unchanged, so the growth is first-party and reviewed above.
  optionalVendorRuntimeAggregate: Object.freeze({ raw: 677 * 1024, gzip: 188 * 1024 }),
  // Absolute installed bundle backstop. It includes first-party/routes, both
  // vendor engines, model catalog chunks, and the service worker. Static
  // Pyodide assets remain governed by their separate pack cap below.
  // Genuine linked worktrees add an isolated worktree administration overlay
  // while retaining one shared object/ref database. The installed aggregate now
  // measures 2,047.22 KiB raw / 611.06 KiB gzip. The 2 MiB raw backstop is a
  // deliberate round product statement and is NOT raised here: it still fits,
  // with under 1 KiB to spare, and it — not the gzip figure — is what the next
  // installed capability has to argue against. Only gzip moves, to 612 KiB;
  // 611 KiB would have left 32 bytes, and a ceiling that cannot survive a
  // minifier rename is not a ceiling. Startup and every per-route pack ceiling
  // remain independently enforced.
  // Raised twice: once for the airship-sh pack, once for provider OAuth plus
  // the extension-bridge transport. The original 2 MiB raw figure was a
  // deliberate product statement; a real in-browser shell and real provider
  // sign-in are deliberate product decisions that supersede it. Both additions
  // are lazily loaded and contribute nothing to first paint, which is why the
  // startup cap below has not moved.
  // Raised a third time, for the Connect surface doing what it had only said:
  // consuming a real extension-bridge handshake per page load and issuing a
  // real loopback probe for the local model servers. Measured 2,189.23 KiB raw
  // / 654.58 KiB gzip; neither addition touches first paint, which is why the
  // startup cap below still has not moved.
  // The same chat milestone measures the complete installed bundle at
  // 2,202.99 KiB raw / 658.38 KiB gzip. These are the smallest even-KiB
  // ceilings that preserve roughly 0.5% clearance; startup stays separately
  // fixed at 640/132 KiB raw/gzip above.
  // The Memory route milestone above carries through to the installed total:
  // measured 663.25 KiB gzip, raw unchanged inside its ceiling. First paint is
  // untouched and stays separately fixed at 640/132 KiB raw/gzip below.
  // The session-marker and quarantine milestone above carries through to the
  // installed total: measured 2,281.33 KiB raw / 689.93 KiB gzip. Only raw
  // moves, to the lowest whole KiB keeping ~0.5% clearance; the gzip ceiling is
  // not raised because the build is still inside it. First paint is untouched
  // and is governed separately by the 768/160 KiB raw/gzip ceiling below.
  // The current installed graph measures 2582.86 KiB raw / 785.76 KiB gzip.
  // Every capability is separately owned and capped; the aggregate delta is
  // the sum of those reviewed lazy owners, not eager preload — see
  // `firstPartyJavaScriptAndWorkers` above for what Pass 2 spent it on and what
  // the same pass gave back by deleting duplicate implementations. The
  // backstops below are the smallest whole KiB that clear the reading, while
  // the startup ceiling remains independently fixed.
  // The vendor-logo/theme/vault/rail pass carries the aggregate to
  // 2593.02 KiB raw / 789.33 KiB gzip — the sum of the lazy-route deltas
  // reviewed in `firstPartyJavaScriptAndWorkers` above, still nothing eager.
  // The local-device reclaim and vault danger-zone pass carried the aggregate
  // to 2596.87 KiB raw / 790.35 KiB gzip: the sum of the lazy-route deltas
  // reviewed in the same comment chain as `firstPartyJavaScriptAndWorkers`.
  // The journey pass takes it to 2597.49 KiB raw, one whole KiB above.
  // The journey pass carries the installed graph with the six lazy routes it
  // improved; see `firstPartyJavaScriptAndWorkers` for what each bought.
  // The connection lane's second pass carries the same lazy delta through to
  // the aggregate — loopback classified out of the egress claim, a key checked
  // before a priced picker is drawn for it — and nothing eager moved.
  // Measured 2642.62 KiB raw / 806.96 KiB gzip.
  // The human-journey pass carries the lazy graph past the old whole-KiB step
  // by bytes, not by a feature: a height gate on the rail's auto-open recents
  // (Global destinations must not be pushed off a short viewport) and a bounded
  // claim rail on the Proof route. Nothing eager moved and the entry ceiling is
  // untouched. Measured 2698.00 KiB raw / 827.54 KiB gzip.
  // J151/J152 and the deletion-vs-loss fix carry the aggregate with them.
  // Measured 2700.42 KiB raw / 828.47 KiB gzip.
  // The shell-overlay split carries the aggregate with it: the palette and the
  // preferences dialog now cost a chunk boundary in the lazy graph and nothing
  // at first paint. Measured 2701.21 KiB raw / 829.51 KiB gzip.
  // The rename/fork guard on the session detail effect adds its ref and its
  // condition. Measured 2702.03 KiB raw / 829.66 KiB gzip.
  // Sized for both chunk splits; see `firstPartyJavaScriptAndWorkers`. Measured
  // 2712.18 KiB raw / 833.80 KiB gzip from a clean clone.
  // Skill authoring carries into the installed aggregate exactly as it lands in
  // the first-party partition above — both vendor pins are unchanged, so all of
  // the growth is the first-party weight already reviewed there. Measured
  // 2716.69 KiB raw / 834.76 KiB gzip on the larger chunk split. 2717 KiB raw
  // would have left 318 bytes and 835 KiB gzip 246; both take one further
  // whole-KiB step. Nothing eager moved and the entry ceiling is untouched.
  totalJavaScriptAndWorkers: Object.freeze({ raw: 2718 * 1024, gzip: 836 * 1024 }),
  // The independently loaded offline shell worker is not application-bundle
  // startup cost. Keep it visible under a dedicated, deliberately small cap.
  serviceWorker: Object.freeze({ raw: 12 * 1024, gzip: 4 * 1024 }),
  // Browser-aware guidance on the static Companion install hub. This is not
  // app startup code, but it is executable release payload and therefore gets
  // its own tiny ceiling instead of disappearing into an aggregate.
  companionInstallScript: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  optionalExecutionPack: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  // The stable broker is tiny; Worker/WASI/Pyodide implementation follows as
  // a second-level chunk only when runtime inspection or execution begins.
  // The broker now also registers `airship-sh` and describes its capability,
  // which is what pushed this chunk past 12 KiB gzip. The interpreter itself
  // stays in its own pack below; only the registration travels here.
  optionalExecutionEngine: Object.freeze({ raw: 56 * 1024, gzip: 14 * 1024 }),
  // Grew with the runtime-remediation work: an unavailable runtime now carries
  // its own reason and next step rather than one generic "unadvertised" line.
  // Measured 8.12 KiB raw / 3.17 KiB gzip, still fetched only with the runtime.
  optionalExecutionSupport: Object.freeze({ raw: 10 * 1024, gzip: 4 * 1024 }),
  // Shared implementation behind the lazy agent tool bundle and the
  // second-level execution-engine facade. Vite splits it because both import
  // the same worker/WASI/workspace dispatcher. It is never part of first paint.
  //
  // Re-measured at 60,087 B raw / 17,208 B gzip after the Pass 2 dedup work.
  // The pack grew because consolidation moved bytes INTO it: the helpers that
  // had been declared once per tool module (`stringArgument` in seven places,
  // `deepFreeze` in twenty, two byte formatters, the UUID source) now live in
  // one place, and this is the chunk that both importers share. Total shipped
  // JavaScript did not grow — the copies elsewhere went away — so the honest
  // budget is the new shape rather than the old number.
  optionalExecutionTools: Object.freeze({ raw: 60 * 1024, gzip: 17 * 1024 }),
  // Pinned browser_wasi_shim plus Airship's bounded virtual-filesystem Worker.
  // It is fetched only when the precompiled WASI adapter executes a command.
  optionalWasiPreview1Worker: Object.freeze({ raw: 32 * 1024, gzip: 8 * 1024 }),
  // Page-local dependency reuse, full-source preflight, single-flight
  // activation, cancellation cleanup, and real npm readiness evidence make
  // install → build reliable in one conversation. The pack remains a
  // second-level lazy download and measures 26.14 KiB raw / 9.78 KiB gzip;
  // 11 KiB is the smallest whole-KiB ceiling with useful tripwire room.
  optionalNodeExecutionPack: Object.freeze({ raw: 32 * 1024, gzip: 11 * 1024 }),
  // `airship-sh`, the first-party POSIX-sh interpreter: lexer, parser,
  // expansion, arithmetic, globbing, redirection, job control, and the
  // workspace utilities it executes. It is the universal shell tier, so it
  // needs no Worker, no downloaded pack, and no cross-origin isolation — but
  // it is fetched only when a shell command actually runs, never at startup.
  optionalShellPack: Object.freeze({ raw: 100 * 1024, gzip: 30 * 1024 }),
  // The browser-Git client and the Git operations module that split out beside
  // it, both moved off first paint. Measured together at 16.44 KiB raw /
  // 3.95 KiB gzip; capped at the next whole step above that sum.
  optionalBrowserGitClient: Object.freeze({ raw: 18 * 1024, gzip: 5 * 1024 }),
  // The model-backed tool-action reviewer, fetched at adjudication time.
  optionalApprovalReviewer: Object.freeze({ raw: 6 * 1024, gzip: 2 * 1024 }),
  // Shared route chrome fetched with any route, never at first paint.
  optionalRoutePrimitives: Object.freeze({ raw: 24 * 1024, gzip: 8 * 1024 }),
  // Bounded provider/error projection is fetched on the first failed request
  // (or with a deferred provider route), not on a successful first paint.
  // Measured 2,583 B raw / 1,232 B gzip.
  //
  // The turn-failure vocabulary joined it here — the footer cause words, the
  // "nothing had arrived yet" rule and the chunk-load translation — because
  // they are fetched in the same handler at the same moment. This is a *net*
  // move off first paint: the entry chunk gave up those sentences to gain this
  // budget line. Measured together 4,797 B raw / 2,317 B gzip; each ceiling
  // takes the lowest whole KiB above the reading.
  optionalRequestFailure: Object.freeze({ raw: 5 * 1024, gzip: 3 * 1024 }),
  // Slash-command parser, registry, planner and completer.
  optionalSlashCommands: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  // The research WASIX candidate is intentionally absent from production
  // until its bidirectional workspace/output promotion probe passes.
  optionalWasixJavaScript: Object.freeze({ raw: 0, gzip: 0 }),
  optionalWasixWasm: Object.freeze({ raw: 0, gzip: 0 }),
  // The full inspect-act-verify loop is fetched on the first sent turn. Live
  // environment capture and persisted evidence scheduling put the measured
  // pack at 49,170 B raw / 14,093 B gzip: raw crossed the old cap by 18 bytes,
  // so only that ceiling takes the next whole-KiB step. First paint is fixed.
  optionalAgentRuntime: Object.freeze({ raw: 49 * 1024, gzip: 14 * 1024 }),
  // Image normalization is fetched only when a turn actually carries an image;
  // text-only first paint and text-only turns do not pay for it. Measured
  // 2,343 B raw / 1,153 B gzip.
  optionalMultimodal: Object.freeze({ raw: 3 * 1024, gzip: 2 * 1024 }),
  // Provider context-window policy construction runs only while binding a
  // model with an advertised limit. Measured 3,719 B raw / 1,321 B gzip.
  optionalContextPolicy: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  // The registry, local retrieval broker, live-environment projection, and
  // repository admission logic load together when an agent-capable workspace
  // is first constructed. Measured 124,352 B raw / 37,825 B gzip; the shared
  // pack remains absent from first paint.
  optionalAgentTools: Object.freeze({ raw: 128 * 1024, gzip: 38 * 1024 }),
  // Files/editor shell plus its in-page source-control handoff. Git remains a
  // second lazy pack; this cap covers only the combined Editor route chrome.
  // The workbench gained the behaviour its measured defects needed: a tree
  // filter with an honest shown/total count, a keyboard-operable rail
  // separator, a per-route identity, an orientation surface on the empty pane,
  // a merged file strip, and a modal that traps focus and closes on Escape.
  // The shared `<Tabs>`, `<RouteHeader>` and `<Popover>` primitives it adopted
  // are their own lazy chunks and are not counted here; first paint is
  // unchanged, because this pack is fetched only when the route opens.
  // It then gained folder operations, which the shipped route simply did not
  // have: a folder could be created only by typing a slash into a filename, and
  // could never be renamed or deleted at all. Because `WorkspacePort` stores
  // files and `buildWorkspaceTree` *derives* directories, each of those is a
  // per-file compare-and-swapped plan plus the copy that states its real cost
  // and its real partial outcome — that copy is most of the delta. The editor
  // also gained a persisted soft-wrap mode, replacing a `display: none` that
  // deleted the line-number gutter below 760px with nothing said.
  // Preview/persistent tabs, file-type identity, editor-hosted diffs and commit
  // history, and contextual Terminal/Source Control handoffs now make this a
  // real workbench rather than a file textarea. That work took the reading from
  // 65,918 B to 73,436 B raw.
  //
  // Pass 2 bought three more behaviours here: a real content search over
  // workspace files (`workspace/content-search.ts`, bounded and abortable — the
  // path filter structurally could not answer "which file says this"), an
  // empty-after-filter state that quotes the term and offers a way out, and the
  // shared destructive confirmation replacing this route's private copy.
  // The human-journey pass added the workspace's lost-work row and the Git
  // handoff the developer persona found missing, and then the eight-lane pass
  // added the workspace's own honest path line and its lost-work row.
  // Measured 80,247 B raw / 25,486 B gzip; both ceilings are the tightest
  // whole-KiB step that clears that reading. The route is still fetched only
  // when Workspace opens, so the fixed first-paint ceiling is untouched.
  optionalWorkspaceWorkbench: Object.freeze({ raw: 79 * 1024, gzip: 25 * 1024 }),
  // Held only the Git workspace binding, at 519 B raw / 345 B gzip. It now also
  // holds the one bounded content scan: `search_text` and the Explorer's Contents
  // filter both import it, so Rollup gives it to the chunk those two share rather
  // than inlining a copy in each — the Workspace route shed 1,556 raw bytes of
  // its own copy in the same build. The scan grew a resume cursor, an `include`
  // path glob and a summary that names every bound that fired, because the tool's
  // separate copy could answer "0 matches" for a filter that had selected no file
  // to search at all. Measured 3,844 B raw / 1,741 B gzip; both ceilings are the
  // tightest whole-KiB step that clears that reading. Still fetched only when the
  // Workspace route or the agent's tool bundle binds, so first paint is untouched.
  optionalWorkspaceBinding: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  optionalWorkspaceCodec: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  optionalSourceControl: Object.freeze({ raw: 48 * 1024, gzip: 14 * 1024 }),
  // Binds only when Vite emits the ~650-byte store as its own chunk. In the
  // current build it is inlined into its consumer, so these bytes are charged to
  // the carrier's class ceiling and this line is skipped rather than passed with a
  // zero — see resolveOptionalSourceSelectionDelivery.
  optionalSourceSelection: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  // Full standards-compatible Git engine. It is loaded once during browser
  // runtime boot, never preloaded with the shell, and remains independently
  // cacheable from the lightweight Source Control presentation pack.
  // The adapter includes real log/show/tag/stash/merge/restore/reset/remote
  // operations, per-operation abort checks, and remote-origin admission.
  // isomorphic-git's broad CommonJS SHA-1 fallback is replaced at build time
  // by Airship's byte-view-only equivalent; modern Web Crypto remains the
  // preferred path and legacy/pack hashing remains available. The reviewed
  // pack measures 256.78 KiB raw / 77.72 KiB gzip.
  optionalBrowserGit: Object.freeze({ raw: 276 * 1024, gzip: 83 * 1024 }),
  // Profile-local thread expansion, durable favorite order, coherent resume,
  // branch and true-fork affordances remain behind the Chat/session route.
  //
  // Pass 2 added the verb this product had promised and never had: deleting a
  // conversation, with the shared destructive confirmation and an announcement
  // that states what left and from where. It also lifted the list's silent
  // 200-row cap into a stated bound with a load-more control. Measured
  // 54,296 B raw / 15,964 B gzip, the tightest whole-KiB step above each; none
  // is in first paint.
  //
  // The brand/logo and rail pass re-measured this chunk at 55,476 B raw /
  // 16,346 B gzip: the module graph the vendor-mark and navigation work
  // changed shifted roughly a KiB of shared code into this bundle. The
  // transferred figure still clears its prior gzip step; only the raw figure
  // moves, one whole KiB above the new measurement.
  //
  // The local-device facade and vault danger-zone pass re-measured at 57,465 B
  // raw / 16,919 B gzip: the facade now carries the reclaim verb it was written
  // before, and the route packs the delete path end-to-end. Both steps move one
  // whole KiB above the new figures.
  // Deletion now forgets the return-ledger entry in the same breath, which is
  // what separates a decision from an accident: before it, deleting a thread and
  // returning the next day was reported as lost work. The route carries the
  // ledger's storage accessor and the forget call. Measured 59.58 KiB raw /
  // 17.78 KiB gzip; both steps move one whole KiB above the new figures.
  optionalSessionLibrary: Object.freeze({ raw: 60 * 1024, gzip: 18 * 1024 }),
  // Session pin/digest construction runs during profile-session activation,
  // after the shell can paint. Shared policy/mode code now owns its own lazy
  // chunk, leaving this one at 1,037 B raw / 546 B gzip.
  optionalSessionManifest: Object.freeze({ raw: 7 * 1024, gzip: 3 * 1024 }),
  // Pure keyboard/drop intent translation loads when a favorite is first
  // reordered; journal order remains owned by the Session Library.
  optionalFavoriteOrdering: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  // Historical true-fork audit, bounded context preparation, and seed sealing
  // are fetched only when a fork is requested (or the lazy agent validates a
  // fork lineage). Measured together at 12,672 B raw / 4,620 B gzip.
  optionalSessionFork: Object.freeze({ raw: 13 * 1024, gzip: 5 * 1024 }),
  // The lazy route now includes the live current/peak execution reading,
  // actionable primitive remediation, and the Companion relay/cache/compute
  // observation instead of making those capabilities settings-only facts.
  // Measured 12,409 B raw / 4,230 B gzip. Raw holds at 13 KiB, the smallest whole
  // KiB above it — the route had already outgrown 11 KiB, and 12 KiB does not fit
  // at all. Gzip comes back down to a half-KiB step: 4.5 KiB clears the
  // measurement by 378 bytes, where the 5 KiB it had been raised to granted 21% of
  // the pack as headroom that no measurement asked for. This route is fetched on
  // navigation; none of it enters first paint.
  optionalCapabilitiesView: Object.freeze({ raw: 13 * 1024, gzip: 4 * 1024 + 512 }),
  // Hardware/browser feature detection is requested after the shell starts so
  // it can select the strongest runtime without inflating the HTML preload set.
  // The Service Worker and Cache Storage probes push the raw pack to a measured
  // 16.95 KiB, held under a half-KiB step for the same reason as the route
  // above; gzip stays at 5.49 KiB, well under its unchanged ceiling.
  optionalBrowserCapabilities: Object.freeze({ raw: 17 * 1024 + 512, gzip: 6 * 1024 }),
  // Graph derivation and relationship controls load only on Memory/Context.
  // Raised once, deliberately, from 36 KiB / 12 KiB to a measured 45,950 B raw
  // / 15,976 B gzip. What the +3.6 KiB gzip bought, all of it lazily fetched
  // and none of it in the startup set: a destination and a human title on every
  // result; nine fields the federated search already computed and the view was
  // discarding (recordedAt, sequence, eventId, textDigest, createdAt,
  // profileRevisionAtCreation, createdInSessionId, denseScore, lexicalScore);
  // the per-group `ranking` / `legacyQuarantined` / `duplicatesSuppressed`
  // contracts, which rendered nowhere; the shared provenance disclosure that
  // makes those digests copyable instead of decorative; and a zero-result panel
  // that states what each corpus actually searched. Both ceilings moved with it,
  // from 45 KiB / 15.5 KiB: gzip crossed 15.5 KiB outright and takes the next
  // whole KiB, 16, which leaves 408 bytes; 45 KiB raw would have left 130, so raw
  // takes one step more and leaves 1,154. The startup ceiling is untouched — this
  // route has always been fetched on navigation.
  //
  // The human-journey pass answered the researcher's verdict — "Memory is a
  // beautifully instrumented read-only inspector" — by giving a result
  // somewhere to go: provenance that travels back into a conversation, and a
  // confidence reading that no longer presents bootstrap-embedding noise as a
  // result with the disqualifying score three disclosures deep.
  // Measured 52,861 B raw / 18,013 B gzip, each the tightest whole-KiB step.
  // Still fetched only on navigation to Memory.
  //
  // The lane that answered the second half of that verdict — a corpus a
  // researcher can browse, add to and prune, this tab's own search history,
  // and the evidence disclosure coming forward when a query settles — took the
  // route to a measured 61,402 B raw / 20,591 B gzip. Both steps go one whole
  // KiB beyond the tightest that fits, for the reason stated throughout this
  // file: 60 KiB raw would leave 38 bytes and 20 KiB gzip would leave none at
  // all, and a ceiling a minifier rename can breach is a tripwire rather than a
  // budget. Fetched only on navigation to Memory; first paint is untouched.
  optionalMemoryView: Object.freeze({ raw: 61 * 1024, gzip: 21 * 1024 }),
  // Small shared node-shape vocabulary split out by Vite because both the
  // Memory route and deferred graph renderer consume it.
  optionalMemorySupport: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  // The authoring panel for a `custom.` skill: form, its stylesheet's JS shim,
  // and nothing else. Deferred because the Skills route is a grid people read
  // far more often than they write, and the six built-ins cannot be edited at
  // all — a visitor who never presses New skill or Edit pays nothing for it.
  // Named in MEASUREMENT_JUSTIFIED_BUDGETS, so this pair is enforced rather
  // than merely written: a placeholder left here fails the gate instead of
  // surviving it. Measured 3,396 B raw / 1,320 B gzip.
  optionalSkillEditor: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  /*
   * The one destructive-confirmation dialog, shared rather than re-implemented.
   *
   * Workspace, Terminal and the conversation library each had their own scrim,
   * Escape handler, focus trap and button row; promoting them to one component
   * turned it into a chunk with more than one importer, which is exactly the
   * shape a shared primitive should have. It is budgeted here so the shape is
   * declared rather than merely tolerated by the classifier.
   *
   * Measured 1,010 B raw / 594 B gzip — one component, no dependencies of
   * its own beyond preact. Fetched with whichever of the three routes opens
   * first, never at first paint.
   */
  optionalConfirmDialog: Object.freeze({ raw: 1 * 1024, gzip: 1 * 1024 }),
  /*
   * The keyboard shortcut sheet.
   *
   * Eleven chords shipped with no printed form anywhere — `?`, `F1` and
   * `Shift+/` opened nothing, and the palette could not find the word
   * "shortcut" — so the sheet is new surface. New surface does not get to move
   * the first-paint ceiling: it is fetched the first time `?` or the palette's
   * footer asks for it, which is by definition after first paint.
   * Measured 2,993 B raw / 1,352 B gzip.
   */
  optionalShortcutSheet: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  /*
   * The command palette and preferences dialog, out of the entry chunk.
   *
   * Entry gzip breached its 112 KiB ceiling at 112.01 KiB, and review was right
   * that a budget a symbol rename can breach is not a budget. These two are
   * never on screen at first paint, so they left rather than the ceiling moving.
   * Entry came back to 110.54 KiB gzip — 1.46 KiB of headroom instead of 20
   * bytes. The shell warms this chunk on idle after first paint, so the first
   * Cmd+K is not slower for it. Measured 6.23 KiB raw / 2.46 KiB gzip.
   */
  optionalShellOverlays: Object.freeze({ raw: 7 * 1024, gzip: 3 * 1024 }),
  /*
   * The command palette's conversation verbs.
   *
   * Words only — the host keeps the availability rules and the callbacks — and
   * nothing here can paint before ⌘K, so it is fetched on first open rather
   * than shipped in first paint. Measured 979 B raw / 465 B gzip.
   */
  optionalPaletteActions: Object.freeze({ raw: 3 * 1024, gzip: 2 * 1024 }),
  /*
   * The lost-work report, and the timestamp helper it took with it.
   *
   * It renders only for a returning person whose previous session did not
   * survive — the rarest state the chat surface has — and it was imported
   * statically, which put it and its stylesheet in the entry chunk and pushed
   * first paint to 115.00 KiB gzip against a 112.00 KiB ceiling. Fetched on
   * demand it costs first paint nothing. The ledger it reads travels with it:
   * every caller was already asynchronous, so deferring 9.9 KiB of source cost
   * nothing at any call site. Measured 7,151 B raw / 2,795 B gzip.
   */
  optionalResumeReport: Object.freeze({ raw: 7 * 1024, gzip: 3 * 1024 }),
  /* See `isOptionalMessagePartsPath`. Measured 12,554 B raw / 4,516 B gzip. */
  optionalMessageParts: Object.freeze({ raw: 13 * 1024, gzip: 5 * 1024 }),
  /* See `isOptionalApprovalDockPath`. Measured after the accessibility pass. */
  optionalApprovalDock: Object.freeze({ raw: 24 * 1024, gzip: 8 * 1024 }),
  // Proof presentation and privacy-safe receipt serialization are fetched only
  // when the user opens the comprehensive Proof surface.
  // The claim rail (`proof-inspector`) and the one fail-closed receipt rule it
  // renders (`seal-states`) joined this pack when they stopped being defined
  // inside `app.tsx`. Nothing was added to the product: 1.69 KiB gzip of
  // first-paint weight moved out of `allJavaScriptAndWorkers` and landed here,
  // behind a panel that cannot render until a turn has produced a receipt.
  // That is the trade this file has taken three times before. Measured 74,690 B
  // raw, and gzip crossed the 23 KiB ceiling this pack shipped under
  // — by four bytes, but it crossed it — so it steps to 24 KiB and leaves 1,020;
  // the 25 KiB it was briefly raised to was a further step nothing measured asked
  // for. 73 KiB raw would have left 62 bytes, which a minifier rename can erase, so
  // raw held at 74 KiB and left 1,086.
  //
  // The human-journey pass raises raw to 76 KiB. Proof is the route the whole
  // product's promise rests on, and the Atlas caught it under-reporting: a
  // session that had staged and committed under two approvals exported an audit
  // declaring zero tool operations, and a local slash-command turn produced no
  // receipt while the transcript labelled it COMPLETED. An audit surface that
  // under-reports is worse than none, because it is believed.
  // The eight-lane pass then answered the rest of it: an operation ledger that
  // counts what actually ran, a receipt for a local turn that previously had
  // none, and provenance a reader can follow from a claim back to its source.
  // Measured 89,774 B raw / 27,986 B gzip, each the tightest whole-KiB step.
  // Still fetched only when Proof opens; first paint is untouched.
  optionalProofSurface: Object.freeze({ raw: 88 * 1024, gzip: 28 * 1024 }),
  // Receipt-keyed acquisition scheduling, its WorkspacePort CAS adapter, and
  // the credential-free endpoint-evidence record store. All three load only
  // when a Chutes credential can run or recover the worker, and none belongs to
  // first paint. The record store joined them here rather than staying unowned
  // and being charged to the startup ceiling it never loads with. Measured
  // together at 39.92 KiB raw / 12.31 KiB gzip.
  optionalEvidenceAcquisition: Object.freeze({ raw: 44 * 1024, gzip: 14 * 1024 }),
  // Official xterm.js is isolated behind the Terminal route and is never part
  // of initial navigation or a background capability probe. The dock state and
  // the Profile-owned manager travel with it; the vendor runtime dominates.
  //
  // Pass 2 gave the browser-Git bridge back its entry point. `runTerminalGitCommand`
  // — 17 git verb families with their own `git help`, approval-gated and unit
  // tested — had zero callers outside its own test, so stash, merge, tag, reset,
  // restore, rev-parse and remote management existed with no human path on any
  // device while docs/BROWSER_GIT.md still described them as reachable. It is
  // now wired to a command field on the route.
  //
  // The human-journey pass added the Git handoff the developer persona found
  // missing — a `git` typed into the PTY now offers to run on the real browser
  // Git bridge instead of failing at a shell with no git binary.
  // Measured 426,772 B raw / 111,821 B gzip, the tightest whole-KiB step above
  // each. Still fetched only when Terminal opens.
  optionalTerminal: Object.freeze({ raw: 420 * 1024, gzip: 111 * 1024 }),
  // Protocol host only. The reviewed Transformers/ORT/model artifacts remain
  // a separately mounted same-origin semantic pack and are never preloaded.
  optionalSemanticWorker: Object.freeze({ raw: 16 * 1024, gzip: 6 * 1024 }),
  // Model catalog + utilization normalization is loaded only when provider
  // discovery opens and is enforced separately from the interactive app.
  optionalModelCatalog: Object.freeze({ raw: 33 * 1024, gzip: 12 * 1024 }),
  // Multi-provider connection UI, page-lifetime provider fabric, credential-
  // free route contracts, and cloud transport adapters load with the
  // Connection route/runtime bootstrap. They are deliberately absent from the
  // HTML preload graph.
  // Raised once for genuinely new capability rather than growth in an existing
  // one: three provider OAuth grant shapes (paste-code PKCE, RFC 8628 device
  // code, refresh) plus the extension-bridge transport client. Measured
  // 116.14 KiB raw / 34.62 KiB gzip; these are the next whole steps above it.
  // The gzip step moved again for a split, not for new code: the bridge client
  // is now shared between the provider transports and the Connect surface's
  // presence observation, so it compresses as its own 10.65 KiB chunk instead
  // of inside the session route. Raw is unchanged at a measured 116.74 KiB;
  // only the lost cross-chunk compression is new, at 35.59 KiB gzip.
  // Includes the shared page-side companion protocol client used by both the
  // live Providers observation and the opt-in ciphertext cache backend.
  optionalInferenceProviders: Object.freeze({ raw: 124 * 1024, gzip: 38 * 1024 }),
  // Chutes registration metadata plus PKCE/token operations load for Connect,
  // an OAuth callback, or a scheduled refresh—never for first paint.
  //
  // Pass 2 separated the two opposite meanings of `invalid_client`: a localhost
  // bridge has process credentials to repair, a public PKCE client has a
  // registration to re-check, and the remedy for one is wrong for the other.
  // Measured together at 13,530 B raw / 5,125 B gzip.
  optionalChutesOAuth: Object.freeze({ raw: 14 * 1024, gzip: 6 * 1024 }),
  // Live companion observation shared by per-turn environment awareness and
  // deferred provider surfaces. Measured 3,179 B raw / 1,204 B gzip.
  optionalExtensionObservation: Object.freeze({ raw: 3 * 1024 + 512, gzip: 1 * 1024 + 512 }),
  // Local Device setup and its OPFS/IndexedDB key-custody runtime load only
  // after the user selects that Vault provider.
  optionalLocalDeviceVault: Object.freeze({ raw: 60 * 1024, gzip: 19 * 1024 }),
  optionalDcapQvlJavaScript: Object.freeze({ raw: 32 * 1024, gzip: 8 * 1024 }),
  optionalDcapQvlWasm: Object.freeze({ raw: 1536 * 1024, gzip: 512 * 1024 }),
  optionalPythonPack: Object.freeze({ raw: 16 * 1024 * 1024, gzip: 8 * 1024 * 1024 }),
  // First-paint weight: CSS blocks render, so this is deliberately tighter than
  // the JavaScript ceilings. The Pass 1 audit added per-claim capability copy,
  // the runtime-load indicator, a keyboard-operable workbench splitter and the
  // phone pane rules.
  //
  // Pass 2 added the missing empty/error states, the coarse-pointer touch floor
  // at the primitive layer, and one shared search-field recipe (2,043 B) that
  // is in the always-loaded barrel on purpose: imported directly by Memory and
  // Context — two lazy routes — it formed a shared CSS chunk that pulled
  // `memory-graph/kind-visual` into the same chunk group and merged it away.
  // Duplicating the recipe per route was the alternative and is worse on both
  // counts.
  //
  // It also keeps the session bar to one row under 400px wide and on short
  // landscape screens, where wrapping cost 46px of a 375px-tall viewport and
  // left 93px of transcript.
  //
  // Measured 171,150 B raw / 29,523 B gzip when it moved to 168 KiB. The
  // brand-mark, vault-usage, rail-depth, profile-editor and one-row mobile
  // chrome pass re-measured at 172,367 B raw / 29,891 B gzip — and the owner
  // asked for the ceiling raised with the work, not the work thinned. Only
  // the raw ceiling moves, two whole KiB this time. The transferred figure —
  // the one that actually blocks render — still clears its unchanged 32 KiB
  // ceiling by 2.8 KiB, and the JS startup ceiling is separately fixed and
  // untouched.
  //
  // The eight-lane pass takes raw one further KiB, to 171, for the styles the
  // journeys needed: the shortcut sheet, the egress panel, the resume and
  // quarantine reports, and the workspace's lost-work row. Measured 174,407 B
  // raw / 29,532 B gzip. Gzip does not move and is not close: 28.84 KiB inside
  // a 32 KiB ceiling. Entry JavaScript, the other first-paint ceiling, is
  // untouched at 111.59 KiB.
  //
  // Skill authoring takes raw one further KiB, to 172, for two rules the route
  // could not be honest without: the Edit/Remove row on an authored card, which
  // wraps rather than scrolls so a Remove button cannot leave the card at 320px;
  // and the coarse-pointer floor for this route's own two controls, a 37px
  // `role="switch"` toggle and a 38px mode trigger that the product-wide
  // `.small-button` floor never covered. The panel's own stylesheet is NOT here
  // — it ships with the deferred `skill-editor` chunk. Measured 175,303 B raw /
  // 29,655 B gzip. Gzip does not move and is not close: 28.96 KiB inside a
  // 32 KiB ceiling.
  entryCss: Object.freeze({ raw: 172 * 1024, gzip: 32 * 1024 }),
  eachWasm: Object.freeze({ raw: 1024 * 1024, gzip: 350 * 1024 }),
  allWasm: Object.freeze({ raw: 1024 * 1024, gzip: 350 * 1024 }),
});

const secretPatterns = Object.freeze([
  ["Chutes client secret", /\bcsc_[A-Za-z0-9_-]{16,}\b/u],
  ["Chutes user credential", /\bcak_[A-Za-z0-9_-]{16,}\b/u],
  ["Chutes inference key", /\bcpk_[A-Za-z0-9_-]{16,}\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["npm token", /\bnpm_[A-Za-z0-9]{24,}\b/u],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["Stripe live secret", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u],
  ["PEM private key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u],
  ["long bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}\b/u],
]);

const sourceMapDirective = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/u;
const PYODIDE_ASSET_PATHS = Object.freeze([
  "execution-packs/pyodide/pyodide.mjs",
  "execution-packs/pyodide/pyodide.asm.mjs",
  "execution-packs/pyodide/pyodide.asm.wasm",
  "execution-packs/pyodide/pyodide-lock.json",
  "execution-packs/pyodide/python_stdlib.zip",
]);

export function inspectPayload(path, payload) {
  const findings = [];
  if (/\.map(?:\.(?:br|gz))?$/u.test(path)) findings.push("production source map");
  const text = `${path}\0${payload.toString("utf8")}`;
  if (sourceMapDirective.test(text)) findings.push("sourceMappingURL directive");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) findings.push(label);
  }
  return Object.freeze(findings);
}

export function createReleaseManifest(artifacts) {
  return Object.freeze({
    schema: "airship.release-manifest.v1",
    hashAlgorithm: "sha256",
    signed: false,
    artifacts: Object.freeze(
      [...artifacts]
        .sort((left, right) => compareText(left.path, right.path))
        .map((artifact) =>
          Object.freeze({
            path: artifact.path,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          }),
        ),
    ),
  });
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function assertWithinBudget(label, measurement, budget) {
  /*
   * A budget line is a guarantee only while it compares two real byte counts.
   * `undefined > limit` and `null > limit` are both false, so the cheapest way to
   * retire a ceiling without anyone noticing is to hand this function something
   * that is not a measurement — which is exactly what happened when a pack that
   * Vite had inlined was reported as a fabricated zero. Refuse to answer instead
   * of answering "within budget".
   */
  for (const [role, value] of [
    ["measurement", measurement],
    ["budget", budget],
  ]) {
    const raw = value?.raw;
    const gzip = value?.gzip;
    if (!Number.isInteger(raw) || !Number.isInteger(gzip) || raw < 0 || gzip < 0) {
      throw new Error(`${label} cannot be checked against a release budget: its ${role} is not a raw/gzip byte count.`);
    }
  }
  const exceeded = [];
  if (measurement.raw > budget.raw) {
    exceeded.push(`raw ${formatBytes(measurement.raw)} > ${formatBytes(budget.raw)}`);
  }
  if (measurement.gzip > budget.gzip) {
    exceeded.push(`gzip ${formatBytes(measurement.gzip)} > ${formatBytes(budget.gzip)}`);
  }
  if (exceeded.length > 0) throw new Error(`${label} exceeds its release budget: ${exceeded.join(", ")}.`);
}

/*
 * Ceilings whose comment is required to state the measurement that sets them, in
 * this file's `Measured <raw> raw / <gzip> gzip` form. Not every budget is here:
 * several carry justifications older than this guard, and a name joins the list
 * when its pack is next measured rather than being retro-fitted with a figure
 * nobody re-took. Adding one is a commitment — the comment has to keep recording a
 * real build, and it may never record a figure its own ceiling would reject.
 */
export const MEASUREMENT_JUSTIFIED_BUDGETS = Object.freeze([
  "deferredCapabilities",
  "optionalWorkspaceWorkbench",
  "optionalCapabilitiesView",
  "optionalMemoryView",
  "optionalProofSurface",
  "optionalSkillEditor",
]);

/*
 * Every ceiling in RELEASE_BUDGETS is justified by a measurement written in the
 * comment above it, and that comment is the only place a reviewer can see what a
 * raise bought. Nothing held the two together: three ceilings were raised in one
 * pass while their comments still recorded the previous build, and one of them
 * asserted that the gzip ceiling "do[es] not move" on the line above the constant
 * that moved it. A stale justification is worse than none, because it reads as
 * confirmation that transferred weight did not grow.
 *
 * Three rules, so that a comment and the constant it explains cannot silently
 * disagree again. No figure a comment records may exceed the ceiling it justifies —
 * a ceiling that rejects its own stated measurement is describing a build nobody
 * shipped. The budgets above must each still state a measurement at all, so a raise
 * cannot be laundered by deleting the number it contradicts. And each ceiling must
 * be the smallest whole-KiB step that clears its measurement, unless the comment
 * says for that role what the tighter step would have left — the sentence this file
 * already writes when it declines a ceiling a minifier rename could breach. The
 * three ceilings raised against stale comments each granted 10–18% of new transfer
 * budget in silence; that last rule is what refuses it, because the extra step now
 * costs a sentence naming the bytes it bought.
 */
export function assertDocumentedBudgetMeasurements(source) {
  const failures = [];
  const seen = new Set();
  for (const entry of parseDocumentedBudgets(source)) {
    seen.add(entry.name);
    for (const figure of entry.figures) {
      const ceiling = entry.budget[figure.role];
      if (figure.bytes > ceiling) {
        failures.push(
          `${entry.name}: its comment records ${figure.text} ${figure.role}, above the ${formatBytes(ceiling)} ${figure.role} ceiling it justifies`,
        );
      }
    }
    if (!MEASUREMENT_JUSTIFIED_BUDGETS.includes(entry.name)) continue;
    // The largest pair a comment states is the one its ceilings have to clear; a
    // comment may also quote a delta or the reading it grew from.
    const documented = entry.measured.reduce((largest, pair) => (largest && largest.raw >= pair.raw ? largest : pair), null);
    if (!documented) {
      failures.push(`${entry.name}: its comment no longer records a measured raw/gzip pair for the ceiling it sets`);
      continue;
    }
    for (const role of ["raw", "gzip"]) {
      const ceiling = entry.budget[role];
      const steps = new RegExp(`${role} would have left \\d`, "u").test(entry.prose) ? 2 : 1;
      const allowed = (Math.floor(documented[role] / 1024) + steps) * 1024;
      if (ceiling > allowed) {
        failures.push(
          `${entry.name}: the ${formatBytes(ceiling)} ${role} ceiling is above the smallest whole-KiB step that clears the documented ${formatBytes(documented[role])}; take the tighter step, or say in the comment what "<n> KiB ${role} would have left"`,
        );
      }
    }
  }
  for (const name of MEASUREMENT_JUSTIFIED_BUDGETS) {
    if (!seen.has(name)) failures.push(`${name}: named as measurement-justified but no such release budget was found`);
  }
  if (failures.length > 0) {
    throw new Error(`Release budget comments disagree with their ceilings:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * Pairs each `name: Object.freeze({ raw, gzip })` ceiling with the contiguous
 * comment block directly above it and the byte figures that block states. Parsing
 * this file's own comments is unusual; it is warranted because those comments are
 * the ceilings' only justification, and an unchecked justification is the defect
 * this guards against.
 */
function parseDocumentedBudgets(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("export const RELEASE_BUDGETS"));
  if (start < 0) throw new Error("Release budgets are not declared where the documentation guard expects them.");
  const entries = [];
  let comment = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "});") break;
    const commentText = /^\s*\/\/ ?(.*)$/u.exec(line);
    if (commentText) {
      comment.push(commentText[1]);
      continue;
    }
    const budget = /^\s{2}([A-Za-z][A-Za-z0-9]*): Object\.freeze\(\{ raw: ([^,]+), gzip: ([^}]+?) \}\),$/u.exec(line);
    if (budget) {
      const prose = comment.join(" ");
      entries.push(
        Object.freeze({
          name: budget[1],
          budget: Object.freeze({ raw: evaluateByteExpression(budget[2]), gzip: evaluateByteExpression(budget[3]) }),
          prose,
          figures: Object.freeze(parseByteFigures(prose)),
          measured: Object.freeze(parseMeasuredPairs(prose)),
        }),
      );
    }
    comment = [];
  }
  return entries;
}

/**
 * Budget ceilings are written as whole/half-KiB arithmetic — `46 * 1024`,
 * `4 * 1024 + 512` — so a sum of products is the whole grammar. Evaluating it by
 * hand rather than with `Function` keeps a build script free of a code path that
 * runs text as code, however well fenced.
 */
function evaluateByteExpression(expression) {
  let total = 0;
  for (const term of expression.split("+")) {
    let product = 1;
    for (const factor of term.split("*")) {
      const value = Number(factor.trim());
      if (!Number.isInteger(value) || value < 0) throw new Error(`Unexpected release budget expression: ${expression}.`);
      product *= value;
    }
    total += product;
  }
  return total;
}

const BYTE_FIGURE = /(\d[\d,]*(?:\.\d+)?)\s(KiB|MiB|B)\s(raw|gzip)\b/gu;
// Only figures the file presents as a measurement of *this* pack anchor the
// tightness rule; the same comment may also quote a delta or another surface.
const MEASURED_PAIR =
  /[Mm]easur\w*[^.;]{0,80}?(\d[\d,]*(?:\.\d+)?)\s(KiB|MiB|B)\sraw\s*\/\s*(\d[\d,]*(?:\.\d+)?)\s(KiB|MiB|B)\sgzip/gu;

function parseByteFigures(prose) {
  return [...prose.matchAll(BYTE_FIGURE)].map((match) =>
    Object.freeze({ text: `${match[1]} ${match[2]}`, role: match[3], bytes: toBytes(match[1], match[2]) }),
  );
}

function parseMeasuredPairs(prose) {
  return [...prose.matchAll(MEASURED_PAIR)].map((match) =>
    Object.freeze({ raw: toBytes(match[1], match[2]), gzip: toBytes(match[3], match[4]) }),
  );
}

function toBytes(value, unit) {
  const scale = unit === "MiB" ? 1024 * 1024 : unit === "KiB" ? 1024 : 1;
  return Math.round(Number(value.replaceAll(",", "")) * scale);
}

/** A researched runtime that failed promotion must contribute zero release artifacts. */
export function assertUnpromotedWasixAbsent(kind, paths) {
  if (paths.length !== 0) {
    throw new Error(`Production must not contain the unpromoted WASIX ${kind}; found ${paths.length} artifacts.`);
  }
}

/** Every emitted bundled JavaScript artifact has one, and only one, owner. */
export function assertExclusiveArtifactClassifications(paths, classifications) {
  const claims = new Map(paths.map((path) => [path, []]));
  for (const classification of classifications) {
    const uniquePaths = new Set(classification.paths);
    for (const path of uniquePaths) {
      const owners = claims.get(path);
      if (owners) owners.push(classification.name);
    }
  }
  const unclassified = [];
  const multiplyClassified = [];
  for (const [path, owners] of claims) {
    if (owners.length === 0) unclassified.push(path);
    if (owners.length > 1) multiplyClassified.push(`${path} (${owners.join(", ")})`);
  }
  if (unclassified.length || multiplyClassified.length) {
    const failures = [
      ...unclassified.map((path) => `unclassified: ${path}`),
      ...multiplyClassified.map((path) => `multiple classes: ${path}`),
    ];
    throw new Error(`JavaScript artifact classification failed:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * The in-memory Git adapter is a deterministic test fixture, not a production
 * runtime. Keep a literal sentinel in that adapter and fail the release if a
 * production JavaScript graph accidentally imports it again.
 */
export function assertNoSimulatedGitRuntime(files) {
  const sentinel = Buffer.from("airship-memory-git");
  const offenders = files
    .filter((file) => file.payload.includes(sentinel))
    .map((file) => file.path);
  if (offenders.length > 0) {
    throw new Error(
      `Production must not contain the simulated browser-Git runtime; found ${offenders.join(", ")}.`,
    );
  }
}

/**
 * The fork contract, as the shipped documentation states it.
 *
 * `SessionLibrary.fork` seals a bounded ancestor-context seed on every fork and
 * always returns `contextSeeded: true`. The doc described the pre-seed world —
 * "the source transcript is not copied" plus branching filed as future work —
 * so a reader who trusted it believed a fork begins blank. `historyCopied:
 * false` is true of the *journal* and was being read as a claim about the
 * model's context; the two facts have to appear together or the true one reads
 * as the false one.
 *
 * Gated at release rather than left to a unit test because this is a promise
 * made to whoever ships and operates the build, and prose drifts back silently
 * the moment the code that contradicts it is the only thing under test.
 */
export function assertForkContractDocumented(source) {
  const failures = [];
  // The blank-slate vocabulary, in the one doc that defines the operation.
  for (const claim of ["empty transcript", "clean fork"]) {
    if (source.includes(claim)) failures.push(`states the pre-seed claim "${claim}"`);
  }
  // "The source *journal* is not copied" is true and worth saying. "The source
  // *transcript* is not copied" is the same sentence aimed at the thing the
  // fork does carry, and it is the exact substitution that made a seeded
  // branch read as a blank one.
  if (/source transcript is not\s+copied/iu.test(source)) {
    failures.push("calls the seeded ancestor context a transcript that is not copied");
  }
  if (/future protocol[\s\S]{0,120}branching/iu.test(source)) {
    failures.push("still files conversational branching as future work");
  }
  // Naming the seed is not enough: a reader needs the event that carries it and
  // the two bounds that decide what it leaves behind, or "bounded" is a word.
  for (const term of [
    "FORK_CONTEXT_EVENT_TYPE",
    "contextSeeded",
    "historyCopied",
    "MAX_FORK_CONTEXT_MESSAGES",
    "MAX_FORK_CONTEXT_BYTES",
  ]) {
    if (!source.includes(term)) failures.push(`never names ${term}`);
  }
  if (failures.length > 0) {
    throw new Error(`docs/SESSION_LIBRARY.md misdescribes the fork contract: it ${failures.join("; ")}.`);
  }
}

export async function runReleaseGate(outputDirectory = defaultOutput) {
  // The ceilings below are only as trustworthy as the measurements that justify
  // them, so the gate checks its own justifications before it checks the build.
  assertDocumentedBudgetMeasurements(await readFile(fileURLToPath(import.meta.url), "utf8"));
  const output = resolve(outputDirectory);
  const files = await collectFiles(output);
  const manifestPath = posix.normalize(RELEASE_MANIFEST_NAME);
  const releasableFiles = files.filter((file) => file.path !== manifestPath);
  const failures = [];

  for (const file of releasableFiles) {
    for (const finding of inspectPayload(file.path, file.payload)) {
      failures.push(`${redactSensitiveText(file.path)}: ${finding}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Release payload rejected:\n- ${failures.join("\n- ")}`);
  }

  const required = [
    "_headers",
    "favicon.svg",
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "extension/index.html",
    "extension/install.css",
    "extension/install.js",
    "extension/privacy.html",
    "extension/releases/release.json",
    "extension/releases/SHA256SUMS",
    "extension/releases/airship-companion-chromium-development.zip",
    "extension/releases/airship-companion-chromium-release.zip",
    "extension/releases/airship-companion-firefox-development.zip",
    "extension/releases/airship-companion-firefox-release.zip",
    "extension/releases/airship-companion-safari-development.zip",
    "extension/releases/airship-companion-safari-release.zip",
  ];
  const fileMap = new Map(releasableFiles.map((file) => [file.path, file]));
  for (const path of required) {
    if (!fileMap.has(path)) throw new Error(`Required static artifact is missing: ${path}.`);
  }

  await validatePublicCopies(output, required.filter((path) => path !== "index.html"));
  assertForkContractDocumented(await readFile(resolve(root, "docs", "SESSION_LIBRARY.md"), "utf8"));
  const headers = fileMap.get("_headers").payload.toString("utf8");
  const index = fileMap.get("index.html").payload.toString("utf8");
  validateHeaders(headers);
  validateBuiltCsp(index, headers);
  assertOptionalPacksAreNotPreloaded(index);
  validateWebManifest(fileMap.get("manifest.webmanifest").payload.toString("utf8"), index);
  validateServiceWorker(fileMap.get("sw.js").payload.toString("utf8"));

  const entries = parseHtmlEntries(index);
  if (entries.scripts.length !== 1) {
    throw new Error(`Production index must load exactly one module entry; found ${entries.scripts.length}.`);
  }
  if (entries.styles.length !== 1) {
    throw new Error(`Production index must load exactly one stylesheet entry; found ${entries.styles.length}.`);
  }
  const entryJavaScript = requireAsset(fileMap, entries.scripts[0], ".js");
  const initialJavaScriptFiles = [
    entryJavaScript,
    ...entries.modulePreloads.map((url) => requireAsset(fileMap, url, ".js")),
  ].filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index);
  const entryCss = requireAsset(fileMap, entries.styles[0], ".css");
  const pyodideFiles = PYODIDE_ASSET_PATHS.map((path) => requireReleaseFile(fileMap, path));
  const wasmFiles = releasableFiles.filter((file) => file.path.endsWith(".wasm") && !isOptionalPythonPackPath(file.path));
  if (wasmFiles.length === 0) throw new Error("The production build is missing the Chutes crypto WASM artifact.");

  const entryJavaScriptMeasurement = measure(entryJavaScript.payload);
  const initialJavaScriptMeasurement = sumMeasurements(initialJavaScriptFiles.map((file) => measure(file.payload)));
  const entryCssMeasurement = measure(entryCss.payload);
  const serviceWorker = requireReleaseFile(fileMap, "sw.js");
  const serviceWorkerMeasurement = measure(serviceWorker.payload);
  const javaScriptFiles = releasableFiles.filter(
    (file) => (file.path.endsWith(".js") || file.path.endsWith(".mjs"))
      && file.path !== "sw.js"
      && !isOptionalPythonPackPath(file.path),
  );
  assertNoSimulatedGitRuntime(javaScriptFiles);
  const optionalExecutionPacks = javaScriptFiles.filter((file) => isOptionalExecutionPackPath(file.path));
  if (optionalExecutionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution pack; found ${optionalExecutionPacks.length}.`);
  }
  const optionalExecutionPackMeasurement = measure(optionalExecutionPacks[0].payload);
  const optionalExecutionEnginePacks = javaScriptFiles.filter((file) => isOptionalExecutionEnginePath(file.path));
  if (optionalExecutionEnginePacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution engine; found ${optionalExecutionEnginePacks.length}.`);
  }
  const optionalExecutionEngineMeasurement = measure(optionalExecutionEnginePacks[0].payload);
  const optionalExecutionSupportPacks = javaScriptFiles.filter((file) => isOptionalExecutionSupportPath(file.path));
  if (optionalExecutionSupportPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution support chunk; found ${optionalExecutionSupportPacks.length}.`);
  }
  const optionalExecutionSupportMeasurement = measure(optionalExecutionSupportPacks[0].payload);
  const optionalExecutionToolPacks = javaScriptFiles.filter((file) => isOptionalExecutionToolsPath(file.path));
  if (optionalExecutionToolPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional execution-tools implementation; found ${optionalExecutionToolPacks.length}.`);
  }
  const optionalExecutionToolsMeasurement = measure(optionalExecutionToolPacks[0].payload);
  const optionalWasiPreview1WorkerPacks = javaScriptFiles.filter((file) => isOptionalWasiPreview1WorkerPath(file.path));
  if (optionalWasiPreview1WorkerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional WASI Preview 1 Worker; found ${optionalWasiPreview1WorkerPacks.length}.`);
  }
  const optionalWasiPreview1WorkerMeasurement = measure(optionalWasiPreview1WorkerPacks[0].payload);
  const optionalNodeExecutionPacks = javaScriptFiles.filter((file) => isOptionalNodeExecutionPackPath(file.path));
  if (optionalNodeExecutionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Node execution pack; found ${optionalNodeExecutionPacks.length}.`);
  }
  const optionalNodeExecutionPackMeasurement = measure(optionalNodeExecutionPacks[0].payload);
  // The interpreter may split into more than one chunk; the budget governs
  // their sum, because a user who runs one shell command fetches all of them.
  const optionalShellPacks = javaScriptFiles.filter((file) => isOptionalShellPackPath(file.path));
  if (optionalShellPacks.length === 0) {
    throw new Error("Production must contain the first-party airship-sh shell pack; found none.");
  }
  const optionalShellPackMeasurement = sumMeasurements(optionalShellPacks.map((file) => measure(file.payload)));
  const optionalWasixJavaScriptPacks = javaScriptFiles.filter((file) => isOptionalWasixJavaScriptPath(file.path));
  assertUnpromotedWasixAbsent("JavaScript candidate", optionalWasixJavaScriptPacks.map((file) => file.path));
  const optionalWasixJavaScriptMeasurement = sumMeasurements(
    optionalWasixJavaScriptPacks.map((file) => measure(file.payload)),
  );
  const optionalAgentRuntimePacks = javaScriptFiles.filter((file) => isOptionalAgentRuntimePath(file.path));
  if (optionalAgentRuntimePacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional agent runtime; found ${optionalAgentRuntimePacks.length}.`);
  }
  const optionalAgentRuntimeMeasurement = measure(optionalAgentRuntimePacks[0].payload);
  const optionalMultimodalPacks = javaScriptFiles.filter((file) => isOptionalMultimodalPath(file.path));
  if (optionalMultimodalPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional multimodal pack; found ${optionalMultimodalPacks.length}.`);
  }
  const optionalMultimodalMeasurement = measure(optionalMultimodalPacks[0].payload);
  const optionalContextPolicyPacks = javaScriptFiles.filter((file) => isOptionalContextPolicyPath(file.path));
  if (optionalContextPolicyPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional context-policy pack; found ${optionalContextPolicyPacks.length}.`);
  }
  const optionalContextPolicyMeasurement = measure(optionalContextPolicyPacks[0].payload);
  const optionalAgentToolPacks = javaScriptFiles.filter((file) => isOptionalAgentToolsPath(file.path));
  if (optionalAgentToolPacks.length !== 4) {
    throw new Error(`Production must contain exactly four optional agent-tool chunks; found ${optionalAgentToolPacks.length}.`);
  }
  const optionalAgentToolsMeasurement = sumMeasurements(optionalAgentToolPacks.map((file) => measure(file.payload)));
  const optionalWorkspaceWorkbenchPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceWorkbenchPath(file.path));
  if (optionalWorkspaceWorkbenchPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Workspace workbench pack; found ${optionalWorkspaceWorkbenchPacks.length}.`);
  }
  const optionalWorkspaceWorkbenchMeasurement = measure(optionalWorkspaceWorkbenchPacks[0].payload);
  const optionalWorkspaceBindingPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceBindingPath(file.path));
  if (optionalWorkspaceBindingPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional workspace-binding chunk; found ${optionalWorkspaceBindingPacks.length}.`);
  }
  const optionalWorkspaceBindingMeasurement = measure(optionalWorkspaceBindingPacks[0].payload);
  const optionalWorkspaceCodecPacks = javaScriptFiles.filter((file) => isOptionalWorkspaceCodecPath(file.path));
  if (optionalWorkspaceCodecPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional workspace codec; found ${optionalWorkspaceCodecPacks.length}.`);
  }
  const optionalWorkspaceCodecMeasurement = measure(optionalWorkspaceCodecPacks[0].payload);
  const optionalSourceControlPacks = javaScriptFiles.filter((file) => isOptionalSourceControlPath(file.path));
  if (optionalSourceControlPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional source-control pack; found ${optionalSourceControlPacks.length}.`);
  }
  const optionalSourceControlMeasurement = measure(optionalSourceControlPacks[0].payload);
  // The store either ships as its own chunk or is inlined into its consumer; the
  // key it persists is what proves it shipped, and what proves it is not eager.
  const optionalSourceSelectionPacks = javaScriptFiles.filter((file) => isOptionalSourceSelectionPath(file.path));
  const sourceSelectionKey = Buffer.from(SOURCE_SELECTION_STORAGE_KEY);
  if (initialJavaScriptFiles.some((file) => file.payload.includes(sourceSelectionKey))) {
    throw new Error("Source selection must not load at first paint.");
  }
  const optionalSourceSelectionDelivery = resolveOptionalSourceSelectionDelivery(
    optionalSourceSelectionPacks,
    javaScriptFiles.filter((file) => file.payload.includes(sourceSelectionKey)).map((file) => file.path),
  );
  const optionalBrowserGitPacks = javaScriptFiles.filter((file) => isOptionalBrowserGitPath(file.path));
  if (optionalBrowserGitPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional browser-Git engine pack; found ${optionalBrowserGitPacks.length}.`);
  }
  const optionalBrowserGitMeasurement = measure(optionalBrowserGitPacks[0].payload);
  // The Git client left the startup chunk with the adapter it is always awaited
  // beside; it is measured with the engine rather than against first paint.
  const optionalBrowserGitClientPacks = javaScriptFiles.filter((file) => isOptionalBrowserGitClientPath(file.path));
  if (optionalBrowserGitClientPacks.length === 0) {
    throw new Error("Production must contain the optional browser-Git client pack; found none.");
  }
  // The pack may split across more than one chunk; the budget governs their sum
  // because opening the Workspace fetches all of them together.
  const optionalBrowserGitClientMeasurement = sumMeasurements(optionalBrowserGitClientPacks.map((file) => measure(file.payload)));
  // The model-backed safety reviewer runs only when a governed tool action
  // needs adjudicating, so it is not first-paint cost.
  const optionalApprovalReviewerPacks = javaScriptFiles.filter((file) => isOptionalApprovalReviewerPath(file.path));
  if (optionalApprovalReviewerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional approval-reviewer pack; found ${optionalApprovalReviewerPacks.length}.`);
  }
  const optionalApprovalReviewerMeasurement = measure(optionalApprovalReviewerPacks[0].payload);
  const optionalSlashCommandPacks = javaScriptFiles.filter((file) => isOptionalSlashCommandPath(file.path));
  if (optionalSlashCommandPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional slash-command pack; found ${optionalSlashCommandPacks.length}.`);
  }
  const optionalSlashCommandMeasurement = measure(optionalSlashCommandPacks[0].payload);
  const optionalFileDownloadPacks = javaScriptFiles.filter((file) => isOptionalFileDownloadPath(file.path));
  const optionalRoutePrimitivePacks = javaScriptFiles.filter((file) => isOptionalRoutePrimitivePath(file.path));
  if (optionalRoutePrimitivePacks.length === 0) {
    throw new Error("Production must contain the shared route-primitive pack; found none.");
  }
  const optionalRoutePrimitiveMeasurement = sumMeasurements(optionalRoutePrimitivePacks.map((file) => measure(file.payload)));
  const optionalRequestFailurePacks = javaScriptFiles.filter((file) => isOptionalRequestFailurePath(file.path));
  // Two: the failure classifier and the failure vocabulary, deferred together.
  if (optionalRequestFailurePacks.length !== 2) {
    throw new Error(`Production must contain exactly two optional request-failure packs; found ${optionalRequestFailurePacks.length}.`);
  }
  const optionalRequestFailureMeasurement = sumMeasurements(optionalRequestFailurePacks.map((file) => measure(file.payload)));
  const optionalSessionLibraryPacks = javaScriptFiles.filter((file) => isOptionalSessionLibraryPath(file.path));
  if (optionalSessionLibraryPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional session-library pack; found ${optionalSessionLibraryPacks.length}.`);
  }
  const optionalSessionLibraryMeasurement = measure(optionalSessionLibraryPacks[0].payload);
  const optionalSessionManifestPacks = javaScriptFiles.filter((file) => isOptionalSessionManifestPath(file.path));
  if (optionalSessionManifestPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional session-manifest chunk; found ${optionalSessionManifestPacks.length}.`);
  }
  const optionalSessionManifestMeasurement = measure(optionalSessionManifestPacks[0].payload);
  const optionalFavoriteOrderingPacks = javaScriptFiles.filter((file) => isOptionalFavoriteOrderingPath(file.path));
  if (optionalFavoriteOrderingPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional favorite-ordering chunk; found ${optionalFavoriteOrderingPacks.length}.`);
  }
  const optionalFavoriteOrderingMeasurement = measure(optionalFavoriteOrderingPacks[0].payload);
  const optionalSessionForkPacks = javaScriptFiles.filter((file) => isOptionalSessionForkPath(file.path));
  if (optionalSessionForkPacks.length !== 2) {
    throw new Error(`Production must contain exactly two optional session-fork chunks; found ${optionalSessionForkPacks.length}.`);
  }
  const optionalSessionForkMeasurement = sumMeasurements(optionalSessionForkPacks.map((file) => measure(file.payload)));
  const optionalCapabilitiesViewPacks = javaScriptFiles.filter((file) => isOptionalCapabilitiesViewPath(file.path));
  if (optionalCapabilitiesViewPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Capabilities view; found ${optionalCapabilitiesViewPacks.length}.`);
  }
  const optionalCapabilitiesViewMeasurement = measure(optionalCapabilitiesViewPacks[0].payload);
  const optionalBrowserCapabilityPacks = javaScriptFiles.filter((file) => isOptionalBrowserCapabilityPath(file.path));
  if (optionalBrowserCapabilityPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional browser-capability pack; found ${optionalBrowserCapabilityPacks.length}.`);
  }
  const optionalBrowserCapabilityMeasurement = measure(optionalBrowserCapabilityPacks[0].payload);
  const optionalMemoryViewPacks = javaScriptFiles.filter((file) => isOptionalMemoryViewPath(file.path));
  if (optionalMemoryViewPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Memory view; found ${optionalMemoryViewPacks.length}.`);
  }
  const optionalMemoryViewMeasurement = measure(optionalMemoryViewPacks[0].payload);
  const optionalMemorySupportPacks = javaScriptFiles.filter((file) => isOptionalMemorySupportPath(file.path));
  if (optionalMemorySupportPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Memory support chunk; found ${optionalMemorySupportPacks.length}.`);
  }
  const optionalMemorySupportMeasurement = measure(optionalMemorySupportPacks[0].payload);
  const optionalSkillEditorPacks = javaScriptFiles.filter((file) => isOptionalSkillEditorPath(file.path));
  if (optionalSkillEditorPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional skill editor; found ${optionalSkillEditorPacks.length}.`);
  }
  const optionalSkillEditorMeasurement = measure(optionalSkillEditorPacks[0].payload);
  const optionalMessagePartsPacks = javaScriptFiles.filter((file) => isOptionalMessagePartsPath(file.path));
  if (optionalMessagePartsPacks.length !== 1) {
    throw new Error(`Production must contain exactly one message-parts pack; found ${optionalMessagePartsPacks.length}.`);
  }
  const optionalMessagePartsMeasurement = measure(optionalMessagePartsPacks[0].payload);
  const optionalApprovalDockPacks = javaScriptFiles.filter((file) => isOptionalApprovalDockPath(file.path));
  if (optionalApprovalDockPacks.length !== 1) {
    throw new Error(`Production must contain exactly one approval-dock pack; found ${optionalApprovalDockPacks.length}.`);
  }
  const optionalApprovalDockMeasurement = measure(optionalApprovalDockPacks[0].payload);
  const optionalResumeReportPacks = javaScriptFiles.filter((file) => isOptionalResumeReportPath(file.path));
  if (optionalResumeReportPacks.length !== 3) {
    throw new Error(`Production must contain the resume-report pack, its ledger and its format helper; found ${optionalResumeReportPacks.length}.`);
  }
  const optionalResumeReportMeasurement = sumMeasurements(optionalResumeReportPacks.map((file) => measure(file.payload)));
  const optionalConfirmDialogPacks = javaScriptFiles.filter((file) => isOptionalConfirmDialogPath(file.path));
  if (optionalConfirmDialogPacks.length !== 1) {
    throw new Error(`Production must contain exactly one shared confirm-dialog chunk; found ${optionalConfirmDialogPacks.length}.`);
  }
  const optionalConfirmDialogMeasurement = measure(optionalConfirmDialogPacks[0].payload);
  const optionalShellOverlayPacks = javaScriptFiles.filter((file) => isOptionalShellOverlayPath(file.path));
  if (optionalShellOverlayPacks.length !== 1) {
    throw new Error(`Production must contain exactly one deferred shell-overlay chunk; found ${optionalShellOverlayPacks.length}.`);
  }
  const optionalShellOverlayMeasurement = measure(optionalShellOverlayPacks[0].payload);
  const optionalShortcutSheetPacks = javaScriptFiles.filter((file) => isOptionalShortcutSheetPath(file.path));
  if (optionalShortcutSheetPacks.length !== 1) {
    throw new Error(`Production must contain exactly one keyboard-shortcut-sheet chunk; found ${optionalShortcutSheetPacks.length}.`);
  }
  const optionalShortcutSheetMeasurement = measure(optionalShortcutSheetPacks[0].payload);
  const optionalPaletteActionPacks = javaScriptFiles.filter((file) => isOptionalPaletteActionsPath(file.path));
  if (optionalPaletteActionPacks.length !== 1) {
    throw new Error(`Production must contain exactly one palette-actions chunk; found ${optionalPaletteActionPacks.length}.`);
  }
  const optionalPaletteActionsMeasurement = measure(optionalPaletteActionPacks[0].payload);
  const optionalProofSurfacePacks = javaScriptFiles.filter((file) => isOptionalProofSurfacePath(file.path));
  if (optionalProofSurfacePacks.length !== 6) {
    throw new Error(`Production must contain exactly six optional Proof-surface chunks; found ${optionalProofSurfacePacks.length}.`);
  }
  const optionalProofSurfaceMeasurement = sumMeasurements(optionalProofSurfacePacks.map((file) => measure(file.payload)));
  const optionalEvidenceAcquisitionPacks = javaScriptFiles.filter((file) => isOptionalEvidenceAcquisitionPath(file.path));
  if (optionalEvidenceAcquisitionPacks.length !== 3) {
    throw new Error(`Production must contain exactly three optional evidence-acquisition chunks; found ${optionalEvidenceAcquisitionPacks.length}.`);
  }
  const optionalEvidenceAcquisitionMeasurement = sumMeasurements(
    optionalEvidenceAcquisitionPacks.map((file) => measure(file.payload)),
  );
  const optionalTerminalPacks = javaScriptFiles.filter((file) => isOptionalTerminalPath(file.path));
  if (optionalTerminalPacks.length !== 3) {
    throw new Error(`Production must contain exactly three optional Terminal packs; found ${optionalTerminalPacks.length}.`);
  }
  const optionalTerminalMeasurement = sumMeasurements(optionalTerminalPacks.map((file) => measure(file.payload)));
  const optionalSemanticWorkerPacks = javaScriptFiles.filter((file) => isOptionalSemanticWorkerPath(file.path));
  if (optionalSemanticWorkerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional semantic worker; found ${optionalSemanticWorkerPacks.length}.`);
  }
  const optionalSemanticWorkerMeasurement = measure(optionalSemanticWorkerPacks[0].payload);
  const optionalModelCatalogPacks = javaScriptFiles.filter((file) => isOptionalModelCatalogPath(file.path));
  if (optionalModelCatalogPacks.length !== 3) {
    throw new Error(`Production must contain exactly three optional model-catalog packs; found ${optionalModelCatalogPacks.length}.`);
  }
  const optionalModelCatalogMeasurement = sumMeasurements(optionalModelCatalogPacks.map((file) => measure(file.payload)));
  // Six since the extension-bridge client became shared: the Connect surface
  // observes bridge presence with the same client the provider transports use,
  // so Rollup emits it once instead of embedding it in the session route.
  const optionalInferenceProviderPacks = javaScriptFiles.filter((file) => isOptionalInferenceProviderPath(file.path));
  if (optionalInferenceProviderPacks.length !== 6) {
    throw new Error(`Production must contain exactly six optional inference-provider packs; found ${optionalInferenceProviderPacks.length}.`);
  }
  const optionalInferenceProviderMeasurement = sumMeasurements(
    optionalInferenceProviderPacks.map((file) => measure(file.payload)),
  );
  const optionalChutesOAuthPacks = javaScriptFiles.filter((file) => isOptionalChutesOAuthPath(file.path));
  if (optionalChutesOAuthPacks.length !== 2) {
    throw new Error(`Production must contain exactly two optional Chutes OAuth chunks; found ${optionalChutesOAuthPacks.length}.`);
  }
  const optionalChutesOAuthMeasurement = sumMeasurements(optionalChutesOAuthPacks.map((file) => measure(file.payload)));
  const optionalExtensionObservationPacks = javaScriptFiles.filter((file) => isOptionalExtensionObservationPath(file.path));
  if (optionalExtensionObservationPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional extension-observation pack; found ${optionalExtensionObservationPacks.length}.`);
  }
  const optionalExtensionObservationMeasurement = measure(optionalExtensionObservationPacks[0].payload);
  const optionalLocalDeviceVaultPacks = javaScriptFiles.filter((file) => isOptionalLocalDeviceVaultPath(file.path));
  if (optionalLocalDeviceVaultPacks.length !== 5) {
    throw new Error(`Production must contain exactly five optional local-storage provider packs; found ${optionalLocalDeviceVaultPacks.length}.`);
  }
  const optionalLocalDeviceVaultMeasurement = sumMeasurements(
    optionalLocalDeviceVaultPacks.map((file) => measure(file.payload)),
  );
  const optionalDcapQvlPacks = javaScriptFiles.filter((file) => isOptionalDcapQvlPath(file.path));
  if (optionalDcapQvlPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional DCAP QVL JavaScript pack; found ${optionalDcapQvlPacks.length}.`);
  }
  const optionalDcapQvlJavaScriptMeasurement = measure(optionalDcapQvlPacks[0].payload);
  const optionalDcapQvlWasmFiles = wasmFiles.filter((file) => isOptionalDcapQvlWasmPath(file.path));
  if (optionalDcapQvlWasmFiles.length !== 1) {
    throw new Error(`Production must contain exactly one optional DCAP QVL WASM pack; found ${optionalDcapQvlWasmFiles.length}.`);
  }
  const optionalDcapQvlWasmMeasurement = measure(optionalDcapQvlWasmFiles[0].payload);
  const optionalWasixWasmFiles = wasmFiles.filter((file) => isOptionalWasixWasmPath(file.path));
  assertUnpromotedWasixAbsent("engine WASM", optionalWasixWasmFiles.map((file) => file.path));
  const optionalWasixWasmMeasurement = sumMeasurements(optionalWasixWasmFiles.map((file) => measure(file.payload)));
  const deferredCapabilityPacks = javaScriptFiles.filter((file) => isDeferredCapabilityPackPath(file.path));
  if (deferredCapabilityPacks.length !== 2) {
    throw new Error(`Production must contain exactly two deferred capability chunks; found ${deferredCapabilityPacks.length}.`);
  }
  const deferredCapabilityMeasurement = sumMeasurements(deferredCapabilityPacks.map((file) => measure(file.payload)));
  const optionalPythonPackMeasurement = sumMeasurements(pyodideFiles.map((file) => measure(file.payload)));
  const baselineJavaScriptFiles = javaScriptFiles.filter(
    (file) => !isOptionalExecutionPackPath(file.path)
      && !isOptionalExecutionEnginePath(file.path)
      && !isOptionalExecutionSupportPath(file.path)
      && !isOptionalExecutionToolsPath(file.path)
      && !isOptionalWasiPreview1WorkerPath(file.path)
      && !isOptionalNodeExecutionPackPath(file.path)
      && !isOptionalShellPackPath(file.path)
      && !isOptionalShellOverlayPath(file.path)
      && !isOptionalWasixJavaScriptPath(file.path)
      && !isOptionalAgentRuntimePath(file.path)
      && !isOptionalMultimodalPath(file.path)
      && !isOptionalContextPolicyPath(file.path)
      && !isOptionalAgentToolsPath(file.path)
      && !isOptionalWorkspaceWorkbenchPath(file.path)
      && !isOptionalWorkspaceBindingPath(file.path)
      && !isOptionalWorkspaceCodecPath(file.path)
      && !isOptionalSourceControlPath(file.path)
      && !isOptionalSourceSelectionPath(file.path)
      && !isOptionalBrowserGitPath(file.path)
      && !isOptionalBrowserGitClientPath(file.path)
      && !isOptionalApprovalReviewerPath(file.path)
      && !isOptionalRoutePrimitivePath(file.path)
      && !isOptionalFileDownloadPath(file.path)
      && !isOptionalRequestFailurePath(file.path)
      && !isOptionalSlashCommandPath(file.path)
      && !isOptionalSessionLibraryPath(file.path)
      && !isOptionalSessionManifestPath(file.path)
      && !isOptionalFavoriteOrderingPath(file.path)
      && !isOptionalSessionForkPath(file.path)
      && !isOptionalCapabilitiesViewPath(file.path)
      && !isOptionalBrowserCapabilityPath(file.path)
      && !isOptionalMemoryViewPath(file.path)
      && !isOptionalMemorySupportPath(file.path)
      && !isOptionalSkillEditorPath(file.path)
      && !isOptionalProofSurfacePath(file.path)
      && !isOptionalEvidenceAcquisitionPath(file.path)
      && !isOptionalTerminalPath(file.path)
      && !isOptionalSemanticWorkerPath(file.path)
      && !isOptionalModelCatalogPath(file.path)
      && !isOptionalInferenceProviderPath(file.path)
      && !isOptionalChutesOAuthPath(file.path)
      && !isOptionalExtensionObservationPath(file.path)
      && !isOptionalLocalDeviceVaultPath(file.path)
      && !isOptionalDcapQvlPath(file.path)
      && !isDeferredCapabilityPackPath(file.path)
      && !isCompanionInstallScriptPath(file.path),
  );
  const baselineJavaScriptMeasurement = sumMeasurements(baselineJavaScriptFiles.map((file) => measure(file.payload)));
  const vendorRuntimeFiles = [...optionalBrowserGitPacks, ...optionalTerminalPacks];
  const optionalVendorRuntimeMeasurement = sumMeasurements(vendorRuntimeFiles.map((file) => measure(file.payload)));
  const firstPartyJavaScriptFiles = [
    serviceWorker,
    ...javaScriptFiles.filter(
      (file) => !isOptionalBrowserGitPath(file.path)
        && !isOptionalTerminalPath(file.path)
        && !isCompanionInstallScriptPath(file.path),
    ),
  ];
  const firstPartyJavaScriptMeasurement = sumMeasurements(firstPartyJavaScriptFiles.map((file) => measure(file.payload)));
  const installedJavaScriptFiles = [
    serviceWorker,
    ...javaScriptFiles.filter((file) => !isCompanionInstallScriptPath(file.path)),
  ];
  const totalJavaScriptMeasurement = sumMeasurements(installedJavaScriptFiles.map((file) => measure(file.payload)));
  const companionInstallScripts = javaScriptFiles.filter((file) => isCompanionInstallScriptPath(file.path));
  if (companionInstallScripts.length !== 1) {
    throw new Error(`Production must contain exactly one Companion install script; found ${companionInstallScripts.length}.`);
  }
  const companionInstallScriptMeasurement = measure(companionInstallScripts[0].payload);

  assertExclusiveArtifactClassifications(
    [serviceWorker, ...javaScriptFiles].map((file) => file.path),
    [
      { name: "core-entry-and-preloads", paths: initialJavaScriptFiles.map((file) => file.path) },
      { name: "service-worker", paths: [serviceWorker.path] },
      { name: "deferred-capabilities", paths: deferredCapabilityPacks.map((file) => file.path) },
      { name: "execution-broker", paths: optionalExecutionPacks.map((file) => file.path) },
      { name: "execution-engine", paths: optionalExecutionEnginePacks.map((file) => file.path) },
      { name: "execution-support", paths: optionalExecutionSupportPacks.map((file) => file.path) },
      { name: "execution-tools", paths: optionalExecutionToolPacks.map((file) => file.path) },
      { name: "wasi-preview1-worker", paths: optionalWasiPreview1WorkerPacks.map((file) => file.path) },
      { name: "node-runtime", paths: optionalNodeExecutionPacks.map((file) => file.path) },
      { name: "airship-shell", paths: optionalShellPacks.map((file) => file.path) },
      { name: "wasix-runtime", paths: optionalWasixJavaScriptPacks.map((file) => file.path) },
      { name: "agent-runtime", paths: optionalAgentRuntimePacks.map((file) => file.path) },
      { name: "multimodal", paths: optionalMultimodalPacks.map((file) => file.path) },
      { name: "context-policy", paths: optionalContextPolicyPacks.map((file) => file.path) },
      { name: "agent-tools", paths: optionalAgentToolPacks.map((file) => file.path) },
      { name: "workspace-workbench", paths: optionalWorkspaceWorkbenchPacks.map((file) => file.path) },
      { name: "workspace-binding", paths: optionalWorkspaceBindingPacks.map((file) => file.path) },
      { name: "workspace-codec", paths: optionalWorkspaceCodecPacks.map((file) => file.path) },
      { name: "source-control", paths: optionalSourceControlPacks.map((file) => file.path) },
      { name: "source-selection", paths: optionalSourceSelectionPacks.map((file) => file.path) },
      { name: "browser-git-vendor", paths: optionalBrowserGitPacks.map((file) => file.path) },
      { name: "browser-git-client", paths: optionalBrowserGitClientPacks.map((file) => file.path) },
      { name: "approval-reviewer", paths: optionalApprovalReviewerPacks.map((file) => file.path) },
      { name: "route-primitives", paths: optionalRoutePrimitivePacks.map((file) => file.path) },
      { name: "file-download", paths: optionalFileDownloadPacks.map((file) => file.path) },
      { name: "request-failure", paths: optionalRequestFailurePacks.map((file) => file.path) },
      { name: "slash-commands", paths: optionalSlashCommandPacks.map((file) => file.path) },
      { name: "session-library", paths: optionalSessionLibraryPacks.map((file) => file.path) },
      { name: "session-manifest", paths: optionalSessionManifestPacks.map((file) => file.path) },
      { name: "favorite-ordering", paths: optionalFavoriteOrderingPacks.map((file) => file.path) },
      { name: "session-fork", paths: optionalSessionForkPacks.map((file) => file.path) },
      { name: "capabilities-view", paths: optionalCapabilitiesViewPacks.map((file) => file.path) },
      { name: "browser-capabilities", paths: optionalBrowserCapabilityPacks.map((file) => file.path) },
      { name: "memory-view", paths: optionalMemoryViewPacks.map((file) => file.path) },
      { name: "memory-support", paths: optionalMemorySupportPacks.map((file) => file.path) },
      { name: "skill-editor", paths: optionalSkillEditorPacks.map((file) => file.path) },
      { name: "confirm-dialog", paths: optionalConfirmDialogPacks.map((file) => file.path) },
      { name: "shortcut-sheet", paths: optionalShortcutSheetPacks.map((file) => file.path) },
      { name: "shell-overlays", paths: optionalShellOverlayPacks.map((file) => file.path) },
      { name: "palette-actions", paths: optionalPaletteActionPacks.map((file) => file.path) },
      { name: "resume-report", paths: optionalResumeReportPacks.map((file) => file.path) },
      { name: "approval-dock", paths: optionalApprovalDockPacks.map((file) => file.path) },
      { name: "message-parts", paths: optionalMessagePartsPacks.map((file) => file.path) },
      { name: "proof-surface", paths: optionalProofSurfacePacks.map((file) => file.path) },
      { name: "evidence-acquisition", paths: optionalEvidenceAcquisitionPacks.map((file) => file.path) },
      { name: "terminal-vendor", paths: optionalTerminalPacks.map((file) => file.path) },
      { name: "semantic-worker", paths: optionalSemanticWorkerPacks.map((file) => file.path) },
      { name: "model-catalog", paths: optionalModelCatalogPacks.map((file) => file.path) },
      { name: "inference-providers", paths: optionalInferenceProviderPacks.map((file) => file.path) },
      { name: "chutes-oauth", paths: optionalChutesOAuthPacks.map((file) => file.path) },
      { name: "extension-observation", paths: optionalExtensionObservationPacks.map((file) => file.path) },
      { name: "local-device-vault", paths: optionalLocalDeviceVaultPacks.map((file) => file.path) },
      { name: "dcap-qvl", paths: optionalDcapQvlPacks.map((file) => file.path) },
      { name: "companion-install", paths: companionInstallScripts.map((file) => file.path) },
    ],
  );
  const baselineWasmFiles = wasmFiles.filter(
    (file) => !isOptionalDcapQvlWasmPath(file.path) && !isOptionalWasixWasmPath(file.path),
  );
  const allWasmMeasurement = sumMeasurements(baselineWasmFiles.map((file) => measure(file.payload)));

  assertWithinBudget("Entry JavaScript", entryJavaScriptMeasurement, RELEASE_BUDGETS.entryJavaScript);
  assertWithinBudget(
    "Baseline JavaScript and workers",
    baselineJavaScriptMeasurement,
    RELEASE_BUDGETS.allJavaScriptAndWorkers,
  );
  assertWithinBudget(
    "Optional execution pack",
    optionalExecutionPackMeasurement,
    RELEASE_BUDGETS.optionalExecutionPack,
  );
  assertWithinBudget(
    "Optional execution engine",
    optionalExecutionEngineMeasurement,
    RELEASE_BUDGETS.optionalExecutionEngine,
  );
  assertWithinBudget(
    "Optional execution support",
    optionalExecutionSupportMeasurement,
    RELEASE_BUDGETS.optionalExecutionSupport,
  );
  assertWithinBudget(
    "Optional execution tools",
    optionalExecutionToolsMeasurement,
    RELEASE_BUDGETS.optionalExecutionTools,
  );
  assertWithinBudget(
    "Optional WASI Preview 1 Worker",
    optionalWasiPreview1WorkerMeasurement,
    RELEASE_BUDGETS.optionalWasiPreview1Worker,
  );
  assertWithinBudget(
    "Optional Node execution pack",
    optionalNodeExecutionPackMeasurement,
    RELEASE_BUDGETS.optionalNodeExecutionPack,
  );
  assertWithinBudget("Optional airship-sh shell pack", optionalShellPackMeasurement, RELEASE_BUDGETS.optionalShellPack);
  assertWithinBudget(
    "Optional WASIX JavaScript",
    optionalWasixJavaScriptMeasurement,
    RELEASE_BUDGETS.optionalWasixJavaScript,
  );
  assertWithinBudget("Optional WASIX engine WASM", optionalWasixWasmMeasurement, RELEASE_BUDGETS.optionalWasixWasm);
  assertWithinBudget("Optional agent runtime", optionalAgentRuntimeMeasurement, RELEASE_BUDGETS.optionalAgentRuntime);
  assertWithinBudget("Optional multimodal", optionalMultimodalMeasurement, RELEASE_BUDGETS.optionalMultimodal);
  assertWithinBudget("Optional context policy", optionalContextPolicyMeasurement, RELEASE_BUDGETS.optionalContextPolicy);
  assertWithinBudget("Optional agent tools", optionalAgentToolsMeasurement, RELEASE_BUDGETS.optionalAgentTools);
  assertWithinBudget(
    "Optional Workspace workbench",
    optionalWorkspaceWorkbenchMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceWorkbench,
  );
  assertWithinBudget(
    "Optional workspace binding",
    optionalWorkspaceBindingMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceBinding,
  );
  assertWithinBudget(
    "Optional workspace codec",
    optionalWorkspaceCodecMeasurement,
    RELEASE_BUDGETS.optionalWorkspaceCodec,
  );
  assertWithinBudget("Optional source control", optionalSourceControlMeasurement, RELEASE_BUDGETS.optionalSourceControl);
  // Only a dedicated chunk has bytes of its own to hold to this ceiling. When the
  // module is inlined the ceiling has nothing to govern, and the honest move is to
  // skip the line rather than feed it a zero that would pass unconditionally — the
  // carrier's own class budget is what bounds those bytes.
  if (optionalSourceSelectionDelivery.path) {
    assertWithinBudget("Optional source selection", optionalSourceSelectionDelivery, RELEASE_BUDGETS.optionalSourceSelection);
  }
  assertWithinBudget("Optional browser Git", optionalBrowserGitMeasurement, RELEASE_BUDGETS.optionalBrowserGit);
  assertWithinBudget("Optional browser-Git client", optionalBrowserGitClientMeasurement, RELEASE_BUDGETS.optionalBrowserGitClient);
  assertWithinBudget("Optional approval reviewer", optionalApprovalReviewerMeasurement, RELEASE_BUDGETS.optionalApprovalReviewer);
  assertWithinBudget("Optional route primitives", optionalRoutePrimitiveMeasurement, RELEASE_BUDGETS.optionalRoutePrimitives);
  assertWithinBudget("Optional request failure", optionalRequestFailureMeasurement, RELEASE_BUDGETS.optionalRequestFailure);
  assertWithinBudget("Optional slash commands", optionalSlashCommandMeasurement, RELEASE_BUDGETS.optionalSlashCommands);
  assertWithinBudget("Optional session library", optionalSessionLibraryMeasurement, RELEASE_BUDGETS.optionalSessionLibrary);
  assertWithinBudget("Optional session manifest", optionalSessionManifestMeasurement, RELEASE_BUDGETS.optionalSessionManifest);
  assertWithinBudget("Optional favorite ordering", optionalFavoriteOrderingMeasurement, RELEASE_BUDGETS.optionalFavoriteOrdering);
  assertWithinBudget("Optional session fork", optionalSessionForkMeasurement, RELEASE_BUDGETS.optionalSessionFork);
  assertWithinBudget("Optional Capabilities view", optionalCapabilitiesViewMeasurement, RELEASE_BUDGETS.optionalCapabilitiesView);
  assertWithinBudget(
    "Optional browser capabilities",
    optionalBrowserCapabilityMeasurement,
    RELEASE_BUDGETS.optionalBrowserCapabilities,
  );
  assertWithinBudget("Optional Memory view", optionalMemoryViewMeasurement, RELEASE_BUDGETS.optionalMemoryView);
  assertWithinBudget("Optional Memory support", optionalMemorySupportMeasurement, RELEASE_BUDGETS.optionalMemorySupport);
  assertWithinBudget("Optional skill editor", optionalSkillEditorMeasurement, RELEASE_BUDGETS.optionalSkillEditor);
  assertWithinBudget("Shared confirm dialog", optionalConfirmDialogMeasurement, RELEASE_BUDGETS.optionalConfirmDialog);
  assertWithinBudget("Optional shortcut sheet", optionalShortcutSheetMeasurement, RELEASE_BUDGETS.optionalShortcutSheet);
  assertWithinBudget("Optional shell overlays", optionalShellOverlayMeasurement, RELEASE_BUDGETS.optionalShellOverlays);
  assertWithinBudget("Optional palette actions", optionalPaletteActionsMeasurement, RELEASE_BUDGETS.optionalPaletteActions);
  assertWithinBudget("Optional resume report", optionalResumeReportMeasurement, RELEASE_BUDGETS.optionalResumeReport);
  assertWithinBudget("Optional approval dock", optionalApprovalDockMeasurement, RELEASE_BUDGETS.optionalApprovalDock);
  assertWithinBudget("Optional message parts", optionalMessagePartsMeasurement, RELEASE_BUDGETS.optionalMessageParts);
  assertWithinBudget("Optional Proof surface", optionalProofSurfaceMeasurement, RELEASE_BUDGETS.optionalProofSurface);
  assertWithinBudget(
    "Optional evidence acquisition",
    optionalEvidenceAcquisitionMeasurement,
    RELEASE_BUDGETS.optionalEvidenceAcquisition,
  );
  assertWithinBudget("Optional Terminal", optionalTerminalMeasurement, RELEASE_BUDGETS.optionalTerminal);
  assertWithinBudget("Optional semantic worker", optionalSemanticWorkerMeasurement, RELEASE_BUDGETS.optionalSemanticWorker);
  assertWithinBudget(
    "Optional model catalog",
    optionalModelCatalogMeasurement,
    RELEASE_BUDGETS.optionalModelCatalog,
  );
  assertWithinBudget(
    "Optional inference providers",
    optionalInferenceProviderMeasurement,
    RELEASE_BUDGETS.optionalInferenceProviders,
  );
  assertWithinBudget("Optional Chutes OAuth", optionalChutesOAuthMeasurement, RELEASE_BUDGETS.optionalChutesOAuth);
  assertWithinBudget(
    "Optional extension observation",
    optionalExtensionObservationMeasurement,
    RELEASE_BUDGETS.optionalExtensionObservation,
  );
  assertWithinBudget(
    "Optional Local Device Vault",
    optionalLocalDeviceVaultMeasurement,
    RELEASE_BUDGETS.optionalLocalDeviceVault,
  );
  assertWithinBudget(
    "Optional DCAP QVL JavaScript",
    optionalDcapQvlJavaScriptMeasurement,
    RELEASE_BUDGETS.optionalDcapQvlJavaScript,
  );
  assertWithinBudget(
    "Optional DCAP QVL WASM",
    optionalDcapQvlWasmMeasurement,
    RELEASE_BUDGETS.optionalDcapQvlWasm,
  );
  assertWithinBudget(
    "Deferred capability pack",
    deferredCapabilityMeasurement,
    RELEASE_BUDGETS.deferredCapabilities,
  );
  assertWithinBudget(
    "First-party JavaScript and workers",
    firstPartyJavaScriptMeasurement,
    RELEASE_BUDGETS.firstPartyJavaScriptAndWorkers,
  );
  assertWithinBudget(
    "Optional vendor runtime aggregate",
    optionalVendorRuntimeMeasurement,
    RELEASE_BUDGETS.optionalVendorRuntimeAggregate,
  );
  assertWithinBudget(
    "Total JavaScript and workers",
    totalJavaScriptMeasurement,
    RELEASE_BUDGETS.totalJavaScriptAndWorkers,
  );
  assertWithinBudget("Service worker", serviceWorkerMeasurement, RELEASE_BUDGETS.serviceWorker);
  assertWithinBudget(
    "Companion install script",
    companionInstallScriptMeasurement,
    RELEASE_BUDGETS.companionInstallScript,
  );
  assertWithinBudget("Optional Python pack", optionalPythonPackMeasurement, RELEASE_BUDGETS.optionalPythonPack);
  assertWithinBudget("Entry CSS", entryCssMeasurement, RELEASE_BUDGETS.entryCss);
  for (const wasm of baselineWasmFiles) {
    assertWithinBudget(`WASM ${wasm.path}`, measure(wasm.payload), RELEASE_BUDGETS.eachWasm);
  }
  assertWithinBudget("All WASM", allWasmMeasurement, RELEASE_BUDGETS.allWasm);

  const artifacts = releasableFiles.map((file) => ({
    path: file.path,
    bytes: file.payload.byteLength,
    sha256: createHash("sha256").update(file.payload).digest("hex"),
  }));
  const manifest = createReleaseManifest(artifacts);
  const serialized = serializeReleaseManifest(manifest);
  await writeFile(resolve(output, RELEASE_MANIFEST_NAME), serialized, { encoding: "utf8", mode: 0o644 });
  const written = await readFile(resolve(output, RELEASE_MANIFEST_NAME), "utf8");
  if (written !== serialized) throw new Error("Release manifest changed while it was being written.");

  return Object.freeze({
    manifest,
    manifestPath: resolve(output, RELEASE_MANIFEST_NAME),
    measurements: Object.freeze({
      entryJavaScript: entryJavaScriptMeasurement,
      initialJavaScriptAndPreloads: initialJavaScriptMeasurement,
      allJavaScriptAndWorkers: baselineJavaScriptMeasurement,
      baselineJavaScriptAndWorkers: baselineJavaScriptMeasurement,
      optionalExecutionPack: Object.freeze({ path: optionalExecutionPacks[0].path, ...optionalExecutionPackMeasurement }),
      optionalExecutionEngine: Object.freeze({
        path: optionalExecutionEnginePacks[0].path,
        ...optionalExecutionEngineMeasurement,
      }),
      optionalExecutionSupport: Object.freeze({
        path: optionalExecutionSupportPacks[0].path,
        ...optionalExecutionSupportMeasurement,
      }),
      optionalExecutionTools: Object.freeze({
        path: optionalExecutionToolPacks[0].path,
        ...optionalExecutionToolsMeasurement,
      }),
      optionalWasiPreview1Worker: Object.freeze({
        path: optionalWasiPreview1WorkerPacks[0].path,
        ...optionalWasiPreview1WorkerMeasurement,
      }),
      optionalNodeExecutionPack: Object.freeze({
        path: optionalNodeExecutionPacks[0].path,
        ...optionalNodeExecutionPackMeasurement,
      }),
      optionalWasixJavaScript: Object.freeze({
        paths: Object.freeze(optionalWasixJavaScriptPacks.map((file) => file.path)),
        ...optionalWasixJavaScriptMeasurement,
      }),
      optionalWasixWasm: Object.freeze({
        paths: Object.freeze(optionalWasixWasmFiles.map((file) => file.path)),
        ...optionalWasixWasmMeasurement,
      }),
      optionalAgentRuntime: Object.freeze({
        path: optionalAgentRuntimePacks[0].path,
        ...optionalAgentRuntimeMeasurement,
      }),
      optionalMultimodal: Object.freeze({
        path: optionalMultimodalPacks[0].path,
        ...optionalMultimodalMeasurement,
      }),
      optionalContextPolicy: Object.freeze({
        path: optionalContextPolicyPacks[0].path,
        ...optionalContextPolicyMeasurement,
      }),
      optionalAgentTools: Object.freeze({
        paths: Object.freeze(optionalAgentToolPacks.map((file) => file.path)),
        ...optionalAgentToolsMeasurement,
      }),
      optionalWorkspaceWorkbench: Object.freeze({
        path: optionalWorkspaceWorkbenchPacks[0].path,
        ...optionalWorkspaceWorkbenchMeasurement,
      }),
      optionalWorkspaceBinding: Object.freeze({
        path: optionalWorkspaceBindingPacks[0].path,
        ...optionalWorkspaceBindingMeasurement,
      }),
      optionalWorkspaceCodec: Object.freeze({
        path: optionalWorkspaceCodecPacks[0].path,
        ...optionalWorkspaceCodecMeasurement,
      }),
      optionalSourceControl: Object.freeze({
        path: optionalSourceControlPacks[0].path,
        ...optionalSourceControlMeasurement,
      }),
      // Either `{ path, raw, gzip }` for a dedicated chunk or `{ inlinedInto }`
      // when the bundler folded it into its consumer. Never a size it does not
      // have: a reader of these measurements has to be able to tell the two apart.
      optionalSourceSelection: optionalSourceSelectionDelivery,
      optionalBrowserGit: Object.freeze({
        path: optionalBrowserGitPacks[0].path,
        ...optionalBrowserGitMeasurement,
      }),
      optionalRequestFailure: Object.freeze({
        path: optionalRequestFailurePacks[0].path,
        ...optionalRequestFailureMeasurement,
      }),
      optionalSessionLibrary: Object.freeze({
        path: optionalSessionLibraryPacks[0].path,
        ...optionalSessionLibraryMeasurement,
      }),
      optionalSessionManifest: Object.freeze({
        path: optionalSessionManifestPacks[0].path,
        ...optionalSessionManifestMeasurement,
      }),
      optionalFavoriteOrdering: Object.freeze({
        path: optionalFavoriteOrderingPacks[0].path,
        ...optionalFavoriteOrderingMeasurement,
      }),
      optionalSessionFork: Object.freeze({
        paths: Object.freeze(optionalSessionForkPacks.map((file) => file.path)),
        ...optionalSessionForkMeasurement,
      }),
      optionalCapabilitiesView: Object.freeze({
        path: optionalCapabilitiesViewPacks[0].path,
        ...optionalCapabilitiesViewMeasurement,
      }),
      optionalBrowserCapabilities: Object.freeze({
        path: optionalBrowserCapabilityPacks[0].path,
        ...optionalBrowserCapabilityMeasurement,
      }),
      optionalMemoryView: Object.freeze({ path: optionalMemoryViewPacks[0].path, ...optionalMemoryViewMeasurement }),
      optionalMemorySupport: Object.freeze({
        path: optionalMemorySupportPacks[0].path,
        ...optionalMemorySupportMeasurement,
      }),
      optionalSkillEditor: Object.freeze({
        path: optionalSkillEditorPacks[0].path,
        ...optionalSkillEditorMeasurement,
      }),
      optionalConfirmDialog: Object.freeze({
        path: optionalConfirmDialogPacks[0].path,
        ...optionalConfirmDialogMeasurement,
      }),
      optionalShortcutSheet: Object.freeze({
        path: optionalShortcutSheetPacks[0].path,
        ...optionalShortcutSheetMeasurement,
      }),
      optionalPaletteActions: Object.freeze({
        path: optionalPaletteActionPacks[0].path,
        ...optionalPaletteActionsMeasurement,
      }),
      optionalProofSurface: Object.freeze({
        paths: Object.freeze(optionalProofSurfacePacks.map((file) => file.path)),
        ...optionalProofSurfaceMeasurement,
      }),
      optionalEvidenceAcquisition: Object.freeze({
        paths: Object.freeze(optionalEvidenceAcquisitionPacks.map((file) => file.path)),
        ...optionalEvidenceAcquisitionMeasurement,
      }),
      optionalTerminal: Object.freeze({
        paths: Object.freeze(optionalTerminalPacks.map((file) => file.path)),
        ...optionalTerminalMeasurement,
      }),
      optionalSemanticWorker: Object.freeze({ path: optionalSemanticWorkerPacks[0].path, ...optionalSemanticWorkerMeasurement }),
      optionalModelCatalog: Object.freeze({
        paths: Object.freeze(optionalModelCatalogPacks.map((file) => file.path)),
        ...optionalModelCatalogMeasurement,
      }),
      optionalInferenceProviders: Object.freeze({
        paths: Object.freeze(optionalInferenceProviderPacks.map((file) => file.path)),
        ...optionalInferenceProviderMeasurement,
      }),
      optionalChutesOAuth: Object.freeze({
        paths: Object.freeze(optionalChutesOAuthPacks.map((file) => file.path)),
        ...optionalChutesOAuthMeasurement,
      }),
      optionalExtensionObservation: Object.freeze({
        path: optionalExtensionObservationPacks[0].path,
        ...optionalExtensionObservationMeasurement,
      }),
      optionalLocalDeviceVault: Object.freeze({
        paths: Object.freeze(optionalLocalDeviceVaultPacks.map((file) => file.path)),
        ...optionalLocalDeviceVaultMeasurement,
      }),
      optionalDcapQvlJavaScript: Object.freeze({
        path: optionalDcapQvlPacks[0].path,
        ...optionalDcapQvlJavaScriptMeasurement,
      }),
      optionalDcapQvlWasm: Object.freeze({
        path: optionalDcapQvlWasmFiles[0].path,
        ...optionalDcapQvlWasmMeasurement,
      }),
      deferredCapabilities: Object.freeze({
        paths: Object.freeze(deferredCapabilityPacks.map((file) => file.path)),
        ...deferredCapabilityMeasurement,
      }),
      optionalPythonPack: optionalPythonPackMeasurement,
      firstPartyJavaScriptAndWorkers: firstPartyJavaScriptMeasurement,
      optionalVendorRuntimeAggregate: optionalVendorRuntimeMeasurement,
      totalJavaScriptAndWorkers: totalJavaScriptMeasurement,
      serviceWorker: Object.freeze({ path: serviceWorker.path, ...serviceWorkerMeasurement }),
      companionInstallScript: Object.freeze({
        path: companionInstallScripts[0].path,
        ...companionInstallScriptMeasurement,
      }),
      entryCss: entryCssMeasurement,
      allWasm: allWasmMeasurement,
      wasm: Object.freeze(wasmFiles.map((file) => Object.freeze({ path: file.path, ...measure(file.payload) }))),
    }),
  });
}

export function isOptionalExecutionPackPath(path) {
  return /^assets\/execution-runtime-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isCompanionInstallScriptPath(path) {
  return path === "extension/install.js";
}

export function isOptionalExecutionEnginePath(path) {
  return /^assets\/execution-engine-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalExecutionSupportPath(path) {
  return /^assets\/runtime-registry-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalExecutionToolsPath(path) {
  return /^assets\/execution-tools-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWasiPreview1WorkerPath(path) {
  return /^assets\/wasi-preview1-worker-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalDcapQvlPath(path) {
  return /^assets\/airship_dcap_qvl-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalDcapQvlWasmPath(path) {
  return /^assets\/airship_dcap_qvl_bg-[A-Za-z0-9_-]+\.wasm$/u.test(path);
}

export function isOptionalNodeExecutionPackPath(path) {
  return /^assets\/node-webcontainer-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalShellPackPath(path) {
  return /^assets\/airship-shell-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWasixJavaScriptPath(path) {
  return /^assets\/(?:wasix-pack|wasix-worker|dist)-[A-Za-z0-9_-]+\.js$/u.test(path)
    || /^assets\/index-[A-Za-z0-9_-]+\.mjs$/u.test(path);
}

export function isOptionalWasixWasmPath(path) {
  return /^assets\/wasmer_js_bg-[A-Za-z0-9_-]+\.wasm$/u.test(path);
}

export function isOptionalAgentRuntimePath(path) {
  return /^assets\/agent-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalMultimodalPath(path) {
  return /^assets\/multimodal-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalContextPolicyPath(path) {
  return /^assets\/context-policy-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalAgentToolsPath(path) {
  return /^assets\/(?:tool-bundle|client-context-runtime|context-selection|repository-admission)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceWorkbenchPath(path) {
  return /^assets\/editor-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceBindingPath(path) {
  return /^assets\/workspace-binding-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalWorkspaceCodecPath(path) {
  return /^assets\/content-codec-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSourceControlPath(path) {
  return /^assets\/sources-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSourceSelectionPath(path) {
  return /^assets\/source-selection-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/** The durable key the source-selection store writes; its shipped fingerprint. */
export const SOURCE_SELECTION_STORAGE_KEY = "airship.ui.sources.repository.v1";

/**
 * Source selection is ~650 bytes, so whether Vite emits it as its own chunk or
 * inlines it into the one pack that imports it is a bundler decision, not a
 * product fact — counting chunks made that decision a release blocker. What has
 * to stay true is that the durable key it persists ships in exactly one place
 * (and, asserted by the caller, never at first paint).
 *
 * When the module is inlined there is no artifact to weigh, so this returns a
 * delivery that says so and carries no byte counts at all. Attributing
 * `raw: 0, gzip: 0` to the carrier told two lies at once: the release
 * measurements published a size no artifact has, and the `optionalSourceSelection`
 * budget line compared zero against its ceiling and passed however large the
 * module grew. Inlined bytes are not unowned — `assertExclusiveArtifactClassifications`
 * requires the carrier to belong to exactly one capped class, so they are charged
 * to that class's ceiling instead of to a ceiling of their own.
 */
export function resolveOptionalSourceSelectionDelivery(dedicatedPacks, carrierPaths) {
  if (dedicatedPacks.length > 1) {
    throw new Error(`Production must contain at most one optional source-selection chunk; found ${dedicatedPacks.length}.`);
  }
  if (carrierPaths.length !== 1) {
    throw new Error(
      `Production must carry the source-selection store in exactly one JavaScript pack; found ${carrierPaths.length}.`,
    );
  }
  if (dedicatedPacks.length === 0) return Object.freeze({ inlinedInto: carrierPaths[0] });
  return Object.freeze({ path: dedicatedPacks[0].path, ...measure(dedicatedPacks[0].payload) });
}

/**
 * The shared route chrome — header, tab strip and metric strip. Every route
 * fetches it, no route is first paint, so it is measured as one optional pack
 * rather than against the startup budget or against any single route.
 */
/**
 * Slash commands: the parser, registry, planner and completer. Reachable only
 * once a runtime exists and a person types `/`, so it is not startup cost.
 */
export function isOptionalSlashCommandPath(path) {
  return /^assets\/commands-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalFileDownloadPath(path) {
  // One `Blob` -> object-URL -> anchor -> revoke helper, extracted so Proof and
  // Attestations stop carrying a copy each. It is reached only by an export
  // action, never at first paint.
  return /^assets\/file-download-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalRoutePrimitivePath(path) {
  // `brand-icons` joined this pack with the vendor logo work: it is shared
  // across the billing, connect, provider-fabric and vault routes, none of
  // which is on first paint, and is for the same reason never preloaded.
  return /^assets\/(?:route-header|tabs|metric-strip|brand-icons)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalRequestFailurePath(path) {
  // `turn-recovery` joined `request-state` here: they are one concern — the
  // vocabulary a turn uses when it goes wrong — and they are fetched at the
  // same moment, inside the failure handler. Keeping them out of the entry
  // chunk is the point: first paint should not carry the sentences a turn only
  // needs if it fails.
  return /^assets\/(?:request-state|turn-recovery)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalApprovalReviewerPath(path) {
  return /^assets\/model-reviewer-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalBrowserGitClientPath(path) {
  return /^assets\/browser-git-client-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalBrowserGitPath(path) {
  return /^assets\/workspace-adapter-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSessionLibraryPath(path) {
  return /^assets\/sessions-route-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSessionManifestPath(path) {
  return /^assets\/session-manifest-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalFavoriteOrderingPath(path) {
  return /^assets\/session-pins-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSessionForkPath(path) {
  return /^assets\/(?:session-fork|fork-context)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalCapabilitiesViewPath(path) {
  return /^assets\/capabilities-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalBrowserCapabilityPath(path) {
  return /^assets\/browser-runtime-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalMemoryViewPath(path) {
  return /^assets\/memory-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalMemorySupportPath(path) {
  return /^assets\/kind-visual-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/** The `custom.` skill authoring panel; see `optionalSkillEditor`. */
export function isOptionalSkillEditorPath(path) {
  return /^assets\/skill-editor-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/** The shared destructive-confirmation dialog; see `optionalConfirmDialog`. */
export function isOptionalConfirmDialogPath(path) {
  return /^assets\/confirm-dialog-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The approval dock.
 *
 * A permission request cannot exist before a model is connected and a turn is
 * running, so the dock is not first-paint content — and the pass that gave it
 * an accessible write description and an outcome announcement also gave it 425
 * lines the entry chunk was paying for on every cold open. It is fetched as
 * soon as a broker exists, so it is resident well before the first request.
 */
export function isOptionalApprovalDockPath(path) {
  return /^assets\/approval-dock-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The keyboard shortcut sheet.
 *
 * Nothing renders it until a person presses `?` or opens the palette's footer
 * row, so it is not first-paint content — the same rule that moved the approval
 * dock and the resume report out of the entry chunk.
 */
export function isOptionalShortcutSheetPath(path) {
  return /^assets\/keyboard-shortcuts-sheet-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The command palette and the preferences dialog.
 *
 * They lived in `platform-shell.tsx`, which the boot path imports for its
 * hooks, so their JSX shipped in the entry chunk to be rendered by nobody:
 * neither is ever on screen at first paint, and the entry ceiling had been
 * squeezed to 20 bytes before this moved. Classified with the shortcut sheet
 * because it is the same category — a deferred shell overlay, fetched on idle
 * after first paint so the first press is warm.
 */
export function isOptionalShellOverlayPath(path) {
  return /^assets\/platform-overlays-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The command palette's conversation verbs — New conversation, Rename, Retry,
 * Edit & branch, Fork from here.
 *
 * The palette held no verbs at all, so every action still cost menu
 * archaeology; the rows that fixed that are words, and words that cannot paint
 * before ⌘K do not belong in first paint. Same rule as the shortcut sheet.
 */
export function isOptionalPaletteActionsPath(path) {
  return /^assets\/palette-actions-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The message-part renderer.
 *
 * Tool calls, attachments, receipts and errors are what it draws, and the empty
 * conversation on screen at first paint has none of them. Static, it cost every
 * cold open 32 KiB of source for a renderer with nothing yet to render.
 */
export function isOptionalMessagePartsPath(path) {
  return /^assets\/message-parts-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/** The on-demand lost-work report, its ledger, and its timestamp helper. */
export function isOptionalResumeReportPath(path) {
  return /^assets\/(?:resume-report|return-ledger|instant-format)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalProofSurfacePath(path) {
  // `proof-inspector` and `seal-states` are the claim rail and the one
  // fail-closed receipt rule it renders. They left the entry chunk when the
  // rail stopped being defined inside `app.tsx`: neither can draw anything
  // until a turn has produced a receipt, so neither belongs in first paint.
  // `tdx` is the Intel quote/report parser every one of those claims rests on.
  // It became its own chunk when the endpoint-evidence record store started
  // importing it too; it stays classified with the Proof surface because that
  // is the capability it exists to serve, and nothing renders it at first paint.
  return /^assets\/(?:proof-view-[A-Za-z0-9_-]+|proof-inspector-[A-Za-z0-9_-]+|seal-states-[A-Za-z0-9_-]+|provider-client-[A-Za-z0-9_-]+|tdx-[A-Za-z0-9_-]+|client-(?!runtime-|context-)[A-Za-z0-9_-]+)\.js$/u.test(path);
}

export function isOptionalEvidenceAcquisitionPath(path) {
  return /^assets\/(?:evidence-acquisition-queue|workspace-evidence-acquisition-persistence|workspace-endpoint-evidence-persistence)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalTerminalPath(path) {
  return /^assets\/(?:terminal-view|manager|terminal-dock-state)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSemanticWorkerPath(path) {
  return /^assets\/semantic\.worker-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalModelCatalogPath(path) {
  // `model-picker` is the one rich picker Connection and Chat now share. It is
  // dynamically imported by both, so it fetches with the catalog it renders and
  // never at first paint.
  return /^assets\/(?:client-runtime|telemetry|model-picker)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalInferenceProviderPath(path) {
  return /^assets\/(?:fabric|openai|provider-connections-view|providers|session-route|inference-bridge-pack)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalChutesOAuthPath(path) {
  return /^assets\/(?:chutes-oauth|chutes-oauth-registration)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalExtensionObservationPath(path) {
  return /^assets\/extension-bridge-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalLocalDeviceVaultPath(path) {
  return /^assets\/(?:local-device-vault-setup|local-device-keyring|local-lab|recovery|encrypted-envelope)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isDeferredCapabilityPackPath(path) {
  return /^assets\/(?:deferred-capabilities|load-deferred-capabilities)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalPythonPackPath(path) {
  return path.startsWith("execution-packs/pyodide/");
}

export function assertOptionalPacksAreNotPreloaded(index) {
  if (/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/assets\/(?:deferred-capabilities|load-deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|execution-tools|wasi-preview1-worker|node-webcontainer-pack|wasix-pack|wasix-worker|dist|index|agent|multimodal|context-policy|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|session-manifest|session-pins|session-fork|fork-context|capabilities-view|browser-runtime|memory-view|kind-visual|proof-view|client|request-state|evidence-acquisition-queue|workspace-evidence-acquisition-persistence|terminal-view|terminal-dock-state|semantic\.worker|client-runtime|telemetry|fabric|openai|provider-connections-view|providers|session-route|chutes-oauth|chutes-oauth-registration|extension-bridge|local-device-vault-setup|local-device-keyring|local-lab|recovery|encrypted-envelope)-/u.test(index)) {
    throw new Error("Production HTML must not preload deferred capability or optional execution packs.");
  }
}

async function collectFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release output contains a symbolic link: ${toPosix(base, absolute)}.`);
    if (info.isDirectory()) {
      files.push(...(await collectFiles(absolute, base)));
      continue;
    }
    if (!info.isFile()) throw new Error(`Release output contains a non-file artifact: ${toPosix(base, absolute)}.`);
    files.push(Object.freeze({ path: toPosix(base, absolute), payload: await readFile(absolute) }));
  }
  return files;
}

async function validatePublicCopies(output, paths) {
  for (const path of paths) {
    const [source, built] = await Promise.all([
      readFile(resolve(root, "public", path)),
      readFile(resolve(output, path)),
    ]);
    if (!source.equals(built)) throw new Error(`Vite changed the reviewed public artifact: ${path}.`);
  }
}

function validateHeaders(headers) {
  const requirements = [
    ["root Content-Security-Policy", /^\s{2}Content-Security-Policy:/mu],
    ["cross-origin embedder isolation", /^\s{2}Cross-Origin-Embedder-Policy:\s*credentialless\s*$/mu],
    ["cross-origin opener isolation", /^\s{2}Cross-Origin-Opener-Policy:\s*same-origin\s*$/mu],
    ["MIME sniffing protection", /^\s{2}X-Content-Type-Options:\s*nosniff\s*$/mu],
    ["immutable hashed assets", /\/assets\/\*[\s\S]*?Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/u],
    ["service-worker revalidation", /\/sw\.js[\s\S]*?Cache-Control:\s*no-cache/u],
    ["root service-worker scope", /\/sw\.js[\s\S]*?Service-Worker-Allowed:\s*\//u],
    ["release-manifest revalidation", /\/release-manifest\.json[\s\S]*?Cache-Control:\s*no-cache/u],
  ];
  for (const [label, pattern] of requirements) {
    if (!pattern.test(headers)) throw new Error(`Static headers are missing ${label}.`);
  }
}

function validateWebManifest(source, index) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error("Web app manifest is not valid JSON.");
  }
  const rootManifest = manifest.id === "/" && manifest.start_url === "/" && manifest.scope === "/";
  const relativeManifest = manifest.id === "." && manifest.start_url === "./" && manifest.scope === "./";
  if (!rootManifest && !relativeManifest) {
    throw new Error("Web app manifest id, start_url, and scope must remain aligned same-origin paths.");
  }
  if (manifest.display !== "standalone") throw new Error("Web app manifest must remain installable in standalone mode.");
  if (
    !Array.isArray(manifest.icons) ||
    manifest.icons.length === 0 ||
    manifest.icons.some((icon) => !icon || !["/favicon.svg", "favicon.svg"].includes(icon.src))
  ) {
    throw new Error("Web app manifest icons must use the reviewed same-origin favicon.");
  }
  if (!/<link\b[^>]*\brel="manifest"[^>]*\bhref="\/(?:[A-Za-z0-9._~-]+\/)*manifest\.webmanifest"[^>]*>/u.test(index)) {
    throw new Error("Built index does not reference the reviewed web app manifest.");
  }
  if (!/<link\b[^>]*\brel="icon"[^>]*\bhref="\/(?:[A-Za-z0-9._~-]+\/)*favicon\.svg"[^>]*>/u.test(index)) {
    throw new Error("Built index does not reference the reviewed same-origin icon.");
  }
}

function validateBuiltCsp(index, headers) {
  const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
  const header = /^\s*Content-Security-Policy:\s*(.+)$/mu.exec(headers)?.[1];
  if (!meta || !header) throw new Error("Built index and headers must both contain a Content-Security-Policy.");
  const metaDirectives = parsePolicy(meta);
  const headerDirectives = parsePolicy(header);
  const comparableHeaders = new Map(headerDirectives);
  comparableHeaders.delete("frame-ancestors");
  if (serializePolicy(metaDirectives) !== serializePolicy(comparableHeaders)) {
    throw new Error("Built index and response-header CSP directives diverge.");
  }
  if (headerDirectives.get("frame-ancestors") !== "'none'") {
    throw new Error("Built response-header CSP must deny all frame ancestors.");
  }
  const connections = metaDirectives.get("connect-src")?.split(/\s+/u) ?? [];
  if (connections.includes("https:") || connections.some((source) => source.includes("*"))) {
    throw new Error("Built connect-src must contain only exact origins.");
  }
}

function parsePolicy(value) {
  return new Map(
    value
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...tokens] = directive.split(/\s+/u);
        return [name, tokens.join(" ")];
      }),
  );
}

function serializePolicy(policy) {
  return [...policy.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => `${name} ${value}`)
    .join(";");
}

function validateServiceWorker(source) {
  const requirements = [
    ["release-coupled cache", /searchParams\.get\("revision"\)[\s\S]*?const CACHE_VERSION = `\$\{CACHE_PREFIX\}\$\{RELEASE_REVISION\}`;/u],
    ["scoped cache cleanup", /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_VERSION/u],
    ["release-manifest precache", /fetch\((?:"\/release-manifest\.json"|scopedPath\("release-manifest\.json"\))[\s\S]*?manifest\.artifacts[\s\S]*?cache\.addAll\(\[\.\.\.SHELL, \.\.\.new Set\(assets\)\]\)/u],
    ["same-origin boundary", /requestUrl\.origin !== self\.location\.origin/u],
    ["GET-only cache boundary", /event\.request\.method !== "GET"/u],
    ["authorization bypass", /headers\.has\("authorization"\)/u],
    ["range bypass", /headers\.has\("range"\)/u],
    ["network-first navigation", /request\.mode === "navigate"[\s\S]*?fetch\(event\.request\)[\s\S]*?caches\.match\((?:"\/"|BASE_PATH)\)/u],
    ["first-document control", /self\.clients\.claim\(\)/u],
    ["static-host navigation wrapping", /return isolatedNavigationResponse\(response\)/u],
    ["static-host embedder isolation", /"Cross-Origin-Embedder-Policy":\s*"credentialless"/u],
    ["static-host opener isolation", /"Cross-Origin-Opener-Policy":\s*"same-origin"/u],
    ["hashed asset scope", /pathname\.startsWith\((?:"\/assets\/"|scopedPath\("assets\/"\))\)/u],
    ["optional semantic pack cache", /pathname\.startsWith\((?:"\/semantic-pack\/v1\/"|scopedPath\("semantic-pack\/v1\/"\))\)/u],
    ["Set-Cookie exclusion", /!response\.headers\.has\("set-cookie"\)/u],
  ];
  for (const [label, pattern] of requirements) {
    if (!pattern.test(source)) throw new Error(`Service worker is missing its ${label} invariant.`);
  }
  const rootShell = ["/", "/manifest.webmanifest", "/favicon.svg"].every((path) => source.includes(JSON.stringify(path)));
  const scopedShell = /const SHELL = \[BASE_PATH, scopedPath\("manifest\.webmanifest"\), scopedPath\("favicon\.svg"\)\];/u.test(source);
  if (!rootShell && !scopedShell) {
    throw new Error("Service-worker shell is missing its reviewed root or scoped paths.");
  }
}

function parseHtmlEntries(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/gu)].map(
    (match) => match[1],
  );
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gu)].map(
    (match) => match[1],
  );
  const modulePreloads = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"[^>]*>/gu)].map(
    (match) => match[1],
  );
  return { scripts, styles, modulePreloads };
}

function requireAsset(fileMap, url, extension) {
  const match = /^\/(?:[A-Za-z0-9._~-]+\/)*(assets\/[^?#]+)$/u.exec(url);
  if (!match || url.includes("?") || url.includes("#")) {
    throw new Error(`Entry URL is not an immutable same-origin asset: ${url}.`);
  }
  const path = decodeURIComponent(match[1]);
  if (!path.endsWith(extension) || path.includes("..")) throw new Error(`Unexpected entry asset: ${url}.`);
  const file = fileMap.get(path);
  if (!file) throw new Error(`Entry asset does not exist: ${url}.`);
  return file;
}

function requireReleaseFile(fileMap, path) {
  if (path.includes("..") || path.startsWith("/")) throw new Error(`Unexpected release artifact path: ${path}.`);
  const file = fileMap.get(path);
  if (!file) throw new Error(`Required release artifact does not exist: ${path}.`);
  return file;
}

function measure(payload) {
  return Object.freeze({
    raw: payload.byteLength,
    gzip: gzipSync(payload, { level: 9, mtime: 0 }).byteLength,
  });
}

function sumMeasurements(measurements) {
  return Object.freeze(
    measurements.reduce(
      (total, measurement) => ({ raw: total.raw + measurement.raw, gzip: total.gzip + measurement.gzip }),
      { raw: 0, gzip: 0 },
    ),
  );
}

function toPosix(base, path) {
  return relative(base, path).split(sep).join(posix.sep);
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function redactSensitiveText(value) {
  let redacted = value;
  for (const [, pattern] of secretPatterns) {
    redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[redacted-credential]");
  }
  return redacted;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function printResult(result) {
  const { measurements } = result;
  console.log("Release gate passed (manifest is deterministic and explicitly unsigned).");
  console.log(
    `Entry JS ${formatBytes(measurements.entryJavaScript.raw)} raw / ${formatBytes(measurements.entryJavaScript.gzip)} gzip`,
  );
  console.log(
    `Initial JS + preloads ${formatBytes(measurements.initialJavaScriptAndPreloads.raw)} raw / ${formatBytes(measurements.initialJavaScriptAndPreloads.gzip)} gzip`,
  );
  console.log(
    `Baseline JS/workers ${formatBytes(measurements.baselineJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.baselineJavaScriptAndWorkers.gzip)} gzip`,
  );
  console.log(
    `Deferred capability pack ${formatBytes(measurements.deferredCapabilities.raw)} raw / ${formatBytes(measurements.deferredCapabilities.gzip)} gzip`,
  );
  console.log(
    `Optional execution pack ${formatBytes(measurements.optionalExecutionPack.raw)} raw / ${formatBytes(measurements.optionalExecutionPack.gzip)} gzip`,
  );
  console.log(
    `Optional execution engine ${formatBytes(measurements.optionalExecutionEngine.raw)} raw / ${formatBytes(measurements.optionalExecutionEngine.gzip)} gzip`,
  );
  console.log(
    `Optional execution tools ${formatBytes(measurements.optionalExecutionTools.raw)} raw / ${formatBytes(measurements.optionalExecutionTools.gzip)} gzip`,
  );
  console.log(
    `Optional WASI Preview 1 Worker ${formatBytes(measurements.optionalWasiPreview1Worker.raw)} raw / ${formatBytes(measurements.optionalWasiPreview1Worker.gzip)} gzip`,
  );
  console.log(
    `Optional Node execution pack ${formatBytes(measurements.optionalNodeExecutionPack.raw)} raw / ${formatBytes(measurements.optionalNodeExecutionPack.gzip)} gzip`,
  );
  console.log(
    `Unpromoted WASIX JavaScript shipped ${formatBytes(measurements.optionalWasixJavaScript.raw)} raw / ${formatBytes(measurements.optionalWasixJavaScript.gzip)} gzip`,
  );
  console.log(
    `Unpromoted WASIX engine shipped ${formatBytes(measurements.optionalWasixWasm.raw)} raw / ${formatBytes(measurements.optionalWasixWasm.gzip)} gzip`,
  );
  console.log(
    `Optional agent runtime ${formatBytes(measurements.optionalAgentRuntime.raw)} raw / ${formatBytes(measurements.optionalAgentRuntime.gzip)} gzip`,
  );
  console.log(
    `Optional multimodal ${formatBytes(measurements.optionalMultimodal.raw)} raw / ${formatBytes(measurements.optionalMultimodal.gzip)} gzip`,
  );
  console.log(
    `Optional context policy ${formatBytes(measurements.optionalContextPolicy.raw)} raw / ${formatBytes(measurements.optionalContextPolicy.gzip)} gzip`,
  );
  console.log(
    `Optional agent tools ${formatBytes(measurements.optionalAgentTools.raw)} raw / ${formatBytes(measurements.optionalAgentTools.gzip)} gzip`,
  );
  console.log(
    `Optional Workspace workbench ${formatBytes(measurements.optionalWorkspaceWorkbench.raw)} raw / ${formatBytes(measurements.optionalWorkspaceWorkbench.gzip)} gzip`,
  );
  console.log(
    `Optional source control ${formatBytes(measurements.optionalSourceControl.raw)} raw / ${formatBytes(measurements.optionalSourceControl.gzip)} gzip`,
  );
  // Say which of the two shapes shipped, so a reader is never left guessing
  // whether a missing size means "tiny" or "not measured".
  console.log(
    measurements.optionalSourceSelection.path
      ? `Optional source selection ${formatBytes(measurements.optionalSourceSelection.raw)} raw / ${formatBytes(measurements.optionalSourceSelection.gzip)} gzip`
      : `Optional source selection inlined into ${measurements.optionalSourceSelection.inlinedInto}`,
  );
  console.log(
    `Optional browser Git ${formatBytes(measurements.optionalBrowserGit.raw)} raw / ${formatBytes(measurements.optionalBrowserGit.gzip)} gzip`,
  );
  console.log(
    `Optional session library ${formatBytes(measurements.optionalSessionLibrary.raw)} raw / ${formatBytes(measurements.optionalSessionLibrary.gzip)} gzip`,
  );
  console.log(
    `Optional session manifest ${formatBytes(measurements.optionalSessionManifest.raw)} raw / ${formatBytes(measurements.optionalSessionManifest.gzip)} gzip`,
  );
  console.log(
    `Optional favorite ordering ${formatBytes(measurements.optionalFavoriteOrdering.raw)} raw / ${formatBytes(measurements.optionalFavoriteOrdering.gzip)} gzip`,
  );
  console.log(
    `Optional session fork ${formatBytes(measurements.optionalSessionFork.raw)} raw / ${formatBytes(measurements.optionalSessionFork.gzip)} gzip`,
  );
  console.log(
    `Optional request failure ${formatBytes(measurements.optionalRequestFailure.raw)} raw / ${formatBytes(measurements.optionalRequestFailure.gzip)} gzip`,
  );
  console.log(
    `Optional Memory view ${formatBytes(measurements.optionalMemoryView.raw)} raw / ${formatBytes(measurements.optionalMemoryView.gzip)} gzip`,
  );
  console.log(
    `Optional Memory support ${formatBytes(measurements.optionalMemorySupport.raw)} raw / ${formatBytes(measurements.optionalMemorySupport.gzip)} gzip`,
  );
  console.log(
    `Optional skill editor ${formatBytes(measurements.optionalSkillEditor.raw)} raw / ${formatBytes(measurements.optionalSkillEditor.gzip)} gzip`,
  );
  console.log(
    `Optional Proof surface ${formatBytes(measurements.optionalProofSurface.raw)} raw / ${formatBytes(measurements.optionalProofSurface.gzip)} gzip`,
  );
  console.log(
    `Optional evidence acquisition ${formatBytes(measurements.optionalEvidenceAcquisition.raw)} raw / ${formatBytes(measurements.optionalEvidenceAcquisition.gzip)} gzip`,
  );
  console.log(
    `Optional Chutes OAuth ${formatBytes(measurements.optionalChutesOAuth.raw)} raw / ${formatBytes(measurements.optionalChutesOAuth.gzip)} gzip`,
  );
  console.log(
    `Optional extension observation ${formatBytes(measurements.optionalExtensionObservation.raw)} raw / ${formatBytes(measurements.optionalExtensionObservation.gzip)} gzip`,
  );
  console.log(
    `Optional Python pack ${formatBytes(measurements.optionalPythonPack.raw)} raw / ${formatBytes(measurements.optionalPythonPack.gzip)} gzip`,
  );
  console.log(
    `First-party/all-other JS ${formatBytes(measurements.firstPartyJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.firstPartyJavaScriptAndWorkers.gzip)} gzip`,
  );
  console.log(
    `Vendor runtime aggregate ${formatBytes(measurements.optionalVendorRuntimeAggregate.raw)} raw / ${formatBytes(measurements.optionalVendorRuntimeAggregate.gzip)} gzip`,
  );
  console.log(
    `Installed bundled JS/workers ${formatBytes(measurements.totalJavaScriptAndWorkers.raw)} raw / ${formatBytes(measurements.totalJavaScriptAndWorkers.gzip)} gzip`,
  );
  console.log(`Service worker ${formatBytes(measurements.serviceWorker.raw)} raw / ${formatBytes(measurements.serviceWorker.gzip)} gzip`);
  console.log(`Entry CSS ${formatBytes(measurements.entryCss.raw)} raw / ${formatBytes(measurements.entryCss.gzip)} gzip`);
  for (const wasm of measurements.wasm) {
    console.log(`${wasm.path} ${formatBytes(wasm.raw)} raw / ${formatBytes(wasm.gzip)} gzip`);
  }
  if (measurements.wasm.length > 1) {
    console.log(`All WASM ${formatBytes(measurements.allWasm.raw)} raw / ${formatBytes(measurements.allWasm.gzip)} gzip`);
  }
  console.log(`${result.manifest.artifacts.length} artifacts recorded in ${RELEASE_MANIFEST_NAME}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runReleaseGate(process.argv[2] ? resolve(process.argv[2]) : defaultOutput)
    .then(printResult)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

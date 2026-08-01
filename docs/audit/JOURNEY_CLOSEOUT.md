# Human-journey audit — closeout

What this pass changed, what it proved, and what is still open. Written to be
checkable: every claim here is either enforced by a gate or names the file that
demonstrates it.

## The three findings that mattered most

**The audit's own paperwork was the largest unowned defect.** `JOURNEY_ROUTING.md`
opened with "148 findings, 148 routed, 0 unrouted" and the line "Assertion: the
sum of lane counts equals the Atlas total, or the routing script fails." There
was no routing script. The number was true when it was typed and nothing kept it
true.

`scripts/journey-atlas-gate.mjs` is now that mechanism, wired into `npm run
check`. Running it for the first time found four findings sitting in the Atlas
prose owned by no lane at all, and found that the Atlas narrated 100 of 152
findings while presenting itself as the canonical document.

**One boot navigation was being chased as four separate bugs.** A cold visit
navigates three times and only the third is the app: document at 29ms, minted
conversation address at 127ms, a full document reload at 153ms as the service
worker takes control so the isolation headers apply, and a second — different —
minted address at 212ms. That single event produced "Execution context was
destroyed" in one spec, a keyboard chord vanishing into a document with no
handlers attached in another, and a geometry probe returning `undefined` for a
route whose elements were all present when probed with a settle.

`e2e/support/settled.ts` names the boundary once. The product-side half is J151.

**J151 was already written down and nobody owned it.** "The service-worker
takeover reloads the document mid-journey and the page-memory conversation does
not survive it." It had evidence. It had no lane, so nobody read it, so it was
rediscovered from zero three passes later at a cost of most of a session. That
is what an unowned finding costs, and it is the argument for the gate above.

## Product changes

| Finding | Change | Enforced by |
|---|---|---|
| J151 | The service-worker takeover no longer reloads over work no authority could give back. The gesture fence stays; `reloadWouldDiscardWork` adds recorded turns and unsent drafts under page memory. Under an adopted Vault it still reloads immediately — the journal is on the far side. | `src/ui/reload-risk.test.ts` (7) |
| J152 | The runtime-update banner offsets by a live measurement instead of a constant, so it stops landing on the composer's send button. The capability dock's private copy of that measurement became `bottom-floor.ts`, read by both. | `src/ui/bottom-floor.test.ts` (4) |
| Deletion vs loss | Deleting a conversation forgets its return-ledger entry. Before this, deleting a thread and returning the next day was reported as lost work — a count, a timestamp, and an offer to set up a Vault to protect work that was thrown away on purpose. | `src/ui/chat/return-ledger.test.ts` |
| Proof overflow | `.proof-verdict`'s `auto` first column took its max-content and starved the body: at 1024x900 the columns resolved to 819px and 48px and the scope panel ran 132px past the main column. The screen whose whole job is to be checkable was the one that scrolled sideways. | `e2e/responsive-breakpoints.spec.ts` |
| Rail auto-open | The self-opening recents list no longer pushes Vault, Connection and Account below the fold on a short viewport. | `src/ui/rail.tsx` height gate |

## Standing rules this pass did not bend

- **The entry ceiling did not move.** 112 KiB gzip, first paint. Everything added
  this pass was either deferred or paid for out of the lazy graph. Entry is
  measured at 111.98 KiB — it passes, and that is 20 bytes of headroom. The next
  entry-path change has to defer its way in.
- **Budgets ratchet with a measurement and a reason, or not at all.** Two whole-KiB
  steps moved this pass; both comments record what crossed them and what it
  bought. `scripts/release-gate.test.ts` still demands the tightest whole-KiB step.
- **No test was weakened to make a failure go away.** Every spec fix in this pass
  made the test measure the thing it claimed to measure — waiting for the element
  under assertion rather than a proxy for it. Where a change traded one durability
  failure for another it was reverted whole.

## Where the browser suite finished

Desktop project, Playwright owning its own web server: **138 passed, 4 failed,
38 skipped, of 180.** It was 11 failed when this pass started measuring properly.

Two measurement lessons are worth more than the number:

- A run taken while `dist` was being rebuilt underneath it reported "89 passed,
  0 failed" and accounted for only 127 of 180 tests. It looked like the best
  result of the session and was worthless. Arithmetic on the totals is what
  caught it.
- A run taken against a hand-started `npm run preview` reported 44 failures,
  including whole worker and OAuth suites. Playwright's own web server supplies
  the cross-origin isolation headers those suites need. A green-looking server
  on the right port is not the right server.

The four that remain:

| Spec | Status |
|---|---|
| `airship-shell:110` | Passes alone, fails in the full run. The chip asserts the weakest claim, and under full-suite conditions a different axis is weakest. Ordering, not a product defect — but not diagnosed, so not claimed as one. |
| `catalog-enrichment-retry:71` | Untouched by this pass. |
| `vault-auto-adoption:96`, `:174` | Pre-existing. Measured at `ba7020d~1` for comparison: **five** of these seven failed before the J151 reload fix, two after. The fix improved this file rather than regressing it; these two are a separate cause. |

## Open

- **`app.tsx` is 620 KB in one file.** Splitting it is architectural and was not
  attempted here. It is the single largest obstacle to reviewing shell changes.
- **52 findings are owned and evidenced but not narrated.** The complete index in
  `JOURNEY_ATLAS.md` marks them `prose: no`. They are findings, not gaps in the
  audit, but a reader working from the narrative alone will not meet them.
- **Ephemerality of the return ledger is settled at 14 days** with a documented
  reason and a test, not at a value anyone has validated against real returning
  behaviour.
- **Touch-floor sweep** covered the controls this pass added; it is not a
  whole-product sweep.

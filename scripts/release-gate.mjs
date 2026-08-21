import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  EXTENSION_RELEASE_ARCHIVES,
  EXTENSION_RELEASE_FILES,
  assertExactInventory,
  readExtensionArchive,
} from "../extension/release-archive.mjs";
import {
  duplicatePolicyDirectiveNames,
  parsePolicy,
  validateConnectSources,
} from "./check-static-security.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(root, "dist");

export const RELEASE_MANIFEST_NAME = "release-manifest.json";
export const SEMANTIC_PACK_STATE_FILE = "semantic-pack-state.json";

export const RELEASE_BUDGETS = Object.freeze({
  // The provider/trust simplification reduced total startup JavaScript, but it
  // also removed secondary importers that had kept stable profile-storage
  // modules outside the entry. The named eager profile-storage cache unit in
  // vite.config.ts restores a bounded coordinator without making code lazy.
  //
  // Earlier readings of 380,222 B raw and 117,816 B gzip, then 384,641 B raw and
  // 119,196 B gzip, then 386,146 B raw and 119,594 B gzip, then 385,096 B raw and
  // 119,341 B gzip are kept as history only, and deliberately not phrased as
  // measurements: this file's parser takes the largest figure any "measured"
  // sentence states, and a superseded reading above a lowered ceiling reads as a
  // raise nobody reviewed.
  //
  // The host-composed loopback storage lab left the startup graph. It was never
  // usable without `VITE_AIRSHIP_ENABLE_LOCAL_LAB=1` and an exact loopback
  // origin, and it shipped in every build anyway: the baked MinIO endpoint and
  // its disposable keys, the auto-connect effect, the S3/Cognito diagnostics,
  // the selector copy that names the destination. `LOCAL_LAB_BUILD` folds to a
  // literal, so a stock entry chunk now carries none of it — 4,276 raw and
  // 1,427 gzip bytes off the largest reviewed variant.
  //
  // The canonical config-free artifact weighed 380,623 B raw / 117,807 B gzip.
  // The reviewed Docker-defaults variant weighed 380,616 B raw / 117,812 B
  // gzip, the reviewed Pages variant weighed 380,639 B raw / 117,819 B gzip,
  // and the reviewed Google-Drive-configured variant measures 380,837 B raw /
  // 117,917 B gzip. A configured client ID is a supported deployment of both
  // Pages and Docker, and it is the largest of the four, so it sets both maxima.
  // 372 KiB raw would have left 91 B, far inside minifier jitter, so raw takes
  // the 373 KiB step and leaves 1,115 B. 116 KiB gzip clears the artifact by
  // 867 B, above the tripwire floor, so gzip takes that tight step.
  //
  // Earlier readings of 382,287 B raw and 118,354 B gzip (canonical), 382,292 B
  // raw and 118,348 B gzip (Docker defaults), 382,308 B raw and 118,365 B gzip
  // (Pages) and 382,513 B raw and 118,451 B gzip (Google-Drive-configured) are
  // history and are deliberately not phrased as measurements.
  //
  // Re-measured after the bundle/folder authority repair: a work bundle stopped
  // being able to carry an approval mode, a model, a context policy or a
  // storage fence; an attached folder became a Profile's own attachment rather
  // than the browser's; a write that lands on a real disk is reviewed in every
  // approval mode; and a gate that closed with nobody asked stopped being
  // journaled as a person's refusal. Those four refusals and the sentences that
  // say what to do about them are the whole delta, and every one of them is on
  // the eager authority path — the approval policy, the broker, the resume
  // comparison and the workspace path rules — so none of it could be made lazy
  // without moving the decision away from the code that enforces it.
  //
  // The canonical config-free artifact weighed 384,261 B raw / 119,119 B gzip;
  // the reviewed Docker-defaults variant measures 384,266 B raw / 119,119 B
  // gzip; the reviewed Pages variant weighed 384,277 B raw / 119,119 B gzip;
  // and the reviewed Google-Drive-configured variant measures 384,467 B raw /
  // 119,204 B gzip and sets both maxima. Raw takes the 376 KiB step and leaves
  // 557 B; 117 KiB gzip is already the smallest step that clears the reading and
  // leaves 604 B.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact weighed 384,421 B raw / 119,166 B gzip;
  // the reviewed Docker-defaults variant weighed 384,426 B raw / 119,173 B gzip;
  // the reviewed Pages variant weighed 384,442 B raw / 119,174 B gzip;
  // and the reviewed Google-Drive-configured variant measures 384,647 B raw /
  // 119,275 B gzip. 376 KiB raw would have left 377 B and 117 KiB gzip would
  //
  // Re-measured after the product-audit repair. The whole entry delta is two
  // sentences the shell has to be able to say: which conversation an approval
  // belongs to when nobody has named it yet, and whether the storage a work
  // bundle would merge into is the one that will still be there when the merge
  // lands. Both are decisions the entry chunk already owns — the shell resolves
  // the conversation name and holds the settled-authority latch — so neither
  // could be fetched later without moving the decision away from the code that
  // makes it. Everything else in the pass is in lazily fetched packs.
  //
  // The canonical config-free artifact weighed 384,531 B raw / 119,216 B gzip;
  // the reviewed Docker-defaults variant weighed 384,536 B raw / 119,210 B gzip;
  // the reviewed Pages variant weighed 384,552 B raw / 119,228 B gzip;
  // and the reviewed Google-Drive-configured variant measures 384,743 B raw /
  // 119,318 B gzip and sets both maxima. 117 KiB gzip would have left 490 B,
  // below the tripwire floor, so gzip keeps the 118 KiB step and leaves 1,514 B;
  // 377 KiB raw leaves 1,305 B and does not move.
  //
  // Re-measured after a bundle stopped granting authority through its events.
  // The entry delta is two decisions the shell and the approval policy own and
  // cannot fetch later, because they are made before anything is fetched: which
  // approval mode the conversation on screen puts the page into — a
  // conversation that arrived in a file now puts it into none — and whether a
  // human-proposed effect names a folder on this device, which is reviewed in
  // every mode including Full Access. Both are on the eager authority path.
  // Factoring the three projected pins into one `projectedSessionPins` helper
  // paid part of it back in the same chunk.
  //
  // The canonical config-free artifact weighed 384,689 B raw / 119,273 B gzip;
  // the reviewed Docker-defaults variant weighed 384,682 B raw / 119,263 B gzip;
  // the reviewed Pages variant weighed 384,698 B raw / 119,284 B gzip;
  // and the reviewed Google-Drive-configured variant measures 384,883 B raw /
  // 119,347 B gzip and sets both maxima. 117 KiB gzip would have left 461 B,
  // below the tripwire floor, so gzip keeps the 118 KiB step and leaves 1,485 B;
  // 377 KiB raw leaves 1,165 B and does not move.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact weighed 384,699 B raw / 119,284 B gzip;
  // the reviewed Docker-defaults variant weighed 384,704 B raw / 119,277 B gzip;
  // the reviewed Pages variant weighed 384,720 B raw / 119,279 B gzip;
  // and the reviewed Google-Drive-configured variant measures 384,925 B raw /
  // 119,379 B gzip. 376 KiB raw would have left 99 B and 117 KiB gzip would
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 385,616 B raw / 119,621 B gzip;
  // the reviewed Docker-defaults variant weighed 385,621 B raw / 119,617 B gzip;
  // the reviewed Pages variant weighed 385,637 B raw / 119,616 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 385,842 B raw /
  // 119,722 B gzip. 377 KiB raw would have left 206 B and 117 KiB gzip would
  //
  // Re-measured after the journal-integrity repair. An adoption a storage failure interrupted is finished on the next
  // attempt instead of being refused as a conflicting session forever; a bundle event carrying no payload is refused by
  // the reader that can still name the file, rather than by the Vault the person adopts weeks later; and an approval
  // nobody answered stops being journaled as a decision a person made. The delta is `replayedRecord` and one head
  // helper in the merge primitive, one condition in the bundle reader, and one shared `approvalWasAnswered` predicate
  // that replaced four spellings of the same test — which is why the entry chunk got eight bytes smaller.
  // The canonical config-free artifact weighed 385,620 B raw / 119,614 B gzip;
  // the reviewed Docker-defaults variant weighed 385,613 B raw / 119,616 B gzip;
  // the reviewed Pages variant weighed 385,641 B raw / 119,616 B gzip;
  // and the reviewed Google-Drive-configured variant measures 385,814 B raw /
  // 119,671 B gzip and sets both maxima.
  // 117 KiB gzip would have left 137 B, below the tripwire floor, so gzip keeps the 118 KiB step and leaves 1,161 B; 377 KiB raw leaves 234 B and does not move.
  //
  // Re-measured after adoption stopped stranding a conversation. A transient failure part-way through moving a journal into a Vault used to leave a genesis stub that every later attempt refused by name, forever; a replay is resumable now, and continues only a target that matches the exact record the replay would have produced at that point. A bundle event that omits its payload is refused where it arrives rather than killing an adoption later, and an approval that expired is no longer recorded as a decision a person made.
  // The canonical config-free artifact weighed 385,608 B raw / 119,617 B gzip;
  // the reviewed Docker-defaults variant weighed 385,613 B raw / 119,616 B gzip;
  // the reviewed Pages variant weighed 385,629 B raw / 119,615 B gzip;
  // and the reviewed Google-Drive-configured variant measures 385,834 B raw /
  // 377 KiB raw is the smallest whole-KiB step that clears that reading and leaves 214 B; 117 KiB gzip would have left 87 B, below the tripwire floor, so gzip keeps the 118 KiB step and leaves 1,111 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 385,780 B raw / 119,657 B gzip;
  // the reviewed Docker-defaults variant measures 385,785 B raw / 119,661 B gzip;
  // the reviewed Pages variant measures 385,801 B raw / 119,667 B gzip;
  // and the reviewed Google-Drive-configured variant measures 386,006 B raw /
  // 377 KiB raw is the smallest whole-KiB step that clears that reading and leaves 42 B; 117 KiB gzip would have left 40 B, below the tripwire floor, so gzip keeps the 118 KiB step and leaves 1,064 B.
  entryJavaScript: Object.freeze({ raw: 377 * 1024, gzip: 118 * 1024 }),
  // Provider-neutral simplification removed the obsolete proof, attestation,
  // confidential-provider, and vendor-specific bootstrap graph from the
  // baseline while keeping the static workbench and its eager preloads.
  //
  // Earlier readings of 504,247 B raw and 163,264 B gzip, then 505,457 B raw and
  // 164,062 B gzip, are history and are not phrased as measurements: a
  // superseded figure above a lowered ceiling reads as a raise nobody reviewed.
  //
  // The loopback storage lab left this class twice over: the entry chunk shed
  // its lab branches, and `src/vault/config.ts` — the S3 configuration grammar,
  // reachable from that one destination — stopped being named in the eager
  // profile-storage chunk, which was the last thing pinning 4,969 raw bytes of
  // it into a stock artifact.
  //
  // The canonical config-free artifact weighed 496,015 B raw / 160,959 B gzip.
  // The reviewed Docker-defaults variant weighed 496,008 B raw / 160,974 B
  // gzip, the reviewed Pages variant weighed 496,031 B raw / 160,981 B gzip,
  // and the reviewed Google-Drive-configured variant measures 496,229 B raw /
  // 161,076 B gzip and sets both maxima. 485 KiB raw would have left 411 B, so
  // raw takes the 486 KiB step and leaves 1,435 B. 158 KiB gzip would have left
  // 716 B, below the tripwire floor, so gzip takes 159 KiB and leaves 1,740 B.
  //
  // Earlier readings of 497,984 B raw and 161,619 B gzip (canonical), 497,989 B
  // raw and 161,622 B gzip (Docker defaults), 498,005 B raw and 161,634 B gzip
  // (Pages) and 498,210 B raw and 161,711 B gzip (Google-Drive-configured) are
  // history and are deliberately not phrased as measurements.
  //
  // Re-measured after the bundle/folder authority repair described on the entry
  // ceiling above. This class carries the same eager refusals plus the approval
  // dock the shell mounts, and nothing moved into it that a route could have
  // fetched instead.
  //
  // The canonical config-free artifact weighed 499,995 B raw / 162,384 B gzip;
  // the reviewed Docker-defaults variant measures 500,000 B raw / 162,396 B
  // gzip; the reviewed Pages variant weighed 500,011 B raw / 162,402 B gzip;
  // and the reviewed Google-Drive-configured variant measures 500,201 B raw /
  // 162,487 B gzip and sets both maxima. Raw takes the 489 KiB step and leaves
  // 535 B; 159 KiB gzip is already the smallest step that clears the reading and
  // leaves 329 B.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact weighed 500,155 B raw / 162,443 B gzip;
  // the reviewed Docker-defaults variant weighed 500,160 B raw / 162,439 B gzip;
  // the reviewed Pages variant weighed 500,176 B raw / 162,443 B gzip;
  // and the reviewed Google-Drive-configured variant measures 500,381 B raw /
  // 162,558 B gzip. 489 KiB raw would have left 355 B and 159 KiB gzip would
  //
  // Re-measured after the product-audit repair. This class carries the entry
  // delta above plus the approval dock, which the shell mounts: the dock now
  // renders one named row, one clock and one control per waiting decision
  // rather than the first and a count, announces a decision that arrived from a
  // conversation nobody is reading, and stops drawing a previous file content
  // it never had. The dock's own chunk went from 11,984 B raw / 4,308 B gzip to
  // 12,837 B raw / 4,575 B gzip, less than half of its own ceiling below; this
  // is the row with the margin that has to answer for it.
  //
  // The canonical config-free artifact weighed 501,118 B raw / 162,750 B gzip;
  // the reviewed Docker-defaults variant weighed 501,123 B raw / 162,750 B gzip;
  // the reviewed Pages variant weighed 501,139 B raw / 162,777 B gzip;
  // and the reviewed Google-Drive-configured variant measures 501,330 B raw /
  // 162,850 B gzip and sets both maxima. 160 KiB gzip is already the smallest
  // whole-KiB step that clears that reading and leaves 990 B; 490 KiB raw leaves
  // 430 B and does not move.
  //
  // Re-measured after a bundle stopped granting authority through its events.
  // This class carries the entry delta above and nothing else: the approval
  // dock, the rail and the routed region are untouched by this pass.
  //
  // The canonical config-free artifact weighed 501,276 B raw / 162,814 B gzip;
  // the reviewed Docker-defaults variant weighed 501,269 B raw / 162,802 B gzip;
  // the reviewed Pages variant weighed 501,285 B raw / 162,827 B gzip;
  // and the reviewed Google-Drive-configured variant measures 501,470 B raw /
  // 162,882 B gzip and sets both maxima. 160 KiB gzip is already the smallest
  // whole-KiB step that clears that reading and leaves 958 B; 490 KiB raw leaves
  // 290 B and does not move.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact weighed 501,286 B raw / 162,819 B gzip;
  // the reviewed Docker-defaults variant weighed 501,291 B raw / 162,807 B gzip;
  // the reviewed Pages variant weighed 501,307 B raw / 162,816 B gzip;
  // and the reviewed Google-Drive-configured variant measures 501,512 B raw /
  // 162,912 B gzip. 490 KiB raw would have left 248 B and 160 KiB gzip would
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 502,203 B raw / 163,157 B gzip;
  // the reviewed Docker-defaults variant weighed 502,208 B raw / 163,149 B gzip;
  // the reviewed Pages variant weighed 502,224 B raw / 163,158 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 502,429 B raw /
  // 163,256 B gzip. 491 KiB raw would have left 355 B and 160 KiB gzip would
  //
  // Re-measured after the journal-integrity repair. An adoption a storage failure interrupted is finished on the next
  // attempt instead of being refused as a conflicting session forever; a bundle event carrying no payload is refused by
  // the reader that can still name the file, rather than by the Vault the person adopts weeks later; and an approval
  // nobody answered stops being journaled as a decision a person made. The delta is `replayedRecord` and one head
  // helper in the merge primitive, one condition in the bundle reader, and one shared `approvalWasAnswered` predicate
  // that replaced four spellings of the same test — which is why the entry chunk got eight bytes smaller.
  // The canonical config-free artifact weighed 502,207 B raw / 163,146 B gzip;
  // the reviewed Docker-defaults variant weighed 502,200 B raw / 163,159 B gzip;
  // the reviewed Pages variant weighed 502,228 B raw / 163,159 B gzip;
  // and the reviewed Google-Drive-configured variant measures 502,401 B raw /
  // 163,210 B gzip and sets both maxima.
  // Both ceilings are already the smallest whole-KiB step that clears these readings: 491 KiB raw leaves 383 B and 160 KiB gzip leaves 630 B.
  //
  // Re-measured after adoption stopped stranding a conversation. A transient failure part-way through moving a journal into a Vault used to leave a genesis stub that every later attempt refused by name, forever; a replay is resumable now, and continues only a target that matches the exact record the replay would have produced at that point. A bundle event that omits its payload is refused where it arrives rather than killing an adoption later, and an approval that expired is no longer recorded as a decision a person made.
  // The canonical config-free artifact weighed 502,195 B raw / 163,150 B gzip;
  // the reviewed Docker-defaults variant weighed 502,200 B raw / 163,159 B gzip;
  // the reviewed Pages variant weighed 502,216 B raw / 163,156 B gzip;
  // and the reviewed Google-Drive-configured variant measures 502,421 B raw /
  // 491 KiB raw is the smallest whole-KiB step that clears that reading and leaves 363 B; 160 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 581 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 502,147 B raw / 163,126 B gzip;
  // the reviewed Docker-defaults variant measures 502,152 B raw / 163,140 B gzip;
  // the reviewed Pages variant measures 502,168 B raw / 163,145 B gzip;
  // and the reviewed Google-Drive-configured variant measures 502,373 B raw /
  // 491 KiB raw is the smallest whole-KiB step that clears that reading and leaves 411 B; 160 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 589 B.
  allJavaScriptAndWorkers: Object.freeze({ raw: 491 * 1024, gzip: 160 * 1024 }),
  // The deferred capability graph no longer carries the deleted Chutes proof,
  // attestation, confidential-embedding, and trust-screen implementations.
  // Earlier readings of 251,691 B raw and 72,556 B gzip, then 250,266 B raw and
  // 73,215 B gzip, are history and are not phrased as measurements.
  //
  // This is where the loopback lab was heaviest. The pack exported the S3
  // object store with its AWS request signing, the lab's configure request, and
  // the lab setup panel with its stylesheet — none of it reachable in a stock
  // build, all of it downloaded by the first advanced surface. The pack also
  // absorbed `vault/recovery.ts`, which used to be its own 1,221-byte chunk
  // because the lab's chunk was its second lazy importer. Net: 17,892 raw and
  // 5,164 gzip bytes off the largest reviewed variant.
  //
  // The canonical config-free artifact weighed 232,945 B raw / 68,182 B gzip.
  // The reviewed Docker-defaults variant weighed 232,945 B raw / 68,184 B gzip,
  // the reviewed Pages variant weighed 232,945 B raw / 68,181 B gzip, and the
  // reviewed Google-Drive-configured variant measures 233,017 B raw / 68,239 B
  // gzip and sets both maxima. 228 KiB raw would have left 455 B and 67 KiB gzip
  // would have left 369 B, both below the tripwire floor, so the 229/68 KiB
  // steps leave 1,479 / 1,393 B. None of this bundle is fetched on first paint.
  //
  // Earlier readings of 233,208 B raw and 68,245 B gzip, and of 233,280 B raw
  // and 68,303 B gzip, are history and are not phrased as measurements.
  //
  // Re-measured after the bundle/folder authority repair. `migrateJournalState`
  // travels in this pack and is what an import writes through; it is unchanged,
  // and the thirteen bytes are the merge's callers agreeing with it.
  //
  // The canonical config-free artifact weighed 233,221 B raw / 68,250 B gzip;
  // the reviewed Docker-defaults variant measures 233,221 B raw / 68,251 B
  // gzip; the reviewed Pages variant weighed 233,221 B raw / 68,252 B gzip;
  // and the reviewed Google-Drive-configured variant measures 233,293 B raw /
  // 68,303 B gzip and sets both maxima. 228 KiB raw would have left
  // 1,203 / 1,329 B. None of this bundle is fetched on first paint.
  //
  // Re-measured after a bundle stopped granting authority through its events.
  // `migrateJournalState` travels here and is what an import writes through. It
  // now replays a history without projecting a pin out of it, and the encrypted
  // backend that lands beside it reads the same `projectedSessionPins` helper
  // the page-memory backend does rather than spelling the three projections out
  // twice — so this pack got smaller while gaining the refusal.
  //
  // The canonical config-free artifact weighed 232,979 B raw / 68,195 B gzip;
  // the reviewed Docker-defaults variant weighed 232,979 B raw / 68,198 B gzip;
  // the reviewed Pages variant weighed 232,979 B raw / 68,195 B gzip;
  // and the reviewed Google-Drive-configured variant measures 233,047 B raw /
  // 68,235 B gzip and sets both maxima. 228 KiB raw would have left 425 B and
  // 67 KiB gzip would have left 373 B, both below the tripwire floor; the
  // first paint.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact weighed 232,991 B raw / 68,202 B gzip;
  // the reviewed Docker-defaults variant weighed 232,991 B raw / 68,205 B gzip;
  // the reviewed Pages variant weighed 232,991 B raw / 68,205 B gzip;
  // and the reviewed Google-Drive-configured variant measures 233,063 B raw /
  // 68,252 B gzip. 228 KiB raw would have left 409 B and 67 KiB gzip would
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 233,005 B raw / 68,211 B gzip;
  // the reviewed Docker-defaults variant weighed 233,005 B raw / 68,212 B gzip;
  // the reviewed Pages variant weighed 233,005 B raw / 68,212 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 233,077 B raw /
  // 68,260 B gzip. 228 KiB raw would have left 395 B and 67 KiB gzip would
  //
  // Re-measured after the journal-integrity repair. An adoption a storage failure interrupted is finished on the next
  // attempt instead of being refused as a conflicting session forever; a bundle event carrying no payload is refused by
  // the reader that can still name the file, rather than by the Vault the person adopts weeks later; and an approval
  // nobody answered stops being journaled as a decision a person made. The delta is `replayedRecord` and one head
  // helper in the merge primitive, one condition in the bundle reader, and one shared `approvalWasAnswered` predicate
  // that replaced four spellings of the same test — which is why the entry chunk got eight bytes smaller.
  // The canonical config-free artifact weighed 233,243 B raw / 68,322 B gzip;
  // the reviewed Docker-defaults variant weighed 233,243 B raw / 68,322 B gzip;
  // the reviewed Pages variant weighed 233,243 B raw / 68,324 B gzip;
  // and the reviewed Google-Drive-configured variant measures 233,311 B raw /
  // 68,356 B gzip and sets both maxima.
  // 228 KiB raw would have left 161 B and 67 KiB gzip would have left 252 B, both below the tripwire floor, so the 229/68 KiB steps stand and leave 1,185 / 1,276 B. None of this bundle is fetched on first paint.
  //
  // Re-measured after adoption stopped stranding a conversation. A transient failure part-way through moving a journal into a Vault used to leave a genesis stub that every later attempt refused by name, forever; a replay is resumable now, and continues only a target that matches the exact record the replay would have produced at that point. A bundle event that omits its payload is refused where it arrives rather than killing an adoption later, and an approval that expired is no longer recorded as a decision a person made.
  // The canonical config-free artifact weighed 233,243 B raw / 68,319 B gzip;
  // the reviewed Docker-defaults variant weighed 233,243 B raw / 68,322 B gzip;
  // the reviewed Pages variant weighed 233,243 B raw / 68,322 B gzip;
  // and the reviewed Google-Drive-configured variant measures 233,315 B raw /
  // 228 KiB raw would have left 157 B, below the tripwire floor, so raw keeps the 229 KiB step and leaves 1,181 B; 67 KiB gzip would have left 235 B, below the tripwire floor, so gzip keeps the 68 KiB step and leaves 1,259 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 232,946 B raw / 68,267 B gzip;
  // the reviewed Docker-defaults variant measures 232,946 B raw / 68,267 B gzip;
  // the reviewed Pages variant measures 232,946 B raw / 68,270 B gzip;
  // and the reviewed Google-Drive-configured variant measures 233,018 B raw /
  // 228 KiB raw would have left 454 B, below the tripwire floor, so raw keeps the 229 KiB step and leaves 1,478 B; 67 KiB gzip would have left 288 B, below the tripwire floor, so gzip keeps the 68 KiB step and leaves 1,312 B.
  deferredCapabilities: Object.freeze({ raw: 229 * 1024, gzip: 68 * 1024 }),
  // The complete first-party JavaScript graph shrank with the vendor-specific
  // proof and confidential-runtime deletion while retaining the generic agent,
  // storage, provider, Git, terminal, and extension surfaces.
  //
  // Earlier readings of 2,016,426 B raw and 629,378 B gzip, then 2,024,242 B raw
  // and 632,111 B gzip, then 2,038,267 B raw and 635,875 B gzip, then
  // 2,039,794 B raw and 636,299 B gzip, then 2,047,153 B raw and 639,045 B gzip,
  // then 2,008,572 B raw and 627,184 B gzip are history and are deliberately not
  // phrased as measurements: this file's parser takes the largest figure any
  // "measured" sentence states, and a superseded reading above a lowered ceiling
  // is exactly what the rules below read as a raise nobody reviewed. Vendor code
  // was unchanged across all of them.
  //
  // The host-composed loopback storage lab now leaves a stock build entirely
  // rather than shipping behind a runtime refusal. What went: the S3 object
  // store and its request signing, the lab configure request, the lab setup
  // panel and its stylesheet, the baked MinIO endpoint and disposable keys, the
  // S3 configuration grammar, the Cognito diagnostic, and the selector,
  // Preferences and Vault copy that named the destination — 29,796 raw and
  // 9,601 gzip bytes off the largest reviewed variant. A lab build is
  // byte-for-byte what it was; `VITE_AIRSHIP_ENABLE_LOCAL_LAB=1` still composes
  // all of it back in, and `assertStockReleaseExcludesLocalLab` is what keeps
  // the two apart.
  //
  // The canonical config-free artifact weighed 1,978,258 B raw / 617,280 B
  // gzip. The reviewed Docker-defaults variant weighed 1,978,231 B raw /
  // 617,320 B gzip, the reviewed Pages variant weighed 1,978,331 B raw /
  // 617,342 B gzip, and the reviewed Google-Drive-configured variant weighed
  // 1,978,793 B raw / 617,610 B gzip and set both maxima — a configured client
  // ID is a supported deployment of both Pages and Docker. 1933 KiB raw would
  // have left 599 B, below the tripwire floor, so raw takes the 1934 KiB step
  // and leaves 1,623 B. 604 KiB gzip clears the artifact by 886 B, above that
  // floor, so gzip takes that tight step.
  //
  // Earlier readings of 2,012,792 B raw and 629,760 B gzip (canonical),
  // 2,012,797 B raw and 629,784 B gzip (Docker defaults), 2,012,870 B raw and
  // 629,808 B gzip (Pages) and 2,013,363 B raw and 630,030 B gzip
  // (Google-Drive-configured) are history and are not phrased as measurements.
  //
  // Re-measured after the bundle/folder authority repair. The whole delta is
  // first-party and is five refusals plus the sentences that say what to do:
  // a work bundle may not carry a projected pin or a system prompt that does
  // not hash to its own digest; memory imports only into the profile doing the
  // importing, and only when asked; a write that reaches an attached folder is
  // reviewed in every approval mode; the Terminal neither mounts that folder
  // nor writes shell output into it; and an attachment belongs to one Profile.
  // Vendor code is unchanged.
  //
  // The canonical config-free artifact weighed 2,016,944 B raw / 631,137 B
  // gzip; the reviewed Docker-defaults variant weighed 2,016,949 B raw /
  // 631,185 B gzip; the reviewed Pages variant weighed 2,017,017 B raw /
  // 631,215 B gzip; and the reviewed Google-Drive-configured variant weighed
  // 2,017,418 B raw / 631,463 B gzip and set both maxima. Raw takes the
  // 1971 KiB step and leaves 886 B. 617 KiB gzip would have left 345 B, below
  // the tripwire floor, so gzip takes 618 KiB and leaves 1,369 B.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact weighed 2,017,116 B raw / 631,230 B gzip;
  // the reviewed Docker-defaults variant weighed 2,017,121 B raw / 631,219 B gzip;
  // the reviewed Pages variant weighed 2,017,194 B raw / 631,253 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,017,687 B raw /
  // 631,580 B gzip. 1971 KiB raw would have left 617 B and 617 KiB gzip would
  //
  // Re-measured after the product-audit repair. All of it is first-party and
  // all of it is a refusal or a sentence that says what to do about one: a work
  // bundle may not be merged into a journal a Vault adoption is about to
  // replace; the folder tier no longer promises that a file the agent reads
  // stays out of the conversation, because a bundle carries the conversation;
  // a write approval draws a previous file content only when it has one; two
  // conversations nobody has named are told apart; every waiting decision owns
  // its own row and control; and one that arrived unasked says so once. Vendor
  // code is unchanged. Ceilings do not move — this pass spends headroom, it does
  // not ask for more.
  //
  // The canonical config-free artifact weighed 2,018,705 B raw / 631,757 B gzip;
  // the reviewed Docker-defaults variant weighed 2,018,710 B raw / 631,780 B gzip;
  // the reviewed Pages variant weighed 2,018,783 B raw / 631,849 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,019,193 B raw /
  // 632,008 B gzip and set both maxima. Both ceilings are already the smallest
  // whole-KiB step that clears those readings, leaving 135 B raw and 824 B gzip.
  // The raw margin is the tightest this file carries and it is spent, not
  // granted: the ceiling is where it was.
  //
  // Re-measured after a bundle stopped granting authority through its events.
  // A digest chain certifies its own events and nothing else, and the previous
  // pass refused those events' *record* fields while the events themselves rode
  // in unchallenged: `migrateJournalState` replays a file's whole history
  // through `JournalBackend.append`, whose projection wrote `full-access` and a
  // model override back onto the landed record on both backends. All of this
  // delta is first-party and all of it is a refusal or the sentence that says
  // what to do about one: a replay grants no pin; the conversation on screen
  // grants no mode when it arrived in a file; an import refuses a conversation
  // the file addresses to another profile and any record field this build does
  // not read; a folder on this device is reviewed on the human-intent path in
  // every mode; the Terminal's refusal names a path that is true; and a branch
  // of an imported conversation must be pinned by this device. Vendor code is
  // unchanged.
  //
  // The canonical config-free artifact weighed 2,019,485 B raw / 632,128 B gzip;
  // the reviewed Docker-defaults variant weighed 2,019,458 B raw / 632,103 B gzip;
  // the reviewed Pages variant weighed 2,019,531 B raw / 632,147 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,019,931 B raw /
  // 632,327 B gzip and set both maxima. 1973 KiB raw would have left 421 B,
  // below the tripwire floor, so raw takes the 1974 KiB step and leaves 1,445 B.
  // 618 KiB gzip is already the smallest step that clears the reading and leaves
  // 505 B, so gzip does not move.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact weighed 2,019,474 B raw / 632,108 B gzip;
  // the reviewed Docker-defaults variant weighed 2,019,479 B raw / 632,091 B gzip;
  // the reviewed Pages variant weighed 2,019,552 B raw / 632,126 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,020,045 B raw /
  // 632,361 B gzip. 1973 KiB raw would have left 307 B and 618 KiB gzip would
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 2,020,824 B raw / 632,580 B gzip;
  // the reviewed Docker-defaults variant weighed 2,020,829 B raw / 632,571 B gzip;
  // the reviewed Pages variant weighed 2,020,902 B raw / 632,622 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,021,395 B raw /
  // 632,877 B gzip. 1975 KiB raw would have left 1,005 B and 619 KiB gzip would
  //
  // Re-measured after the journal-integrity repair. An adoption a storage failure interrupted is finished on the next
  // attempt instead of being refused as a conflicting session forever; a bundle event carrying no payload is refused by
  // the reader that can still name the file, rather than by the Vault the person adopts weeks later; and an approval
  // nobody answered stops being journaled as a decision a person made. The delta is `replayedRecord` and one head
  // helper in the merge primitive, one condition in the bundle reader, and one shared `approvalWasAnswered` predicate
  // that replaced four spellings of the same test — which is why the entry chunk got eight bytes smaller.
  // The canonical config-free artifact weighed 2,021,104 B raw / 632,696 B gzip;
  // the reviewed Docker-defaults variant weighed 2,021,077 B raw / 632,739 B gzip;
  // the reviewed Pages variant weighed 2,021,182 B raw / 632,737 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,021,550 B raw /
  // 632,881 B gzip and set both maxima.
  // Both ceilings are already the smallest whole-KiB step that clears these readings: 1975 KiB raw leaves 850 B and 619 KiB gzip leaves 975 B.
  //
  // Re-measured after adoption stopped stranding a conversation. A transient failure part-way through moving a journal into a Vault used to leave a genesis stub that every later attempt refused by name, forever; a replay is resumable now, and continues only a target that matches the exact record the replay would have produced at that point. A bundle event that omits its payload is refused where it arrives rather than killing an adoption later, and an approval that expired is no longer recorded as a decision a person made.
  // The canonical config-free artifact weighed 2,021,072 B raw / 632,689 B gzip;
  // the reviewed Docker-defaults variant weighed 2,021,077 B raw / 632,739 B gzip;
  // the reviewed Pages variant weighed 2,021,150 B raw / 632,745 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,021,643 B raw /
  // 1975 KiB raw is the smallest whole-KiB step that clears that reading and leaves 757 B; 619 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 852 B.
  //
  // Re-measured after a stock artifact stopped carrying the development lab's own copy. The lab profile's outer freeze was annotated pure and its nested facts freeze was not, so dropping the object left the inner call standing and 231 B of lab wording — a loopback endpoint, disposable keys, a lab bucket — shipped in the Sessions pack where nothing could render it. Both annotations are load-bearing, and this pack is smaller for it.
  // The canonical config-free artifact weighed 2,020,837 B raw / 632,672 B gzip;
  // the reviewed Docker-defaults variant weighed 2,020,842 B raw / 632,621 B gzip;
  // the reviewed Pages variant weighed 2,020,915 B raw / 632,641 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,021,408 B raw /
  // 1975 KiB raw is the smallest whole-KiB step that clears that reading and leaves 992 B; 619 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 959 B.
  //
  // Re-measured after Select all stopped committing an answer a later render contradicts. It sets the panel's everything rule instead of copying the rows on screen, so a press before the conversations arrive still ticks every one of them; Clear still means the empty list on purpose; and the panel says it is still reading rather than claiming there is nothing to take out.
  // The canonical config-free artifact weighed 2,020,932 B raw / 632,654 B gzip;
  // the reviewed Docker-defaults variant weighed 2,020,937 B raw / 632,653 B gzip;
  // the reviewed Pages variant weighed 2,021,010 B raw / 632,642 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,021,504 B raw /
  // 1975 KiB raw is the smallest whole-KiB step that clears that reading and leaves 896 B; 619 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 863 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 2,020,126 B raw / 632,554 B gzip;
  // the reviewed Docker-defaults variant measures 2,020,131 B raw / 632,610 B gzip;
  // the reviewed Pages variant measures 2,020,204 B raw / 632,647 B gzip;
  // and the reviewed Google-Drive-configured variant measures 2,020,698 B raw /
  // 632,922 B gzip and sets both maxima.
  // 1974 KiB raw would have left 678 B, below the tripwire floor, so raw keeps the 1975 KiB step and leaves 1,702 B; 619 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 934 B.
  firstPartyJavaScriptAndWorkers: Object.freeze({ raw: 1975 * 1024, gzip: 619 * 1024 }),
  // isomorphic-git and xterm are mutually activated vendor engines with their
  // own per-pack caps. The pair now weighed 672.33 KiB raw / 186.61 KiB gzip:
  // the browser-Git pack grew (see optionalBrowserGit) and the Terminal pack
  // carries the in-terminal Git command surface, which Pass 2 reconnected to a
  // control after finding its 17 verb families had no caller at all. Both
  // vendor pins are unchanged, so all of the growth is first-party and
  // separately reviewable.
  // The journey pass adds the Terminal's Git handoff to this pair; both vendor
  // pins are unchanged, so the growth is first-party and reviewed above.
  // Re-measured by a clean rebuild at 692,792 B raw /
  // 192,510 B gzip. 188 KiB gzip would have left 2 bytes, the minifier/chunk
  // split tripwire documented for the baseline above, not a vendor-code change,
  // so gzip keeps one further whole-KiB step and leaves 1,026 bytes; raw does
  // not move.
  // Re-measured with bounded terminal authority release at 694,321 B raw /
  // 192,979 B gzip. The vendor pins remain byte-identical; the delta is the
  // first-party manager above. The existing ceilings leave 975 / 1,581 bytes,
  // both above the aggregate's 768-byte floor.
  // Weighed 679.15 KiB raw / 188.84 KiB gzip after the automatic terminal Git
  // sideband and Local Device Vault replacement work; raw takes the next
  // whole-KiB ceiling while gzip remains at 190 KiB.
  /* Current release artifact. */

  // An earlier reading of 694543 B raw and 192,600 B gzip set the ceilings
  // below — history, phrased so the parser reads the current pair.
  //
  // An earlier reading of 700,648 B raw and 194,795 B gzip followed the
  // trailing-slash remote canonicalization — history, phrased so the parser
  // reads the current pair below.
  //
  // Re-measured after the Terminal stopped carrying the folder attached from
  // this device. The vendor pins are byte-identical: isomorphic-git and xterm
  // are untouched, and the whole delta is the first-party mount fence and the
  // sentence it refuses with — the Terminal copies files into a sandbox and
  // writes them back outside the approval broker, which is a thing it may do to
  // a browser store and not to a person's own disk.
  //
  // The canonical config-free artifact measures 701,167 B raw / 195,050 B gzip;
  // the reviewed Docker-defaults variant measures 701,167 B raw / 195,050 B
  // gzip; the reviewed Pages variant measures 701,167 B raw / 195,052 B gzip;
  // and the reviewed Google-Drive-configured variant measures 701,167 B raw /
  // 195,053 B gzip and sets the gzip maximum. 685 KiB raw
  // would have left 273 B and 191 KiB gzip would have left 531 B, both below the
  // tripwire floor, so the 686/192 KiB steps leave 1,297 / 1,555 B.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact measures 701,167 B raw / 195,051 B gzip;
  // the reviewed Docker-defaults variant measures 701,167 B raw / 195,051 B gzip;
  // the reviewed Pages variant measures 701,167 B raw / 195,053 B gzip;
  // and the reviewed Google-Drive-configured variant measures 701,167 B raw /
  // 195,056 B gzip. 685 KiB raw would have left 273 B and 191 KiB gzip would
  // have left 528 B; the 686/192 KiB steps leave 1,297 / 1,552 B.
  //
  // Re-measured after a bundle stopped granting authority through its events.
  // The vendor pins are byte-identical again: isomorphic-git and xterm are
  // untouched, and the whole delta is one clause of the Terminal's own
  // refusal. It used to send a person to the Workspace "where every write to it
  // is reviewed", and a workbench save writes through the same port with no
  // broker; it now names what is actually true of that path.
  //
  // The canonical config-free artifact measures 701,198 B raw / 195,067 B gzip;
  // the reviewed Docker-defaults variant measures 701,198 B raw / 195,069 B gzip;
  // the reviewed Pages variant measures 701,198 B raw / 195,068 B gzip;
  // and the reviewed Google-Drive-configured variant measures 701,198 B raw /
  // 195,071 B gzip and sets the gzip maximum. 685 KiB raw would have left 242 B
  // and 191 KiB gzip would have left 513 B; the 686/192 KiB steps leave
  // 1,266 / 1,537 B.
  optionalVendorRuntimeAggregate: Object.freeze({ raw: 686 * 1024, gzip: 192 * 1024 }),
  // This absolute installed-JavaScript backstop follows the smaller first-party
  // graph plus the reviewed browser-Git and Terminal packs.
  //
  // Earlier readings of 2,716,996 B raw and 823,700 B gzip, then 2,740,364 B raw
  // and 830,617 B gzip, then 2,747,723 B raw and 833,366 B gzip, then
  // 2,709,264 B raw and 821,976 B gzip are history and are not phrased as
  // measurements, so the parser reads the current pairs below.
  //
  // The whole movement is the loopback storage lab leaving a stock artifact;
  // vendor code is unchanged and the browser-Git and Terminal packs are
  // byte-identical to the readings they carry.
  //
  // The canonical config-free artifact weighed 2,678,955 B raw / 812,079 B
  // gzip. The reviewed Docker-defaults variant weighed 2,678,928 B raw /
  // 812,124 B gzip, the reviewed Pages variant weighed 2,679,028 B raw /
  // 812,146 B gzip, and the reviewed Google-Drive-configured variant weighed
  // 2,679,490 B raw / 812,410 B gzip and set both maxima. 2617 KiB raw would
  // have left 318 B and 794 KiB gzip would have left 646 B, both below the
  //
  // Earlier readings of 2,713,496 B raw and 824,579 B gzip (canonical),
  // 2,713,501 B raw and 824,602 B gzip (Docker defaults), 2,713,574 B raw and
  // 824,626 B gzip (Pages) and 2,714,067 B raw and 824,844 B gzip
  // (Google-Drive-configured) are history and are not phrased as measurements.
  //
  // Re-measured after the bundle/folder authority repair. It is the sum of the
  // first-party growth described two ceilings above and the Terminal mount
  // fence described one ceiling above; vendor code is unchanged.
  //
  // The canonical config-free artifact weighed 2,718,111 B raw / 826,187 B
  // gzip; the reviewed Docker-defaults variant weighed 2,718,116 B raw /
  // 826,235 B gzip; the reviewed Pages variant weighed 2,718,184 B raw /
  // 826,267 B gzip; and the reviewed Google-Drive-configured variant weighed
  // 2,718,585 B raw / 826,516 B gzip and set both maxima. 2655 KiB raw would
  // have left 135 B, below the tripwire floor, so raw takes 2656 KiB and leaves
  // 1,159 B; gzip takes its smallest clearing step to 808 KiB and leaves 876 B.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact weighed 2,718,283 B raw / 826,281 B gzip;
  // the reviewed Docker-defaults variant weighed 2,718,288 B raw / 826,270 B gzip;
  // the reviewed Pages variant weighed 2,718,361 B raw / 826,306 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,718,854 B raw /
  // 826,636 B gzip. 2656 KiB raw would have left 890 B and 808 KiB gzip would
  //
  // Re-measured after the product-audit repair. It is the first-party growth
  // described one ceiling above and nothing else; vendor code is unchanged.
  //
  // The canonical config-free artifact weighed 2,719,872 B raw / 826,807 B gzip;
  // the reviewed Docker-defaults variant weighed 2,719,877 B raw / 826,832 B gzip;
  // the reviewed Pages variant weighed 2,719,950 B raw / 826,904 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,720,360 B raw /
  // 827,057 B gzip and set both maxima. 808 KiB gzip would have left 335 B,
  // below the tripwire floor, so gzip keeps the 809 KiB step and leaves 1,359 B;
  // 2657 KiB raw leaves 408 B and does not move.
  //
  // Re-measured after a bundle stopped granting authority through its events.
  // It is the first-party growth described one ceiling above plus the Terminal
  // sentence one ceiling above that, and nothing else; vendor code is unchanged.
  //
  // The canonical config-free artifact weighed 2,720,683 B raw / 827,195 B gzip;
  // the reviewed Docker-defaults variant weighed 2,720,656 B raw / 827,172 B gzip;
  // the reviewed Pages variant weighed 2,720,729 B raw / 827,215 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,721,129 B raw /
  // 827,398 B gzip and set both maxima. 2658 KiB raw would have left 663 B,
  // below the tripwire floor, so raw takes the 2659 KiB step and leaves 1,687 B;
  // 809 KiB gzip is already the smallest step that clears the reading and leaves
  // 1,018 B.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact weighed 2,720,672 B raw / 827,176 B gzip;
  // the reviewed Docker-defaults variant weighed 2,720,677 B raw / 827,158 B gzip;
  // the reviewed Pages variant weighed 2,720,750 B raw / 827,193 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,721,243 B raw /
  // 827,427 B gzip. 2658 KiB raw would have left 549 B and 809 KiB gzip would
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 2,722,022 B raw / 827,647 B gzip;
  // the reviewed Docker-defaults variant weighed 2,722,027 B raw / 827,638 B gzip;
  // the reviewed Pages variant weighed 2,722,100 B raw / 827,692 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,722,593 B raw /
  // 827,945 B gzip. 2659 KiB raw would have left 223 B and 809 KiB gzip would
  //
  // Re-measured after the journal-integrity repair. An adoption a storage failure interrupted is finished on the next
  // attempt instead of being refused as a conflicting session forever; a bundle event carrying no payload is refused by
  // the reader that can still name the file, rather than by the Vault the person adopts weeks later; and an approval
  // nobody answered stops being journaled as a decision a person made. The delta is `replayedRecord` and one head
  // helper in the merge primitive, one condition in the bundle reader, and one shared `approvalWasAnswered` predicate
  // that replaced four spellings of the same test — which is why the entry chunk got eight bytes smaller.
  // The canonical config-free artifact weighed 2,722,302 B raw / 827,764 B gzip;
  // the reviewed Docker-defaults variant weighed 2,722,275 B raw / 827,811 B gzip;
  // the reviewed Pages variant weighed 2,722,380 B raw / 827,805 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,722,748 B raw /
  // 827,948 B gzip and set both maxima before the repair below.
  //
  // Re-measured after adoption stopped stranding a conversation. A transient failure part-way through moving a journal into a Vault used to leave a genesis stub that every later attempt refused by name, forever; a replay is resumable now, and continues only a target that matches the exact record the replay would have produced at that point. A bundle event that omits its payload is refused where it arrives rather than killing an adoption later, and an approval that expired is no longer recorded as a decision a person made.
  // The canonical config-free artifact weighed 2,722,270 B raw / 827,756 B gzip;
  // the reviewed Docker-defaults variant weighed 2,722,275 B raw / 827,811 B gzip;
  // the reviewed Pages variant weighed 2,722,348 B raw / 827,814 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,722,841 B raw /
  // 828,071 B gzip and set both maxima.
  // 2659 KiB raw would have left -25 B, so raw took the 2660 KiB step and left
  // 999 B; 809 KiB gzip was already the smallest step that cleared it, at 345 B.
  //
  // Re-measured after a stock artifact stopped carrying the development lab's own copy. The lab profile's outer freeze was annotated pure and its nested facts freeze was not, so dropping the object left the inner call standing and 231 B of lab wording — a loopback endpoint, disposable keys, a lab bucket — shipped in the Sessions pack where nothing could render it. Both annotations are load-bearing, and this pack is smaller for it.
  // The canonical config-free artifact weighed 2,722,035 B raw / 827,743 B gzip;
  // the reviewed Docker-defaults variant weighed 2,722,040 B raw / 827,690 B gzip;
  // the reviewed Pages variant weighed 2,722,113 B raw / 827,709 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,722,606 B raw /
  // 827,966 B gzip and set both maxima.
  // 2659 KiB raw would have left 210 B, below the tripwire floor, so raw keeps the 2660 KiB step and leaves 1,234 B; 809 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 450 B.
  //
  // Re-measured after Select all stopped committing an answer a later render contradicts. It sets the panel's everything rule instead of copying the rows on screen, so a press before the conversations arrive still ticks every one of them; Clear still means the empty list on purpose; and the panel says it is still reading rather than claiming there is nothing to take out.
  // The canonical config-free artifact weighed 2,722,130 B raw / 827,722 B gzip;
  // the reviewed Docker-defaults variant weighed 2,722,135 B raw / 827,721 B gzip;
  // the reviewed Pages variant weighed 2,722,208 B raw / 827,710 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 2,722,702 B raw /
  // 2659 KiB raw would have left 114 B, below the tripwire floor, so raw keeps the 2660 KiB step and leaves 1,138 B; 809 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 352 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 2,721,324 B raw / 827,624 B gzip;
  // the reviewed Docker-defaults variant measures 2,721,329 B raw / 827,683 B gzip;
  // the reviewed Pages variant measures 2,721,402 B raw / 827,719 B gzip;
  // and the reviewed Google-Drive-configured variant measures 2,721,896 B raw /
  // 827,993 B gzip and sets both maxima.
  // 2659 KiB raw is the smallest whole-KiB step that clears that reading and leaves 920 B; 809 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 423 B.
  totalJavaScriptAndWorkers: Object.freeze({ raw: 2659 * 1024, gzip: 809 * 1024 }),
  // The independently loaded offline shell worker is not application-bundle
  // startup cost. It weighed 6,216 B raw / 2,337 B gzip after credential and
  // no-store cache bypasses. 7 KiB raw leaves 952 B; gzip stays at 4 KiB
  // because 3 KiB would leave only 735 B.
  // Re-weighed at 11,268 B raw / 3,511 B gzip after exact worker fetches began
  // refusing redirects and revalidating cached response URL/type provenance.
  // The tight 12/5 KiB steps leave 1,020 / 1,609 B; 4 KiB gzip would have left
  // only 585 B.
  serviceWorker: Object.freeze({ raw: 12 * 1024, gzip: 5 * 1024 }),
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
  // Weighed 8.12 KiB raw / 3.17 KiB gzip, still fetched only with the runtime.
  optionalExecutionSupport: Object.freeze({ raw: 10 * 1024, gzip: 4 * 1024 }),
  // Shared implementation behind the lazy agent tool bundle and the
  // second-level execution-engine facade. Vite splits it because both import
  // the same worker/WASI/workspace dispatcher. It is never part of first paint.
  //
  // The pack grew twice before this: once when Pass 2 consolidated helpers that
  // had been declared once per tool module (`stringArgument` in seven places,
  // `deepFreeze` in twenty, two byte formatters, the UUID source) into the one
  // chunk both importers share — total shipped JavaScript did not grow, the
  // copies elsewhere went away — and once when exact conversation return added
  // the journal's audited-head append, so selection compare-and-sets the head it
  // replayed instead of rebasing onto a concurrent turn. Those readings are not
  // restated here: they describe artifacts this build no longer produces, and a
  // superseded figure above a live ceiling is exactly what the rule below reads
  // as a raise nobody reviewed.
  /* Current release artifact. */
  //
  // An earlier reading of 58,841 B raw / 16,881 B gzip followed the
  // surface-repair sweep, and that one went *down* too — kept as history, and
  // deliberately not phrased as a measurement, because this file's parser
  // takes the largest figure any "measured" sentence states and a superseded
  // reading would otherwise outrank the current one. `registerExecutionTools` was a second, eager copy
  // of every execution tool's schema that nothing called — the product registers
  // through `registerLazyExecutionTools` — and it had already drifted: the dead
  // copy never learned `execute_shell`. Deleting it removed the duplicate
  // schemas rather than any capability. Both ceilings take the smallest whole-
  // KiB step that clears the new reading, so raw falls to 58 KiB (551 B) and
  // gzip to 17 KiB (527 B). A ceiling left where a shrink found it is headroom
  // nobody reviewed.
  //
  // An earlier reading of 46,622 B raw and 13,771 B gzip followed the deletion
  // of the legacy blob-worker sources — history, phrased so the parser reads
  // the current readings below rather than a superseded pair.
  //
  // In this tree the canonical config-free artifact measures 47,269 B raw /
  // 13,940 B gzip, the reviewed origin-inlined variant measures 47,269 B raw /
  // 13,940 B gzip, and the reviewed Pages variant measures 47,285 B raw /
  // 13,943 B gzip. Pages sets both maxima. The tight 47 KiB raw
  // step leaves 843 B. 14 KiB gzip would have left 393 B, below the tripwire
  // floor, so gzip keeps 15 KiB and leaves 1,417 B. No capability moved back to
  // startup.
  optionalExecutionTools: Object.freeze({ raw: 47 * 1024, gzip: 15 * 1024 }),
  // Pinned browser_wasi_shim plus Airship's bounded virtual-filesystem Worker.
  // It is fetched only when the precompiled WASI adapter executes a command.
  optionalWasiPreview1Worker: Object.freeze({ raw: 32 * 1024, gzip: 8 * 1024 }),
  // Page-local dependency reuse, full-source preflight, single-flight
  // activation, cancellation cleanup, and real npm readiness evidence make
  // install → build reliable in one conversation. The shipped fetch_url
  // escalation now lives in this same second-level lazy pack: its reviewed
  // Node relay, binary workspace handoff, digest verification and scratch
  // cleanup are fetched only when Node execution/egress is first used. The
  // combined artifact now weighed 40,267 B raw / 14,355 B gzip with transient
  // reset retries and the bare Node compatibility profile. 40 KiB raw would
  // have left 693 bytes, below the tripwire floor, so the lazy pack takes
  // 41/15 KiB without charging that capability to eager tools.
  optionalNodeExecutionPack: Object.freeze({ raw: 41 * 1024, gzip: 15 * 1024 }),
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
  // Shared route chrome fetched with any route, never at first paint. After
  // memory dedup landed, the recall rankers (bm25 987 B, dedup 5,721 B) joined
  // this pack as shared lazy chunks between the Memory view and the agent
  // tools lane: Rollup hoised them out of both bundles exactly the way
  // phone-viewport comments below describe for route chrome, so this is their
  // home, weighed 17,345 B raw / 7,412 B gzip all-in — the ceilings keep
  // 0.76 KiB of gzip tripwire room above that reading.
  optionalRoutePrimitives: Object.freeze({ raw: 24 * 1024, gzip: 8 * 1024 }),
  // Bounded provider/error projection is fetched on the first failed request
  // (or with a deferred provider route), not on a successful first paint.
  // Weighed 2,583 B raw / 1,232 B gzip.
  //
  // The turn-failure vocabulary joined it here — the footer cause words, the
  // "nothing had arrived yet" rule and the chunk-load translation — because
  // they are fetched in the same handler at the same moment. This is a *net*
  // move off first paint: the entry chunk gave up those sentences to gain this
  // budget line. Weighed together 4,797 B raw / 2,317 B gzip; each ceiling
  // takes the lowest whole KiB above the reading.
  optionalRequestFailure: Object.freeze({ raw: 5 * 1024, gzip: 3 * 1024 }),
  // Slash-command parser, registry, planner and completer.
  optionalSlashCommands: Object.freeze({ raw: 32 * 1024, gzip: 10 * 1024 }),
  // The full inspect-act-verify loop is fetched on the first sent turn. Live
  // environment capture and persisted evidence scheduling had put the pack at
  // 49,170 B raw / 14,093 B gzip.
  //
  // In-turn provider resilience now joins it, and this pack is the only place
  // it can live: the attempt loop has to sit where the turn can see whether the
  // stream was ever observed, because a failure after the first event can never
  // be redelivered. What landed is jittered decorrelated backoff, an RFC 7231
  // `Retry-After` parse (delay-seconds and HTTP-date), the classification that
  // says a 429 or a 5xx may be repeated while a 400 or a 401 may not, and the
  // materialization that keeps a cancelled turn's completed tool results rather
  // than discarding the turn whole. Weighed 49.48 KiB raw / 14.33 KiB gzip;
  // both ceilings take the smallest whole-KiB step above that reading. First
  // paint is fixed — none of this is fetched until a turn is sent.
  //
  // The turn loop now also stops wasting itself. Three mechanisms land in this
  // pack because all three are properties of the loop rather than of any tool:
  // a per-turn repeat detector keyed on the broker's own `(tool, arguments)`
  // digest, which warns inside the tool message the model actually reads and
  // ends the turn on the fifth identical failure instead of burning 32 steps on
  // it; a work-plan restatement emitted when a compaction fires, so a long turn
  // stops having to remember to call `list_tasks` to remember its own plan; and
  // parallel dispatch of consecutive read-effect calls, which is the smallest
  // of the three on disk and the largest in latency. The restatement carries a
  // canonical renderer because the session audit rebuilds every request this
  // turn was digested over and has to reproduce the note byte for byte.
  // Weighed 52.08 KiB raw / 15.33 KiB gzip; both ceilings take the smallest
  // whole-KiB step above that reading, leaving 942 bytes raw and 686 gzip.
  // Still nothing before the first sent turn.
  // Re-weighed at 54,276 B raw / 16,049 B gzip after the surface-repair sweep,
  // four bytes over the raw ceiling. The whole delta is the turn loop learning
  // to say what it did: a tool call whose arguments fail their schema is no
  // longer journaled as a terminal the audit rejects, a reasoning block cut off
  // by the final delta keeps its `truncated` marker, a provider `length` finish
  // on a tool-call step is no longer overwritten with "tool-calls" and so still
  // reaches the severed-reply disclosure, and a registry refusal names the tool
  // that does not exist instead of reporting "Permission denied" for it. Raw
  // takes one whole-KiB step to 54 KiB, leaving 1,020 bytes; gzip is unchanged
  // and keeps 335 bytes of its own. Still nothing before the first sent turn.
  // Re-weighed at 57,019 B raw / 16,721 B gzip after the JavaScript kernel
  // gained a private controller closure, a generation capability, strict host
  // frame validation, and adversarial channel isolation. 56 KiB raw would leave
  // 325 B and 17 KiB gzip would leave 687 B, both under the 768-byte tripwire;
  // 57/18 KiB leave 1,349 / 1,711 B.
  optionalAgentRuntime: Object.freeze({ raw: 57 * 1024, gzip: 18 * 1024 }),
  /*
   * The session view's runtime-status tag — the surface that answers whose
   * engine owns a conversation, and what to do about a pin the person did
   * not choose. Lazily fetched beside the session view; still nothing
   * before the first sent turn. Weighed 1,656 B raw / 765 B gzip; the
   * claim, as always in this file, is the floor across both build modes.
   */
  optionalAgentRuntimeStatus: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  // Image normalization is fetched only when a turn actually carries an image;
  // text-only first paint and text-only turns do not pay for it. Weighed
  // 2,343 B raw / 1,153 B gzip.
  optionalMultimodal: Object.freeze({ raw: 3 * 1024, gzip: 2 * 1024 }),
  // Provider context-window policy construction runs only while binding a
  // model with an advertised limit. Weighed 3,719 B raw / 1,321 B gzip.
  optionalContextPolicy: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  // The registry, local retrieval broker, live-environment projection, and
  // repository admission logic load together when an agent-capable workspace
  // is first constructed. fetch_url's manifest/ladder and binary workspace
  // handoff stay here, while its engine and relay remain in the second-level
  // Node pack. Weighed 128,071 B raw / 39,814 B gzip after the dead reviewer
  // and architecture islands left the lazy graph. 126 KiB raw leaves 953 B;
  // 39 KiB gzip would have left 122 B, so gzip takes 40 KiB and leaves 1,146 B.
  // Nothing moves to first paint.
  optionalAgentTools: Object.freeze({ raw: 126 * 1024, gzip: 40 * 1024 }),
  // The provider-neutral Workspace route keeps the editor, tree, source-control
  // handoff, and accessibility repairs while dropping obsolete proof chrome.
  // Weighed 86,877 B raw / 27,519 B gzip. 85 KiB raw would have left
  // 163 B and 27 KiB gzip would have left 129 B. The next steps leave
  // 1,187 / 1,153 B above the tripwire floor.
  // An earlier reading of 87,494 B raw and 27,689 B gzip followed the deferred
  // loader for the attached-folder panel — history, phrased so the parser reads
  // the current pair below.
  //
  // Re-measured after the attached folder became a Profile's own attachment:
  // the route now names the Profile it opens, remembers and forgets a folder
  // for, which is one prop on the panel it already loaded. The canonical
  // config-free artifact measures 87,523 B raw / 27,687 B gzip; the reviewed
  // Docker-defaults variant measures 87,523 B raw / 27,687 B gzip; the reviewed
  // Pages variant measures 87,523 B raw / 27,688 B gzip; and the reviewed
  // Google-Drive-configured variant measures 87,523 B raw / 27,688 B gzip and
  // sets the gzip maximum. Both ceilings are already the smallest whole-KiB
  // step that clears those readings, leaving 541 B raw and 984 B gzip.
  optionalWorkspaceWorkbench: Object.freeze({ raw: 86 * 1024, gzip: 28 * 1024 }),
  // Held only the Git workspace binding, at 519 B raw / 345 B gzip. It now also
  // holds the one bounded content scan: `search_text` and the Explorer's Contents
  // filter both import it, so Rollup gives it to the chunk those two share rather
  // than inlining a copy in each — the Workspace route shed 1,556 raw bytes of
  // its own copy in the same build. The scan grew a resume cursor, an `include`
  // path glob and a summary that names every bound that fired, because the tool's
  // separate copy could answer "0 matches" for a filter that had selected no file
  // to search at all. Weighed 3,844 B raw / 1,741 B gzip; both ceilings are the
  // tightest whole-KiB step that clears that reading. Still fetched only when the
  // Workspace route or the agent's tool bundle binds, so first paint is untouched.
  optionalWorkspaceBinding: Object.freeze({ raw: 4 * 1024, gzip: 2 * 1024 }),
  optionalWorkspaceCodec: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  /*
   * The folder-on-this-device storage tier: the `WorkspacePort` over a
   * `FileSystemDirectoryHandle`, the IndexedDB record that lets one survive a
   * reload, the permission query/request wrappers, the composition with the
   * Profile workspace, and the Workspace panel that opens and revokes it.
   *
   * It is fetched in exactly two places, both after first paint: the Workspace
   * route draws the panel, and a shell whose `localStorage` marker says a
   * folder was attached restores it. A browser that has never opened a folder
   * and never visits #workspace never fetches these bytes at all, which is why
   * the tier gets its own ceiling instead of joining the workbench's.
   *
   * An earlier reading of 14,282 B raw and 5,616 B gzip is history and is not
   * phrased as a measurement.
   *
   * The tier is now siloed to a Profile. One IndexedDB key and one
   * `localStorage` marker had meant a folder opened while reading under one
   * Profile was composed into `/workspace/local` for every other Profile in the
   * browser, which is the one storage boundary every other tier here respects.
   * The key names the Profile, the record carries it, and a record that names a
   * different one is refused. The panel also says what the fence does, because
   * a promise about approvals that the Terminal and Auto Approve did not keep
   * is worse than no promise.
   *
   * Every reviewed variant weighed 14,974 B raw / 5,805 B gzip across its
   * two chunks — the port and the panel — before the row layout below.
   */
  //
  // Re-measured with the disclosure row and the profile-scoped attachment.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact weighed 15,006 B raw / 5,826 B gzip;
  // the reviewed Docker-defaults variant weighed 15,006 B raw / 5,826 B gzip;
  // the reviewed Pages variant weighed 15,006 B raw / 5,826 B gzip;
  // and the reviewed Google-Drive-configured variant measures 15,006 B raw /
  // 5,826 B gzip. 15 KiB raw would have left 354 B and 6 KiB gzip would
  // have left 318 B; the 16/7 KiB steps leave 1,378 / 1,342 B.
  //
  // Re-measured after the folder tier stopped promising a fence it does not
  // have. The three doors it named — the Vault, Airship's Git, off this device —
  // are all real and all still shut. A fourth was not named: the conversation
  // journal keeps tool results, so a folder file the agent reads once comes out
  // in the clear inside a readable bundle. The tool payload is deliberately not
  // fenced, because it is the provenance that makes a transcript checkable; the
  // sentence is what changed, in all three places it was written.
  //
  // Every reviewed variant — config-free, Docker defaults, Pages and
  // Google-Drive-configured — weighed 15,218 B raw / 5,892 B gzip. 15 KiB raw
  // would have left 142 B, below the tripwire floor, so raw keeps the 16 KiB
  // step and leaves 1,166 B; 6 KiB gzip is already the smallest step that clears
  // the reading and leaves 252 B.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact measures 15,205 B raw / 5,881 B gzip;
  // the reviewed Docker-defaults variant measures 15,205 B raw / 5,881 B gzip;
  // the reviewed Pages variant measures 15,205 B raw / 5,881 B gzip;
  // and the reviewed Google-Drive-configured variant measures 15,205 B raw /
  // 5,881 B gzip. 15 KiB raw would have left 155 B and 6 KiB gzip would
  // have left 263 B; the 16/6 KiB steps leave 1,179 / 263 B.
  optionalLocalFolder: Object.freeze({ raw: 16 * 1024, gzip: 6 * 1024 }),
  // The current Source Control presentation measures 39,337 B raw / 12,521 B
  // gzip. 39 KiB raw would have left 599 B; 40/13 KiB leave 1,623 / 791 B.
  optionalSourceControl: Object.freeze({ raw: 40 * 1024, gzip: 13 * 1024 }),
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
  // pack measures 267,462 B raw / 81,003 B gzip in the candidate tree after the
  // exact-origin, redirect-free reviewed HTTP boundary gained trailing-slash
  // remote canonicalization. The reviewed origin-inlined variant also measures
  // 267,462 B raw / 81,003 B gzip. The artifact is 198 B over 261 KiB raw and
  // 107 B over 79 KiB gzip; the tight 262/80 KiB steps leave 826 / 917 B.
  optionalBrowserGit: Object.freeze({ raw: 262 * 1024, gzip: 80 * 1024 }),
  // Profile-local thread expansion, durable favorite order, coherent resume,
  // branch and true-fork affordances remain behind the Chat/session route.
  //
  // Pass 2 added the verb this product had promised and never had: deleting a
  // conversation, with the shared destructive confirmation and an announcement
  // that states what left and from where. It also lifted the list's silent
  // 200-row cap into a stated bound with a load-more control. Weighed
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
  //
  // Re-weighed at 64,411 B raw / 19,292 B gzip. The 3,401 bytes are
  // `conversations: a way back into a pinned conversation that is not a fork`
  // (ebb61fb): `sessions-presentation` — the projection that decides what a
  // pinned thread looks like when you return to it rather than branch from it —
  // and the row and empty-state work in `sessions-view` that renders it. Both
  // are Sessions code, fetched when the route opens and never at first paint.
  // 63 KiB raw would have left 101 bytes and 19 KiB gzip would have left 164,
  // each far inside the margin a minifier rename moves and tighter than the
  // 305 B this file has already declined once, so both take the next step: raw
  // to 64 KiB (1,125 B) and gzip to 20 KiB (1,188 B).
  //
  // An earlier reading of 63,885 B raw and 18,972 B gzip followed the shared Run
  // details renderer and local naming path replacing duplicate route work.
  //
  // The Vault route travels in this pack, so the loopback lab's provider column
  // — its title, description, note and six comparison facts — left with the
  // rest of the lab. The canonical config-free artifact measures 64,880 B raw /
  // 19,224 B gzip, the reviewed Docker-defaults variant measures 64,868 B raw /
  // 19,228 B gzip, the reviewed Pages variant measures 64,880 B raw / 19,227 B
  // gzip, and the reviewed Google-Drive-configured variant measures 64,940 B raw
  // / 19,287 B gzip. Neither ceiling can move: 64 KiB raw would have left 596 B
  // and 19 KiB gzip would have left 169 B, both below the tripwire floor, so the
  // existing 64/20 KiB ceilings stand and leave 596 / 1,193 B. None of it is in
  // first paint.
  //
  // The route then had to carry one more fact to the move-work panel: whether
  // the journal a merge would land in is the authority that will still be there
  // when it lands. It is one boolean on a prop the route already passes, and it
  // is the whole delta here — 36 raw bytes. The canonical config-free, Docker
  // defaults and Pages variants weighed 65,792 B raw / 19,585 B gzip, and the
  // reviewed Google-Drive-configured variant measures 65,858 B raw / 19,642 B
  // gzip. Neither ceiling moves, leaving 1,726 B raw and 838 B gzip. Still
  // fetched on navigation and never at first paint.
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 65,780 B raw / 19,581 B gzip;
  // the reviewed Docker-defaults variant weighed 65,780 B raw / 19,582 B gzip;
  // the reviewed Pages variant weighed 65,780 B raw / 19,583 B gzip;
  // and the reviewed Google-Drive-configured variant measures 65,856 B raw /
  // 19,648 B gzip. 65 KiB raw would have left 704 B and 20 KiB gzip would
  //
  // Re-measured after a stock artifact stopped carrying the development lab's own copy. The lab profile's outer freeze was annotated pure and its nested facts freeze was not, so dropping the object left the inner call standing and 231 B of lab wording — a loopback endpoint, disposable keys, a lab bucket — shipped in the Sessions pack where nothing could render it. Both annotations are load-bearing, and this pack is smaller for it.
  // The canonical config-free artifact weighed 65,545 B raw / 19,505 B gzip;
  // the reviewed Docker-defaults variant weighed 65,545 B raw / 19,502 B gzip;
  // the reviewed Pages variant weighed 65,545 B raw / 19,503 B gzip;
  // and the reviewed Google-Drive-configured variant measures 65,621 B raw /
  // 65 KiB raw would still have cleared this reading, but the step is not taken back in the same pass that measured it; 66 KiB leaves 1,963 B; 20 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 915 B.
  //
  // Re-measured after Select all stopped committing an answer a later render contradicts. It sets the panel's everything rule instead of copying the rows on screen, so a press before the conversations arrive still ticks every one of them; Clear still means the empty list on purpose; and the panel says it is still reading rather than claiming there is nothing to take out.
  // The canonical config-free artifact measures 65,571 B raw / 19,509 B gzip;
  // the reviewed Docker-defaults variant measures 65,571 B raw / 19,508 B gzip;
  // the reviewed Pages variant measures 65,571 B raw / 19,513 B gzip;
  // and the reviewed Google-Drive-configured variant measures 65,648 B raw /
  // 65 KiB raw would still have cleared this reading, but the step is not taken back in the same pass that measured it; 66 KiB leaves 1,936 B; 20 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 904 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 65,571 B raw / 19,510 B gzip;
  // the reviewed Docker-defaults variant measures 65,571 B raw / 19,512 B gzip;
  // the reviewed Pages variant measures 65,571 B raw / 19,512 B gzip;
  // and the reviewed Google-Drive-configured variant measures 65,648 B raw /
  // 65 KiB raw would still have cleared this reading, but the step is not taken back in the same pass that measured it; 66 KiB leaves 1,936 B; 20 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 904 B.
  optionalSessionLibrary: Object.freeze({ raw: 66 * 1024, gzip: 20 * 1024 }),
  // Session pin/digest construction, receipt inspection, route recovery, and
  // cross-tab status load after the shell can paint. They remain exact,
  // separately named chunks under this unchanged aggregate ceiling.
  optionalSessionManifest: Object.freeze({ raw: 7 * 1024, gzip: 3 * 1024 }),
  // Pure keyboard/drop intent translation loads when a favorite is first
  // reordered; journal order remains owned by the Session Library.
  optionalFavoriteOrdering: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
  // Historical true-fork audit, bounded context preparation, and seed sealing
  // are fetched only when a fork is requested (or the lazy agent validates a
  // fork lineage). Re-measured together at 13,437 B raw / 4,917 B gzip after
  // the current fork-context binding changes. The tight 14/6 KiB steps leave
  // 899 / 1,227 B; 5 KiB gzip would have left only 203 B.
  optionalSessionFork: Object.freeze({ raw: 14 * 1024, gzip: 6 * 1024 }),
  // The lazy route now includes the live current/peak execution reading,
  // actionable primitive remediation, and the Companion relay/cache/compute
  // observation instead of making those capabilities settings-only facts.
  // Measured 12,409 B raw / 4,229 B gzip. Raw holds at 13 KiB, the smallest whole
  // KiB above it — the route had already outgrown 11 KiB, and 12 KiB does not fit
  // at all. Gzip comes back down to a half-KiB step: 4.5 KiB clears the
  // measurement by 379 bytes, where the 5 KiB it had been raised to granted 21% of
  // the pack as headroom that no measurement asked for. This route is fetched on
  // navigation; none of it enters first paint.
  /* Current release artifact. */

  // Measured 12401 B raw / 4,214 B gzip.
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
  //
  // The phase-1 duplicate reviewer joined the records panel: the cluster
  // strip, its keeper/fold-in prose, and the session-scoped dismiss affordance
  // render only while clusters exist, so the whole wave rides the route that
  // was already fetched on navigation — re-measured at 64,158 B raw / 21,344 B
  // gzip, the claim standing at the floor across both build modes with the
  // origin-inlined Docker variant measuring one raw byte and twenty-nine gzip
  // bytes under the config-free CI artifact, and its own reading wandering by
  // single bytes between runs.
  //
  // In this tree the canonical config-free artifact measures 64,236 B raw /
  // 21,348 B gzip. The reviewed Pages variant measures 64,236 B raw / 21,347 B
  // gzip, and the reviewed origin-inlined variant measures 64,236 B raw /
  // 21,346 B gzip. 63 KiB raw would have left 276 B, below the tripwire floor,
  // so raw keeps 64 KiB and leaves 1,300 B. Gzip is already at the smallest
  // whole-KiB step that clears its reading, leaving 156 B.
  optionalMemoryView: Object.freeze({ raw: 64 * 1024, gzip: 21 * 1024 }),
  // Small shared node-shape vocabulary split out by Vite because both the
  // Memory route and deferred graph renderer consume it.
  // Memory's small shared modules: the kind glyphs, and now the memory.json
  // document schema itself. The schema was reachable only through
  // `memory-tools.ts`, which also carries the tool definitions, the dedup
  // rankers and the registry — so any surface that merely needed to read or
  // write the file pulled all of it: the work bundle's memory merge measured
  // 35 KiB of chunk for a parser worth about two. Split out, it is one shared
  // chunk the agent tool bundle, the Memory route and the work bundle each
  // point at instead of each carrying a copy; `tool-bundle` gave up 2,019 B in
  // the same build. Measured together 2,604 B raw / 1,105 B gzip
  // (kind-visual 432/213, memory-document 2,172/892); both ceilings take the
  // smallest whole-KiB step above that reading. Fetched with the Memory route,
  // an agent turn or the move-work panel — never at first paint.
  optionalMemorySupport: Object.freeze({ raw: 3 * 1024, gzip: 2 * 1024 }),
  /*
   * Taking work out of Airship, and bringing it back in.
   *
   * `downloadBytes` had exactly two callers — one workspace file and the whole
   * encrypted Vault — so `docs/PRODUCT_SPEC.md`'s "fork, resume, export, or
   * delete work without vendor lock-in" was three verbs out of four. This pack
   * is the fourth: the bundle reader and writer, the digest re-verification
   * that makes "the digests survived" a checked claim, the import plan that
   * states what will happen before anything is written, and the panel that
   * says it. The merge itself is `migrateJournalState`, which already exists
   * in the deferred capability pack and is fetched only when an import runs.
   *
   * An earlier reading of 16,173 B raw and 5,114 B gzip is history and is not
   * phrased as a measurement.
   *
   * The pack then learned that a readable file is not authority. A verified
   * digest chain says the events in a bundle were not edited after they were
   * written; it says nothing about who wrote them, because any file can carry a
   * chain that verifies. So the reader now refuses a record that carries an
   * approval mode, a model, a context policy or a storage fence — every pin the
   * journal projection reads back with the record's own value as its fallback —
   * refuses a manifest whose system prompt does not hash to its own digest,
   * imports memory only into the profile doing the importing and only when the
   * person asks for it, and stamps what it writes as having arrived in a file so
   * it is read here and forked to continue. Each refusal states what it refused
   * and what to do, which is where most of the bytes are.
   *
   * The canonical config-free artifact weighed 17,724 B raw / 5,645 B gzip;
   * the reviewed Docker-defaults variant weighed 17,724 B raw / 5,646 B gzip;
   * the reviewed Pages variant weighed 17,724 B raw / 5,647 B gzip; and the
   * reviewed Google-Drive-configured variant measures 17,724 B raw / 5,648 B
   * gzip and sets the gzip maximum. Both ceilings take the
   * smallest whole-KiB step that clears those readings: 18 KiB raw leaves 708 B
   * and 6 KiB gzip leaves 496 B. Nothing here is fetched until someone presses
   * "Move work", so first paint, the Chat route and the Sessions route are all
   * unchanged by it.
   */
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact weighed 17,724 B raw / 5,646 B gzip;
  // the reviewed Docker-defaults variant weighed 17,724 B raw / 5,645 B gzip;
  // the reviewed Pages variant weighed 17,724 B raw / 5,645 B gzip;
  // and the reviewed Google-Drive-configured variant measures 17,724 B raw /
  // 5,647 B gzip. 18 KiB raw would have left 708 B and 6 KiB gzip would
  //
  // Re-measured after the pack learned to wait for the journal it writes into.
  // Bringing work in on a new device is the first thing a person does with this
  // feature and it was the one case it could not do: with a Vault configured,
  // the page-memory runtime boots first and adoption replaces the journal an
  // import had just been written into — measured as "1 conversation added",
  // present at t+3ms, gone after the adoption, after Refresh and after a reload.
  // The import action is now gated on the same settled-authority latch the chat
  // route waits for, says why while it is unavailable, and refuses rather than
  // queues. Taking work out is untouched: an export writes nothing.
  //
  // The canonical config-free and reviewed Docker-defaults artifacts weighed
  // 18,082 B raw / 5,790 B gzip; the reviewed Pages variant measures 18,082 B
  // raw / 5,791 B gzip and the reviewed Google-Drive-configured variant weighed
  // 18,082 B raw / 5,788 B gzip. 18 KiB raw would have left
  // 350 B, below the tripwire floor, so raw keeps the 19 KiB step and leaves
  // 1,374 B; 6 KiB gzip is already the smallest step that clears the reading and
  // leaves 353 B.
  //
  // Re-measured after the reader stopped casting the record it reads. A session
  // record is now built field by field from an allowlist, so a key this build
  // has never heard of is refused by name rather than written onto a journal
  // record — which is what made the next pin added to `SessionRecord`
  // file-granted from the day it was declared. Beside it, a conversation the
  // file addresses to a profile that is not the one importing is planned as a
  // conflict and the applier asks the same question again before it writes.
  // Both refusals say what they refused and what to do, which is where the
  // bytes are; the two record-field refusals share one closing sentence.
  //
  // Every reviewed variant measures 18,708 B raw: the canonical config-free and
  // Docker-defaults artifacts measure 18,708 B raw / 5,997 B and 5,996 B gzip,
  // the reviewed Pages variant weighed 18,708 B raw / 5,998 B gzip and sets the
  // gzip maximum, and the reviewed Google-Drive-configured variant weighed
  // 18,708 B raw / 5,995 B gzip. Both ceilings are already the smallest
  // whole-KiB step that clears those readings: 19 KiB raw leaves 748 B and
  // 6 KiB gzip leaves 146 B. Nothing here is fetched until someone presses
  // "Move work".
  //
  // Re-measured after conversations stopped substituting for one another. A click on a running conversation now switches to it, an addressed conversation is opened rather than replaced by a freshly minted one, and a plan made against a journal that has been replaced is withdrawn instead of pressed. The delta is the manifest that mint used to supply, held directly now, plus the sentence that says a conversation is opening and the comparison that withdraws a stale plan.
  // The canonical config-free artifact weighed 19,127 B raw / 6,128 B gzip;
  // the reviewed Docker-defaults variant weighed 19,127 B raw / 6,128 B gzip;
  // the reviewed Pages variant weighed 19,127 B raw / 6,131 B gzip;
  // and the reviewed Google-Drive-configured variant weighed 19,127 B raw /
  // 6,129 B gzip. 19 KiB raw would have left 329 B and 6 KiB gzip would
  //
  // Re-measured after the journal-integrity repair. An adoption a storage failure interrupted is finished on the next
  // attempt instead of being refused as a conflicting session forever; a bundle event carrying no payload is refused by
  // the reader that can still name the file, rather than by the Vault the person adopts weeks later; and an approval
  // nobody answered stops being journaled as a decision a person made. The delta is `replayedRecord` and one head
  // helper in the merge primitive, one condition in the bundle reader, and one shared `approvalWasAnswered` predicate
  // that replaced four spellings of the same test — which is why the entry chunk got eight bytes smaller.
  // The canonical config-free artifact weighed 19,145 B raw / 6,137 B gzip;
  // the reviewed Docker-defaults variant weighed 19,145 B raw / 6,137 B gzip;
  // the reviewed Pages variant weighed 19,145 B raw / 6,139 B gzip;
  // and the reviewed Google-Drive-configured variant measures 19,145 B raw /
  // 6,137 B gzip; the Pages variant sets the gzip maximum and every variant
  // measures the same raw bytes.
  // 19 KiB raw is already the smallest whole-KiB step that clears the reading and leaves 311 B; 6 KiB gzip would have left 5 B, below the tripwire floor, so gzip keeps the 7 KiB step and leaves 1,029 B.
  //
  // Re-measured after adoption stopped stranding a conversation. A transient failure part-way through moving a journal into a Vault used to leave a genesis stub that every later attempt refused by name, forever; a replay is resumable now, and continues only a target that matches the exact record the replay would have produced at that point. A bundle event that omits its payload is refused where it arrives rather than killing an adoption later, and an approval that expired is no longer recorded as a decision a person made.
  // The canonical config-free artifact weighed 19,145 B raw / 6,137 B gzip;
  // the reviewed Docker-defaults variant weighed 19,145 B raw / 6,137 B gzip;
  // the reviewed Pages variant weighed 19,145 B raw / 6,138 B gzip;
  // and the reviewed Google-Drive-configured variant measures 19,145 B raw /
  // 19 KiB raw is the smallest whole-KiB step that clears that reading and leaves 311 B; 6 KiB gzip would have left 6 B, below the tripwire floor, so gzip keeps the 7 KiB step and leaves 1,030 B.
  //
  // Re-measured after Select all stopped committing an answer a later render contradicts. It sets the panel's everything rule instead of copying the rows on screen, so a press before the conversations arrive still ticks every one of them; Clear still means the empty list on purpose; and the panel says it is still reading rather than claiming there is nothing to take out.
  // The canonical config-free artifact weighed 19,214 B raw / 6,158 B gzip;
  // the reviewed Docker-defaults variant weighed 19,214 B raw / 6,158 B gzip;
  // the reviewed Pages variant weighed 19,214 B raw / 6,156 B gzip;
  // and the reviewed Google-Drive-configured variant measures 19,214 B raw /
  // 19 KiB raw is the smallest whole-KiB step that clears that reading and leaves 242 B; 7 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 1,009 B.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 19,207 B raw / 6,168 B gzip;
  // the reviewed Docker-defaults variant measures 19,207 B raw / 6,170 B gzip;
  // the reviewed Pages variant measures 19,207 B raw / 6,168 B gzip;
  // and the reviewed Google-Drive-configured variant measures 19,207 B raw /
  // 19 KiB raw is the smallest whole-KiB step that clears that reading and leaves 249 B; 7 KiB gzip is the smallest whole-KiB step that clears that reading and leaves 998 B.
  optionalWorkBundle: Object.freeze({ raw: 19 * 1024, gzip: 7 * 1024 }),
  // The complete Skills route: resolved-set grid, profile/global controls,
  // authored-skill removal guard, and the exact adjacent profile-switch
  // refusal. It is fetched only for `#skills`; the authoring form remains the
  // second-level `optionalSkillEditor` chunk below. The earlier reading of this
  // pack is not restated: it described an artifact this build no longer
  // produces, and a superseded figure above a live ceiling reads as a raise
  // nobody reviewed.
  //
  // An earlier reading of 7,344 B raw and 2,828 B gzip followed the surface
  // sweep — history, phrased so the parser reads the current pair below. The
  // named cause is that Edit now answers: pressing it mounted the authoring
  // panel above a scrolled-to grid, so from the reader's seat the click did
  // nothing at all, and the panel now comes to them — and only when it is not
  // already on screen, which is the part that costs the bytes. Raw takes one
  // whole-KiB step to 8 KiB, leaving 848 B; gzip stays inside 3 KiB with 243 — the Docker floor, one byte under this host.
  //
  // An earlier reading of 7,344 B raw and 3,100 B gzip recorded prime's skill
  // tools sharing the skill-file parser with this route — history, phrased so
  // the parser reads the current readings below.
  //
  // In this tree the canonical config-free and reviewed Pages artifacts measure
  // 7,974 B raw / 3,076 B gzip, and the reviewed origin-inlined variant measures
  // 7,974 B raw / 3,074 B gzip. Both ceilings are already the smallest whole-KiB
  // step that clears those readings: raw leaves 218 B and gzip leaves 1,020 B.
  //
  // The route then gave up `startConversationDisabledReason`, which had exactly
  // one producer: the shell's "Stop the active turn before starting a new
  // conversation." A new conversation has no turn of its own to collide with,
  // and with turns running per conversation that sentence was never true, so
  // the prop, its pre-emptive `disabled` and the status branch that split
  // "refused in advance" from "the attempt failed" are gone rather than
  // reworded. The reviewed Pages variant re-measures 7,883 B raw / 3,028 B
  // gzip. Both ceilings stay where they are; the shrink is recorded so it
  // cannot read later as headroom nobody reviewed.
  optionalSkillsManagerView: Object.freeze({ raw: 8 * 1024, gzip: 4 * 1024 }),
  // The authoring panel for a `custom.` skill: form, its stylesheet's JS shim,
  // and nothing else. Deferred because the Skills route is a grid people read
  // far more often than they write, and the six built-ins cannot be edited at
  // all — a visitor who never presses New skill or Edit pays nothing for it.
  // Named in MEASUREMENT_JUSTIFIED_BUDGETS, so this pair is enforced rather
  // than merely written: a placeholder left here fails the gate instead of
  // surviving it. An earlier reading of 3,396 B raw and 1,319 B gzip is kept as
  // history only: it described a smaller artifact than this build produces, and
  // a comment that understates its chunk reports headroom the build does not
  // have — the second direction this file's build comparison now checks.
  //
  // In this tree the canonical config-free artifact measures 4,002 B raw /
  // 1,587 B gzip, and the reviewed origin-inlined and Pages variants measure
  // 4,002 B raw / 1,587 B gzip. Both ceilings are already the smallest
  // whole-KiB step that clears those readings, leaving 94 B raw and 461 B gzip.
  // Neither ceiling moves.
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
   * first, never at first paint. Re-measured at 1,112 B raw / 650 B gzip after
   * the compression-gate (entry-lazy) and Preferences-reset consumers adopted
   * the shared grammar; 1 KiB raw was within minifier jitter of a comment
   * change, and this ceiling defends smallness, not minifier noise.
   */
  optionalConfirmDialog: Object.freeze({ raw: 2 * 1024, gzip: 1 * 1024 }),
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
   *
   * Re-measured at 7,219 B raw / 2,816 B gzip after the surface-repair sweep,
   * 51 bytes over the raw ceiling. The cause is the Preferences dialog telling
   * the truth about Durability: its reset confirmation used to promise the
   * vault was untouched in the same breath as resetting the vault backend the
   * row above it sets. Raw takes one whole-KiB step to 8 KiB, leaving 973
   * bytes; gzip is unchanged.
   */
  optionalShellOverlays: Object.freeze({ raw: 8 * 1024, gzip: 3 * 1024 }),
  /*
   * The command palette's conversation verbs.
   *
   * Words only — the host keeps the availability rules and the callbacks — and
   * nothing here can paint before ⌘K, so it is fetched on first open rather
   * than shipped in first paint.
   *
   * It shrank when turns became per conversation: New conversation and Rename
   * lost their `blocked` fields, because the only sentence that ever filled
   * them was the page-wide "Stop the active turn first." and neither verb is in
   * a running turn's way. Measured 936 B raw / 462 B gzip.
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
  /* See `isOptionalMessagePartsPath`. Measured 12,554 B raw / 4,516 B gzip.
   * Re-measured at 13,377 B raw / 4,673 B gzip: the reasoning part grew two
   * renders — the expanded "By default" Profile variant and a bounded pre-wrap
   * reading block — with the earlier render path reordered to land the cheapest
   * branch first. Trimmed first, so what the ceiling pays for is the second
   * default (expanded without a fold), not duplication. Raw takes one tighter
   * whole-KiB step. */
  optionalMessageParts: Object.freeze({ raw: 14 * 1024, gzip: 5 * 1024 }),
  /*
   * See `isOptionalApprovalDockPath`. Measured after the accessibility pass.
   *
   * The dock is now scoped to a conversation. The broker decides what may
   * interrupt (see `focusSession`), so this pack only had to learn to say
   * *whose* request it is: the dialog's eyebrow, the waiting bar's line and the
   * button that answers it all name the conversation, and the sentence spoken
   * on Escape quotes that button by the name it actually carries.
   * An earlier reading of 11,984 B raw and 4,308 B gzip is history and is not
   * phrased as a measurement.
   *
   * The pack then learned to say what is actually waiting and what is actually
   * known. "2 decisions waiting" printed one name, one clock and one button, so
   * the second request had no name a person could read and no control until the
   * first was answered — every deferred request now owns a row. The bar was a
   * `role="group"` with no live region, so a request filed because it came from
   * a conversation nobody is reading was announced only by the Escape handler,
   * which never fires for it — it now speaks once, from its own polite region
   * rather than the transcript narrator's. And a write approval drew "∅" as the
   * file's current content over a file that had content: the previous side is
   * drawn only when the arguments carry it, and the single value is labelled as
   * new content instead.
   *
   * Every reviewed variant measures 12,837 B raw / 4,576 B gzip, still less than
   * half this raw ceiling. That ceiling is not where this work is bounded: the
   * dock is fetched as the shell mounts, so the same bytes are also charged to
   * `allJavaScriptAndWorkers` above, which is the row with the real margin to
   * answer for.
   */
  optionalApprovalDock: Object.freeze({ raw: 24 * 1024, gzip: 8 * 1024 }),
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
  // The profile-authority shutdown now observes rejected provider exits, waits
  // for an overtaken jsh spawn before unmounting its cwd, and bounds forced
  // termination. Manual restart and close now use the same bounded stop and a
  // timed-out spawn retains its mounted authority. The standalone-command
  // parser also rejects shell operators and substitutions before the bridge is
  // claimed, keeping compound lines with jsh. Measured 422.32 KiB raw /
  // 111.14 KiB gzip; 423 KiB raw and 112 KiB gzip are the tightest whole-KiB
  // ceilings above those readings. First paint does not move. Still fetched
  // only when Terminal opens.
  /* Current release artifact. */

  // An earlier reading of 431218 B raw and 113144 B gzip set the ceilings
  // below — history, phrased so the parser reads the current pair.
  //
  // An earlier reading of 433,600 B raw and 113,700 B gzip followed the
  // resizable terminal column — history, phrased so the parser reads the
  // current pair below.
  //
  // Re-measured after the mount fence. A terminal mount is a copy in both
  // directions: `mountTerminalWorkspace` reads every listed file into the
  // WebContainer, and `syncTerminalWorkspace` writes the result back through
  // `workspace.write`, which is outside the approval broker entirely. That is
  // an acceptable trade for a browser-managed store and not for a directory on
  // someone's disk, so the attached folder is neither mounted nor written, a
  // tab cannot be opened inside it, and each refusal says where to do the work
  // instead. The canonical config-free artifact measures 433,704 B raw /
  // 114,070 B gzip; the reviewed Docker-defaults variant measures 433,704 B raw
  // / 114,070 B gzip; the reviewed Pages variant measures 433,704 B raw /
  // 114,072 B gzip; and the reviewed Google-Drive-configured variant measures
  // 433,704 B raw / 114,073 B gzip and sets the gzip maximum. 424 KiB raw would have
  // left 472 B, below the tripwire floor, so raw keeps 425 KiB and leaves
  // 1,496 B; 112 KiB gzip is the smallest clearing step and leaves 615 B.
  // Still fetched only when Terminal opens.
  //
  // Re-measured after a file stopped being authority: bundle pins refused, folder writes always reviewed, Terminal fenced, attachment scoped to its Profile.
  // The canonical config-free artifact measures 433,704 B raw / 114,071 B gzip;
  // the reviewed Docker-defaults variant measures 433,704 B raw / 114,071 B gzip;
  // the reviewed Pages variant measures 433,704 B raw / 114,073 B gzip;
  // and the reviewed Google-Drive-configured variant measures 433,704 B raw /
  // 114,076 B gzip. 424 KiB raw would have left 472 B and 112 KiB gzip would
  // have left 612 B; the 425/113 KiB steps leave 1,496 / 1,636 B.
  //
  // Re-measured after the mount refusal learned to name a true path. The
  // sentence is the only change; the vendor runtime is byte-identical.
  // The canonical config-free artifact measures 433,735 B raw / 114,087 B gzip;
  // the reviewed Docker-defaults variant measures 433,735 B raw / 114,089 B gzip;
  // the reviewed Pages variant measures 433,735 B raw / 114,088 B gzip;
  // and the reviewed Google-Drive-configured variant measures 433,735 B raw /
  // 114,091 B gzip and sets the gzip maximum. 424 KiB raw would have left 441 B
  // and 112 KiB gzip would have left 597 B; the 425/113 KiB steps leave
  // 1,465 / 1,621 B. Still fetched only when Terminal opens.
  optionalTerminal: Object.freeze({ raw: 425 * 1024, gzip: 113 * 1024 }),
  // Protocol host only. The reviewed Transformers/ORT/model artifacts remain
  // a separately mounted same-origin semantic pack and are never preloaded.
  optionalSemanticWorker: Object.freeze({ raw: 16 * 1024, gzip: 6 * 1024 }),
  // Multi-provider connection UI, page-lifetime provider fabric, credential-
  // free route contracts, and cloud transport adapters load with the
  // Connection route/runtime bootstrap. They are deliberately absent from the
  // HTML preload graph.
  // Raised once for genuinely new capability rather than growth in an existing
  // one: three provider OAuth grant shapes (paste-code PKCE, RFC 8628 device
  // code, refresh) plus the extension-bridge transport client. Weighed
  // 116.14 KiB raw / 34.62 KiB gzip; these are the next whole steps above it.
  // The gzip step moved again for a split, not for new code: the bridge client
  // is now shared between the provider transports and the Connect surface's
  // presence observation, so it compresses as its own 10.65 KiB chunk instead
  // of inside the session route. Raw is unchanged at a measured 116.74 KiB;
  // only the lost cross-chunk compression is new, at 35.59 KiB gzip.
  // Includes the shared page-side companion protocol client used by both the
  // live Providers observation and the opt-in ciphertext cache backend.
  //
  // Exact conversation return classified every held provider route as the
  // pinned generation, a replacement, or unrelated; locked the pinned model;
  // and kept abandon unavailable once verification reached its commit point.
  // The provider-neutral custom endpoint path added the transactional descriptor,
  // credential, and catalog setup used by the direct-browser connection form.
  // The generic OpenAI-compatible wire implementation replaced the old Chutes
  // duplicate, and its single-use descriptor factory folded into the fabric, so
  // that earlier complete family emitted eight packs. It weighed 182,759 B raw /
  // 54,849 B gzip after transactional accessor snapshots, cryptographic custom
  // authority, neutral provider failures, and the accessible custom-endpoint form
  // landed. Its tight 180/55 KiB steps left 1,561 / 1,471 B.
  // Descriptor-driven transports replaced the provider-ID switch: the Responses
  // and Messages wires now read their origin, catalog endpoint and transport
  // identity from the descriptor they are given, which serves every provider
  // that declares those wires instead of three hard-coded names.
  //
  // The dead browser-local descriptor pair also left this pack: nothing imported
  // OFFICIAL_LOCAL_PROVIDERS, and it had already drifted from the endpoints the
  // live loopback descriptor builds.
  //
  // The canonical config-free artifact emits five classified packs and weighed
  // 143,290 B raw / 41,653 B gzip. The reviewed Docker-defaults variant weighed
  // 143,290 B raw / 41,657 B gzip, the reviewed Pages variant weighed
  // 143,290 B raw / 41,656 B gzip, and the reviewed Google-Drive-configured
  // variant weighed 143,290 B raw / 41,654 B gzip. 140 KiB raw would have left
  // 70 B and 41 KiB gzip would have left 327 B, both below the tripwire floor.
  //
  // Re-measured after the engine nobody runs was deleted and an unanswered approval stopped being recorded as a person's refusal. Deleting 8,393 lines of an unreachable second agent engine changed no shipped byte, so the savings below are the shared-helper consolidation that came with it; the entry cost is the withdrawal word itself, which is on the eager path because the shell is what withdraws.
  // The canonical config-free artifact measures 143,060 B raw / 41,642 B gzip;
  // the reviewed Docker-defaults variant measures 143,060 B raw / 41,643 B gzip;
  // the reviewed Pages variant measures 143,060 B raw / 41,643 B gzip;
  // and the reviewed Google-Drive-configured variant measures 143,060 B raw /
  // 140 KiB raw would have left 300 B, below the tripwire floor, so raw keeps the 141 KiB step and leaves 1,324 B; 41 KiB gzip would have left 341 B, below the tripwire floor, so gzip keeps the 42 KiB step and leaves 1,365 B.
  optionalInferenceProviders: Object.freeze({ raw: 141 * 1024, gzip: 42 * 1024 }),
  // The prime runtime port measured at 88,098 B raw / 26,594 B gzip — the
  // claim states the floor across both build modes, with the origin-inlined
  // Docker variant one raw byte and twenty-nine gzip bytes under the
  // config-free artifact. Deferred by construction: the ported agent runtime
  // and its transport/transform/cost stream are reachable only behind a
  // capability request, so the shell's first paint stays where the 768/160
  // KiB ceilings already fence it.
    // Re-measured at 100,317 B raw / 30,230 B gzip: the W1-W6 acceptance wave
  // completed the port — batched read path, boundary tests, docs-as-contract.
  // The prime runtime is lazily fetched only behind a capability request, so
  // first paint stays fenced behind 768/160 raw/gzip as it always has; both
  // ceilings take the tightest whole-KiB step above reading while keeping the
  // 768 KiB raw free floor out.
  // Re-measured at 101,875 B raw / 30,789 B gzip after the surface-repair
  // sweep. The named cause is the prime lane telling the truth about itself:
  // the engine tag no longer greets a fresh conversation as prime while the
  // gate routes it to airship-core, the kernel bridge binds the name every
  // prompt and tool description already spells, a turn no longer mints and
  // abandons a session authority (which was leaking the kernel worker and
  // resetting the namespace it calls persistent), provider receipts bind to
  // the turn that produced them instead of a random id, and the in-turn budget
  // ledger keeps the calibrated bytes-per-token the compression gate just
  // computed. All of it stays behind the capability request; first paint is
  // untouched. 100 KiB raw would have left 525 bytes, below the 768-byte
  // tripwire, so raw takes 101 KiB and keeps 1,549; gzip takes its tightest
  // step to 31 KiB, leaving 955.
  //
  // Re-measured at 162,800 B raw / 48,300 B gzip after prime's tool surface
  // was wired into it, and this is the raise that carries the feature: the
  // chunk now holds `src/prime/tools` — read/list/search/write/edit over the
  // workspace port, the harness CRUD tool, the RLM family, and the
  // `execute_code` tool that reaches the persistent kernel — plus the
  // IndexedDB continual-harness store. All of it was dead code the bundler
  // had never seen, which is why the number moves this far in one step. It is
  // still entirely behind the capability request: this pack loads when a prime
  // turn runs and never on first paint, which is what the baseline budget
  // above measures separately.
  // 160 KiB raw would have left 640 B and 48 KiB gzip 843 B; raw is under the
  // 768-byte tripwire so it takes one further whole step to 161 (2,064 B), while
  // gzip takes its tightest clearing step to 48.
  //
  // Re-measured after the subagent factory landed: 192,100 B raw / 57,400 B gzip. `rlm_spawn`,
  // `subagent`, `agent_message`, `agent_observe` and `rlm_heartbeat` stopped
  // being named absences — the production `PrimeAgentRuntimeFactory`, the
  // registry that owns it, the synchronous heartbeat store and the refine
  // completion client are all in the graph now, and a child agent is a real
  // journaled session with its own manifest and kernel. Still behind the
  // capability request; first paint is untouched. Figures are floors a little
  // under the build, for the reason the backstop below spells out.
  //
  // Re-measured at 195,100 B raw / 58,400 B gzip once the kernel learned the
  // RLM call surface — rlm(), subagent(), agent_message.send(), observe,
  // harness and heartbeat bound into the worker namespace beside pat, which
  // is the spelling prime-agent's model actually writes.
  // 191 KiB raw would have left 484 B, under the 768-byte floor, so raw takes
  // one further whole step to 192 (1,508 B); gzip takes its smallest clearing
  // step to 58, which leaves 992 B and is already above it.
  //
  // Re-measured at 209,600 B raw / 63,700 B gzip once the tool surface became
  // its own member of this family — the session-creation path pins its
  // definitions into a new manifest, so it is a second importer and a chunk of
  // its own. 205 KiB raw would have left 720 B, under the 768-byte floor, so
  // raw takes one further whole step to 206 (1,744 B); gzip takes its smallest
  // clearing step to 63, which leaves 812 B and is already above it. The gzip
  // step moved once more when every port became deferred rather than optional:
  // the surface always registers the whole vocabulary now, because the digest
  // binds names and names may not depend on which ports were constructible.
  //
  // Re-measured at 208.23 KiB raw / 62.80 KiB gzip once this pack began
  // composing the layered system prompt for root turns and not only for
  // children: the composer, its harness merge and the registry-derived tool
  // inventory now load with the runtime rather than with the subagent factory
  // alone. 209 KiB raw is the smallest clearing step and leaves 788 B, above
  // the floor; 63 KiB gzip would have left 204 B, under it, so gzip takes one
  // further whole step to 64 (1,228 B).
  // Re-measured at 224,259 B raw / 67,487 B gzip after the authenticated
  // JavaScript-kernel controller and strict frame parser joined the deferred
  // runtime. 219 KiB raw is three bytes too small; 66 KiB gzip would have left
  // only 97 B. 220/67 KiB leave 1,021 / 1,121 B.
  //
  // Re-measured at 227,956 B raw / 69,171 B gzip after the interpreter moved to
  // one independently cached, manifest-pinned worker artifact. The worker now
  // carries its exact no-egress CSP and is still charged to this capability's
  // total rather than hidden in a separate budget. 223 KiB raw leaves only
  // 396 B and 68 KiB gzip leaves 461 B, both below the 768-byte tripwire.
  // Re-measured at 240,348 B raw / 72,441 B gzip after legacy execution was
  // moved onto the strict worker, controller primordials were captured, and
  // completion began draining admitted bridge effects. 235 KiB raw would have
  // left 292 B and 71 KiB gzip would have left 263 B; the tight
  // 236/72 KiB steps leave 1,316 / 1,287 B. First
  // paint remains unchanged.
  optionalPrimePack: Object.freeze({ raw: 236 * 1024, gzip: 72 * 1024 }),
  // Live companion observation shared by per-turn environment awareness and
  // deferred provider surfaces. Measured 3,179 B raw / 1,204 B gzip.
  optionalExtensionObservation: Object.freeze({ raw: 3 * 1024 + 512, gzip: 1 * 1024 + 512 }),
  // Local Device setup and its OPFS/IndexedDB key-custody runtime load only
  // after the user selects that Vault provider.
  //
  // An earlier reading of 61,735 B raw and 18,163 B gzip is history. The
  // loopback lab's own 2,067-byte chunk was charged to this class and is gone
  // from a stock build; `vault/recovery.ts` lost the lab as its second lazy
  // importer and folded into the keyring pack, which is why the pack count
  // fell from four to two and the class still shrank.
  //
  // Measured 59,284 B raw / 16,707 B gzip: raw is identical in all four
  // reviewed variants and gzip moves by one byte between them. 58 KiB raw would
  // have left 108 B and 17 KiB gzip would have left 701 B, both below the
  // tripwire floor, so the 59/18 KiB steps leave 1,132 / 1,725 B.
  // All of it is fetched after the person picks Local Device,
  // never at first paint.
  optionalLocalDeviceVault: Object.freeze({ raw: 59 * 1024, gzip: 18 * 1024 }),
  optionalPythonPack: Object.freeze({ raw: 16 * 1024 * 1024, gzip: 8 * 1024 * 1024 }),
  // First-paint CSS blocks render. After obsolete feature rules, selector
  // branches, and duplicates were removed from the shipped cascade, it weighed
  // 146,266 B raw / 25,116 B gzip in all four reviewed variants.
  //
  // The loopback lab's own stylesheet was never in this class — it travels with
  // the lazily fetched setup panel — and a previous analysis that charged
  // 1,088 B of `.local-lab` rules to this budget was wrong. What was here is the
  // two lab selectors inside the shared `.eyebrow` recipe, 38 raw and 11 gzip
  // bytes, now taken by class from the panel instead. That is real and it is
  // small: neither ceiling can move, because 142 KiB raw is 858 B below the
  // artifact and 25 KiB gzip is 484 B below the tripwire floor. 143/26 KiB
  // leave 166 / 1,508 B.
  //
  // Re-measured after the product-shell repair landed on top of it. The folder tier stopped being a disclosure, so its promises are on screen instead of in textContent; its own pack got smaller, because two `<details>`, two summaries and an unrendered live ref weigh more than a deciding state and a bounded terms band. That pays for an audit comparison that no longer accuses an empty conversation of drift, a first-run link that lands where its sentence says, and coarse-pointer sizes a phone can actually hit.
  // The canonical config-free artifact measures 146,425 B raw / 25,154 B gzip;
  // the reviewed Docker-defaults variant measures 146,425 B raw / 25,154 B gzip;
  // the reviewed Pages variant measures 146,425 B raw / 25,154 B gzip;
  // and the reviewed Google-Drive-configured variant measures 146,425 B raw /
  // 25,154 B gzip. 143 KiB raw would have left 7 B and 25 KiB gzip would
  // have left 446 B; the 144/26 KiB steps leave 1,031 / 1,470 B.
  entryCss: Object.freeze({ raw: 144 * 1024, gzip: 26 * 1024 }),
  eachWasm: Object.freeze({ raw: 1024 * 1024, gzip: 350 * 1024 }),
  allWasm: Object.freeze({ raw: 1024 * 1024, gzip: 350 * 1024 }),
});

/*
 * Credential shapes this product actually handles.
 *
 * The list below used to cover Chutes, AWS access key IDs, GitHub, npm, Slack,
 * Stripe and JWTs — and none of the bring-your-own-provider keys the workbench
 * is built around. Four realistic provider keys appended to a shipped entry
 * chunk passed this gate, while `docs/RELEASE_GATE.md` promised it blocks
 * "credential-shaped payloads". Nothing inlines a provider key today; this is
 * the control a maintainer will trust on the day something does.
 *
 * Every shape is anchored on a literal the vendor issues, never on a bare
 * `sk-` prefix: OpenAI keys carry `T3BlbkFJ` ("OpenAI" in base64) in both the
 * classic and project forms. All of them were checked for false positives
 * across every artifact of a full build.
 *
 * What this cannot do is stated plainly rather than implied: a vendor whose key
 * is bare base64 or bare hex with no issued prefix and no fixed length — Together
 * and Mistral among them — has no shape to anchor on, and a pattern loose enough
 * to catch one would flag hashes, digests and asset names throughout the build.
 * Those keys are caught by the rule that no credential belongs in a build input,
 * not by this scanner. A vendor that does issue a prefix belongs above, and two
 * that this comment once excused — DeepSeek and Cerebras — are there now.
 */
const secretPatterns = Object.freeze([
  ["Chutes API key", /\bcpk_[A-Za-z0-9_-]{16,}\b/u],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}\b/u],
  ["Anthropic API key", /\bsk-ant-(?:api|admin)\d\d-[A-Za-z0-9_-]{32,}\b/u],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/u],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/u],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/u],
  ["AWS secret access key", /\baws_secret_access_key\b\s*[=:]\s*["']?[A-Za-z0-9/+]{40}\b/iu],
  ["xAI API key", /\bxai-[A-Za-z0-9]{40,}\b/u],
  ["Anthropic OAuth credential", /\bsk-ant-(?:oat|sid)\d\d-[A-Za-z0-9_-]{32,}\b/u],
  ["OpenRouter API key", /\bsk-or-v1-[A-Za-z0-9]{32,}\b/u],
  ["Groq API key", /\bgsk_[A-Za-z0-9]{40,}\b/u],
  ["Fireworks API key", /\bfw_[A-Za-z0-9]{24,}\b/u],
  ["Perplexity API key", /\bpplx-[A-Za-z0-9]{32,}\b/u],
  ["NVIDIA API key", /\bnvapi-[A-Za-z0-9_-]{32,}\b/u],
  ["GitLab token", /\b(?:glpat|gldt|glcbt|glrt|glsoat)-[A-Za-z0-9_-]{20,}\b/u],
  ["DeepSeek API key", /\bsk-[0-9a-f]{32}\b/u],
  ["Cerebras API key", /\bcsk-[A-Za-z0-9]{32,}\b/u],
  ["Replicate API token", /\br8_[A-Za-z0-9]{32,}\b/u],
  ["Slack app-level token", /\bxapp-\d-[A-Za-z0-9-]{20,}\b/u],
  ["Anyscale secret", /\besecret_[A-Za-z0-9]{20,}\b/u],
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

const EXTENSION_RELEASE_PREFIX = "extension/releases/";
const extensionArchivePaths = new Set(
  EXTENSION_RELEASE_ARCHIVES.map(({ file }) => `${EXTENSION_RELEASE_PREFIX}${file}`),
);

export function assertExactExtensionReleaseInventory(paths) {
  const actual = paths
    .filter((path) => path.startsWith(EXTENSION_RELEASE_PREFIX))
    .map((path) => path.slice(EXTENSION_RELEASE_PREFIX.length));
  assertExactInventory("Companion release directory", actual, EXTENSION_RELEASE_FILES);
}

export function inspectExtensionArchive(path, payload) {
  const findings = [];
  for (const member of readExtensionArchive(path, payload)) {
    for (const finding of inspectPayload(`${path}!/${member.path}`, member.payload)) {
      findings.push(`${member.path}: ${finding}`);
    }
  }
  return Object.freeze(findings);
}


export function assertExtensionReleaseMetadata(fileMap) {
  const metadataFile = fileMap.get(`${EXTENSION_RELEASE_PREFIX}release.json`);
  const sumsFile = fileMap.get(`${EXTENSION_RELEASE_PREFIX}SHA256SUMS`);
  const installHub = fileMap.get("extension/index.html");
  if (!metadataFile || !sumsFile || !installHub) {
    throw new Error("Companion release metadata, checksums and install hub must all exist.");
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataFile.payload.toString("utf8"));
  } catch {
    throw new Error("Companion release metadata is not valid JSON.");
  }
  if (metadata?.schema !== "airship-companion-release:1"
    || typeof metadata.version !== "string"
    || metadata.version.length === 0
    || !Array.isArray(metadata.artifacts)
    || metadata.artifacts.length !== EXTENSION_RELEASE_ARCHIVES.length) {
    throw new Error("Companion release metadata has an unexpected schema, version or artifact count.");
  }

  const checksumLines = [];
  for (const [index, expected] of EXTENSION_RELEASE_ARCHIVES.entries()) {
    const artifact = metadata.artifacts[index];
    if (artifact?.target !== expected.target
      || artifact?.channel !== expected.channel
      || artifact?.file !== expected.file) {
      throw new Error(`Companion release metadata artifact ${index} does not match ${expected.file}.`);
    }
    const archivePath = `${EXTENSION_RELEASE_PREFIX}${expected.file}`;
    const archive = fileMap.get(archivePath);
    if (!archive) throw new Error(`Companion archive is missing: ${archivePath}.`);
    const digest = createHash("sha256").update(archive.payload).digest("hex");
    if (artifact.bytes !== archive.payload.byteLength || artifact.sha256 !== digest) {
      throw new Error(`Companion release metadata does not bind the bytes of ${expected.file}.`);
    }
    checksumLines.push(`${digest}  ${expected.file}`);

    let manifest;
    try {
      const member = readExtensionArchive(archivePath, archive.payload)
        .find(({ path }) => path === "manifest.json");
      manifest = JSON.parse(member.payload.toString("utf8"));
    } catch {
      throw new Error(`Companion manifest is invalid in ${expected.file}.`);
    }
    if (manifest.version !== metadata.version) {
      throw new Error(`Companion manifest version disagrees with release.json in ${expected.file}.`);
    }
  }
  if (sumsFile.payload.toString("utf8") !== `${checksumLines.join("\n")}\n`) {
    throw new Error("Companion SHA256SUMS does not exactly match the six release archives.");
  }
  if (!installHub.payload.toString("utf8").includes(`Airship Companion · ${metadata.version}`)) {
    throw new Error("Companion install hub version disagrees with release.json.");
  }
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
  "entryJavaScript",
  "allJavaScriptAndWorkers",
  "deferredCapabilities",
  "firstPartyJavaScriptAndWorkers",
  "optionalVendorRuntimeAggregate",
  "totalJavaScriptAndWorkers",
  "optionalExecutionTools",
  "optionalInferenceProviders",
  "optionalWorkspaceWorkbench",
  "optionalLocalFolder",
  "optionalCapabilitiesView",
  "optionalMemoryView",
  "optionalSkillsManagerView",
  "optionalSkillEditor",
  "optionalTerminal",
  // Self-contained: two first-party modules and no build-time configuration in
  // either, so its reading is the same in every reviewed variant and there is
  // no reason for its ceiling to be justified by anything looser.
  "optionalWorkBundle",
]);

/*
 * These raw ceilings are deliberate absolute parse/memory backstops. Their
 * gzip roles still follow the ordinary tight whole-KiB rule, and both roles
 * must still record and match a measurement from the build under review.
 */
const MEASUREMENT_TIGHTNESS_EXEMPT_ROLES = Object.freeze({
  entryJavaScript: Object.freeze(["raw"]),
  allJavaScriptAndWorkers: Object.freeze(["raw"]),
});

const RELEASE_BUDGET_ROLES = Object.freeze(["raw", "gzip"]);
/**
 * How far a supported build may sit from the readings its comment records.
 *
 * Measured spread across the four reviewed variants of this commit — config
 * free, Docker defaults, Pages, and Google-Drive-configured — is 565 B on the
 * largest aggregate and 0 B on a hashed optional pack. The allowance is the
 * tripwire floor this file already uses for margins, which covers that spread
 * with room for a minifier rename and nothing like a whole KiB.
 */
const DOCUMENTED_VARIANT_ALLOWANCE = 768;
const TRIPWIRE_MARGIN_CLAIM =
  /(\d[\d,]*(?:\.\d+)?)\s(KiB|MiB|B)\s(raw|gzip)\swould have left\s(\d[\d,]*)\s(?:B|bytes)\b/gu;

/** Select each role's largest claim without losing that claim's written precision. */
function maximumDocumentedFigures(measured) {
  return Object.fromEntries(RELEASE_BUDGET_ROLES.map((role) => {
    const maximum = measured.reduce((largest, pair) => {
      const candidate = { bytes: pair[role], written: pair.written[role] };
      if (!largest || candidate.bytes > largest.bytes) return candidate;
      // Equal byte claims keep the finer promise; choosing the coarser spelling
      // would silently widen the lower-bucket tolerance.
      if (candidate.bytes === largest.bytes && writtenTolerance(candidate.written) < writtenTolerance(largest.written)) {
        return candidate;
      }
      return largest;
    }, null);
    return [role, maximum];
  }));
}

function parseTripwireMarginClaims(prose) {
  return [...prose.matchAll(TRIPWIRE_MARGIN_CLAIM)].map((match) => ({
    ceiling: toBytes(match[1], match[2]),
    role: match[3],
    remaining: Number(match[4].replaceAll(",", "")),
  }));
}

function writtenTolerance(written) {
  // Half of the last digit the author actually wrote.
  return (0.5 * unitScale(written.unit)) / 10 ** written.decimals;
}

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
 * names that exact step and the bytes it would leave against the role's maximum —
 * the sentence this file already writes when it declines a ceiling a minifier
 * rename could breach. The three ceilings raised against stale comments each
 * granted 10–18% of new transfer
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
    // Raw and gzip maxima can come from different supported build variants.
    // Keep each winning figure whole so its written precision remains attached.
    const documented = maximumDocumentedFigures(entry.measured);
    if (RELEASE_BUDGET_ROLES.some((role) => !documented[role])) {
      failures.push(`${entry.name}: its comment no longer records a measured raw/gzip pair for the ceiling it sets`);
      continue;
    }
    const tripwireClaims = parseTripwireMarginClaims(entry.prose);
    for (const role of RELEASE_BUDGET_ROLES) {
      if (MEASUREMENT_TIGHTNESS_EXEMPT_ROLES[entry.name]?.includes(role)) continue;
      const ceiling = entry.budget[role];
      const figure = documented[role];
      const firstStep = (Math.floor(figure.bytes / 1024) + 1) * 1024;
      const expectedRemaining = firstStep - figure.bytes;
      const hasMatchingTripwire = tripwireClaims.some((claim) =>
        claim.role === role
        && claim.ceiling === firstStep
        && Math.abs(claim.remaining - expectedRemaining) <= writtenTolerance(figure.written));
      const allowed = firstStep + (hasMatchingTripwire ? 1024 : 0);
      if (ceiling > allowed) {
        failures.push(
          `${entry.name}: the ${formatBytes(ceiling)} ${role} ceiling is above the smallest whole-KiB step that clears the documented ${formatBytes(figure.bytes)}; take the tighter step, or record the matching tripwire arithmetic "${firstStep / 1024} KiB ${role} would have left ${expectedRemaining} B"`,
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
 * A documented measurement may not claim a larger whole-KiB budget bucket than
 * the artifact this run measures.
 *
 * Everything above compares a comment to a *ceiling*, and a ceiling is the one
 * thing a stale-high figure keeps satisfying. A reading in a higher whole-KiB
 * bucket can therefore buy an additional KiB of transfer budget for bytes no
 * build shipped. `optionalWorkspaceWorkbench` once did exactly that, and a
 * comment-to-ceiling check could not catch it because it never saw the build.
 *
 * Exact output is not universal, though. Build-time public configuration changes
 * minified strings and compression by a few bytes, and shared chunks drift even
 * when the capability being measured did not. Those variants are legitimate
 * when both readings remain in the same enforced whole-KiB bucket: the documented
 * reading cannot justify a larger ceiling, and `assertWithinBudget` still blocks
 * the actual artifact. Requiring exact equality here made Docker's supported
 * local deployment fail over nine gzip bytes while granting no tighter budget.
 * The allowance is structurally bounded to less than one KiB; crossing a bucket
 * remains a failure and requires the comment and ceiling to be reviewed again.
 *
 * Raw and gzip are selected independently because supported variants can have
 * crossed maxima. Each selected figure keeps its own written precision, so a
 * comment that spells one role in bytes and the other in hundredths of a KiB is
 * checked against exactly those claims rather than the precision of whichever
 * variant happened to have the largest raw output.
 */
export function assertDocumentedMeasurementsMatchBuild(source, measurements) {
  const failures = [];
  for (const entry of parseDocumentedBudgets(source)) {
    if (!MEASUREMENT_JUSTIFIED_BUDGETS.includes(entry.name)) continue;
    const measured = measurements[entry.name];
    if (!measured) {
      failures.push(`${entry.name}: named as measurement-justified, but this run measured no artifact under that name`);
      continue;
    }
    const documented = maximumDocumentedFigures(entry.measured);
    // Its absence is already a failure in the guard that runs before the build.
    if (RELEASE_BUDGET_ROLES.some((role) => !documented[role])) continue;
    for (const role of RELEASE_BUDGET_ROLES) {
      /*
       * Two questions, and they need different reference points.
       *
       * "Is this comment stale-high?" must be asked of the reading that
       * describes THIS build, because a comment records several reviewed
       * variants and they can straddle a whole-KiB line — the unconfigured
       * Docker build lands 1 B below a line the Pages build sits above, and
       * asking the Pages figure about the Docker build reported a supported
       * deployment as stale and broke `./deploy.sh`. So the nearest recorded
       * reading answers it, with no tolerance: a build a whole bucket below
       * every reading it could plausibly be is a comment nobody re-took.
       *
       * "Does this comment understate the artifact?" must be asked of the
       * LARGEST reading, because that is the one a ceiling is derived from.
       * Four readings here described chunks 78-647 B smaller than the bytes on
       * disk, one leaving 94 B under a ceiling its comment implied was ~700 B
       * away, and nothing failed.
       *
       * Applying one tolerance to both questions was worse than either: it let
       * a comment name a figure just above a KiB line the artifact sits below
       * and buy a full unreviewed KiB, which the previous rule caught.
       */
      const figure = documented[role];
      if (measured[role] - figure.bytes > DOCUMENTED_VARIANT_ALLOWANCE) {
        failures.push(
          `${entry.name}: its comment records at most ${formatBytes(figure.bytes)} ${role}, but this build measures ${formatBytes(measured[role])} (${measured[role]} B). Re-take the reading; a comment that understates the artifact reports headroom the build does not have.`,
        );
        continue;
      }
      const nearest = entry.measured.reduce((closest, pair) => (
        !closest || Math.abs(pair[role] - measured[role]) < Math.abs(closest[role] - measured[role]) ? pair : closest
      ), null);
      const measuredBucket = Math.floor(measured[role] / 1024);
      if (Math.floor(nearest[role] / 1024) > measuredBucket) {
        const written = nearest.written[role];
        failures.push(
          `${entry.name}: its comment claims ${written.text} ${role}, but this build measures only ${formatAsWritten(measured[role], written)} (${measured[role]} B), in a lower whole-KiB budget bucket. Re-take the reading; a ceiling justified by bytes nothing shipped is a raise nobody reviewed.`,
        );
        continue;
      }
      /*
       * And the ceiling itself, against measured bytes rather than a claim.
       * The tightness rule that runs before the build can only compare a
       * ceiling with what the comment SAYS, so an inflated extra reading buys
       * a whole-KiB step no artifact needs. Here the artifact is in hand.
       */
      if (MEASUREMENT_TIGHTNESS_EXEMPT_ROLES[entry.name]?.includes(role)) continue;
      /*
       * A recorded reading that no other recorded reading stands near is not a
       * variant of this build — it is a figure on its own, and the ceiling is
       * derived from the largest one. Reviewed variants cluster inside the
       * allowance; a claim that sits a kilobyte above the cluster is the
       * crossed-maxima inflation this guard was written for.
       */
      if (figure.bytes - nearest[role] > DOCUMENTED_VARIANT_ALLOWANCE) {
        failures.push(
          `${entry.name}: its comment claims ${figure.written.text} ${role}, but no reviewed variant it records comes within ${DOCUMENTED_VARIANT_ALLOWANCE} B of that figure, and this build measures ${formatBytes(measured[role])} (${measured[role]} B). Re-take the reading; a ceiling justified by bytes nothing shipped is a raise nobody reviewed.`,
        );
        continue;
      }
      /*
       * The step is taken over the larger of what this build measures and what
       * the comment records, because a ceiling has to clear the largest
       * reviewed variant and only one of them is in front of this run.
       *
       * The residual is stated rather than hidden: an author who adds an
       * inflated reading BESIDE an honest one, within the allowance above, can
       * still buy one whole-KiB step. Closing that needs the gate to measure
       * every reviewed variant in a single run; until then the understatement
       * check, the nearest-variant bucket check and the recorded-variant list
       * bound how far a comment can drift from the artifact.
       */
      const firstStep = (Math.floor(Math.max(measured[role], figure.bytes) / 1024) + 1) * 1024;
      // The tripwire sentence is checked against the reading it was written
      // for, because the margin it states moves by a few bytes between reviewed
      // variants; the STEP is computed from the artifact in hand, which is what
      // an inflated extra reading was buying.
      const documentedStep = (Math.floor(figure.bytes / 1024) + 1) * 1024;
      const tripwire = parseTripwireMarginClaims(entry.prose).some((claim) =>
        claim.role === role
        && claim.ceiling === documentedStep
        && Math.abs(claim.remaining - (documentedStep - figure.bytes)) <= writtenTolerance(figure.written));
      const allowed = firstStep + (tripwire ? 1024 : 0);
      if (entry.budget[role] > allowed) {
        failures.push(
          `${entry.name}: the ${formatBytes(entry.budget[role])} ${role} ceiling is above the smallest whole-KiB step that clears the ${formatBytes(measured[role])} this build measures; take the tighter step, or record the matching tripwire arithmetic "${firstStep / 1024} KiB ${role} would have left ${firstStep - measured[role]} B"`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Release budget comments no longer describe this build:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * Pairs each `name: Object.freeze({ raw, gzip })` ceiling with the contiguous
 * comment block directly above it and the byte figures that block states. Parsing
 * this file's own comments is unusual; it is warranted because those comments are
 * the ceilings' only justification, and an unchecked justification is the defect
 * this guards against.
 *
 * Both comment syntaxes count. This read `//` lines only, and every other line
 * — including every line of a `/* *\/` block — reset the accumulator, so a
 * ceiling whose justification was written as a block comment arrived at the
 * guard as empty prose. Empty prose states no figure that can contradict a
 * ceiling, states no measurement to be too loose for, and is only *required* to
 * exist for the names in MEASUREMENT_JUSTIFIED_BUDGETS — so eight budgets
 * documented in block form were being waved through a guard that reported
 * itself green. Which of the two forms a comment happens to use is a typographic
 * accident, and it was deciding whether the budget was checked at all.
 */
export function parseDocumentedBudgets(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("export const RELEASE_BUDGETS"));
  if (start < 0) throw new Error("Release budgets are not declared where the documentation guard expects them.");
  const entries = [];
  let comment = [];
  let insideBlockComment = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "});") break;
    if (insideBlockComment) {
      const body = /^\s*\*?\/?\s?(.*?)\s*$/u.exec(line)[1];
      if (/\*\/\s*$/u.test(line)) insideBlockComment = false;
      comment.push(body.replace(/\*\/\s*$/u, "").trim());
      continue;
    }
    const blockOpen = /^\s*\/\*+\s?(.*)$/u.exec(line);
    if (blockOpen) {
      const closes = /\*\/\s*$/u.test(line);
      comment.push(blockOpen[1].replace(/\*\/\s*$/u, "").trim());
      insideBlockComment = !closes;
      continue;
    }
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
/*
 * The sentence a measurement is stated in, from the word that claims it to the
 * end of that sentence. A period between digits is a decimal point, not a full
 * stop — `Measured 6.23 KiB raw / 2.46 KiB gzip` is one sentence.
 *
 * The ceiling rule below is scoped to these spans for the reason MEASURED_PAIR
 * already states: a budget comment may legitimately quote another surface's
 * figure, and several do. `optionalShellOverlays` and `optionalResumeReport`
 * both exist *because* the entry chunk breached 112 KiB gzip, so both name the
 * entry chunk's reading — a number no route-pack ceiling could ever clear.
 * Reading those as claims about the pack would force the story out of the
 * comment, and the story is what a reviewer needs. Nothing is weakened by the
 * narrowing: the pairs a comment states about itself are now compared against
 * the artifact the same run measures, which is a stronger check than any rule
 * about which numbers may appear in prose.
 */
const MEASURED_SENTENCE = /[Mm]easur\w*(?:[^.;]|\.(?=\d))*/gu;

function parseByteFigures(prose) {
  return [...prose.matchAll(MEASURED_SENTENCE)].flatMap((sentence) =>
    [...sentence[0].matchAll(BYTE_FIGURE)].map((match) =>
      Object.freeze({ text: `${match[1]} ${match[2]}`, role: match[3], bytes: toBytes(match[1], match[2]) }),
    ),
  );
}

function parseMeasuredPairs(prose) {
  return [...prose.matchAll(MEASURED_PAIR)].map((match) =>
    Object.freeze({
      raw: toBytes(match[1], match[2]),
      gzip: toBytes(match[3], match[4]),
      /*
       * The precision a figure was written at is part of the claim. "49.48 KiB
       * raw" asserts a hundredth of a KiB, not a byte, and a cross-check that
       * demanded byte equality of it would be enforcing a promise its author
       * never made — and would push every comment towards raw byte counts,
       * which are the harder form to read.
       */
      written: Object.freeze({
        raw: Object.freeze({ text: `${match[1]} ${match[2]}`, unit: match[2], decimals: decimalPlaces(match[1]) }),
        gzip: Object.freeze({ text: `${match[3]} ${match[4]}`, unit: match[4], decimals: decimalPlaces(match[3]) }),
      }),
    }),
  );
}

function decimalPlaces(value) {
  const point = value.indexOf(".");
  return point < 0 ? 0 : value.length - point - 1;
}

/** The scale a figure was written at, so a re-measurement can be offered in the same form. */
function unitScale(unit) {
  return unit === "MiB" ? 1024 * 1024 : unit === "KiB" ? 1024 : 1;
}

/** A measurement rendered in the unit and precision the comment beside it uses. */
function formatAsWritten(bytes, written) {
  const value = bytes / unitScale(written.unit);
  const rendered = written.decimals > 0 ? value.toFixed(written.decimals) : Math.round(value).toLocaleString("en-US");
  return `${rendered} ${written.unit}`;
}

function toBytes(value, unit) {
  const scale = unit === "MiB" ? 1024 * 1024 : unit === "KiB" ? 1024 : 1;
  return Math.round(Number(value.replaceAll(",", "")) * scale);
}

/** Require each named lazy chunk stem exactly once, not only the same count. */
export function assertExactChunkStems(label, paths, expectedStems) {
  const expected = [...expectedStems].sort();
  const observed = paths.map((path) => {
    const stem = expectedStems.find((candidate) => {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`^assets/${escaped}-[A-Za-z0-9_-]+\\.js$`, "u").test(path);
    });
    return stem ?? `<unmatched:${path}>`;
  }).sort();
  if (new Set(expected).size !== expected.length || observed.join("\n") !== expected.join("\n")) {
    throw new Error(
      `${label} chunks do not match the required stems (${expected.join(", ")}): ${paths.join(", ")}`,
    );
  }
}

/** Every emitted bundled JavaScript artifact has one, and only one, owner. */
/**
 * Every HTML document this release publishes, exactly.
 *
 * `_headers` covers the app origin on hosts that read it, and the release
 * worker wraps controlled navigations in the reviewed policy — but GitHub Pages
 * reads neither for a page nobody reviewed. Any other document dropped into
 * `public/` (or into `dist/` after the build) therefore ships as same-origin,
 * unreviewed, script-capable HTML inside the worker's scope, and the manifest
 * would list it as a shipped artifact with a checksum, as if it had been
 * reviewed. The rest of the release is inventoried exactly; documents are the
 * one artifact class where a stray file executes.
 */
export const RELEASE_DOCUMENTS = Object.freeze([
  "404.html",
  "extension/index.html",
  "extension/privacy.html",
  "favicon.svg",
  "index.html",
]);

/*
 * Every extension a browser will render as a document on this origin, matched
 * without case. `.html` alone was not the class: `evil.htm`, `EVIL.HTML`,
 * `evil.xhtml` and a `<script>`-carrying `evil.svg` all shipped past a suffix
 * test, and each of them runs script on the app origin inside the release
 * worker's scope on a host that serves no headers.
 */
const RELEASE_DOCUMENT_EXTENSIONS = /\.(?:x?html?|xht|shtml?|svgz?|mht(?:ml)?|xslt?|xml|hta)\.?$/iu;

export function assertExactDocumentInventory(paths) {
  const documents = paths.filter((path) => RELEASE_DOCUMENT_EXTENSIONS.test(path)).sort();
  const unexpected = documents.filter((path) => !RELEASE_DOCUMENTS.includes(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Release contains unreviewed documents: ${unexpected.join(", ")}. `
      + `Only ${RELEASE_DOCUMENTS.join(", ")} may ship.`,
    );
  }
}

/**
 * `404.html` is on the allowlist because Pages and Docker create it from the
 * index after the build. Being on a list is not a review: only a byte copy of
 * the reviewed index carries the reviewed policy, so anything else that arrives
 * under that name is an unreviewed document with a permitted name.
 */
export function assertFallbackDocumentIsIndex(fileMap) {
  const fallback = fileMap.get("404.html");
  if (!fallback) return;
  const index = fileMap.get("index.html");
  if (!index || !fallback.payload.equals(index.payload)) {
    throw new Error("404.html must be a byte copy of the reviewed index.html.");
  }
}

export function assertRequiredFilesAreMeasured(label, requiredFiles, measuredFiles) {
  const measuredPaths = new Set(measuredFiles.map((file) => file.path));
  const escapedPaths = requiredFiles
    .map((file) => file.path)
    .filter((path) => !measuredPaths.has(path));
  if (escapedPaths.length > 0) {
    throw new Error(`${label} escaped its release measurement: ${escapedPaths.join(", ")}.`);
  }
}

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

/*
 * Every literal that only the host-composed loopback storage lab can produce.
 *
 * `VITE_AIRSHIP_ENABLE_LOCAL_LAB` has gated the lab's *reachability* for some
 * time, and the lab was shipped anyway: a stock artifact carried the S3 object
 * store with its AWS request signing, the lab's configure request, the setup
 * panel's stylesheet, the Cognito diagnostic and the selector copy that names
 * the destination. A build flag that only decides what a person may click is
 * not a build flag; this is the check that makes it one.
 *
 * Each sentinel is a string the lab alone emits, taken from the module that
 * emits it, and each was verified to be absent from a stock build and present
 * in a lab build. `airship:local-lab-is-not-in-this-build` is the specifier the
 * stock build externalizes the lab's modules to: it can only appear if a lab
 * import escaped its `LOCAL_LAB_BUILD` branch, which would ship an import that
 * resolves to nothing.
 */
export const LOCAL_LAB_RELEASE_SENTINELS = Object.freeze([
  ["lab module specifier", "airship:local-lab-is-not-in-this-build"],
  ["lab chunk", /(?:^|\/)local-lab(?:-setup|-vault)?-[A-Za-z0-9_-]+\.(?:js|css)$/u],
  ["baked lab credentials", "airship-vault-probe-only-2026"],
  ["lab namespace parameter", "airshipLabNamespace"],
  ["S3 request signing", "AWS4-HMAC-SHA256"],
  ["S3 configuration grammar", "Local-development vaults require a loopback S3 endpoint."],
  ["Cognito credential diagnostic", "CognitoIdentityError"],
  ["lab storage destination", "Local MinIO lab"],
  ["lab provider profile", "Loopback development lab"],
  ["lab setup panel", "local-lab__boundary"],
]);

/**
 * A stock release carries none of the loopback lab.
 *
 * The path is checked as well as the payload because an orphan chunk is the
 * failure that started this: folding the branch that *calls* a dynamic import
 * still left the bundler emitting its target, four files and 21 KiB of them,
 * referenced by nothing and shipped anyway.
 */
export function assertStockReleaseExcludesLocalLab(files) {
  const findings = [];
  for (const file of files) {
    if (isOptionalSemanticPackPath(file.path) || isOptionalPythonPackPath(file.path)) continue;
    for (const [label, sentinel] of LOCAL_LAB_RELEASE_SENTINELS) {
      const matched = typeof sentinel === "string"
        ? file.path.includes(sentinel) || file.payload.includes(sentinel)
        : sentinel.test(file.path);
      if (matched) findings.push(`${file.path}: ${label}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(
      "A stock release must not contain the host-composed loopback storage lab. "
      + `Build without VITE_AIRSHIP_ENABLE_LOCAL_LAB=1, or review these artifacts:\n- ${findings.join("\n- ")}`,
    );
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

/*
 * `docs/RELEASE_GATE.md`'s budget table, row by row, in the order each row
 * names its classes.
 *
 * That document says of the table that it mirrors "the executable ceilings
 * exported by `scripts/release-gate.mjs`" and that a reviewer "must update this
 * inventory in the same change when a ceiling moves". Nothing checked it, and
 * six rows had stopped being true: entry JS gzip read 110 KiB against 113, the
 * installed backstop 2,152 / 643 against 2,746 / 846, the deferred capability
 * pack 388 / 113 against 424 / 126. Two more described gates this file does not
 * contain at all — a 224 KiB compressed-startup ceiling and a 640 / 132 KiB
 * initial-load class, both of which a reader would reasonably argue a raise
 * against. A stale ceiling in the one document a reviewer consults is worse than
 * no document, because it is consulted.
 *
 * Matched by label and compared by value rather than by string: a cell may
 * write 1.5 MiB or 1,536 KiB and that is the author's choice. A row may cover
 * several ceilings in the order it names them, and a row carrying one figure
 * for several of them requires those ceilings to be equal — the only case where
 * one number can honestly stand for more than one.
 */
export const DOCUMENTED_BUDGET_ROWS = Object.freeze([
  Object.freeze({ label: "HTML-referenced entry JavaScript", budgets: Object.freeze(["entryJavaScript"]) }),
  Object.freeze({ label: "Baseline JavaScript/workers including pre-render chunks, optional packs excluded", budgets: Object.freeze(["allJavaScriptAndWorkers"]) }),
  Object.freeze({ label: "Deferred advanced capability bundle", budgets: Object.freeze(["deferredCapabilities"]) }),
  Object.freeze({ label: "First-party and other non-vendor JS/workers", budgets: Object.freeze(["firstPartyJavaScriptAndWorkers"]) }),
  Object.freeze({ label: "Browser Git + Terminal vendor runtime aggregate", budgets: Object.freeze(["optionalVendorRuntimeAggregate"]) }),
  Object.freeze({ label: "Absolute installed JavaScript/worker backstop", budgets: Object.freeze(["totalJavaScriptAndWorkers"]) }),
  Object.freeze({ label: "Service worker", budgets: Object.freeze(["serviceWorker"]) }),
  Object.freeze({
    label: "Optional execution broker / engine / support / tools",
    budgets: Object.freeze(["optionalExecutionPack", "optionalExecutionEngine", "optionalExecutionSupport", "optionalExecutionTools"]),
  }),
  Object.freeze({ label: "Optional pinned WASI Preview 1 Worker", budgets: Object.freeze(["optionalWasiPreview1Worker"]) }),
  Object.freeze({ label: "Optional Node/WebContainer pack", budgets: Object.freeze(["optionalNodeExecutionPack"]) }),
  Object.freeze({ label: "Optional first-party `airship-sh` shell pack", budgets: Object.freeze(["optionalShellPack"]) }),
  Object.freeze({
    label: "Optional agent runtime / tool bundle",
    budgets: Object.freeze(["optionalAgentRuntime", "optionalAgentTools"]),
  }),
  Object.freeze({
    label: "Optional Workspace / Source Control / browser Git",
    budgets: Object.freeze(["optionalWorkspaceWorkbench", "optionalSourceControl", "optionalBrowserGit"]),
  }),
  Object.freeze({ label: "Optional folder on this device", budgets: Object.freeze(["optionalLocalFolder"]) }),
  Object.freeze({
    label: "Optional Sessions / Memory / Memory support",
    budgets: Object.freeze(["optionalSessionLibrary", "optionalMemoryView", "optionalMemorySupport"]),
  }),
  Object.freeze({ label: "Optional move-work bundle pack", budgets: Object.freeze(["optionalWorkBundle"]) }),
  Object.freeze({
    label: "Optional Skills route / skill editor",
    budgets: Object.freeze(["optionalSkillsManagerView", "optionalSkillEditor"]),
  }),
  Object.freeze({ label: "Optional Terminal", budgets: Object.freeze(["optionalTerminal"]) }),
  Object.freeze({ label: "Optional semantic worker", budgets: Object.freeze(["optionalSemanticWorker"]) }),
  Object.freeze({ label: "Optional inference/provider + Companion protocol packs", budgets: Object.freeze(["optionalInferenceProviders"]) }),
  Object.freeze({ label: "Optional prime runtime pack", budgets: Object.freeze(["optionalPrimePack"]) }),
  Object.freeze({ label: "Pinned same-origin Pyodide distribution", budgets: Object.freeze(["optionalPythonPack"]) }),
  Object.freeze({ label: "HTML-referenced entry CSS", budgets: Object.freeze(["entryCss"]) }),
  Object.freeze({
    label: "General WASM excluding separately capped engine WASM",
    budgets: Object.freeze(["eachWasm", "allWasm"]),
  }),
]);

/** The figures in one table cell, as bytes. A trailing unit governs a cell that writes it once. */
function parseCeilingCell(cell) {
  const scaleOf = (text) => (/MiB/u.test(text) ? 1024 * 1024 : 1024);
  const cellScale = scaleOf(cell);
  return cell
    .split("/")
    .map((part) => {
      const figure = /(\d[\d,]*(?:\.\d+)?)/u.exec(part);
      if (!figure) return undefined;
      const scale = /KiB|MiB/u.test(part) ? scaleOf(part) : cellScale;
      return Math.round(Number(figure[1].replaceAll(",", "")) * scale);
    })
    .filter((value) => value !== undefined);
}

function parseBudgetTable(doc) {
  const lines = doc.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| Class |"));
  if (header < 0) throw new Error("docs/RELEASE_GATE.md no longer carries a budget table with a `Class` column.");
  const rows = [];
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    rows.push(Object.freeze({ label: cells[0], raw: cells[1] ?? "", gzip: cells[2] ?? "" }));
  }
  return rows;
}

export function assertReleaseGateDocumentationMirrors(doc) {
  const failures = [];
  const rows = parseBudgetTable(doc);
  const documented = new Set(rows.map((row) => row.label));
  for (const { label, budgets } of DOCUMENTED_BUDGET_ROWS) {
    const row = rows.find((candidate) => candidate.label === label);
    if (!row) {
      failures.push(`the table has no row for "${label}", which covers ${budgets.join(", ")}`);
      continue;
    }
    documented.delete(label);
    for (const role of ["raw", "gzip"]) {
      const written = parseCeilingCell(row[role]);
      const expected = budgets.map((name) => RELEASE_BUDGETS[name][role]);
      // One figure may stand for several ceilings only when they are the same
      // number; otherwise the row is quietly hiding whichever it omitted.
      if (written.length === 1 && expected.length > 1 && expected.every((value) => value === expected[0])) {
        if (written[0] !== expected[0]) {
          failures.push(`"${label}" ${role}: the table says ${formatBytes(written[0])}, the ceiling is ${formatBytes(expected[0])}`);
        }
        continue;
      }
      if (written.length !== expected.length) {
        failures.push(
          `"${label}" ${role}: the table states ${written.length} figure(s) for ${expected.length} ceiling(s) (${budgets.join(", ")})`,
        );
        continue;
      }
      for (const [position, value] of written.entries()) {
        if (value !== expected[position]) {
          failures.push(
            `"${label}" ${role}: the table says ${formatBytes(value)} for ${budgets[position]}, the ceiling is ${formatBytes(expected[position])}`,
          );
        }
      }
    }
  }
  for (const label of documented) {
    failures.push(`the table row "${label}" names no ceiling this file exports; a class that is not gated must not be tabled as one`);
  }
  if (failures.length > 0) {
    throw new Error(`docs/RELEASE_GATE.md no longer mirrors the executable ceilings:\n- ${failures.join("\n- ")}`);
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
  // It is kept for a second pass at the end, where those justifications are
  // compared to the artifacts this same run measured.
  const gateSource = await readFile(fileURLToPath(import.meta.url), "utf8");
  assertDocumentedBudgetMeasurements(gateSource);
  const output = resolve(outputDirectory);
  const files = await collectFiles(output);
  const manifestPath = posix.normalize(RELEASE_MANIFEST_NAME);
  const releasableFiles = files.filter((file) => file.path !== manifestPath);
  assertExactExtensionReleaseInventory(releasableFiles.map(({ path }) => path));
  const semanticArtifactManifest = JSON.parse(
    await readFile(resolve(root, "src/indexing/semantic-artifact-manifest.json"), "utf8"),
  );
  const semanticPackStateFile = releasableFiles.find((file) => file.path === SEMANTIC_PACK_STATE_FILE);
  if (!semanticPackStateFile) throw new Error(`Required static artifact is missing: ${SEMANTIC_PACK_STATE_FILE}.`);
  const semanticPackState = parseSemanticPackState(semanticPackStateFile.payload, semanticArtifactManifest);
  assertOptionalSemanticPackIntegrity(releasableFiles, semanticArtifactManifest, semanticPackState.available);
  const failures = [];

  for (const file of releasableFiles) {
    // These large public model/runtime artifacts have already been matched to
    // their reviewed byte lengths and SHA-256 pins above. Re-decoding ONNX/WASM
    // as UTF-8 adds no security signal and can multiply gate memory by hundreds
    // of MiB.
    if (isOptionalSemanticPackPath(file.path)) continue;
    for (const finding of inspectPayload(file.path, file.payload)) {
      failures.push(`${redactSensitiveText(file.path)}: ${finding}`);
    }
    if (extensionArchivePaths.has(file.path)) {
      try {
        for (const finding of inspectExtensionArchive(file.path, file.payload)) {
          failures.push(`${redactSensitiveText(file.path)}!/${redactSensitiveText(finding)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${redactSensitiveText(file.path)}: ${redactSensitiveText(message)}`);
      }
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
    SEMANTIC_PACK_STATE_FILE,
    "sw.js",
    "extension/index.html",
    "extension/install.css",
    "extension/install.js",
    "extension/privacy.html",
    ...EXTENSION_RELEASE_FILES.map((path) => `${EXTENSION_RELEASE_PREFIX}${path}`),
  ];
  const fileMap = new Map(releasableFiles.map((file) => [file.path, file]));
  for (const path of required) {
    if (!fileMap.has(path)) throw new Error(`Required static artifact is missing: ${path}.`);
  }
  assertExtensionReleaseMetadata(fileMap);
  assertExactDocumentInventory(releasableFiles.map((file) => file.path));
  assertFallbackDocumentIsIndex(fileMap);
  assertStockReleaseExcludesLocalLab(releasableFiles);

  await validatePublicCopies(
    output,
    required.filter((path) => path !== "index.html" && path !== SEMANTIC_PACK_STATE_FILE),
  );
  assertForkContractDocumented(await readFile(resolve(root, "docs", "SESSION_LIBRARY.md"), "utf8"));
  assertReleaseGateDocumentationMirrors(await readFile(resolve(root, "docs", "RELEASE_GATE.md"), "utf8"));
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
  const wasmFiles = releasableFiles.filter(
    (file) => file.path.endsWith(".wasm")
      && !isOptionalPythonPackPath(file.path)
      && !isOptionalSemanticPackPath(file.path),
  );
  const entryJavaScriptMeasurement = measure(entryJavaScript.payload);
  const initialJavaScriptMeasurement = sumMeasurements(initialJavaScriptFiles.map((file) => measure(file.payload)));
  const entryCssMeasurement = measure(entryCss.payload);
  const serviceWorker = requireReleaseFile(fileMap, "sw.js");
  const serviceWorkerMeasurement = measure(serviceWorker.payload);
  const javaScriptFiles = releasableFiles.filter(
    (file) => (file.path.endsWith(".js") || file.path.endsWith(".mjs"))
      && file.path !== "sw.js"
      && !isOptionalPythonPackPath(file.path)
      && !isOptionalSemanticPackPath(file.path),
  );
  assertNoSimulatedGitRuntime(javaScriptFiles);
  const primeKernelWorkerPacks = javaScriptFiles.filter((file) => isPrimeKernelWorkerPath(file.path));
  assertSinglePrimeKernelWorkerArtifact(javaScriptFiles.map((file) => file.path));
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
  const optionalAgentRuntimePacks = javaScriptFiles.filter((file) => isOptionalAgentRuntimePath(file.path));
  const optionalAgentRuntimeStatusPacks = javaScriptFiles.filter((file) => isOptionalAgentRuntimeStatusPath(file.path));
  if (optionalAgentRuntimePacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional agent runtime; found ${optionalAgentRuntimePacks.length}.`);
  }
  const optionalAgentRuntimeMeasurement = measure(optionalAgentRuntimePacks[0].payload);
 
  const optionalAgentRuntimeStatusMeasurement = sumMeasurements(optionalAgentRuntimeStatusPacks.map((file) => measure(file.payload))); const optionalMultimodalPacks = javaScriptFiles.filter((file) => isOptionalMultimodalPath(file.path));
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
  assertExactChunkStems(
    "Agent tool",
    optionalAgentToolPacks.map((file) => file.path),
    ["client-context-runtime", "context-selection", "repository-admission", "tool-bundle"],
  );
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
  /*
   * Exactly one, and only when the tier ships. It is a whole storage tier, so a
   * build that silently stopped emitting it — or emitted it twice — is a
   * release question, not a bundler detail.
   */
  const optionalLocalFolderPacks = javaScriptFiles.filter((file) => isOptionalLocalFolderPath(file.path));
  // The panel's stem is a prefix extension of the port's, and the stem matcher
  // takes the first entry that matches, so the longer name is listed first.
  assertExactChunkStems(
    "Local folder",
    optionalLocalFolderPacks.map((file) => file.path),
    ["local-folder-panel", "local-folder"],
  );
  const optionalLocalFolderMeasurement = sumMeasurements(optionalLocalFolderPacks.map((file) => measure(file.payload)));
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
  // The failure classifier and vocabulary remain deferred together.
  assertExactChunkStems(
    "Request failure",
    optionalRequestFailurePacks.map((file) => file.path),
    ["request-state", "turn-recovery"],
  );
  const optionalRequestFailureMeasurement = sumMeasurements(optionalRequestFailurePacks.map((file) => measure(file.payload)));
  const optionalSessionLibraryPacks = javaScriptFiles.filter((file) => isOptionalSessionLibraryPath(file.path));
  if (optionalSessionLibraryPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional session-library pack; found ${optionalSessionLibraryPacks.length}.`);
  }
  const optionalSessionLibraryMeasurement = measure(optionalSessionLibraryPacks[0].payload);
  const optionalSessionManifestPacks = javaScriptFiles.filter((file) => isOptionalSessionManifestPath(file.path));
  assertExactChunkStems(
    "Post-paint session metadata",
    optionalSessionManifestPacks.map((file) => file.path),
    ["route-failure", "run-details", "session-manifest", "tab-presence"],
  );
  const optionalSessionManifestMeasurement = sumMeasurements(optionalSessionManifestPacks.map((file) => measure(file.payload)));
  const optionalFavoriteOrderingPacks = javaScriptFiles.filter((file) => isOptionalFavoriteOrderingPath(file.path));
  if (optionalFavoriteOrderingPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional favorite-ordering chunk; found ${optionalFavoriteOrderingPacks.length}.`);
  }
  const optionalFavoriteOrderingMeasurement = measure(optionalFavoriteOrderingPacks[0].payload);
  const optionalSessionForkPacks = javaScriptFiles.filter((file) => isOptionalSessionForkPath(file.path));
  assertExactChunkStems(
    "Session fork",
    optionalSessionForkPacks.map((file) => file.path),
    ["fork-context", "session-fork"],
  );
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
  // Two chunks today, and the ceiling governs their sum: whichever surface
  // opens first fetches both, and Rollup is free to inline one of them into a
  // consumer without that being a capability moving anywhere.
  const optionalMemorySupportPacks = javaScriptFiles.filter((file) => isOptionalMemorySupportPath(file.path));
  if (optionalMemorySupportPacks.length === 0) {
    throw new Error("Production must contain the optional Memory support chunk; found none.");
  }
  const optionalMemorySupportMeasurement = sumMeasurements(optionalMemorySupportPacks.map((file) => measure(file.payload)));
  const optionalWorkBundlePacks = javaScriptFiles.filter((file) => isOptionalWorkBundlePath(file.path));
  if (optionalWorkBundlePacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional move-work pack; found ${optionalWorkBundlePacks.length}.`);
  }
  const optionalWorkBundleMeasurement = measure(optionalWorkBundlePacks[0].payload);
  const optionalSkillsManagerViewPacks = javaScriptFiles.filter((file) => isOptionalSkillsManagerViewPath(file.path));
  if (optionalSkillsManagerViewPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional Skills route; found ${optionalSkillsManagerViewPacks.length}.`);
  }
  const optionalSkillsManagerViewMeasurement = measure(optionalSkillsManagerViewPacks[0].payload);
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
  const resumeReportEntries = optionalResumeReportPacks.filter((file) => /^assets\/resume-report-/u.test(file.path));
  const returnLedgerEntries = optionalResumeReportPacks.filter((file) => /^assets\/return-ledger-/u.test(file.path));
  const instantFormatHelpers = optionalResumeReportPacks.filter((file) => /^assets\/instant-format-/u.test(file.path));
  // Rolldown may fold the single-use timestamp helper into resume-report. Both
  // layouts are valid, but the report and independently loaded ledger must each
  // remain present and the helper must never multiply.
  if (resumeReportEntries.length !== 1 || returnLedgerEntries.length !== 1 || instantFormatHelpers.length > 1) {
    throw new Error(
      "Production must contain one resume-report pack, one return-ledger pack, and at most one split instant-format helper "
      + `(found ${resumeReportEntries.length}, ${returnLedgerEntries.length}, ${instantFormatHelpers.length}).`,
    );
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
  const optionalTerminalPacks = javaScriptFiles.filter((file) => isOptionalTerminalPath(file.path));
  assertExactChunkStems(
    "Terminal",
    optionalTerminalPacks.map((file) => file.path),
    ["manager", "terminal-dock-state", "terminal-view"],
  );
  const optionalTerminalMeasurement = sumMeasurements(optionalTerminalPacks.map((file) => measure(file.payload)));
  const optionalSemanticWorkerPacks = javaScriptFiles.filter((file) => isOptionalSemanticWorkerPath(file.path));
  if (optionalSemanticWorkerPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional semantic worker; found ${optionalSemanticWorkerPacks.length}.`);
  }
  const optionalSemanticWorkerMeasurement = measure(optionalSemanticWorkerPacks[0].payload);
  // Airship's fabric/session route is the only production provider HTTP seam.
  // Keep the retired Prime registry provider stems in the family matcher below
  // so any stale anthropic/openai chunk is classified here and rejected.
  const optionalInferenceProviderPacks = javaScriptFiles.filter((file) => isOptionalInferenceProviderPath(file.path));
  assertNoRetiredPrimeProviderChunks(optionalInferenceProviderPacks.map((file) => file.path));
  const inferenceProviderStems = [
    "fabric",
    "inference-bridge-pack",
    "provider-connections-view",
    "providers",
    "session-route",
  ];
  const observedInferenceProviderStems = optionalInferenceProviderPacks
    .map((file) => inferenceProviderStems.find((stem) => file.path.startsWith(`assets/${stem}-`)))
    .filter((stem) => stem !== undefined)
    .sort();
  if (
    optionalInferenceProviderPacks.length !== inferenceProviderStems.length
    || observedInferenceProviderStems.join("\n") !== [...inferenceProviderStems].sort().join("\n")
  ) {
    throw new Error(
      "Production inference-provider packs do not match Airship's provider-only lazy chunk family: "
      + optionalInferenceProviderPacks.map((file) => file.path).join(", "),
    );
  }
  const optionalInferenceProviderMeasurement = sumMeasurements(
    optionalInferenceProviderPacks.map((file) => measure(file.payload)),
  );
  const optionalPrimePackPacks = javaScriptFiles.filter((file) => isOptionalPrimePackPath(file.path));
  // Stock Prime has one admitted Airship transport. Removing its provider
  // registry fallback lets Rolldown fold the remaining stream vocabulary into
  // runtime; only these five ordinary Prime chunks remain. The pinned kernel
  // worker below stays a separate, independently fetched asset.
  assertExactChunkStems(
    "Prime",
    optionalPrimePackPacks.map((file) => file.path),
    ["prime-ai-hash", "prime-events", "prime-kernel-host", "prime-tool-surface", "runtime"],
  );
  const optionalPrimePackMeasurement = sumMeasurements(
    [...optionalPrimePackPacks, ...primeKernelWorkerPacks].map((file) => measure(file.payload)),
  );

  const optionalExtensionObservationPacks = javaScriptFiles.filter((file) => isOptionalExtensionObservationPath(file.path));
  if (optionalExtensionObservationPacks.length !== 1) {
    throw new Error(`Production must contain exactly one optional extension-observation pack; found ${optionalExtensionObservationPacks.length}.`);
  }
  const optionalExtensionObservationMeasurement = measure(optionalExtensionObservationPacks[0].payload);
  const optionalLocalDeviceVaultPacks = javaScriptFiles.filter((file) => isOptionalLocalDeviceVaultPath(file.path));
  /*
   * `local-lab` used to be required here, which made the loopback lab's chunk a
   * condition of shipping. It is host composition, not a product surface: a
   * stock release must contain no such chunk at all, and
   * `assertStockReleaseExcludesLocalLab` below states that as its own rule
   * rather than leaving it to a stem list that could only ever demand the
   * opposite.
   */
  const localVaultRequiredStems = ["local-device-keyring", "local-device-vault-setup"];
  /*
   * `encrypted-envelope` also serves durable storage, and `recovery` is the
   * workspace-recovery authority every provider shares; either may be folded
   * into its static importers, and both are lazy wherever they land. `recovery`
   * joined this list when the lab left: it had two lazy importers, one of which
   * was the lab's own chunk, so a stock build now folds it into the deferred
   * capability pack rather than emitting a 1,221-byte chunk for one consumer.
   * The two route/runtime packs above stay independently lazy.
   */
  const localVaultFoldableStems = ["encrypted-envelope", "recovery"];
  const localVaultObservedStems = optionalLocalDeviceVaultPacks
    .map((file) => localVaultRequiredStems.find((stem) => file.path.startsWith(`assets/${stem}-`)))
    .filter((stem) => stem !== undefined)
    .sort();
  const foldableLocalVaultPacks = localVaultFoldableStems.map((stem) =>
    optionalLocalDeviceVaultPacks.filter((file) => file.path.startsWith(`assets/${stem}-`)));
  if (
    localVaultObservedStems.join("\n") !== [...localVaultRequiredStems].sort().join("\n")
    || foldableLocalVaultPacks.some((packs) => packs.length > 1)
    || optionalLocalDeviceVaultPacks.length
      !== localVaultRequiredStems.length + foldableLocalVaultPacks.reduce((total, packs) => total + packs.length, 0)
  ) {
    throw new Error(
      "Production local-storage packs do not match the required lazy chunk family: "
      + optionalLocalDeviceVaultPacks.map((file) => file.path).join(", "),
    );
  }
  const optionalLocalDeviceVaultMeasurement = sumMeasurements(
    optionalLocalDeviceVaultPacks.map((file) => measure(file.payload)),
  );
  const deferredCapabilityPacks = javaScriptFiles.filter((file) => isDeferredCapabilityPackPath(file.path));
  const deferredCapabilityEntries = deferredCapabilityPacks
    .filter((file) => file.path.startsWith("assets/deferred-capabilities-"));
  const splitDeferredLoaders = deferredCapabilityPacks
    .filter((file) => file.path.startsWith("assets/load-deferred-capabilities-"));
  // The loader also has static consumers and may be folded into them. The
  // capability implementation itself must remain one independently lazy pack.
  if (
    deferredCapabilityEntries.length !== 1
    || splitDeferredLoaders.length > 1
    || deferredCapabilityPacks.length !== deferredCapabilityEntries.length + splitDeferredLoaders.length
  ) {
    throw new Error(
      "Production deferred-capability chunks do not match the required family: "
      + deferredCapabilityPacks.map((file) => file.path).join(", "),
    );
  }
  const deferredCapabilityMeasurement = sumMeasurements(deferredCapabilityPacks.map((file) => measure(file.payload)));
  const optionalPythonPackMeasurement = sumMeasurements(pyodideFiles.map((file) => measure(file.payload)));
  const controlledNavigationPacks = javaScriptFiles.filter((file) => isControlledNavigationPath(file.path));
  if (controlledNavigationPacks.length !== 1) {
    throw new Error(`Production must contain exactly one controlled-navigation boundary; found ${controlledNavigationPacks.length}.`);
  }
  const baselineJavaScriptFiles = javaScriptFiles.filter((file) => isBaselineJavaScriptPath(file.path));
  assertRequiredFilesAreMeasured(
    "Required pre-render JavaScript",
    [...initialJavaScriptFiles, ...controlledNavigationPacks],
    baselineJavaScriptFiles,
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
      { name: "controlled-navigation", paths: controlledNavigationPacks.map((file) => file.path) },
      { name: "deferred-capabilities", paths: deferredCapabilityPacks.map((file) => file.path) },
      { name: "execution-broker", paths: optionalExecutionPacks.map((file) => file.path) },
      { name: "execution-engine", paths: optionalExecutionEnginePacks.map((file) => file.path) },
      { name: "execution-support", paths: optionalExecutionSupportPacks.map((file) => file.path) },
      { name: "execution-tools", paths: optionalExecutionToolPacks.map((file) => file.path) },
      { name: "wasi-preview1-worker", paths: optionalWasiPreview1WorkerPacks.map((file) => file.path) },
      { name: "node-runtime", paths: optionalNodeExecutionPacks.map((file) => file.path) },
      { name: "airship-shell", paths: optionalShellPacks.map((file) => file.path) },
      { name: "agent-runtime", paths: optionalAgentRuntimePacks.map((file) => file.path) },
      { name: "agent-runtime-status", paths: optionalAgentRuntimeStatusPacks.map((file) => file.path) },
      { name: "multimodal", paths: optionalMultimodalPacks.map((file) => file.path) },
      { name: "context-policy", paths: optionalContextPolicyPacks.map((file) => file.path) },
      { name: "agent-tools", paths: optionalAgentToolPacks.map((file) => file.path) },
      { name: "workspace-workbench", paths: optionalWorkspaceWorkbenchPacks.map((file) => file.path) },
      { name: "workspace-binding", paths: optionalWorkspaceBindingPacks.map((file) => file.path) },
      { name: "workspace-codec", paths: optionalWorkspaceCodecPacks.map((file) => file.path) },
      { name: "local-folder", paths: optionalLocalFolderPacks.map((file) => file.path) },
      { name: "source-control", paths: optionalSourceControlPacks.map((file) => file.path) },
      { name: "source-selection", paths: optionalSourceSelectionPacks.map((file) => file.path) },
      { name: "browser-git-vendor", paths: optionalBrowserGitPacks.map((file) => file.path) },
      { name: "browser-git-client", paths: optionalBrowserGitClientPacks.map((file) => file.path) },
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
      { name: "work-bundle", paths: optionalWorkBundlePacks.map((file) => file.path) },
      { name: "skills-manager-view", paths: optionalSkillsManagerViewPacks.map((file) => file.path) },
      { name: "skill-editor", paths: optionalSkillEditorPacks.map((file) => file.path) },
      { name: "confirm-dialog", paths: optionalConfirmDialogPacks.map((file) => file.path) },
      { name: "shortcut-sheet", paths: optionalShortcutSheetPacks.map((file) => file.path) },
      { name: "shell-overlays", paths: optionalShellOverlayPacks.map((file) => file.path) },
      { name: "palette-actions", paths: optionalPaletteActionPacks.map((file) => file.path) },
      { name: "resume-report", paths: optionalResumeReportPacks.map((file) => file.path) },
      { name: "approval-dock", paths: optionalApprovalDockPacks.map((file) => file.path) },
      { name: "message-parts", paths: optionalMessagePartsPacks.map((file) => file.path) },
      { name: "terminal-vendor", paths: optionalTerminalPacks.map((file) => file.path) },
      { name: "semantic-worker", paths: optionalSemanticWorkerPacks.map((file) => file.path) },
      { name: "inference-providers", paths: optionalInferenceProviderPacks.map((file) => file.path) },
      { name: "prime-pack", paths: optionalPrimePackPacks.map((file) => file.path) },
      { name: "prime-kernel-worker", paths: primeKernelWorkerPacks.map((file) => file.path) },
      { name: "extension-observation", paths: optionalExtensionObservationPacks.map((file) => file.path) },
      { name: "local-device-vault", paths: optionalLocalDeviceVaultPacks.map((file) => file.path) },
      { name: "companion-install", paths: companionInstallScripts.map((file) => file.path) },
    ],
  );
  const baselineWasmFiles = wasmFiles;
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
  assertWithinBudget("Optional agent runtime", optionalAgentRuntimeMeasurement, RELEASE_BUDGETS.optionalAgentRuntime);
  assertWithinBudget("Optional agent runtime status", optionalAgentRuntimeStatusMeasurement, RELEASE_BUDGETS.optionalAgentRuntimeStatus);
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
  assertWithinBudget("Optional local folder", optionalLocalFolderMeasurement, RELEASE_BUDGETS.optionalLocalFolder);
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
  assertWithinBudget("Optional move-work pack", optionalWorkBundleMeasurement, RELEASE_BUDGETS.optionalWorkBundle);
  assertWithinBudget("Optional Skills route", optionalSkillsManagerViewMeasurement, RELEASE_BUDGETS.optionalSkillsManagerView);
  assertWithinBudget("Optional skill editor", optionalSkillEditorMeasurement, RELEASE_BUDGETS.optionalSkillEditor);
  assertWithinBudget("Shared confirm dialog", optionalConfirmDialogMeasurement, RELEASE_BUDGETS.optionalConfirmDialog);
  assertWithinBudget("Optional shortcut sheet", optionalShortcutSheetMeasurement, RELEASE_BUDGETS.optionalShortcutSheet);
  assertWithinBudget("Optional shell overlays", optionalShellOverlayMeasurement, RELEASE_BUDGETS.optionalShellOverlays);
  assertWithinBudget("Optional palette actions", optionalPaletteActionsMeasurement, RELEASE_BUDGETS.optionalPaletteActions);
  assertWithinBudget("Optional resume report", optionalResumeReportMeasurement, RELEASE_BUDGETS.optionalResumeReport);
  assertWithinBudget("Optional approval dock", optionalApprovalDockMeasurement, RELEASE_BUDGETS.optionalApprovalDock);
  assertWithinBudget("Optional message parts", optionalMessagePartsMeasurement, RELEASE_BUDGETS.optionalMessageParts);
  assertWithinBudget("Optional Terminal", optionalTerminalMeasurement, RELEASE_BUDGETS.optionalTerminal);
  assertWithinBudget("Optional semantic worker", optionalSemanticWorkerMeasurement, RELEASE_BUDGETS.optionalSemanticWorker);
  assertWithinBudget(
    "Optional inference providers",
    optionalInferenceProviderMeasurement,
    RELEASE_BUDGETS.optionalInferenceProviders,
  );
  assertWithinBudget("Optional prime runtime", optionalPrimePackMeasurement, RELEASE_BUDGETS.optionalPrimePack);
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

  // Last, because a pack over its ceiling is the more useful failure to report
  // first, and because this is the only check in the file that can compare a
  // written justification with the bytes that justify it.
  assertDocumentedMeasurementsMatchBuild(gateSource, {
    entryJavaScript: entryJavaScriptMeasurement,
    allJavaScriptAndWorkers: baselineJavaScriptMeasurement,
    deferredCapabilities: deferredCapabilityMeasurement,
    firstPartyJavaScriptAndWorkers: firstPartyJavaScriptMeasurement,
    optionalVendorRuntimeAggregate: optionalVendorRuntimeMeasurement,
    totalJavaScriptAndWorkers: totalJavaScriptMeasurement,
    optionalExecutionTools: optionalExecutionToolsMeasurement,
    optionalInferenceProviders: optionalInferenceProviderMeasurement,
    optionalWorkspaceWorkbench: optionalWorkspaceWorkbenchMeasurement,
    optionalLocalFolder: optionalLocalFolderMeasurement,
    optionalCapabilitiesView: optionalCapabilitiesViewMeasurement,
    optionalMemoryView: optionalMemoryViewMeasurement,
    optionalSkillsManagerView: optionalSkillsManagerViewMeasurement,
    optionalSkillEditor: optionalSkillEditorMeasurement,
    optionalTerminal: optionalTerminalMeasurement,
    optionalWorkBundle: optionalWorkBundleMeasurement,
  });


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
      optionalLocalFolder: Object.freeze({
        paths: Object.freeze(optionalLocalFolderPacks.map((file) => file.path)),
        ...optionalLocalFolderMeasurement,
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
        paths: Object.freeze(optionalSessionManifestPacks.map((file) => file.path)),
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
      optionalWorkBundle: Object.freeze({
        path: optionalWorkBundlePacks[0].path,
        ...optionalWorkBundleMeasurement,
      }),
      optionalSkillsManagerView: Object.freeze({
        path: optionalSkillsManagerViewPacks[0].path,
        ...optionalSkillsManagerViewMeasurement,
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
      optionalTerminal: Object.freeze({
        paths: Object.freeze(optionalTerminalPacks.map((file) => file.path)),
        ...optionalTerminalMeasurement,
      }),
      optionalSemanticWorker: Object.freeze({ path: optionalSemanticWorkerPacks[0].path, ...optionalSemanticWorkerMeasurement }),
      optionalInferenceProviders: Object.freeze({
        paths: Object.freeze(optionalInferenceProviderPacks.map((file) => file.path)),
        ...optionalInferenceProviderMeasurement,
      }),
      optionalPrimePack: Object.freeze({
        paths: Object.freeze([...optionalPrimePackPacks, ...primeKernelWorkerPacks].map((file) => file.path)),
        ...optionalPrimePackMeasurement,
      }),
      optionalExtensionObservation: Object.freeze({
        path: optionalExtensionObservationPacks[0].path,
        ...optionalExtensionObservationMeasurement,
      }),
      optionalLocalDeviceVault: Object.freeze({
        paths: Object.freeze(optionalLocalDeviceVaultPacks.map((file) => file.path)),
        ...optionalLocalDeviceVaultMeasurement,
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

export function isOptionalNodeExecutionPackPath(path) {
  return /^assets\/node-webcontainer-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalShellPackPath(path) {
  return /^assets\/airship-shell-pack-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export // The UI status surface is a separate lazy pack; exclude it from the
// runtime classifier so the runtime budget stays the runtime budget.
function isOptionalAgentRuntimePath(path) {
  if (/^assets\/agent-runtime-status-[A-Za-z0-9_-]+\.js$/u.test(path)) return false;
  return /^assets\/agent-[A-Za-z0-9_-]+\.js$/u.test(path);
}
export function isOptionalAgentRuntimeStatusPath(path) {
  return /^assets\/agent-runtime-status-[A-Za-z0-9_-]+\.js$/u.test(path);
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

/**
 * The attached-folder tier: the port over a directory handle, and the panel
 * that opens, reconnects and forgets one.
 *
 * Two chunks rather than one on purpose. Naming them into a single manual chunk
 * made Rolldown hoist preact itself out of the entry and into the pack — 28 KiB
 * where 14 KiB of first-party code belonged, for a surface almost nobody
 * fetches. They split naturally, they are fetched in the same moment, and the
 * ceiling governs their sum.
 */
export function isOptionalLocalFolderPath(path) {
  return /^assets\/local-folder(?:-panel)?-[A-Za-z0-9_-]+\.js$/u.test(path);
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
 * Slash commands: the parser, registry, planner and completer. Reachable only
 * once a runtime exists and a person types `/`, so it is not startup cost.
 */
export function isOptionalSlashCommandPath(path) {
  return /^assets\/commands-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * JavaScript required before or at the base workbench render. Optional route,
 * provider, execution, storage, and tool packs are excluded. The controlled
 * navigation boundary is deliberately included: production awaits it before
 * the first render even though Vite emits it as a dynamic chunk.
 */
export function isBaselineJavaScriptPath(path) {
  return !isOptionalExecutionPackPath(path)
    && !isOptionalExecutionEnginePath(path)
    && !isOptionalExecutionSupportPath(path)
    && !isOptionalExecutionToolsPath(path)
    && !isOptionalWasiPreview1WorkerPath(path)
    && !isOptionalNodeExecutionPackPath(path)
    && !isOptionalShellPackPath(path)
    && !isOptionalShellOverlayPath(path)
    && !isOptionalAgentRuntimePath(path)
    && !isOptionalMultimodalPath(path)
    && !isOptionalContextPolicyPath(path)
    && !isOptionalAgentToolsPath(path)
    && !isOptionalWorkspaceWorkbenchPath(path)
    && !isOptionalWorkspaceBindingPath(path)
    && !isOptionalWorkspaceCodecPath(path)
    && !isOptionalLocalFolderPath(path)
    && !isOptionalSourceControlPath(path)
    && !isOptionalSourceSelectionPath(path)
    && !isOptionalBrowserGitPath(path)
    && !isOptionalBrowserGitClientPath(path)
    && !isOptionalRoutePrimitivePath(path)
    && !isOptionalFileDownloadPath(path)
    && !isOptionalRequestFailurePath(path)
    && !isOptionalSlashCommandPath(path)
    && !isOptionalSessionLibraryPath(path)
    && !isOptionalSessionManifestPath(path)
    && !isOptionalFavoriteOrderingPath(path)
    && !isOptionalSessionForkPath(path)
    && !isOptionalCapabilitiesViewPath(path)
    && !isOptionalBrowserCapabilityPath(path)
    && !isOptionalMemoryViewPath(path)
    && !isOptionalMemorySupportPath(path)
    && !isOptionalWorkBundlePath(path)
    && !isOptionalSkillsManagerViewPath(path)
    && !isOptionalSkillEditorPath(path)
    && !isOptionalTerminalPath(path)
    && !isOptionalSemanticWorkerPath(path)
    && !isOptionalInferenceProviderPath(path)
    && !isOptionalPrimePackPath(path)
    && !isPrimeKernelWorkerPath(path)
    && !isOptionalExtensionObservationPath(path)
    && !isOptionalLocalDeviceVaultPath(path)
    && !isDeferredCapabilityPackPath(path)
    && !isCompanionInstallScriptPath(path);
}

export function isControlledNavigationPath(path) {
  // This small chunk is fetched before production renders. It owns the
  // headerless-static-host controller/reload proof, not an optional UI route.
  return /^assets\/controlled-navigation-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalFileDownloadPath(path) {
  // One `Blob` -> object-URL -> anchor -> revoke helper shared by Workspace
  // Explorer downloads and Local Device Vault recovery/backup exports. Both
  // callers are deferred routes; neither can execute at first paint.
  return /^assets\/file-download-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * Small modules shared across current deferred routes and retrieval views.
 * `route-header` and `tabs` are common route chrome. `brand-icons` is shared by
 * Provider Connections and Vault. `phone-viewport` answers Memory's responsive
 * layout question. `bm25` and `dedup` are the exact semantic retrieval stems
 * shared by Memory and indexing/tool code. MetricStrip was deleted and must not
 * remain a release-classification escape hatch for a stale artifact.
 */
export function isOptionalRoutePrimitivePath(path) {
  return /^assets\/(?:route-header|tabs|brand-icons|phone-viewport|bm25|dedup)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalRequestFailurePath(path) {
  // `turn-recovery` joined `request-state` here: they are one concern — the
  // vocabulary a turn uses when it goes wrong — and they are fetched at the
  // same moment, inside the failure handler. Keeping them out of the entry
  // chunk is the point: first paint should not carry the sentences a turn only
  // needs if it fails.
  return /^assets\/(?:request-state|turn-recovery)-[A-Za-z0-9_-]+\.js$/u.test(path);
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
  return /^assets\/(?:route-failure|run-details|session-manifest|tab-presence)-[A-Za-z0-9_-]+\.js$/u.test(path);
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
  // `memory-document` joined `kind-visual` when the memory.json schema was
  // split out of the tool surface: it is the one shared chunk the agent tool
  // bundle, the Memory route and the move-work panel all point at, so it is
  // Memory support by definition rather than by convenience.
  return /^assets\/(?:kind-visual|memory-document)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/**
 * The move-work pack: the bundle reader/writer, the digest re-verification and
 * the panel that states an import before it runs. See `optionalWorkBundle`.
 *
 * Fetched on the first press of "Move work" and never before, which is why it
 * is excluded from the pre-render baseline below rather than counted in it.
 */
export function isOptionalWorkBundlePath(path) {
  return /^assets\/work-bundle-view-[A-Za-z0-9_-]+\.js$/u.test(path);
}

/** The complete route-local Skills manager; see `optionalSkillsManagerView`. */
export function isOptionalSkillsManagerViewPath(path) {
  return /^assets\/skills-manager-view-[A-Za-z0-9_-]+\.js$/u.test(path);
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

export function isOptionalTerminalPath(path) {
  return /^assets\/(?:terminal-view|manager|terminal-dock-state)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isOptionalSemanticWorkerPath(path) {
  return /^assets\/semantic\.worker-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function isPrimeKernelWorkerPath(path) {
  return /^assets\/[A-Za-z0-9_-]+\.prime-kernel-worker\.js$/u.test(path);
}

export function assertSinglePrimeKernelWorkerArtifact(paths) {
  const matches = paths.filter((path) => isPrimeKernelWorkerPath(path));
  if (matches.length !== 1) {
    throw new Error(`Production must contain exactly one Prime kernel worker artifact; found ${matches.length}.`);
  }
  return matches[0];
}

export function isOptionalInferenceProviderPath(path) {
  // The release requires the five Airship stems checked above. The bare
  // `openai` stem and retired Prime anthropic/openai stems remain explicit
  // legacy matchers, so stale artifacts are classified and rejected.
  return /^assets\/(?:fabric|openai|openai-completions|openai-responses|anthropic|provider-connections-view|providers|session-route|inference-bridge-pack)-[A-Za-z0-9_-]+\.js$/u.test(path);
}

export function assertNoRetiredPrimeProviderChunks(paths) {
  const retired = paths.filter((path) => /^assets\/(?:anthropic|openai-completions|openai-responses)-/u.test(path));
  if (retired.length > 0) {
    throw new Error(`Production contains retired Prime provider chunks: ${retired.join(", ")}`);
  }
}

export function isOptionalPrimePackPath(path) {
  // The prime runtime port: its transport, transform, cost, and event-stream
  // modules are all deferred by design — the shell never loads the ported
  // agent runtime until a capability explicitly asks for it. The leading
  // `runtime-` alternative rejects the existing runtime-registry family,
  // which has its own budget; lookalike names must not quietly merge two
  // budgets into one.
  return /^assets\/(?:(?:prime|prime-runtime|prime-kernel|prime-harness|prime-subagents|prime-tools|prime-ai|prime-agent|transport-adapter|cost|event-stream|transform|registry)-|runtime-(?!registry-))[A-Za-z0-9_-]+\.js$/u.test(path);
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

export function isOptionalSemanticPackPath(path) {
  return path.startsWith("semantic-pack/v1/");
}

export function parseSemanticPackState(payload, manifest) {
  let state;
  try {
    state = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Semantic pack build state is not valid JSON.");
  }
  if (state?.schema !== "airship.semantic-pack-state.v1"
    || typeof state.available !== "boolean"
    || state.modelRevision !== manifest?.modelRevision) {
    throw new Error("Semantic pack build state does not match its reviewed schema and model revision.");
  }
  return Object.freeze({ available: state.available, modelRevision: state.modelRevision });
}

/**
 * An optional pack is either wholly absent or exactly the reviewed manifest.
 * This is stronger than a size budget: one missing, added, or same-size changed
 * byte rejects the release before the large binary payload enters generic scans.
 */
export function assertOptionalSemanticPackIntegrity(files, manifest, declaredAvailable = undefined) {
  const present = files.filter((file) => isOptionalSemanticPackPath(file.path));
  if (declaredAvailable === true && present.length === 0) {
    throw new Error("This build declares the optional semantic pack available, but no pack artifacts were emitted.");
  }
  if (declaredAvailable === false && present.length > 0) {
    throw new Error("This build declares the optional semantic pack unavailable, but pack artifacts were emitted.");
  }
  if (present.length === 0) return Object.freeze([]);
  const assets = manifest?.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets) || Object.keys(assets).length === 0) {
    throw new Error("The reviewed semantic artifact manifest has no usable assets.");
  }
  const expected = new Map(
    Object.entries(assets).map(([relativePath, pin]) => [`semantic-pack/v1/${relativePath}`, pin]),
  );
  const actual = new Map(present.map((file) => [file.path, file]));
  const unknown = present.map((file) => file.path).filter((path) => !expected.has(path));
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  if (unknown.length > 0 || missing.length > 0) {
    const details = [
      unknown.length > 0 ? `unreviewed: ${unknown.sort(compareText).join(", ")}` : undefined,
      missing.length > 0 ? `missing: ${missing.sort(compareText).join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    throw new Error(`Optional semantic pack does not match its reviewed file set (${details}).`);
  }
  for (const [path, pin] of expected) {
    const payload = actual.get(path).payload;
    const digest = createHash("sha256").update(payload).digest("hex");
    if (payload.byteLength !== pin.bytes || digest !== pin.sha256) {
      throw new Error(`Optional semantic pack asset failed its reviewed byte/hash pin: ${path}.`);
    }
  }
  return Object.freeze([...present].sort((left, right) => compareText(left.path, right.path)));
}

export function assertOptionalPacksAreNotPreloaded(index) {
  if (/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/(?:[A-Za-z0-9._~-]+\/)*assets\/(?:deferred-capabilities|load-deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|execution-tools|wasi-preview1-worker|node-webcontainer-pack|agent|multimodal|context-policy|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|session-manifest|session-pins|session-fork|fork-context|capabilities-view|browser-runtime|memory-view|skills-manager-view|skill-editor|kind-visual|memory-document|work-bundle-view|client|request-state|terminal-view|manager|terminal-dock-state|semantic\.worker|fabric|openai|provider-connections-view|providers|session-route|extension-bridge|local-device-vault-setup|local-device-keyring|local-lab|recovery|encrypted-envelope)-/u.test(index)) {
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

export function validateBuiltCsp(index, headers) {
  const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
  const header = /^\s*Content-Security-Policy:\s*(.+)$/mu.exec(headers)?.[1];
  if (!meta || !header) throw new Error("Built index and headers must both contain a Content-Security-Policy.");

  const metaDirectiveList = parsePolicy(meta);
  const headerDirectiveList = parsePolicy(header);
  const duplicateFailures = [
    ...duplicatePolicyDirectiveNames(metaDirectiveList).map(
      (name) => `Built index CSP contains a duplicate CSP directive: ${name}.`,
    ),
    ...duplicatePolicyDirectiveNames(headerDirectiveList).map(
      (name) => `Built response-header CSP contains a duplicate CSP directive: ${name}.`,
    ),
  ];
  if (duplicateFailures.length > 0) {
    throw new Error(
      `Built CSP directives must be unique because browsers honor the first occurrence:\n- ${duplicateFailures.join("\n- ")}`,
    );
  }

  const metaDirectives = new Map(metaDirectiveList);
  const headerDirectives = new Map(headerDirectiveList);
  const comparableHeaders = new Map(headerDirectives);
  comparableHeaders.delete("frame-ancestors");
  if (serializePolicy(metaDirectives) !== serializePolicy(comparableHeaders)) {
    throw new Error("Built index and response-header CSP directives diverge.");
  }
  if (headerDirectives.get("frame-ancestors") !== "'none'") {
    throw new Error("Built response-header CSP must deny all frame ancestors.");
  }
  const connections = metaDirectives.get("connect-src")?.split(/\s+/u) ?? [];
  const connectionFailures = validateConnectSources(connections);
  if (connectionFailures.length > 0) {
    throw new Error(`Built connect-src is invalid: ${connectionFailures.join(" ")}`);
  }
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
    `Optional inference providers ${formatBytes(measurements.optionalInferenceProviders.raw)} raw / ${formatBytes(measurements.optionalInferenceProviders.gzip)} gzip`,
  );
  console.log(
    `Optional Workspace workbench ${formatBytes(measurements.optionalWorkspaceWorkbench.raw)} raw / ${formatBytes(measurements.optionalWorkspaceWorkbench.gzip)} gzip`,
  );
  console.log(
    `Optional folder on this device ${formatBytes(measurements.optionalLocalFolder.raw)} raw / ${formatBytes(measurements.optionalLocalFolder.gzip)} gzip`,
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
    `Optional move-work pack ${formatBytes(measurements.optionalWorkBundle.raw)} raw / ${formatBytes(measurements.optionalWorkBundle.gzip)} gzip`,
  );
  console.log(
    `Optional Skills route ${formatBytes(measurements.optionalSkillsManagerView.raw)} raw / ${formatBytes(measurements.optionalSkillsManagerView.gzip)} gzip`,
  );
  console.log(
    `Optional skill editor ${formatBytes(measurements.optionalSkillEditor.raw)} raw / ${formatBytes(measurements.optionalSkillEditor.gzip)} gzip`,
  );
  console.log(
    `Optional Prime runtime ${formatBytes(measurements.optionalPrimePack.raw)} raw / ${formatBytes(measurements.optionalPrimePack.gzip)} gzip`,
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

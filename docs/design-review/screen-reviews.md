# Screen-by-screen design review

Six lanes measured every remaining route on the running build.


---

## Source Control (Workspace → Sources tab) and #terminal

**Diagnosis.**

Measured live at 1440x900 (main scroll region 842px), iPad Pro 11 (1136px) and iPhone 14 Pro Max (632px), with a real populated repo: I edited/staged/committed README.md + docs/architecture.md, created branch feature/aesthetic, ran ls/cat/seq/a failing command/a loop in the terminal, and ran `git log --oneline` through the Shared Git bridge.

SOURCE CONTROL. The route spends 614px — 73% of the 842px desktop viewport — on preamble before one pixel of Git: a 158px heading block (mono eyebrow + 43px serif H1 + 45px paragraph + 27px durability strip), a 59px Import band, and a 212px trust band. The first changed-file row sits at y=773, i.e. 92% down. On iPad the trust band alone is 361px with roughly 500px of literal void in cells 1 and 3, and the layout starts at 803/1136. On iPhone it is worse than tall — it is reordered: heading 286px (45% of viewport), layout starts at 590/632 (93%), and because the left rail renders first the change list does not begin until scroll offset 1658px, 2.6 viewport heights down a 3029px page. "Ephemeral" is printed 3 times; "remote" 11 times; the screen is 466 words. Inside, the change list holds 736px for ~262px of content (474px, 64%, empty) while the diff inspector gets 160px — 91px of code, about 4 lines of a 19-line patch. The diff gutter numbers the patch array, so it labels `--- a/README.md`, `+++ b/README.md` and `@@ -1,3 +1,12 @@` as lines 1, 2, 3; and because `<b>` prints a sign and `<code>` prints the unstripped line, the screen reads `+ +# Airship workspace` and `− -# Private workspace`. Longest line measured 261 chars with wrap off by default. Change rows have tabIndex -1; checkboxes are 18x18, diff buttons 36px, Tree/Flat 38px. The left rail carries 8 always-visible form controls in a 513px stack inside a 188px column (Remove selected worktree wraps to two lines) above ~225px of void; the right rail is 172 words with a 1030-character always-on remote essay. And history is absent: after I committed, the commit was nowhere on screen; after I created feature/aesthetic, the branch appeared nowhere except inside a closed select. `BrowserGitClient` implements log/show/tag/stash/merge/restore/reset and the bridge routes all of them — `git log --oneline` returned `964d257 Initial browser workspace` live — but `sources-view.tsx`'s `execute()` throws `not-a-source-control-mutation` for every one, and a body scan of the populated screen returns log:false, stash:false, merge:false, reset:false, restore:false. The one place a person can reach Git history is a text box on a different route.

TERMINAL. 324px (38%) of the desktop viewport is chrome above the terminal panel; the emulator gets 548px (65%) and the route totals 991px against 842px, so the whole page scrolls behind the terminal's own scrollback. The explanation band costs 183px and **cannot be closed on desktop**: `.terminal-route__setup > summary { display: none }` above 760px while `setupOpen` initialises true. Forcing it shut drops the route to 808px and lifts the panel from y=406 to y=223. The same fact is stated three ways in that band (paragraph "runs inside this page's WebContainer", chip "Browser Node shell", hidden summary "Browser Node shell"). The Shared Git bridge is a second command line stacked above a terminal that cannot run git, and its output is echoed into the xterm with a `$ ` prompt while the real jsh prompt is `❯`. Panel controls are 30px tall (Interrupt 95x30, Restart 80x30, Close 65x30) against the 44px rule; on iPhone the bar wraps to 77px over three lines and the emulator starts at y=372 of 632px, with no Tab/Esc/arrow affordance. `session.detail` and `Command history · N` live in a 28px strip at y=1002 — permanently below the desktop fold. And the route never says "airship-sh" or "POSIX": live, `for i in 1 2 3; do echo $i; done` returned `jsh: unsupported shell syntax` and `seq 1 400` returned `jsh: command not found`, while Airship ships its own POSIX shell with control flow, functions, here-docs and abortable execution at `state: "ready"`, `tier: "web-baseline"` — no download, no cross-origin isolation, no third-party delivery. The manager is hardcoded to WebContainer and the runtimes are never presented as a choice.

### Collapse the 614px Source Control preamble into one 44px repo bar

- impact **transformative** · effort **medium** · reclaims ~570px desktop (614→44), ~740px iPad, ~530px iPhone plus the fold moves from 92% to ~10%
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css, src/ui/sources-presentation.test.ts

**Problem.** At 1440x900 the heading block (158px), Import band (59px) and trust band (212px) plus gaps consume 614px — 73% of the 842px main viewport — before `.git-sources-layout` begins; the first changed-file row is at y=773 (92% down). On iPad the trust band alone is 361px with ~500px of vertical void in cells 1 and 3. On iPhone the heading is 286px (45% of a 632px viewport) and 'Ephemeral · this page only' is printed twice, adjacently, under 'Workspace files' and 'Git index & refs'.

**Design.** Replace `.git-sources-heading`, `.git-import` and `.git-sources-trust*` with one sticky 44px `.git-repo-bar` at the top of `<section class="git-sources">`: `[branch glyph] Airship Workspace · main · acbb23f │ 3 changed · 2 staged │ ● ● ⛨ │ [Import ▾] [Refresh]`. The three dots are 44px `aria-expanded` buttons; each opens the existing `SourceTrustFacts` cell as a popover with its `strong` + `small` text unchanged. Merge the two DurabilityIndicators into one dot when both agree — `● Ephemeral · workspace files + Git index` — which expands to the two original labelled rows with their separate detail strings, and renders as two dots when they disagree. `Import ▾` opens the existing `.git-import-body` (form, Snapshot contract paragraphs, ImportProgress, ImportReceipt) as a popover on desktop and a sheet under 760px.

**Information fate.** Eyebrow 'Browser-native source control' → visually-hidden text on the new `<h1>` (kept for screen readers; the tab and sidebar already say it). H1 'Repositories & worktrees' → repo name + branch in the bar, full string kept as the visually-hidden h1. Heading paragraph → body of a `ⓘ` disclosure on the bar labelled 'About this surface', verbatim. Two durability pills → one merged dot that expands to both original rows. Three trust cells (Page-memory repository / Direct Git HTTPS / Version-bound writes) → the three dots, identical strong+small copy on expand. Import band and its entire body → the `Import ▾` popover, every field and contract paragraph unchanged.

### Give Source Control a History pane wired to the log/show/tag/stash/merge/restore/reset verbs that already exist

- impact **transformative** · effort **large** · reclaims n/a — adds the missing half of the surface into space reclaimed by proposals 1 and 5
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css, src/git/client.ts, src/git/operations.ts, src/ui/sources-view.test.ts

**Problem.** `BrowserGitClient` implements log, show, createTag, deleteTag, stash, merge, restore and reset, and `src/git/terminal-commands.ts` routes all of them — I ran `git log --oneline` through the Terminal's Shared Git box and got `964d257 Initial browser workspace` back live. But `execute()` in sources-view.tsx throws `not-a-source-control-mutation` for every one of those kinds, and a text scan of the populated Source Control screen returns log:false, stash:false, merge:false, reset:false, restore:false. After I committed, the commit was invisible; after I created `feature/aesthetic`, the branch appeared nowhere except inside a closed 'Switch branch' select. The only route to Git history in the product is a text input on a different screen.

**Design.** Turn `.git-change-stage` into a two-tab pane sharing the diff panel below: `Changes · 3` / `History`. History renders `client.log` as a virtualized list — short oid, subject, author, relative time, and ref chips for any branch or tag pointing at that commit, so a newly created branch is visible without opening a menu. Selecting a commit calls `client.show` and renders its file list into the same diff panel. A per-row `⋯` offers the already-implemented reviewed verbs: 'Tag this commit…' (createTag) and 'Reset worktree to here…' (reset) with copy 'Reset moves the branch pointer. Choose what happens to your files.' and three labelled options soft / mixed / hard. In Changes, add a per-row 'Discard changes' → restore, copy: 'Discard working-tree changes to <path>? The file returns to its staged content. This cannot be undone from this page.'; add a `Stash ▾` control beside Commit ('Stash all changes' / 'Pop latest stash'); add 'Merge branch…' to the branch menu from proposal 5.

**Information fate.** Pure addition of state that is already true and already computed — nothing is removed or restated. Each verb reuses its existing `describeGitOperation` descriptor so the approval-dock text is unchanged. The Shared Git bridge keeps working exactly as it does; this stops it being the only door.

### Reclaim the terminal: make the explanation band collapsible on desktop and stop the route scrolling

- impact **high** · effort **small** · reclaims 183px desktop, and the route drops 991→808px so the page stops scrolling; emulator share rises from 65% toward 88%
- **Files.** src/ui/terminal-view.tsx, src/ui/terminal-view.css

**Problem.** `.terminal-route__setup > summary { display: none }` applies at every width above 760px while `setupOpen` initialises to `true`, so on desktop the 183px band is permanently open and its own disclosure control is invisible. Chrome above the terminal panel measures 324px of an 842px viewport (38%); the route totals 991px so the entire page scrolls behind the terminal's own scrollback. Setting `details.open = false` in the console drops the route to 808px — under the viewport — and lifts the panel top from y=406 to y=223. The band also states one fact three times: the paragraph says 'runs inside this page's WebContainer', the assurance chip says 'Browser Node shell', the hidden summary says 'Browser Node shell'.

**Design.** Show the summary at every width; persist open/closed in `localStorage` under `airship.terminal.setup.v1`; default it closed once any session has ever started. Collapsed summary carries the load-bearing facts on one 44px row: `>_ Browser Node shell · WebContainer, not your device shell · Shared Git  ⌄`. Set `.terminal-route { height: 100%; grid-template-rows: auto auto minmax(0,1fr) auto; overflow: hidden }` so only the emulator scrolls.

**Information fate.** The paragraph 'Real interactive Node processes run inside this page's WebContainer. This is not your device shell, host Bash, SSH, or a remote Airship backend.' stays verbatim inside the band. All four assurance chips (Browser Node shell / Processes stay hot while this page lives / Reload requires process restart / Thread <id>) stay inside. The Shared Git form stays (relocated by proposal 10). The triple statement collapses to one: the summary line is the only place the runtime is named while collapsed.

### Split the change list into Staged / Not staged groups with 44px per-row stage toggles

- impact **high** · effort **medium** · reclaims 41px of legend; every row and control reaches 44px; staged/unstaged becomes readable at a glance instead of at 0.7rem
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css, src/ui/sources-view.test.ts

**Problem.** After I staged two of three paths the header still read '3 changed paths'; staged-ness was carried only by a 0.7rem sub-label ('staged · modified') and a filled-vs-outlined letter badge that needs a permanent 41px legend row to decode. Checkboxes are 18x18 against the 44px rule, `Working diff` is 91x36, and change rows have tabIndex -1 with no arrow-key navigation. A row showing both scopes renders two buttons totalling 182px inside a 669px column.

**Design.** In `ChangedPathRow` and `.git-change-stage`, render two `role="group"` sections with sticky 32px headers — `Staged · 2  [Unstage all]` and `Not staged · 1  [Stage all]` — with conflicted paths in their own third group. Each row becomes a 44px `role="button"` with roving tabindex and arrow-key navigation: delta glyph, path, `+12 −3`, and a right-hand 44x44 `＋`/`−` toggle that stages or unstages that single path through the existing reviewed mutation. Shift-click and Space keep multi-select feeding the existing bulk buttons, which move into the group headers. Collapse the two diff buttons into one 44x44 `⟨⟩` that opens a two-item menu when both scopes exist.

**Information fate.** Filled/outlined delta letters stay on the row (they still carry added/modified/deleted/renamed/conflicted). The 41px legend paragraph ('Staged = ready to commit' / 'Working = not yet staged') moves into a `ⓘ` on each group header, same words. The `staged · added` / `working · modified` sub-labels become redundant with the group heading and survive as the delta glyph's title. The rename `from → to` line and the conflict note stay, the note attached to the conflicted group. Tree/Flat toggle stays, bumped to 44px.

### Fix the diff gutter and doubled +/− markers, and make the diff the largest thing on the route

- impact **high** · effort **medium** · reclaims diff area 160px → ~430px at rest (4 lines → ~22), and ~474px of empty list box returned to the diff
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css, src/ui/sources-view.test.ts

**Problem.** `.git-diff-lines` renders `<span>{index + 1}</span>`, the patch array index, so the gutter labels `--- a/README.md`, `+++ b/README.md` and `@@ -1,3 +1,12 @@` as lines 1, 2, 3 — no reader can map a hunk to a file line. Because `<b>` prints a sign and `<code>` prints the unstripped line, the screen literally shows `+ +# Airship workspace` and `− -# Private workspace`. Longest line measured 261 characters with `white-space: pre` and Wrap off by default, so long lines clip. At rest the diff panel is 160px with 91px of code — about 4 of a 19-line patch — while the change list holds 736px for ~262px of content, 474px (64%) empty. The header prints the raw scope enum: `worktree · README.md`.

**Design.** Parse the `@@` hunk headers already present in the patch into old/new line counters and render a two-column gutter (old | new) like GitHub. Strip the leading sign from `<code>` since `<b>` already carries it. Render `@@` lines as a full-width dimmed hunk separator preserving the `@@ -1,3 +1,12 @@` text verbatim, and promote the `---`/`+++` header lines out of the diff body into the panel subtitle. Persist the Wrap checkbox in localStorage and add a soft-wrap continuation indent. Change `.git-change-stage` to `grid-template-rows: auto minmax(0, 0.4fr) minmax(280px, 0.6fr)` with a draggable splitter so the list is capped near its content and the diff takes the remainder, plus a `⤢` in the diff header that expands the diff across the whole `.git-sources-layout` for reading. Header copy becomes `README.md · working tree vs index` and `README.md · index vs HEAD`.

**Information fate.** Every patch line still renders, including the `---`/`+++`/`@@` lines — they move to subtitle and separator rows rather than disappearing. The `bounded preview` badge, the Wrap control and the empty-state sentence 'Choose a staged or working diff. Patches are computed locally and bounded before display.' all stay. The raw scope words 'staged'/'worktree' are replaced by their plain-English equivalents in the header, which state the same comparison more precisely.

### Demote the rail's 513px form wall into a branch menu and put the remote essay behind a disclosure

- impact **high** · effort **medium** · reclaims ~510px from the left rail and ~330px from the right rail on desktop; on iPhone it removes an 816px rail from in front of the change list, moving the first file from scroll 1658 to about 400
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css, src/ui/menu-select.tsx

**Problem.** `.git-branch-controls` is 513px tall inside a 188px column and holds 8 always-visible controls — Switch branch select, Switch checkout, New branch input, Create branch, Worktree branch input, Workspace path input, Create worktree, Remove selected worktree (which wraps to two lines). Above it, with one worktree, the rail carries ~225px of void. The right `.git-action-rail` is 172 words; its 'Remote boundary' section alone is 1030 characters of always-on prose, and the word 'remote' appears 11 times on the screen.

**Design.** Replace the form wall with a single 44px `main ▾` branch button in the stage header beside the changed count. Its menu holds a filtered branch list (click = reviewed checkout), 'Create branch from main…', 'Merge into main…' (proposal 4), and a Worktrees submenu carrying Create/Remove with the same two inputs inline. The left rail returns to repository picker + worktree list + HEAD and last-fetch meta, about 180px. In the action rail keep 'Local commit' open and turn 'Remote boundary' into a summary row: `origin · not configured — fetch and push unavailable  ⌄`.

**Information fate.** Nothing deleted. Every control keeps its label, disabled rule and title text inside the menu. The CSP paragraph ('isomorphic-git speaks Smart HTTP directly…'), the `gitCredentialBoundary()` sentence, the push warning and the 'If the final response is lost…' sentence all move into the disclosure verbatim. `upstreamStatus()` stays visible as the one-line summary because it is the live claim rather than static contract text. 'Remove selected worktree' keeps its two title strings for the two disabled reasons.

### Present the runtimes as a choice and surface airship-sh in the terminal

- impact **transformative** · effort **large** · reclaims n/a — turns a hidden first-party capability into the default working shell and explains the jsh failures a person actually hits
- **Files.** src/ui/terminal-view.tsx, src/terminal/manager.ts, src/terminal/contracts.ts, src/execution/shell/adapter.ts, src/ui/terminal-view.css

**Problem.** `BrowserTerminalManager` is hardcoded to `activateNodeWebContainerHost`, and the route's text never contains 'airship-sh' or 'POSIX'. Live in the terminal, `for i in 1 2 3; do echo $i; done` returned `jsh: unsupported shell syntax` and `seq 1 400` returned `jsh: command not found: seq` — while Airship ships its own POSIX shell at `state: "ready"`, `tier: "web-baseline"`, with control flow, functions, here-documents, globbing, traps and `cancellation: "abort-interpreter"`, needing no download, no cross-origin isolation and no third-party delivery. WebContainer is `state: "installable"`, `tier: "web-enhanced"`, and depends on StackBlitz delivery plus npm egress. The person choosing a terminal is told none of this and is given no choice.

**Design.** The `＋` on the tab strip opens a two-item runtime menu instead of silently creating a Node tab. Item 1: `airship-sh · POSIX sh` — 'Airship's own interpreter. Runs here: no download, no network, no third party. POSIX sh only — not Bash.' badge `Ready`. Item 2: `Node · WebContainer` — 'Real Node processes and npm. Delivered by StackBlitz; needs cross-origin isolation.' badge `Installable · third-party delivery`. The chosen runtime becomes a chip on the tab and in the panel bar (`Terminal 1 · sh`, `Terminal 2 · node`). When a jsh command fails with `unsupported shell syntax` or `command not found`, the panel bar shows one dismissible line: 'jsh does not implement this. airship-sh does — open an airship-sh tab?' with the action inline. Requires a second terminal backend in `src/terminal/manager.ts` driving the existing interpreter as a REPL alongside the WebContainer host.

**Information fate.** `AIRSHIP_SH_CAPABILITY.detail` and the WebContainer capability `detail` become the verbatim bodies of an `ⓘ` on each menu item — this is where the route's current explanatory paragraph goes rather than being dropped. The 'not your device shell' claim stays on the collapsed setup summary from proposal 7 and applies to both runtimes.

### Fold the terminal route heading into the tab strip

- impact **medium** · effort **small** · reclaims 66px desktop (54 + gap), 109px iPhone; combined with proposal 7 the emulator goes from 548px (65%) to ~790px (94%) of the desktop main viewport
- **Files.** src/ui/terminal-view.tsx, src/ui/terminal-view.css

**Problem.** `.terminal-route__heading` is 54px on desktop and 97px on iPhone for a mono eyebrow 'WORKSPACE · BROWSER PROCESS ROOM' plus a serif H1 'Terminal' naming a route the sidebar already shows as selected, alongside two buttons. On iPhone that block plus the action row pushes the emulator to y=372 of a 632px viewport.

**Design.** Replace the visible H1 block with a visually-hidden `<h1>Terminal</h1>`. Move `New terminal` into the tab strip as a trailing `＋` (which becomes the runtime menu from proposal 9) and `Reconcile workspace` into a `⋯` at the end of the strip, keeping its exact label, its disabled rule (`!sessions.some(status === running || exited)`) and its notice strings ('Synced N revision-fenced workspace changes.' / 'Workspace is already synchronized.').

**Information fate.** The eyebrow 'Workspace · browser process room' folds into the collapsed setup summary as the trailing context; the H1 survives for screen readers and the document title. Both buttons keep identical labels, icons, disabled logic and notices, one click deeper.

### Move Shared Git inside the terminal and mark its output as a different authority

- impact **medium** · effort **medium** · reclaims 79px from above the terminal; the bridge stops competing with the prompt for 'which box do I type in'
- **Files.** src/ui/terminal-view.tsx, src/ui/terminal-view.css, src/terminal/manager.ts, src/git/terminal-commands.ts

**Problem.** `.terminal-git-bridge` is a 79px full-width form with its own monospace input pre-filled `git status` and a Run button, sitting above a terminal that cannot run git at all. Its output is written into the xterm buffer prefixed `$ ` — I saw `$ git log --oneline` then `964d257 Initial browser workspace` — while the real jsh prompt is `❯`. A reader sees two command lines, one of which appears to have been typed into the other. The deterministic command set is discoverable only by typing `git help`.

**Design.** Keep the bridge and move it into `.terminal-panel` as a 44px footer strip that reads as part of the terminal, below the emulator. Prefix its echoed output with a brass `git▸` marker and a left brass rule so a reader can always tell which authority produced a line. Add an autocomplete list built from `help()` in `src/git/terminal-commands.ts` — status, diff, add, reset, restore, log, show, tag, stash, merge, commit, branch, switch, checkout, fetch, push, remote, rev-parse, worktree, clone — so the command set is discoverable inline.

**Information fate.** The label 'Shared Git' becomes the strip's leading chip; the sub-label 'Authoritative Editor/source-control state · approval policy applies' becomes the input placeholder's `ⓘ`; the sentence 'This deterministic bridge uses browser Git directly; the WebContainer never receives a second copy of .git. Try git help.' becomes that `ⓘ`'s body verbatim. Every output line, notice string and error path is unchanged.

### One 44px terminal panel bar, with the meta strip pulled above the fold and a touch key row

- impact **medium** · effort **small** · reclaims bar 47→44px desktop, 77→44px iPhone; the 28px meta strip leaves the layout entirely, adding ~40px to the emulator and lifting two facts above the fold
- **Files.** src/ui/terminal-view.tsx, src/ui/terminal-view.css

**Problem.** `⌃C Interrupt` is 95x30, `Restart` 80x30 and `× Close` 65x30 — all below the 44px rule, and Close is destructive. On iPhone 14 Pro Max the bar wraps to 77px over three lines (Running / /workspace / thread 63b1c59…6e5c9) with three icon-only buttons and no label. `session.detail` and `Command history · N` sit in a 28px strip measured at y=1002 against a clientH of 842 — permanently below the desktop fold. On touch there is no Tab, Esc, arrow or Ctrl affordance beyond the ⌃C button.

**Design.** Collapse the bar to one 44px row: `● Running` + truncating `/workspace` (full path in title) + a 44x44 `⋯` overflow holding Restart, Close, Reconcile workspace, Rename and the thread id. Interrupt stays as the only always-visible 44px control while status is `running`, so the one time-critical action never hides. Under 760px dock a 44px key bar above the emulator: `Tab  Esc  ↑  ↓  ⌃C  ⌃D  /  -`.

**Information fate.** `statusLabel(session)` (Starting / Running / Exited N / Restart required / Failed) stays on the dot and its tooltip. `session.detail` ('Interactive jsh process running inside this page's WebContainer.', 'Cold-starting the in-browser WebContainer runtime…', the deactivation strings) moves into the status dot's popover so it is finally reachable. `Command history · N` and its ordered list move into the `⋯` menu, unchanged. The thread id keeps its full value in the menu item's title. Nothing is removed; two items that were below the fold become reachable.

### Rebuild the Source Control empty and clean states as designed panels rather than leftovers

- impact **medium** · effort **small** · reclaims ~640px of dead middle column on the clean state converted into visible history and diff
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css

**Problem.** After I committed, the middle column showed ~640px of empty dark space between a one-row change list and a 160px 'Diff inspector' reading 'Choose a staged or working diff' — the most common resting state of a healthy repo is the emptiest screen on the route. The no-repository state (`.git-sources-empty`) offers 'Check available browser sources' and a single `small` line about clone availability, while the real primary action (Import public GitHub snapshot) is a separate collapsed band 300px above it.

**Design.** Clean state: replace the 736px empty list box with a 120px designed panel — `✓ Worktree clean · HEAD, index and working tree agree` plus the last commit line (`964d257 · Initial browser workspace · 3m ago`) as a link into the History pane from proposal 4 — and let the diff panel take the remaining height showing the selected commit. Empty state: fold the Import affordance directly into `.git-sources-empty` as its primary button ('Import a public GitHub snapshot'), with 'Check available browser sources' as the secondary.

**Information fate.** 'Nothing to stage' and 'HEAD, index, and working tree agree.' stay verbatim in the clean panel. The clone-availability sentence — 'A clone-capable adapter is available.' / 'Full-history clone unavailable: <reason>.' — stays under the empty-state buttons unchanged. The diff empty-state sentence stays as the panel's placeholder when no commit is selected.

### Make the Sources tab strip a real 44px surface switch and remember which pane you were in

- impact **medium** · effort **small** · reclaims ~55px by merging the 43px strip and its gap into the repo bar; targets reach 44px on desktop
- **Files.** src/ui/editor-view.tsx, src/ui/editor-view.css, src/ui/navigation-model.ts

**Problem.** `.editor-route__tabs button` is 34px tall on desktop (44px only under 760px), the strip is `width: fit-content` at 228px floating above a full-width panel, and `mode` is component state that resets to `files` on every remount — so navigating away from Source Control and back always drops you into the editor. There is also no route hash for it, so Source Control cannot be linked or bookmarked.

**Design.** Raise the tabs to 44px at all widths, add counts so the strip carries state — `Files & editor` / `Sources · 3` where 3 is `worktree.status.length` — and persist `mode` under `airship.editor.mode.v1` alongside a `#sources` hash so the pane is addressable. Merge the strip into the repo bar from proposal 1 on desktop so the route has one header band instead of a tab strip plus a page heading.

**Information fate.** Both tab labels stay exactly as written. The changed-path count moves from being visible only after you arrive to being visible before you arrive; it also still appears in the stage heading. No content changes.


---

## Workspace and Editor (#workspace, #editor, Sources tab)

**Diagnosis.**

Measured at 1440x900, iPad Pro 11 (834x1194) and iPhone 14 Pro Max (430x740), both empty and populated with 6 created files, a 240-line file, 9 open tabs and 9 Git changes.

THE HEADLINE NUMBERS
- #workspace and #editor are the *same component*. app.tsx:5176 renders `EditorScreen` for both, and editor-view.tsx:58 hard-codes `heading="Editor"`. So the sidebar item labelled "Workspace" opens a page whose H1 says "Editor" and whose eyebrow says "PAGE WORKSPACE". Two routes, one screen, three different names for it.
- Chrome before the workbench: desktop 315px (35% of 900), tablet 293px, phone 375px (51% of 740). Sequence: route tabs 43px, eyebrow 15px, a 47px Georgia H1, a 2-line paragraph, a durability pill, sometimes a notice bar. On phone that becomes six stacked bands and the first file row lands at y=498 — 67% of the viewport is chrome; ~3 files are visible.
- Three tab strips stack on phone: "Files & editor / Sources" (53px), "Files / Editor · 6" (45px), "Explorer / Source Control 9" (48px).
- `.workspace-tree { height: 432px }` (workspace-view.css:12) is a hard pixel height inside a rail that is 628px (desktop) or 718px (tablet) tall. Populated, the tree content is 336px. So 96px dead on desktop and 382px (53% of the rail) dead on tablet, inside a bordered panel.
- The rail is `minmax(15rem, 21rem)`. On iPad it takes 357px of a 693px workbench and the code column gets 334px, of which the gutter eats 33px → **301px of actual code, 18% of the tablet viewport**. The file list gets more room than the code.
- Tab strip: 9 tabs = 1593px of content in a 797px strip (desktop, 2.0x), 334px (tablet, 4.8x), 402px (phone, 3.7x). No fade, no overflow menu, and the active tab is never scrolled into view — on phone the strip showed queue.ts / backpressure.ts / websocket-adapt… while the toolbar said `docs/architecture.md`.
- `.editor-status` ("Modified" / "Saved", "UTF-8 · LF · client-side") measured at y=959 on a 900px desktop viewport, y=920 on a 740px phone. It is **never visible without scrolling on any device**, because the route scrolls as a document instead of the workbench owning the viewport.
- Real information deletion already ships: `.editor-toolbar small { display: none }` at ≤760px drops the revision hash and byte size on phone with no way to recover them. The `DurabilityIndicator` detail sentence lives only in `title=`, so it is unreachable by touch and by keyboard on every device.
- Sources: the 660-character CSP paragraph ("isomorphic-git speaks Smart HTTP directly…") is printed **verbatim twice** on desktop — once in the "Direct Git HTTPS" trust card, once in "REMOTE BOUNDARY". "Ephemeral · this page only" appears three times on one screen (topbar chip + Workspace files + Git index & refs). First change row: y=817 desktop (91% down the fold), y=1026 tablet, **y=1746 phone — 2.8 screens of scrolling before one changed file is visible**; the route is 3526px tall in a 632px phone viewport.
- The phone Sources view already collapses the three trust cards into one `SOURCE POSTURE · Page memory · Remote available · Ve…` disclosure row. The good pattern exists in the codebase and is only turned on below 760px.
- The workbench modal (`.workbench-dialog`) has neither Escape-to-close nor a focus trap, while platform-shell.tsx:321, mobile-navigation.tsx:183 and approval-dock.tsx:45 all use `trapFocus`. Verified live: Playwright could not dismiss the Move dialog with Escape. `.move-targets button { min-height: 36px }` is also not raised to 44px in the ≤760px block, unlike `.workspace-scm button`.
- The Move dialog is titled "Move file" and never names the file being moved.
- The notice region latches: "Creating file…" was still on screen minutes after the create completed, pushing the workbench down 40px.
- Discovery: the only creation affordance is a 26x26 "+" glyph. The folder context menu is Expand / New file… / Close — no New folder, no rename, no delete. Folders can only be created by typing slashes into "New file". There is no filter box on a tree that is fully virtualized for thousands of rows.

WHAT IS GOOD AND MUST SURVIVE
Byte size per file at rest, revision hash + compare-and-swap language, the truncation/binary boundary notices, per-file A/M/D deltas, the "Nothing is downloaded until you select it" promise, full arrow-key tree navigation, and the honest remote/CSP caveats. Every proposal below re-homes these; none deletes one.

### Replace the 315px route header with one 44px workbench bar

- impact **transformative** · effort **medium** · reclaims desktop 315px → 44px (+271px, 30% of the viewport back); tablet 293px → 44px; phone 375px → 44px (+331px, 45% of the viewport back, taking visible file rows from 3 to ~10)
- **Files.** src/ui/workspace-view.tsx, src/ui/editor-view.tsx, src/ui/workspace-view.css, src/ui/editor-view.css, src/ui/app.tsx, src/ui/durability-indicator.tsx

**Problem.** Desktop spends 315px (35% of a 900px viewport) before the first file row; phone spends 375px (51%). The band is: route tabs (43px) + monospace eyebrow "DEVICE-EXECUTED · PAGE WORKSPACE" (15px) + a 47px Georgia H1 "Editor" + a 2-line paragraph + a "Ephemeral · this page only" pill (150px total). The H1 also lies: #workspace and #editor render the same component and both say "Editor" while the sidebar says "Workspace", and the topbar already shows an "Ephemeral" chip, so Ephemeral is printed twice on the screen.

**Design.** Delete the `.page-heading` block from workspace-view.tsx:423 and merge it with the `.editor-route__tabs` nav (editor-view.tsx:44) into a single sticky 44px bar that is the first thing inside `.editor-route`:

`[ Files ][ Sources ]   /workspace   ·   ⌂ device-executed   ·   ● Ephemeral ⌄   ·······   [⌘P Find file] [+ New ⌄]`

Left: the existing two-segment route control, unchanged, at 44px. Centre: the workspace path as a real breadcrumb (`/workspace` when nothing is open, `workspace / notes / retrieval.md` when a file is). Right: the trust chips, then the two global actions. On ≤760px the bar keeps the segmented control and the chips and moves `[+ New]` to a 44px icon button; the breadcrumb truncates from the left (`… / notes / retrieval.md`).

Also fix the route identity: pass `heading="Workspace"` when `view === "workspace"` and keep `"Editor"` for `#editor`, or collapse the two nav destinations to one. Today they are byte-identical screens.

**Information fate.** H1 "Editor" → becomes an `sr-only` h1 for the accessibility tree plus the breadcrumb's root crumb; the visible name already exists in the sidebar and in the active route segment. Eyebrow "Device-executed · Page workspace" → "Device-executed" becomes a ⌂ chip whose click/Enter opens a popover reading "Device-executed · every read, write and Git operation in this view runs in this browser tab. Nothing is uploaded."; "Page workspace" becomes the breadcrumb root, which reads `/workspace` and shows the adapter name (`Page workspace`, `Local Device Vault`, …) on hover and in the popover. Paragraph "Files, version-fenced editing, and browser-native source control share one workspace." → moves verbatim into the Explorer empty state (proposal: "Discoverable creation…") and into the `?` line of the durability popover; it is a first-run orientation sentence, not a permanent header. Durability pill → stays in the bar as `● Ephemeral ⌄`; clicking it expands the full detail sentence that is currently trapped in `title=` ("Workspace files exist only in this page-memory adapter. Nothing is synced."), which makes it reachable by touch and keyboard for the first time.

### Let the workbench own the viewport so the status strip stops falling below the fold

- impact **transformative** · effort **medium** · reclaims recovers 59–180px of below-fold content per device; eliminates page-level scroll on desktop and tablet entirely
- **Files.** src/ui/editor-view.css, src/ui/workspace-view.css, src/ui/styles.css

**Problem.** The route scrolls as a page: `.workbench-shell` is `min-height: min(70vh, 720px)` inside a document-scrolling `main`. Measured, the editor's footer sits at y=959 on a 900px desktop viewport, y=1027 on tablet and y=920 on a 740px phone. "Modified" / "Saved" and "UTF-8 · LF · client-side" are therefore invisible on every device unless the user scrolls the whole page — and when they scroll, the route tabs and breadcrumb scroll away too (visible in the desktop populated capture, where the Files/Sources control is clipped at y=57). The dirty state of the file you are typing in is only otherwise shown by a tab dot which, with 9 tabs, is off-screen.

**Design.** Make `.editor-route` a full-height grid: `height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr);` with the 44px bar from proposal 1 as row 1 and `.workbench-shell` as row 2 with `min-height: 0`. Change `.workbench-shell` from `min-height: min(70vh,720px)` to `height: 100%`. Give `.workbench-editor` `display: grid; grid-template-rows: auto auto minmax(0,1fr) auto` so tabs, toolbar, code and status are all pinned and only the code scrolls. Same for `.workbench-activity` (see the tree-height proposal). The page itself then never scrolls on desktop or tablet; on phone the shell gets `height: 100dvh - topbar - bottomnav` so the status strip sits directly above the bottom nav.

**Information fate.** Nothing moves except upward into view. "Modified"/"Saved", "UTF-8 · LF", "client-side", "Binary · read-only" and "Protected bytes" all keep their exact current strings and become permanently visible instead of permanently hidden. The route tab control and breadcrumb become sticky rather than scroll-away.

### Merge the toolbar and the status footer into one honest 32px file strip, and stop deleting revision and size on phone

- impact **high** · effort **medium** · reclaims 76px → 32px of editor pane chrome (+44px of code), and restores 2 facts currently deleted below 760px
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css

**Problem.** The same file state is asserted in three places — the tab dot ●, the Save button's enabled/disabled state, and the footer word "Modified" — and the third is below the fold (see previous proposal). Meanwhile `.editor-toolbar small { display: none }` at ≤760px *deletes* the revision hash and byte size on phone with no alternative surface; the phone toolbar reads only "package.json  [Save]". The desktop toolbar (50px) and footer (26px) together spend 76px of a 628px editor pane on eight words.

**Design.** Collapse `.editor-toolbar` and `.editor-status` into one 32px `.editor-strip` pinned to the bottom of the editor pane (the toolbar's path duty is taken over by the breadcrumb in the 44px bar from proposal 1):

`● Unsaved · 25117ef · 72 B · UTF-8 LF · Ln 14, Col 8 · client-side` … right-aligned `[⌘S Save]`

States, exact copy: saved → `● Saved`; dirty → `● Unsaved · ⌘S to save`; truncated → `◐ Bounded preview · read-only`; binary → `◼ Binary · read-only`. The revision hash is a click-to-copy chip with `title="Revision 25117ef — writes are compare-and-swapped against this exact revision"`.
On ≤760px the strip keeps `● Unsaved` and `[Save]` inline and puts `25117ef · 72 B · UTF-8 LF · client-side` behind a `⌄` that expands the strip to two 32px lines. Nothing is display:none'd at any width.

**Information fate.** Toolbar path → breadcrumb in the 44px bar (still `title`-full-path). Revision short hash → stays, becomes copyable, and is now present on phone. Byte size → stays, present on phone. "Modified"/"Saved" → becomes the ● dot + word in the same strip. "UTF-8 · LF · client-side" → stays verbatim, behind the ⌄ on phone. "Binary · read-only" / "Protected bytes" → become the ◼ state of the same strip; the full binary explanation stays in the existing `.workspace-binary-preview` body. Save button → unchanged, gains its keyboard hint. New: Ln/Col, which the textarea already knows and nothing currently shows.

### Make the file tree fill its rail and give the rail a resizable, collapsible width

- impact **transformative** · effort **medium** · reclaims tablet code column 301px → ~513px (+70%); tablet rail dead space 382px → 0; desktop tree +196px of usable rows
- **Files.** src/ui/workspace-view.css, src/ui/workspace-view.tsx

**Problem.** Two hard-coded numbers fight the layout. `.workspace-tree { height: 432px }` plus the inline `maxHeight: WORKSPACE_FILE_VIEWPORT_HEIGHT` cap the tree at 432px inside a rail that measures 628px (desktop) and 718px (tablet) — with 8 files the content is 336px, leaving 96px dead on desktop and 382px (53% of the rail) dead on tablet, all inside a bordered panel that looks broken. And `grid-template-columns: minmax(15rem, 21rem) minmax(0,1fr)` hands the rail 357px of a 693px tablet workbench, so the code column gets 334px and, after the 33px gutter, 301px of real code — 18% of the tablet viewport. The file list outranks the code on an iPad.

**Design.** Rail: `grid-template-columns: clamp(12rem, var(--workbench-rail, 26%), 22rem) minmax(0, 1fr)` with a 6px keyboard-operable splitter (`role="separator"`, ArrowLeft/Right ±16px, Home/End to min/max) that writes `--workbench-rail` and persists it in the existing `sessionStorage` tab-state record. Add a 44px `«` collapse control in the rail header that reduces the rail to a 44px icon strip (Explorer / Source Control icons with their count badges) and restores on click — the same mechanism the tablet needs by default.
Tree: `.workspace-tree { flex: 1; min-height: 0; height: auto; }` and drive `workspaceFileWindow`'s viewport height from a `ResizeObserver` on `treeViewport` instead of the `WORKSPACE_FILE_VIEWPORT_HEIGHT` constant (keep the constant as the SSR/initial fallback so virtualization math is unchanged). Default `--workbench-rail` to 26% on tablet, which gives the rail 180px and the code 513px.

**Information fate.** Nothing is removed. The tree simply shows more of the rows it already virtualizes — desktop goes from 12 to ~18 visible rows, tablet from 12 to ~21. When the rail is collapsed to 44px the Explorer/Source Control counts stay visible as badges, and the tree is one click away. Byte sizes, chevrons, icons and the overflow control are untouched.

### Give the tab strip an overflow menu, active-tab autoscroll and truncation that keeps the extension

- impact **high** · effort **medium** · reclaims n/a
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css

**Problem.** Nine open tabs produce 1593px of strip content in 797px (desktop, 2.0x overflow), 334px (tablet, 4.8x) and 402px (phone, 3.7x). There is no fade, no scroll button and no overflow list, and the strip never scrolls the active tab into view — the phone capture shows the strip displaying queue.ts / backpressure.ts / websocket-adapt… while the toolbar says `docs/architecture.md`. The dirty dot for the file you are editing is therefore routinely off-screen, which is the only dirty signal that is currently above the fold. Tab labels are untruncated basenames, so `really-long-component-name-panel.tsx` alone consumes 250px, and two files named `index.ts` are indistinguishable.

**Design.** In `.editor-tabs` (workspace-view.tsx:462): (1) on `activePath` change, `element.scrollIntoView({ inline: "nearest", block: "nearest" })`; (2) `max-width: 15ch` on the label with middle truncation that preserves the extension (`really-long…panel.tsx`), full path still in `title`; (3) when two open tabs share a basename, append the parent directory in `--ink-faint` (`index.ts` `runtime`, `index.ts` `ui`); (4) a pinned 44px `⌄ 4` control at the right end of the strip opening a menu of every open tab as `[● ] path/from/workspace` rows, dirty ones first, with a `Close others` / `Close saved` footer; (5) a 12px accent-tinted fade on whichever edge has hidden tabs; (6) `Ctrl/⌘+Alt+←/→` to move between tabs and `⌘W` to close, listed in the overflow menu footer.
Also split `.editor-tabs` off the `.workbench-mode-tabs` row (they currently sit in one visual band, which makes the file tabs read as children of the Source Control panel) by giving the mode tabs the rail header instead of the shell header.

**Information fate.** Every open tab stays open and every one is reachable — the ones that do not fit move into the `⌄ N` menu with their full workspace-relative path, which is more than the strip shows today. The dirty ● stays on the tab and is mirrored in the overflow menu and in the count badge (`⌄ 4 · 2 unsaved`). Close buttons stay. Nothing about tab persistence (`airship.workspace.tabs.v1`) changes.

### Make creation and folders first-class, and add a filter to a tree that is already virtualized for thousands of rows

- impact **high** · effort **large** · reclaims n/a
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css, src/workspace/tree.ts

**Problem.** The only discoverable way to create anything is a 26x26 bare `+` glyph in the WORKSPACE header. The directory context menu offers exactly "Expand / New file… / Close" — there is no New folder, no rename, no delete for folders, and a folder can only be created by typing slashes into the New-file path field. The file context menu has no icons and no keyboard hints, and spends a row on "Close", which menus do on outside-click anyway. And the tree is fully virtualized (`WORKSPACE_FILE_OVERSCAN`, windowed rendering, a 250-path SCM cap) — i.e. built for large repositories — yet there is no filter or quick-open anywhere, so a 2000-file import is navigable only by scrolling.

**Design.** Rail header becomes one 36px row: `WORKSPACE` … `[ ⌕ filter ]` … `[ + New ⌄ ]` (44px targets on touch). `+ New` opens File / Folder / Upload…; "Folder" reuses the existing create dialog with the label `Folder name (relative to notes/)` and writes a `.gitkeep`-free directory via the same `writeWorkspaceAndGit` path. The filter input filters `visibleWorkspaceTree` by substring, auto-expands ancestors of matches, highlights the matched span, and shows `12 of 486 files` beneath itself; Escape clears it and returns focus to the tree. Add `⌘P` quick-open over `files` reusing `MenuSelect`'s existing listbox behaviour.
Context menu, files: `Open` · `Open to the side` · `Rename` (⏎) · `Move…` · `Copy path` · `Delete` (⌫). Folders: `Expand/Collapse` · `New file…` · `New folder…` · `Rename…` · `Delete…`. Every destructive item keeps the existing revision-checked confirmation copy. Drop the "Close" row and add a footer hint `Esc to dismiss`.

**Information fate.** Nothing is removed — the menu gains items and loses only its redundant "Close" row, whose behaviour (Escape / outside pointerdown) is already implemented and becomes documented instead of duplicated as a button. Byte sizes, the drag-to-move affordance and the 420ms hover-expand all stay. The filter never hides a file permanently: clearing it restores the full tree, and the `12 of 486` counter makes the filtered state impossible to mistake for an empty workspace.

### Turn the empty editor pane into the orientation surface instead of 464,000 dead pixels

- impact **high** · effort **small** · reclaims converts 464,000 px² (desktop) / 224,000 px² (tablet) of dead pane into the route's onboarding, which then lets the 40px header paragraph be removed on every subsequent visit
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css

**Problem.** Empty, the editor pane is 797x582 on desktop (36% of the whole viewport) and holds one 36px folder glyph and two lines: "Open a file from Explorer" / "Nothing is downloaded until you select it." On tablet it is 334x672 with the same two lines. Meanwhile the route paragraph that actually explains the screen ("Files, version-fenced editing, and browser-native source control share one workspace.") is being burned into the header above every populated session, where it is read once and then ignored forever.

**Design.** Keep the glyph and both lines, centred, and add beneath them a 3-item list that is the only place a first-run user needs to look:

`Open a file from Explorer`
`Nothing is downloaded until you select it — Airship fetches file bytes only when you open one.`

`↳ README.md            845 B`   (the three largest / most recently written workspace files, as buttons)
`↳ docs/architecture.md 108 B`
`↳ notes/retrieval.md    72 B`

`[ + New file ]  [ ⌘P Find a file ]`
footer, `--ink-faint`, `--fs-micro`: `Files, version-fenced editing, and browser-native source control share one workspace. Every write is compare-and-swapped against the revision you opened.`

When the workspace has zero files, the three suggestions are replaced by `[ + New file ]  [ Import a GitHub snapshot ]` (the latter deep-links to the Sources import banner) and the copy becomes `This workspace is empty. Create a file, or import a public repository snapshot.`

**Information fate.** Both existing sentences stay verbatim. The header paragraph moves here (and into the durability popover) rather than being deleted. The byte sizes shown next to the suggestions are the same `formatBytes(entry.size)` already rendered in the tree. Nothing new is fetched — the suggestion list reads the `files` array the route already has, and honours "nothing is downloaded until you select it" because it shows metadata only.

### Say what phone editing is, and turn on wrapping so prose files are readable at 390px

- impact **high** · effort **small** · reclaims n/a
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css

**Problem.** `.code-editor` is `white-space: pre` with no wrap control at any width. On a 402px phone pane a single markdown line renders as "The browser owns orchestration; the select" and runs off the right edge — the rest of the file is reachable only by horizontal scrolling one line at a time, under 408px of otherwise empty pane. The gutter is `display: none` below 760px, so there is not even a line number to orient by. Sources already ships a "Wrap" checkbox for its diff panel; the editor does not. The honest answer to "is this usable at 390px" is "for reading and small edits, yes; for code, no" — and the UI currently says nothing either way.

**Design.** Add a wrap toggle to the file strip from proposal 3: a 44px `⏎ Wrap` segmented control, defaulting **on** below 760px and **off** at ≥761px, persisted per workspace in the existing tab-state record. Wrapping sets `white-space: pre-wrap; overflow-wrap: anywhere` and, when on, replaces the per-line gutter with a soft-wrap-aware one or hides it (already hidden on phone). Reuse the exact `Wrap` label and checkbox semantics from sources-view so the two surfaces read as one system.
Second, be explicit about the phone posture. When the pane is < 480px wide and the buffer is not `truncated`/`binary`, show a single dismissible `--fs-micro` line directly under the tab strip: `Phone editing is on. Wrapped, no line numbers — long code files are easier on a wider screen.` Dismissal persists. When the buffer *is* read-only, the existing boundary notice already says why and stays exactly as it is.

**Information fate.** Nothing removed. The gutter's line numbers, already hidden below 760px, gain a stated reason instead of vanishing silently; at ≥761px with wrap on they stay and simply mark logical lines. The two existing read-only notices (`Bounded preview only.` / `Encrypted file not downloaded.` and the binary preview body) are untouched — this proposal only covers the editable case, which currently has no honest label at all.

### Fix the workbench modal: Escape, focus trap, 44px targets, and name the file being moved

- impact **high** · effort **small** · reclaims n/a
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css, src/ui/focus-trap.ts

**Problem.** `.workbench-dialog` is the only modal in Airship without Escape-to-close or a focus trap — platform-shell.tsx:321, mobile-navigation.tsx:183 and approval-dock.tsx:45 all call `trapFocus`, and workspace-view.tsx only wires Escape for the *context menu* (line 136). Verified live: Playwright could not dismiss the Move dialog with Escape and had to be killed. The Move dialog is titled "Move file" and never says which file — it shows a flat list of full paths (`workspace/src/runtime/scheduler`) with no indentation, no filter and no label on the disabled current-parent row. And `.move-targets button { min-height: 36px }` is not raised in the `@media (max-width: 760px)` block, unlike `.workspace-scm button`, so the move destination list ships 36px touch targets on phone.

**Design.** Wrap the dialog in the same pattern the rest of the app uses: `tabIndex={-1}`, `onKeyDown` → Escape closes / Tab calls `trapFocus(event, dialog.current)`, focus moved to the first field on open and restored to the invoking row on close. Retitle: `Move really-long-component-name-panel.tsx` (the H2 carries the basename, `title` carries the full path). Above the list, one `--fs-micro` line: `Currently in workspace/src/ui/components.` Indent the destination rows by depth using the same 15px-per-level rule as the tree and show only the segment name with the ancestors dimmed, so `workspace/src/runtime/scheduler` renders as `scheduler` at depth 3 under a dimmed `src / runtime`. Add a filter input above the list when there are more than 8 destinations. Raise `.move-targets button` to `min-height: 44px` inside the ≤760px block. Same treatment for the create/rename/delete/discard variants.

**Information fate.** Every destination still appears — indentation replaces the repeated `workspace/…` prefix, and hovering or focusing a row shows the full path in `title`. The existing unsaved-draft warning ("The unsaved draft will move with this tab; the durable file is not changed until you save.") and the delete confirmation's revision language stay verbatim. The dialog gains the file name it was always missing.

### Stop the notice bar from latching, and give it a home that does not shove the workbench down

- impact **medium** · effort **small** · reclaims 40px of permanent layout shift removed on every device; on phone this is one of six stacked chrome bands
- **Files.** src/ui/workspace-view.tsx, src/ui/workspace-view.css

**Problem.** `transact()` sets `setNotice("Creating file…")` and only ever replaces it — nothing clears it. Captured on all three devices: "Creating file…" was still on screen minutes after the create succeeded, and "Saved package.json with revision compare-and-swap." persisted through six subsequent interactions. The bar is 40px of full-width layout that pushes `.workbench-shell` down by 40px every time it appears and never gives the space back, and on phone it lands between the mobile pane switch and the mode tabs, adding a sixth chrome band.

**Design.** Split the two roles. In-flight work (`Creating file…`, `Saving file…`, `Moving file…`, `Updating source control…`) becomes a 2px indeterminate accent line along the top of the workbench plus the verb in the file strip from proposal 3 — no layout shift. Completion notices (`Saved package.json with revision compare-and-swap.`, `Moved to notes/queue.ts. Unsaved edits moved with the tab.`) become a bottom-left toast over the editor pane, `role="status"`, auto-dismissing after 6s with a `⌄` that pins it. Errors keep `role="alert"`, do **not** auto-dismiss, and render inline at the top of the affected pane (rail for SCM errors, editor for file errors) with a `Dismiss` button — an error that cannot be dismissed is the only case where a persistent band is correct. Add the missing `setNotice(undefined)` on success in `transact`.

**Information fate.** Every current string survives with its wording intact; only its lifetime and position change. Success messages become transient-but-pinnable rather than permanent; errors become dismissible rather than permanent; progress verbs stop occupying a block-level band. Nothing that today is announced to screen readers stops being announced — `role="status"` and `role="alert"` are preserved on the toast and the inline error respectively.

### Sources: collapse the trust cards into the disclosure row the phone already has, and stop printing the CSP paragraph twice

- impact **transformative** · effort **medium** · reclaims desktop first-change-row y=817 → ~330px (from 91% to 37% of the fold); phone y=1746 → ~640px (from 2.8 screens to under one)
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css

**Problem.** On desktop the first changed file sits at y=817 of a 900px viewport — 91% down, effectively below the fold — and on phone at y=1746, which is 2.8 full screens of scrolling; the whole route is 3526px tall in a 632px phone viewport. What fills that space: a 158px heading block, a row that prints "Ephemeral · this page only" twice (a third copy is in the topbar), a 59px import banner, and a 212px three-card trust grid whose middle card contains a 660-character paragraph while the other two cards float ~55% empty at forced equal height. That same 660-character CSP paragraph is then printed **verbatim a second time** under REMOTE BOUNDARY, ~700px lower. The phone build already collapses the three cards into one row — `SOURCE POSTURE · Page memory · Remote available · Ve…` — proving the pattern is built and merely gated behind `max-width: 760px`.

**Design.** Promote `.git-sources-trust-disclosure` to every breakpoint as the default, and widen its summary so it stops truncating: `SOURCE POSTURE  ● Page memory · ● Direct HTTPS (2 origins blocked) · ● Version-bound   ⌄`. Expanded, it renders the three existing cards at natural height in a single column — no forced equal-height grid, no dead space. Collapse the two durability pills into one: `Workspace files & Git index & refs  ● Ephemeral · this page only` (one pill, one expansion listing both scopes with their separate detail sentences). Under REMOTE BOUNDARY, replace the duplicated paragraph with the state line plus a reference: `No remote configured. Direct Git HTTPS is blocked for github.com and gitlab.com by this build's Content-Security-Policy — see Source posture ↑` where the link scrolls to and expands the disclosure. Shrink the H1 to the shared 44px bar treatment from proposal 1 (eyebrow "BROWSER-NATIVE SOURCE CONTROL" → chip; paragraph → the disclosure's intro line).

**Information fate.** Not one word of the CSP paragraph is lost — it stays in full inside the Source posture expansion, which is the one place it belongs, and the REMOTE BOUNDARY copy becomes a pointer to it instead of a second rendering. "Page-memory repository" and "Version-bound writes" keep their bodies verbatim inside the same expansion. Both Ephemeral scopes keep their distinct detail sentences inside the merged pill's expansion. The remaining three push caveats ("Push is always reviewed…", "Anonymous direct push only…", "If the final response is lost…") stay where they are, attached to the buttons they govern.

### Sources: put the diff beside the change list instead of 1.7 viewports below it, and compress the 58px change row

- impact **high** · effort **large** · reclaims diff moves from y=1465 to within the first fold; change rows 58px → 40px (10 rows = +180px of list); rail sheds ~470px of always-open branch controls
- **Files.** src/ui/sources-view.tsx, src/ui/sources-view.css

**Problem.** The Diff inspector is a fixed 160px panel at the bottom of a 736px change list, measured at y=1465 on desktop — you click a file at y=880 and the result renders 585px below, off-screen, so reading a diff means scrolling away from the list you are working. With an empty added file selected, the panel header correctly showed `worktree · docs/adr/0001-browser-native-execution.md` while the body still read "Choose a staged or working diff", conflating "nothing selected" with "this file has no textual change". Each change row is 58px on desktop and 104px on phone and repeats an identical "Working diff" button ten times down the list; the delta chips read `+0 −0` on every newly added file. The left rail meanwhile keeps eight branch/worktree controls (~470px) permanently expanded above ~250px of blank space for a single worktree.

**Design.** Change `.git-sources-layout` from three stacked-ish columns to `grid-template-columns: minmax(0,1fr) minmax(0,1.15fr)` at ≥1100px, with the change list on the left and a sticky, full-height Diff inspector on the right; the action rail (Local commit + Remote boundary) moves under the change list as a two-column footer. Below 1100px the diff becomes a sheet that slides over the list with the file name in its header and a `←` back control. Row: drop the per-row "Working diff" button — the row itself opens the diff (it already has a click target) — and keep one `Staged ⇄ Working` toggle in the diff header, so the staged/working distinction is not lost. Row becomes 40px: `☐  A  queue.ts  ·  src/runtime/scheduler  ·  +0 −0`, basename first at full opacity, directory dimmed, delta letter colour-coded (A `--v-verified`, M `--accent`, D `--danger`, C `--v-caution`) with the existing legend kept. Diff empty states, exact copy: nothing selected → `Select a changed path to compute its patch locally.`; selected but identical → `No textual change in queue.ts. The file is newly added and empty (0 B).`; binary → the existing binary language. Collapse the branch/worktree block into `Branches & worktrees ⌄` (closed by default when there is exactly one worktree, open otherwise).

**Information fate.** Nothing is dropped. `working · added` moves from a second row line into the colour-coded delta letter plus its tooltip and the existing legend (`Staged = ready to commit` / `Working = not yet staged` stay). The "Working diff" wording survives as the diff header's toggle label, where it now also names the alternative (`Staged diff`) that ten identical buttons never mentioned. `+0 −0` stays, and the diff panel's new empty copy explains what a zero delta means instead of leaving it ambiguous. All eight branch/worktree controls stay, one disclosure away, with their counts in the summary row. Bounded-patch and 250-path caps keep their current notices.


---

## Vault and storage (#vault): provider selection, Google Drive / Local Device / S3-MinIO configuration, connected state, durability and encryption posture, recovery-key ceremony

**Diagnosis.**

Measured live at 1440x900 (main scroll viewport = 842px), iPad Pro 11 (834x1194, main = 1136px) and iPhone 14 Pro Max (430x740, main = 632px). Screenshots in .aesthetic/shots/vault/.

THE ROUTE SAYS EVERYTHING TWICE. #vault renders two independent components stacked — VaultView (src/ui/vault-view.tsx) and a provider setup panel (local-device-vault-setup / local-lab-setup / google-drive-setup) — and neither knows the other exists. Each has its own brass monospace eyebrow, its own big heading, its own one-line prose summary and its own status pill. Local Device empty state, desktop: eyebrow "PRIVATE DEVICE STATE" + H1 "Vault" (34px) + "Encrypted journal and workspace state remain in browser-managed storage on this device and work offline." + pill "Disconnected" + truth card "Local Device setup required" + empty card "Complete the crash-safe recovery ceremony below…" + eyebrow "DEVICE-OWNED DURABILITY" + H2 "Local Device Vault" + "Encrypted, offline, and private to this browser profile." + pill "Not opened". That is FOUR restatements of "not connected" and THREE of "encrypted/offline/device" in 606px, before the first real control. On desktop the first non-decoy control ("Open existing") sits at y=664 = 72% down the 842px scroll viewport; on iPad it is at 58%; on iPhone (632px window) the entire Local Device Vault panel is below the fold — 596px of 632 (94%) is spent restating that nothing is connected.

THE MOST PROMINENT BUTTON ON THE EMPTY STATE IS DEAD. "Open Local Device setup" / "Configure vault" is the only brass-filled button on screen. It calls onOpenSetup → setVaultSetupOpen(open => !open), but app.tsx:5268 renders the Local Device setup slot unconditionally, and app.tsx:5280 renders the Google Drive slot whenever `vaultBackend === "google-drive" && phase === "disconnected"` regardless of that flag. In both cases clicking it changes nothing. Meanwhile the actual primary actions ("Open existing", "Create new", "Recover with Google Drive") are rendered as ghost or unstyled buttons further down. The visual hierarchy is exactly inverted.

THE ONE-TIME RECOVERY KEY IS RENDERED OFF-SCREEN. Measured: after clicking "Create new" at 1440x900, `.local-device-vault__ceremony` lands at y=922 in a viewport whose main region spans y=58..900 — zero pixels visible, no auto-scroll, no focus move. The value `airship-wrk-v1.k875Ttjtxâ€¦` (57 chars) is in the DOM and the app tells the user it "cannot be shown again", but nothing above the fold changes except the button they just clicked relabelling itself "Replace ceremony". This is the highest-stakes moment on the route and it is invisible by default.

A CONNECTED VAULT STILL SHOWS ITS OWN CREDENTIAL FORM. With MinIO connected and the contract verified, desktop content is 2449px = 2.9 scroll viewports, and 1157px of it (47%) is a full "Connect your loopback S3 lab" form repeating the six facts the read-only table 967px above already shows (endpoint, region, bucket, namespace, access key, secret key). On iPhone the same state scrolls 3974px = 6.3 viewports.

FACTS ARE PRINTED TWICE IN DIFFERENT WORDS. Local Device connected has two stat grids in two different typographic systems (monospace 2-col dl; sans 4-col grid). 4 of the 10 cells are the same fact twice: "Storage engine / Origin Private File System" vs "Backend / OPFS"; "Retention / Browser managed · backup recommended" vs "Retention / Browser managed"; "Synchronization / Device only · offline available" vs "Offline / Available"; plus "Provider / Local Device" duplicating the provider dropdown. Context fabric does it too, two adjacent lines saying the same thing.

YOU CANNOT COMPARE THE PROVIDERS. The choice is a 340x263px MenuSelect popover with one line each ("Encrypted, offline, and persistent in this browser profile" / "Your encrypted cross-device Airship workspace folder" / "Advanced provider or local development lab" / "Page memory only; nothing synced"). None of the dimensions that actually decide this — survives closing the tab, works offline, reaches other devices, what you must supply, what you must keep, what can destroy it — are visible side by side. Every one of those facts already exists on this route, scattered across three header paragraphs, three truth cards, a config table, a readiness grid and two warnings.

GOOGLE DRIVE IS OUTSIDE THE DESIGN SYSTEM. google-drive-setup.css contains no `button` rule at all: measured "Recover with Google Drive" (the panel's primary action) = 26px tall, raw UA grey; "Create a new workspace" = 26px; the "Show imported recovery key" checkbox = 13px box in a 19px row. The standing rule is 44px. Everything else on the route is 44px (local-lab) or 40px (local-device). The recovery textarea is 1090px wide × 98px for a 57-char key, in Inter, masked. And the default first-run mode is "recover an existing workspace" — a brand-new user's primary path is a paste-your-existing-key box.

VALIDATION DESTROYS WORK. Entering one bad endpoint in the MinIO form and submitting calls clearForm(): all six fields are wiped, the generated one-time recovery key is destroyed, and a single line — "Local-development vaults require a loopback S3 endpoint." — appears at the very bottom of a 3627px page, ~2000px below the field that caused it, with no aria-invalid, no field anchor and no focus move.

Ephemeral: 883px of content in a 900px viewport with ~460px of dead space below it, and four blocks all saying nothing is stored (top-shell chip "Ephemeral", eyebrow "PRIVATE PAGE STATE", pill "Disconnected", truth "Ephemeral · page memory only", empty card "No endpoint, credential authority, or workspace key is attached") — and the empty card has no button at all, because onOpenSetup is undefined for ephemeral. It is an empty state that offers no exit.

None of this information should be deleted. All of it should be said once, in the right place, at the right size.

### Replace the provider dropdown with a three-card comparison the user can actually read

- impact **transformative** · effort **medium** · reclaims Adds ~180px desktop when expanded (the honest cost of a real comparison) but retires 72px of selector chrome plus the 121px header paragraph and ~80px of duplicated truth-card prose it makes redundant; collapses to 44px once connected, net −149px desktop / −186px phone in the connected state.
- **Files.** src/ui/vault-provider-chooser.tsx, src/ui/vault-provider-chooser.css, src/ui/vault-view.tsx, src/ui/vault-view.css

**Problem.** Choosing where your data lives is the most consequential decision on this route and it happens inside a 340x263px MenuSelect popover with one line of description per option (measured, .aesthetic/shots/vault/D-provider-menu-open.png). The popover also covers the panel behind it. Not one of the dimensions that decides the choice — durability, offline, cross-device reach, what you must supply, what you must keep, what can destroy it — is comparable, even though every one of those facts is already printed somewhere else on this same route (the three header paragraph variants at vault-view.tsx:69-75, the three truth-card variants at :110-118, the config dl at :158-171, the readiness grid in local-device-vault-setup.tsx:706-726, and the eviction warning). The provider selector row costs 72px desktop / 115px phone to show a single collapsed value.

**Design.** New component src/ui/vault-provider-chooser.tsx + .css, replacing .vault-provider-selector in vault-view.tsx:86-103. A radiogroup of four selectable cards — three durable peers in a row (2-up on iPad, stacked on phone) plus Ephemeral rendered as a visually quieter fourth tile with a dashed border, so it reads as 'no durability' rather than a peer. Each card: provider name, a 6-row fact matrix in aligned label/value rows, and a state chip on the selected card. Cards are <label><input type=radio> so arrow keys move between them natively; min-height 44px per card, full card is the hit target.

Exact matrix (rows identical across cards so the columns line up):
Survives closing the tab — Local Device: 'Yes · encrypted on this device' / Google Drive: 'Yes · encrypted in your Drive' / S3-MinIO: 'Yes · encrypted in your bucket' / Ephemeral: 'No · released with the page'
Works offline — 'Yes' / 'No · needs Google' / 'No · needs the endpoint' / 'Yes, until you close it'
Reaches other devices — 'No' / 'Yes' / 'Yes' / 'No'
You supply — 'Nothing' / 'A Google account' / 'Endpoint and keys' / 'Nothing'
You keep — 'A recovery key' / 'A recovery key' / 'A recovery key' / 'Nothing to keep'
What can lose it — 'Browser eviction · clearing site data' / 'Deleting the Drive folder' / 'Deleting the bucket' / 'Closing the page'

When a provider is connected the chooser collapses to a single 44px row: '[dot] Local Device · encrypted and offline — Change provider', where 'Change provider' re-expands the cards. Keeps 'Keys and encryption stay client-owned in every mode.' as a footnote under the card row. Keeps the 'Moving the active runtime safely…' status line.

**Information fate.** Nothing removed. The four MenuSelect one-line descriptions become the card subtitles verbatim. The three per-provider header paragraphs (vault-view.tsx:69-75) STOP being three essays and become matrix rows — 'work offline', 'nothing is synchronized', 'closing the page releases it', 'travel directly between this device and the provider' are each already a row. The eviction warning from LocalDeviceReadiness moves into the 'What can lose it' row and still appears in full on the connected panel. 'Keys and encryption stay client-owned in every mode.' stays as a footnote. Ephemeral stays a first-class selectable option, just visually demoted to match what it is.

### Fuse four restatements of 'not connected' into one state header with the real action in it

- impact **transformative** · effort **medium** · reclaims 466px → ~96px on desktop (−370px, 44% of the scroll viewport); 596px → ~150px on iPhone (−446px, 71% of the 632px window)
- **Files.** src/ui/vault-view.tsx, src/ui/vault-view.css, src/ui/app.tsx

**Problem.** Measured on Local Device empty, desktop: .vault-view__header 121px (eyebrow + 34px H1 'Vault' + 2-line paragraph) + phase pill 'Disconnected' + .vault-view__truth 81px ('Local Device setup required' + caveat) + .vault-view__empty 115px ('Complete the crash-safe recovery ceremony below…' + a dead button) = 466px, 55% of the 842px scroll viewport, all saying the same thing before the provider panel even starts. On Ephemeral the same stack produces 883px of content in a 900px viewport with ~460px of dead space below and an empty-state card that has no button at all. The route heading 'Vault' is also already the selected item in the left rail and the tab bar — it is printed three times on screen.

**Design.** Collapse vault-view.tsx:57-119 and :151-155 into one <VaultStateHeader> band, ~96px desktop: a 10px status dot + one headline + one caveat line + inline actions, with an expandable 'What's attached' disclosure carrying the prerequisite detail.

Exact copy per state:
· disconnected + local-device — amber dot. Headline 'Local Device — not set up yet'. Caveat 'No storage authority is created until you save a recovery key.' Actions: [Create encrypted Vault] primary, [Recover with a key] secondary. Disclosure 'What's attached (0 of 3)' → 'Device key · not enrolled', 'Encrypted object store · not created', 'Recovery key · not saved'.
· disconnected + s3/drive — amber dot. Headline 'S3-compatible — nothing attached'. Caveat keeps snapshot.message verbatim. Disclosure 'What's attached (0 of 3)' → 'Endpoint · none', 'Credential authority · none', 'Workspace key · none' — this is where the sentence 'No endpoint, credential authority, or workspace key is attached.' goes, itemised.
· ephemeral — grey dot, no 'Disconnected' pill (ephemeral is a chosen mode, not a failure). Headline 'Ephemeral — nothing is being stored'. Caveat 'Workspace and journal state live only in this page. Closing it releases them.' Action: [Choose a durable provider] which expands the chooser and focuses the first card. This gives the ephemeral empty state the exit it currently lacks.
· ready — green dot. Headline '[provider] — encrypted runtime active'. Caveat keeps the honest limit verbatim: 'Cross-device sync is not evaluated by this probe.'
· degraded — caution dot. Headline keeps snapshot.diagnostic.code; the full diagnostic block stays as today.

Drop the 34px H1 'Vault' and the monospace eyebrow entirely — the route is already titled by the rail and the tab bar. Keep the phase pill only for probing ('Testing…' with the cancel action inline).

**Information fate.** Nothing removed. Eyebrow's provider-mode word ('device'/'page'/'object-store') is absorbed into the headline. The header paragraph moves to the chooser matrix (proposal 1). phaseCopy().headline and .label merge into the one headline; snapshot.message stays as the caveat. 'No endpoint, credential authority, or workspace key is attached.' becomes three named rows with per-item state, which says strictly more than the sentence did. The 'Complete the crash-safe recovery ceremony below…' sentence merges into the local-device caveat. Every honest limit sentence survives word for word.

### Kill the two dead brass buttons and give the state header the action that actually works

- impact **high** · effort **small** · reclaims 115px desktop / 135px phone, and removes a 44px false-primary from the first screen on every viewport
- **Files.** src/ui/vault-view.tsx, src/ui/app.tsx, src/ui/local-device-vault-setup.tsx, src/ui/google-drive-setup.tsx

**Problem.** 'Open Local Device setup' and 'Configure vault' are the only brass-filled buttons on the empty state — the loudest element on screen at 1440x900 and the only visible control on iPhone. Both are no-ops. onOpenSetup (app.tsx:5253) toggles vaultSetupOpen, but app.tsx:5268 renders the Local Device setup slot for `vaultBackend === 'local-device'` unconditionally, and app.tsx:5280 renders the Google Drive slot whenever `google-drive && phase === 'disconnected'` regardless of the flag. Clicking either produces zero visible change. Verified in the browser on both paths. The real primary actions — 'Open existing', 'Create new' (local-device-vault-setup.tsx:464,474) and 'Recover with Google Drive' (google-drive-setup.tsx:158) — are rendered as ghost or unstyled buttons 200-600px further down.

**Design.** Delete the .vault-view__empty card and its button (vault-view.tsx:132-137 and :151-155). The state header from proposal 2 carries the real actions, wired straight through to the provider component's handlers rather than to a slot toggle: for local-device, [Create encrypted Vault] calls beginEnrollment and [Recover with a key] opens the recover disclosure with focus in its textarea; for s3/drive, [Configure connection] sets vaultSetupOpen and scrolls/focuses the first field. Keep onOpenSetup only for the connected 'Edit connection' path in proposal 6, where it has a real effect. Promote the provider panel's real primary to brass (44px) and demote nothing else — the loud button and the working button become the same button.

**Information fate.** No information removed — only a control that never did anything. Its label text ('Complete the crash-safe recovery ceremony below to activate encrypted offline persistence.') is preserved as the local-device caveat line in proposal 2.

### Give the recovery-key ceremony the screen it deserves — today it renders below the fold

- impact **transformative** · effort **medium** · reclaims No reclaim — this one spends pixels deliberately. It converts a 258px panel that is currently 0px visible into a moment the user cannot miss.
- **Files.** src/ui/local-device-vault-setup.tsx, src/ui/local-device-vault-setup.css, src/ui/google-drive-setup.tsx, src/ui/local-lab-setup.tsx, src/ui/focus-trap.ts

**Problem.** Measured at 1440x900: click 'Create new' and .local-device-vault__ceremony appears at y=922 in a main region spanning y=58..900. Zero pixels of the ceremony are visible. There is no scrollIntoView, no focus move, no page-level signal. The only above-the-fold change is the button relabelling itself 'Replace ceremony'. The key itself (57 chars, e.g. airship-wrk-v1.k875TtjtxWUqmau901uyiWEpVE0GjCgeWrvlRf8aMBc) renders as one unbroken mono run with overflow-wrap:anywhere, so it breaks at arbitrary points at narrow widths; there is no copy affordance at all (only 'Download recovery key' and user-select:all); and one click on an 18px checkbox permanently blanks it (local-device-vault-setup.tsx:216). The app's own copy says losing this value means losing the Vault.

**Design.** In local-device-vault-setup.tsx, when ceremony transitions to 'revealed': (a) render the ceremony into a focus-trapped dialog using the existing src/ui/focus-trap.ts, or at minimum scrollIntoView({block:'center'}) + focus the <output> and set a page-level sticky bar 'A one-time recovery key is on screen — save it before leaving' that only clears on acknowledge or cancel; (b) present the key as a fixed prefix line 'airship-wrk-v1.' in muted mono, then the 43-char body in 4-char groups on a tabular-nums monospace grid (11 groups, ~4 per line at phone width) so it is transcribable and visually checksummable; (c) three real actions at 44px — [Copy key] primary, [Download .txt] secondary, [Cancel] quiet; (d) replace the bare acknowledge checkbox with a two-step confirm: a 6-character input labelled 'Type the last 6 characters to confirm you saved it' (validated against the key, never echoed anywhere else), and only then the existing checkbox line, copy unchanged: 'I saved this recovery key outside Airship and understand it cannot be shown again.'

Apply the identical treatment to the two other places a key is revealed: google-drive-setup.tsx:134 <output> and local-lab-setup.tsx:301-312 recovery textarea — one <RecoveryKeyCeremony> component used by all three so the highest-stakes moment looks the same everywhere.

**Information fate.** Nothing removed and one thing added. The warning 'Airship does not upload or persist this value. Losing both it and this browser profile means losing the Vault.' stays verbatim. 'Download recovery key' stays and gains a Copy sibling. The acknowledge copy is unchanged. The 'Recovery key hidden / The recovery value is no longer rendered. Creation is the only remaining step.' second phase stays exactly as-is.

### Merge the two competing fact grids into one Vault Facts table with one vocabulary

- impact **high** · effort **medium** · reclaims 309px → ~190px desktop (−119px) and removes a whole second typographic system; 475px → ~220px on iPhone (−255px)
- **Files.** src/ui/vault-view.tsx, src/ui/vault-view.css, src/ui/local-device-vault-setup.tsx, src/ui/local-device-vault-setup.css

**Problem.** Local Device connected renders two stat grids in two different typographic systems: .vault-view__configuration (6 rows, 2-col, 0.85rem monospace, 204px) and .local-device-vault__readiness (4 cells, 4-col, sans, 105px). Four of the ten cells are the same fact stated twice in different words — 'Storage engine: Origin Private File System' vs 'Backend: OPFS'; 'Retention: Browser managed · backup recommended' vs 'Retention: Browser managed'; 'Synchronization: Device only · offline available' vs 'Offline: Available'; and 'Provider: Local Device' duplicates the provider selector 200px above. S3 connected has the same problem in the other direction: its 7-row 272px dl (475px on phone) is a read-only echo of the form 967px below it.

**Design.** One <VaultFacts> component in vault-view.tsx replacing both grids, fed by both sources. 2-col on desktop/iPad, single-column label-above-value on phone. Each row is 'label · value' with an optional small dot when the value carries posture, and an optional expander when the merged value hides a distinction.

Local Device connected — exactly 6 rows:
· Provider — 'Local Device · OPFS' (merges Provider + Storage engine + Backend; expander note: 'Origin Private File System. IndexedDB is used when OPFS is unavailable.')
· Retention — amber dot, 'Browser managed · backup recommended' (one string, replaces both retention rows; becomes green dot 'Persistent grant' when persistedPermission is granted)
· Reach — 'This device only · offline available' (merges Synchronization + Offline)
· Encryption — green dot, 'AES-256-GCM envelopes · non-extractable key handle'
· Stored — '5.3 KiB of 10 GiB'
· Schema — 'v2' (· migrated from v1 when present)
The eviction warning stays as a full-width caution row under the table, verbatim.

S3/Drive connected — same component, rows: Provider, Endpoint, Bucket + Region (or Workspace + Folder ID for Drive), Opaque namespace, Credential path, Workspace key. Unchanged content, one type system.

**Information fate.** Every value survives. 'Origin Private File System' and 'OPFS' merge into one row and the long form is preserved in the expander. The two Retention strings merge into the longer, more honest one. Synchronization and Offline merge without losing either claim. Usage and Schema keep their exact formatting. The readiness.warning line is unchanged. Nothing is dropped — the count goes from 10 cells to 6 because 4 were duplicates.

### Evidence: one honest summary row that expands to the identical 8-check table

- impact **high** · effort **small** · reclaims 359px → 44px collapsed on desktop (−315px); 603px → ~56px on iPhone (−547px)
- **Files.** src/ui/vault-view.tsx, src/ui/vault-view.css

**Problem.** The verified state spends 359px (603px on iPhone) on a panel whose payload is 'the contract passed'. Measured: 8 readiness rows, 7 reading 'Verified' and 1 reading 'Not evaluated' — 199px of grid to communicate one exception. Beneath it a collapsed <details> holds 16 timing rows (721px expanded) and the immutable-object caveat. On a connected screen already 2449px tall this is the largest block of near-uniform state on the route.

**Design.** Replace vault-view.tsx:173-206 with a 44px summary row that expands to exactly what is there now. Collapsed: a green dot, 'Storage contract · 7 of 8 checks verified', a muted trailing clause '1 not evaluated', a row of 8 tiny dots (7 verified colour, 1 caution) each with a title/aria-label naming its check, and the run id in mono at the right, truncated to 8 chars with the full value on hover/expand. The count is computed, never hardcoded — if all 8 pass it reads '8 of 8 checks verified' with no trailing clause; if any fails it reads 'N of 8 verified · M failed' with a caution dot. Never say 'verified' for a check that was not evaluated.

Expanded: the existing 8-row .vault-view__readiness grid unchanged (rows already measure 44px, keep them), the full run id, the existing 'Probe timings and immutable objects' details with all 16 timings, the cleanup warning and the createdKeys count. Same markup, one level deeper.

**Information fate.** Nothing removed. All 8 named checks and their exact states stay in the expansion, and each is also reachable collapsed via its dot's accessible name. The run id, logical prefix, all 16 timings with ms values, the 'Probe objects are immutable. Configure provider lifecycle expiry or remove the listed keys out-of-band.' warning and the 'N immutable probe object keys are available in the machine-readable evidence.' line all stay verbatim in the expansion. aria-label 'Verified vault capabilities' is preserved on the grid.

### Stop showing a connected vault its own credential form

- impact **high** · effort **small** · reclaims 1157px desktop (47% of the connected page), 1259px iPad, and on iPhone drops the connected S3 route from 3974px (6.3 viewports) toward ~2400px
- **Files.** src/ui/app.tsx, src/ui/vault-view.tsx, src/ui/local-lab-setup.css, src/ui/google-drive-setup.css

**Problem.** With MinIO connected and the contract verified, the page renders the complete 'Connect your loopback S3 lab' form below the connected state — 1157px of a 2449px page (47%) on desktop, 1259px of 2623px on iPad. It repeats the same six facts the read-only table 967px above already shows: endpoint, region, bucket, namespace, access key, secret key. It is shown because changeVaultProvider (app.tsx:3441) sets vaultSetupOpen(next !== 'ephemeral') on every provider change, so a successful auto-connect leaves the editor open. The same happens for Google Drive: a fully working connection still renders 'Connect your Google Drive' underneath it.

**Design.** In app.tsx:5280-5297, when snapshot.phase !== 'disconnected' (or localDeviceStatus is present), wrap the setup slot in a collapsed disclosure: <details class="vault-setup-slot__editor"><summary>Edit connection · S3-compatible / MinIO</summary>. Change changeVaultProvider to set vaultSetupOpen(false) and let the probe result decide — open the editor only when the probe leaves the vault disconnected or degraded. Wire the existing 'Edit configuration' button (vault-view.tsx:249) to set the details open, scroll it into view and focus the first field, so it becomes the one button that opens the editor. Keep the 'Not a production credential path' boundary banner inside the disclosure — it belongs with the credential fields, not with a verified connection.

For Local Device connected the equivalent fix is smaller: 'Open this browser's Vault' and 'Create a new Vault' should not render at all once status is present (local-device-vault-setup.tsx:457 already branches, but the Restore disclosure and the durability articles still sit under a second full header — fold them under the merged panel from proposal 8).

**Information fate.** Nothing removed. Every form field, its helper text, both acknowledgement checkboxes and the 'Handoff validates configuration only…' footnote stay exactly as they are, one click away behind a summary that names what it opens. The 'Not a production credential path' warning moves with the form it guards.

### Delete the second panel header — one route, one heading, one status chip

- impact **high** · effort **small** · reclaims 78px (local-device) / 51px (S3) / 45px (Drive) per panel plus the duplicate-chip confusion; combined with proposal 2 the empty Local Device state goes from 606px-to-first-control down to ~200px
- **Files.** src/ui/local-device-vault-setup.tsx, src/ui/local-lab-setup.tsx, src/ui/google-drive-setup.tsx, src/ui/vault-provider-chooser.tsx, src/ui/vault-view.tsx

**Problem.** Every provider panel opens with its own eyebrow + H2 + summary sentence + status pill, directly beneath the route's eyebrow + H1 + summary sentence + status pill. Measured: 'DEVICE-OWNED DURABILITY / Local Device Vault / Encrypted, offline, and private to this browser profile. / [Not opened]' at 78px, sitting 466px below 'PRIVATE DEVICE STATE / Vault / Encrypted journal and workspace state remain in browser-managed storage on this device and work offline. / [Disconnected]'. The connected state prints two ready chips: 'Encrypted device Vault ready' and 'Ready'. The S3 panel does the same with 'DEVELOPMENT HARNESS / Connect your loopback S3 lab / [Memory only]'; Google Drive with 'RECOMMENDED DURABILITY / Connect your Google Drive / [Browser → Drive]'.

**Design.** Remove the <header> from local-device-vault-setup.tsx:448-455, local-lab-setup.tsx:164-170 and google-drive-setup.tsx:118-121. The provider panel becomes an unheaded continuation of the route, separated by a rule, not a second title block. Each panel's distinguishing chip becomes a small qualifier appended to the state header from proposal 2, where it belongs next to the live state:
· Local Device → the header already names the provider; 'Not opened'/'Ready' merges with the phase dot.
· S3 lab → append a caution qualifier chip 'Memory only' to the Edit-connection summary from proposal 6, and keep 'DEVELOPMENT HARNESS' as the summary's leading eyebrow so the dev-only boundary is still explicit.
· Google Drive → 'Browser → Drive' becomes the first row of the chooser card ('Reaches other devices: Yes'), which is what it was trying to say.
The subtitle sentences ('Encrypted, offline, and private to this browser profile.', 'Airship creates a visible folder in your Drive and stores only client-encrypted manifests and segments. Google never receives the workspace key.') move into the chooser card's expandable 'How this works' note, so they are read at the moment of choice rather than after it.

**Information fate.** Nothing removed. Three eyebrows, three H2s, three subtitle sentences and three chips all keep their exact wording; each moves to the single place on the route where that fact is decision-relevant. 'Google never receives the workspace key' and 'Memory only' are load-bearing honesty claims and both stay visible in the default view, not behind a click.

### Field-anchored validation that does not destroy the form or the recovery key

- impact **high** · effort **medium** · reclaims n/a
- **Files.** src/ui/local-lab-setup.tsx, src/ui/local-lab-setup.css

**Problem.** Reproduced live: set the MinIO endpoint to https://s3.amazonaws.com, generate a recovery key, tick both acknowledgements, submit. Result — all six fields are blanked, the generated one-time recovery key is destroyed, both acknowledgements reset, and a single line 'Local-development vaults require a loopback S3 endpoint.' appears at the bottom of a 3627px page, roughly 2000px below the endpoint field that caused it. No aria-invalid, no field-level message, no focus move, no indication of which of the six fields was wrong. local-lab-setup.tsx:136-145 calls clearForm() inside the catch. The recovery key the user was just told to save is gone. The error box (.local-lab__status--error) is border+currentColor only — no icon, no caution fill, visually indistinguishable from the success variant except by hue.

**Design.** In local-lab-setup.tsx submit(): on a VaultConfigurationError, do not call clearForm(). Keep every field value and the generated recovery material; the existing clearForm() after a successful handoff (line 148) already covers the secret-hygiene case. Add a `fieldErrors: Partial<Record<'endpoint'|'region'|'bucket'|'namespace'|'accessKeyId'|'secretAccessKey'|'recovery', string>>` state, map the coordinator's error codes to fields, set aria-invalid + aria-describedby on the offending input, render the message inline directly under it in caution colour, and focus that input.

Exact mapping and copy for the case reproduced: endpoint → 'Use localhost, 127.0.0.1, or [::1]. This is a loopback-only development lab.' (the existing helper 'Only localhost, 127.0.0.1, or [::1] is accepted. Path-style access is forced.' stays as the neutral hint; the error replaces it while invalid). Keep the summary line at the submit button but restate it as a count that links to the first bad field: 'Fix 1 field to continue — Endpoint'.

Also, while here: replace the three UA <legend> notches ('Loopback object store', 'Disposable local credentials', 'Workspace recovery key' — measured 17px Inter/750 sitting in the fieldset border) with the route's section-header pattern (uppercase mono --fs-caption in brass, inside the panel above the fields), so the form stops looking like an unstyled browser fieldset; and give the currently unheaded .local-lab__acknowledgements block a header 'Before handoff'.

**Information fate.** Nothing removed. Every helper sentence, boundary warning and acknowledgement string is unchanged. The single bottom-of-page error message is not deleted — it is duplicated to the field that caused it and reduced to a pointer at the submit button, so the same words are now readable where the fix happens. The three legend strings become section eyebrows with identical text.

### Bring the Google Drive panel inside the design system and fix its no-client-ID dead end

- impact **high** · effort **medium** · reclaims 267px of dead-end panel becomes a ~150px actionable unavailable state; and the connect panel drops from 589px to ~360px by defaulting to create rather than recover
- **Files.** src/ui/google-drive-setup.css, src/ui/google-drive-setup.tsx, src/ui/vault-provider-chooser.tsx

**Problem.** Two problems in one file. (a) google-drive-setup.css has no `button` rule at all. Measured: the panel's primary action 'Recover with Google Drive' renders as a 26px raw UA grey button; 'Create a new workspace' 26px; the 'Show imported recovery key' checkbox 13px in a 19px hit row — against a standing 44px rule that local-lab-setup.css:137 and vault-view.css:246 both honour. The recovery textarea is 1090px wide × 98px for a 57-char key, in proportional Inter, masked. And a first-time user's default is 'Recover an existing workspace' with a paste-your-key box as the main path and 'Create a new workspace' as a tiny grey afterthought — the onboarding default is inverted. (b) When the build has no VITE_GOOGLE_CLIENT_ID (verified by patching the module in-browser, .aesthetic/shots/vault/F-desktop-gdrive-noclientid.png): the panel still reads 'RECOMMENDED DURABILITY / Connect your Google Drive' and still claims 'Airship creates a visible folder in your Drive…', then renders a role="alert" div with zero alert styling containing a build instruction the user cannot act on, zero buttons, and no way back to another provider. The dead 'Configure vault' button above is the only control on screen.

**Design.** (a) Add to google-drive-setup.css a button rule matching local-lab-setup.css:136-150 — min-height 44px, 0.65rem/1rem padding, brass fill for primary, transparent for --secondary, --quiet variant, and the same focus-visible ring. Set .google-drive-setup__check { min-height: 44px } with an 18px box. Constrain the key field to max-width: 46ch and render the <output> and the import textarea in --font-mono with the same 4-char grouping as proposal 4's shared ceremony component. Flip the default: `recovery` state starts by offering [Create a new workspace] as the brass primary with the folder-name field, and 'I already have a recovery key' becomes a <details> disclosure below containing the paste box.

(b) When clientId is empty, render a distinct unavailable state instead of the connect panel: pill 'Unavailable' (muted, not brass); headline 'Google Drive is not available in this build'; body 'This deployment has no Google OAuth client ID, so Airship cannot open a Drive workspace. Your data is not affected.'; primary 44px button [Choose another provider] which expands the chooser from proposal 1 and focuses the Local Device card; and a <details><summary>For the person deploying Airship</summary> containing the existing sentence verbatim: 'Set VITE_GOOGLE_CLIENT_ID to a Google OAuth Web client ID, enable the Drive API, and allow this page origin.' Suppress the 'RECOMMENDED DURABILITY' eyebrow and the 'Airship creates a visible folder in your Drive…' claim in this state — do not advertise a capability the build does not have. Mark the Google Drive chooser card 'Unavailable in this build' so the dead end is visible before it is entered.

**Information fate.** Nothing removed. Both existing buttons keep their labels and gain the system's sizing. The VITE_GOOGLE_CLIENT_ID instruction is preserved word for word, moved behind a summary aimed at the person who can act on it. 'OAuth tokens remain in page memory. Airship requests drive.file, not access to your whole Drive.' stays visible in every state. 'Airship discovers the app-created folder from the key after Google account selection. A wrong account or key fails closed and never creates a blank replacement.' moves inside the recover disclosure, where it is read at the moment it applies.

### Say the context-fabric state once, and stop calling the restore file input a browser default

- impact **medium** · effort **small** · reclaims 149px → ~96px for the context panel; the restore changes are net-neutral on height and buy correct affordance and colour semantics on the route's only irreversible action
- **Files.** src/ui/vault-view.tsx, src/ui/vault-view.css, src/ui/local-device-vault-setup.tsx, src/ui/local-device-vault-setup.css

**Problem.** Two smaller duplications with high visual cost. (a) .vault-view__context (149px) prints the same fact in two adjacent lines: 'No matching encrypted generation is active. Publishing uploads encrypted derived shards; source plaintext never leaves this browser.' immediately followed, in blue, by 'No matching encrypted generation was found. Turns continue with the on-device index until you publish one.' Plus an eyebrow 'CONTEXT FABRIC' and a bold 'On-device index active' above them — four lines to say one thing and offer one button. (b) The Restore encrypted backup disclosure — an atomic, irreversible replacement of every encrypted object — renders a raw UA `Choose File / No file chosen` control and UA radio buttons, the only unstyled widgets in the connected view, on the most destructive operation on the route.

**Design.** (a) Restructure ContextFabricPanel (vault-view.tsx:258-294) to two lines plus the button: a state line with a dot — 'Context fabric · on-device index' (caution dot) or 'Context fabric · encrypted generation published' (verified dot) — and ONE consequence line, the publication message when present, otherwise the mode sentence. Exact copy for the local-fallback case, replacing both lines: 'Turns use the on-device index. Publishing writes encrypted derived shards; source plaintext never leaves this browser.' For encrypted-ranged, keep the existing sentence verbatim including its fallback caveat. The contextPublicationMessage keeps its own role=status line only when it says something the state line does not.

(b) Style the restore file input as a proper 44px control: hide the native input, present a [Choose backup file…] secondary button plus a filename chip showing name and size once chosen, with the existing 'Maximum 256 MiB. Files are bounded before parsing.' as its helper. Style the two restore-target radios as full-width 44px selectable rows in the same visual language as the provider chooser cards, keeping both titles and both sub-captions verbatim. Give the destructive confirm a caution treatment: caution border on the acknowledgement row and a caution-filled [Verify and restore] button rather than brass, so a destructive action does not wear the same colour as [Publish encrypted index].

**Information fate.** Nothing removed. (a) The two duplicate sentences merge into one that carries both claims — 'turns continue on the on-device index' and 'source plaintext never leaves this browser'. The 'CONTEXT FABRIC' eyebrow becomes the state line's leading label. Publish/Update button labels unchanged. (b) Every restore string is kept verbatim: 'Verified atomic replacement', the two radio titles and captions, the 256 MiB bound, and the acknowledgement 'I understand a successful restore atomically replaces every encrypted object in the selected Local Device Vault.'

### Make the phone layout stop stacking every fact as a full-width row

- impact **medium** · effort **medium** · reclaims Connected S3 on iPhone: 3974px → roughly 1300px (2.1 viewports) once combined with proposals 5, 6 and 7; Local Device empty: first real control moves from off-screen to ~y=260
- **Files.** src/ui/vault-view.css, src/ui/local-device-vault-setup.css, src/ui/vault-provider-chooser.css, src/ui/local-lab-setup.css

**Problem.** iPhone 14 Pro Max, main scroll window 632px. Connected S3 scrolls 3974px — 6.3 viewports. The breakpoints at vault-view.css:269 and local-device-vault-setup.css:307 collapse every grid to a single column, so the 7-row configuration table becomes 475px, the evidence grid 603px, and the header block 196px (34px H1 plus a three-line paragraph). The provider selector alone costs 115px to show one collapsed value. The Local Device empty state puts 596px of restatement in front of a 632px window, so the first screen contains zero controls other than the dead brass button.

**Design.** Phone-specific rules once proposals 1-6 land. (a) Fact rows become two-column label-left/value-right at 34px each rather than stacked label-over-value at 68px — the values (OPFS, us-east-1, airship-dev, v2) are short; only Endpoint, Namespace and Encryption need to wrap, and those get a full-width variant via a `data-long` attribute. 6 rows ≈ 220px instead of 475px. (b) The chooser cards stack but the fact matrix inside each card collapses to a 3-icon summary strip (durable / offline / multi-device) with the full matrix behind a 'Compare all' expander that opens all four cards' matrices in one scrollable comparison. (c) The evidence summary row (proposal 6) wraps its dots to a second line rather than stacking. (d) Add a sticky 44px status strip at the top of the scroll region when scrolled past the state header: '[dot] Local Device · encrypted and offline' — so the route's answer to 'where is my data' is always on screen while reading 2000px of configuration. (e) Raise the Local Device button min-height from 40px (local-device-vault-setup.css:85) to 44px to match the rest of the route.

**Information fate.** Nothing removed. The 2-column fact rows show identical labels and values; long values keep a full-width row so nothing truncates. The chooser's full comparison matrix is one tap away and shows all four providers at once, which is more comparable than today's dropdown. The sticky strip is additive.


---

## Memory and Context — the #memory route (federated Search lanes, Typed relationship graph, Local index)

**Diagnosis.**

MEASURED, NOT INFERRED. Captures and geometry in .aesthetic/memory/ (measure.mjs, populate2.mjs, wsq.mjs, audit.mjs). Populated with a real connected Chutes turn (GLM-5.2-TEE) that wrote a profile memory and read two workspace files, then searched "retrieval" and "workspace".

VERTICAL BUDGET. Desktop 1440x900: topbar 58px, route content region 842px. `.memory-hero` is 220px (page-heading 128 + query block 156 + jump nav 44, overlapping in a 2-col grid), then `.memory-federated > header` adds another 104px. The first result pixel is at y=430 — 372px, 44% of the content region and 48% of the raw viewport, is chrome before any recall. iPad Pro 11: 418/1136 = 37%. iPhone 14 Pro Max: 510/632 = 81% — a phone user scrolls ~1.3 viewports to reach the first result. Whole route with the Index open is 3051–3349px = 3.6–4.0 desktop viewports, 4.11 phone viewports.

DEAD SPACE. Empty state, desktop: three lanes at 229px each containing three 20px lines of "Enter a query." — 97% blank, and the same sentence three times. iPad: those three stacked cards are 707px, 59% of the viewport, all empty. Populated (3 conversation + 1 profile + 0 workspace hits): lanes are locked to equal 527px heights; used content is roughly 525/242/107 → 45% of the results region is blank, and the empty Workspace lane is an 80%-empty 527px box holding one sentence. The graph's `.memory-detail` inspector is a 587px-tall "Select an idea" placeholder on every load. The `#memory-relationships` summary sits at y=674, so the graph itself is below the fold on a 900px screen.

REPEATED FACTS. Three sentences say one thing across 380px: hero para "One private query across conversation, profile memory, workspace index, and typed relationships.", field helper "Updates every loaded scope. Each corpus keeps its own scores.", and section para "The agent and interface share one revision-checked service; each corpus keeps independent scores." The jump nav ("Recall / Relationships / Local index") restates the three section titles directly beneath it. Machine-measured on one screen: the generation digest `sha256:pxi6ho7JxBqq…` printed 3x, README's content digest 2x, a session UUID 2x, "No matches in this scope." 2x. 11.5% of all visible text on the route (680 of 5,931 chars) is raw digests and UUIDs. 68 monospace leaf tokens on one route.

INFORMATION ALREADY BEING DROPPED — this is the sharpest finding. The route claims to never hide, but the search lanes silently discard fields the search service already computed: thread hits carry `recordedAt`, `sequence`, `eventId`, `textDigest` and the UI shows none of them; profile hits carry `createdAt`, `profileRevisionAtCreation`, `createdInSessionId` and the UI shows none; every group carries a `ranking` contract string ("hybrid score within this corpus only; never comparable across groups") plus `legacyQuarantined`, `duplicatesSuppressed` and a full `lineage` object — none rendered. Worse, memory-view.css:512 sets `.memory-summary-meta { font-size: 0 }` below 620px, so "647 relationships" and "3 workspace sources" are literally deleted on phone. And there is NO path from a result to its source: a hit is `<article><strong>eventType</strong><p>text</p><small>digest</small></article>` with no link, no button, no way to open the message or the file.

GRAPH. After one turn: 189 nodes, 799 edges — but 173 of the 189 (92%) are derived `term` nodes rendered as unlabelled grey hollow dots. The 16 real entities (1 session, 3 messages, 3 files, 3 profiles, 6 skills) are buried in a hairball. The amber `.memory-boundary.attention` shouts "1,056 source/derived items exceeded bounds" in the completely default state. Selecting a node is genuinely excellent — the brass neighbourhood highlight is the best moment on the route — but nothing invites the click, and the inspector's metadata `dl` renders "documentCoun2" because the dt column is too narrow and collides with its dd.

INDEX. 470px of preamble (embedding card 175 + 5-metric strip 92 + "Shared Memory query / Waiting for a query above" 76 + "Shared runtime." note 60 + gaps) before the first candidate. Three 100-byte markdown files consume 531px of candidate cards, each printing a raw revision UUID and a 51-char sha256 in full. One search hit is 627px tall.

HYGIENE. 21 interactive targets below 44px on this route alone (jump nav 42, graph match chips 28, legend 32, embedding toggle 34, chunk-id summaries 28, relationship rows 38). The search placeholder clips on both tablet ("…workspace, relationsh") and phone ("…workspace, relatic"). The phone has two clear affordances side by side (native ✕ plus a 58px "Clear" button). A raw session UUID wraps to two lines inside a pill, pushing the lane header from 77px to 91px. The phone jump nav clips "Relationships 15…" and pushes "Local index" off-screen entirely.

The route is not over-informed. It is under-designed and, in several measurable places, already under-informed.

### Fuse hero, jump nav and section header into one Memory bar

- impact **transformative** · effort **medium** · reclaims desktop 372→~100 (272px, 32% of the content region); tablet 418→~110; phone 510→~104 (406px, 64% of the phone content region)
- **Files.** src/ui/memory-view.tsx, src/ui/memory-view.css

**Problem.** 372px of desktop chrome (44% of the content region), 510px on phone (81%), stands between arriving and the first result. Inside it, three different sentences state the same fact, and the jump nav restates the three section titles that appear immediately below it. On phone there is also ~135px of pure dead gap between the hero paragraph and the search label, caused by `.memory-query { align-content: center }` in a stacked grid.

**Design.** Replace `.memory-hero` (memory-view.tsx:130-162) and the `<header>` of `FederatedMemorySearch` (memory-view.tsx:293-296) with a single `MemoryBar` component, sticky to the top of the route scroller.

Row 1 (56px): `Memory` as the H1 at `--fs-h2` (not the current display-serif H1), a `Private · on-device` pill, then the search field flexed to fill. Field `min-height: 48px`, placeholder shortened to `Search memory` so it never clips at 430px. Right edge of the field carries a live state dot + one word (`ready` / `searching` / `pinned`) which is the `role="status" aria-live="polite"` node.

Row 2 (44px): a scope rail replacing the jump nav — four 44px buttons `Conversation 3` / `Profile 1` / `Workspace 0` / `Graph 7`, each anchoring AND filtering. Counts come from the same values the jump nav shows today.

An `(i)` button (44px) at the end of row 1 opens a small popover, `Memory searches four surfaces`, whose body carries the retired sentences verbatim.

Desktop total: 220 + 104 → ~100px. Phone: 307 + 170 → ~104px.

**Information fate.** "Private recall & on-device retrieval" eyebrow → becomes the `Private · on-device` pill, full phrase as its tooltip and `aria-label`. "One private query across conversation, profile memory, workspace index, and typed relationships." → line 1 of the (i) popover, and the search field's `aria-describedby`. "Search every memory surface" label → the field's visually-hidden `<label>`. "Updates every loaded scope. Each corpus keeps its own scores." → line 2 of the popover. "Federated client recall" / "Results across private scopes" → the results region's `aria-labelledby` heading, visually hidden; the scope rail is the visible label. "The agent and interface share one revision-checked service; each corpus keeps independent scores." → line 3 of the popover, verbatim. "Search complete · results pinned to reported revisions." and every other `memory-search-status` string → the field's state word; the full sentence renders on hover/focus and stays in the live region for screen readers. Jump-nav counts (3 private scopes / 152 nodes / 3 sources) → merge into the scope rail counts; `152 nodes` moves to the `Graph` chip.

### Let result lanes size to their content; collapse an empty scope to one honest row

- impact **high** · effort **small** · reclaims empty desktop 229→0; populated desktop ~707px of blank column removed; tablet empty 707→~132; phone empty 593→~132
- **Files.** src/ui/memory-view.css, src/ui/memory-view.tsx, src/ui/styles.css

**Problem.** `.memory-result-lane > div` has `min-height: 150px` (112px on mobile) and the three lanes are locked to equal heights by the grid. Empty state: 229px x 3 columns, 97% blank, printing "Enter a query." three times. Populated: 527px x 3, 45% blank, with the 0-result Workspace lane an 80%-empty 527px box holding one sentence.

**Design.** In memory-view.css add `align-items: start` to `.memory-result-lanes` and drop the `min-height` floors at lines 164-171 and 464-471. Change the desktop grid to `repeat(auto-fit, minmax(320px, 1fr))` so a single populated scope can use the full width when the others collapse.

Give `MemorySearchLane` (memory-view.tsx:310) a third render state. When `count === 0` and a query is present, the lane renders as a single 44px row rather than a card body: a muted dot, `No matches · Workspace & sources`, and the lane's provenance chip — and it stays a `<button aria-expanded>` whose expansion shows exactly what was searched.

Expansion copy, workspace example: "Searched the hybrid workspace index at generation eA3WGuvU — 3 sources, 3 chunks, 0.32 ms. Ranking: hybrid score within this corpus only; never comparable across groups. Nothing was filtered out."

When `count === 0` for a scope and the query is empty, the lane renders only its 44px header — no body, no placeholder.

**Information fate.** "Enter a query." x3 → deleted as a repeated string; the single empty-route state is handled by the bar's `ready` status and one line under the scope rail. "No matches in this scope." → becomes the collapsed row label, prefixed with the scope name so the sentence is no longer ambiguous when read alone. Count badges, scope pill and freshness pill → move to the 44px header (see the lane-header proposal). Nothing about which corpus was consulted is lost; more is stated than today, because the expansion names the generation, the corpus size and the ranking rule.

### Give every result a destination and restore the fields the card silently drops

- impact **transformative** · effort **medium** · reclaims card heights roughly unchanged (183/165/145 → ~150 collapsed) but every card becomes actionable; the 45% blank results region is spent on affordance instead of padding
- **Files.** src/ui/memory-view.tsx, src/ui/memory-view.css, src/ui/app.tsx, src/ui/styles.css

**Problem.** A result is `<article><strong>{eventType}</strong><p>{text.slice(0,320)}</p><small>{digest.slice(0,20)}…</small></article>` (memory-view.tsx:298-300). There is no link, no button, no way to reach the message, the memory record or the file. The primary label is a machine token ("assistant.completed"). Text is hard-cut at 320 chars mid-sentence with no ellipsis and no expander. And `recordedAt`, `sequence`, `eventId`, `textDigest`, `createdAt`, `profileRevisionAtCreation`, `createdInSessionId`, `denseScore`, `lexicalScore` are all computed by searchFederatedMemory and then thrown away by the view.

**Design.** New `MemoryHit` component in memory-view.tsx.

Header row (44px): a kind glyph reusing `KIND_VISUAL` colours, a human title, a `<time>`, and a right-aligned 44px open button.
- Conversation, user event → title `You asked`; assistant event → `Airship replied`. Time renders relative (`12 min ago`) with the ISO value in `datetime`. Button `Open in chat` → navigate `#chat/{authority.sessionId}` and scroll/highlight `eventId`.
- Profile → title is `hit.source` (e.g. `user preference`), or `Explicit memory` when absent. Button `Open profile memory`.
- Workspace → title is the basename, dimmed directory prefix; button `Open in editor`, calling the existing `openFile(path)` at src/ui/app.tsx:2879 (already wired to EditorView at :5180) then `navigate("editor")`.

Body: matched text with the query terms wrapped in `<mark>`, clamped to 4 lines. When the text was bounded, a 44px `Show the full record (2,140 chars)` button; today the 320-char cut is invisible and irreversible.

Footer: one provenance chip (next proposal).

This needs one new prop: `onOpenSource?: (target: { kind: "message" | "memory" | "file"; sessionId?: string; eventId?: string; path?: string }) => void` on `MemoryViewProps`, wired at src/ui/app.tsx:5197.

**Information fate.** `eventType` ("assistant.completed") → replaced as the visible title by human copy; the raw token survives verbatim inside the provenance expansion as `event type · assistant.completed`. Truncated `eventDigest`/`contentDigest` `<small>` → moves into the provenance chip at full length with a copy button. `hit.path` in the workspace lane → stays as the title AND becomes the open target. NEW information now shown that is currently dropped: `recordedAt` (as the visible time), `sequence`, `eventId`, `textDigest`, `createdAt`, `profileRevisionAtCreation`, `createdInSessionId`, `denseScore`/`lexicalScore` — all in the provenance expansion. Nothing leaves the screen; the card gains a destination and five fields.

### One Provenance chip, deduplicated — replace 68 scattered monospace tokens

- impact **transformative** · effort **medium** · reclaims ~11.5% of visible route text withdrawn from the default layer; per-hit exact-record blocks 40+40+63px → one 44px chip; Index lineage stays but stops being repeated
- **Files.** src/ui/provenance-chip.tsx, src/ui/memory-view.tsx, src/ui/context-view.tsx, src/ui/memory-view.css, src/ui/context-view.css

**Problem.** Measured on a single populated screen: 68 monospace leaf tokens; 680 of 5,931 visible characters (11.5%) are raw digests and UUIDs; the generation digest `sha256:pxi6ho7JxBqq…` is printed three separate times (the shared-query status line, the per-hit query lineage, and the Index lineage panel); README's content digest twice; a session UUID twice. The lineage is genuinely valuable and must survive — it is just being shouted rather than filed.

**Design.** New shared component `src/ui/provenance-chip.tsx`.

Collapsed: a 44px `<button aria-expanded>` reading `⛓ eA3WGuvU` — the 8-char tail only, with the full value in `title`. Tone follows the truth palette already in use.

Expanded: a `<dl>` where every row is `label / value / 44px copy button`. Digests render as `sha256:…eA3WGuvU` with the full string in `title` and on copy. Rows use `grid-template-columns: minmax(0, 14ch) minmax(0, 1fr) 44px` with `overflow-wrap: anywhere` so no label ever collides with its value.

Dedup rule, the important part: a chip never restates a digest already asserted by its enclosing scope. A hit inside the Workspace lane renders `Generation · same as this scope (eA3WGuvU)` as a link that scrolls to and flashes the lane's own chip. That single rule removes the 3x and 2x repeats measured above.

Use it in five places: each lane header, each result card, each index candidate row, each index search hit, and the Index lineage panel (which becomes the canonical, always-expandable owner of the generation-level fields).

**Information fate.** Everything currently printed raw stays reachable, in exactly one canonical place plus back-references: `revision`, `contentDigest`, `chunkId`, `chunkIds[]`, `eventDigest`, `textDigest`, `queryDigest`, `generationDigest`, `workspaceSnapshotDigest`, `completedAt`, `sequence`, `embeddingProvider` + dimensions, `extractor` + per-file ceiling, `chunker` + chars + overlap, `indexFormat`, `scoring`, `createdAt`, `retention` ("Page memory only · discarded on teardown · no credential or persistent index state" survives verbatim as the Retention row). The `.callout` "Recall follows the selected storage mode" paragraph (71px desktop, 125px phone) moves into the Workspace lane chip's expansion, verbatim. Nothing is deleted; digests stop being decoration and become copyable evidence.

### Lane headers: 44px, no raw UUIDs, and surface the ranking contract that is currently computed and never shown

- impact **high** · effort **small** · reclaims header 77–91 → 44 per lane (99–141px per screen), and the raw-UUID wrap that inflates it disappears
- **Files.** src/ui/memory-view.tsx, src/ui/styles.css, src/ui/memory-view.css

**Problem.** The lane header is 77px, growing to 91px when the session UUID wraps to two lines inside a pill; on phone `journal revision` also wraps. It prints a raw 36-char UUID as a primary metadata pill, which tells a human nothing. Meanwhile the search service computes and returns `ranking`, `legacyQuarantined`, `duplicatesSuppressed` and a full `lineage` object per group — and memory-view.tsx renders none of them. Those strings are the honest "scores are not comparable across scopes" claim, and they are invisible.

**Design.** Rewrite `MemorySearchLane`'s header (memory-view.tsx:311) as one 44px flex row: kind dot, scope name, count, and the provenance chip pinned right. Delete the two `<span>` mono pills.

The chip's expansion becomes the lane's honesty panel and carries the group's own metadata verbatim:
- Conversation: "Ranked reverse-chronologically by lexical match. Scores are not comparable to other scopes." then rows `Session`, `Journal revision`, `Events searched`.
- Profile: "Bounded BM25 relevance, recency-tiebroken; within this corpus only." then `Profile`, `Profile revision`, and — when `legacyQuarantined > 0` — a caution row "N legacy records are quarantined and were not searched."
- Workspace: "Hybrid score within this corpus only; never comparable across groups." then `Generation`, `Workspace snapshot`, `Completed`, `Duration`, and — when `duplicatesSuppressed > 0` — "N duplicate chunks suppressed."

This is the one place where the route should get *more* verbose, because it is the claim that makes three separate lanes correct rather than arbitrary.

**Information fate.** Scope pill (`current session` / raw UUID / `pinned profile` / `general` / `hybrid workspace index`) → becomes a chip row with the full value, copyable. Freshness pill (`journal revision` / `revision SnkCnLUk` / `generation bH9mYq3w`) → becomes a chip row with the full untruncated digest. Count badge → stays, inline in the 44px row. NEW, currently dropped entirely: `groups[n].ranking`, `groups[1].legacyQuarantined`, `groups[2].duplicatesSuppressed`, `groups[n].lineage`, `groups[2].durationMs`, `groups[2].completedAt`, `groups[2].workspaceSnapshotDigest`.

### Graph: hide derived terms by default so the 16 real ideas become visible

- impact **transformative** · effort **medium** · reclaims no height change — this converts a 470px illegible canvas into a legible one, and fixes 3 of the 21 sub-44px targets
- **Files.** src/ui/memory-view.tsx, src/ui/memory-controls.tsx, src/memory-graph/renderer.tsx, src/memory-graph/canvas-renderer.tsx, src/ui/styles.css

**Problem.** After one turn the graph is 189 nodes and 799 edges, and 173 of those nodes (92%) are derived `term` nodes drawn as unlabelled grey hollow dots. The 1 session, 3 messages, 3 workspace files, 3 profiles and 6 skills — the things a person came to see — are buried inside a grey hairball. Searching for "retrieval" produces 7 match chips but the canvas does not change at all, so the query appears to do nothing to the picture. Selecting a node is superb (brass neighbourhood highlight, labelled spokes) but nothing invites the first click.

**Design.** Initialise `hiddenMemoryKinds` (memory-view.tsx:51) to `new Set(["term"])`. The canvas then opens showing 16 labelled entities in a legible layout instead of a blob.

The legend chip for terms reads `term 173 · hidden` and remains a one-click toggle; add a single line under the canvas on first view: "173 derived terms are hidden from the picture. They are still in the graph, still searchable, and still counted above."

Pass `matchedNodeIds` from `graphResults` into `MemoryGraphRenderer` so all query matches glow at once (and auto-reveal their kind if hidden) without requiring a click. Relabel the chip row `7 matches — select one to focus`.

Fix the inspector metadata `dl` (memory-view.tsx:210), which currently renders "documentCoun2" because the dt column is too narrow: `grid-template-columns: minmax(0, 13ch) minmax(0, 1fr)` with `overflow-wrap: anywhere`.

Raise `.memory-graph-query button` from 28px and `.memory-legend button` from 32px (src/ui/styles.css:265) to 44px, and `.relationship-list button` from 38px to 44px.

**Information fate.** All 173 term nodes stay in the graph object, stay counted in the Nodes metric, stay searchable, and stay one legend click away — the picture is filtered, the memory is not. `graph.stats.nodesByKind` counts stay on the legend. The existing rule "Filters never alter memory." moves out of the bounds banner and becomes the legend group's help line, which is where filtering actually happens. Node metadata (`term`, `termType`, `occurrences`, `documentCount`, `normalization`, `lineage`) all stay, now legible.

### Turn the graph's 587px "Select an idea" placeholder into a live overview, and stop the bounds banner shouting

- impact **high** · effort **medium** · reclaims metrics 91→44 desktop and 180–191→44 on tablet/phone; ~310px of inspector dead space becomes a functional launcher
- **Files.** src/ui/memory-view.tsx, src/ui/memory-view.css, src/ui/styles.css

**Problem.** `.memory-detail` is a 587px-tall panel that reads "Select an idea" on every single load — roughly 590x310px of visible dead space beside the canvas at 1440x900. Separately, four `.metric` cards (91px desktop, 180–191px when they go 2x2 on tablet and phone) sit above the canvas, one of which is "Density 0.045 / not vector similarity" — a debug statistic given the same visual weight as everything else. And the amber `.memory-boundary.attention` announces "1,056 source/derived items exceeded bounds" in the completely default state, which reads as a failure when nothing has failed.

**Design.** Inspector empty state becomes an overview, not a placeholder. Heading `This graph`, then: the four stats as a compact 2x2 (moved out of the metric cards), the kind breakdown, and `Most connected` — the top 5 nodes by degree as 44px buttons that select on click. The panel becomes the launcher for the interaction it is currently only describing.

The four `.metric` cards collapse into one 44px status row above the canvas: `189 ideas · 799 links · 1 cluster · 1,056 beyond the view bound`, expandable to the four cards verbatim.

Retone `.memory-boundary`: neutral by default, and reword to "Showing 189 of 1,245 items — this view is bounded on purpose." Reserve `--v-caution` for when the *user* has hidden something (`hiddenMemoryNodeIds.size > 0`), where amber is actually informative.

**Information fate.** "Select an idea / Pan, zoom, search, or select a node to inspect relationships and source metadata." → survives as the overview panel's one-line footer. All four metrics stay: Nodes "real page inputs + derived terms", Relationships "typed, bounded edges", Components "current relationship islands", Density "not vector similarity" — verbatim, in the status row's expansion and in the overview panel. `isolatedNodeCount`, `maxDegree`, `hiddenMemoryNodeIds.size` and the truncation total all stay in the bounds row (expanded). "Filters never alter memory." relocates to the legend. `rev {graph.revision}` moves into the bounds row's expansion.

### Index: replace 470px of preamble with one 56px status row

- impact **high** · effort **medium** · reclaims 470→56 (414px) at every breakpoint; on phone this is roughly two-thirds of a viewport
- **Files.** src/ui/context-view.tsx, src/ui/context-view.css, src/ui/memory-view.css

**Problem.** Measured from the top of the Index disclosure body to the first candidate: `.embedding-engine-card` 175px (an eyebrow, an H2, and a three-line paragraph about hash vectors) + `.context-live-strip` 92px (five metric cards) + `.context-managed-search` 76px ("SHARED MEMORY QUERY / Waiting for a query above" — restating the field 1,600px above it) + `.context-injection-disclosure` 60px + gaps ≈ 470px. The panel also stacks five separate eyebrow + heading pairs ("Revision-bound local materialization", "Private embedding engine", "Automatic discovery", "Generation-pinned retrieval", "Rebuildable local materialization") before showing a single indexed file.

**Design.** One 56px `Index status` row at the top of the embedded ContextView:
`● Searchable · 3 sources · 3 chunks · 4.5 KiB · bootstrap embeddings` on the left, the `[Bootstrap | Local semantic]` segmented control (raised to 44px from its current 34px) on the right, and — when a shared query is running — the result sentence inline: `1 result sealed to eA3WGuvU`.

The row is a `<button aria-expanded>`. Expanded, it shows exactly the five `ContextMetric` cards that exist today, unchanged, plus the embedding-mode paragraph and the shared-runtime note.

Delete the `.context-managed-search` block entirely — it exists only to say the field above is being followed, which the status row now says in four words.

Drop the redundant eyebrows: the disclosure summary already says "Revision-bound local materialization". Inside it, `Vectorization candidates` and `Search hits` become plain 44px column headers with their counts.

**Information fate.** All five metrics stay verbatim in the expansion: State ("memory-only" / "staging privately"), Candidates ("1.0 KiB indexed"), Chunks ("3 documents"), Refresh ("0.77 ms indexing"), Vector memory ("384 dimensions"), including their tone states. Both embedding paragraphs stay verbatim as the expansion of the mode toggle — the bootstrap caveat "deterministic test/bootstrap signals, not semantic understanding" is exactly the kind of honesty that must not be lost, so it also becomes the toggle's `title` and is promoted to a visible caution line whenever the mode is bootstrap AND a search has returned hits. `embeddingStatus()`/`semanticTone()` output ⇒ the status row's dot and label. "Shared runtime. This screen, the search_context tool, and automatic turn grounding use the same memory-only generation…" → expansion, verbatim. `managedSearchStatusText()` strings → the inline sentence in the row, unchanged. Refresh/error banners stay where they are.

### Index candidates: a source table, not three digest cards

- impact **high** · effort **small** · reclaims 177px per file → 44px collapsed; 531→132 for the seeded workspace, and the saving scales linearly with real workspaces
- **Files.** src/ui/context-view.tsx, src/ui/context-view.css

**Problem.** Three markdown files totalling 1,025 bytes consume 531px of stacked cards (177+177+176). Each card prints, at full length and unprompted, a 36-char revision UUID and a 51-char sha256 content digest, plus a `<details>` whose 28px summary reads "1 exact chunk identifier". The reason line for every healthy file is the same seven words, "Indexed on this device.", repeated once per row.

**Design.** Replace `.context-candidate-list` (context-view.tsx:233-254) with a table of 44px rows: `status dot · path · text/markdown · 108 B · 1 chunk · [provenance chip]`. Sort so anything not `indexed` floats to the top.

Rows whose status is `failed`, `too-large` or `unsupported` render expanded by default with their `candidate.reason` inline and a caution dot — those are the rows a person actually needs, and they are currently formatted identically to the healthy ones.

The healthy row's expansion carries `reason`, `revision`, `contentDigest` and the full `chunkIds` list, each with a copy button. The chunk-id `<details>` disappears as a separate control; it becomes a section of the one expansion.

**Information fate.** `status`, `path`, `contentType`, `size`, `chunks` → stay in the 44px row. `reason` → row expansion for healthy files, inline for degraded ones. `revision`, `contentDigest`, `chunkIds[]` → the provenance chip, full length, copyable, deduped against the Index lineage panel. `candidateSummary()` ("3 indexed · 0 excluded") → stays as the column header count. The "Recall reduced · N sources could not be indexed" alert stays exactly where it is.

### Index search hits: 627px per hit → ~180px, with the best sentence on the route promoted

- impact **high** · effort **medium** · reclaims 627→~180 collapsed per hit; at the default limit of 8 hits that is ~3,500px, roughly four desktop viewports
- **Files.** src/ui/context-view.tsx, src/ui/context-view.css, src/ui/provenance-chip.tsx

**Problem.** One workspace hit measured 627px tall: rank + path + `chunk 0 · hybrid 0.168`, then the entire chunk text unclamped (~330px for an 845-byte file, and chunks run to 1,200 chars), then a `Document source / …matched… / 844 B retrieved` row, then a 3-cell dense/lexical/combined grid, then a 3-row exact-record `dl`, then a separate 3-row query-lineage `dl`. Meanwhile `whyMatched()` — "Matched the query's broader meaning in this local index." — is the single best piece of copy anywhere on the route and it is buried in the middle, styled as metadata.

**Design.** Rework `.context-hit` (context-view.tsx:267-282).

Header (44px): rank, basename with dimmed directory, `chunk 0`, `hybrid 0.168`, and a 44px `Open in editor` button (same `openFile` wiring as the search-lane cards).

Subhead: the `whyMatched()` sentence promoted to `--fs-caption` in `--ink`, with `humanKind()` as a leading chip — `Document source · Matched the query's broader meaning in this local index.`

Body: chunk text clamped to 6 lines with `Show the whole chunk (845 B)` as a 44px expander. Query terms wrapped in `<mark>`.

Footer: one provenance chip.

The standalone `.context-query-lineage` block after the hit list disappears as a separate element — its three rows fold into the Index lineage panel, which is where generation-scoped facts belong.

**Information fate.** `denseScore` and `lexicalScore` → the provenance expansion as a labelled pair (`Dense 0.194 · Lexical 0.103 · Combined 0.168`), with the split rule "72% deterministic dense score · 28% lexical overlap" carried alongside them — currently that rule only appears on the standalone Context route's label and is invisible in the embedded view. `whyMatched()` → promoted, unchanged. `humanKind()` → leading chip. "844 B retrieved" → header chip. `revision` / `contentDigest` / `chunkId` → provenance chip, full length. `queryDigest` / `generationDigest` / `completedAt` → the Index lineage panel, stated once instead of once per hit. Full chunk text → always reachable via the expander; nothing is silently cut.

### Stop deleting information at the phone breakpoint, and fix the 21 sub-44px targets

- impact **high** · effort **small** · reclaims restores two facts currently deleted on phone; brings 21 controls to 44px; returns ~64px of field width on a 430px screen
- **Files.** src/ui/memory-view.css, src/ui/memory-view.tsx, src/ui/styles.css, src/ui/context-view.css

**Problem.** memory-view.css:512 sets `.memory-summary-meta { font-size: 0 }` below 620px. That does not compress the fact — it deletes it. On phone the disclosure headers no longer say "647 relationships" or "3 workspace sources" at all. That is the one thing this route is not allowed to do, and it is shipping. Alongside it: 21 interactive targets on this route measure under 44px (jump nav 42, graph match chips 28, legend 32, embedding toggle 34, chunk-id summaries 28, relationship rows 38). The search placeholder clips on both tablet ("…workspace, relationsh") and phone ("…workspace, relatic"). The phone shows two clear affordances side by side — the native `type=search` ✕ and a separate 58px "Clear" button. A raw session UUID wraps to two lines inside a pill, inflating the lane header from 77px to 91px. And the phone jump nav clips "Relationships 15…" with "Local index" pushed off-screen entirely.

**Design.** Delete the `font-size: 0` rule. Render the disclosure meta on phone as a compact count badge next to the chevron: `647` with `aria-label="647 relationships"`, and the full phrase in the expanded panel header. If space is genuinely unavailable, abbreviate the unit — never the number.

Raise every listed control to `min-height: 44px`. The graph match chips and legend chips gain `padding: 10px 12px`; the relationship rows in the inspector gain `min-height: 44px`.

Remove the bespoke `Clear` button (memory-view.tsx:153) and keep a single 44x44 icon button, which returns 64px of text width to the field on phone. Shorten the placeholder to `Search memory` (the long enumeration moves to `aria-describedby` and the (i) popover, per the Memory bar proposal), which fixes the clipping at 834px and 430px.

Never print a raw session UUID as a pill — handled by the lane-header proposal.

The jump nav is replaced by the scope rail in the Memory bar proposal; at 430px it becomes four equal 44px cells that fit without horizontal scroll because the labels shorten to `Chat / Profile / Files / Graph` with full names in `aria-label`.

**Information fate.** "647 relationships" / "3 workspace sources" → restored on phone as a numeric badge plus an accessible full label, and repeated in full inside the opened panel. Placeholder enumeration "Search conversation, profile, workspace, relationships, and index…" → the field's `aria-describedby` text and line 1 of the (i) popover, verbatim. Jump-nav labels → full names retained in `aria-label` and in the section headings they anchor to. Nothing is dropped; the phone stops being the breakpoint where honesty is quietly traded for space.

### A single, specific zero-result state instead of three vague ones

- impact **medium** · effort **small** · reclaims 687→~200 desktop; ~600→~230 on phone, and the state finally earns its space
- **Files.** src/ui/memory-view.tsx, src/ui/memory-view.css

**Problem.** Searching for something absent produces "No matches in this scope." printed three times in three 229px boxes — 687px of screen telling the user nothing about what was actually searched. The route's whole argument is that it never hides anything, and its zero state is the one moment where that argument most needs to be made and is instead silent. On phone this state also inflates the first lane header to 91px because the session UUID wraps.

**Design.** When all three lane counts are 0 and a query is present, replace the three lane bodies with one panel inside the results region:

Heading: `No memory matched "zzzqqq"`
Body, one line per scope, each ending in that scope's provenance chip:
- `Conversation — searched 4 journal events in this session.`
- `Active profile memory — searched 1 record at profile revision SnkCnLUk.`
- `Workspace & sources — searched 3 chunks across 3 sources at generation bH9mYq3w.`
Then: `Nothing was hidden, filtered, or ranked away.`

When `graphResults.length > 0` the panel ends with an action rather than a dead end: `But the relationship graph has 7 matches — show them` (a 44px button that expands the graph disclosure and focuses the first match). Today the graph quietly has matches while the results region says nothing was found, which reads as a contradiction.

The three lane headers stay above the panel at 44px each so the scope structure and counts are never lost.

**Information fate.** "No matches in this scope." x3 → becomes one heading plus three specific per-scope sentences that state strictly more than the original. Each lane's count badge, scope and freshness metadata stay in the 44px headers and their provenance chips. The graph-match count, currently only discoverable by scrolling past the empty lanes to the disclosure summary, is surfaced at the moment of failure.


---

## Proof route (#proof — "Receipt & journal" + "Attestation evidence") and the trust indicators wherever they appear

**Diagnosis.**

VERIFIED LIVE, NOT FROM SOURCE. I connected Chutes with the supplied key (API-key lane → Discover → Qwen/Qwen3-32B-TEE → Finish), sent one real turn, and captured 1440x900 / 834x1194 / 430x932. Screenshots at /tmp/ap/shots/ (M-chat-bottom.png, M-proof-via-sidebar.png, M-att-populated.png, M-ipad-att.png, M-iphone-att.png, P-audit-findings.png, M-claims-open-1.png).

THE CONTRADICTION IS STILL TRUE AND IT IS WORSE THAN SIX LABELS. In one 1440x900 chat viewport after one completed turn (/tmp/ap/shots/M-chat-bottom.png): top-bar pill "Evidence unavailable" (y=28); session badge "E2EE · evidence recorded" (y=107); session sub-line "Evidence unavailable · this session" (y=163); receipt chip "Evidence not pulled" (y=655); right rail "Encrypted · no required endpoint proof · some claims are assertions" + "Turn receipt only / 7 established · 1 not established" + the sentence "hardware claims are not inferred" — sitting 60px above a green "VERIFIED 1 / Protected CPU runtime / ✓ Verified". Six verdict-shaped statements, two of them flat contradictions of each other.

On #proof itself (M-proof-via-sidebar.png) the same turn produces NINE verdict-shaped statements inside 900px: top-bar pill; hero seal "Asserted"; hero "Current proof level: Encrypted"; metric "TEE verification — Not established / compatibility mode"; metric "Session journal — Journal structure passed"; inspector pill "ENCRYPTED"; the ranked verdict sentence; "Turn receipt only · 7 established · 1 not established"; and "VERIFIED 1 — Protected CPU runtime — Verified". The word "Encrypted" is printed 4 times; "journal passed" is printed 8 times (metric + section pill + six "Passed/consistent" tiles).

ROOT CAUSE IS ARCHITECTURAL, NOT COSMETIC. Six independent reducers each compute a verdict from a different subset of the same state: describeAttestationSeal (app.tsx:6112, topbar), activeConnectionBoundaryLabel (app.tsx:5666, session badge — reads only connection.posture, never the receipt), describeMessageAttestation (app.tsx:6190, transcript chip), sealStateForReceipt (seal.tsx, hero), composeClaimStack().evidence + rankedReceiptVerdict (claim stack), and the teeVerified ternary in proof-view.tsx:150. No shared reduction exists, so they cannot agree. Critically, acquisition state ("evidence not pulled") and claim state ("7 established") are rendered as co-equal verdicts when one is a modifier of the other.

WORST SINGLE FINDING — THE TWO TABS DISAGREE ABOUT THE SAME CLAIM. Same turn, one tab click apart: "Receipt & journal" says Protected CPU runtime = **Verified**; "Attestation evidence" says Protected CPU runtime = **Asserted / "Asserted verified · receipt unauthenticated"**. The attestation tab is correct — attestations-model.ts down-ranks receipt-declared claims because the receipt is unauthenticated; claim-stack-model.ts passes receipt.claims[key].status straight through. Airship's own honesty rule is being broken by its own second opinion.

GEOMETRY (measured, connected, receipt bound). Desktop #proof summary: 338px of chrome before the first proof fact = 37.6% of a 900px viewport (page-heading 109 + tabs 44 + offsets); .proof-hero is 568x110 to carry one word ("Encrypted"); content 1795px in an 842px pane = 2.13 screens; expanding all 8 claim rows = 3905px = 4.64 screens. iPad summary 1836/1136 = 1.62. iPhone summary 2520/824 = 3.06. Attestation tab: desktop 1742/842 = 2.07, iPad 2389/1136 = 2.10, iPhone 3802/824 = 4.61 screens.

DENSITY IS SPENT ON REPETITION, NOT INFORMATION. Attestation tab main text is 3,408 chars and contains the word "Asserted" 17 times and the phrase "receipt unauthenticated" 9 times — the latter is a record-level fact restated on 9 tiles. The 8-tile claim matrix (154x139 each, 281px) and the 7-button "Verification records" list (308px) are two renderings of the same claims stacked vertically. The evidence-record rail is 241px wide holding ONE 212x76 card that renders as "C… / Qw… / ASSERTED / Jul…" — the record's identity is destroyed by layout while the word "asserted" appears three times in the same card (seal label, subtitle, badge) — and ~880px of that rail (81%) is empty.

TWO HARD RENDER DEFECTS. (a) P-audit-findings.png: the expanded audit finding paints over itself — "SESSION_TITLE_SNAPSHOT_MISMATCHreation event title differs…" because .audit-findings article uses grid-template-columns: 48px 150px minmax(0,1fr) and the 31-char mono code needs ~205px. (b) M-att-populated.png claim inspector: "Attested endpoint-key bindingASSERTED · ASSERTED PARTIAL · RECEIPT UNAUTHENTICATED" — <small> and <strong> render inline with no separator, and qualifierLabel re-prefixes a status word that is already displayed.

EMPHASIS IS INVERTED. The loudest control on the entire trust surface is the solid amber "Export status summary", whose own adjacent note says it "is not independently verifiable proof". The one artifact a third party can actually verify — "Export raw verification bundle" — is a .small-button on the other tab. On iPhone that amber button occupies the full width at y=563 while the first actual evidence record starts at y≈820 (88% of the first viewport is preamble).

NOTHING BELOW DELETES A FACT. Every claim summary, verifier, policy digest, expiry, record warning, boundary sentence, the eight-row claim stack and the endpoint/receipt distinction survive; they are re-homed into one canonical verdict plus master-detail disclosure.

### One canonical turn-evidence verdict — kill the six competing reducers

- impact **transformative** · effort **large** · reclaims Removes 4 of 6 duplicate verdict surfaces; ~110px on #proof (one metric card) and ~2 pills from the chat top bar
- **Files.** src/ui/turn-verdict.ts, src/ui/app.tsx, src/ui/proof-view.tsx, src/ui/seal.tsx, src/ui/trust-language.ts, src/ui/posture-chip.tsx

**Problem.** Six independent functions each compute a verdict from a different slice of the same state, so a single turn simultaneously reads "Evidence unavailable" (topbar), "E2EE · evidence recorded" (session badge), "Evidence not pulled" (receipt chip), "TEE verification — Not established" (metric), "Encrypted · no required endpoint proof" (ranked verdict) and "VERIFIED — Protected CPU runtime" (claim stack). activeConnectionBoundaryLabel (app.tsx:5666) never even looks at the receipt. Acquisition state and claim state are rendered as co-equal verdicts when the first is a modifier of the second.

**Design.** New src/ui/turn-verdict.ts exporting `turnEvidenceVerdict({receipt, records, failure, posture, proofPolicy, now}): TurnVerdict` — the single reducer every trust surface must call. Six states, ordered strongest→weakest, each with {id, seal, chip (≤22ch), line (≤80ch), detail, counts, modifier?}:

1. `proven` · seal verified · chip "Proven this turn" · line "Hardware identity verified for this exact turn."
2. `partly-proven` · seal verified · chip "{n}/8 proven" · line "{n} claims independently verified; the rest are assertions."
3. `recorded` · seal asserted · chip "Recorded, not proven" · line "Encrypted and recorded. No independent authority verified this turn."  ← today's real state
4. `not-checked` · seal none · chip "Not checked yet" · line "Evidence is collected when a turn completes."
5. `evidence-blocked` · seal attention · chip "Evidence not pulled" · line "Evidence could not be fetched. This is not a failed verification."
6. `failed` · seal failed · chip "Verification failed" · line "Do not rely on this turn."

PRECEDENCE RULE (this is the fix): an acquisition failure never becomes the headline while a receipt exists. It is returned as `modifier: {label, detail}` and rendered as a trailing clause inside the ONE chip — "Recorded, not proven · evidence not pulled" — never as a second pill. Only when there is no receipt does `evidence-blocked` become the state.

Three render projections, all in a new `<TurnVerdict variant>` component: `chip` (seal + chip text, used by topbar, transcript receipt row, session badge), `bar` (seal + chip + line + clickable count triple), `full` (bar + claim ledger). Delete describeAttestationSeal / describeMessageAttestation / activeConnectionBoundaryLabel / the teeVerified ternary and have all four call sites render `<TurnVerdict>`.

**Information fate.** The five attestationFailureLabel strings ("Evidence unavailable", "Evidence path unreadable", "Evidence access denied", "Evidence rejected", "Evidence pull unavailable") STAY — they become `modifier.label`, shown as the chip's trailing clause and in full in its expansion and in the Attestation-tab alert. "E2EE" STAYS but splits: the transport half becomes a separate non-verdict chip reading only "End-to-end encrypted"; the proof half ("evidence recorded"/"last turn proved"/"proof required") is deleted as a string because it is the verdict, now single-sourced. "TEE verification — Not established / compatibility mode" merges into the bar's count triple plus the `recorded` line. "Receipt-attested" merges into `proven`. sealStateForReceipt's fail-closed logic (posture encrypted-attested + endpointKey verified + attested proofLevel) becomes an input predicate to the reducer, unchanged.

### Stop the claim stack overclaiming — reconcile the two tabs that disagree

- impact **transformative** · effort **medium** · reclaims n/a
- **Files.** src/ui/claim-stack-model.ts, src/ui/trust-language.ts, src/ui/attestations-view.tsx, src/ui/app.tsx

**Problem.** MEASURED, same turn, one tab click apart: "Receipt & journal" shows Protected CPU runtime = Verified (green check, group header "VERIFIED 1"); "Attestation evidence" shows the same claim on the same turn as Asserted / "Asserted verified · receipt unauthenticated". attestations-model.ts correctly down-ranks receipt-declared claims because the receipt itself is unauthenticated; claim-stack-model.ts composeItem() passes receipt.claims[key].status straight through when there is no turn-bound endpoint record. The Proof route's primary tab is the one that overclaims.

**Design.** In src/ui/claim-stack-model.ts composeItem(), when a claim's status is `verified` but it is sourced from `turn-receipt` with no turn-bound fresh endpoint record, emit `status: "partial"` plus a new field `qualifier: "declared-verified"`. Render that row as `Asserted · receipt declares verified` with the asserted half-circle seal. Add a matching branch to trust-language.ts `proofStatusLabel`/a new `claimQualifierLabel` so the two tabs share one vocabulary function (the attestation tab's qualifierLabel() moves out of attestations-view.tsx into trust-language.ts and both import it).

**Information fate.** NOTHING is softened away. The full claim summary stays verbatim in the detail: "Intel DCAP QVL verified the TDX quote, Intel production trust chain, revocation lists, QE Identity, collateral windows, debug prohibition, and an UpToDate TCB locally in this browser. Chutes runtime measurements are evaluated separately." The verifier id (intel-dcap-qvl-wasm@dcap-qvl/0.5.2), version and checked-at all stay. Only the headline word changes from "Verified" to "Asserted · receipt declares verified", and the group counts change from "7 established · 1 not established" to "0 verified · 7 asserted · 1 not established" — which is exactly what the top bar and the other tab already say.

### Replace the eight stacked accordion rows with a claim ribbon + fixed detail panel

- impact **transformative** · effort **large** · reclaims Desktop collapsed 378→264px; expanded case 3905px→1795px (removes 2.5 viewports of growth). Empty state 439→264px. iPhone: 8 stacked tiles → one 44px strip.
- **Files.** src/ui/app.tsx, src/ui/claim-stack-model.ts, src/ui/styles.css

**Problem.** Eight boolean-ish claims are rendered as eight near-identical 53-54px bordered <details> rows (378px collapsed on desktop) grouped under three headers, each row carrying only a title, a seal word and a source pill. Expanding them all takes the page from 1795px to 3905px (4.64 viewports). On iPhone the same eight claims cost 8 stacked rows plus group chrome. Nothing about eight booleans requires eight boxes.

**Design.** In the ProofInspector (app.tsx:6861) replace `.claim-groups` / ClaimGroup / ClaimRow with:
(a) a 44px `.claim-ribbon` — one horizontal strip of 8 equal segments in fixed claim order (Encryption, Freshness, CPU, GPU, Endpoint, Model, Conversation, Payment). Each segment: the Seal glyph at 16px + a 2-3 letter code (ENC FRE CPU GPU KEY MOD CNV PAY) + a 3px bottom rule in the state colour. Segment is a `role="tab"` button, arrow-key navigable, aria-label = "{full claim name}: {status}". 44px tall = touch-legal; on iPhone the ribbon is 8 columns of 44x44 instead of 8 stacked rows.
(b) a fixed-height `.claim-detail-panel` (~220px desktop, ~300px mobile) below it showing the selected claim. Selecting a segment never changes page height, so the 3905px expanded case disappears entirely.
(c) the three group counts ("VERIFIED 1 / ASSERTIONS 6 / Not established 1") move up into the verdict bar as three clickable pills that filter/step the ribbon.

**Information fate.** Every claim keeps everything: name, technical label, status, source, summary, issuer, subject, scope, verifier, version, checked, expires, facts, verifier note, policy digest and the raw details JSON — they move from the accordion body into the detail panel (technical bits stay behind the existing nested "Technical details" disclosure). The group headers become the verdict bar's count pills. The `.claim-absence` "Not established / Future or unavailable claims" disclosure disappears as a separate block: those claims become dimmed ribbon segments whose detail panel shows the same absentClaimSummary() sentence ("No CPU TEE quote has been bound to a completed turn.") — currently 8 of these stack to ~439px in the empty state and are reduced to one 44px ribbon plus one panel.

### Compact the claim detail from an 11-row label/value dump to three provenance lines + facts first

- impact **high** · effort **medium** · reclaims ~110px per claim detail (5 rows x 22px)
- **Files.** src/ui/app.tsx, src/ui/styles.css

**Problem.** An expanded claim row (M-claims-open-1.png) is an 11-row dl: Claim, Source, Issuer, Subject, Scope, Status, Verifier, Version, Checked, Expires, Verifier note. Measured redundancy on a real receipt: Issuer and Verifier print the identical string `intel-dcap-qvl-wasm@dcap-qvl/0.5.2`; Status ("Verified") repeats the seal 20px above it; Subject is the same model string on all 8 claims; Scope is one of three constants. The claim-specific `facts` (TDX quote bytes + version, GPU device count, key digest, freshness window) — the only genuinely per-claim measurements — render LAST, below all of that.

**Design.** Restructure the detail panel body as: (1) the claim summary paragraph; (2) the `facts` grid promoted to the top, since it is the evidence; (3) a three-line provenance block —
  Authority: `{verifier} · v{version} · checked {relative}`  (when issuer ≠ verifier: `issued by {issuer}, verified by {verifier}`)
  Scope: `{scope} · {subject}`
  Validity: `expires {relative}` or `Expiry not supplied`
(4) the existing nested `<details>Technical details</details>` holding policy digest + details JSON, unchanged.
The "Status" row is dropped as a row; it is the seal + word in the panel header. "Claim" (the technical label, e.g. "CPU TEE") becomes the panel's subtitle under the primary name.

**Information fate.** Every one of the 11 values still appears. Issuer merges with Verifier and both are shown when they differ. Status moves 20px up into the panel header (already rendered there). Subject and Scope merge onto one line. Verifier note stays as its own line under Authority. Nothing moves behind a disclosure that was not already behind one.

### Collapse the journal-audit panel from eight restatements of "passed" into one row that surfaces the warning

- impact **high** · effort **medium** · reclaims ~528px on the desktop summary tab (474+110 → 56)
- **Files.** src/ui/proof-view.tsx, src/ui/styles.css

**Problem.** The session journal result is stated eight times on one screen: the metric card "Journal structure passed", the section pill "JOURNAL STRUCTURE PASSED", and six "Passed / consistent" tiles. The panel is 474px, plus 110px for the metric card. Meanwhile the ONE thing that needs a human — a real SESSION_TITLE_SNAPSHOT_MISMATCH warning — is a 35px collapsed row at the very bottom (y=1667 of a 1795px pane), below the fold, under a pill announcing that everything passed.

**Design.** Replace the metric card and the `.journal-audit` header with a single 56px row: `[seal] Session journal · 6 of 6 structure checks passed · 1 warning to read   |  237 events · sha256:JRxW6oG5TM6…  [chevron]`. Expansion (closed by default only when findings.length === 0) reveals exactly today's content in today's order: the "A valid hash chain is not proof of authorship" boundary paragraph, the 6-tile check grid, the commitment dl (Session / Journal events / Checked / External anchor), the technical digest disclosure, and the findings list. Change `<details class="audit-findings" open={audit.status === "invalid"}>` to `open={audit.findings.length > 0}` so a warning is never hidden under a green pill, and make the summary row's seal reflect the worst severity present, not just `status`.

**Information fate.** The metric card's two facts (event count, digest prefix) move to the right side of the new row. The section pill's text becomes the row's own label. All six check tiles, the boundary paragraph, the four commitment fields, the full digest and every finding move into the expansion verbatim. The auditLabel vocabulary ("Journal structure passed" / "Consistent but incomplete" / "Integrity failure" / "Checking journal" / "Not checked") is preserved as the row's status clause.

### Collapse the Proof page chrome into one sticky verdict bar

- impact **high** · effort **medium** · reclaims 338px → 88px desktop (250px, 27.8% of the viewport); 315px → 108px on iPhone
- **Files.** src/ui/proof-view.tsx, src/ui/styles.css, src/ui/app.tsx

**Problem.** 338px — 37.6% of a 900px viewport — passes before the first proof fact: a monospace eyebrow "INSPECTABLE, PORTABLE EVIDENCE", a 47px Georgia H1 "Proof", a paragraph, then a 44px tab row, then a 568x110 hero card whose payload is the single word "Encrypted". On iPhone the first fact is at y=315 of 932 (34%) and the answer to "is this turn proven" scrolls away immediately in a 3.06-screen page.

**Design.** Replace `.page-heading` + `.proof-surface-tabs` + `.proof-overview` with one `.proof-verdict-bar`, `position: sticky; top: 0` inside `main.route-layout`, 88px desktop / 64px+44px tab row on mobile:
  row 1: [Seal 32px] **{verdict.chip}** — {verdict.line}   ·······   [7 asserted] [1 not established] [0 attention]  (three count pills, click = filter the ribbon)
  row 2: segmented control [ Receipt & journal | Attestation evidence ] and, right-aligned on desktop, the 12px caption "Endpoint attestation and conversation receipts are different claims."
A sticky bar means the verdict is answerable at any scroll position, which is the whole point of the route.

**Information fate.** The H1 "Proof" is already the active sidebar item and the active route tab — it moves to `document.title` and an sr-only h1, so screen readers keep it. The eyebrow "Inspectable, portable evidence" moves into an "About this page" popover on the bar together with the second half of the description sentence ("Airship never presents one as the other."); the first half stays visible as the tab-group caption. The hero's proofLevelLabel value and summarizeReceipt() sentence become verdict.chip and verdict.line — same words, one place. The hero Seal becomes the bar's seal. The "TEE verification" metric merges into the count pills (proposal 1).

### Merge the attestation claim matrix with the verification-records list and factor out the nine repeated caveats

- impact **high** · effort **medium** · reclaims ~308px desktop; "receipt unauthenticated" 9 occurrences → 1
- **Files.** src/ui/attestations-view.tsx, src/ui/attestations-view.css, src/ui/attestations-model.ts, src/ui/trust-language.ts

**Problem.** The Attestation tab renders the same 7-8 claims twice, stacked: an 8-tile matrix (154x139 each, 281px) and a 7-button "Verification records" list (308px) whose only added value is the authority string. The tab's main text is 3,408 characters and contains "Asserted" 17 times and "receipt unauthenticated" 9 times — the latter is a record-level fact ("the receipt is unauthenticated") restated on nine separate tiles, and it is ALSO already stated in RecordHeader's receiptTrust sentence directly above.

**Design.** One master list. Each claim tile gains a second line carrying its authority (today's verification-record subtitle, e.g. "Claimed verifier: intel-dcap-qvl…") and clicking that line still routes to setInspector({kind:"verification", id}) so authority records remain individually inspectable. The shared caveat is stated once, in the record header, in the copy that already exists there: "Receipt integrity is unauthenticated; every non-unavailable claim below is an assertion." Each tile then shows only its own delta via qualifierLabel — e.g. CPU runtime reads "declared verified · no authority", endpoint key reads "locally matched · not verified", payment reads "unavailable". Also fix the counts dl, which currently renders "VERIFIEDPARTIAL FAILED UNAV" with overlapping and truncated labels on iPad: relabel to the product's own vocabulary — Verified / Asserted / Failed / Not established — and lay it out as four inline `n label` pairs rather than a 4-column dl.

**Information fate.** No AttestationVerification record is removed: id, title, authority, authorityKind, version, checkedAt, policyDigest, summary and facts all survive and stay reachable from the tile's authority line and in the inspector. The nine identical "receipt unauthenticated" strings collapse to the one sentence that already says it. Every unique qualifier ("asserted verified", "asserted unavailable", "matched", "present", "unverified", "verified-without-authority") is preserved verbatim.

### Fix the evidence-record rail: 81% empty and it destroys the record's identity

- impact **high** · effort **small** · reclaims 241px of horizontal rail reclaimed at low record counts; restores ~28 clipped characters per card
- **Files.** src/ui/attestations-view.tsx, src/ui/attestations-view.css, src/ui/seal.tsx

**Problem.** `.attestations-ledger` is 241px x 1083px holding ONE 212x76 record card — roughly 880px (81%) dead space. The card renders as "C… / Qw… / ASSERTED / Jul…": title, subtitle and timestamp are all clipped to 1-3 characters on a 1440px desktop, while the word "asserted" appears three times inside those 212px (the Seal's visible label, the subtitle "· asserted", and the right-aligned `<b>ASSERTED</b>` badge). On iPad it is worse — "Asse… ASSERTED" with no title at all.

**Design.** (1) Remove the `<b>ENDPOINT|ASSERTED</b>` badge; encode source as a 4px left rule (brass = endpoint acquisition, neutral = conversation receipt) with the word carried in the card's aria-label and title. (2) Give Seal a `labelHidden` prop and use it here — the glyph and colour stay, the redundant word leaves, freeing ~60px. (3) `.attestation-record-list strong { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2 }` so "Conversation receipt · asserted" reads in full. (4) Merge the `<em>` timestamp into the subtitle line as `{model} · {relative time}`, dropping one line (16px). (5) When records.length <= 2, drop the third column entirely and run a two-column shell (`grid-template-columns: minmax(560px,1.9fr) minmax(280px,0.9fr)`) with the record selector demoted to a 36px header segmented control — the 241px rail only earns its width once there is a list to scan.

**Information fate.** Record title, subtitle, source class, overall state and timestamp all remain visible (title now fully, timestamp merged into the subtitle). The "Records are not merged. Endpoint evidence cannot silently upgrade a conversation receipt, or vice versa." note moves from the bottom of the rail to sit under the record selector, where it is read at the moment of choosing. Nothing is dropped.

### Cut the Attestation tab's 558px preamble and un-invert the export emphasis

- impact **high** · effort **medium** · reclaims 558px → ~190px desktop; ~390px reclaimed on iPhone
- **Files.** src/ui/attestations-view.tsx, src/ui/attestations-view.css, src/ui/proof-view.tsx

**Problem.** Before the first evidence record: page-heading 109 + tabs 44 + attestations-heading 112 + "Claim-scoped trust" boundary 60 + acquisition alert 48 = 558px on desktop (evidence starts at y≈600 of 900). On iPhone the first record starts at y≈820 of 932 — 88% preamble. The heading paragraph ("Each result applies only to its named claim…") and the boundary note ("Structural presence and local digest matches remain partial…") say the same thing twice. And the single loudest control on the whole trust surface is the solid amber `primary` "Export status summary", whose own adjacent note says it "is not independently verifiable proof", while "Export raw verification bundle" — the artifact a third party can actually check — is a `.small-button` on the other tab.

**Design.** One 56px `.attestations-heading` row: `Evidence ledger` + record count + [Refresh evidence] (now the `primary`, because it is the only control that changes truth) + an "Export ▾" split menu listing, in this order: "Raw verification bundle — for independent verification (unsigned)" then "Status summary — privacy-safe snapshot, not proof". Merge the two boundary paragraphs into one 40px note: "Each result applies only to its named claim. “Verified” requires the authority named on that exact record; structural presence and local digest matches remain assertions. Raw evidence withheld by design." Move the acquisition alert out of the page flow and inline it above the record it affects.

**Information fate.** Both boundary sentences survive, merged without losing either clause. The "Unsigned status summary" explainer in the right inspector stays as the export menu item's own description, so the caveat travels with the action instead of sitting 900px away. The acquisitionNotice text is unchanged, only relocated. The h2 "Endpoint & receipt evidence" is dropped as a second page title (the route tab already says Attestation evidence) and kept as the sr-only heading that the tabpanel's aria-labelledby points at.

### Two hard render defects on the trust surface

- impact **medium** · effort **small** · reclaims n/a
- **Files.** src/ui/styles.css, src/ui/attestations-view.tsx, src/ui/trust-language.ts

**Problem.** (a) The one audit finding that exists paints over itself: "WARNING SESSION_TITLE_SNAPSHOT_MISMATCHreation event title differs from the session record." `.audit-findings article` is `grid-template-columns: 48px 150px minmax(0,1fr)` (styles.css:3204) and the 31-character monospace code needs ~205px, so the code column overflows onto the message. This is the single most important row on the journal panel and it is unreadable. (b) In the Attestation claim inspector the title block runs together: "Attested endpoint-key bindingASSERTED · ASSERTED PARTIAL · RECEIPT UNAUTHENTICATED" — `<small>` and `<strong>` are laid out inline with no separator, and qualifierLabel() re-prefixes "Asserted" onto a line that already begins with the status word.

**Design.** (a) `.audit-findings article { grid-template-columns: minmax(0,1fr); gap: 4px }` with severity as a small coloured pill inline before the code, the code on its own line with `overflow-wrap: anywhere; font-variant-ligatures: none`, and the message below it. Keep the max-height 260px scroller. (b) In attestations-view.tsx `DimensionInspector`, make the three title elements block-level and stop double-printing the status: render `<h2>{title}</h2>`, `<small>{technical label}</small>`, then a single status line `{statusLabel} · {qualifier-without-status-prefix}` — so it reads "Endpoint identity / Attested endpoint-key binding / Asserted · locally matched, no authority". Update qualifierLabel() to return only the delta, since the status word is now always rendered beside it.

**Information fate.** Every finding severity, code and message is preserved and becomes readable. Every qualifier string is preserved; only the duplicated leading status word is removed, and it is still displayed once immediately before.

### Make the verdict survivable on mobile

- impact **high** · effort **medium** · reclaims iPhone summary 2520→~1180px; attestation 3802→~1500px
- **Files.** src/ui/styles.css, src/ui/attestations-view.css, src/ui/proof-view.tsx, src/ui/app.tsx

**Problem.** iPhone 14 Pro Max: Proof summary is 2520px in an 824px pane (3.06 screens) and the Attestation tab is 3802px (4.61 screens). The verdict scrolls out of view after ~500px and never returns. The three overview cards stack to 293px; the 8-tile attestation matrix becomes 8 full-width 400x108 tiles = 864px for eight booleans; the summary tab restates "passed" eight times over ~880px.

**Design.** Compose proposals 1, 3, 5, 6 and 9 for the narrow breakpoint: the verdict bar is `position: sticky; top: 0` at 64px with the tab row beneath it (the existing 197x44 tabs already meet the touch target); the claim ribbon becomes an 8-column strip of 44x44 segments with horizontal-scroll fallback below 360px and its detail panel below; the journal audit becomes the single 56px row; the attestation matrix uses the same ribbon component instead of eight stacked tiles; the two full-width export buttons become one 44px "Export ▾" menu. Projected: summary ≈1180px (1.43 screens), attestation ≈1500px (1.82 screens), with the verdict permanently visible.

**Information fate.** Purely a re-layout of the components defined above — no content is dropped at any breakpoint. Everything that is visible on desktop remains reachable on mobile through the same ribbon segments, detail panel and disclosures; the sticky bar adds a permanent answer to "is this turn proven" that mobile currently loses entirely.


---

## Profiles, Account, and session/conversation management (#profiles, #account, #sessions, the rail thread list, fork/rename/delete flows)

**Diagnosis.**

Measured at 1440x900, iPad Pro 11 (834x1194) and iPhone 14 Pro Max (430x740), empty and populated, with a live Chutes key connected for #account.

The three routes share one failure and each has one of its own.

THE SHARED FAILURE — inverted hierarchy. Every route opens with a monospace eyebrow + a 47px Georgia H1 + a 13px paragraph. Measured: #profiles spends 288px (32% of a 900px viewport) before the first profile card; #sessions 215px (24%) before the first conversation; #account 356px (40%) before the balance. The H1 is 47px; the densest real content on the same screen is 11.69px — a 4:1 ratio in favour of a word that already appears in the sidebar nav item, in the gold active tab, and (on profiles) in the catalog panel heading. "Profiles" is printed four times on one screen. Below the fold the same routes are empty: #account disconnected has 336px (37%) of void; #profiles on iPad has 409px (34%).

#PROFILES — the editor hides what a profile does. Collapsed, the four disclosures reveal only "419 characters", "Foundry", and "profile memory · Ask First". You must open four accordions to learn what the profile actually governs. One field has three renderings under two names: the catalog card says "Minimum posture", the boundary select says "Minimum proof", and the revision strip repeats "Minimum proof" ~60px below the select. The boundary summary prints the raw enum `profile memory` while the select inside prints the friendly `This profile`. The note says "including the minimum proof posture below" — it is above. "Skills resolved 3" is a dead number with no link to the Skills tab that owns it. On phone the catalog becomes a scrollbar-less horizontal carousel that clips profile 2 mid-word and hides profile 3 entirely, and `.profile-card .posture-chip { display: none }` deletes the posture claim outright — the one thing the governing constraint forbids.

#ACCOUNT — disconnected reads as broken; connected wastes a quarter of the screen on "no". Disconnected states one fact five times: "● Account telemetry unavailable", "No user-scoped OAuth token is held in page memory", "USER-SCOPED TOKEN REQUIRED", "Connect your Chutes account", "…credential remains held only in page memory" — two of them near-verbatim, 110px apart. A grey dot plus the word "unavailable" is Airship's failure grammar; not-yet-connected is a default. Connected with a real key: the 205px runway triptych (26% of the viewport) is entirely empty, and "Chutes reported no active subscription" prints three times within 200px. The balance renders as $46.2054 — four decimals on a wallet — while the ledger column mixes $0.08 and $0.2871 with no decimal alignment. The 64-bar usage chart has no axis, no scale, no baseline, and a `Math.max(3, …)` floor that renders 14 different buckets as identical stubs; the same ten rows are then reprinted as a table with no linkage between them.

#SESSIONS — you cannot find an old conversation. Created nine real sessions: all titled "General conversation" or "Research conversation", all "Jul 27, 10:15 AM", all "1 event", all "airship-demo / airship/demo-v1", all profile "general". The 148px card carries seven data points, of which seven are identical row-to-row. `querySessionRecords` search matches only title/id/provider/model/profile — never transcript text — so with identical titles the search box is inert. There is no date grouping. Worse: `.recent-conversations` is `max-height: min(250px, 30vh)` and the "All conversations" link is the last child inside it, so at 6+ threads the only in-rail route to the library scrolls out of view (verified: y=555 in a 250px box, `visible: false`) behind a transparent scrollbar and a hard-clipped row. Forks are invisible: `SessionListItem.sourceSessionId` is populated and even searchable, but no card renders it — lineage appears only in the chat header chip and 900px down inside a collapsed disclosure. The detail pane spends 177px on three "everything is fine" bands plus a "Rename conversation" form that opens *above* the title it renames, and prints "1 events".

Nothing here needs deleting. Every finding is a fact that deserves a smaller, better-placed representation.

### Sessions: give conversations an identity — auto-titles, date groups, and a 76px card

- impact **transformative** · effort **large** · reclaims 72px per row (148→76); 9 conversations fit in 684px instead of 1332px — the 620px list panel goes from 4.2 rows visible to 8.1
- **Files.** src/ui/sessions-view.tsx, src/ui/sessions-view.css, src/ui/session-pins.ts, src/sessions/domain.ts, src/ui/app.tsx

**Problem.** Created nine real conversations. All nine are titled "General conversation" or "Research conversation"; all show "Jul 27, 10:15 AM", "1 event", "airship-demo", "airship/demo-v1", profile "general". The 148px card carries seven data points of which seven are identical row-to-row — zero signal at 148px per row, and the list panel (620px) shows only 4.2 of 9. The rail is worse: 46px rows all reading "General conve… / No messages … / 10:15 AM". `querySessionRecords` (src/sessions/domain.ts:927-929) matches search against title, id, providerId, model, profileId and sourceSessionId only — never transcript text — so with identical titles the "Search conversations" box returns everything or nothing and its placeholder overclaims. There is no date grouping at all: `groupPinnedSessions` splits pinned/other, and `formatRelativeDate` emits an absolute "Jul 27, 10:15 AM" for a session created 30 seconds ago. The pin star is a 28x28 hit target (measured) and is a `role="button"` nested inside a `<button>`.

**Design.** Four coordinated changes in sessions-view.tsx and the rail.

1. AUTO-TITLE. The journal already holds the first user message — the rail renders it as `session.preview`. On the first user turn, set the session title from it (bounded to ~60 chars, existing 240 cap for manual renames). Until then the card shows a `Draft` chip instead of repeating provider/model.

2. DATE GROUPS. Reuse the `groupPinnedSessions` seam to emit `Pinned` / `Today` / `Yesterday` / `Earlier this week` / `Earlier` headers, using the same `.session-library-group-label` style already in the file. `formatRelativeDate` gains branches: `just now` (<60s), `12m`, `3h`, `Yesterday 14:02`, `Mon 14:02` (<7d), `Jul 12` beyond.

3. CARD 148px → 76px, two lines:
   line 1: `[state dot] {title}  ································  {relative time}`
   line 2: `{n} messages · {profileName}` and a right-aligned 44x44 pin button.
   The `ACTIVE` pill becomes the state dot's colour plus `aria-label="active session"`.

4. SEARCH HONESTY. Placeholder becomes `Search titles, models and profiles`. When a search returns zero, the empty state adds one line: `Transcript text is not indexed in this build.`

**Information fate.** Title: stays, and finally means something. providerId + model chips: move to the card's `title` attribute and stay fully visible in the detail pane's Runtime record, where they are the point — one click, not deleted. `headSequence` events count: merges into "{n} messages" on the card and stays exact as "Journal head {n} events" in the detail continuity row. profileId chip: stays on line 2, resolved to the profile's display name with the id in `title`. Pin star: stays, moves to the row's right edge at 44x44 and out of the nested-interactive structure. "METADATA ONLY" list eyebrow: becomes a `title` on the count ("Metadata only; transcripts are read on selection"). Nothing is removed.

### Profiles: a persistent "Governs" strip replacing the four-accordion editor

- impact **transformative** · effort **large** · reclaims ~120px on desktop (61px revision strip + 4 collapsed summary bars at ~40px collapse into one 44px strip); the collapsed editor drops from 503px to ~330px
- **Files.** src/ui/app.tsx, src/ui/styles.css

**Problem.** The profile editor is 503px collapsed / 1041px expanded on desktop and 1635px on phone. Collapsed, the only facts visible are Name, Role, "419 characters", "Foundry", and "profile memory · Ask First". A person cannot answer "what does this profile change?" without opening four disclosures. One field has three renderings under two names within 400px: the catalog card prints "Minimum posture ○ Local", the boundary grid prints a "MINIMUM PROOF" select, and `.revision-strip` prints "MINIMUM PROOF ○ Local" again roughly 60px below the select. The collapsed boundary summary prints the raw enum `profile memory` while the select inside prints `This profile` — two vocabularies for one value. `.profile-boundary-note` says "including the minimum proof posture below" when the select is above it. `<span><small>Skills resolved</small>3</span>` is a dead number with no route to the Skills tab that owns it. `RUNTIME airship-demo · airship…` truncates with no `title`.

**Design.** Replace the four `<details class="profile-editor-disclosure">` with one always-visible governance strip directly under Name/Role — six cells, each a button that expands its editor inline below the strip (one open at a time, `aria-expanded`, keyboard reachable):

  `Instructions 419 ch` · `Theme Foundry` · `Memory This profile` · `Approvals Ask First` · `Proof ≥ Local` · `Skills 3 →`

Every value is legible with zero clicks; every editor is one click away, exactly as today. Delete `.revision-strip` as a separate row: `Runtime airship-demo · airship/demo-v1` and `Parent origin` move into the `.panel-heading` beside the revision hash as `airship-demo · airship/demo-v1 · from origin`, each with an untruncated `title`.

Copy fixes, exact: rename "Minimum posture" → "Minimum proof" on the catalog card so one field has one name everywhere. Boundary summary uses the friendly labels (`This profile`, not `profile memory`). The note becomes `These settings are copied into each new session. Existing conversations keep their original pin.` (drops the false "below"). `Skills 3` becomes a link to `#skills` scoped to this profile via the existing `profileHubScope` mechanism.

**Information fate.** System prompt, theme library, workspace binding, memory scope, approval mode, minimum posture: all stay, all editable, each behind one click instead of one click plus a hunt. Character count, theme name, memory scope, approval mode, posture and skill count: promoted from disclosure summaries to always-visible strip cells. Runtime + Parent from the revision strip: move to the panel heading, gain a `title` so the model id stops truncating. `.profile-boundary-note`: stays, one word corrected. Nothing removed.

### Account disconnected: one calm "Not connected yet" card instead of five restatements

- impact **high** · effort **small** · reclaims 64px toolbar removed; the card centres into the 336px of previously dead space, so the route reads as one composed screen rather than 40% chrome / 23% content / 37% void
- **Files.** src/ui/billing-view.tsx

**Problem.** Measured at 1440x900: 356px of chrome (40% of the viewport), a 208px card, then 336px (37%) of void. The route states one fact five times — `● Account telemetry unavailable`, `No user-scoped OAuth token is held in page memory`, `USER-SCOPED TOKEN REQUIRED`, `Connect your Chutes account`, `…credential remains held only in page memory` — with two near-verbatim page-memory sentences 110px apart. A grey dot plus the word "unavailable" is the same visual grammar Airship uses for failure; not-yet-connected is a default, not a fault. The `.billing-toolbar` band (64px) exists to hold one external link plus a redundant status line. The header promises "balance, provider-reported charges, subscription runway, and live limits" and then a `<details>` labelled "What becomes available" promises the same list again in different words — and its summary renders with no disclosure triangle, reading as an inert bold label rather than a control. On phone both the topbar `Connect` pill and the card's `Connect Chutes` button are gold primaries on one screen.

**Design.** In the `!accountReadable` branch, drop `.billing-toolbar` entirely and render one card, vertically centred in the route (which consumes the 336px void):

  [lock glyph]  **Not connected yet**
  `Chutes account standing needs a user-scoped credential. Connect with Chutes sign-in or a Chutes API key — the credential stays in page memory and is never written to disk.`
  [Connect Chutes]   Manage at Chutes ↗ (secondary text link)

Directly below, a dimmed preview of the real connected layout: the four `BillingMetric` tiles with their real labels — `Available Chutes balance`, `Subscription`, `Charged this UTC month`, `Tokens this UTC month` — each showing `—`, plus a fifth `Live headroom`. One honest line under them: `Nothing is read from Chutes until you connect.` This shows the shape of what arrives instead of describing it in prose, and the em-dashes make the non-claim explicit.

**Information fate.** "Account telemetry unavailable" → becomes the H2 `Not connected yet`. "No user-scoped OAuth token is held in page memory" → merged into the body sentence; the string itself stays in `credentialMessage()` and still renders verbatim for the `api-key` and `unknown` credential kinds under the connected status chip. "USER-SCOPED TOKEN REQUIRED" eyebrow → deleted as pure restatement of the H2. `What becomes available` details body → becomes the five labelled preview tiles, which name the same six things (balance, subscription runway, charged usage, token totals, quota, live headroom) with more precision. `Manage at Chutes ↗` → stays, as a secondary link inside the card.

### Rail: "All conversations" scrolls out of reach at six or more threads

- impact **high** · effort **small** · reclaims 0 — this is a reachability fix, not a space fix; it restores an entry point that is currently unreachable at 6+ threads
- **Files.** src/ui/app.tsx, src/ui/styles.css

**Problem.** Confirmed by measurement, not inference. `#airship-recent-conversations` is styled `max-height: min(250px, 30vh); overflow-y: auto` (src/ui/styles.css:712-717) with `scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent`. Each thread row is 46px. The `All conversations` nav item is rendered as the LAST CHILD of that same scrolling container (src/ui/app.tsx:4699-4701). With 9 threads the container's scrollHeight is 460px in a 250px box and the link sits at y=555 — measured `visible: false`. So the only in-rail entry point to the session library disappears exactly when a person has enough conversations to need it, behind a near-invisible scrollbar and a 6th row that is hard-clipped mid-height with no fade. The route also has no `.primary-nav` style scroll mask applied even though that mask machinery already exists in the file (styles.css:630-637).

**Design.** Move the `All conversations` button OUT of `#airship-recent-conversations` and make it a pinned footer row of `.chat-nav-section`, rendered after the scroller and never clipped. Give it the count so it earns its row: `↳ All conversations · 9`.

Apply the existing `data-scroll-edges` mask pattern to `.recent-conversations` so a clipped row reads as "more below" rather than a slice, and set `scrollbar-color: var(--line-strong) transparent` to a visible track when the list overflows.

**Information fate.** Nothing changes except DOM position — one row moves up one level so it is always visible, and gains a count it did not have. Every thread row stays; they simply scroll in a container that now looks scrollable.

### Forks are invisible in the list even though the lineage data is already there

- impact **high** · effort **medium** · reclaims n/a
- **Files.** src/ui/sessions-view.tsx, src/ui/sessions-view.css

**Problem.** Performed a real fork from the library. The new session appears as an ordinary card, indistinguishable from its parent — same title stem, same runtime chips, same timestamp. `SessionListItem.sourceSessionId` is populated on every list item (src/sessions/domain.ts:215, 983) and is even included in the search haystack (line 928), but nothing in `sessions-view.tsx` renders it. Lineage surfaces in only two places: a `Branch from #d295e6de` chip in the chat header after the fork navigates away, and `.session-library-lineage` buried inside the collapsed `Runtime record` disclosure roughly 900px down the detail pane. The route description makes the claim "a fork appears only when its meaning genuinely changes" and then never demonstrates it. Compounding it, the fork title defaults to `"{title} · fork"`, so a library of nine identical "General conversation" rows gains a "General conversation · fork". Separately, the sentence `Fork = new identity · empty transcript · source untouched.` is printed twice in the same file (line 391 in the compatibility band and line 399 in the fork panel).

**Design.** LIST: when `item.sourceSessionId` is present, the state dot becomes a branch glyph and line 2 gains a prefix `↳ from "{parent title}" · head {n}`, both derived from data already in the item. The `↳` is its own control that selects the parent, so lineage is navigable in one click.

DETAIL: promote `.session-library-lineage` out of the `Runtime record` disclosure to a single line directly under the H2: `Forked from 6e8fd534…3d5b at head 1 · source untouched` with the parent id as a link.

COPY: fork title default becomes `Fork of {title}`; once auto-titles land it seeds from the source's first message. Keep `Fork = new identity · empty transcript · source untouched.` once, in the fork panel where the decision is being made; the compatibility band instead says `Continuing here requires a fork.` and defers to the panel.

**Information fate.** `sourceSessionId` and `sourceHeadSequence`: currently rendered nowhere in the list and once, deeply buried, in the detail — now rendered in both places and made navigable. The full `sourceHeadDigest` stays in the Runtime record lineage block where it belongs. The duplicated fork sentence is stated once instead of twice; no unique wording is lost.

### Session detail: three "everything is fine" bands collapse to one integrity row; rename moves onto the title

- impact **high** · effort **medium** · reclaims 177px of bands → 44px, and a 44px rename disclosure removed: 177px reclaimed from a 620px detail column (28%)
- **Files.** src/ui/sessions-view.tsx, src/ui/sessions-view.css

**Problem.** Measured in the populated detail pane: `.session-library-health` 59px + `.session-library-continuity` 56px + `.session-library-compatibility` 62px = 177px of full-width status bands, every one of them green. Above them, the `Rename conversation` disclosure (44px collapsed, ~140px open) sits ABOVE the H2 it renames — opening it pushes a "Title" label, an input and a "Save rename" button above the session title, which is backwards. Add the 92px detail heading and 313px of a 620px detail column (50%) is consumed before anything about the conversation itself. Opening `Runtime record` adds a further 563px. The continuity row prints `1 events` (src/ui/sessions-view.tsx:384) while the list card on the same screen correctly prints `1 event` (line 282). In the Runtime record, digests wrap mid-token (`sha256:C—fMEmS… / 83Ef4Lo`) in a 330px column while the adjacent transcript column is 430px wide and 90% empty, and no digest has a copy control despite being exactly the kind of value a person pastes into a proof comparison.

**Design.** ONE 44px INTEGRITY ROW replacing the three bands, three dot-pills left to right:
  `● Structure passed · ● Ready to resume · ○ 0 receipts`
The row is a button (`aria-expanded`) that reveals, verbatim, today's three sections: the `{checked} of {total} events inspected · {n} turns` counts, the `Structural linkage only · digests not recomputed · authenticity not proven` scope line, the Model pin / Receipt chain / Journal head cells, and the compatibility reasons list or its "Provider, model, posture, tool manifest, workspace, and profile digests match the active runtime." fallback. FAIL-OPEN RULE: if any of the three is not green, the row renders in its warning colour and auto-expands, so a problem is never one click away.

RENAME: delete the disclosure. The H2 becomes inline-editable — click or Enter on focus swaps to an input in place, Esc cancels, Enter/blur saves, same 240-char cap, same `Renamed session to {title}.` announcement.

RUNTIME RECORD: swap the column ratio so the dense manifest gets the wide column and the transcript the narrow one; add a copy button to each `<Digest>` (the full value is already in `title`).

FIX: `{n} event{n === 1 ? "" : "s"}` in the continuity row.

**Information fate.** Journal structure label, checked/total event counts, turn count, the "Structural linkage only" scope caveat, lifecycle state and turn id, model pin, receipt chain count, journal head, the runtime decision label and every compatibility reason with its severity class: all preserved word for word inside the expansion, and auto-shown whenever any is not green. Rename form: same field, same cap, same announcement, relocated onto the title. Digests: unchanged, plus a copy affordance.

### Phone profiles: the carousel hides two of three profiles and deletes the posture claim

- impact **high** · effort **medium** · reclaims 126px carousel → a 44px switcher row inside the route bar; with the header fix, first content moves from y272 (37% of viewport) to roughly y110 (15%)
- **Files.** src/ui/styles.css, src/ui/app.tsx

**Problem.** At 430x740, `.profile-card-list` becomes `display: flex; overflow-x: auto; scrollbar-width: none` with `.profile-card-list::-webkit-scrollbar { display: none }` and cards at `flex: 0 0 min(78vw, 270px)` (src/ui/styles.css:5825-5840). Result, verified in a screenshot: profile 2 is clipped mid-word ("Find, compar" / "sources in vie") with no ellipsis, profile 3 is entirely off-screen, and there is no scrollbar, no dot indicator and no count — a phone user cannot tell there are three profiles. Two lines further, `.profile-card .posture-chip { display: none }` (styles.css:5843) deletes the minimum-proof claim on phones, which is precisely the kind of information loss the governing constraint forbids. Separately, content starts at y272 = 37% of the 740px viewport, and the collapsed editor scrolls to 1130px (2084px with disclosures open) with `Save new revision` at y1676 — 2.6 viewports below the fold, with no sticky action bar.

**Design.** At ≤640px replace the carousel with the `MenuSelect` profile switcher that already exists in `.profile-switcher` (src/ui/app.tsx:4749-4760), rendered in the route bar as `[GE] General · active ⌄`. Every profile is reachable, each option row carrying monogram + name + description (MenuSelect already renders a `description` slot) + a coloured posture dot, with `active` marked. No horizontal scroll, no hidden items, no count to guess.

Add a 56px sticky footer above the mobile nav, shown whenever the draft is dirty: `Unsaved changes` on the left, `Save new revision` on the right — same handlers, same disabled logic.

**Information fate.** Profile name, description and active marker: move from clipped cards into MenuSelect option rows, fully legible. Minimum proof posture: currently DELETED on phone — returns as a coloured dot in each option row (with the posture name as the option's accessible description) and as a text value in the always-visible Governs strip. The `+ Fork` button moves next to the switcher. Nothing is hidden; the carousel itself is what goes.

### One route header contract for #profiles, #account and #sessions

- impact **high** · effort **medium** · reclaims 131px on #profiles, 117px on #sessions, 109px on #account, plus the 44px storage callout and the ~88px journal-adapter panel folded into chips — roughly 200-260px per route
- **Files.** src/ui/app.tsx, src/ui/billing-view.tsx, src/ui/sessions-view.tsx, src/ui/styles.css

**Problem.** All three routes open with the same three-part slab: a monospace uppercase eyebrow, a 47px Georgia H1 and a 13px paragraph. Measured at 1440x900: `.page-heading` is 131px on #profiles (on top of a 47px hub-tab row → 288px, 32% of viewport, before the first card); 117px on #sessions (215px, 24%, before the first conversation); 109px on #account (356px, 40%, before the balance, because the trust-hub tabs and a 64px toolbar sit between). Type audit: `.page-heading h1` is 47px/500 Georgia; `.profile-card strong`, `.profile-form label > span`, `.panel-heading > span` and `.profile-actions button` are all 11.69px — the biggest element on screen is 4x the size of the densest and carries no information the nav does not already carry. "Profiles" appears four times on the profiles screen (sidebar item, gold active tab, H1, catalog panel heading). The eyebrow "DIRECT USER-SCOPED CHUTES TELEMETRY" and the paragraph "See balance, provider-reported charges, subscription runway, and live limits directly from Chutes" then get restated by the gate's `What becomes available` details.

**Design.** `PageHeading` (src/ui/app.tsx:6990) and the two hand-rolled equivalents in `billing-view.tsx:83-87` and `sessions-view.tsx:186-193` become one `RouteBar`: a single 44px row —

  `{title 20px}  ·  {live state chips}  ─────────────  {route actions}`

On routes that already carry a tab row (profiles/capabilities/skills; proof/vault/connection/account) the title is dropped entirely — the gold active tab already IS the title, so the word is stated once instead of three or four times.

The eyebrow and description move into an info popover on a `?` control anchored to the bar, `aria-describedby`-linked, with the copy unchanged character for character.

Live state chips per route: #profiles → `3 profiles · General active · page memory`; #sessions → `9 conversations · Ephemeral`; #account → `Connected · verified 10:33 AM`. The chips replace bands that currently sit below the heading (`.compact-callout` storage status on profiles, `.session-library-origin` on sessions, `.billing-toolbar` status line on account), each expanding on click to its full existing text.

NOTE: `PageHeading` is shared with routes outside this lane; this proposal specifies the contract and the three call sites here, and hands the shared component change to the design-system lane.

**Information fate.** Eyebrow text: unchanged, moves into the info popover's first line. Description text: unchanged, moves into the popover body. H1 word: becomes the active tab (already present) or a 20px title. Storage-status callout / journal-adapter panel / credential-freshness line: each becomes a chip in the bar that expands to its exact current wording. Nothing is rewritten and nothing is dropped.

### Account connected: collapse the empty 205px runway triptych into one subscription row

- impact **high** · effort **small** · reclaims 205px → 56px in the common inactive case: 149px, or 17% of a 900px viewport
- **Files.** src/ui/billing-view.tsx

**Problem.** Connected with a live key: `.runway-grid` measures 1156x205 = 26% of a 900px viewport, and all three cards are empty. `BURST PROTECTION / Fixed four-hour UTC bucket` and `COVERED PLAN USAGE / Subscription cycle` both render only `Chutes reported no active subscription`, and `LATEST INVOCATION / Live headroom` renders only `Run a Chutes turn to observe headers`. Each card spends 205px to display one 13px sentence with roughly 90px of padding above and below it. "Chutes reported no active subscription" is printed three times within 200px — once as the Subscription metric's detail, twice as runway bodies. For any user without a plan (the common case) a quarter of the screen is a triptych of "no". `Live headroom` is not a subscription fact at all and should not be sitting in a grid that is gated on one.

**Design.** When `subscriptionState.value?.active === false`, render one 56px row in place of the two subscription runway cards:

  `Subscription · Inactive` — `Chutes reported no active subscription. Burst and cycle windows are not published for inactive plans.` — right-aligned `Add a plan at Chutes ↗`

When a subscription IS active, both `RunwayCard`s render exactly as today, with the usage/cap bar, the `runway-track`, the remaining/reset foot and the exhausted-allowance paragraph.

Move `LiveTelemetryCard` out of the runway grid and into the metrics row as a fifth tile (`Live headroom`, value `{quota.remaining} / {quota.total}`, detail `observed {time}`). Its empty state becomes the tile's `—` with detail `Run a Chutes turn to observe headers`.

De-duplicate: the Subscription metric's detail keeps `Chutes reported no active subscription; payment mode is not inferred.` and the collapsed row states the windows fact only — the phrase appears once, not three times.

**Information fate.** Both `RunwayCard` bodies preserved verbatim for the active case, including the `sourceStatus !== "verified"` and `!window` branches which stay as the row's alternate text. The exact provider sentence survives, stated once. Quota remaining, user rate limit, chute rate limit and observed time from `LiveTelemetryCard`: all four stay, in the fifth metric tile's expansion.

### Account: the usage chart has no axis and duplicates the ledger with no linkage

- impact **medium** · effort **medium** · reclaims n/a
- **Files.** src/ui/billing-view.tsx, src/ui/styles.css

**Problem.** The `UsageBars` strip renders up to 64 bars at 180px with no y scale, no x scale, no baseline rule and no legend. `Math.max(3, (entry.cost / max) * 100)` floors every small bucket at 3%, so in the live capture roughly 14 different buckets all render as identical stubs — the chart actively misrepresents its own data at the low end. The only time context is the panel heading `JUL 1 → JUL 27`, so a reader cannot tell which end of the strip is which date. It is `role="img"` with a single aria-label, and per-bar detail lives in a `title` attribute only, which keyboard users never reach. Underneath, the `usage-ledger` reprints the same ten buckets as text — the same information twice, with no hover sync, no shared selection, and no way to get from a bar to its row.

**Design.** Keep both representations and bind them.

1. Two-tick y label rendered flush left against the bar strip: `$0` at the baseline and `${max}` at the top, plus a 1px baseline rule so a zero bucket reads differently from a near-zero one.
2. Three x labels under the strip, derived from `usageState.value.rangeStart/rangeEnd`: `Jul 1 · Jul 14 · Jul 27`.
3. Each bar becomes a focusable `<button>` in a roving-tabindex group with the accessible name already present in `title`: `Jul 27, 10 AM EDT · $0.2871 · 38 requests`. Hover/focus on a bar highlights the matching `usage-ledger-row`; hover/focus on a row highlights its bar.
4. Change the floor from `Math.max(3, …)` to `Math.max(1, …)`.
5. The ledger caps at 10 rows today with no indication there are more — add `Showing the 10 most recent of {n} buckets` to the panel heading.

**Information fate.** Every bucket keeps its cost, request count and timestamp; the `title` string becomes a real accessible name rather than a mouse-only affordance. The ledger table stays exactly as it is, plus a truthful count of what it is not showing. The `JUL 1 → JUL 27` heading stays and is now also readable off the axis.

### Profiles layout: sticky catalog on desktop, single column on tablet

- impact **medium** · effort **small** · reclaims iPad: 409px of dead space (34% of viewport) becomes usable editor width and height; desktop: a ~700x362px dead gutter becomes a sticky profile list
- **Files.** src/ui/styles.css, src/ui/app.tsx

**Problem.** Desktop 1440x900: `.profile-catalog` is 362x398 and does not stick, so once the editor is expanded and scrolled the left column is a roughly 700x362px dead gutter — 25% of the content area showing nothing. iPad Pro 11 (834x1194): `.management-layout` is `210px minmax(0, 1fr)` at that breakpoint (src/ui/styles.css:5004-5006), which squeezes `A capable everyday agent for clear, useful work.` to five wrapped lines and `Minimum posture / ○ Local` to two, while content ends at y785 and 409px (34% of the viewport) sits empty below the storage callout. Several cells truncate with no `title`: `RUNTIME airship-dem…`, the ROLE input clipping its own value, and the theme cards clipping `restrained brass and verdigris…` and `blued steel and cool archival…`.

**Design.** At ≥1025px: `.profile-catalog { position: sticky; top: 0; max-height: calc(100dvh - var(--route-gutter-block) * 2); overflow-y: auto; }` so the gutter carries the profile list for the full scroll of the editor instead of scrolling away.

At 641-1024px: `.management-layout` becomes a single column with the catalog rendered as the same `MenuSelect` switcher specified for phone, which removes the 210px squeeze entirely and lets the editor use the full 730px — and lets the editor's content fill the 409px that is currently void.

Add `title` to every truncating cell: the revision-strip runtime value, the ROLE input, and each theme card description.

**Information fate.** Nothing moves between screens; this is purely geometry plus restoring truncated text to hover/focus. Profile descriptions and theme descriptions that currently clip with no recovery path gain a `title`; on tablet the descriptions render in the MenuSelect `description` slot at full width.

### Account: two money formats, not one

- impact **medium** · effort **small** · reclaims n/a
- **Files.** src/ui/billing-view.tsx, src/ui/styles.css

**Problem.** `formatUsd` (src/ui/billing-view.tsx:332) is a single formatter with `minimumFractionDigits: 2, maximumFractionDigits: 4` used for every currency value on the route. Live result: the wallet balance renders as `$46.2054` — four decimal places on the number that determines whether a person can work, reading like a token price rather than a balance. In the ledger's Charged column the same formatter produces `$0.2871`, `$0.08`, `$0.0823`, `$0.016`, `$0.0072` and `$0.0015` in adjacent rows, so nothing aligns on the decimal point and the column is unscannable. The column is also not tabular-figure.

**Design.** Split into `formatUsd(value, mode)`:

  `headline` → `maximumFractionDigits: 2`, used by the balance metric, the subscription monthly price and `Charged this UTC month`. The exact value moves to the tile's detail line and to a `title`: balance detail becomes `Effective USD balance reported by the Chutes account endpoint · exactly $46.2054`.

  `ledger` → fixed 4 decimal places (so `$0.0800`, not `$0.08`), `font-variant-numeric: tabular-nums`, right-aligned, decimal-aligned; applied to the Charged column, the runway usage/cap/remaining values and the bar tooltips.

**Information fate.** Full four-decimal precision is never lost — it moves to the metric's detail line and `title` for headline values, and is what the ledger renders. Only the visual weight changes: the balance reads as money, the ledger reads as a column.

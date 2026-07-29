# Source Control workbench inventory

This inventory is the WKS-05 removal gate. The historical route-level
**Sources** mode may disappear only while every control below retains one
tested home under **Workspace → Source Control**. The compact rail handles the
daily path; **Advanced source controls** is a modal sheet in that same
workbench. Opening the sheet never unmounts the editor, its preview/pinned tabs,
or profile-local drafts.

## Compact Source Control rail

| Capability | Workbench home |
| --- | --- |
| Repository and worktree selection | Repository/worktree selectors at the top of Source Control |
| Refresh | Source Control toolbar |
| Branch, head, and changed-path count | Source Control summary |
| Staged and working status | Staged and Changes path groups |
| Stage/unstage one or all visible paths | Per-path actions and group actions |
| Working/staged diff | Shared preview/pinned editor document |
| Local commit | Commit message and Commit staged action |
| Recent bounded history | History group; commit patch opens as an editor document |
| Reveal current file or Git path | Active file/diff strip; exact Explorer expansion and focus |
| Import/advanced entry | Advanced source controls action, present even when no repository exists |

## Advanced source controls sheet

| Capability retained from the former Sources mode | Tested home in the sheet |
| --- | --- |
| Public GitHub snapshot import | Import disclosure with URL/ref/destination, approval, progress, receipt, and explicit snapshot omissions |
| Source trust and durability posture | Source posture disclosure |
| Empty-adapter recovery | Import and recheck actions plus clone-capability statement |
| Full status selection | Tree/Flat presentations, checkboxes, conflict exclusions, Stage selected, and Unstage selected |
| Detailed history | Bounded 50-commit list, branch/tag refs, per-commit changed paths, and bounded diff inspector |
| Repository selection and metadata | Repository disclosure and selector, storage posture, head, and last-fetch fact |
| Worktree selection | Full worktree list with branch, path, and change count |
| Branch checkout and creation | Switch branch, Switch checkout, and Create branch controls |
| Linked-worktree creation/removal | Branch/path inputs, Create worktree, and Remove selected worktree |
| Local commit | Staged count, author, message, and separately reviewed Commit locally action |
| Existing remote boundary | Remote URL/transport/upstream fact, capability-gated Fetch direct and Push, credential boundary, ambiguous-result warning, and CSP pointer |
| Refresh/reconciliation | Header refresh and version-conflict refresh without discarding the selected paths before fresh state arrives |

The sheet is not a second destination: it is rendered modally inside the
workbench panel, the compact Source Control rail stays mounted underneath, and
Escape, the explicit close action, or the backdrop returns focus to the action
that opened it. Desktop and mobile use the same DOM and control inventory. Its
open state and component instance are fenced by the collision-safe active
Profile + workspace authority; changing either removes the prior sheet in the
same render, before that repository inventory can appear under the new silo.

## Compatibility and tests

- `#sources` is accepted as a legacy input and replaced with canonical
  `#editor`. New navigation emits no Sources destination or route tab; the one
  Source Control activity and its Advanced source controls action are present
  in that unified workbench.
- `e2e/workspace-source-controls.spec.ts` compares the advanced control
  inventory on desktop and mobile, proves keyboard containment/focus return,
  exercises the compatibility redirect, and switches Profiles while the sheet
  is open to prove that the prior selection and inventory are discarded.
- `e2e/workspace-workbench.spec.ts` covers the compact rail, shared diff tabs,
  file icons, Reveal in Explorer, staging, preview/pin, and mobile pane switch.
- `e2e/github-import.spec.ts` remains the live import/commit/branch/worktree and
  encrypted-reload contract through the new workbench entry.

## Boundaries not created by the removal

This move does not claim capabilities the former UI lacked. Authenticated
GitHub transport, a general empty-repository creator, remote add/remove UI,
full-history clone where browser CORS forbids it, deterministic export, and the
requested collapsible origin commit→file tree remain separate backlog work.

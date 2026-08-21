# VISUALIZE — the complete Airship user journey

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../SIMPLIFICATION.md`](../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

The purpose of this document is to describe **everything a person can do in
Airship**, in the order they would plausibly meet it, in a fully healthy system.
It is the script for visual capture: every state named here should be
photographable, including the transitional states — a dropdown mid-open, a field
mid-type, a toggle mid-throw, a turn mid-stream.

It describes the product as it *is*, not as it should be. Where behaviour is
conditional, the condition is named so a capture team knows how to reach it.

Conventions used below:

- **Route** — a destination reachable from the rail or a hash URL.
- **Moment** — a state worth a photograph.
- ▸ marks a **transition** (hover, click, focus, type, open, close, drag).
- Viewports: desktop `1440×900`, laptop `1280×800`, tablet `iPad Pro 11`,
  phone `iPhone 14 Pro Max`, small phone `360×800`.

---

## 0. The frame

Every route renders inside one shell.

| Region | Contains |
|---|---|
| Topbar (58px) | Brand + edition, the four-axis trust chip, the primary inference action, live runtime status, ⌘K palette, preferences, proof shortcut |
| Rail (left) | Work: Chat, Workspace (→ Editor, Terminal), Memory · Receipts & Access: Proof, Vault, Connection, Account · a profile row pinned at the base |
| Main | The route |
| Composer | Chat only, pinned to the bottom |

On tablet the rail becomes an icon rail. On phone it becomes a bottom tab bar —
Chat, Workspace, Trust, More — and the rail is gone.

**Moments**
1. Shell at rest, each viewport.
2. ▸ Rail collapse toggled (`⌘\`) — collapsing, collapsed, hover-revealed label.
3. ▸ Trust chip hovered, then opened — the four-axis sheet.
4. ▸ ⌘K palette: closed → open → typed query → arrowed selection → executed.
5. ▸ Preferences opened: theme, type scale, density, corners, body font, each toggled.
6. Phone: bottom tab bar, and ▸ "More" opened.

---

## 1. First arrival — no credentials, no vault

A person lands on `#chat`. Nothing is configured. This is the screen that has to
explain the product.

**What is true here:** the workspace, editor, terminal and browser-owned Git all
work with no account. Only model-backed chat needs a provider. The composer runs
a deterministic local demo until one is connected.

**Moments**
1. Empty chat, each viewport.
2. The first-run block and its three starter cards.
3. ▸ Each starter card hovered, then clicked (Open a terminal / Browse the
   workspace / Connect a model).
4. ▸ Composer focused, ▸ typed, ▸ `/` typed → slash menu open → arrowed → accepted.
5. ▸ A local demo turn sent: submitted → streaming → settled.
6. ▸ The trust chip opened from this state (nothing connected yet).

---

## 2. Connecting a model — `#access`

Five lanes, all reachable at once. Connecting one must never close the others.

| Lane | Route to working |
|---|---|
| Chutes | Sign in (PKCE), or paste a `cpk_` API key |
| Codex (OpenAI) | Sign in with ChatGPT → paste the code back from the address bar |
| Claude (Anthropic) | Requires the Airship Companion extension; API key otherwise |
| Grok (xAI) | Requires the extension |
| Local | Ollama / LM Studio on loopback |
| Companion | The extension itself — install, presence, what it does |

**Moments**
1. `#access` at rest, all lanes visible, each viewport.
2. ▸ Each lane opened and closed in turn.
3. ▸ Method tabs switched (OAuth ↔ API key) inside a lane.
4. ▸ The Chutes key field: empty → focused → typed (masked) → submitted → discovering.
5. Model picker: ▸ trigger clicked → open → ▸ search typed → filtered → ▸ option
   hovered → ▸ selected → closed. Include the pagination control at >30 models.
6. The post-discovery state: model summary, capability metadata, proof policy.
7. ▸ Proof policy switched between options.
8. ▸ "Finish: verify & connect" pressed → verifying → connected → landed on chat.
9. Codex lane: ▸ "Sign in with ChatGPT" pressed → the warning that the next page
   will look like an error → the paste field → ▸ pasted → validated → exchanged.
10. Claude / Grok lanes with the extension **absent**: the honest unavailable
    state and its install route. And on a browser that cannot host extensions.
11. Local lane: ▸ "Check this machine" pressed → probing → answered/refused rows.
12. Connected state: a lane showing connected, others still open.

---

## 3. A real conversation

The core loop.

**Moments**
1. Connected chat at rest, model named in the session bar.
2. ▸ A question typed and sent → thinking → streaming tokens → settled.
3. A turn with **tool calls**: the operation strip, ▸ expanded, ▸ collapsed.
   Capture streaming and settled separately.
4. A turn that **fails** (ask for a missing file) — the error and its recovery.
5. ▸ A turn interrupted mid-stream (Stop) — partial kept, retry offered.
6. Message actions: ▸ hovered (desktop) / ▸ disclosure tapped (touch) →
   Copy, Retry, Edit & resend, Fork session.
7. ▸ An approval prompt: raised → its explanation → Approve and Deny paths.
8. ▸ The approval policy control: Ask First → Auto Approve → Full Access.
9. ▸ An image attached: picker → attached chip → sent → vision answer.
10. Long output: code blocks, syntax highlighting, ▸ Copy on a code block,
    tables, a rendered diff.
11. ▸ The receipt chip clicked → what it opens.
12. ▸ Model switched mid-conversation — what warns, what forks.
13. ▸ Scrolled up mid-stream → the jump-to-latest affordance → ▸ pressed.

---

## 4. Workspace and Editor

**Moments**
1. `#workspace` at rest, tree populated.
2. ▸ Filter typed → tree filtered → count updated.
3. ▸ A folder expanded / collapsed; ▸ a file opened.
4. Editor with a file open: content, status strip, revision, byte size.
5. ▸ Text edited → dirty state → ▸ saved (`⌘S`) → saved state.
6. ▸ Tabs: several opened, ▸ overflow panel opened, ▸ a tab closed.
7. ▸ New file, ▸ New folder — dialog open, typed, confirmed.
8. ▸ A file renamed, ▸ moved (dialog names the file), ▸ deleted (and its
   confirmation).
9. ▸ Context menu opened on a file and on a folder.
10. Empty workspace state.
11. Phone and tablet: what the workbench becomes.

## 5. Source Control

**Moments**
1. Sources tab with changes staged and unstaged.
2. ▸ A file's diff opened — additions, deletions, line numbers.
3. ▸ Staged, ▸ unstaged, ▸ discarded (and its confirmation).
4. ▸ A commit message typed → ▸ committed → result.
5. ▸ Branch switched, ▸ created.
6. History: log, show, tag, stash — wherever these surface.
7. ▸ Import a public GitHub snapshot: URL typed → importing → imported.
8. The remote/CORS boundary explanation.

## 6. Terminal

**Moments**
1. `#terminal` at rest — the runtime explanation and the process state.
2. ▸ A command typed and run → streaming output → prompt returns.
3. ▸ A long-output command; ▸ a failing command; ▸ `ctrl-c` cancellation.
4. ▸ The Shared Git bridge used.
5. ▸ A new terminal opened, ▸ restarted, ▸ closed.
6. Reload → the reconstruction boundary.

---

## 7. Memory

**Moments**
1. `#memory` unsearched — the starter chips.
2. ▸ A query typed → searching → results across three scopes.
3. ▸ A result expanded — its lineage: revision, digest, extractor, chunker,
   embedding posture, scope.
4. ▸ A zero-result query and what it says.
5. Graph tab: at rest, ▸ a node selected, ▸ the term filter used.
6. Index tab: sources, chunk counts, the embedding engine named.

## 8. Proof

**Moments**
1. `#proof` with **no** completed turn — the eight absences, open.
2. `#proof` after a real turn — the hero verdict, the counts, the claim rows.
3. ▸ A claim row expanded — its qualifier and ceiling sentence.
4. Attestation evidence tab — the matrix, ▸ a record opened.
5. ▸ Receipt copied, ▸ verification bundle exported.
6. Journal integrity: ▸ expanded, the six structure checks.
7. The claim rail in chat, ▸ opened from the receipt chip.

## 9. Vault

**Moments**
1. `#vault` at rest — the three providers compared.
2. ▸ Provider switched (Ephemeral → Local Device → S3 → Google Drive).
3. Local Device: ▸ enrolled → ▸ the recovery-key ceremony → ▸ confirmed →
   ▸ backup exported → ▸ restored.
4. S3/MinIO: ▸ the form filled field by field → ▸ connected → adopted state.
5. Google Drive with no client ID — the honest unavailable state.
6. Google Drive configured — ▸ the consent flow.
7. ▸ Disconnected, and what warns.

## 10. Connection, Account, Profiles, Sessions

**Moments**
1. `#account` disconnected, then connected — balance, charges, runway, limits.
2. `#profiles` — the list, ▸ one opened, ▸ edited, ▸ forked, ▸ deleted.
3. ▸ The pinned profile row switched.
4. Session list in the rail; ▸ "All conversations" opened.
5. ▸ A conversation renamed, ▸ forked, ▸ resumed, ▸ deleted.
6. ▸ Filtered to zero results — what the detail pane does.
7. Session integrity — ▸ expanded.

---

## 11. Cross-cutting states

Each of these should be photographed wherever it can occur.

- **Loading** — route skeletons, streaming, probing, discovering.
- **Empty** — every route with nothing in it.
- **Error** — network lost, provider refused, storage failed, import blocked.
- **Offline** — the whole shell with the network down.
- **Disabled** — every control that can be disabled, and why it says it is.
- **Focus** — the ring on every interactive element, keyboard-only traversal.
- **Reduced motion** and **forced colours**.
- **200% zoom** at 1280×800.
- **Long content** — a very long file name, a very long model name, a 40-item
  conversation list, a 500-line file.

---

## 12. What "healthy" means for capture

To reach the states above, a capture run needs:

- The local lab running (`npm run lab:start`) — UI on `:4173`, MinIO on `:9900`.
- A live Chutes key in the environment, never written to disk.
- A populated workspace: several files, nested folders, a long file, staged and
  unstaged Git changes, and at least one completed conversation with tool calls.
- MinIO credentials for the vault path: endpoint `http://127.0.0.1:9900`, region
  `us-east-1`, bucket `airship-dev`, namespace `airship-live-v2/local-user`,
  access key `airship-vault-probe`, secret `airship-vault-probe-only-2026`.

States that **cannot** be reached locally, and must be reported as such rather
than faked: a configured Google Drive consent flow, a real Anthropic or xAI
OAuth grant, and a receipt-declared claim **failure** (the live endpoint has not
produced one).

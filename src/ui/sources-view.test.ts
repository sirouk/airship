import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildStatusTree,
  commitRefs,
  commitSubject,
  deltaLetter,
  diffComparisonLabel,
  diffPlaceholder,
  parseUnifiedPatch,
  cloneBoundaryNote,
  remoteBoundaryParagraphs,
  remoteTransportLabel,
  sourcePostureFacts,
  sourceRemoteOperation,
} from "./sources-view";
import { isRemoteOriginPermitted } from "../git/validation";
import type { BrowserGitClient } from "../git/client";

type Capabilities = BrowserGitClient["capabilities"];

const capabilities = (overrides: Partial<Capabilities> = {}): Capabilities => ({
  adapterId: "test",
  adapterName: "Test adapter",
  storage: { backend: "memory", durable: false, detail: "A genuine .git object database lives in this page's workspace." },
  remote: {
    transport: "direct-git-http",
    requiresCors: true,
    credentialPersistence: "none",
    permittedOrigins: ["http://127.0.0.1:4173"],
    detail: "isomorphic-git speaks Smart HTTP directly and Airship never inserts a proxy.",
  },
  features: {} as Capabilities["features"],
  ...overrides,
} as Capabilities);

describe("Sources presentation", () => {
  it("uses letters for all five change kinds", () => {
    expect(["added", "modified", "deleted", "renamed", "conflicted"].map((kind) => deltaLetter(kind as never))).toEqual(["A", "M", "D", "R", "C"]);
  });
  /*
   * `diffLineKind` was a third answer to "what kind of line is this", living in
   * the same file as the parser that already answers it from the `@@` counters.
   * `grep -rn diffLineKind src/` returned its own declaration and these
   * assertions and nothing else — a dead export kept alive by its own test. The
   * same four cases are asserted against the renderer that ships.
   */
  it("does not color diff headers as file additions/removals", () => {
    const parsed = parseUnifiedPatch([
      "diff --git a/file b/file",
      "--- a/file",
      "+++ b/file",
      "@@ -1,2 +1,2 @@",
      "-removed",
      "+added",
    ].join("\n"));
    expect(parsed.lines.filter((line) => line.kind === "added").map((line) => line.text)).toEqual(["added"]);
    expect(parsed.lines.filter((line) => line.kind === "removed").map((line) => line.text)).toEqual(["removed"]);
    expect(parsed.header).toContain("--- a/file");
    expect(parsed.header).toContain("+++ b/file");
  });
  it("projects changed paths into a deterministic folder-first tree", () => {
    const entry = (path: string) => ({ path, index: null, worktree: { kind: "modified" as const } });
    const tree = buildStatusTree([entry("README.md"), entry("src/z.ts"), entry("src/lib/a.ts")]);
    expect(tree.map((node) => [node.kind, node.name])).toEqual([["folder", "src"], ["file", "README.md"]]);
    expect(tree[0]?.children.map((node) => [node.kind, node.name])).toEqual([["folder", "lib"], ["file", "z.ts"]]);
    expect(tree[0]?.children[0]?.children[0]?.entry?.path).toBe("src/lib/a.ts");
  });
});

describe("unified patch parsing", () => {
  const patch = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,3 +1,4 @@",
    " # Airship workspace",
    "-old line",
    "+new line",
    "+another",
    " tail",
  ].join("\n");

  it("keeps the file header out of the code body without discarding it", () => {
    const parsed = parseUnifiedPatch(patch);
    expect(parsed.header).toEqual(["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md"]);
    expect(parsed.lines.some((line) => line.raw.startsWith("---"))).toBe(false);
  });

  it("numbers the file, not the array, from the hunk header", () => {
    const parsed = parseUnifiedPatch(patch);
    const body = parsed.lines.filter((line) => line.kind !== "hunk");
    expect(body.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1],
      ["removed", 2, undefined],
      ["added", undefined, 2],
      ["added", undefined, 3],
      ["context", 3, 4],
    ]);
  });

  it("prints the sign once by stripping it from the code text", () => {
    const parsed = parseUnifiedPatch(patch);
    const added = parsed.lines.find((line) => line.kind === "added");
    expect(added?.sign).toBe("+");
    expect(added?.text).toBe("new line");
    const removed = parsed.lines.find((line) => line.kind === "removed");
    expect(removed?.sign).toBe("−");
    expect(removed?.text).toBe("old line");
  });

  it("renders a hunk header verbatim as its own row", () => {
    const hunk = parseUnifiedPatch(patch).lines.find((line) => line.kind === "hunk");
    expect(hunk?.raw).toBe("@@ -1,3 +1,4 @@");
    expect(hunk?.oldLine).toBeUndefined();
  });

  it("restarts the counters at every hunk", () => {
    const parsed = parseUnifiedPatch(["@@ -1,1 +1,1 @@", " a", "@@ -40,1 +52,1 @@", " b"].join("\n"));
    const body = parsed.lines.filter((line) => line.kind === "context");
    expect(body.map((line) => [line.oldLine, line.newLine])).toEqual([[1, 1], [40, 52]]);
  });

  it("keeps the no-newline marker without numbering it", () => {
    const parsed = parseUnifiedPatch(["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file"].join("\n"));
    const marker = parsed.lines.at(-1);
    expect(marker?.raw).toBe("\\ No newline at end of file");
    expect(marker?.oldLine).toBeUndefined();
    expect(marker?.newLine).toBeUndefined();
  });

  it("yields nothing to draw for an empty patch", () => {
    expect(parseUnifiedPatch("").lines).toHaveLength(0);
  });

  /*
   * Driven by the shape this product's own adapters emit.
   *
   * The first version of this test hand-wrote `diff --git` headers, and the
   * parser it was proving keyed its file boundary on exactly that string —
   * which neither `renderPatch` in git/workspace-adapter.ts nor the one in
   * git/memory-adapter.ts has ever written. Both emit `--- a/<path>` /
   * `+++ b/<path>` / `@@` and nothing else. So the test passed, and every
   * commit touching two or more files rendered its second header as a red
   * deleted line reading `-- a/second.ts` at a fabricated line number.
   *
   * A test that asserts an input format the product cannot produce is worse
   * than no test: it converts an unnoticed bug into a defended one. These two
   * cases are the adapter shape first, then the git-remote shape.
   */
  it("does not number a second file's header as a deleted line of the first", () => {
    // Exactly what workspace-adapter.ts / memory-adapter.ts concatenate: no
    // `diff --git` line anywhere in the document.
    const parsed = parseUnifiedPatch([
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -10,1 +10,1 @@",
      "-second old",
      "+second new",
    ].join("\n"));
    expect(parsed.header).toEqual(["--- a/first.ts", "+++ b/first.ts"]);
    expect(parsed.lines.filter((line) => line.kind === "removed").map((line) => [line.text, line.oldLine]))
      .toEqual([["old", 1], ["second old", 10]]);
    // The second file's header is a boundary band, not content, and carries no
    // line number of the file it just ended.
    expect(parsed.lines.filter((line) => line.kind === "hunk").map((line) => line.raw)).toEqual([
      "@@ -1,1 +1,1 @@",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -10,1 +10,1 @@",
    ]);
  });

  it("also reads the `diff --git` boundary a real git remote sends", () => {
    const parsed = parseUnifiedPatch([
      "diff --git a/first.ts b/first.ts",
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/second.ts b/second.ts",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -10,1 +10,1 @@",
      "-second old",
      "+second new",
    ].join("\n"));
    expect(parsed.lines.filter((line) => line.kind === "removed").map((line) => [line.text, line.oldLine]))
      .toEqual([["old", 1], ["second old", 10]]);
  });

  /*
   * The one line a content-shaped `--- ` must NOT be mistaken for. Inside a
   * hunk every row carries a one-character prefix, so `--- a/x` is a removal of
   * the text `-- a/x`; it is only a file boundary when a `+++ ` row follows it.
   */
  it("does not treat a removed line that looks like a header as a file boundary", () => {
    const parsed = parseUnifiedPatch([
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,3 +1,2 @@",
      "--- a/quoted.ts",
      "-still removed",
      "+kept",
    ].join("\n"));
    expect(parsed.lines.filter((line) => line.kind === "removed").map((line) => [line.text, line.oldLine]))
      .toEqual([["-- a/quoted.ts", 1], ["still removed", 2]]);
  });
});

describe("one patch renderer for both panes of the Workspace route", () => {
  /*
   * Source Control and the Workbench diff tab render on one route, and the
   * Workbench pane printed the same `git.diff` result as undifferentiated text:
   * no line numbers, no added/removed colour, the `diff --git`/`index` preamble
   * left inline. The fix is only real if the second renderer is *gone*, so this
   * asserts the source rather than a rendered copy of it.
   */
  const workspaceView = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
  const sourcesView = readFileSync(new URL("./sources-view.tsx", import.meta.url), "utf8");

  it("leaves no second diff renderer in the workbench pane", () => {
    expect(workspaceView).not.toMatch(/<pre[^>]*workspace-diff/u);
    // The named set grows as the rail stops re-implementing this module's
    // vocabulary — `deltaLetter` joined when Source Control's status letters
    // moved off an inline ternary chain — so the claim is that `UnifiedPatch`
    // arrives from here, not that it arrives alone.
    expect(workspaceView).toMatch(/import \{[^}]*\bUnifiedPatch\b[^}]*\} from "\.\/sources-view"/u);
    expect(workspaceView).toMatch(/<UnifiedPatch\b/u);
  });

  it("keeps exactly one classifier for a diff line", () => {
    // `diffLineKind` was the third answer, dead except for its own test.
    expect(sourcesView).not.toMatch(/function diffLineKind/u);
    expect([...sourcesView.matchAll(/class=\{`git-diff-lines /gu)]).toHaveLength(1);
  });
});

describe("diff panel copy", () => {
  it("says which two things are being compared instead of printing the enum", () => {
    expect(diffComparisonLabel("worktree")).toBe("working tree vs index");
    expect(diffComparisonLabel("staged")).toBe("index vs HEAD");
  });

  it("distinguishes nothing-selected from this-file-has-no-textual-change", () => {
    expect(diffPlaceholder({})).toContain("Choose a staged or working diff");
    expect(diffPlaceholder({ diff: { path: "queue.ts" } as never })).toBe(
      "No textual change in queue.ts. The comparison returned an empty patch.",
    );
    expect(diffPlaceholder({ busy: "diff:queue.ts:worktree" })).toBe("Computing this patch locally…");
  });
});

describe("source posture", () => {
  it("merges the two durability pills only while the two scopes agree", () => {
    const merged = sourcePostureFacts(capabilities(), { state: "ephemeral", detail: "Workspace files exist only in this page runtime." });
    const durability = merged.filter((fact) => fact.id.startsWith("durability"));
    expect(durability).toHaveLength(1);
    // Scoped even when merged, so it can never read byte-identically to the
    // workspace-only durability chip the route header above it already shows.
    // Copy corrected: the posture keeps one continuity line per conversation,
    // so an unqualified "page memory only" / "nothing survives" was a claim the
    // product does not honour. See `EPHEMERAL_RETENTION_DISCLOSURE`.
    expect(durability[0]?.label).toBe("Workspace & Git index · Ephemeral · content not saved");
    // Both original sentences survive inside the merged fact.
    expect(durability[0]?.detail).toContain("Workspace files exist only in this page runtime.");
    expect(durability[0]?.detail).toContain("A genuine .git object database");

    const split = sourcePostureFacts(
      capabilities({ storage: { backend: "encrypted-workspace", durable: true, detail: "Git objects are written to the adopted vault." } }),
      { state: "ephemeral", detail: "Workspace files exist only in this page runtime." },
    );
    expect(split.filter((fact) => fact.id.startsWith("durability"))).toHaveLength(2);
  });

  it("does not call a transport ready when no origin is reachable with it", () => {
    const blocked = sourcePostureFacts(
      capabilities({ remote: { ...capabilities().remote, permittedOrigins: [] } }),
      { state: "ephemeral", detail: "x" },
    );
    expect(blocked.find((fact) => fact.id === "remote")?.state).toBe("attention");
    const reachable = sourcePostureFacts(capabilities(), { state: "ephemeral", detail: "x" });
    expect(reachable.find((fact) => fact.id === "remote")?.state).toBe("asserted");
  });

  it("states the transport paragraph exactly once, as the remote fact's detail", () => {
    const facts = sourcePostureFacts(capabilities(), { state: "ephemeral", detail: "x" });
    const printed = facts.filter((fact) => fact.detail.includes("isomorphic-git speaks Smart HTTP"));
    expect(printed).toHaveLength(1);
    expect(printed[0]?.id).toBe("remote");
  });

  it("counts the origins this build may actually reach", () => {
    expect(remoteTransportLabel("direct-git-http", 1)).toBe("Direct Git HTTPS · 1 permitted origin");
    expect(remoteTransportLabel("direct-git-http", 0)).toBe("Direct Git HTTPS · 0 permitted origins");
    expect(remoteTransportLabel("none", 0)).toBe("Remote operations unavailable");
  });

  it("never claims durability the adapter does not have", () => {
    const facts = sourcePostureFacts(capabilities(), { state: "ephemeral", detail: "x" });
    expect(facts.find((fact) => fact.id === "storage")?.state).toBe("none");
    expect(facts.find((fact) => fact.id === "version-bound")?.state).toBe("asserted");
  });
});

describe("history rows", () => {
  it("shows a branch created here without opening a menu", () => {
    const refs = commitRefs("abc", { branches: [{ name: "feature/aesthetic", oid: "abc" }, { name: "main", oid: "zzz" }] }, [
      { name: "v1", oid: "tagobj", annotated: true, target: "abc" },
      { name: "v0", oid: "old", annotated: false, target: "old" },
    ]);
    expect(refs).toEqual(["feature/aesthetic", "tag: v1"]);
  });

  it("shows the subject line and never an empty row", () => {
    expect(commitSubject("Initial browser workspace\n\nBody text")).toBe("Initial browser workspace");
    expect(commitSubject("\n\n")).toBe("(no message)");
  });
});

describe("patch tail handling", () => {
  it("does not number the empty string a trailing newline leaves behind", () => {
    const parsed = parseUnifiedPatch("@@ -0,0 +1,1 @@\n+only line\n");
    expect(parsed.lines.filter((line) => line.kind !== "hunk")).toHaveLength(1);
  });
});

describe("remote reachability", () => {
  const withFeatures = (overrides: Partial<Capabilities> = {}) => capabilities({
    features: {
      clone: { available: true }, fetch: { available: true }, push: { available: true },
    } as Capabilities["features"],
    ...overrides,
  });

  it("judges reachability per remote URL, not per build", () => {
    // `features.fetch.available` is true here because the page's own origin is
    // permitted, which says nothing about the remote actually configured.
    expect(isRemoteOriginPermitted("https://github.com/o/n", ["http://localhost:4173"])).toBe(false);
    expect(isRemoteOriginPermitted("http://localhost:4173/o/n.git", ["http://localhost:4173"])).toBe(true);
    expect(isRemoteOriginPermitted("not a url", ["http://localhost:4173"])).toBe(false);
  });

  it("names the policy, not the credential broker, for a remote this build cannot reach", () => {
    const paragraphs = remoteBoundaryParagraphs(
      withFeatures({ remote: { ...capabilities().remote, permittedOrigins: ["http://localhost:4173"] } }),
      { url: "https://github.com/o/n.git" },
    ).join(" ");
    expect(paragraphs).toContain("Content-Security-Policy");
    expect(paragraphs).toContain("https://github.com");
    expect(paragraphs).toContain("http://localhost:4173");
    // Custody is not what stands in the way when no request is ever sent.
    expect(paragraphs).not.toContain("Anonymous direct push only");
  });

  it("keeps the credential and lost-response paragraphs for a reachable remote", () => {
    const paragraphs = remoteBoundaryParagraphs(
      withFeatures({ remote: { ...capabilities().remote, permittedOrigins: ["http://localhost:4173"] } }),
      { url: "http://localhost:4173/o/n.git" },
    );
    expect(paragraphs[0]).toContain("Anonymous direct push only");
    expect(paragraphs[1]).toContain("reports the outcome as unknown");
  });

  it("blames the adapter, not the policy, when no transport is installed at all", () => {
    // The memory and encrypted-workspace adapters declare transport "none" and
    // no permitted origin, yet snapshot import registers a real GitHub
    // `origin`. Reaching for the CSP sentence there would tell the operator to
    // go fix a policy that is not what stands in the way.
    const paragraphs = remoteBoundaryParagraphs(
      capabilities({
        remote: { ...capabilities().remote, transport: "none", permittedOrigins: [] },
        features: {
          clone: { available: false, reason: "this adapter has no direct CORS-safe Git HTTP or host-provider transport" },
          fetch: { available: false, reason: "this adapter has no direct CORS-safe Git HTTP or host-provider transport" },
          push: { available: false, reason: "this adapter has no direct CORS-safe Git HTTP or host-provider transport" },
        } as Capabilities["features"],
      }),
      { url: "https://github.com/o/n.git" },
    );
    expect(paragraphs).toEqual(["this adapter has no direct CORS-safe Git HTTP or host-provider transport"]);
    expect(paragraphs.join(" ")).not.toContain("Content-Security-Policy");
    expect(paragraphs.join(" ")).not.toContain("no origin at all");
  });

  it("still states the adapter's own reason when push is unavailable outright", () => {
    expect(remoteBoundaryParagraphs(
      withFeatures({
        features: {
          clone: { available: false }, fetch: { available: false },
          push: { available: false, reason: "push is unavailable on this adapter." },
        } as Capabilities["features"],
      }),
      { url: "http://127.0.0.1:4173/o/n.git" },
    )).toEqual(["push is unavailable on this adapter."]);
  });

  it("never advertises a clone adapter on a surface that offers no clone control", () => {
    const available = cloneBoundaryNote(withFeatures());
    expect(available).not.toContain("A clone-capable adapter is available.");
    expect(available).toContain("http://127.0.0.1:4173");
    expect(cloneBoundaryNote(capabilities({
      features: { clone: { available: false, reason: "no adapter" } } as Capabilities["features"],
    }))).toBe("Full-history clone unavailable: no adapter.");
  });
});

/*
 * Source Control could never add, repoint or remove a remote, so its own Fetch
 * and Push were permanently inert on every imported repository: the snapshot
 * importer — the only repository a first-time user can obtain — writes files
 * and configures no remote, and the panel answered "No upstream configured."
 * beside two buttons that could not do anything about it.
 */
describe("configuring the remote the panel reports on", () => {
  const repository = (remotes: readonly Readonly<{ name: string; url: string }>[]) => ({
    id: "snapshot-repo",
    version: "7",
    remotes,
  });

  it("adds origin when the repository has none", () => {
    const operation = sourceRemoteOperation(repository([]), " https://github.com/owner/repo.git ");
    expect(operation).toEqual({
      kind: "remote-add",
      request: {
        repositoryId: "snapshot-repo",
        name: "origin",
        url: "https://github.com/owner/repo.git",
        expectedRepositoryVersion: "7",
      },
    });
  });

  it("repoints the existing remote rather than adding a second one", () => {
    const operation = sourceRemoteOperation(repository([{ name: "origin", url: "https://github.com/owner/old.git" }]), "https://github.com/owner/new.git");
    expect(operation?.kind).toBe("remote-set-url");
    expect(operation?.request.url).toBe("https://github.com/owner/new.git");
  });

  it("asks for no review when nothing would change", () => {
    expect(sourceRemoteOperation(repository([]), "   ")).toBeUndefined();
    expect(sourceRemoteOperation(repository([{ name: "origin", url: "https://github.com/owner/repo.git" }]), " https://github.com/owner/repo.git "))
      .toBeUndefined();
  });

  it("carries the compare-and-swap version every other mutation carries", () => {
    expect(sourceRemoteOperation(repository([]), "https://example.invalid/x.git")?.request.expectedRepositoryVersion).toBe("7");
  });

  it("routes all three remote verbs to the client that has always implemented them", () => {
    const source = readFileSync(new URL("./sources-view.tsx", import.meta.url), "utf8");
    const dispatch = source.match(/async function execute\([\s\S]*?\n\}/u)?.[0] ?? "";
    expect(dispatch).toContain('case "remote-add": return client.addRemote');
    expect(dispatch).toContain('case "remote-set-url": return client.setRemoteUrl');
    expect(dispatch).toContain('case "remote-remove": return client.removeRemote');
    // The control exists on the panel, not only in the dispatcher.
    expect(source).toContain("onClick={configureRemote}");
    expect(source).toContain("setRemoteDraft(event.currentTarget.value)");
  });
});

/*
 * The advanced sheet is the only place the browser source controls exist on a
 * phone, and at 320px its title read "Repositories & wor" — the serif heading
 * cut flush by the screen edge, mid-word, with no ellipsis to admit it. The
 * cause was never the heading: `.route-title` has carried `min-width: 0`,
 * `overflow: hidden` and `text-overflow: ellipsis` all along. It was the box
 * above it, twice over. These rules pin that box, so an edit that re-opens
 * either escape has to argue with this file first.
 */
describe("the advanced sheet fits the phone it opens on", () => {
  const sheet = readFileSync(new URL("./sources-view.css", import.meta.url), "utf8");
  const rule = (source: string, selector: string): string => {
    const start = source.indexOf(`${selector} {`);
    expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
    const bodyStart = source.indexOf("{", start) + 1;
    return source.slice(bodyStart, source.indexOf("}", bodyStart));
  };

  it("clamps the header's implicit column so a nowrap title cannot widen the sheet", () => {
    // `<RouteHeader>` is a grid with no declared column, and an `auto` track is
    // floored by its widest child's min-content contribution — which for a
    // `white-space: nowrap` heading is the entire string. Only a track whose
    // min sizing function is fixed refuses to grow past the sheet.
    expect(rule(sheet, ".git-sources-header.route-header")).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps the embedded sheet to one inline gutter rather than two", () => {
    // `.git-sources--embedded` already pads 16px inline. The primitive's own
    // inset stacked a second 16px on top of it, so the title and its verbs
    // started 32px in while every card below them started at 16px — and the
    // title had 32px less to truncate into than the sheet actually offered.
    expect(rule(sheet, ".git-sources--embedded .git-sources-header.route-header")).toMatch(/padding-inline:\s*0/u);
    expect(rule(sheet, ".git-sources--embedded")).toContain("padding: 0 var(--sp-4) var(--sp-4)");
  });

  it("still asks the title to truncate, which is the whole point of clamping the box", () => {
    const routes = readFileSync(new URL("./routes.css", import.meta.url), "utf8");
    const title = rule(routes, ".route-title");
    expect(title).toContain("white-space: nowrap");
    expect(title).toContain("text-overflow: ellipsis");
    expect(title).toContain("overflow: hidden");
  });
});

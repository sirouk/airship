import { describe, expect, it } from "vitest";
import {
  buildStatusTree,
  commitRefs,
  commitSubject,
  deltaLetter,
  diffComparisonLabel,
  diffLineKind,
  diffPlaceholder,
  parseUnifiedPatch,
  cloneBoundaryNote,
  remoteBoundaryParagraphs,
  remoteTransportLabel,
  sourcePostureFacts,
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
  it("does not color diff headers as file additions/removals", () => {
    expect(diffLineKind("+added")).toBe("added");
    expect(diffLineKind("-removed")).toBe("removed");
    expect(diffLineKind("+++ b/file")).toBe("context");
    expect(diffLineKind("--- a/file")).toBe("context");
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
    expect(durability[0]?.label).toBe("Workspace & Git index · Ephemeral · this page only");
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

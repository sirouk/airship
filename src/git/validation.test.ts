import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { describeGitOperation, normalizeGitOperation } from "./operations";
import {
  GIT_LIMITS,
  GIT_REMOTE_CONNECT_ORIGINS,
  assertNoCaseFoldCollisions,
  assertRemoteOriginPermitted,
  gitRemoteConnectOrigins,
  validateBranchName,
  validateGitPath,
  validatePathList,
  validateRemoteUrl,
} from "./validation";

/** Public origins that really do answer Git Smart HTTP, so none may appear in connect-src unclassified. */
const GIT_SMART_HTTP_HOSTS: readonly string[] = Object.freeze([
  "https://github.com",
  "https://gitlab.com",
  "https://bitbucket.org",
  "https://codeberg.org",
  "https://git.sr.ht",
]);

/** The rule the allowlist must satisfy: every declared Git origin is one the policy granted. */
function ungrantedOrigins(origins: readonly string[], sources: readonly string[]): string[] {
  return origins.filter((origin) => !sources.includes(origin));
}

function connectSources(policy: string): string[] {
  const directive = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src "));
  if (!directive) throw new Error("The policy under test declares no connect-src.");
  return directive.split(/\s+/u).slice(1);
}

describe("browser Git validation", () => {
  it("pins the Git remote allowlist to the connect-src both shipped policy documents declare", async () => {
    const [index, headers] = await Promise.all([
      readFile(new URL("../../index.html", import.meta.url), "utf8"),
      readFile(new URL("../../public/_headers", import.meta.url), "utf8"),
    ]);
    const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
    const header = /^\s*Content-Security-Policy:\s*(.+)$/mu.exec(headers)?.[1];
    expect(meta).toBeDefined();
    expect(header).toBeDefined();

    for (const policy of [meta!, header!]) {
      const sources = connectSources(policy);
      // An allowlist entry the shipped policy never granted would claim a
      // reachable Git host the browser blocks at runtime.
      expect(ungrantedOrigins(GIT_REMOTE_CONNECT_ORIGINS, sources)).toEqual([]);
      // The constant is empty today, which makes the line above pass for free.
      // Applying the same rule to a probe entry proves the comparison is real
      // and would actually catch the first entry that drifts from the policy.
      expect(ungrantedOrigins([...GIT_REMOTE_CONNECT_ORIGINS, "https://git.example.test"], sources))
        .toEqual(["https://git.example.test"]);
      // gitRemoteConnectOrigins() treats the page's own origin as permitted
      // unconditionally, which is only true while connect-src grants 'self'.
      expect(sources).toContain("'self'");
      // The two hosts that are allowlisted serve GitHub's REST API and raw
      // file CDN. Asserting they are granted keeps the pair below live — a
      // `not.toContain` against an empty constant proves nothing on its own —
      // while neither answers Git Smart HTTP, so neither may be claimed as a
      // Git remote origin.
      for (const rest of ["https://api.github.com", "https://raw.githubusercontent.com"]) {
        expect(sources).toContain(rest);
        expect(GIT_REMOTE_CONNECT_ORIGINS).not.toContain(rest);
      }
      // Drift in the other direction: a Git Smart HTTP host added to the policy
      // but not to the constant would leave the adapter refusing an origin the
      // page can genuinely reach, and would falsify the claim that no
      // cross-origin Git host is reachable at all.
      expect(sources.filter((source) => GIT_SMART_HTTP_HOSTS.includes(source))).toEqual([]);
    }
  });

  it("permits only the page's own origin and refuses every Git host the page cannot reach", () => {
    expect(gitRemoteConnectOrigins()).toEqual([...GIT_REMOTE_CONNECT_ORIGINS]);
    expect(() => assertRemoteOriginPermitted("https://github.com/owner/repo.git", "clone"))
      .toThrow(/Content-Security-Policy blocks a direct Git clone/u);

    vi.stubGlobal("location", { origin: "https://git.example.test" });
    try {
      expect(gitRemoteConnectOrigins()).toEqual(["https://git.example.test", ...GIT_REMOTE_CONNECT_ORIGINS]);
      expect(assertRemoteOriginPermitted("https://git.example.test/repository.git", "push")).toBe("https://git.example.test");
      expect(() => assertRemoteOriginPermitted("https://other.example.test/repository.git", "fetch"))
        .toThrow(/blocks a direct Git fetch/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("separates the per-adapter-call path bound from the reviewed request bound", () => {
    const paths = Array.from({ length: GIT_LIMITS.maxPathsPerOperation + 1 }, (_, index) => `file-${index}.txt`);
    expect(() => validatePathList(paths)).toThrow(`Select between 1 and ${GIT_LIMITS.maxPathsPerOperation} paths.`);
    expect(validatePathList(paths, GIT_LIMITS.maxPathsPerRequest)).toHaveLength(paths.length);
    const tooMany = Array.from({ length: GIT_LIMITS.maxPathsPerRequest + 1 }, (_, index) => `file-${index}.txt`);
    expect(() => validatePathList(tooMany, GIT_LIMITS.maxPathsPerRequest))
      .toThrow(`Select between 1 and ${GIT_LIMITS.maxPathsPerRequest} paths.`);
    expect(() => normalizeGitOperation({
      kind: "stage",
      request: { repositoryId: "airship", worktreeId: "main", paths: tooMany, expectedWorktreeVersion: "worktree-v1" },
    })).toThrow(`Select between 1 and ${GIT_LIMITS.maxPathsPerRequest} paths.`);
  });

  it("accepts portable repository-relative paths and rejects escape or metadata paths", () => {
    expect(validateGitPath("src/ship/engine.ts")).toBe("src/ship/engine.ts");
    for (const unsafe of ["../secret", "/etc/passwd", "src\\secret", ".git/config", "src/.git/index", "CON", "bad:name", "a//b", "a/./b"]) {
      expect(() => validateGitPath(unsafe)).toThrow();
    }
    expect(() => validateGitPath("cafe\u0301.txt")).toThrow("NFC");
    expect(() => assertNoCaseFoldCollisions(["Readme.md", "README.md"])).toThrow("collide");
  });

  it("enforces Git ref grammar and credential-free HTTPS remotes", () => {
    expect(validateBranchName("feature/context-fabric")).toBe("feature/context-fabric");
    for (const unsafe of ["main..old", "refs/@{upstream}", "bad name", "main.lock", ".hidden", "trailing."]) {
      expect(() => validateBranchName(unsafe)).toThrow();
    }
    expect(validateRemoteUrl("https://github.com/chutes/airship.git")).toBe("https://github.com/chutes/airship.git");
    expect(() => validateRemoteUrl("http://github.com/chutes/airship.git")).toThrow("credential-free HTTPS");
    expect(() => validateRemoteUrl("https://token@github.com/chutes/airship.git")).toThrow("credential-free HTTPS");
    expect(() => validateRemoteUrl("https://github.com/chutes/airship.git?token=secret")).toThrow("credential-free HTTPS");
    expect(() => validateRemoteUrl("\nhttps://github.com/chutes/airship.git")).toThrow("whitespace or control");
  });

  it("normalizes bounded path sets and produces immutable approval material", () => {
    const operation = normalizeGitOperation({
      kind: "stage",
      request: {
        repositoryId: "airship",
        worktreeId: "main",
        paths: ["src/z.ts", "src/a.ts"],
        expectedWorktreeVersion: "worktree-v4",
      },
    });
    expect(operation.request.paths).toEqual(["src/a.ts", "src/z.ts"]);
    expect(Object.isFrozen(operation.request.paths)).toBe(true);
    const descriptor = describeGitOperation(operation);
    expect(descriptor).toMatchObject({
      brokerEffect: "write",
      risk: "change-local",
      approvalRequired: true,
      dataLeavesDevice: false,
      resource: "repository:airship/worktree:main",
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.arguments)).toBe(true);
  });

  it("marks remote mutation and disclosure without hiding force semantics", () => {
    const descriptor = describeGitOperation({
      kind: "push",
      request: {
        repositoryId: "airship",
        worktreeId: "main",
        remote: "origin",
        branch: "main",
        expectedWorktreeVersion: "worktree-v8",
        force: true,
      },
    });
    expect(descriptor).toMatchObject({
      brokerEffect: "identity",
      risk: "change-remote",
      approvalRequired: true,
      dataLeavesDevice: true,
      destination: "remote:origin",
    });
    expect(descriptor.summary).toContain("Force-push");
    expect(descriptor.arguments).toMatchObject({ force: true, branch: "main" });
  });

  it("binds linked-worktree approval to the normalized workspace destination", () => {
    const descriptor = describeGitOperation({
      kind: "worktree-create",
      request: {
        repositoryId: "airship",
        worktreeId: "proof",
        path: "worktrees/proof",
        branch: "feature/proof",
        expectedRepositoryVersion: "repository-v3",
      },
    });
    expect(descriptor).toMatchObject({
      brokerEffect: "write",
      risk: "change-local",
      approvalRequired: true,
      dataLeavesDevice: false,
      resource: "repository:airship/worktree:proof",
    });
    expect(descriptor.arguments).toMatchObject({ path: "/workspace/worktrees/proof", branch: "feature/proof" });
  });
});

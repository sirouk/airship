import { describe, expect, it } from "vitest";
import { describeGitOperation, normalizeGitOperation } from "./operations";
import {
  assertNoCaseFoldCollisions,
  validateBranchName,
  validateGitPath,
  validateRemoteUrl,
} from "./validation";

describe("browser Git validation", () => {
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

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { GitOperation } from "../git/types";
import { describeGitOperation } from "../git/operations";
import { writeApprovalFacts } from "../ui/approval-presentation";
import { approvalDerivationInput, gitApprovalToolName } from "./consequence";

/**
 * Every Git operation the Workspace panel can propose, with a payload
 * `describeGitOperation` accepts. Built from the real descriptor rather than
 * hand-written argument objects so a validation rule that changes shape here
 * fails the test instead of silently drifting from the dialog.
 */
const OPERATIONS: readonly GitOperation[] = Object.freeze([
  { kind: "stage", request: { repositoryId: "airship-workspace", worktreeId: "main", paths: ["README.md"], expectedWorktreeVersion: "v1", force: false } },
  { kind: "unstage", request: { repositoryId: "airship-workspace", worktreeId: "main", paths: ["README.md"], expectedWorktreeVersion: "v1" } },
  { kind: "commit", request: { repositoryId: "airship-workspace", worktreeId: "main", message: "docs: note", author: { name: "A", email: "a@b.invalid" }, expectedWorktreeVersion: "v1" } },
  { kind: "restore", request: { repositoryId: "airship-workspace", worktreeId: "main", paths: ["README.md"], source: "head", expectedWorktreeVersion: "v1" } },
  { kind: "reset", request: { repositoryId: "airship-workspace", worktreeId: "main", mode: "hard", ref: "HEAD", expectedWorktreeVersion: "v1" } },
  { kind: "merge", request: { repositoryId: "airship-workspace", worktreeId: "main", theirs: "topic", fastForwardOnly: false, author: { name: "A", email: "a@b.invalid" }, expectedWorktreeVersion: "v1" } },
  { kind: "stash", request: { repositoryId: "airship-workspace", worktreeId: "main", op: "push", index: 0, author: { name: "A", email: "a@b.invalid" }, expectedWorktreeVersion: "v1" } },
  { kind: "branch-create", request: { repositoryId: "airship-workspace", worktreeId: "main", name: "topic", checkout: true, expectedWorktreeVersion: "v1" } },
  { kind: "branch-switch", request: { repositoryId: "airship-workspace", worktreeId: "main", name: "topic", expectedWorktreeVersion: "v1" } },
  { kind: "worktree-create", request: { repositoryId: "airship-workspace", worktreeId: "second", path: "trees/second", branch: "topic", expectedRepositoryVersion: "v1" } },
  { kind: "worktree-remove", request: { repositoryId: "airship-workspace", worktreeId: "second", expectedRepositoryVersion: "v1" } },
  { kind: "tag-create", request: { repositoryId: "airship-workspace", name: "v1.0.0", force: false, expectedRepositoryVersion: "v1" } },
  { kind: "tag-delete", request: { repositoryId: "airship-workspace", name: "v1.0.0", expectedRepositoryVersion: "v1" } },
  { kind: "remote-add", request: { repositoryId: "airship-workspace", name: "origin", url: "https://example.invalid/r.git", expectedRepositoryVersion: "v1" } },
  { kind: "remote-set-url", request: { repositoryId: "airship-workspace", name: "origin", url: "https://example.invalid/s.git", expectedRepositoryVersion: "v1" } },
  { kind: "remote-remove", request: { repositoryId: "airship-workspace", name: "origin", expectedRepositoryVersion: "v1" } },
] as readonly GitOperation[]);

describe("approvalDerivationInput", () => {
  /**
   * The measured defect: staging README.md opened "Allow git_stage once?" over
   * "Target: Adapter-selected target / Change: Consequence not derivable — read
   * the raw arguments below", while the dialog's own argument disclosure held
   * `"paths": ["README.md"]`. The only irreversible actions in the product were
   * the only ones the permission dialog could not attribute.
   */
  it("derives a consequence for every approval-requiring Git operation", () => {
    const undeclared: string[] = [];
    for (const operation of OPERATIONS) {
      const descriptor = describeGitOperation(operation);
      const input = approvalDerivationInput(gitApprovalToolName(operation.kind), descriptor.arguments);
      const facts = writeApprovalFacts(input.toolName, input.argumentsValue);
      if (!facts.derived || facts.targets.length === 0) undeclared.push(operation.kind);
    }
    expect(undeclared).toEqual([]);
  });

  it("names the staged path and the verb the Source Control row used", () => {
    const descriptor = describeGitOperation(OPERATIONS[0]!);
    const input = approvalDerivationInput("git_stage", descriptor.arguments);
    const facts = writeApprovalFacts(input.toolName, input.argumentsValue);
    expect(facts.disposition).toBe("Git stage in the browser-owned worktree");
    expect(facts.targets).toContain("README.md");
  });

  /** One vocabulary: the person's staging request and the model's `git_change`. */
  it("resolves the human and model Git paths to the same sentence", () => {
    const descriptor = describeGitOperation(OPERATIONS[2]!);
    const human = approvalDerivationInput("git_commit", descriptor.arguments);
    const model = approvalDerivationInput("git_change", { ...descriptor.arguments as object, action: "commit" });
    expect(writeApprovalFacts(human.toolName, human.argumentsValue).disposition)
      .toBe(writeApprovalFacts(model.toolName, model.argumentsValue).disposition);
  });

  it("leaves every registered tool name and payload untouched", () => {
    const value = { path: "notes/hello.md", content: "hello" };
    expect(approvalDerivationInput("write_file", value)).toEqual({ toolName: "write_file", argumentsValue: value });
    expect(approvalDerivationInput("git_change", value)).toEqual({ toolName: "git_change", argumentsValue: value });
    expect(approvalDerivationInput("git_inspect", value)).toEqual({ toolName: "git_inspect", argumentsValue: value });
  });

  /**
   * `clone`, `fetch` and `push` are network and identity effects whose
   * descriptor summary already names the remote and the branch. Routing them
   * through a worktree-change vocabulary would describe them as something they
   * are not, so the table maps them to nothing on purpose.
   */
  it("does not restate a remote operation as a local worktree change", () => {
    for (const kind of ["clone", "fetch", "push"] as const) {
      expect(approvalDerivationInput(gitApprovalToolName(kind), {}).toolName).toBe(`git_${kind}`);
    }
  });

  /**
   * The seam this adapter closes has two ends, and only one of them is here.
   * `reviewGitOperation` still spells the template inline; this asserts the
   * spelling the adapter keys on is the spelling that surface mints, so the two
   * cannot drift apart silently.
   */
  it("keys on the name the Workspace review site actually mints", async () => {
    const source = await readFile(new URL("../ui/app.tsx", import.meta.url), "utf8");
    expect(source).toContain("name: `git_${operation.kind}`");
    expect(gitApprovalToolName("stage")).toBe("git_stage");
  });
});

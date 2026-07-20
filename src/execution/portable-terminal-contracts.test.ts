import { describe, expect, it } from "vitest";
import {
  PORTABLE_TERMINAL_CANDIDATES,
  assessCheckpointCompatibility,
  type TerminalCheckpoint,
} from "./portable-terminal-contracts";

const checkpoint: TerminalCheckpoint = {
  schema: "airship.terminal-checkpoint.v1",
  id: "checkpoint-1",
  engine: "v86-linux",
  engineVersion: "0.5.424",
  artifactSetSha256: `sha256:${"a".repeat(64)}`,
  kind: "machine-state",
  createdAt: "2026-07-19T12:00:00.000Z",
  workspaceRevision: "workspace-revision-7",
  encryptedObjects: [{
    key: "terminal/checkpoint-1/state.enc",
    etag: "etag-1",
    bytes: 4096,
    sha256: `sha256:${"b".repeat(64)}`,
  }],
};

describe("portable terminal evidence", () => {
  it("does not advertise an unintegrated Linux engine as active", () => {
    expect(PORTABLE_TERMINAL_CANDIDATES.filter(({ implementation }) => implementation === "active").map(({ id }) => id))
      .toEqual(["webcontainer-node"]);
    expect(PORTABLE_TERMINAL_CANDIDATES.find(({ id }) => id === "wasmer-wasix")).toMatchObject({
      implementation: "blocked",
      evidence: expect.arrayContaining([
        expect.objectContaining({ feature: "bash", support: "documented" }),
        expect.objectContaining({ feature: "git", support: "unknown" }),
        expect.objectContaining({ feature: "process-checkpoint", support: "unsupported" }),
      ]),
    });
  });

  it("keeps vendor documentation distinct from a verified Airship probe", () => {
    for (const candidate of PORTABLE_TERMINAL_CANDIDATES.filter(({ implementation }) => implementation !== "active")) {
      expect(candidate.evidence.every(({ support }) => support !== "verified")).toBe(true);
      expect(candidate.blocker).toBeTruthy();
    }
  });

  it("restores machine state only across an exact compatibility boundary", () => {
    expect(assessCheckpointCompatibility(checkpoint, {
      engine: "v86-linux",
      engineVersion: "0.5.424",
      artifactSetSha256: checkpoint.artifactSetSha256,
      workspaceRevision: checkpoint.workspaceRevision,
      supportsMachineState: true,
    })).toEqual({ compatible: true, restores: "machine-state", reason: "Exact runtime, artifact set, and workspace revision match." });

    expect(assessCheckpointCompatibility(checkpoint, {
      engine: "v86-linux",
      engineVersion: "0.5.425",
      artifactSetSha256: checkpoint.artifactSetSha256,
      workspaceRevision: checkpoint.workspaceRevision,
      supportsMachineState: true,
    })).toMatchObject({ compatible: false, restores: "nothing", reason: "Checkpoint runtime version changed." });
  });

  it("refuses to reinterpret machine state as a filesystem checkpoint", () => {
    expect(assessCheckpointCompatibility(checkpoint, {
      engine: "v86-linux",
      engineVersion: checkpoint.engineVersion,
      artifactSetSha256: checkpoint.artifactSetSha256,
      workspaceRevision: checkpoint.workspaceRevision,
      supportsMachineState: false,
    })).toMatchObject({ compatible: false, restores: "nothing" });
  });

  it("rejects malformed or empty encrypted checkpoint descriptors", () => {
    expect(() => assessCheckpointCompatibility({ ...checkpoint, encryptedObjects: [] }, {
      engine: "v86-linux",
      engineVersion: checkpoint.engineVersion,
      artifactSetSha256: checkpoint.artifactSetSha256,
      workspaceRevision: checkpoint.workspaceRevision,
      supportsMachineState: true,
    })).toThrow(/no encrypted objects/u);
  });
});

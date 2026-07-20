import type { MemoryNodeKind } from "./types";

export type MemoryNodeShape = "disc" | "dot" | "square" | "ring" | "diamond" | "hollow";
export const KIND_VISUAL: Readonly<Record<MemoryNodeKind, Readonly<{ colorToken: string; shape: MemoryNodeShape }>>> = Object.freeze({
  session: Object.freeze({ colorToken: "--brand-brass", shape: "disc" }),
  message: Object.freeze({ colorToken: "--truth-local", shape: "dot" }),
  "workspace-file": Object.freeze({ colorToken: "--v-verified", shape: "square" }),
  profile: Object.freeze({ colorToken: "--accent-bright", shape: "ring" }),
  skill: Object.freeze({ colorToken: "--copper", shape: "diamond" }),
  term: Object.freeze({ colorToken: "--ink-muted", shape: "hollow" }),
});

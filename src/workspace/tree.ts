import type { WorkspaceEntry } from "./contracts";
import { normalizeWorkspacePath } from "./contracts";

export type WorkspaceTreeNode = Readonly<{
  kind: "directory" | "file";
  name: string;
  path: string;
  depth: number;
  entry?: WorkspaceEntry;
  children: readonly WorkspaceTreeNode[];
}>;

export type VisibleWorkspaceNode = WorkspaceTreeNode & Readonly<{
  expanded?: boolean;
}>;

type MutableNode = {
  kind: "directory" | "file";
  name: string;
  path: string;
  depth: number;
  entry?: WorkspaceEntry;
  children: Map<string, MutableNode>;
};

/** Build one deterministic directory-first projection without loading file bytes. */
export function buildWorkspaceTree(entries: readonly WorkspaceEntry[]): WorkspaceTreeNode {
  const root: MutableNode = {
    kind: "directory",
    name: "workspace",
    path: "/workspace",
    depth: 0,
    children: new Map(),
  };
  for (const entry of entries) {
    const normalized = normalizeWorkspacePath(entry.path);
    if (normalized === "/workspace") continue;
    const parts = normalized.slice("/workspace/".length).split("/");
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const path = `/workspace/${parts.slice(0, index + 1).join("/")}`;
      const final = index === parts.length - 1;
      let child = parent.children.get(name);
      if (!child) {
        child = {
          kind: final ? "file" : "directory",
          name,
          path,
          depth: index + 1,
          ...(final ? { entry } : {}),
          children: new Map(),
        };
        parent.children.set(name, child);
      } else if (final) {
        child.kind = "file";
        child.entry = entry;
      }
      parent = child;
    }
  }
  return freezeNode(root);
}

/** Flatten only expanded branches so large imported repositories stay cheap. */
export function visibleWorkspaceTree(
  root: WorkspaceTreeNode,
  expanded: ReadonlySet<string>,
): readonly VisibleWorkspaceNode[] {
  const visible: VisibleWorkspaceNode[] = [];
  const visit = (node: WorkspaceTreeNode) => {
    const isExpanded = node.kind === "directory" && expanded.has(node.path);
    if (node.path !== root.path) visible.push(Object.freeze({ ...node, ...(node.kind === "directory" ? { expanded: isExpanded } : {}) }));
    if (node.path === root.path || isExpanded) node.children.forEach(visit);
  };
  visit(root);
  return Object.freeze(visible);
}

export function workspaceParentPath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === "/workspace") return normalized;
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= "/workspace".length ? "/workspace" : normalized.slice(0, lastSlash);
}

export function workspaceBaseName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace" ? "workspace" : normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function workspaceDirectories(root: WorkspaceTreeNode): readonly WorkspaceTreeNode[] {
  const directories: WorkspaceTreeNode[] = [root];
  const visit = (node: WorkspaceTreeNode) => {
    for (const child of node.children) {
      if (child.kind !== "directory") continue;
      directories.push(child);
      visit(child);
    }
  };
  visit(root);
  return Object.freeze(directories);
}

function freezeNode(node: MutableNode): WorkspaceTreeNode {
  const children = [...node.children.values()]
    .sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      : left.kind === "directory" ? -1 : 1)
    .map(freezeNode);
  return Object.freeze({
    kind: node.kind,
    name: node.name,
    path: node.path,
    depth: node.depth,
    ...(node.entry ? { entry: structuredClone(node.entry) } : {}),
    children: Object.freeze(children),
  });
}

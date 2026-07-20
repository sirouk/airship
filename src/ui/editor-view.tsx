import { useEffect, useState } from "preact/hooks";
import type { BrowserGitClient } from "../git/client";
import type { GitOperation, GitOperationDescriptor } from "../git/types";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import type { DurabilityState } from "./durability-indicator";
import type { SourcesImportRequest } from "./sources-view";
import { WorkspaceView } from "./workspace-view";
import "./editor-view.css";

type SourcesComponent = typeof import("./sources-view").SourcesView;

export type EditorViewProps = Readonly<{
  files: readonly WorkspaceEntry[];
  selected?: WorkspaceFile;
  onOpen(path: string): void | Promise<void>;
  workspace: WorkspacePort;
  git: BrowserGitClient;
  review(operation: GitOperation, descriptor: GitOperationDescriptor): Promise<"allow" | "deny">;
  reviewImport(request: SourcesImportRequest): Promise<"allow" | "deny">;
  onWorkspaceChanged(): void | Promise<void>;
  durability: Readonly<{ state: DurabilityState; detail: string }>;
}>;

/** One Workspace destination with lightweight editing and full source control. */
export function EditorView(props: EditorViewProps) {
  const [mode, setMode] = useState<"files" | "sources">("files");
  const [Sources, setSources] = useState<SourcesComponent>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    if (mode !== "sources" || Sources) return;
    let current = true;
    setLoadError(undefined);
    void import("./sources-view").then((module) => {
      if (current) setSources(() => module.SourcesView);
    }).catch(() => {
      if (current) setLoadError("The full source-control tools could not be loaded. Workspace files and drafts were not changed.");
    });
    return () => { current = false; };
  }, [mode, Sources]);

  return <section class="editor-route" aria-label="Workspace editor">
    <nav class="editor-route__tabs" aria-label="Editor views" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "files"} onClick={() => setMode("files")}>Files &amp; editor</button>
      <button type="button" role="tab" aria-selected={mode === "sources"} onClick={() => setMode("sources")}>Sources</button>
    </nav>
    {mode === "files" ? <WorkspaceView
      files={props.files}
      selected={props.selected}
      onOpen={props.onOpen}
      workspace={props.workspace}
      git={props.git}
      review={props.review}
      onWorkspaceChanged={props.onWorkspaceChanged}
      onOpenRepositoryManager={() => setMode("sources")}
      heading="Editor"
      durability={props.durability}
    /> : Sources ? <Sources
      client={props.git}
      author={{ name: "Local Airship User", email: "airship@local.invalid" }}
      review={props.review}
      workspace={props.workspace}
      reviewImport={props.reviewImport}
      onWorkspaceChanged={props.onWorkspaceChanged}
      workspaceDurability={props.durability}
    /> : <div class="editor-route__loading" role={loadError ? "alert" : "status"}>{loadError ?? "Loading full browser source control…"}</div>}
  </section>;
}

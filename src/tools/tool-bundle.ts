import { registerContextTools } from "./context-tools";
import { registerLazyExecutionTools } from "./execution-tool-proxies";
import { registerGitTools } from "./git-tools";
import { registerMemoryTools } from "./memory-tools";
import { registerNetworkTools } from "./network-tools";
import { registerSessionTools } from "./session-tools";
import { registerTaskTools } from "./task-tools";
import { createWorkspaceToolRegistry } from "./workspace-tools";
import type { AirshipToolRegistryOptions } from "./airship-tools";
import { getClientContextRuntime } from "../retrieval/client-context-runtime";
import { GitSynchronizedWorkspace } from "./git-synchronized-workspace";
import { registerFederatedMemoryTool } from "./federated-memory";

/** One lazy capability chunk keeps startup small without paying per-tool chunk overhead. */
export function createLoadedAirshipToolRegistry(options: AirshipToolRegistryOptions) {
  const contextRuntime = getClientContextRuntime(options.workspace, {
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
  });
  const observedWorkspace = contextRuntime.observeWorkspace();
  const workspace = options.git ? new GitSynchronizedWorkspace(observedWorkspace, options.git) : observedWorkspace;
  const registry = createWorkspaceToolRegistry(workspace);
  registry.attachContextRuntime(contextRuntime);
  registerTaskTools(registry, workspace);
  registerMemoryTools(registry, workspace, options.journal);
  registerFederatedMemoryTool(registry, workspace, options.journal, contextRuntime);
  registerSessionTools(registry, options.journal);
  registerContextTools(registry, contextRuntime);
  registerLazyExecutionTools(registry, workspace);
  registerNetworkTools(registry, workspace, options.git, options.fetch);
  if (options.git) registerGitTools(registry, options.git);
  void contextRuntime.scheduleRefresh().catch(() => undefined);
  return registry;
}

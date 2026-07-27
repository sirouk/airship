/**
 * Load the standards-compatible Git engine only when the browser runtime boots.
 *
 * `BrowserGitClient` travels with the adapter rather than being imported at the
 * top of the shell: nothing on the first paint of a conversation needs Git, and
 * a static import placed the whole client in the startup chunk for every
 * visitor who never opens the Workspace. Both modules are requested together
 * because every construction site needs both within the same await.
 */
export async function loadBrowserGit() {
  const [adapter, client] = await Promise.all([
    import("./git/workspace-adapter"),
    import("./git/client"),
  ]);
  return { ...adapter, ...client };
}

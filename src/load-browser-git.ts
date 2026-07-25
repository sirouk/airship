/** Load the standards-compatible Git engine only when the browser runtime boots. */
export async function loadBrowserGit() {
  return import("./git/workspace-adapter");
}

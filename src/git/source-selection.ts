const SOURCE_SELECTION_KEY = "airship.ui.sources.repository.v1";
let pageSelection = "";

/** Keep Sources focused on the repository most recently selected or admitted. */
export function rememberSourceRepository(repositoryId: string): void {
  pageSelection = repositoryId;
  try { globalThis.sessionStorage?.setItem(SOURCE_SELECTION_KEY, repositoryId); } catch {
    // Selection is optional page UI state. Storage denial cannot affect Git.
  }
}

export function preferredSourceRepositoryId(): string {
  if (pageSelection) return pageSelection;
  try { return globalThis.sessionStorage?.getItem(SOURCE_SELECTION_KEY) ?? ""; } catch { return ""; }
}

/**
 * Work performed after a durable assistant completion is advisory UI work.
 * It must never be allowed to reinterpret the completed turn as a failure.
 */
export async function refreshCompletedTurnWorkspace(
  refresh: () => Promise<void>,
): Promise<string | undefined> {
  try {
    await refresh();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Workspace metadata could not be refreshed.";
  }
}

/**
 * Release the composer synchronously, then reconcile advisory session metadata
 * in the background. Provider/Vault latency cannot keep chat globally busy.
 */
export function releaseComposerAndReloadSession<T>(options: Readonly<{
  release(): void;
  load(): Promise<T | undefined>;
  accept(value: T): boolean;
  apply(value: T): void;
}>): void {
  options.release();
  let pending: Promise<T | undefined>;
  try {
    pending = options.load();
  } catch {
    return;
  }
  void pending.then((value) => {
    if (value !== undefined && options.accept(value)) options.apply(value);
  }).catch(() => {
    // Durable turn signals already own lifecycle truth. A later library read
    // can reconcile advisory session header metadata.
  });
}

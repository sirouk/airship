/**
 * Keep first-message naming strictly presentational. The durable turn must
 * pass its own authority checks and complete before a title write can start.
 */
export async function runTurnBeforeNaming<Result>(
  run: () => Promise<Result>,
  rename: () => Promise<void>,
): Promise<Result> {
  const result = await run();
  try {
    await rename();
  } catch {
    // A presentation-only title write must never turn a completed turn into a failure.
  }
  return result;
}

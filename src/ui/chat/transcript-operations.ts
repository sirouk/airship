import { useEffect, useState } from "preact/hooks";

export const TRANSCRIPT_OPERATION_MODES = ["summary", "rows"] as const;

export type TranscriptOperationsMode = (typeof TRANSCRIPT_OPERATION_MODES)[number];

export const DEFAULT_TRANSCRIPT_OPERATIONS: TranscriptOperationsMode = "summary";

export function parseTranscriptOperationsMode(value: unknown): TranscriptOperationsMode {
  return value === "rows" ? "rows" : DEFAULT_TRANSCRIPT_OPERATIONS;
}

type Listener = () => void;

let mode: TranscriptOperationsMode = DEFAULT_TRANSCRIPT_OPERATIONS;
const listeners = new Set<Listener>();

export function transcriptOperationsMode(): TranscriptOperationsMode {
  return mode;
}

/**
 * The expert override lives in its own module rather than travelling as a prop
 * because the transcript renderer sits ten layers below the preference dialog,
 * and the ownership rule for this program forbids re-plumbing `app.tsx` to
 * carry a display flag. The store is written by `applyPreferenceOverrides`,
 * which is the one place a preference becomes live.
 */
export function setTranscriptOperationsMode(next: TranscriptOperationsMode): void {
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

export function subscribeTranscriptOperations(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTranscriptOperations(): TranscriptOperationsMode {
  const [value, setValue] = useState(mode);
  useEffect(() => {
    setValue(mode);
    return subscribeTranscriptOperations(() => setValue(transcriptOperationsMode()));
  }, []);
  return value;
}

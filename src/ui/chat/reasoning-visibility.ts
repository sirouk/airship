import { useEffect, useState } from "preact/hooks";

export const REASONING_VISIBILITIES = ["collapsed", "expanded"] as const;

export type ReasoningVisibility = (typeof REASONING_VISIBILITIES)[number];

export const DEFAULT_REASONING_VISIBILITY: ReasoningVisibility = "collapsed";

export function parseReasoningVisibility(value: unknown): ReasoningVisibility {
  return value === "expanded" ? "expanded" : DEFAULT_REASONING_VISIBILITY;
}

type Listener = () => void;

let visibility: ReasoningVisibility = DEFAULT_REASONING_VISIBILITY;
const listeners = new Set<Listener>();

export function reasoningVisibility(): ReasoningVisibility {
  return visibility;
}

/**
 * The Profile-level presentation preference, mirrored into the transcript
 * renderer the same way the global tool-steps override is: the parts view
 * sits ten layers under the profile draft, and the ownership rule forbids
 * re-plumbing `app.tsx` to carry a display flag. The active profile's
 * `presentation.reasoningVisibility` is written here by the one effect that
 * owns profile presentation, so every mounted transcript sees the change in
 * the same frame the profile switch lands.
 */
export function setReasoningVisibility(next: ReasoningVisibility): void {
  if (next === visibility) return;
  visibility = next;
  for (const listener of listeners) listener();
}

export function subscribeReasoningVisibility(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useReasoningVisibility(): ReasoningVisibility {
  const [value, setValue] = useState(visibility);
  useEffect(() => {
    setValue(visibility);
    return subscribeReasoningVisibility(() => setValue(reasoningVisibility()));
  }, []);
  return value;
}

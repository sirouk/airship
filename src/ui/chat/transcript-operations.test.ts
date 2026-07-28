import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRANSCRIPT_OPERATIONS,
  parseTranscriptOperationsMode,
  setTranscriptOperationsMode,
  subscribeTranscriptOperations,
  transcriptOperationsMode,
} from "./transcript-operations";

afterEach(() => { setTranscriptOperationsMode(DEFAULT_TRANSCRIPT_OPERATIONS); });

describe("transcript operations preference", () => {
  it("defaults to the summary mode the collapse rule is written against", () => {
    expect(DEFAULT_TRANSCRIPT_OPERATIONS).toBe("summary");
    expect(transcriptOperationsMode()).toBe("summary");
  });

  it("accepts only the two documented modes from stored preferences", () => {
    expect(parseTranscriptOperationsMode("rows")).toBe("rows");
    expect(parseTranscriptOperationsMode("summary")).toBe("summary");
    expect(parseTranscriptOperationsMode("collapsed")).toBe("summary");
    expect(parseTranscriptOperationsMode(undefined)).toBe("summary");
  });

  it("notifies subscribers once per real change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTranscriptOperations(listener);

    setTranscriptOperationsMode("rows");
    setTranscriptOperationsMode("rows");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(transcriptOperationsMode()).toBe("rows");

    unsubscribe();
    setTranscriptOperationsMode("summary");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(transcriptOperationsMode()).toBe("summary");
  });
});

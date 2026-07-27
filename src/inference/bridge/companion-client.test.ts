import { describe, expect, it } from "vitest";
import {
  PageCompanionClient,
} from "./companion-client";

const capabilities = Object.freeze({
  storage: Object.freeze({
    state: "available" as const,
    enabled: true,
    backend: "extension-indexeddb" as const,
    durability: "extension-origin-persistent" as const,
    boundary: "ciphertext-cache-only" as const,
    maxRecordBytes: 4 * 1024 * 1024,
    maxCacheBytes: 256 * 1024 * 1024,
    maxRecords: 4_096,
    records: 2,
    usageBytes: 512,
  }),
  compute: Object.freeze({
    state: "available" as const,
    execution: "extension-background" as const,
    operations: Object.freeze(["sha256", "cosine-top-k"] as const),
    maxVectorBytes: 4 * 1024 * 1024,
    maxCandidates: 512,
    maxDimensions: 2_048,
  }),
});

describe("page companion client", () => {
  it("accepts a correlated exact-origin live capability report", async () => {
    const channel = new FakeWindow((request) => ({
      airshipCompanion: 1,
      from: "extension",
      id: request.id,
      kind: "hello",
      version: "1.1.0",
      capabilities,
    }));
    const result = await new PageCompanionClient(channel.asWindow(), channel.origin).handshake(100);
    expect(result).toMatchObject({
      kind: "answered",
      version: "1.1.0",
      capabilities: {
        storage: { enabled: true, boundary: "ciphertext-cache-only" },
        compute: { execution: "extension-background" },
      },
    });
  });

  it("surfaces a companion refusal without converting it into a result", async () => {
    const channel = new FakeWindow((request) => ({
      airshipCompanion: 1,
      from: "extension",
      id: request.id,
      kind: "error",
      code: "cache-disabled",
      message: "Enable the encrypted cache first.",
    }));
    await expect(
      new PageCompanionClient(channel.asWindow(), channel.origin)
        .cacheStats("f".repeat(43)),
    ).rejects.toMatchObject({
      name: "CompanionError",
      code: "cache-disabled",
    });
  });

  it("ignores a reply from a different origin", async () => {
    const channel = new FakeWindow((request) => ({
      airshipCompanion: 1,
      from: "extension",
      id: request.id,
      kind: "hello",
      version: "1.1.0",
      capabilities,
    }), "https://untrusted.example");
    const result = await new PageCompanionClient(channel.asWindow(), "https://airship.example")
      .handshake(5);
    expect(result).toEqual({ kind: "silent", deadlineMs: 5 });
  });
});

class FakeWindow {
  readonly origin = "https://airship.example";
  readonly #listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(
    private readonly answer: (request: Record<string, unknown>) => Record<string, unknown>,
    private readonly replyOrigin = "https://airship.example",
  ) {}

  postMessage = (message: unknown): void => {
    const request = message as Record<string, unknown>;
    queueMicrotask(() => {
      const event = {
        data: this.answer(request),
        origin: this.replyOrigin,
        source: this.asWindow(),
      } as MessageEvent<unknown>;
      for (const listener of this.#listeners) listener(event);
    });
  };

  addEventListener = (_type: string, listener: EventListenerOrEventListenerObject): void => {
    this.#listeners.add(listener as (event: MessageEvent<unknown>) => void);
  };

  removeEventListener = (_type: string, listener: EventListenerOrEventListenerObject): void => {
    this.#listeners.delete(listener as (event: MessageEvent<unknown>) => void);
  };

  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);

  asWindow(): Window {
    return this as unknown as Window;
  }
}

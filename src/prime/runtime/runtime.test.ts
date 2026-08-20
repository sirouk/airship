/**
 * PrimeRuntime facade tests: create/attach/list/prompt/abort/dispose flows
 * over the memory journal, disposal serialization, and the runtime gate's
 * fail-closed fork refusals.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "../ai/providers/faux.test-support";
import type { Model } from "../ai/types";
import type { InferenceTransport } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { createSessionManifest } from "../../core/session-manifest";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PrimeRuntime, runPrimeTurn, sessionRuntimeKind } from "./runtime";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

type RuntimeFixture = Readonly<{
  registration: FauxProviderRegistration;
  model: Model<string>;
  journal: EventJournal;
  registry: ToolRegistry;
  runtime: PrimeRuntime;
}>;

async function makeRuntimeFixture(
  faux?: Parameters<typeof registerFauxProvider>[0],
): Promise<RuntimeFixture> {
  const registration = registerFauxProvider(faux ?? {});
  registrations.push(registration);
  const model = registration.getModel();
  if (!model) throw new Error("faux registration has no model");
  const journal = new EventJournal(new MemoryJournalBackend());
  const registry = new ToolRegistry();
  const runtime = new PrimeRuntime({ journal, registry, approvalPolicy: allowAllForTests });
  return { registration, model, journal, registry, runtime };
}

describe("PrimeRuntime", () => {
  it("creates sessions whose manifests are digest-identical to airship createSessionManifest output", async () => {
    const fixture = await makeRuntimeFixture();
    const now = "2026-01-01T00:00:00.000Z";
    const session = await fixture.runtime.createSession({
      title: "runtime create",
      model: fixture.model,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
        now,
      },
    });
    const direct = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "faux",
      model: fixture.model.id,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      now,
    });
    expect(session.manifest).toEqual(direct);
    expect(session.manifest.protocolVersion).toBe(2);
    expect(fixture.runtime.getSession(session.id)).toBe(session);
    const record = await fixture.journal.getSession(session.id);
    expect(record?.manifest).toEqual(direct);
  });

  it("routes prompts through the runtime registry and lists durable sessions", async () => {
    const fixture = await makeRuntimeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("runtime answer")]);
    const session = await fixture.runtime.createSession({
      model: fixture.model,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const result = await fixture.runtime.prompt(session.id, "hello");
    expect(result.outcome).toBe("completed");
    expect(result.text).toContain("runtime answer");

    const other = await fixture.runtime.createSession({
      model: fixture.model,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const listed = await fixture.runtime.listSessions();
    const ids = listed.map((record) => record.id);
    expect(ids).toContain(session.id);
    expect(ids).toContain(other.id);
    expect(listed).toHaveLength(2);
  });

  it("attaches to a durable session record, refuses duplicates and unknown ids", async () => {
    const fixture = await makeRuntimeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("attached answer")]);
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "faux",
      model: fixture.model.id,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      securityPosture: "local",
    });
    const record = await fixture.journal.createSession("to attach", manifest);

    const session = await fixture.runtime.attachSession({
      sessionId: record.id,
      model: fixture.model,
    });
    expect(session.id).toBe(record.id);
    expect(session.manifest).toEqual(manifest);
    const result = await fixture.runtime.prompt(record.id, "hi");
    expect(result.outcome).toBe("completed");

    await expect(
      fixture.runtime.attachSession({ sessionId: record.id, model: fixture.model }),
    ).rejects.toThrow(`Session ${record.id} is already attached to this runtime.`);
    await expect(
      fixture.runtime.attachSession({ sessionId: "does-not-exist", model: fixture.model }),
    ).rejects.toThrow("Unknown session: does-not-exist");
  });

  it("routes abortTurn and refuses unknown sessions", async () => {
    const fixture = await makeRuntimeFixture();
    await expect(fixture.runtime.prompt("missing", "hi")).rejects.toThrow("Unknown prime session: missing.");
    await expect(fixture.runtime.abortTurn("missing")).rejects.toThrow("Unknown prime session: missing.");

    const slow = await makeRuntimeFixture({ tokensPerSecond: 5 });
    slow.registration.setResponses([fauxAssistantMessage("slow ".repeat(400))]);
    const session = await slow.runtime.createSession({
      model: slow.model,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: slow.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const promptPromise = slow.runtime.prompt(session.id, "slow prompt");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session.getActiveTurnId()).toBeDefined();
    await slow.runtime.abortTurn(session.id, "runtime stop");
    const result = await promptPromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.reason).toBe("runtime stop");
  });

  it("serializes disposal: one session fully tears down before the next begins", async () => {
    const fixture = await makeRuntimeFixture();
    const options = (id: string) => ({
      model: fixture.model,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
      title: id,
    });
    const first = await fixture.runtime.createSession(options("first"));
    const second = await fixture.runtime.createSession(options("second"));

    const order: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const firstDispose = first.dispose.bind(first);
    const secondDispose = second.dispose.bind(second);
    first.dispose = async (reason: string) => {
      order.push("first:start");
      await delay(40);
      await firstDispose(reason);
      order.push("first:end");
    };
    second.dispose = async (reason: string) => {
      order.push("second:start");
      await secondDispose(reason);
      order.push("second:end");
    };

    await fixture.runtime.dispose();
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(fixture.runtime.getSession(first.id)).toBeUndefined();

    await fixture.runtime.dispose(); // idempotent
    await expect(
      fixture.runtime.createSession(options("third")),
    ).rejects.toThrow("The prime runtime is disposed.");
    void options;
  });

  it("gate: evidence classification and fork refusals are fail-closed", async () => {
    // The classification is the gate's, so an empty journal is unclaimed land
    // rather than airship-core; the local copy that said otherwise is what
    // kept the first-turn seal from ever being written.
    expect(sessionRuntimeKind([])).toBe("unpinned");
    expect(sessionRuntimeKind([{ type: "turn.requested" }])).toBe("airship-core");
    expect(sessionRuntimeKind([{ type: "prime.kernel.job.started" }])).toBe("prime");

    const transport: InferenceTransport = {
      id: "faux",
      posture: "local",
      async *stream() {
        throw new Error("gate tests never stream through the transport");
      },
    };
    const fixture = await makeRuntimeFixture();

    // Explicit prime selection on a session with no prime.* evidence refuses with fork guidance.
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "faux",
      model: fixture.model.id,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      securityPosture: "local",
    });
    /*
     * A fresh journal is unpinned, so prime is admitted and the first prime
     * turn seals it — the durable statement the Proof view reads. The seal is
     * written before the session runs, so it lands whatever the turn then does
     * with this deliberately unusable transport.
     */
    const plain = await fixture.journal.createSession("plain", manifest);
    await expect(
      runPrimeTurn({
        sessionId: plain.id,
        content: "hi",
        runtime: "prime",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const sealed = await fixture.journal.readEvents(plain.id);
    expect(sealed.filter((event) => event.type === "prime.session.runtime.seal")).toHaveLength(1);

    // The default path — no explicit `runtime` — takes the same branch, and
    // the seal is written exactly once per journal.
    const defaulted = await fixture.journal.createSession("defaulted", manifest);
    await expect(
      runPrimeTurn({
        sessionId: defaulted.id,
        content: "hi",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(
      runPrimeTurn({
        sessionId: defaulted.id,
        content: "again",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const defaultedEvents = await fixture.journal.readEvents(defaulted.id);
    expect(defaultedEvents.filter((event) => event.type === "prime.session.runtime.seal")).toHaveLength(1);

    // Durable airship turn history is what refuses prime, not the mere
    // presence of a creation record.
    const airship = await fixture.journal.createSession("airship", manifest);
    await fixture.journal.append(airship.id, [
      { type: "turn.requested", turnId: "t-1", payload: { content: "hi" } },
      { type: "inference.started", turnId: "t-1", payload: { step: 0 } },
    ]);
    await expect(
      runPrimeTurn({
        sessionId: airship.id,
        content: "hi",
        runtime: "prime",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session to use the PRIME runtime");

    // Provider-pin mismatch names fork the session.
    const wrongTransport: InferenceTransport = { ...transport, id: "not-faux" };
    await expect(
      runPrimeTurn({
        sessionId: plain.id,
        content: "hi",
        transport: wrongTransport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session");

    // A prime-pinned session (prime.* evidence in its journal) refuses airship-core selection.
    fixture.registration.setResponses([fauxAssistantMessage("prime answer")]);
    const primeSession = await fixture.runtime.createSession({
      model: fixture.model,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const completed = await fixture.runtime.prompt(primeSession.id, "go");
    expect(completed.outcome).toBe("completed");
    const primeEvents = await fixture.journal.readEvents(primeSession.id);
    expect(primeEvents.some((event) => event.type.startsWith("prime."))).toBe(true);
    await expect(
      runPrimeTurn({
        sessionId: primeSession.id,
        content: "again",
        runtime: "airship-core",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session to use the airship-core runtime");
  });
});

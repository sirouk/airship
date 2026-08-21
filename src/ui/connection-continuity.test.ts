import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("generic inference authority continuity", () => {
  it("admits only one exact provider, connection generation, and model tuple", () => {
    const activate = section(
      "async function activateExternalInference(",
      "async function switchExternalModel(",
    );
    expect(activate).toContain("route.pin.model.connectionId !== route.pin.connection.id");
    expect(activate).toContain("route.pin.model.connectionGeneration !== route.pin.connection.generation");
    expect(activate).toContain("route.pin.model.providerId !== route.pin.provider.id");
    expect(activate).toContain("fabric.preflight(route.pin).transport !== route.transport");
  });

  it("releases a provider connection without replacing the readable conversation", () => {
    const disconnect = section(
      "async function disconnectExternalInference(",
      "async function saveProfileRevision(",
    );
    expect(disconnect).toContain("fabric.disconnect(connectionId)");
    expect(disconnect).toContain("This conversation remains pinned and readable");
    expect(disconnect).not.toContain("createProfileSession");
    expect(disconnect).not.toContain("activateSession");
    expect(disconnect).not.toContain("setMessages");
    expect(disconnect).not.toContain("setLastReceipt");
    expect(disconnect).not.toContain("runtime.current.model =");
  });

  it("blocks every disconnected provider uniformly before invocation", () => {
    expect(source).toContain("if (turnRuntime.inferenceBinding && !inferenceConnected)");
    expect(source).toContain("resolveExternalInferencePreflight(");
    expect(source).toContain('externalPreflight.state !== "ready"');
    expect(source).toContain("your prompt, messages, journal, and workspace remain here.");
  });
});

describe("historical fork activation", () => {
  it("uses the fork-boundary model while keeping every other route fact exact", () => {
    const activation = section(
      "async function activateForkedSessionAgainst(",
      "function returnToTurn(",
    );
    expect(activation).toContain("forkActivationManifestMatches(result.session.manifest, authority.manifest)");
    expect(activation).toContain("result.session.manifest.model");
    expect(activation).toContain("sessionManifestRuntime(");
    expect(activation).not.toContain("resumableProfileManifestMatches(result.session.manifest, authority.manifest)");
  });
});

describe("exact reconnect transaction", () => {
  it("matches every authority field against the immutable conversation pin", () => {
    const prepare = section(
      "async function prepareReconnectSession(",
      "async function selectPreparedReconnectSession(",
    );
    for (const comparison of [
      "pinnedBinding.providerId !== intent.providerId",
      "effectiveSessionModel(target) !== intent.model",
      "pinnedBinding.authMethod !== intent.method",
      "pinnedBinding.connectionId !== intent.connectionId",
      "pinnedBinding.connectionGeneration !== intent.connectionGeneration",
    ]) expect(prepare).toContain(comparison);
    expect(prepare).toContain("candidateRuntime.journal.getSession(intent.returnSessionId, signal)");
    expect(prepare).toContain("sessionAuditRefusesResume(audited.report)");
    expect(prepare).toContain("stageAuditedSessionPresentation(detail, audited, signal)");
  });

  it("stages selection before publishing route and transcript authority", () => {
    const activate = section(
      "async function activateExternalInference(",
      "async function switchExternalModel(",
    );
    const selection = activate.indexOf("await selectPreparedReconnectSession(");
    const routeCommit = activate.indexOf("runtime.current = committedRuntime;");
    const presentationCommit = activate.indexOf("publishSelectedAuditedSession(");
    expect(selection).toBeGreaterThan(-1);
    expect(selection).toBeLessThan(routeCommit);
    expect(routeCommit).toBeLessThan(presentationCommit);
    expect(activate.slice(routeCommit, presentationCommit)).not.toContain("await ");
  });

  it("cancels when the exact return URL changes during selection", () => {
    const requirement = section(
      "function requireCurrentReconnectIntent(",
      "function reconnectSelectionGuard(",
    );
    expect(requirement).toContain("parseAccessReconnectIntent(window.location.hash)");
    expect(requirement).toContain("reconnectIntentsEqual(current, intent)");
    const guard = section(
      "function reconnectSelectionGuard(",
      "function resolveExternalInferencePreflight(",
    );
    expect(guard).toContain('["hashchange", "popstate", "airship:n"] as const');
    expect(guard).toContain("window.addEventListener(type, cancelIfChanged)");
    expect(guard).toContain("window.removeEventListener(type, cancelIfChanged)");
    const transition = section(
      "async function runInferenceRouteTransition",
      "async function activateExternalInference",
    );
    expect(transition.indexOf("reconnectSelectionGuard(reconnectIntent, callerSignal)"))
      .toBeLessThan(transition.indexOf("return await operation(signal)"));
    expect(transition).toContain("if (signal?.aborted) setRuntimeStatus(statusBeforeTransition)");
  });

  it("abandons by replacing the return entry so Back cannot resurrect it", () => {
    const abandon = section("function abandonReconnectRequest()", "function navigatePrimary(");
    expect(abandon).toContain('window.history.replaceState({ view: "access" }, "", "#connection")');
    expect(abandon).not.toContain("pushState");
    expect(abandon).toContain("setDestinationArrival");
  });
});

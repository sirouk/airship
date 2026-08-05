import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FORK_RETRY_TOOLTIP } from "./chat/fork-notice";
import { postureFloorRefusal } from "./posture-floor";
import { PROFILE_POSTURE_FIELD_LABEL, PROFILE_POSTURE_LABELS } from "./profiles-governance";
import { ROUTE_FAILURE_RELOAD_LABEL, ROUTE_FAILURE_RELOAD_REASON, routeRetryLabel } from "./route-failure";
import { postureLabel } from "./trust-language";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
const routeFailure = await readFile(new URL("./route-failure.tsx", import.meta.url), "utf8");

/** Every route that renders from a deferred chunk, with the state that carries its failure. */
const DEFERRED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["All conversations", "sessionsViewError"],
  ["Editor", "editorViewError"],
  ["Terminal", "terminalViewError"],
  ["Memory", "memoryViewError"],
  ["Skills", "skillsViewError"],
  ["Capabilities", "capabilitiesViewError"],
  ["Vault", "vaultViewError"],
  ["Account", "billingViewError"],
  ["Proof", "proofViewError"],
  ["Connection", "accessViewError"],
];

/** Slots that load on their own chunk *inside* a route that already rendered. */
const DEFERRED_SLOTS: ReadonlyArray<readonly [string, string]> = [
  ["the claim stack", "proofInspectorError"],
  ["the provider fabric", "providerFabricError"],
  ["attestation evidence", "attestationsViewError"],
];

describe("a failed route chunk is a stated fact with a way out", () => {
  it("gives every deferred route the same failure panel, not eight dead ends and one Retry", () => {
    for (const [title, state] of DEFERRED_ROUTES) {
      expect(app, `${title} routes its failure through the shared component`)
        .toContain(`<RouteFailure title="${title}" message={${state}} onRetry={retryDeferredChunk}`);
    }
    // The nine hand-written `<section class="work-view panel" role="alert">`
    // branches this replaces. Each shipped a heading, one sentence and no
    // control of any kind.
    expect(app).not.toMatch(/<section class="(?:work-view )?panel" role="alert">/u);
  });

  it("states the failure inside the slot that failed, rather than in a branch the route cannot reach", () => {
    for (const [title, state] of DEFERRED_SLOTS) {
      expect(app, `${title} states its own failure`)
        .toContain(`<RouteFailure inline title="${title}" message={${state}} onRetry={retryDeferredChunk} />`);
    }
    // `accessViewError` renders only where `AccessScreen` is absent, so the
    // provider-fabric and OAuth-registration loaders writing to it were dead
    // writes: unreachable the moment the Connection route loaded.
    expect([...app.matchAll(/setAccessViewError\("/gu)]).toHaveLength(1);
    expect(app).toContain('setProviderFabricError("The provider fabric could not be loaded.');
    expect(app).toContain('setOAuthRegistrationError("Chutes OAuth registration metadata could not be loaded');
    expect(app).toContain("oauthRegistrationError ? { tone: \"error\", message: oauthRegistrationError } : undefined");
  });

  it("re-enters the loaders, because the loaders are keyed on state a user cannot change", () => {
    expect(app).toContain("function retryDeferredChunk()");
    for (const dependency of [
      "AttestationsScreen, deferredChunkAttempt]",
      "ProofInspector, deferredChunkAttempt]",
      "ProofScreen, deferredChunkAttempt]",
      "VaultScreen, deferredChunkAttempt]",
      "LocalDeviceVaultSetupScreen, deferredChunkAttempt]",
      "AccessScreen, BillingScreen, deferredChunkAttempt]",
      "activeOAuthRegistration, deferredChunkAttempt]",
      "ProviderConnectionsScreen, deferredChunkAttempt]",
      "EditorScreen, deferredChunkAttempt]",
      "TerminalScreen, deferredChunkAttempt]",
      "CapabilitiesScreen, deferredChunkAttempt]",
      "MemoryScreen, deferredChunkAttempt]",
      "SkillsScreen, deferredChunkAttempt]",
    ]) expect(app, `${dependency} re-runs on retry`).toContain(dependency);
  });

  it("writes the retry verb once", () => {
    expect(routeRetryLabel("Account")).toBe("Retry loading Account");
    expect(routeFailure).toContain("{routeRetryLabel(title)}");
    // The label is the component's, so no route can spell a tenth version.
    expect(app).not.toContain("Retry loading");
  });

  it("keeps both arms of the shared component an alert", () => {
    expect([...routeFailure.matchAll(/role="alert"/gu)]).toHaveLength(2);
  });

  /**
   * The card's whole content was the sentence plus "Retry loading Memory", and
   * a route chunk whose fetch already failed is memoised by the browser's
   * module map — so a person pressed the one verb on screen, nothing happened,
   * and the only action that does work was named nowhere on the card.
   */
  it("names the action that works once its own verb has been tried", () => {
    expect(ROUTE_FAILURE_RELOAD_LABEL).toBe("Reload Airship");
    expect(ROUTE_FAILURE_RELOAD_REASON).toMatch(/newer version of Airship was deployed/u);
    // It says what a reload does not cost, because "reload" reads as "lose it"
    // in a product whose default durability is page memory.
    expect(ROUTE_FAILURE_RELOAD_REASON).toMatch(/conversations and Vault are unaffected/u);
    // Only after a retry: offering it first would teach people to reload past
    // a transient fetch failure that the retry genuinely fixes.
    expect(routeFailure).toContain("const [retried, setRetried] = useState(false);");
    expect(routeFailure).toContain("{retried ? (");
    expect(routeFailure).toContain("setRetried(true);");
  });
});

describe("All conversations reports its own chunk failure", () => {
  it("does not leave the phone with a skeleton and a runtime line it cannot see", () => {
    // `.runtime-line` is `display: none` at 640px, so `setRuntimeStatus` was
    // the whole failure report and it was invisible on the device most likely
    // to drop a chunk fetch.
    expect(app).toContain('setSessionsViewError("The conversation history interface could not be loaded. No session or journal state changed.")');
    expect(app).toContain("setRuntimeStatus(\"Session library interface could not be loaded\")");
    // Pending still renders the skeleton: the error branch is tested first, so
    // the skeleton is reachable only while nothing has failed.
    expect(app).toMatch(/\) : sessionsViewError \? \(\s*<RouteFailure title="All conversations"/u);
    expect(app).toMatch(/<RouteSkeleton label="Loading conversation history" \/>/u);
  });
});

describe("the claim stack says when it did not load", () => {
  it("no longer claims #proof reports a chunk #proof does not own", () => {
    expect(app).not.toMatch(/which reports its own load failure/u);
    expect(app).toContain('setProofInspectorError("The claim stack could not be loaded. No receipt, evidence, or journal state changed.")');
  });

  it("states the same fact in the chat rail instead of rendering nothing", () => {
    // Matched on the element rather than on one spelling of its class list:
    // the rail's class became conditional when the claim stack learned to open
    // collapsed, and a literal slice silently stopped finding the rail at all.
    const rail = app.slice(app.search(/<aside class=(?:"inspector|\{)/u));
    expect(rail.slice(0, rail.indexOf("{view === \"sessions\""))).toContain("proofInspectorError");
  });
});

describe("Retry's branch warning reaches a touch device", () => {
  it("carries the constant that owns the sentence, not a literal that drifted from it", () => {
    // The literal it replaces said the sealed ancestor context IS carried into
    // the branch; `FORK_RETRY_TOOLTIP`, beside the post-click headlines it has
    // to agree with, says the prior answer is not.
    expect(app).not.toContain("Regenerate in a bounded-context fork");
    expect(app).toContain("title={FORK_RETRY_TOOLTIP}");
    expect(FORK_RETRY_TOOLTIP).toMatch(/new branch/u);
  });

  it("renders it as text where `.message-actions` is display:none", () => {
    const touch = app.slice(app.indexOf("<details class=\"message-actions-touch\">"));
    const disclosure = touch.slice(0, touch.indexOf("</details>"));
    expect(disclosure).toContain("{FORK_RETRY_TOOLTIP}</small>");
    // The control keeps its one-word accessible name; the sentence is a
    // sibling the same group exposes.
    expect(disclosure).toContain(">Retry</button>");
    expect(disclosure).toContain("aria-describedby={`retry-branch-note-${message.id}`}");
  });
});

describe("a profile's minimum proof is refused in the words it was set in", () => {
  const POSTURES = ["local", "plaintext-remote", "encrypted-unattested", "encrypted-attested"] as const;

  it("never prints a raw union member, and always names a way out", () => {
    for (const runtime of POSTURES) {
      for (const floor of POSTURES) {
        const message = postureFloorRefusal(runtime, floor);
        for (const raw of POSTURES) {
          expect(message, `${runtime}/${floor} keeps ${raw} internal`).not.toContain(raw);
        }
        expect(message).toContain(postureLabel(runtime));
        expect(message).toContain(PROFILE_POSTURE_LABELS[floor]);
        expect(message).toContain(PROFILE_POSTURE_FIELD_LABEL);
        expect(message).toMatch(/Connect a provider that meets it, or lower/u);
      }
    }
  });

  it("is built from the dictionaries, not a third spelling at the throw site", () => {
    expect(app).toContain("postureFloorRefusal(runtime.transport.posture, pin.minimumPosture)");
    expect(app).not.toContain("minimum posture");
  });
});

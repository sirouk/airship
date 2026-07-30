import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

/**
 * Both routes that switch a profile own the outcome locally.
 *
 * `ProfileManagerView` and `SkillsManagerView` route every other mutation they
 * perform — save, fork, archive, each skill write — through their own `status`
 * element, but activation was a fire-and-forget `void onActivate(…)`. A refused
 * switch had to be inferred from the route not changing.
 *
 * Awaiting is necessary but not sufficient, and this is the correction the first
 * pass at it missed: the App-level wrapper (`requestProfileChange`) is built so
 * that it *cannot reject* — its docblock says so, and its catch turns every
 * refusal into the topbar runtime line and `false`. A handler that awaits and
 * only catches therefore surfaces nothing at all, and its `catch` body is
 * unreachable from these two call sites. The outcome has to be a returned
 * boolean, and both editors have to read it. `busy` is part of the fix rather
 * than decoration: a switch mid-negotiation must not accept a second one.
 *
 * Asserted at source because the defect is the shape of the call, and the paths
 * involved — a conversation transition still committing, a refused encrypted
 * catalog write — are reachable in a render test only by rebuilding the whole
 * cockpit around them.
 */
describe("the routes that switch profiles report their own failures", () => {
  /** One component's whole body: its declaration up to the next top-level one. */
  const view = (name: string) => {
    const start = app.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = app.indexOf("\nfunction ", start + 1);
    return app.slice(start, end < 0 ? app.length : end);
  };

  it("awaits activation inside the Profiles editor's own status handling", () => {
    const profiles = view("ProfileManagerView");
    expect(profiles).toContain("async function activate() {");
    expect(profiles).toContain("onClick={() => void activate()}");
    expect(profiles).not.toContain("onClick={() => void onActivate(");
    const start = profiles.indexOf("async function activate() {");
    const activate = profiles.slice(start, profiles.indexOf("return (", start));
    // The refusal path that actually happens: a boolean, read and reported.
    expect(activate).toContain("if (!await onActivate(selected.profileId)) {");
    expect(activate).toContain("did not become active");
    // The catch is the defence for a prop that rejects, kept but not relied on.
    expect(activate).toContain("setStatus(error instanceof Error ? error.message : String(error));");
    expect(activate).toContain("setBusy(true);");
    expect(activate).toContain("setBusy(false);");
  });

  it("does the same on the Skills route, whose target is a preview selector", () => {
    const skills = view("SkillsManagerView");
    expect(skills).toContain("async function applyProfile(): Promise<void> {");
    expect(skills).toContain("if (!await onApply(profile.profileId)) {");
    expect(skills).toContain("did not become active");
    expect(skills).not.toContain("void onApply(");
    // The control names the profile that becomes active, not just the verb: its
    // subject is a preview selector, not a row the operator clicked.
    expect(skills).toContain("onClick={() => void applyProfile()}>Switch to {profile.name}<");
  });

  it("types both props as the outcome they must report", () => {
    // A `Promise<void>` prop is what made the boolean unreadable, and the wiring
    // has to hand the answer back rather than swallow it into a navigation.
    expect(app).toContain("onActivate: (profileId: string) => Promise<boolean>;");
    expect(app).toContain("onApply: (profileId: string) => Promise<boolean>;");
    expect([...app.matchAll(/const activated = await requestProfileChange\(id, true\);/gu)]).toHaveLength(2);
    expect([...app.matchAll(/return activated;/gu)]).toHaveLength(2);
  });
});

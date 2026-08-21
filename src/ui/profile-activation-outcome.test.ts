import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [app, skillsRoute] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./skills-manager-view.tsx", import.meta.url), "utf8"),
]);

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
 * refusal into a non-throwing outcome. A handler that awaits and only catches
 * therefore surfaces nothing at all. The outcome must carry the exact refusal
 * message back to both initiating routes; a global status line is hidden on
 * phones and truncated on touch tablets.
 *
 * Asserted at source because the defect is the shape of the call, and the paths
 * involved — a conversation transition still committing, a refused encrypted
 * catalog write — are reachable in a render test only by rebuilding the whole
 * cockpit around them.
 */
describe("the routes that switch profiles report their own failures", () => {
  /** One component's whole body: its declaration up to the next top-level one. */
  const view = (name: string) => {
    const source = name === "SkillsManagerView" ? skillsRoute : app;
    const start = source.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = source.indexOf("\nfunction ", start + 1);
    return source.slice(start, end < 0 ? source.length : end);
  };

  it("awaits activation inside the Profiles editor's own status handling", () => {
    const profiles = view("ProfileManagerView");
    expect(profiles).toContain("async function activate() {");
    expect(profiles).toContain("onClick={() => void activate()}");
    expect(profiles).not.toContain("onClick={() => void onActivate(");
    const start = profiles.indexOf("async function activate() {");
    const activate = profiles.slice(start, profiles.indexOf("return (", start));
    expect(activate).toContain("const failure = await onActivate(selected.profileId);");
    expect(activate).toContain("if (failure) setStatus(failure)");
    // The catch is the defence for a prop that rejects, kept but not relied on.
    expect(activate).toContain("setStatus(error instanceof Error ? error.message : String(error));");
    expect(activate).toContain("setBusy(true);");
    expect(activate).toContain("setBusy(false);");
    expect(profiles).toContain('<span role="status" aria-live="polite">{status}</span>');
    expect(profiles).not.toContain("runtime status line at the top");
  });

  it("does the same on the Skills route, whose target is a preview selector", () => {
    const skills = view("SkillsManagerView");
    expect(skills).toContain("async function applyProfile(): Promise<void> {");
    expect(skills).toContain("const failure = await onApply(profile.profileId);");
    expect(skills).toContain("if (failure) setProfileSwitchFailure(failure)");
    expect(skills).not.toContain("void onApply(");
    // The control names the profile that becomes active, not just the verb: its
    // subject is a preview selector, not a row the operator clicked.
    expect(skills).toContain("onClick={() => void applyProfile()}>Switch to {profile.name}<");
    expect(skills).toContain('class="profile-switch-failure" role="alert"');
    expect(skills).toContain('aria-describedby={profileSwitchFailure ? "skill-profile-switch-failure" : undefined}');
    expect(skills.indexOf('class="profile-switch-failure"')).toBeLessThan(skills.indexOf('class="skill-grid"'));
    expect(skills).not.toContain("runtime status line at the top");
  });

  it("keeps a new-conversation refusal beside the Skills control that initiated it", () => {
    const skills = view("SkillsManagerView");
    expect(skills).toContain("async function startConversation(): Promise<void> {");
    expect(skills).toContain("const failure = await onStartConversation();");
    expect(skills).toContain("if (failure) setConversationStartFailure(failure)");
    /*
     * No pre-emptive disable left on this control. Its only producer was the
     * shell's “Stop the active turn…” refusal, and turns run per conversation:
     * a new conversation has no turn of its own to collide with. What the
     * surface reports is what the attempt returned.
     */
    expect(skills).not.toContain("startConversationDisabledReason");
    expect(skills).toContain('aria-describedby={conversationStartFailure ? "skill-conversation-start-status" : undefined}');
    expect(skills).toContain('id="skill-conversation-start-status"');
    /*
     * The refusal the route still reports is the one it can fail with — a
     * conversation transition already in flight, or a throw from the create
     * path. The shell used to add a second one on top of it, "Stop the active
     * turn before starting a new conversation.", and that one was never about
     * this verb: a new conversation has no turn to collide with, and turns run
     * per conversation. It is gone rather than reworded.
     */
    expect(app).not.toContain("Stop the active turn before starting a new conversation.");
    expect(app).toContain("A new conversation could not be started while the current session was changing. Try again.");
  });

  it("types both props as the outcome they must report", () => {
    // A `Promise<void>` prop made the outcome unreadable; the wiring has to hand
    // the exact refusal back rather than swallow it into a navigation.
    expect(app).toContain("onActivate: (profileId: string) => Promise<ProfileSwitchFailure>;");
    expect(skillsRoute).toContain("onApply: (profileId: string) => Promise<ProfileSwitchFailure>;");
    expect([...app.matchAll(/const failure = await requestProfileChange\(id, true\);/gu)]).toHaveLength(2);
    expect([...app.matchAll(/return failure;/gu)]).toHaveLength(2);
    expect(app).toContain("return message;");
  });
});

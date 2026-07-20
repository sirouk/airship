# Airship design language

## Character

Airship should feel instrument-grade: professional, regal, materially precise, quietly powerful, clean, light, inviting, and enjoyable. “Steampunk” is translated into manufacturing quality and tactile restraint—not lore, costume, or ornamental machinery.

Use:

- warm ivory or near-black work surfaces;
- ink, blued steel, oxidized brass, and restrained copper accents;
- fine engraved rules, deliberate borders, shallow material layers, and occasional knurled-control cues;
- a high-contrast editorial serif only for brief display moments, paired with a humanist system sans and a compact mono for evidence/data;
- small line icons and receipt seals whose shape communicates proof state without color;
- generous breathing room around dense, operational information.

Avoid:

- literal gears, dirigibles, captain/crew ranks, fictional places, or lore;
- generic AI purple, neon cyberpunk, scanlines, glass everywhere, broad gradients, and particle canvases;
- decorative motion, heavy shadows, ornate chrome, or bitmap texture downloads;
- copying the supplied mockup theme or layout verbatim.

The name Airship can remain a memorable product mark. Product copy stays direct: Session, Workspace, Sources, Worktree, Proof, Funding, Device—not Bridge, Engine Room, Captain, or other role-play vocabulary.

## Performance is visual quality

- Static Preact shell; meaningful UI before nonessential code loads.
- CSS and small audited SVGs instead of canvas decoration or generated textures.
- Self-hosted subset fonts only if they beat system fallbacks under measured budgets; never block the build on a third-party font host.
- Transform and opacity animation only, under 160 ms for controls; honor reduced motion.
- Virtualize large trees/logs, lazy-load code editing, Git, embedding, and graph views.
- Do not render a continuous animation loop when the interface is idle.

## Responsive parity

Desktop exposes three resizable regions: navigation/source tree, active work surface, and contextual inspector. Mobile presents the same information as top-level Chat, Workspace, Sources, and Proof views with bottom navigation and drill-in sheets. Nothing essential is desktop-only: staging, diffs, approvals, receipts, profile switching, source filters, session recovery, and funding all remain available.

## Proof icon grammar

Proof icons are compact seals, not status decoration:

- outlined circle: not checked;
- interrupted circle: checking or stale;
- solid check seal: cryptographically verified claim;
- half seal: transport/service evidence only;
- warning diamond: policy mismatch, expiry, or incomplete receipt;
- crossed seal: verification failed.

Color reinforces but never carries meaning. Selecting a seal opens the claim stack with issuer, subject, scope, age, expiry, evidence digest, verifier policy, and export action.

## Initial tokens

```css
:root {
  --paper: #f3efe5;
  --ink: #171a1d;
  --steel: #34424a;
  --brass: #9a7136;
  --copper: #a65332;
  --verdigris: #36756d;
  --signal-red: #a13b32;
  --line: color-mix(in srgb, currentColor 18%, transparent);
  --radius-control: 6px;
  --radius-panel: 10px;
}
```

Dark mode uses deep graphite rather than pure black, warm off-white text, and lower-chroma metals. Accessibility contrast, focus visibility, text scaling, touch targets, and keyboard operation are release gates rather than theme polish.


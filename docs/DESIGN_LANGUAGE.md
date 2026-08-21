# Airship design language

## Character

Airship should feel instrument-grade: professional, regal, materially precise, quietly powerful, clean, light, inviting, and enjoyable. “Steampunk” is translated into manufacturing quality and tactile restraint—not lore, costume, or ornamental machinery.

Use:

- warm ivory or near-black work surfaces;
- ink, blued steel, oxidized brass, and restrained copper accents;
- fine engraved rules, deliberate borders, shallow material layers, and occasional knurled-control cues;
- a high-contrast editorial serif only for brief display moments, paired with a humanist system sans and a compact mono for run data;
- small line icons whose shape communicates operational state without relying on color;
- generous breathing room around dense, operational information.

Avoid:

- literal gears, dirigibles, captain/crew ranks, fictional places, or lore;
- generic AI purple, neon cyberpunk, scanlines, glass everywhere, broad gradients, and particle canvases;
- decorative motion, heavy shadows, ornate chrome, or bitmap texture downloads;
- copying the supplied mockup theme or layout verbatim.

The name Airship can remain a memorable product mark. Product copy stays direct: Session, Workspace, Sources, Worktree, Providers, Vault, Device—not Bridge, Engine Room, Captain, or other role-play vocabulary.

## Performance is visual quality

- Static Preact shell; meaningful UI before nonessential code loads.
- CSS and small audited SVGs instead of canvas decoration or generated textures.
- Self-hosted subset fonts only if they beat system fallbacks under measured budgets; never block the build on a third-party font host.
- Transform and opacity animation only, under 160 ms for controls; honor reduced motion.
- Virtualize large trees/logs, lazy-load code editing, Git, embedding, and graph views.
- Do not render a continuous animation loop when the interface is idle.

## Responsive parity

Desktop exposes three resizable regions: navigation/source tree, active work surface, and contextual inspector. Mobile presents the same information as top-level Chat, Workspace, Sources, and Setup views with bottom navigation and drill-in sheets. Nothing essential is desktop-only: staging, diffs, approvals, profile switching, source filters, Run details, and session recovery all remain available.

## Operational status grammar

Status marks report product state. They do not certify a provider, model, or remote runtime:

- neutral outline: no active result;
- interrupted circle: work in progress or stale local state;
- check: the named local operation completed;
- warning diamond: action needed or incomplete local state;
- crossed mark: the named operation failed.

Color reinforces but never carries meaning. Run details expose bounded local and provider-origin metadata as trace data, with `attestation: "none"`; the interface does not turn that metadata into proof.

## Initial tokens

`src/ui/tokens.css` is the contract; this is the vocabulary it uses. The roles
below are the ones a reader meets by name — the sheet itself carries the full
set, the mode and profile overrides, and the reasoning for each value.

```css
:root {
  --ground: #101417;          /* the page beneath everything */
  --surface: #171c20;         /* a panel on the ground */
  --surface-raised: #1c2226;  /* a panel on a panel */
  --ink: #ece8de;             /* body text; --ink-muted / --ink-faint below it */
  --accent: #c19a58;          /* brass: the product's own material */
  --accent-bright: #dfba72;   /* the pressable brass, and --focus */
  --copper: #be805f;          /* a restrained material accent */
  --signal: var(--v-verified); /* successful operational state */
  --danger: var(--v-failed);  /* failed operational state */
  --line: color-mix(in srgb, currentColor 18%, transparent);
  --radius-control: 6px;
  --radius-panel: 10px;
}
```

`--brass` and `--verdigris` are aliases of the roles above rather than separate
hexes, so a palette moves in one place. `--steel` was retired once its last call
site was re-homed by role; `token-vocabulary.test.ts` holds that it does not come
back, and this block used to keep publishing it after the token was gone.

Dark mode uses deep graphite rather than pure black, warm off-white text, and lower-chroma metals. Accessibility contrast, focus visibility, text scaling, touch targets, and keyboard operation are release gates rather than theme polish.


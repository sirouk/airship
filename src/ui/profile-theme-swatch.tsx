import type { ThemeManifest } from "../profiles/domain";
import type { PresentationDefaults } from "./platform-shell";

/**
 * A theme's presentation layer, expressed in the one vocabulary the `<html>`
 * attributes use.
 *
 * `ThemeTypeScale` names the unscaled ramp 'standard' while the preference
 * layer names the same ramp 'default', and both write `data-type-scale`. The
 * two are reconciled here, at the write site, rather than by renaming the enum:
 * theme manifests are content-addressed and already persisted, so changing the
 * stored word would fail every existing catalog's digest check. One attribute,
 * one vocabulary — without invalidating sealed content.
 */
export function themePresentation(theme: ThemeManifest): PresentationDefaults {
  return Object.freeze({
    typeScale: theme.typography.scale === "standard" ? "default" : theme.typography.scale,
    density: theme.layout.density,
    corners: theme.layout.corners,
    bodyFont: theme.typography.body,
  });
}

const TYPE_SCALE_WORDS = Object.freeze({
  compact: "compact type",
  default: "default type",
  large: "large type",
  "x-large": "extra-large type",
} satisfies Record<PresentationDefaults["typeScale"], string>);

/**
 * What choosing this theme actually changes beyond colour, stated in the option
 * itself. The manifest's typography and layout are real render inputs now, so
 * the library has to name them — a preview that shows a difference the option
 * never mentioned is the same defect from the other side.
 */
export function themePresentationSummary(theme: ThemeManifest): string {
  const presentation = themePresentation(theme);
  return `${TYPE_SCALE_WORDS[presentation.typeScale]} · ${presentation.density} density · ${presentation.corners} corners`;
}

export function ProfileThemeSwatch({ theme }: { theme: ThemeManifest }) {
  const colors = [theme.colors.ground, theme.colors.surface, theme.colors.ink, theme.colors.accent, "var(--v-verified)", "var(--v-failed)"];
  // Decoration, and named as such: the swatch sits beside the theme's own name
  // and description inside the option button, so its six chips add no fact. The
  // `aria-label` it used to carry was silently discarded anyway — a bare span's
  // computed role is generic, which ARIA forbids naming — so this states the
  // real relationship instead of restating a name that never reached anyone.
  return <span class="theme-swatch six-color" aria-hidden="true">{colors.map((color, index) => <i key={`${index}:${color}`} style={{ background: color }} />)}</span>;
}

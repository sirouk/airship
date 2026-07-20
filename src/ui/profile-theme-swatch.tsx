import type { ThemeManifest } from "../profiles/domain";

export function ProfileThemeSwatch({ theme }: { theme: ThemeManifest }) {
  const colors = [theme.colors.ground, theme.colors.surface, theme.colors.ink, theme.colors.accent, "var(--v-verified)", "var(--v-failed)"];
  return <span class="theme-swatch six-color" aria-label={`${theme.name} ground, surface, ink, accent, verified signal, and danger colors`}>{colors.map((color, index) => <i key={`${index}:${color}`} style={{ background: color }} />)}</span>;
}

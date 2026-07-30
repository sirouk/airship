import type { ComponentChildren, JSX } from "preact";

/*
 * Vendor brand marks.
 *
 * Unlike the stroke glyphs in `icons.tsx` — which are original artwork in this
 * set's own stroke language — these are the vendors' actual logos, drawn as
 * filled paths so the silhouette reads at 16–20px:
 *
 * - OpenAI, Anthropic and Google Drive come from Simple Icons (CC0-1.0).
 * - xAI comes from the logo published on Wikimedia Commons.
 * - Chutes is Chutes' own mark, traced from the vendor's published favicon.
 *
 * The product owner deliberately chose real vendor marks over clean-room
 * proxies; that is a licensing decision made by request, not by default.
 */
export type BrandLogoName = "chutes" | "openai" | "anthropic" | "xai" | "google-drive";

const GOOGLE_DRIVE_PATH = "M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z";

const OPENAI_PATH = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const ANTHROPIC_PATH = "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

const bodies: Record<BrandLogoName, Readonly<{ viewBox: string; body: ComponentChildren }>> = {
  chutes: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path d="M2.8 13.2C6.1 9.9 9.8 8.7 13.3 9c3 .2 5.7 1.4 7.5 3.4-1.6-.7-3.4-.7-5 .2-2.5 1.4-4 3.9-4.2 6.5-3-1.3-6.2-3.2-8.8-5.9z" />
        <path d="M12.4 22.3c.5-1.6 1.5-2.9 2.9-3.7 1.5-.8 3.1-.9 4.5-.2-1.3-.1-2.6.3-3.7 1.2-1 .9-1.7 2-1.9 3.1z" />
      </>
    ),
  },
  openai: { viewBox: "0 0 24 24", body: <path d={OPENAI_PATH} /> },
  anthropic: { viewBox: "0 0 24 24", body: <path d={ANTHROPIC_PATH} /> },
  xai: {
    viewBox: "0 0 466.04 516.93",
    body: (
      <>
        <polygon points="0.12 182.71 234.14 516.92 338.15 516.92 104.13 182.71 0.12 182.71" />
        <polygon points="0 516.92 104.08 516.92 156.08 442.67 104.04 368.34 0 516.92" />
        <polygon points="466.04 0 361.96 0 182.1 256.86 234.15 331.18 466.04 0" />
        <polygon points="380.78 516.92 466.04 516.92 466.04 37.16 380.78 158.92 380.78 516.92" />
      </>
    ),
  },
  "google-drive": { viewBox: "0 0 24 24", body: <path d={GOOGLE_DRIVE_PATH} /> },
};

export function BrandLogo({ name, size = 18, class: className }: Readonly<{
  name: BrandLogoName;
  size?: number;
  class?: string;
}>): JSX.Element {
  const definition = bodies[name];
  return (
    <svg
      aria-hidden="true"
      class={className}
      fill="currentColor"
      height={size}
      viewBox={definition.viewBox}
      width={size}
    >
      {definition.body}
    </svg>
  );
}

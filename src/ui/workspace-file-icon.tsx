/**
 * A small, deterministic file-icon model for the Workspace workbench.
 *
 * The path is the authority. Icons do not depend on file bytes, language
 * services, network packs, or the active editor, so Explorer and document tabs
 * cannot disagree while a file is still loading. The visible marks mirror the
 * familiar workbench grammar (TS, JS, MD, {}, and so on), while `data-file-kind`
 * gives themes and regression tests a stable semantic hook.
 */

export type WorkspaceFileIconKind =
  | "archive"
  | "binary"
  | "config"
  | "document"
  | "go"
  | "image"
  | "javascript"
  | "json"
  | "markdown"
  | "markup"
  | "python"
  | "rust"
  | "shell"
  | "stylesheet"
  | "text"
  | "typescript";

export type WorkspaceFileIconDescriptor = Readonly<{
  kind: WorkspaceFileIconKind;
  mark: string;
  label: string;
}>;

const DESCRIPTORS: Readonly<Record<WorkspaceFileIconKind, WorkspaceFileIconDescriptor>> = Object.freeze({
  archive: Object.freeze({ kind: "archive", mark: "ZIP", label: "Archive file" }),
  binary: Object.freeze({ kind: "binary", mark: "01", label: "Binary file" }),
  config: Object.freeze({ kind: "config", mark: "CFG", label: "Configuration file" }),
  document: Object.freeze({ kind: "document", mark: "DOC", label: "Document file" }),
  go: Object.freeze({ kind: "go", mark: "GO", label: "Go file" }),
  image: Object.freeze({ kind: "image", mark: "IMG", label: "Image file" }),
  javascript: Object.freeze({ kind: "javascript", mark: "JS", label: "JavaScript file" }),
  json: Object.freeze({ kind: "json", mark: "{}", label: "JSON file" }),
  markdown: Object.freeze({ kind: "markdown", mark: "MD", label: "Markdown file" }),
  markup: Object.freeze({ kind: "markup", mark: "<>", label: "Markup file" }),
  python: Object.freeze({ kind: "python", mark: "PY", label: "Python file" }),
  rust: Object.freeze({ kind: "rust", mark: "RS", label: "Rust file" }),
  shell: Object.freeze({ kind: "shell", mark: ">$", label: "Shell file" }),
  stylesheet: Object.freeze({ kind: "stylesheet", mark: "CSS", label: "Stylesheet" }),
  text: Object.freeze({ kind: "text", mark: "TXT", label: "Text file" }),
  typescript: Object.freeze({ kind: "typescript", mark: "TS", label: "TypeScript file" }),
});

const SPECIAL_BASENAMES: Readonly<Record<string, WorkspaceFileIconKind>> = Object.freeze({
  ".dockerignore": "config",
  ".editorconfig": "config",
  ".env": "config",
  ".gitattributes": "config",
  ".gitignore": "config",
  ".gitkeep": "config",
  ".npmrc": "config",
  ".prettierignore": "config",
  ".prettierrc": "config",
  "cargo.lock": "config",
  "cargo.toml": "config",
  "compose.yaml": "config",
  "compose.yml": "config",
  "docker-compose.yaml": "config",
  "docker-compose.yml": "config",
  "dockerfile": "config",
  "go.mod": "config",
  "go.sum": "config",
  "license": "text",
  "makefile": "config",
  "package-lock.json": "json",
  "pnpm-lock.yaml": "config",
  "readme": "markdown",
  "tsconfig.json": "json",
  "yarn.lock": "config",
});

const EXTENSION_KINDS: Readonly<Record<string, WorkspaceFileIconKind>> = Object.freeze({
  "7z": "archive",
  avi: "binary",
  bash: "shell",
  bin: "binary",
  bmp: "image",
  bz2: "archive",
  cjs: "javascript",
  conf: "config",
  config: "config",
  css: "stylesheet",
  csv: "text",
  cts: "typescript",
  doc: "document",
  docx: "document",
  env: "config",
  gif: "image",
  go: "go",
  gz: "archive",
  htm: "markup",
  html: "markup",
  ico: "image",
  ini: "config",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  lock: "config",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mov: "binary",
  mp3: "binary",
  mp4: "binary",
  mts: "typescript",
  pdf: "document",
  png: "image",
  ps1: "shell",
  py: "python",
  pyw: "python",
  rar: "archive",
  rs: "rust",
  sass: "stylesheet",
  scss: "stylesheet",
  sh: "shell",
  svg: "image",
  tar: "archive",
  toml: "config",
  ts: "typescript",
  tsv: "text",
  tsx: "typescript",
  txt: "text",
  wasm: "binary",
  wav: "binary",
  webp: "image",
  xls: "document",
  xlsx: "document",
  xml: "markup",
  yaml: "config",
  yml: "config",
  zip: "archive",
  zsh: "shell",
});

export function workspaceFileIconDescriptor(path: string): WorkspaceFileIconDescriptor {
  const basename = path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase("en-US");
  const special = SPECIAL_BASENAMES[basename];
  if (special) return DESCRIPTORS[special];
  // Declaration files still read as TypeScript; checking only the final
  // extension also handles ordinary compound names without a growing table.
  if (basename.endsWith(".d.ts") || basename.endsWith(".d.mts") || basename.endsWith(".d.cts")) {
    return DESCRIPTORS.typescript;
  }
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".") + 1) : "";
  return DESCRIPTORS[EXTENSION_KINDS[extension] ?? "text"];
}

/**
 * The mark's size in `ICON_VIEWBOX` user units.
 *
 * The badge is drawn, not typeset: its size belongs to the viewBox, so the
 * rendered mark is a fixed fraction of whatever the box resolves to. That is
 * what lets the icon answer the reader's Type scale preference — a CSS
 * `font-size: 6px` on a decorative mark is a size `--type-scale` cannot move,
 * and it was one before this became an `<svg>`.
 *
 * Three-character marks lose the width two-character marks can spend, and the
 * symbol pairs (`{}`, `<>`, `>$`) read as shapes rather than letters, so they
 * carry the optical weight the letterforms get from their strokes.
 */
export function workspaceFileIconMarkUnits(mark: string): number {
  if (mark.length > 2) return 8;
  return /^[\p{L}\p{N}]+$/u.test(mark) ? 9.5 : 12.5;
}

const ICON_VIEWBOX = "0 0 24 24";

export function WorkspaceFileIcon({ path, class: className }: Readonly<{ path: string; class?: string }>) {
  const descriptor = workspaceFileIconDescriptor(path);
  return (
    <svg
      aria-hidden="true"
      class={["workspace-file-icon", className].filter(Boolean).join(" ")}
      data-file-kind={descriptor.kind}
      viewBox={ICON_VIEWBOX}
    >
      <title>{descriptor.label}</title>
      <text
        dominant-baseline="central"
        font-size={workspaceFileIconMarkUnits(descriptor.mark)}
        text-anchor="middle"
        x="12"
        y="12.5"
      >{descriptor.mark}</text>
    </svg>
  );
}

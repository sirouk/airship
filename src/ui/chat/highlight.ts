/**
 * Bounded, zero-dependency code tokenisation for transcript code blocks.
 *
 * The scanner is deliberately shallow: it recognises comments, string
 * literals, numbers, keywords and call sites, and nothing else. An unknown
 * language returns no spans and the block renders exactly as it does today —
 * a wrong-language guess would be worse than plain monospace.
 */

export type HighlightKind = "com" | "str" | "num" | "kw" | "fn";

export type HighlightSpan = Readonly<{
  start: number;
  end: number;
  kind: HighlightKind;
}>;

export const HIGHLIGHT_LIMITS = Object.freeze({
  /**
   * Mirrors `MARKDOWN_LIMITS.codeChars`. Declared literally rather than
   * imported so the renderer and the scanner do not form an import cycle;
   * highlight.test.ts asserts the two bounds stay equal.
   */
  chars: 32_768,
  /** A pathological block must not allocate one span per character. */
  spans: 4_096,
  /** Fence infos like ```ts title=x carry more than a language name. */
  languageChars: 40,
});

type Rule = Readonly<{ kind: HighlightKind; source: string }>;

/**
 * Keyword tables as pre-joined alternations: measured, halving them moved the
 * gzipped bundle by 0.04 KiB, so completeness costs nothing worth trading.
 * A word left out simply renders in the default ink.
 */
const C_LIKE_KEYWORDS = "abstract|as|async|await|break|case|catch|class|const|constructor|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|keyof|let|new|null|of|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield";

const RUST_KEYWORDS = "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while";

const PYTHON_KEYWORDS = "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield";

const SHELL_KEYWORDS = "case|do|done|elif|else|esac|export|fi|for|function|if|in|local|return|then|until|while";

const C_LIKE_RULES: readonly Rule[] = Object.freeze([
  { kind: "com", source: "//[^\\n]*|/\\*[\\s\\S]*?\\*/" },
  { kind: "str", source: "\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`" },
  { kind: "num", source: "\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b" },
  { kind: "kw", source: `\\b(?:${C_LIKE_KEYWORDS})\\b` },
  { kind: "fn", source: "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()" },
]);

const RUST_RULES: readonly Rule[] = Object.freeze([
  { kind: "com", source: "//[^\\n]*|/\\*[\\s\\S]*?\\*/" },
  { kind: "str", source: "r?\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\\\n])'" },
  { kind: "num", source: "\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?)(?:[iuf](?:8|16|32|64|128|size))?\\b" },
  { kind: "kw", source: `\\b(?:${RUST_KEYWORDS})\\b` },
  { kind: "fn", source: "\\b[A-Za-z_][\\w]*!?(?=\\s*[(\\[])" },
]);

const PYTHON_RULES: readonly Rule[] = Object.freeze([
  { kind: "com", source: "#[^\\n]*" },
  { kind: "str", source: "\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|[rbfu]{0,2}\"(?:\\\\.|[^\"\\\\\\n])*\"|[rbfu]{0,2}'(?:\\\\.|[^'\\\\\\n])*'" },
  { kind: "num", source: "\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b" },
  { kind: "kw", source: `\\b(?:${PYTHON_KEYWORDS})\\b` },
  { kind: "fn", source: "\\b[A-Za-z_][\\w]*(?=\\s*\\()" },
]);

const JSON_RULES: readonly Rule[] = Object.freeze([
  { kind: "str", source: "\"(?:\\\\.|[^\"\\\\])*\"" },
  { kind: "num", source: "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b" },
  { kind: "kw", source: "\\b(?:true|false|null)\\b" },
]);

const SHELL_RULES: readonly Rule[] = Object.freeze([
  { kind: "com", source: "#[^\\n]*" },
  { kind: "str", source: "\"(?:\\\\.|[^\"\\\\])*\"|'[^']*'" },
  { kind: "num", source: "\\b\\d+\\b" },
  { kind: "kw", source: `\\b(?:${SHELL_KEYWORDS})\\b` },
  { kind: "fn", source: "^\\s*[A-Za-z_][\\w.-]*(?=\\s)" },
]);

/**
 * Markdown inside a fence: structure markers read as keywords, literal spans
 * (code, fences) as strings, link targets as call sites. No colour here means
 * "verified" or "failed" — it is only shape.
 */
const MARKDOWN_RULES: readonly Rule[] = Object.freeze([
  { kind: "str", source: "```[^\\n]*|`[^`\\n]+`" },
  { kind: "kw", source: "^ {0,3}(?:#{1,6} [^\\n]*|>[^\\n]*|(?:-{3,}|\\*{3,})$|[-*+] |\\d+\\. )" },
  { kind: "fn", source: "\\[[^\\]\\n]*\\]\\([^\\s)]*\\)" },
]);

const GRAMMARS: Readonly<Record<string, readonly Rule[]>> = Object.freeze({
  ts: C_LIKE_RULES, tsx: C_LIKE_RULES, typescript: C_LIKE_RULES,
  js: C_LIKE_RULES, jsx: C_LIKE_RULES, javascript: C_LIKE_RULES,
  mjs: C_LIKE_RULES, cjs: C_LIKE_RULES,
  rust: RUST_RULES, rs: RUST_RULES,
  python: PYTHON_RULES, py: PYTHON_RULES,
  json: JSON_RULES, jsonc: JSON_RULES,
  bash: SHELL_RULES, sh: SHELL_RULES, shell: SHELL_RULES, zsh: SHELL_RULES, console: SHELL_RULES,
  md: MARKDOWN_RULES, markdown: MARKDOWN_RULES,
});

const COMPILED = new WeakMap<readonly Rule[], RegExp>();

/**
 * The fence info is everything after the backticks (```ts title=foo yields
 * "ts title=foo"), so an exact-match lookup would silently miss.
 */
export function normalizeHighlightLanguage(language: string | undefined): string | undefined {
  const first = language?.slice(0, HIGHLIGHT_LIMITS.languageChars).trim().split(/\s+/u)[0];
  return first ? first.toLowerCase() : undefined;
}

export function highlightSupportsLanguage(language: string | undefined): boolean {
  const key = normalizeHighlightLanguage(language);
  return Boolean(key && key in GRAMMARS);
}

/**
 * Non-overlapping spans in source order. Text outside every span renders
 * unchanged, so concatenating the slices always reproduces the input exactly.
 */
export function highlightSpans(language: string | undefined, text: string): readonly HighlightSpan[] {
  const key = normalizeHighlightLanguage(language);
  const rules = key ? GRAMMARS[key] : undefined;
  if (!rules || !text) return EMPTY_SPANS;
  const bounded = text.length > HIGHLIGHT_LIMITS.chars ? text.slice(0, HIGHLIGHT_LIMITS.chars) : text;
  const pattern = compile(rules);
  pattern.lastIndex = 0;
  const spans: HighlightSpan[] = [];
  for (const match of bounded.matchAll(pattern)) {
    if (spans.length >= HIGHLIGHT_LIMITS.spans) break;
    const token = match[0];
    if (!token) continue;
    const kind = rules[matchedRuleIndex(match)]?.kind;
    if (!kind) continue;
    spans.push(Object.freeze({ start: match.index, end: match.index + token.length, kind }));
  }
  return Object.freeze(spans);
}

const EMPTY_SPANS: readonly HighlightSpan[] = Object.freeze([]);

function compile(rules: readonly Rule[]): RegExp {
  const cached = COMPILED.get(rules);
  if (cached) return cached;
  // One alternation in rule order: `matchAll` then guarantees the matches are
  // non-overlapping and monotonic, and earlier rules win at the same offset.
  const pattern = new RegExp(rules.map((rule) => `(${rule.source})`).join("|"), "gmu");
  COMPILED.set(rules, pattern);
  return pattern;
}

function matchedRuleIndex(match: RegExpExecArray | RegExpMatchArray): number {
  for (let group = 1; group < match.length; group += 1) {
    if (match[group] !== undefined) return group - 1;
  }
  return -1;
}

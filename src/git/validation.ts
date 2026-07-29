import { GitAbortError, GitDomainError, GitValidationError } from "./errors";
import { isAirshipReservedPath } from "../workspace/contracts";

const encoder = new TextEncoder();
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[A-Za-z0-9_-]{32,})$/u;

export const GIT_LIMITS = Object.freeze({
  maxPathBytes: 4_096,
  maxSegmentBytes: 255,
  /** Per-adapter-call safety bound. One reviewed request may span several calls. */
  maxPathsPerOperation: 512,
  /** Request-level bound: at least the repository importer's default file count. */
  maxPathsPerRequest: 4_096,
  maxCommitMessageBytes: 64 * 1_024,
  maxAuthorNameBytes: 256,
  maxEmailBytes: 320,
  maxRemoteUrlBytes: 4_096,
  maxDiffBytes: 512 * 1_024,
  maxFileBytes: 8 * 1_024 * 1_024,
  maxSeedFiles: 50_000,
  /** `git log` walks parents eagerly; rename following is quadratic in depth. */
  maxLogDepth: 512,
  /** Per-commit patch fan-out for `show`; larger commits report truncation. */
  maxCommitPatchPaths: 64,
  maxTagMessageBytes: 16 * 1_024,
  maxStashEntries: 128,
});

/**
 * Exact origins this build's shipped Content-Security-Policy `connect-src`
 * permits for Git Smart HTTP, beyond `'self'`. index.html and public/_headers
 * name `api.github.com` and `raw.githubusercontent.com` — both REST/CDN hosts
 * used by the snapshot importer, neither of which serves `/info/refs` — so no
 * cross-origin Git host is reachable from the page at all. The list stays empty
 * until a Git host is added to the policy; src/git/validation.test.ts pins it
 * against the two shipped policy documents so the two cannot drift apart.
 */
export const GIT_REMOTE_CONNECT_ORIGINS: readonly string[] = Object.freeze([]);

/**
 * The page's own origin is reachable through `connect-src 'self'`, so a Git
 * remote served beside Airship is genuinely usable. A host without a document
 * origin (Node, a test runner) cannot prove any origin is permitted, so it
 * contributes nothing and every cross-origin remote fails closed.
 */
export function gitRemoteConnectOrigins(): readonly string[] {
  const page = pageOrigin();
  return Object.freeze(page ? [page, ...GIT_REMOTE_CONNECT_ORIGINS] : [...GIT_REMOTE_CONNECT_ORIGINS]);
}

export function pageOrigin(): string | undefined {
  const candidate = (globalThis as { location?: { origin?: string } }).location?.origin;
  return typeof candidate === "string" && candidate && candidate !== "null" ? candidate : undefined;
}

/**
 * Fail before the request leaves the adapter. A CSP block and a remote CORS
 * refusal both surface as an opaque `TypeError: Failed to fetch`, so without
 * this gate Airship would blame the remote for a decision its own page policy
 * made.
 */
export function assertRemoteOriginPermitted(url: string, operation: "clone" | "fetch" | "push"): string {
  const origin = new URL(validateRemoteUrl(url)).origin;
  const permitted = gitRemoteConnectOrigins();
  if (permitted.includes(origin)) return origin;
  throw new GitDomainError(
    "remote-origin-not-permitted",
    `Airship's own Content-Security-Policy blocks a direct Git ${operation} to ${origin}; the request was never sent. `
    + `This build permits Git Smart HTTP only to ${permitted.length ? permitted.join(", ") : "no origin at all — not even its own, because this host has no document origin"}. `
    + "github.com and gitlab.com are not permitted and grant no CORS on their Git endpoints regardless. "
    + "Use the GitHub snapshot importer, which reads api.github.com and raw.githubusercontent.com.",
  );
}

/**
 * The same question `assertRemoteOriginPermitted` answers, asked without
 * throwing and against a capability snapshot rather than the ambient page.
 * Reachability is a property of one remote URL, not of the build: a surface
 * that reads `features.fetch.available` learns only that *some* origin is
 * permitted (the page's own always is), which says nothing about the remote
 * actually configured. Any UI offering fetch/push must ask about that remote.
 * An unparseable URL is unreachable — it can never match a permitted origin.
 */
export function isRemoteOriginPermitted(url: string, permittedOrigins: readonly string[]): boolean {
  const origin = remoteOrigin(url);
  return origin !== undefined && permittedOrigins.includes(origin);
}

/** The origin a remote URL would be contacted on, or undefined if it is not a URL. */
export function remoteOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new GitAbortError();
}

export function validateGitIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new GitValidationError(`${label} must be 1-128 ASCII letters, numbers, dots, underscores, colons, or dashes.`);
  }
  return value;
}

export function validateRepositoryName(value: string): string {
  const name = validateText(value, "Repository name", 160, false).trim();
  if (!name) throw new GitValidationError("Repository name cannot be empty.");
  return name;
}

/** Validate an adapter-relative Git path. Host absolute paths are intentionally outside this domain. */
export function validateGitPath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || CONTROL.test(value)) {
    throw new GitValidationError("Git paths must be non-empty relative paths without controls or backslashes.");
  }
  if (value !== value.normalize("NFC")) throw new GitValidationError("Git paths must use canonical NFC Unicode.");
  if (encoder.encode(value).byteLength > GIT_LIMITS.maxPathBytes) throw new GitValidationError("Git path is too long.");
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new GitValidationError("Git paths cannot contain empty, dot, or parent segments.");
    }
    if (encoder.encode(segment).byteLength > GIT_LIMITS.maxSegmentBytes) {
      throw new GitValidationError("Git path contains an overlong segment.");
    }
    if (segment.toLowerCase() === ".git") throw new GitValidationError("Git metadata paths cannot be materialized as worktree files.");
    if (WINDOWS_DEVICE.test(segment) || /[<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment)) {
      throw new GitValidationError("Git path is unsafe on supported cross-platform filesystems.");
    }
  }
  return value;
}

export function validatePathList(paths: readonly string[], limit: number = GIT_LIMITS.maxPathsPerOperation): readonly string[] {
  if (paths.length < 1 || paths.length > limit) {
    throw new GitValidationError(`Select between 1 and ${limit} paths.`);
  }
  const normalized = paths.map(validateGitPath);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw new GitValidationError("A Git path may appear only once per operation.");
  return Object.freeze([...normalized].sort(asciiCompare));
}

export function assertNoCaseFoldCollisions(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const valid = validateGitPath(path);
    const folded = valid.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = seen.get(folded);
    if (previous && previous !== valid) {
      throw new GitValidationError(`Git paths ${previous} and ${valid} collide on case-insensitive filesystems.`);
    }
    seen.set(folded, valid);
  }
}

export function validateBranchName(value: string): string {
  return validateRefName(value, "Branch name");
}

export function validateTagName(value: string): string {
  return validateRefName(value, "Tag name");
}

function validateRefName(value: string, label: string): string {
  if (!value || value.length > 255 || CONTROL.test(value) || /[ ~^:?*[\\]/u.test(value)) {
    throw new GitValidationError(`${label} contains characters Git does not permit.`);
  }
  if (
    value === "@" || value.startsWith("/") || value.endsWith("/") || value.startsWith(".") ||
    value.endsWith(".") || value.endsWith(".lock") || value.includes("..") || value.includes("//") ||
    value.includes("@{")
  ) {
    throw new GitValidationError(`${label} is not a safe Git reference name.`);
  }
  return value;
}

/** A 40-hex SHA-1, an adapter-declared content digest, or a plain ref name. Revision expressions (HEAD~1, @{u}) are deliberately not parsed. */
export function validateRevision(value: string): string {
  if (OBJECT_ID.test(value)) return value;
  return validateRefName(value, "Revision");
}

export function validateObjectId(value: string): string {
  if (!OBJECT_ID.test(value)) throw new GitValidationError("A Git object id must be a 40-character SHA-1 or an adapter-declared content digest.");
  return value;
}

export function validateBoundedCount(value: number | undefined, label: string, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new GitValidationError(`${label} must be a whole number between 1 and ${max}.`);
  }
  return value;
}

export function validateEntryIndex(value: number | undefined, label: string, max: number): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= max) {
    throw new GitValidationError(`${label} must be a whole number between 0 and ${max - 1}.`);
  }
  return value;
}

export function validateVersion(value: string, label = "Expected version"): string {
  if (!value || value.length > 256 || CONTROL.test(value)) throw new GitValidationError(`${label} is invalid.`);
  return value;
}

export function validateCommitMessage(value: string): string {
  const message = validateText(value.replaceAll("\r\n", "\n"), "Commit message", GIT_LIMITS.maxCommitMessageBytes, true);
  if (!message.trim()) throw new GitValidationError("Commit message cannot be empty.");
  return message;
}

export function validateTagMessage(value: string): string {
  const message = validateText(value.replaceAll("\r\n", "\n"), "Tag message", GIT_LIMITS.maxTagMessageBytes, true);
  if (!message.trim()) throw new GitValidationError("Tag message cannot be empty.");
  return message;
}

export function validateAuthor(author: Readonly<{ name: string; email: string }>): Readonly<{ name: string; email: string }> {
  const name = validateText(author.name, "Author name", GIT_LIMITS.maxAuthorNameBytes, false).trim();
  const email = validateText(author.email, "Author email", GIT_LIMITS.maxEmailBytes, false).trim();
  if (!name || !EMAIL.test(email)) throw new GitValidationError("Commit author name and email must be valid.");
  return Object.freeze({ name, email });
}

export function validateRemoteUrl(value: string): string {
  if (!value || value !== value.trim() || CONTROL.test(value)) throw new GitValidationError("Remote URL contains whitespace or control characters.");
  if (encoder.encode(value).byteLength > GIT_LIMITS.maxRemoteUrlBytes) throw new GitValidationError("Remote URL is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitValidationError("Remote URL must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new GitValidationError("Remote URL must be credential-free HTTPS without a query or fragment.");
  }
  return url.toString();
}

/** Validate an adapter-owned repository root inside Airship's virtual workspace. */
export function validateGitDestination(value: string): string {
  if (!value || value !== value.trim() || value.includes("\\") || CONTROL.test(value) || value !== value.normalize("NFC")) {
    throw new GitValidationError("Git destination must be a normalized workspace path.");
  }
  const rooted = value.startsWith("/") ? value : `/workspace/${value}`;
  if (encoder.encode(rooted).byteLength > GIT_LIMITS.maxPathBytes) throw new GitValidationError("Git destination is too long.");
  const parts = rooted.slice(1).split("/");
  if (!rooted.startsWith("/") || parts[0] !== "workspace" || parts.some((part) => part === "." || part === ".." || !part)) {
    throw new GitValidationError("Git destination must stay inside /workspace without dot segments.");
  }
  for (const part of parts.slice(1)) {
    if (encoder.encode(part).byteLength > GIT_LIMITS.maxSegmentBytes || part.toLowerCase() === ".git" || WINDOWS_DEVICE.test(part) || /[<>:"|?*]/u.test(part) || /[ .]$/u.test(part)) {
      throw new GitValidationError("Git destination contains a cross-platform unsafe segment.");
    }
  }
  const destination = `/${parts.join("/")}`;
  // A repository root is where clone, import and worktree creation are allowed
  // to materialize a whole tree. Rooting one in Airship's reserved namespace
  // would put that tree on top of the evidence and registry records Airship
  // reads back as its own state, before any per-path fence sees a path.
  if (isAirshipReservedPath(destination)) {
    throw new GitValidationError("A repository cannot be rooted in Airship's private control-plane namespace.");
  }
  return destination;
}

export function validateFileContent(content: string): string {
  if (encoder.encode(content).byteLength > GIT_LIMITS.maxFileBytes) {
    throw new GitValidationError(`In-memory Git files are limited to ${GIT_LIMITS.maxFileBytes} bytes.`);
  }
  return content;
}

export function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateText(value: string, label: string, maxBytes: number, allowLineBreaks: boolean): string {
  if (value.includes("\0") || (!allowLineBreaks && CONTROL.test(value))) throw new GitValidationError(`${label} contains control characters.`);
  if (encoder.encode(value).byteLength > maxBytes) throw new GitValidationError(`${label} is too long.`);
  return value;
}

import { GitAbortError, GitValidationError } from "./errors";

const encoder = new TextEncoder();
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/u;

export const GIT_LIMITS = Object.freeze({
  maxPathBytes: 4_096,
  maxSegmentBytes: 255,
  maxPathsPerOperation: 512,
  maxCommitMessageBytes: 64 * 1_024,
  maxAuthorNameBytes: 256,
  maxEmailBytes: 320,
  maxRemoteUrlBytes: 4_096,
  maxDiffBytes: 512 * 1_024,
  maxFileBytes: 8 * 1_024 * 1_024,
  maxSeedFiles: 50_000,
});

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

export function validatePathList(paths: readonly string[]): readonly string[] {
  if (paths.length < 1 || paths.length > GIT_LIMITS.maxPathsPerOperation) {
    throw new GitValidationError(`Select between 1 and ${GIT_LIMITS.maxPathsPerOperation} paths.`);
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
  if (!value || value.length > 255 || CONTROL.test(value) || /[ ~^:?*[\\]/u.test(value)) {
    throw new GitValidationError("Branch name contains characters Git does not permit.");
  }
  if (
    value === "@" || value.startsWith("/") || value.endsWith("/") || value.startsWith(".") ||
    value.endsWith(".") || value.endsWith(".lock") || value.includes("..") || value.includes("//") ||
    value.includes("@{")
  ) {
    throw new GitValidationError("Branch name is not a safe Git reference name.");
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
  return `/${parts.join("/")}`;
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

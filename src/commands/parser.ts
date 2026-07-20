import type { JsonValue } from "../core/contracts";
import type { SlashPlanErrorCode } from "./types";

export const MAX_SLASH_INPUT_CHARS = 64 * 1024;
export const MAX_SLASH_TOKENS = 128;
export const MAX_SLASH_TOKEN_CHARS = 32 * 1024;

const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,95}$/u;

export class SlashSyntaxError extends Error {
  readonly name = "SlashSyntaxError";

  constructor(
    readonly code: SlashPlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type SlashLexResult =
  | Readonly<{ kind: "chat"; content: string }>
  | Readonly<{ kind: "command"; tokens: readonly string[] }>;

/**
 * Bounded shell-like tokenization without shell semantics. Quotes group text
 * and backslash escapes one character; substitutions, pipes, redirects and
 * separators are never interpreted.
 */
export function tokenizeSlashInput(input: string): SlashLexResult {
  if (!input.startsWith("/")) return Object.freeze({ kind: "chat", content: input });
  if (input.length > MAX_SLASH_INPUT_CHARS) {
    throw new SlashSyntaxError("input-too-large", `Slash input exceeds ${MAX_SLASH_INPUT_CHARS} characters.`);
  }
  if (UNSAFE_CONTROL.test(input)) {
    throw new SlashSyntaxError("invalid-control", "Slash input contains a disallowed control character.");
  }

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let escaping = false;

  const finishToken = () => {
    if (!tokenStarted) return;
    if (token.length > MAX_SLASH_TOKEN_CHARS) {
      throw new SlashSyntaxError("token-too-large", `A slash token exceeds ${MAX_SLASH_TOKEN_CHARS} characters.`);
    }
    tokens.push(token);
    if (tokens.length > MAX_SLASH_TOKENS) {
      throw new SlashSyntaxError("too-many-tokens", `Slash input exceeds ${MAX_SLASH_TOKENS} tokens.`);
    }
    token = "";
    tokenStarted = false;
  };

  for (const character of input.slice(1)) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === "\"") quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === "\"") {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaping) throw new SlashSyntaxError("dangling-escape", "Slash input ends with an incomplete escape.");
  if (quote) throw new SlashSyntaxError("unterminated-quote", "Slash input contains an unterminated quote.");
  finishToken();
  return Object.freeze({ kind: "command", tokens: Object.freeze(tokens) });
}

export function normalizeSlashName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!COMMAND_NAME.test(normalized)) {
    throw new SlashSyntaxError("invalid-command", `Invalid slash command name: ${value || "(empty)"}.`);
  }
  return normalized;
}

export function parseJsonToken(value: string, label = "JSON value"): JsonValue {
  if (value.length > MAX_SLASH_TOKEN_CHARS) {
    throw new SlashSyntaxError("token-too-large", `${label} exceeds ${MAX_SLASH_TOKEN_CHARS} characters.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SlashSyntaxError("invalid-arguments", `${label} must be valid JSON.`);
  }
  if (!isJsonValue(parsed)) {
    throw new SlashSyntaxError("invalid-arguments", `${label} is outside the supported JSON value domain.`);
  }
  return parsed;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 10_000 && entries.every(([, item]) => isJsonValue(item, depth + 1));
}


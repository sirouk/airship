/**
 * Port of prime-agent packages/ai/src/utils/json-parse.ts. The upstream
 * implementation delegates truncated-JSON recovery to the `partial-json`
 * dependency; this library stays dependency-free, so parsePartialJson is an
 * in-house incremental parser with the same contract: always return a
 * best-effort value, never throw.
 */

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

/**
 * Repairs malformed JSON string literals by escaping raw control characters
 * inside strings and doubling backslashes before invalid escape characters.
 */
export function repairJson(json: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }

      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += "\\\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const repairedJson = repairJson(json);
    if (repairedJson !== json) {
      return JSON.parse(repairedJson) as T;
    }
    throw error;
  }
}

type Frame =
  | { kind: "object"; value: Record<string, unknown>; pendingKey?: string }
  | { kind: "array"; value: unknown[] };

/**
 * Best-effort parse of possibly-truncated JSON. Closes open containers and
 * strings, drops dangling keys/incomplete literals, and returns the deepest
 * complete value available. Never throws.
 */
export function parsePartialJson<T = unknown>(input: string): T | undefined {
  let i = 0;
  const n = input.length;
  const root: Frame[] = [];

  const current = (): Frame | undefined => root[root.length - 1];

  const pushValue = (value: unknown): void => {
    const frame = current();
    if (!frame) {
      const wrapper: Frame = { kind: "object", value: { __root__: value }, pendingKey: "__root__" };
      root.push(wrapper);
      return;
    }
    if (frame.kind === "array") {
      frame.value.push(value);
    } else if (frame.pendingKey !== undefined) {
      frame.value[frame.pendingKey] = value;
      frame.pendingKey = undefined;
    }
    // Object frame without a pending key: a second value at this depth is
    // malformed; ignore it rather than throwing.
  };

  const skipWs = () => {
    while (i < n && /\s/.test(input[i])) i++;
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const ch = input[i];

    if (ch === "{") {
      root.push({ kind: "object", value: {} });
      i++;
      continue;
    }
    if (ch === "[") {
      root.push({ kind: "array", value: [] });
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const frame = current();
      if (frame && ((ch === "}" && frame.kind === "object") || (ch === "]" && frame.kind === "array"))) {
        root.pop();
        if (frame.kind === "object") frame.pendingKey = undefined;
        pushValueFromPop(frame);
      }
      i++;
      continue;
    }
    if (ch === ",") {
      i++;
      continue;
    }
    if (ch === ":") {
      i++;
      continue;
    }
    if (ch === '"') {
      const { value, complete, next } = readString(input, i);
      i = next;
      const frame = current();
      if (frame && frame.kind === "object" && frame.pendingKey === undefined) {
        skipWs();
        if (input[i] === ":") {
          frame.pendingKey = value;
        } else if (!complete) {
          // truncated key without colon: drop it
        } else {
          // string value in key position with no colon: treat as value
          pushValue(value);
        }
      } else {
        pushValue(value);
      }
      continue;
    }
    if (ch === "t" || ch === "f" || ch === "n") {
      const { matched, complete } = readLiteral(input, i);
      if (matched !== undefined && complete) pushValue(matched);
      i = skipToBoundary(input, i);
      continue;
    }

    const num = readNumber(input, i);
    if (num !== undefined) {
      pushValue(num.value);
      i = num.next;
      continue;
    }
    i++;
  }

  // Unwind: the outermost surviving frame is the value.
  function pushValueFromPop(frame: Frame): void {
    if (root.length === 0) {
      root.push(frame);
      return;
    }
    const parent = current();
    if (parent?.kind === "array") parent.value.push(frame.value);
    else if (parent && parent.kind === "object" && parent.pendingKey !== undefined) {
      parent.value[parent.pendingKey] = frame.value;
      parent.pendingKey = undefined;
    }
  }

  const outer = root[0];
  if (!outer) return undefined;
  if (outer.kind === "object" && outer.pendingKey === "__root__") {
    return outer.value.__root__ as T;
  }
  return outer.value as T;
}

function readString(input: string, start: number): { value: string; complete: boolean; next: number } {
  let i = start + 1;
  let out = "";
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) return { value: out, complete: false, next: input.length };
      switch (next) {
        case "n":
          out += "\n";
          i += 2;
          break;
        case "t":
          out += "\t";
          i += 2;
          break;
        case "r":
          out += "\r";
          i += 2;
          break;
        case "b":
          out += "\b";
          i += 2;
          break;
        case "f":
          out += "\f";
          i += 2;
          break;
        case '"':
          out += '"';
          i += 2;
          break;
        case "\\":
          out += "\\";
          i += 2;
          break;
        case "/":
          out += "/";
          i += 2;
          break;
        case "u": {
          const hex = input.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            return { value: out, complete: false, next: input.length };
          }
          break;
        }
        default:
          out += next;
          i += 2;
      }
      continue;
    }
    if (ch === '"') return { value: out, complete: true, next: i + 1 };
    out += ch;
    i++;
  }
  return { value: out, complete: false, next: i };
}

function readLiteral(input: string, start: number): { matched: unknown; complete: boolean } {
  const rest = input.slice(start, start + 5);
  if (rest.startsWith("true")) return { matched: true, complete: true };
  if (rest.startsWith("null")) return { matched: null, complete: true };
  const rest4 = rest.slice(0, 5);
  if (rest4.startsWith("false")) return { matched: false, complete: true };
  return { matched: undefined, complete: false };
}

function skipToBoundary(input: string, start: number): number {
  let i = start;
  while (i < input.length && /[a-zA-Z]/.test(input[i])) i++;
  return i;
}

function readNumber(input: string, start: number): { value: number; next: number } | undefined {
  let i = start;
  const begin = i;
  if (input[i] === "-") i++;
  let digits = 0;
  while (i < input.length && /[0-9]/.test(input[i])) {
    i++;
    digits++;
  }
  let frac = false;
  if (input[i] === ".") {
    frac = true;
    i++;
    while (i < input.length && /[0-9]/.test(input[i])) i++;
  }
  if (input[i] === "e" || input[i] === "E") {
    i++;
    if (input[i] === "+" || input[i] === "-") i++;
    while (i < input.length && /[0-9]/.test(input[i])) i++;
  }
  const raw = input.slice(begin, i);
  if (digits === 0) return undefined;
  // Truncated number: ends mid-fraction or mid-exponent. Trim to last safe cut.
  let safe = raw;
  const m = /^(.*?[0-9])/.exec(raw);
  safe = m ? m[1] : raw;
  const value = frac ? parseFloat(safe) : parseInt(safe, 10);
  if (Number.isNaN(value)) return undefined;
  return { value, next: i };
}

/**
 * Attempts to parse potentially incomplete JSON during streaming, mirroring
 * prime-agent's parseStreamingJson: full parse first (with repair), then a
 * best-effort incremental parse, then an empty object.
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
  if (!partialJson || partialJson.trim() === "") {
    return {} as T;
  }
  try {
    return parseJsonWithRepair<T>(partialJson);
  } catch {
    const raw = parsePartialJson<unknown>(partialJson) ?? parsePartialJson<unknown>(repairJson(partialJson));
    if (raw !== undefined && raw !== null) return raw as T;
    return {} as T;
  }
}

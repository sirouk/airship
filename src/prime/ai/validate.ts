/**
 * Dependency-free JSON-Schema-subset validator used for tool-argument checks.
 * prime-agent uses typebox's runtime compiler for this; the browser port keeps
 * semantics (structural validation with useful first-error messages) without
 * a schema dependency. Draft features beyond this subset pass through to the
 * provider untouched, so schemas remain forward-compatible.
 */

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateJson(schema: Record<string, unknown>, value: unknown, path = "$"): ValidationResult {
  const errors: string[] = [];
  inner(schema, value, path, errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function checkType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && !Number.isNaN(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    default: return true;
  }
}

function inner(schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  if (schema.anyOf) {
    const ok = (schema.anyOf as Record<string, unknown>[]).some((sub) => validateJson(sub, value, path).ok);
    if (!ok) errors.push(`${path}: does not match anyOf`);
    return;
  }
  if (schema.oneOf) {
    const matches = (schema.oneOf as Record<string, unknown>[]).filter((sub) => validateJson(sub, value, path).ok).length;
    if (matches !== 1) errors.push(`${path}: expected exactly one oneOf match, got ${matches}`);
    return;
  }
  if (schema.enum) {
    if (!(schema.enum as unknown[]).some((v) => deepEqual(v, value))) {
      errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
    }
    return;
  }
  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, value)) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    return;
  }

  const type = schema.type as string | string[] | undefined;
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => checkType(t, value))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${typeof value}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern as string).test(value)) {
          errors.push(`${path}: does not match pattern ${schema.pattern}`);
        }
      } catch {
        // an invalid regex is a schema bug, not a value error
      }
    }
  }

  if (typeof value === "number" && !Number.isNaN(value)) {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > (schema.maximum as number)) errors.push(`${path}: above maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= (schema.exclusiveMinimum as number)) {
      errors.push(`${path}: not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= (schema.exclusiveMaximum as number)) {
      errors.push(`${path}: not below exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
    if (schema.multipleOf !== undefined && value % (schema.multipleOf as number) !== 0) {
      errors.push(`${path}: not a multiple of ${schema.multipleOf}`);
    }
    if (schema["type"] === "integer" && !Number.isInteger(value)) { /* caught in checkType */ }
  }

  if (Array.isArray(value)) {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((v, idx) => inner(items, v, `${path}[${idx}]`, errors));
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) errors.push(`${path}: more than maxItems ${schema.maxItems}`);
  }

  if (isPlainObject(value)) {
    const obj = value;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in obj)) errors.push(`${path}.${key}: missing required property`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) inner(sub, obj[key], `${path}.${key}`, errors);
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    } else if (additional && typeof additional === "object") {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) inner(additional as Record<string, unknown>, obj[key], `${path}.${key}`, errors);
      }
    }
  }
}

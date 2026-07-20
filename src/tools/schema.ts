import type { JsonValue } from "../core/contracts";
import { stableStringify } from "../core/hash";

const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 2_048;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_PATTERN_CHARS = 512;
const MAX_VALUE_DEPTH = 64;
const MAX_VALIDATION_VISITS = 100_000;

const ANNOTATION_KEYWORDS = new Set([
  "$comment",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);
const VALIDATION_KEYWORDS = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
  "uniqueItems",
]);
const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

export type ToolArgumentValidationIssue = Readonly<{
  path: string;
  keyword: string;
  message: string;
}>;

export class ToolArgumentValidationError extends Error {
  readonly name = "ToolArgumentValidationError";

  constructor(readonly issue: ToolArgumentValidationIssue) {
    super(`Tool arguments ${issue.path || "/"} ${issue.message}`);
  }
}

type CompiledSchema =
  | Readonly<{ boolean: boolean }>
  | Readonly<{
      types?: ReadonlySet<string>;
      properties: ReadonlyMap<string, CompiledSchema>;
      required: ReadonlySet<string>;
      additionalProperties: true | false | CompiledSchema;
      items?: CompiledSchema;
      enumValues?: readonly JsonValue[];
      hasConst: boolean;
      constValue?: JsonValue;
      allOf: readonly CompiledSchema[];
      anyOf: readonly CompiledSchema[];
      oneOf: readonly CompiledSchema[];
      not?: CompiledSchema;
      minLength?: number;
      maxLength?: number;
      pattern?: RegExp;
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      exclusiveMaximum?: number;
      minItems?: number;
      maxItems?: number;
      uniqueItems: boolean;
      minProperties?: number;
      maxProperties?: number;
    }>;

/**
 * Compiles Airship's intentionally small, fail-closed JSON Schema dialect.
 * Unsupported validation keywords reject tool registration so the UI can
 * never imply validation that the runtime does not perform.
 */
export function compileToolInputSchema(schema: JsonValue): (value: JsonValue) => void {
  const state = { nodes: 0 };
  const compiled = compileSchema(schema, state, 0, "#");
  return (value) => {
    const domainIssue = validateJsonDomain(value, "", 0, { visits: 0 });
    if (domainIssue) throw new ToolArgumentValidationError(domainIssue);
    const issue = validateSchema(compiled, value, "", 0, { visits: 0 });
    if (issue) throw new ToolArgumentValidationError(issue);
  };
}

function compileSchema(
  schema: JsonValue,
  state: { nodes: number },
  depth: number,
  path: string,
): CompiledSchema {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) throw new Error(`Tool schema exceeds ${MAX_SCHEMA_NODES} nodes.`);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`Tool schema exceeds ${MAX_SCHEMA_DEPTH} levels at ${path}.`);
  if (typeof schema === "boolean") return Object.freeze({ boolean: schema });
  if (!isObject(schema)) throw new Error(`Tool schema at ${path} must be an object or boolean.`);

  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(keyword) && !VALIDATION_KEYWORDS.has(keyword)) {
      throw new Error(`Unsupported tool schema keyword ${keyword} at ${path}.`);
    }
  }

  const types = compileTypes(schema.type, path);
  const propertiesValue = schema.properties;
  if (propertiesValue !== undefined && !isObject(propertiesValue)) {
    throw new Error(`properties at ${path} must be an object.`);
  }
  const propertyEntries = Object.entries(propertiesValue ?? {});
  if (propertyEntries.length > MAX_SCHEMA_PROPERTIES) {
    throw new Error(`Tool schema properties at ${path} exceed ${MAX_SCHEMA_PROPERTIES}.`);
  }
  const properties = new Map<string, CompiledSchema>();
  for (const [name, child] of propertyEntries) {
    properties.set(name, compileSchema(child, state, depth + 1, `${path}/properties/${escapePointer(name)}`));
  }

  const required = compileRequired(schema.required, path);
  const additionalProperties = compileAdditionalProperties(schema.additionalProperties, state, depth, path);
  const items = schema.items === undefined
    ? undefined
    : compileSchema(schema.items, state, depth + 1, `${path}/items`);
  const enumValues = compileEnum(schema.enum, path);
  const hasConst = Object.hasOwn(schema, "const");
  const constValue = hasConst ? schema.const : undefined;
  const allOf = compileSchemaArray(schema.allOf, "allOf", state, depth, path);
  const anyOf = compileSchemaArray(schema.anyOf, "anyOf", state, depth, path);
  const oneOf = compileSchemaArray(schema.oneOf, "oneOf", state, depth, path);
  const not = schema.not === undefined ? undefined : compileSchema(schema.not, state, depth + 1, `${path}/not`);
  const minLength = optionalNonNegativeInteger(schema, "minLength", path);
  const maxLength = optionalNonNegativeInteger(schema, "maxLength", path);
  const pattern = compilePattern(schema.pattern, maxLength.maxLength, path);

  const compiled: Exclude<CompiledSchema, { boolean: boolean }> = {
    ...(types ? { types } : {}),
    properties,
    required,
    additionalProperties,
    ...(items ? { items } : {}),
    ...(enumValues ? { enumValues } : {}),
    hasConst,
    ...(hasConst ? { constValue } : {}),
    allOf,
    anyOf,
    oneOf,
    ...(not ? { not } : {}),
    ...minLength,
    ...maxLength,
    ...(pattern ? { pattern } : {}),
    ...optionalFiniteNumber(schema, "minimum", path),
    ...optionalFiniteNumber(schema, "maximum", path),
    ...optionalFiniteNumber(schema, "exclusiveMinimum", path),
    ...optionalFiniteNumber(schema, "exclusiveMaximum", path),
    ...optionalNonNegativeInteger(schema, "minItems", path),
    ...optionalNonNegativeInteger(schema, "maxItems", path),
    uniqueItems: optionalBoolean(schema, "uniqueItems", path) ?? false,
    ...optionalNonNegativeInteger(schema, "minProperties", path),
    ...optionalNonNegativeInteger(schema, "maxProperties", path),
  };
  assertOrderedBounds(compiled, "minLength", "maxLength", path);
  assertOrderedBounds(compiled, "minItems", "maxItems", path);
  assertOrderedBounds(compiled, "minProperties", "maxProperties", path);
  return Object.freeze(compiled);
}

function validateSchema(
  schema: CompiledSchema,
  value: JsonValue,
  path: string,
  depth: number,
  budget: { visits: number },
): ToolArgumentValidationIssue | undefined {
  budget.visits += 1;
  if (budget.visits > MAX_VALIDATION_VISITS) return issue(path, "bounds", "exceed the validation work limit.");
  if (depth > MAX_VALUE_DEPTH) return issue(path, "bounds", `exceed ${MAX_VALUE_DEPTH} nested levels.`);
  if ("boolean" in schema) return schema.boolean ? undefined : issue(path, "falseSchema", "are rejected by the tool schema.");

  if (schema.types && ![...schema.types].some((type) => matchesType(value, type))) {
    return issue(path, "type", `must be ${[...schema.types].join(" or ")}.`);
  }
  if (schema.enumValues && !schema.enumValues.some((candidate) => jsonEqual(candidate, value))) {
    return issue(path, "enum", "must match one of the declared values.");
  }
  if (schema.hasConst && !jsonEqual(schema.constValue as JsonValue, value)) {
    return issue(path, "const", "must match the declared constant.");
  }

  for (const child of schema.allOf) {
    const childIssue = validateSchema(child, value, path, depth + 1, budget);
    if (childIssue?.keyword === "bounds") return childIssue;
    if (childIssue) return issue(path, "allOf", `do not satisfy all required schemas (${childIssue.message})`);
  }
  if (schema.anyOf.length > 0) {
    let matched = false;
    for (const child of schema.anyOf) {
      const childIssue = validateSchema(child, value, path, depth + 1, budget);
      if (childIssue?.keyword === "bounds") return childIssue;
      if (!childIssue) matched = true;
    }
    if (!matched) return issue(path, "anyOf", "do not satisfy any allowed schema.");
  }
  if (schema.oneOf.length > 0) {
    let matches = 0;
    for (const child of schema.oneOf) {
      const childIssue = validateSchema(child, value, path, depth + 1, budget);
      if (childIssue?.keyword === "bounds") return childIssue;
      if (!childIssue) matches += 1;
    }
    if (matches !== 1) return issue(path, "oneOf", "must satisfy exactly one allowed schema.");
  }
  if (schema.not) {
    const childIssue = validateSchema(schema.not, value, path, depth + 1, budget);
    if (childIssue?.keyword === "bounds") return childIssue;
    if (!childIssue) return issue(path, "not", "match a prohibited schema.");
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return issue(path, "minLength", `must contain at least ${schema.minLength} characters.`);
    if (schema.maxLength !== undefined && length > schema.maxLength) return issue(path, "maxLength", `must contain at most ${schema.maxLength} characters.`);
    if (schema.pattern && !schema.pattern.test(value)) return issue(path, "pattern", "must match the declared pattern.");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return issue(path, "minimum", `must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) return issue(path, "maximum", `must be at most ${schema.maximum}.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return issue(path, "exclusiveMinimum", `must be greater than ${schema.exclusiveMinimum}.`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return issue(path, "exclusiveMaximum", `must be less than ${schema.exclusiveMaximum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return issue(path, "minItems", `must contain at least ${schema.minItems} items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return issue(path, "maxItems", `must contain at most ${schema.maxItems} items.`);
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const canonical = stableStringify(item);
        if (seen.has(canonical)) return issue(path, "uniqueItems", "must not contain duplicate items.");
        seen.add(canonical);
      }
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const childIssue = validateSchema(schema.items, value[index]!, `${path}/${index}`, depth + 1, budget);
        if (childIssue) return childIssue;
      }
    }
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (schema.minProperties !== undefined && entries.length < schema.minProperties) return issue(path, "minProperties", `must contain at least ${schema.minProperties} properties.`);
    if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) return issue(path, "maxProperties", `must contain at most ${schema.maxProperties} properties.`);
    for (const name of schema.required) {
      if (!Object.hasOwn(value, name)) return issue(`${path}/${escapePointer(name)}`, "required", "are required.");
    }
    for (const [name, childValue] of entries) {
      const childPath = `${path}/${escapePointer(name)}`;
      const propertySchema = schema.properties.get(name);
      if (propertySchema) {
        const childIssue = validateSchema(propertySchema, childValue, childPath, depth + 1, budget);
        if (childIssue) return childIssue;
      } else if (schema.additionalProperties === false) {
        return issue(childPath, "additionalProperties", "are not declared by the tool schema.");
      } else if (schema.additionalProperties !== true) {
        const childIssue = validateSchema(schema.additionalProperties, childValue, childPath, depth + 1, budget);
        if (childIssue) return childIssue;
      }
    }
  }
  return undefined;
}

function validateJsonDomain(
  value: unknown,
  path: string,
  depth: number,
  budget: { visits: number },
): ToolArgumentValidationIssue | undefined {
  budget.visits += 1;
  if (budget.visits > MAX_VALIDATION_VISITS) return issue(path, "bounds", "exceed the JSON value work limit.");
  if (depth > MAX_VALUE_DEPTH) return issue(path, "bounds", `exceed ${MAX_VALUE_DEPTH} nested levels.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : issue(path, "json", "must contain only finite JSON numbers.");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = validateJsonDomain(value[index], `${path}/${index}`, depth + 1, budget);
      if (child) return child;
    }
    return undefined;
  }
  if (isObject(value)) {
    for (const [name, childValue] of Object.entries(value)) {
      const child = validateJsonDomain(childValue, `${path}/${escapePointer(name)}`, depth + 1, budget);
      if (child) return child;
    }
    return undefined;
  }
  return issue(path, "json", "must be a JSON value.");
}

function compileTypes(value: JsonValue | undefined, path: string): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (candidates.length === 0 || candidates.some((candidate) => typeof candidate !== "string" || !JSON_TYPES.has(candidate))) {
    throw new Error(`type at ${path} must name one or more supported JSON types.`);
  }
  if (new Set(candidates).size !== candidates.length) throw new Error(`type at ${path} contains duplicates.`);
  return new Set(candidates as string[]);
}

function compileRequired(value: JsonValue | undefined, path: string): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`required at ${path} must be an array of property names.`);
  }
  const names = value as string[];
  if (new Set(names).size !== names.length) throw new Error(`required at ${path} contains duplicates.`);
  return new Set(names);
}

function compileAdditionalProperties(
  value: JsonValue | undefined,
  state: { nodes: number },
  depth: number,
  path: string,
): true | false | CompiledSchema {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  return compileSchema(value, state, depth + 1, `${path}/additionalProperties`);
}

function compileSchemaArray(
  value: JsonValue | undefined,
  keyword: string,
  state: { nodes: number },
  depth: number,
  path: string,
): readonly CompiledSchema[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${keyword} at ${path} must be a non-empty array.`);
  return Object.freeze(value.map((child, index) => compileSchema(child, state, depth + 1, `${path}/${keyword}/${index}`)));
}

function compileEnum(value: JsonValue | undefined, path: string): readonly JsonValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`enum at ${path} must be a non-empty array.`);
  const canonical = value.map(stableStringify);
  if (new Set(canonical).size !== canonical.length) throw new Error(`enum at ${path} contains duplicate values.`);
  return Object.freeze([...value]);
}

function compilePattern(value: JsonValue | undefined, maxLength: number | undefined, path: string): RegExp | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern at ${path} must be a string of at most ${MAX_PATTERN_CHARS} characters.`);
  }
  if (maxLength === undefined || maxLength > 4_096) {
    throw new Error(`pattern at ${path} requires maxLength no greater than 4096.`);
  }
  if (!isLinearPatternSubset(value)) {
    throw new Error(`pattern at ${path} uses constructs outside Airship's linear-time subset.`);
  }
  try {
    return new RegExp(value, "u");
  } catch {
    throw new Error(`pattern at ${path} is not a valid Unicode regular expression.`);
  }
}

/** Reject grouping, alternation, backreferences, lookarounds, and counted
 * repetition. With a bounded input and quantifiers applying only to one
 * literal/class atom, this subset cannot create nested catastrophic matches. */
function isLinearPatternSubset(pattern: string): boolean {
  let inClass = false;
  let escaped = false;
  let priorQuantifier = false;
  let quantifiers = 0;
  for (const character of pattern) {
    if (escaped) {
      if (!inClass && /[1-9]/u.test(character)) return false;
      escaped = false;
      priorQuantifier = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      if (inClass) return false;
      inClass = true;
      priorQuantifier = false;
      continue;
    }
    if (character === "]") {
      if (!inClass) return false;
      inClass = false;
      priorQuantifier = false;
      continue;
    }
    if (inClass) continue;
    if (character === "(" || character === ")" || character === "|" || character === "{" || character === "}") {
      return false;
    }
    const quantifier = character === "*" || character === "+" || character === "?";
    if (quantifier && priorQuantifier) return false;
    if (quantifier) {
      quantifiers += 1;
      if (quantifiers > 1) return false;
    }
    priorQuantifier = quantifier;
  }
  return !escaped && !inClass;
}

function optionalNonNegativeInteger<K extends string>(
  schema: Record<string, JsonValue>,
  key: K,
  path: string,
): Partial<Record<K, number>> {
  const value = schema[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} at ${path} must be a non-negative safe integer.`);
  }
  return { [key]: value } as Partial<Record<K, number>>;
}

function optionalFiniteNumber<K extends string>(
  schema: Record<string, JsonValue>,
  key: K,
  path: string,
): Partial<Record<K, number>> {
  const value = schema[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} at ${path} must be finite.`);
  return { [key]: value } as Partial<Record<K, number>>;
}

function optionalBoolean(schema: Record<string, JsonValue>, key: string, path: string): boolean | undefined {
  const value = schema[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} at ${path} must be boolean.`);
  return value;
}

function assertOrderedBounds(
  schema: Record<string, unknown>,
  minimum: string,
  maximum: string,
  path: string,
): void {
  const min = schema[minimum];
  const max = schema[maximum];
  if (typeof min === "number" && typeof max === "number" && min > max) {
    throw new Error(`${minimum} cannot exceed ${maximum} at ${path}.`);
  }
}

function matchesType(value: JsonValue, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  return typeof value === type;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function issue(path: string, keyword: string, message: string): ToolArgumentValidationIssue {
  return Object.freeze({ path, keyword, message });
}

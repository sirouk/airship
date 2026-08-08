import type { JsonValue, ToolDefinition } from "../core/contracts";
import type { ToolRegistry } from "../tools/registry";
import { normalizeSlashName, parseJsonToken, SlashSyntaxError } from "./parser";
import type {
  SlashApprovalRequirement,
  SlashArgumentDescriptor,
  SlashBuiltinAction,
  SlashCommandAvailability,
  SlashCommandCategory,
  SlashCommandDescriptor,
  SlashInvocation,
  SlashPermission,
} from "./types";

type CommandParser = (tokens: readonly string[]) => SlashInvocation;

type CommandRegistration = Readonly<{
  descriptor: SlashCommandDescriptor;
  parse: CommandParser;
}>;

export type ToolSlashExposure = Readonly<{
  /** Unauthorized tools are omitted instead of leaking their existence. */
  authorized?: boolean;
  aliases?: readonly string[];
  approval?: SlashApprovalRequirement;
  availability?: SlashCommandAvailability;
}>;

export type SlashRegistryOptions = Readonly<{
  tools: ToolRegistry;
  exposeTool?: (tool: ToolDefinition) => ToolSlashExposure;
  includeBuiltins?: boolean;
  builtinAvailability?: Partial<Record<"help" | "sessions" | "models" | "skills", SlashCommandAvailability>>;
}>;

const ENABLED = Object.freeze({ enabled: true }) as SlashCommandAvailability;
const DEFAULT_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  list_files: Object.freeze(["ls"]),
  read_file: Object.freeze(["read"]),
  write_file: Object.freeze(["write"]),
});

export class SlashCommandRegistry {
  private readonly commands = new Map<string, CommandRegistration>();
  private readonly lookup = new Map<string, string>();

  register(registration: CommandRegistration): void {
    const name = normalizeSlashName(registration.descriptor.name);
    if (this.commands.has(name)) throw new Error(`Slash command already registered: /${name}`);
    const aliases = uniqueNames(registration.descriptor.aliases, name);
    for (const candidate of [name, ...aliases]) {
      const owner = this.lookup.get(candidate);
      if (owner) throw new Error(`Slash name /${candidate} is already owned by /${owner}.`);
    }

    const descriptor = freezeDescriptor({ ...registration.descriptor, name, aliases });
    this.commands.set(name, Object.freeze({ descriptor, parse: registration.parse }));
    for (const candidate of [name, ...aliases]) this.lookup.set(candidate, name);
  }

  descriptors(): readonly SlashCommandDescriptor[] {
    return Object.freeze([...this.commands.values()]
      .map((registration) => registration.descriptor)
      .sort((left, right) => left.name.localeCompare(right.name)));
  }

  resolve(nameOrAlias: string): SlashCommandDescriptor | undefined {
    const normalized = safeNormalizeName(nameOrAlias);
    if (!normalized) return undefined;
    const canonical = this.lookup.get(normalized);
    return canonical ? this.commands.get(canonical)?.descriptor : undefined;
  }

  parse(nameOrAlias: string, tokens: readonly string[]): SlashInvocation {
    const normalized = safeNormalizeName(nameOrAlias);
    const canonical = normalized ? this.lookup.get(normalized) : undefined;
    const registration = canonical ? this.commands.get(canonical) : undefined;
    if (!registration) throw new SlashSyntaxError("unknown-command", `Unknown slash command: /${nameOrAlias}.`);
    return registration.parse(tokens);
  }
}

export function createSlashCommandRegistry(options: SlashRegistryOptions): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  if (options.includeBuiltins !== false) registerBuiltins(registry, options.builtinAvailability ?? {});

  for (const definition of options.tools.definitions()) {
    const exposure = options.exposeTool?.(definition) ?? {};
    if (exposure.authorized === false) continue;
    const baseName = normalizeSlashName(definition.name.replaceAll("_", "-"));
    const name = registry.resolve(baseName) ? `tool-${baseName}` : baseName;
    const automaticAliases = DEFAULT_TOOL_ALIASES[definition.name] ?? [];
    const rawAlias = definition.name !== baseName ? [definition.name] : [];
    const aliases = uniqueNames([...automaticAliases, ...rawAlias, ...(exposure.aliases ?? [])], name)
      .filter((alias) => !registry.resolve(alias));
    const schema = inspectToolSchema(definition.inputSchema);
    const permission = Object.freeze({
      effect: definition.effect,
      approval: exposure.approval ?? (definition.effect === "read" ? "automatic" : "policy-review"),
    }) satisfies SlashPermission;
    const descriptor: SlashCommandDescriptor = {
      name,
      aliases,
      summary: definition.description,
      category: "tool",
      usage: toolUsage(name, schema.arguments),
      availability: normalizeAvailability(exposure.availability),
      permission,
      arguments: schema.arguments,
      subcommands: Object.freeze([]),
      source: Object.freeze({ kind: "tool", toolName: definition.name }),
    };
    registry.register({
      descriptor,
      parse(tokens) {
        const argumentsValue = parseToolArguments(tokens, schema);
        options.tools.validateArguments(definition.name, argumentsValue);
        const immutableArguments = freezeJson(argumentsValue);
        return Object.freeze({
          kind: "tool",
          toolName: definition.name,
          arguments: immutableArguments,
        });
      },
    });
  }
  return registry;
}

function registerBuiltins(
  registry: SlashCommandRegistry,
  availability: SlashRegistryOptions["builtinAvailability"] extends infer T ? NonNullable<T> : never,
): void {
  registerBuiltin(registry, {
    name: "help",
    aliases: ["commands"],
    summary: "Show available commands or detailed help for one command.",
    category: "system",
    usage: "/help [command]",
    availability: normalizeAvailability(availability.help),
    subcommands: [],
    parse(tokens) {
      if (tokens.length > 1) invalid("Usage: /help [command].");
      const command = tokens[0] ? normalizeSlashName(tokens[0].replace(/^\//u, "")) : undefined;
      return builtin({ type: "help", ...(command ? { command } : {}) });
    },
  });
  registerBuiltin(registry, {
    name: "sessions",
    aliases: ["session"],
    summary: "List, create, activate, or fork isolated agent sessions.",
    category: "session",
    usage: "/sessions [list|new|open|fork]",
    availability: normalizeAvailability(availability.sessions),
    subcommands: ["list", "new", "open", "fork"],
    parse: parseSessions,
  });
  /*
   * Skills were reachable from nothing the composer offers. The registry has
   * one channel — the tool registry — and a skill is not a tool: no schema, no
   * effect class, nothing to invoke. So the whole set silently governed every
   * reply while `/help` listed sessions, models and every workspace tool and
   * never named one of them. Listing needs no new channel, and a person cannot
   * reason about a set they cannot see.
   */
  registerBuiltin(registry, {
    name: "skills",
    aliases: ["skill"],
    summary: "List the skills pinned into this conversation, with each one's source and digest.",
    category: "system",
    usage: "/skills [list]",
    availability: normalizeAvailability(availability.skills),
    subcommands: ["list"],
    parse: parseSkills,
  });
  registerBuiltin(registry, {
    name: "models",
    aliases: ["model"],
    // Not "a new pinned session": a thread pinned to the connection it is
    // already on now changes model in place, and only a thread pinned
    // elsewhere still forks. This sentence is read verbatim in `/help` and in
    // the composer's argument menu, so it must not promise either route.
    summary: "List available inference models, or switch the model in use.",
    category: "model",
    usage: "/models [list|use]",
    availability: normalizeAvailability(availability.models),
    subcommands: ["list", "use"],
    parse: parseModels,
  });
}

function registerBuiltin(registry: SlashCommandRegistry, args: Readonly<{
  name: string;
  aliases: readonly string[];
  summary: string;
  category: SlashCommandCategory;
  usage: string;
  availability: SlashCommandAvailability;
  subcommands: readonly string[];
  parse: CommandParser;
}>): void {
  registry.register({
    descriptor: {
      name: args.name,
      aliases: args.aliases,
      summary: args.summary,
      category: args.category,
      usage: args.usage,
      availability: args.availability,
      arguments: Object.freeze([]),
      subcommands: Object.freeze([...args.subcommands]),
      source: Object.freeze({ kind: "builtin" }),
    },
    parse: args.parse,
  });
}

/** `list` is accepted so the one subcommand the completion offers parses. */
function parseSkills(tokens: readonly string[]): SlashInvocation {
  const [subcommand = "list", ...rest] = tokens;
  if (subcommand !== "list" || rest.length) invalid("Usage: /skills list.");
  return builtin({ type: "skills.list" });
}

function parseSessions(tokens: readonly string[]): SlashInvocation {
  const [subcommand = "list", ...rest] = tokens;
  if (subcommand === "list") {
    if (rest.length) invalid("Usage: /sessions list.");
    return builtin({ type: "sessions.list" });
  }
  if (subcommand === "new" || subcommand === "create") {
    if (rest.length > 1) invalid("Quote a multi-word session title: /sessions new \"Title\".");
    const title = rest[0] ? boundedValue(rest[0], 160, "Session title") : undefined;
    return builtin({ type: "sessions.create", ...(title ? { title } : {}) });
  }
  if (subcommand === "open" || subcommand === "switch" || subcommand === "activate") {
    if (rest.length !== 1) invalid("Usage: /sessions open <session-id>.");
    return builtin({ type: "sessions.activate", sessionId: boundedValue(rest[0]!, 256, "Session ID") });
  }
  if (subcommand === "fork") {
    if (rest.length > 1) invalid("Usage: /sessions fork [session-id].");
    const sessionId = rest[0] ? boundedValue(rest[0], 256, "Session ID") : undefined;
    return builtin({ type: "sessions.fork", ...(sessionId ? { sessionId } : {}) });
  }
  invalid(`Unknown sessions action: ${subcommand}.`);
}

function parseModels(tokens: readonly string[]): SlashInvocation {
  const [subcommand = "list", ...rest] = tokens;
  if (subcommand === "list") {
    if (rest.length > 1) invalid("Quote a multi-word model query: /models list \"query\".");
    const query = rest[0] ? boundedValue(rest[0], 512, "Model query") : undefined;
    return builtin({ type: "models.list", ...(query ? { query } : {}) });
  }
  if (subcommand === "use" || subcommand === "select") {
    if (rest.length !== 1) invalid("Usage: /models use <exact-model-id>.");
    return builtin({ type: "models.select", modelId: boundedValue(rest[0]!, 512, "Model ID") });
  }
  invalid(`Unknown models action: ${subcommand}.`);
}

function builtin(action: SlashBuiltinAction): SlashInvocation {
  return Object.freeze({ kind: "builtin", action: Object.freeze(action) });
}

type ToolProperty = Readonly<{
  name: string;
  optionNames: readonly string[];
  descriptor: SlashArgumentDescriptor;
  types: readonly string[];
  enumValues?: readonly JsonValue[];
}>;

type ToolSchema = Readonly<{
  objectInput: boolean;
  properties: readonly ToolProperty[];
  arguments: readonly SlashArgumentDescriptor[];
}>;

function inspectToolSchema(schemaValue: JsonValue): ToolSchema {
  const schema = record(schemaValue);
  const propertiesRecord = record(schema?.properties);
  const required = new Set(Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []);
  const properties: ToolProperty[] = [];
  for (const [name, rawProperty] of Object.entries(propertiesRecord ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name)) continue;
    const property = record(rawProperty);
    const types = schemaTypes(property?.type);
    const kebab = name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").replaceAll("_", "-").toLowerCase();
    const optionNames = Object.freeze([...new Set([`--${kebab}`, `--${name}`])]);
    const descriptor = Object.freeze({
      name,
      option: optionNames[0]!,
      ...(typeof property?.description === "string" ? { description: property.description.slice(0, 512) } : {}),
      required: required.has(name),
      positional: true,
      valueHint: types.join("|") || "json",
    }) satisfies SlashArgumentDescriptor;
    const enumValues = Array.isArray(property?.enum)
      ? property.enum.filter((item): item is JsonValue => isJsonCandidate(item))
      : undefined;
    properties.push(Object.freeze({
      name,
      optionNames,
      descriptor,
      types,
      ...(enumValues ? { enumValues: Object.freeze(enumValues) } : {}),
    }));
  }
  return Object.freeze({
    objectInput: schema?.type === "object" || Boolean(propertiesRecord),
    properties: Object.freeze(properties),
    arguments: Object.freeze(properties.map((property) => property.descriptor)),
  });
}

/**
 * The one sentence for the one rule.
 *
 * `--json` is accepted as the first and only tool argument, and the usage line
 * used to advertise it trailing the positionals — so the reader who followed
 * the documentation got "Unknown option: --json." from one branch here and a
 * bare "must be the only tool argument" from another. One rule, one wording,
 * naming both forms that do parse.
 */
const JSON_FORM_RULE = "--json must be the only tool argument. Use /command --json '<json>' on its own, or the positional form without it.";

function parseToolArguments(tokens: readonly string[], schema: ToolSchema): JsonValue {
  if (tokens[0] === "--json" || tokens[0]?.startsWith("--json=")) {
    if (tokens.length !== (tokens[0] === "--json" ? 2 : 1)) {
      invalid(JSON_FORM_RULE);
    }
    const raw = tokens[0] === "--json" ? tokens[1]! : tokens[0]!.slice("--json=".length);
    return parseJsonToken(raw, "--json");
  }
  if (!schema.objectInput) {
    if (tokens.length === 0) return Object.freeze({});
    invalid("This tool requires the universal /command --json '<value>' syntax.");
  }

  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const supplied = new Set<string>();
  const byOption = new Map<string, ToolProperty>();
  for (const property of schema.properties) {
    for (const option of property.optionNames) byOption.set(option, property);
    if (property.types.includes("boolean")) {
      for (const option of property.optionNames) byOption.set(`--no-${option.slice(2)}`, property);
    }
  }

  let positionalIndex = 0;
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("--")) {
      const equals = token.indexOf("=");
      const option = equals >= 0 ? token.slice(0, equals) : token;
      const property = byOption.get(option);
      // `--json` is a real option in the wrong place, not an unknown one. A
      // person who followed the usage line's old ordering was told the flag did
      // not exist, which sends them looking for a different command.
      if (!property && option === "--json") invalid(JSON_FORM_RULE);
      if (!property) invalid(`Unknown option: ${option}.`);
      if (supplied.has(property.name)) invalid(`Argument ${property.name} was supplied more than once.`);
      const negated = option.startsWith("--no-");
      let raw: string;
      if (equals >= 0) {
        if (negated) invalid(`Negated boolean option ${option} does not accept a value.`);
        raw = token.slice(equals + 1);
      } else if (property.types.includes("boolean")) {
        const possible = tokens[index + 1];
        if (!negated && (possible === "true" || possible === "false")) {
          raw = possible;
          index += 1;
        } else {
          raw = negated ? "false" : "true";
        }
      } else {
        const next = tokens[index + 1];
        if (next === undefined) invalid(`Option ${option} requires a value.`);
        raw = next;
        index += 1;
      }
      result[property.name] = parsePropertyValue(raw, property);
      supplied.add(property.name);
      continue;
    }

    while (schema.properties[positionalIndex] && supplied.has(schema.properties[positionalIndex]!.name)) {
      positionalIndex += 1;
    }
    const property = schema.properties[positionalIndex];
    if (!property) invalid("Too many positional arguments. Quote values containing spaces or use named options.");
    result[property.name] = parsePropertyValue(token, property);
    supplied.add(property.name);
    positionalIndex += 1;
  }

  for (const property of schema.properties) {
    if (property.descriptor.required && !supplied.has(property.name)) {
      invalid(`Missing required argument: ${property.name}.`);
    }
  }
  return result;
}

function parsePropertyValue(raw: string, property: ToolProperty): JsonValue {
  const types = property.types;
  let value: JsonValue;
  if (raw === "null" && types.includes("null")) value = null;
  else if (types.includes("string") || types.length === 0) value = raw;
  else if (types.includes("boolean") && (raw === "true" || raw === "false")) value = raw === "true";
  else if (types.includes("integer") && /^-?(?:0|[1-9]\d*)$/u.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) invalid(`${property.name} must be a safe integer.`);
    value = parsed;
  } else if (types.includes("number") && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) invalid(`${property.name} must be a finite number.`);
    value = parsed;
  } else if (types.includes("array") || types.includes("object")) {
    value = parseJsonToken(raw, property.name);
    if (types.includes("array") && !types.includes("object") && !Array.isArray(value)) {
      invalid(`${property.name} must be a JSON array.`);
    }
    if (types.includes("object") && !types.includes("array") && (!value || typeof value !== "object" || Array.isArray(value))) {
      invalid(`${property.name} must be a JSON object.`);
    }
  } else {
    invalid(`${property.name} must be ${types.join(" or ") || "valid JSON"}.`);
  }
  if (property.enumValues && !property.enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    invalid(`${property.name} must be one of the values declared by the tool schema.`);
  }
  return value;
}

/**
 * Two forms, because the parser has two forms.
 *
 * Measured defect: `/help` printed
 * `/update-memory <action> [id] [content] [source] [--json <json>]`, and typing
 * exactly that — positionals first, then the flag — answered "Unknown option:
 * --json." `parseToolArguments` accepts `--json` only as the first *and only*
 * token, so the trailing `[--json <json>]` documented a syntax the product
 * rejects. A usage line is a promise about the parser; this one states the
 * alternation the parser actually implements.
 */
function toolUsage(name: string, args: readonly SlashArgumentDescriptor[]): string {
  const positional = args.map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`);
  return [`/${name}`, ...positional].join(" ") + ` | /${name} --json <json>`;
}

function normalizeAvailability(value: SlashCommandAvailability | undefined): SlashCommandAvailability {
  if (!value || value.enabled) return ENABLED;
  const reason = value.reason.trim().slice(0, 512);
  if (!reason) throw new Error("A disabled slash command requires a reason.");
  return Object.freeze({ enabled: false, reason });
}

function freezeDescriptor(descriptor: SlashCommandDescriptor): SlashCommandDescriptor {
  return Object.freeze({
    ...descriptor,
    aliases: Object.freeze([...descriptor.aliases]),
    arguments: Object.freeze([...descriptor.arguments]),
    subcommands: Object.freeze([...descriptor.subcommands]),
    availability: Object.freeze({ ...descriptor.availability }),
    ...(descriptor.permission ? { permission: Object.freeze({ ...descriptor.permission }) } : {}),
    source: Object.freeze({ ...descriptor.source }),
  });
}

function uniqueNames(values: readonly string[], owner: string): string[] {
  return [...new Set(values.map(normalizeSlashName).filter((value) => value !== owner))];
}

function safeNormalizeName(value: string): string | undefined {
  try {
    return normalizeSlashName(value);
  } catch {
    return undefined;
  }
}

function schemaTypes(value: JsonValue | undefined): readonly string[] {
  if (typeof value === "string") return Object.freeze([value]);
  if (Array.isArray(value)) return Object.freeze(value.filter((item): item is string => typeof item === "string"));
  return Object.freeze([]);
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function isJsonCandidate(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonCandidate);
  return Boolean(value) && typeof value === "object" && Object.values(value).every(isJsonCandidate);
}

function invalid(message: string): never {
  throw new SlashSyntaxError("invalid-arguments", message);
}

function boundedValue(value: string, maximum: number, label: string): string {
  if (!value || value.length > maximum) invalid(`${label} must contain 1 to ${maximum} characters.`);
  return value;
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else {
    for (const item of Object.values(value)) freezeJson(item);
  }
  return Object.freeze(value);
}

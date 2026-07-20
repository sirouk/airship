import { describe, expect, it } from "vitest";
import type { JsonValue, Tool, ToolDefinition } from "../core/contracts";
import { ToolRegistry } from "../tools/registry";
import {
  MAX_SLASH_INPUT_CHARS,
  completeSlashCommand,
  createSlashCommandRegistry,
  planSlashCommand,
  tokenizeSlashInput,
} from ".";

describe("browser-native slash commands", () => {
  it("discovers every authorized tool with aliases and honest approval metadata", () => {
    const tools = toolRegistry([
      definition("list_files", "read", {
        type: "object",
        properties: { path: { type: "string", description: "Workspace path" } },
        additionalProperties: false,
      }),
      definition("write_file", "write", {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedRevision: { type: ["string", "null"] },
        },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      definition("private_identity", "identity", { type: "object" }),
      definition("network_probe", "network", { type: "object" }),
    ]);
    const registry = createSlashCommandRegistry({
      tools,
      exposeTool(tool) {
        if (tool.name === "private_identity") return { authorized: false };
        if (tool.name === "network_probe") {
          return {
            availability: { enabled: false, reason: "Connect an account first." },
            aliases: ["probe"],
          };
        }
        return {};
      },
    });

    expect(registry.resolve("ls")).toMatchObject({
      name: "list-files",
      source: { kind: "tool", toolName: "list_files" },
      permission: { effect: "read", approval: "automatic" },
    });
    expect(registry.resolve("write_file")).toMatchObject({
      name: "write-file",
      permission: { effect: "write", approval: "policy-review" },
    });
    expect(registry.resolve("private-identity")).toBeUndefined();
    expect(registry.resolve("probe")?.availability).toEqual({
      enabled: false,
      reason: "Connect an account first.",
    });
    expect(registry.descriptors().map((command) => command.name)).toEqual([
      "help",
      "list-files",
      "models",
      "network-probe",
      "sessions",
      "write-file",
    ]);
  });

  it("tokenizes quotes and escapes but never interprets shell syntax", () => {
    expect(tokenizeSlashInput("normal chat")).toEqual({ kind: "chat", content: "normal chat" });
    expect(tokenizeSlashInput(String.raw`/read "docs/a b.md" literal\ value '$HOME'`)).toEqual({
      kind: "command",
      tokens: ["read", "docs/a b.md", "literal value", "$HOME"],
    });

    const registry = workspaceRegistry();
    const embedded = planSlashCommand('/read "notes; /write stolen.txt payload"', registry);
    expect(embedded.kind).toBe("tool");
    if (embedded.kind === "tool") {
      expect({ ...(embedded.arguments as Record<string, JsonValue>) }).toEqual({
        path: "notes; /write stolen.txt payload",
      });
    }
    const substitution = planSlashCommand('/read "$(touch never-runs)"', registry);
    expect(substitution.kind).toBe("tool");
    if (substitution.kind === "tool") {
      expect({ ...(substitution.arguments as Record<string, JsonValue>) }).toEqual({
        path: "$(touch never-runs)",
      });
    }
    expect(planSlashCommand("/read README.md; /write owned.txt payload", registry)).toMatchObject({
      kind: "invalid",
      code: "invalid-arguments",
    });
  });

  it("builds typed tool plans from positional, quoted, and named arguments", () => {
    const registry = workspaceRegistry();
    const positional = planSlashCommand('/write "notes/launch plan.md" "ships at dawn" null', registry);
    expect(positional.kind).toBe("tool");
    if (positional.kind === "tool") {
      expect(positional.toolName).toBe("write_file");
      expect(positional.permission).toEqual({ effect: "write", approval: "policy-review" });
      expect({ ...(positional.arguments as Record<string, JsonValue>) }).toEqual({
        path: "notes/launch plan.md",
        content: "ships at dawn",
        expectedRevision: null,
      });
    }

    const named = planSlashCommand(
      '/write --content="hello world" --path notes/hello.md --expected-revision=rev-2',
      registry,
    );
    expect(named.kind).toBe("tool");
    if (named.kind === "tool") {
      expect({ ...(named.arguments as Record<string, JsonValue>) }).toEqual({
        content: "hello world",
        path: "notes/hello.md",
        expectedRevision: "rev-2",
      });
      expect(Object.isFrozen(named.arguments)).toBe(true);
    }

    expect(planSlashCommand("/write only-a-path", registry)).toMatchObject({
      kind: "invalid",
      code: "invalid-arguments",
      message: "Missing required argument: content.",
    });
    expect(planSlashCommand("/write a b --path duplicate", registry)).toMatchObject({
      kind: "invalid",
      message: "Argument path was supplied more than once.",
    });
  });

  it("supports a bounded universal JSON form without evaluating it", () => {
    const tools = toolRegistry([
      definition("arbitrary_input", "execute", { anyOf: [{ type: "array" }, { type: "object" }] }),
    ]);
    const registry = createSlashCommandRegistry({ tools, includeBuiltins: false });
    const plan = planSlashCommand(`/arbitrary-input --json '{"argv":["sh","-c","echo never-runs"]}'`, registry);
    expect(plan.kind).toBe("tool");
    if (plan.kind === "tool") {
      expect(plan.arguments).toEqual({ argv: ["sh", "-c", "echo never-runs"] });
      expect(plan.permission).toEqual({ effect: "execute", approval: "policy-review" });
    }
    expect(planSlashCommand('/arbitrary-input --json {} trailing', registry)).toMatchObject({
      kind: "invalid",
      message: "--json must be the only tool argument.",
    });
    expect(planSlashCommand(
      `/write --json '{"path":"notes/a.md","content":"ok","undeclared":true}'`,
      workspaceRegistry(),
    )).toMatchObject({
      kind: "invalid",
      code: "invalid-arguments",
    });
  });

  it("returns declarative session, model, and help actions instead of mutating app state", () => {
    const registry = workspaceRegistry();
    expect(planSlashCommand("/sessions", registry)).toMatchObject({
      kind: "builtin",
      action: { type: "sessions.list" },
    });
    expect(planSlashCommand('/session new "Incident review"', registry)).toMatchObject({
      kind: "builtin",
      action: { type: "sessions.create", title: "Incident review" },
    });
    expect(planSlashCommand("/sessions open sess_42", registry)).toMatchObject({
      kind: "builtin",
      action: { type: "sessions.activate", sessionId: "sess_42" },
    });
    expect(planSlashCommand("/sessions fork", registry)).toMatchObject({
      kind: "builtin",
      action: { type: "sessions.fork" },
    });
    expect(planSlashCommand("/models use zai-org/GLM-5.2-TEE", registry)).toMatchObject({
      kind: "builtin",
      action: { type: "models.select", modelId: "zai-org/GLM-5.2-TEE" },
    });
    expect(planSlashCommand("/help /write", registry)).toMatchObject({
      kind: "builtin",
      action: { type: "help", command: "write" },
    });
    expect(planSlashCommand(`/sessions new "${"x".repeat(161)}"`, registry)).toMatchObject({
      kind: "invalid",
      code: "invalid-arguments",
    });
    expect(planSlashCommand(`/models use ${"m".repeat(513)}`, registry)).toMatchObject({
      kind: "invalid",
      code: "invalid-arguments",
    });
  });

  it("surfaces disabled reasons and keeps unauthorized commands out of autocomplete", () => {
    const registry = createSlashCommandRegistry({
      tools: workspaceTools(),
      exposeTool(tool) {
        if (tool.name === "read_file") return { authorized: false };
        return {};
      },
      builtinAvailability: {
        models: { enabled: false, reason: "Discover models after connecting." },
      },
    });
    expect(planSlashCommand("/models", registry)).toMatchObject({
      kind: "disabled",
      reason: "Discover models after connecting.",
    });
    expect(completeSlashCommand("/mo", registry)).toEqual([
      expect.objectContaining({
        kind: "command",
        insertText: "/models",
        disabledReason: "Discover models after connecting.",
      }),
    ]);
    expect(completeSlashCommand("/re", registry)).toEqual([]);
  });

  it("autocompletes canonical commands, subcommands, and unused schema options", () => {
    const registry = workspaceRegistry();
    expect(completeSlashCommand("/wr", registry).map((item) => item.insertText)).toEqual(["/write-file"]);
    expect(completeSlashCommand("/sessions ", registry).map((item) => item.insertText)).toEqual([
      "list",
      "new",
      "open",
      "fork",
    ]);
    expect(completeSlashCommand("/write --p", registry).map((item) => item.insertText)).toEqual(["--path"]);
    expect(completeSlashCommand("/write --path notes/a --c", registry).map((item) => item.insertText)).toEqual([
      "--content",
    ]);
  });

  it("fails closed on malformed or oversized command input", () => {
    const registry = workspaceRegistry();
    expect(planSlashCommand("/", registry)).toMatchObject({ kind: "invalid", code: "missing-command" });
    expect(planSlashCommand('/read "unfinished', registry)).toMatchObject({
      kind: "invalid",
      code: "unterminated-quote",
    });
    expect(planSlashCommand("/read bad\u0000path", registry)).toMatchObject({
      kind: "invalid",
      code: "invalid-control",
    });
    expect(planSlashCommand(`/${"x".repeat(MAX_SLASH_INPUT_CHARS)}`, registry)).toMatchObject({
      kind: "invalid",
      code: "input-too-large",
    });
    expect(planSlashCommand("/not-a-command", registry)).toMatchObject({
      kind: "invalid",
      code: "unknown-command",
    });
  });
});

function workspaceRegistry() {
  return createSlashCommandRegistry({ tools: workspaceTools() });
}

function workspaceTools(): ToolRegistry {
  return toolRegistry([
    definition("list_files", "read", {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    }),
    definition("read_file", "read", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    }),
    definition("write_file", "write", {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedRevision: { type: ["string", "null"] },
      },
      required: ["path", "content"],
      additionalProperties: false,
    }),
  ]);
}

function toolRegistry(definitions: readonly ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const toolDefinition of definitions) {
    const tool: Tool = {
      definition: toolDefinition,
      async execute() {
        throw new Error("Slash planning must never execute a tool.");
      },
    };
    registry.register(tool);
  }
  return registry;
}

function definition(
  name: string,
  effect: ToolDefinition["effect"],
  inputSchema: JsonValue,
): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    effect,
    inputSchema,
  };
}

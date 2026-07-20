import { SlashSyntaxError, tokenizeSlashInput } from "./parser";
import type { SlashCommandRegistry } from "./registry";
import type { SlashCommandPlan } from "./types";

/**
 * Converts composer text into inert structured data. It never calls a tool,
 * invokes a shell, changes a session, or bypasses the application approval
 * policy; the app must explicitly dispatch the resulting plan.
 */
export function planSlashCommand(input: string, registry: SlashCommandRegistry): SlashCommandPlan {
  let lexed;
  try {
    lexed = tokenizeSlashInput(input);
  } catch (error) {
    return syntaxFailure(error);
  }
  if (lexed.kind === "chat") return Object.freeze({ kind: "chat", content: lexed.content });
  const [rawName, ...argumentsTokens] = lexed.tokens;
  if (!rawName) {
    return Object.freeze({ kind: "invalid", code: "missing-command", message: "Type a command after /." });
  }
  const command = registry.resolve(rawName);
  if (!command) {
    return Object.freeze({
      kind: "invalid",
      code: "unknown-command",
      message: `Unknown slash command: /${rawName}. Use /help to see available commands.`,
      commandName: rawName,
    });
  }
  if (!command.availability.enabled) {
    return Object.freeze({ kind: "disabled", command, reason: command.availability.reason });
  }

  try {
    const invocation = registry.parse(rawName, argumentsTokens);
    if (invocation.kind === "builtin") {
      return Object.freeze({ kind: "builtin", command, action: invocation.action });
    }
    if (!command.permission) throw new Error(`Tool command /${command.name} has no permission metadata.`);
    return Object.freeze({
      kind: "tool",
      command,
      toolName: invocation.toolName,
      arguments: invocation.arguments,
      permission: command.permission,
    });
  } catch (error) {
    const failure = syntaxFailure(error, command.name);
    if (failure.kind !== "invalid") throw new Error("Unexpected slash planner state.");
    return failure;
  }
}

function syntaxFailure(error: unknown, commandName?: string): Extract<SlashCommandPlan, { kind: "invalid" }> {
  if (error instanceof SlashSyntaxError) {
    return Object.freeze({
      kind: "invalid",
      code: error.code,
      message: error.message,
      ...(commandName ? { commandName } : {}),
    });
  }
  return Object.freeze({
    kind: "invalid",
    code: "invalid-arguments",
    message: error instanceof Error ? error.message : "Slash command could not be planned.",
    ...(commandName ? { commandName } : {}),
  });
}


import type { JsonValue, ToolDefinition } from "../core/contracts";

export type SlashCommandCategory = "tool" | "session" | "model" | "system";

export type SlashCommandAvailability =
  | Readonly<{ enabled: true }>
  | Readonly<{ enabled: false; reason: string }>;

export type SlashApprovalRequirement = "automatic" | "policy-review";

export type SlashPermission = Readonly<{
  effect: ToolDefinition["effect"];
  approval: SlashApprovalRequirement;
}>;

export type SlashArgumentDescriptor = Readonly<{
  /** JSON property supplied to the tool. */
  name: string;
  /** Long option accepted by the parser, including the leading `--`. */
  option: string;
  description?: string;
  required: boolean;
  positional: boolean;
  valueHint: string;
}>;

export type SlashCommandDescriptor = Readonly<{
  name: string;
  aliases: readonly string[];
  summary: string;
  category: SlashCommandCategory;
  usage: string;
  availability: SlashCommandAvailability;
  permission?: SlashPermission;
  arguments: readonly SlashArgumentDescriptor[];
  subcommands: readonly string[];
  source:
    | Readonly<{ kind: "tool"; toolName: string }>
    | Readonly<{ kind: "builtin" }>;
}>;

export type SlashBuiltinAction =
  | Readonly<{ type: "help"; command?: string }>
  | Readonly<{ type: "sessions.list" }>
  | Readonly<{ type: "sessions.create"; title?: string }>
  | Readonly<{ type: "sessions.activate"; sessionId: string }>
  | Readonly<{ type: "sessions.fork"; sessionId?: string }>
  | Readonly<{ type: "models.list"; query?: string }>
  | Readonly<{ type: "models.select"; modelId: string }>;

export type SlashInvocation =
  | Readonly<{
      kind: "tool";
      toolName: string;
      arguments: JsonValue;
    }>
  | Readonly<{
      kind: "builtin";
      action: SlashBuiltinAction;
    }>;

export type SlashPlanErrorCode =
  | "input-too-large"
  | "invalid-control"
  | "missing-command"
  | "invalid-command"
  | "unknown-command"
  | "unterminated-quote"
  | "dangling-escape"
  | "too-many-tokens"
  | "token-too-large"
  | "invalid-arguments";

export type SlashCommandPlan =
  | Readonly<{ kind: "chat"; content: string }>
  | Readonly<{
      kind: "invalid";
      code: SlashPlanErrorCode;
      message: string;
      commandName?: string;
    }>
  | Readonly<{
      kind: "disabled";
      command: SlashCommandDescriptor;
      reason: string;
    }>
  | Readonly<{
      kind: "tool";
      command: SlashCommandDescriptor;
      toolName: string;
      arguments: JsonValue;
      permission: SlashPermission;
    }>
  | Readonly<{
      kind: "builtin";
      command: SlashCommandDescriptor;
      action: SlashBuiltinAction;
    }>;

export type SlashCompletion = Readonly<{
  kind: "command" | "option" | "subcommand";
  insertText: string;
  label: string;
  detail: string;
  command: SlashCommandDescriptor;
  disabledReason?: string;
}>;


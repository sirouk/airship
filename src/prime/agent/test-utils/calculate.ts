import type { AgentTool, AgentToolResult } from "../types";

/**
 * Port of prime-agent packages/agent/test/utils/calculate.ts.
 * TypeBox schema becomes a plain JSON Schema object; evaluation keeps the
 * upstream semantics (throw on failure instead of encoding an error result).
 */

export interface CalculateResult extends AgentToolResult<undefined> {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
}

export function calculate(expression: string): CalculateResult {
  try {
    const result = new Function(`return ${expression}`)();
    return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
  } catch (e: unknown) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}

export interface CalculateParams {
  expression: string;
}

export const calculateTool: AgentTool<CalculateParams, undefined> = {
  label: "Calculator",
  name: "calculate",
  description: "Evaluate mathematical expressions",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "The mathematical expression to evaluate" },
    },
    required: ["expression"],
  },
  execute: async (_toolCallId: string, args: CalculateParams) => {
    return calculate(args.expression);
  },
};

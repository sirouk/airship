import { describe, expect, it } from "vitest";
import type { ToolContext } from "../core/contracts";
import { executeExecutionTool } from "./execution-tools";
import { objectArguments, rawString, requiredString } from "./schema";

/**
 * `stringArgument` used to be declared once per tool module — seven copies, three
 * contracts. The model cannot see which module its call lands in, so the same
 * argument was accepted by one tool and refused by another purely on where the
 * copy lived.
 */

const context: ToolContext = {
  sessionId: "coercer-session",
  turnId: "coercer-turn",
  operationId: "coercer-operation",
  capabilityTier: "web-baseline",
  signal: new AbortController().signal,
};

describe("shared tool argument coercers", () => {
  it("states each contract in its name", () => {
    expect(requiredString(" node-webcontainer ", "runtime")).toBe("node-webcontainer");
    expect(() => requiredString("   ", "runtime")).toThrow(/runtime must be a non-empty string/u);
    expect(() => requiredString(undefined, "runtime")).toThrow(/runtime must be a non-empty string/u);

    // Writing an empty file and replacing trailing whitespace are real requests.
    expect(rawString("", "content")).toBe("");
    expect(rawString("  keep me  ", "oldText")).toBe("  keep me  ");
    expect(() => rawString(7, "content")).toThrow(/content must be a string/u);

    expect(objectArguments({ a: 1 })).toEqual({ a: 1 });
    expect(() => objectArguments([])).toThrow(/Tool arguments must be an object/u);
  });

  it("reads a trailing space in an enum-shaped argument as one runtime, not two", async () => {
    const failure = async (runtime: string): Promise<string> => {
      try {
        await executeExecutionTool("execute_code", { runtime, code: "return 42;", args: ["unexpected"] }, context);
        return "no failure";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    // Before the coercers were shared, execution-tools returned the argument
    // untrimmed and cast it straight to ExecutionRuntimeId, so the spaced form
    // missed every runtime branch and failed with a message that never named
    // whitespace as the cause.
    expect(await failure("javascript-worker ")).toBe(await failure("javascript-worker"));
    expect(await failure("javascript-worker ")).toMatch(/accepts only code and timeoutMs/u);
  });
});

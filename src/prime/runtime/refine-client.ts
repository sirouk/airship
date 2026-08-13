import type { InferenceTransport } from "../../core/contracts";
import type { HarnessCompletionClient, HarnessCompletionRequest, HarnessCompletionResult } from "../harness/planner";

/**
 * The bridge `/refine` waited on: the continual harness's completion client,
 * over an Airship inference transport.
 *
 * `harness/PORT.md` recorded this as host-side work and deferred it, which is
 * why harness CRUD and the prompt projections worked while refinement did not
 * — the planner needs a model to propose an update, and nothing gave it one.
 *
 * Deliberately not a turn. A refinement is a single bounded completion with no
 * tools, no approvals and no transcript: it reads a trajectory slice and
 * proposes small edits to durable harness state. Routing it through the turn
 * loop would give it a receipt, a journal identity and an approval path it has
 * no use for, and would put its output in the conversation a person is
 * reading. It goes straight at the transport instead, and the caller decides
 * what to do with the proposal.
 *
 * Failure is a value, never a throw. `HarnessCompletionResult` has an `error`
 * stop reason precisely so a refusal, a timeout or a dropped connection ends
 * the refinement without ending whatever asked for it — the harness is an
 * optimization, and an optimization that can fail a turn is a liability.
 */
export function createHarnessCompletionClient(args: Readonly<{
  transport: InferenceTransport;
  sessionId: string;
  model: string;
}>): HarnessCompletionClient {
  return {
    async complete(request: HarnessCompletionRequest): Promise<HarnessCompletionResult> {
      const controller = new AbortController();
      let text = "";
      let stopReason: HarnessCompletionResult["stopReason"] = "error";
      let errorMessage: string | undefined = "The refinement completion produced no terminal event.";
      try {
        for await (const event of args.transport.stream(
          {
            requestId: `harness-refine-${Date.now().toString(36)}`,
            sessionId: args.sessionId,
            // Its own identity, beside the conversation rather than inside it:
            // a refinement is not a turn and must not claim one's id.
            turnId: `harness-refine-${args.sessionId}`,
            model: args.model,
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: request.userPrompt }],
            tools: [],
            idempotencyKey: `${args.sessionId}:harness-refine:${request.maxOutputTokens}`,
          },
          controller.signal,
        )) {
          if (event.type === "text-delta") text += event.text;
          if (event.type === "tool-call") {
            // The request carries no tools, so a tool call is a provider
            // contract violation rather than something to execute.
            controller.abort();
            return Object.freeze({ stopReason: "error", text, errorMessage: "The refinement completion attempted a tool call." });
          }
          if (event.type === "completed") {
            stopReason = event.finishReason === "length" ? "length" : "stop";
            errorMessage = undefined;
          }
        }
      } catch (error) {
        return Object.freeze({
          stopReason: "error",
          text,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return Object.freeze({
        stopReason,
        text,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      });
    },
  };
}

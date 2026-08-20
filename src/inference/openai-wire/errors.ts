/**
 * Failure vocabulary for the shared OpenAI chat-completions wire helpers.
 *
 * Every transport that speaks this wire (browser-local loopback services and
 * OpenAI-compatible cloud providers) wraps these into its own error family, so
 * the codes here only ever name a parse verdict about the provider's bytes,
 * never a network or credential event.
 */
export type OpenAiWireErrorCode =
  | "invalid-response"
  | "tool-call-invalid"
  | "sse-limit";

export class OpenAiWireError extends Error {
  readonly code: OpenAiWireErrorCode;

  constructor(code: OpenAiWireErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "OpenAiWireError";
    this.code = code;
  }
}

import type {
  JsonValue,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../../core/contracts";
import type { InferenceConnectionRegistry } from "./connection-registry";
import type {
  InferenceAvailabilityLimits,
  InferenceAvailabilitySnapshot,
  SessionInferenceRoutePin,
} from "./contracts";
import type { InferenceModelCatalog } from "./model-catalog";
import type { InferenceProviderCatalog } from "./provider-catalog";
import { createInferenceAvailabilitySnapshot } from "./session-route";

export type InferenceAvailabilityToolOptions = Readonly<{
  providers: InferenceProviderCatalog;
  connections: InferenceConnectionRegistry;
  models: InferenceModelCatalog;
  activeSession?: () => SessionInferenceRoutePin | undefined;
  now?: () => number;
  limits?: Partial<InferenceAvailabilityLimits>;
  /** Optional credential-free projection for an externally managed provider. */
  project?: (snapshot: InferenceAvailabilitySnapshot) => InferenceAvailabilitySnapshot;
}>;

/**
 * Read-only agent surface for the same bounded snapshot used in a new-session
 * prompt. No credential accessor is reachable through this tool.
 */
export class InspectInferenceConnectionsTool implements Tool {
  readonly definition = Object.freeze({
    name: "inspect_inference_connections",
    description: "Inspect connected inference providers, observed availability, models, capabilities, and the immutable active-session route. Returns no credentials.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({}),
      additionalProperties: false,
    }),
    effect: "read" as const,
  });

  constructor(private readonly options: InferenceAvailabilityToolOptions) {}

  async execute(
    argumentsValue: JsonValue,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (
      !argumentsValue
      || Array.isArray(argumentsValue)
      || typeof argumentsValue !== "object"
      || Object.keys(argumentsValue).length !== 0
    ) {
      return {
        content: "inspect_inference_connections accepts an empty object.",
        isError: true,
      };
    }
    const capturedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const base = createInferenceAvailabilitySnapshot({
      providers: this.options.providers,
      connections: this.options.connections,
      models: this.options.models,
      activeSession: this.options.activeSession?.(),
      capturedAt,
      limits: this.options.limits,
    });
    const snapshot = this.options.project?.(base) ?? base;
    // Round-trip into the mutable JsonValue structural type without ever
    // touching the credential authority.
    const metadata = JSON.parse(JSON.stringify(snapshot)) as JsonValue;
    return {
      content: JSON.stringify(snapshot, null, 2),
      metadata,
    };
  }
}

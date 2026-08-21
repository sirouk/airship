/**
 * Is this a plain JSON object, as opposed to `null`, an array, or a scalar?
 *
 * One question, asked at every boundary where untrusted JSON arrives: a
 * persisted journal record, a bundle event, a wire frame, a model-emitted tool
 * argument. Seventeen files declared it privately in three spellings —
 * `Boolean(value) &&`, `!!value &&`, and `value !== null &&` — which agree
 * today and are three chances to disagree tomorrow. `src/core/single-implementation.contract.test.ts`
 * pins it here.
 *
 * It is its own module rather than an export of `core/contracts.ts` for a
 * measured reason: adding a runtime export to that file moved it out of the
 * `tool-registry-pack` chunk and cost the entry its modulepreload, which the
 * release gate refuses as an unclassified artifact.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

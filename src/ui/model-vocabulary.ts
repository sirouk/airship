/**
 * The words this product uses for a model capability — one vocabulary, one
 * source.
 *
 * Chat and Connection each grew their own formatter, so one fact had two
 * spellings on two screens: Connection's row said `Vision`, Chat's option said
 * `Vision · evidenced` followed by a popularity/load tail no other surface
 * printed. Nothing about that difference was a difference in meaning.
 *
 * This lives in its own module rather than inside `model-picker.tsx` for a
 * structural reason: the picker is a deferred pack (`model-picker.css` travels
 * with it), and the shell reads these words on the external-provider route,
 * which has no `AirshipModel` and therefore no picker. A static import of the
 * picker from the shell would pull the whole pack into the entry chunk to reach
 * five strings.
 */
export const MODEL_CAPABILITY_WORDS = Object.freeze({
  text: "Text",
  vision: "Vision",
  video: "Video",
  tools: "Tools",
  confidential: "Confidential candidate",
});

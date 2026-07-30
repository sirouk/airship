import type { SecurityPosture } from "../core/contracts";
import { PROFILE_POSTURE_FIELD_LABEL, PROFILE_POSTURE_LABELS } from "./profiles-governance";
import { postureLabel } from "./trust-language";

/**
 * Why a conversation refused to start, in the words the person set the floor in.
 *
 * Measured defect: this sentence was built inline from the raw union members
 * and reached the runtime status line verbatim — "The local runtime does not
 * satisfy this profile's encrypted-unattested minimum posture." A user who had
 * chosen "Encrypted" from the Minimum proof select (spelled by
 * `PROFILE_POSTURE_LABELS`, which this now reads) was shown a hyphenated
 * internal identifier that appears on no label in the product, on both sides
 * of the comparison.
 *
 * It also stopped at the diagnosis. This is the only text explaining why Chat
 * will not start, and on a phone it is the only text at all — the runtime line
 * is `display: none` below 640px and this is thrown into a status the user has
 * no other copy of — so it names both ways out. Neither is a guess: the floor
 * is a profile field with a known editor, and the posture is a property of the
 * connection.
 *
 * A function rather than a template at the throw site, because two dictionaries
 * already own these four names and a third spelling of them is the defect.
 */
export function postureFloorRefusal(
  runtimePosture: SecurityPosture,
  minimumPosture: SecurityPosture,
): string {
  return `This runtime is ${postureLabel(runtimePosture)}, which does not meet this profile's `
    + `${PROFILE_POSTURE_FIELD_LABEL} of ${PROFILE_POSTURE_LABELS[minimumPosture]}. `
    + `Connect a provider that meets it, or lower ${PROFILE_POSTURE_FIELD_LABEL} in Profiles.`;
}

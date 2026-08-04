/**
 * A structurally valid ML-KEM-768 encapsulation key, 1,184 bytes, base64.
 *
 * Lifted out of `confidential-embedding-mode.spec.ts` when a second journey
 * needed to finish a connection: `verifyModelAccess` reads `/e2e/instances/`
 * before it will call a connection made, and `build_e2ee_request` calls
 * `EncapsulationKey768::new`, which rejects a byte string that does not decode
 * and re-encode to itself. 1,184 counting bytes pass a length check and nothing
 * else, which is what silently stopped the encrypted leg before any request
 * left the page.
 *
 * FIPS 203 §7.2 says what "valid" means here: 768 twelve-bit coefficients, each
 * below q = 3329, packed two per three bytes, followed by a 32-byte seed.
 * Nothing secret is needed — encapsulation only ever uses the public half.
 */
export function mlKem768EncapsulationKey(): string {
  const bytes = new Uint8Array(1184);
  for (let pair = 0; pair < 384; pair += 1) {
    // Deterministic, and deliberately spread across the range rather than
    // constant: a packing bug that dropped high bits would still round-trip
    // zeros.
    const first = (pair * 7) % 3329;
    const second = (pair * 13 + 11) % 3329;
    const offset = pair * 3;
    bytes[offset] = first & 0xff;
    bytes[offset + 1] = ((first >> 8) & 0x0f) | ((second & 0x0f) << 4);
    bytes[offset + 2] = (second >> 4) & 0xff;
  }
  // The trailing 32-byte ρ seed is unconstrained.
  for (let index = 1152; index < 1184; index += 1) bytes[index] = index % 251;
  return Buffer.from(bytes).toString("base64");
}

/**
 * The baked loopback MinIO vault the lab auto-connects (`compose.local-lab.yaml`).
 *
 * This module exists so that a stock build can be free of it. Everything here —
 * the endpoint, the disposable bucket credentials and the fixed workspace key —
 * is reached through one dynamic import inside a `LOCAL_LAB_BUILD` branch, so a
 * build without the opt-in never places these bytes in any chunk. The fixed key
 * keeps the throwaway local vault decryptable across reloads; it is a
 * development convenience and is stated as one.
 */

const LOCAL_LAB_VAULT = Object.freeze({
  endpoint: "http://127.0.0.1:9900",
  region: "us-east-1",
  bucket: "airship-dev",
  namespace: "airship-live-v2/local-user",
  accessKeyId: "airship-vault-probe",
  secretAccessKey: "airship-vault-probe-only-2026",
});

const LOCAL_LAB_TEST_NAMESPACE_PARAMETER = "airshipLabNamespace";

export function isLoopbackAirshipLocation(location?: Pick<Location, "hostname">): boolean {
  const hostname = location?.hostname.trim().toLocaleLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Keep automated browser work out of the operator's visible local-user vault. */
export function localLabVaultConfiguration(location?: Pick<Location, "hostname" | "search">) {
  if (!location || !isLoopbackAirshipLocation(location)) {
    throw new TypeError("Baked MinIO configuration is available only on an exact loopback Airship origin.");
  }
  const candidate = new URLSearchParams(location.search).get(LOCAL_LAB_TEST_NAMESPACE_PARAMETER) ?? "";
  if (!/^airship-live-v2\/e2e\/[a-z0-9][a-z0-9-]{0,80}$/u.test(candidate)) return LOCAL_LAB_VAULT;
  return Object.freeze({ ...LOCAL_LAB_VAULT, namespace: candidate });
}

export const LOCAL_LAB_DEV_KEY: readonly number[] = Object.freeze([
  0xa1, 0x25, 0x7f, 0x0c, 0x93, 0x4e, 0xd8, 0x62, 0x1b, 0xf4, 0x30, 0xa9, 0x57, 0x8e, 0x6d, 0x14,
  0xc2, 0x0b, 0x9a, 0x46, 0xe3, 0x71, 0x58, 0xbd, 0x2f, 0x84, 0xd0, 0x6a, 0x39, 0xf7, 0x1c, 0x50,
]);

/**
 * The one way bytes Airship already holds leave the browser.
 *
 * Every download in this product is the same three lines — a Blob, an object
 * URL, a synthetic anchor — and each place that had written them got the
 * revoke and the cleanup slightly differently: `proof-view` and
 * `attestations-view` had one shape, `local-device-vault-setup` a second that
 * never attached the anchor to the document (which Firefox requires) and put
 * its availability check in a third place again. Every call site in the tree
 * is now here — `proof-view`, `attestations-view`, `workspace-view` and the
 * two in `local-device-vault-setup` — so there is one revoke, one cleanup, one
 * precondition and one place to fix any of them. Naming the operation once
 * also names its bound: this hands the caller's exact bytes to the browser and
 * nothing else.
 * It never re-reads, re-encodes or truncates them, because a download that
 * quietly shipped a bounded preview would be indistinguishable from the real
 * file.
 */

/**
 * A filename a browser download can safely carry.
 *
 * `anchor.download` is a *filename*, not a path: a value carrying `/` or `\`
 * is either ignored or silently rewritten by the browser, and a control
 * character in a Content-Disposition-shaped string is a header-splitting
 * idiom. Both are stripped here rather than trusted to the platform.
 */
export function downloadFileName(path: string, fallback = "workspace-file"): string {
  const base = path.split(/[/\\]/u).filter(Boolean).at(-1) ?? "";
  const sanitized = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return sanitized === "" || sanitized === "." || sanitized === ".." ? fallback : sanitized;
}

/**
 * Downloads exact bytes under an exact name.
 *
 * `application/octet-stream` on purpose: the workspace stores a file's bytes,
 * not its media type, and guessing one from an extension would let a download
 * assert a type the stored object never claimed.
 *
 * Throws rather than returning when the platform cannot download at all. Every
 * caller reports the failure to the user, and the one that matters — the Vault
 * export — must never let "the browser has no object URLs" pass as a backup
 * the user now believes they hold.
 */
export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  type = "application/octet-stream",
): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Browser download is unavailable.");
  }
  // A fresh buffer, so a view onto a larger array cannot leak its neighbours
  // into the downloaded file.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Downloads a text payload — a receipt, a bundle, a status summary.
 *
 * Encoded to UTF-8 here rather than handed to `Blob` as a string so that the
 * receipt a verifier re-hashes is byte-for-byte the one the caller composed:
 * `new Blob(["…"])` also encodes as UTF-8, but stating it is what stops the
 * next reader from assuming the platform's default is negotiable. Unlike
 * `downloadBytes` the type defaults to JSON, because every text download in
 * this product so far is a JSON document a machine will read back.
 */
export function downloadText(text: string, filename: string, type = "application/json"): void {
  downloadBytes(new TextEncoder().encode(text), filename, type);
}

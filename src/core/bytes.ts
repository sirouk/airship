/** Return an owned ArrayBuffer accepted by strict Web Crypto and Fetch typings. */
export function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}


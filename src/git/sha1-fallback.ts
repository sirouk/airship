/**
 * Small incremental-compatible SHA-1 fallback for isomorphic-git.
 *
 * Modern browsers take isomorphic-git's Web Crypto path for ordinary object
 * hashing. Its pack writer and browsers without subtle SHA-1 still need the
 * legacy `sha.js/sha1.js` constructor contract, however. Shipping that CommonJS
 * fallback also pulled in safe-buffer, to-buffer, and a typed-array inspection
 * graph despite Airship already normalizing every input to browser byte views.
 *
 * Keep this implementation deliberately narrow: update accepts the byte and
 * string inputs isomorphic-git uses, digest returns bytes or lower-case hex,
 * and the SHA-1 transform itself follows FIPS PUB 180-1.
 */

const UTF8 = new TextEncoder();
const BLOCK_BYTES = 64;
const LENGTH_FIELD_BYTES = 8;

function bytesFrom(value: string | ArrayBuffer | ArrayBufferView, encoding = "utf8"): Uint8Array {
  if (typeof value !== "string") {
    return value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (encoding === "hex") {
    if (value.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(value)) {
      throw new TypeError("SHA-1 hex input must contain complete hexadecimal bytes.");
    }
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (encoding !== "utf8" && encoding !== "utf-8") {
    throw new TypeError(`Unsupported SHA-1 input encoding: ${encoding}.`);
  }
  return UTF8.encode(value);
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

export default class BrowserSha1 {
  private readonly tail = new Uint8Array(BLOCK_BYTES);
  private readonly words = new Int32Array(80);
  private tailLength = 0;
  private byteLength = 0;
  private finalized = false;
  private h0 = 0x67452301 | 0;
  private h1 = 0xefcdab89 | 0;
  private h2 = 0x98badcfe | 0;
  private h3 = 0x10325476 | 0;
  private h4 = 0xc3d2e1f0 | 0;

  update(value: string | ArrayBuffer | ArrayBufferView, encoding?: string): this {
    if (this.finalized) throw new Error("SHA-1 digest has already been finalized.");
    const bytes = bytesFrom(value, encoding);
    const nextByteLength = this.byteLength + bytes.byteLength;
    if (!Number.isSafeInteger(nextByteLength)) {
      throw new RangeError("SHA-1 input exceeds the maximum safely countable byte length.");
    }
    this.byteLength = nextByteLength;

    let offset = 0;
    if (this.tailLength > 0) {
      const available = BLOCK_BYTES - this.tailLength;
      const copied = Math.min(available, bytes.byteLength);
      this.tail.set(bytes.subarray(0, copied), this.tailLength);
      this.tailLength += copied;
      offset = copied;
      if (this.tailLength === BLOCK_BYTES) {
        this.transform(this.tail, 0);
        this.tailLength = 0;
      }
    }

    while (offset + BLOCK_BYTES <= bytes.byteLength) {
      this.transform(bytes, offset);
      offset += BLOCK_BYTES;
    }
    if (offset < bytes.byteLength) {
      const remainder = bytes.subarray(offset);
      this.tail.set(remainder, 0);
      this.tailLength = remainder.byteLength;
    }
    return this;
  }

  digest(encoding?: string): Uint8Array | string {
    if (this.finalized) throw new Error("SHA-1 digest has already been finalized.");
    if (encoding !== undefined && encoding !== "hex") {
      throw new TypeError(`Unsupported SHA-1 digest encoding: ${encoding}.`);
    }
    this.finalized = true;

    const finalByteLength = this.tailLength < BLOCK_BYTES - LENGTH_FIELD_BYTES
      ? BLOCK_BYTES
      : BLOCK_BYTES * 2;
    const finalBlocks = new Uint8Array(finalByteLength);
    finalBlocks.set(this.tail.subarray(0, this.tailLength));
    finalBlocks[this.tailLength] = 0x80;
    const finalView = new DataView(finalBlocks.buffer);
    const bitLengthHigh = Math.floor(this.byteLength / 0x20000000);
    const bitLengthLow = (this.byteLength % 0x20000000) * 8;
    finalView.setUint32(finalByteLength - LENGTH_FIELD_BYTES, bitLengthHigh);
    finalView.setUint32(finalByteLength - 4, bitLengthLow);
    for (let offset = 0; offset < finalByteLength; offset += BLOCK_BYTES) {
      this.transform(finalBlocks, offset);
    }

    const result = new Uint8Array(20);
    const resultView = new DataView(result.buffer);
    [this.h0, this.h1, this.h2, this.h3, this.h4]
      .forEach((word, index) => resultView.setUint32(index * 4, word >>> 0));
    this.tail.fill(0);
    this.tailLength = 0;

    if (encoding === undefined) return result;
    let hex = "";
    for (const byte of result) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }

  private transform(block: Uint8Array, offset: number): void {
    const words = this.words;
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] = (
        (block[wordOffset] << 24)
        | (block[wordOffset + 1] << 16)
        | (block[wordOffset + 2] << 8)
        | block[wordOffset + 3]
      );
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1,
      );
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + f + e + k + words[index]) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }
}

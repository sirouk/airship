import type { ObjectStore } from "./object-store";

const encoder = new TextEncoder();

export type ObjectStoreConformanceResult = {
  prefix: string;
  checks: Array<{ name: string; durationMs: number }>;
  createdKeys: string[];
};

/**
 * Destructive-in-the-small live probe for an isolated, disposable prefix.
 * The store contract has no delete operation, so callers must configure expiry
 * or remove the returned keys out-of-band after the run.
 */
export async function runObjectStoreConformance(args: {
  store: ObjectStore;
  prefix: string;
  nonce?: string;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<ObjectStoreConformanceResult> {
  const now = args.now ?? (() => performance.now());
  const prefix = disposablePrefix(args.prefix, args.nonce ?? randomNonce());
  const immutableKey = `${prefix}/immutable.bin`;
  const rootKey = `${prefix}/root.json`;
  const racedCreateKey = `${prefix}/raced-create.bin`;
  const specialKey = `${prefix}/space % snowman-☃.bin`;
  const encodedAliasKey = `${prefix}/space%20%25%20snowman-%E2%98%83.bin`;
  const adjacentKey = `${prefix}-adjacent/must-not-list.bin`;
  const createdKeys = [immutableKey, rootKey, racedCreateKey, specialKey, encodedAliasKey, adjacentKey];
  const checks: ObjectStoreConformanceResult["checks"] = [];
  const original = encoder.encode("airship-object-store-conformance-v1");

  const created = await timed(checks, "conditional create", now, () => args.store.putIfAbsent(immutableKey, original, args.signal));
  invariant(created.created && Boolean(created.etag), "conditional create did not create a versioned object");

  const duplicate = await timed(checks, "duplicate rejection", now, () => args.store.putIfAbsent(immutableKey, encoder.encode("different"), args.signal));
  invariant(!duplicate.created, "If-None-Match semantics allowed an overwrite");

  const createRace = await timed(checks, "concurrent create serialization", now, () =>
    Promise.all([
      args.store.putIfAbsent(racedCreateKey, encoder.encode("writer-a"), args.signal),
      args.store.putIfAbsent(racedCreateKey, encoder.encode("writer-b"), args.signal),
    ]),
  );
  invariant(createRace.filter((result) => result.created).length === 1, "concurrent create did not produce exactly one winner");

  const read = await timed(checks, "read after write", now, () => args.store.get(immutableKey, args.signal));
  invariant(read && equalBytes(read.bytes, original), "read-after-write returned missing or different bytes");
  invariant(read.etag === created.etag, "ETag changed between write and read");

  const range = await timed(checks, "exact range read", now, () => args.store.getRange(immutableKey, 8, 20, args.signal));
  invariant(range && equalBytes(range.bytes, original.slice(8, 20)), "range read returned missing or different bytes");
  invariant(range.start === 8 && range.endExclusive === 20, "range response offsets were not exact");
  invariant(range.etag === created.etag, "range ETag does not match the full object ETag");
  invariant(range.totalSize === original.byteLength, "range response did not expose the exact object size");

  const specialBytes = encoder.encode("special-one");
  const aliasBytes = encoder.encode("special-two");
  await timed(checks, "special-character key injectivity", now, async () => {
    const [special, encodedAlias, adjacent] = await Promise.all([
      args.store.putIfAbsent(specialKey, specialBytes, args.signal),
      args.store.putIfAbsent(encodedAliasKey, aliasBytes, args.signal),
      args.store.putIfAbsent(adjacentKey, encoder.encode("adjacent"), args.signal),
    ]);
    invariant(special.created && encodedAlias.created && adjacent.created, "special or adjacent conformance keys collided");
    const [specialRead, aliasRead] = await Promise.all([
      args.store.get(specialKey, args.signal),
      args.store.get(encodedAliasKey, args.signal),
    ]);
    invariant(specialRead && equalBytes(specialRead.bytes, specialBytes), "special-character key was not injective");
    invariant(aliasRead && equalBytes(aliasRead.bytes, aliasBytes), "percent-encoded-looking key was aliased");
  });

  const listed = await timed(checks, "prefix list after write", now, () => args.store.list(`${prefix}/`, args.signal));
  invariant(listed.some((item) => item.key === immutableKey && item.etag === created.etag), "list did not expose the new object and ETag");
  invariant(!listed.some((item) => item.key === adjacentKey), "list leaked an object outside the requested prefix");

  const listedFromRoot = await timed(checks, "empty-prefix list", now, () => args.store.list("", args.signal));
  invariant(listedFromRoot.some((item) => item.key === immutableKey), "empty-prefix listing omitted a conformance object");

  const initialRoot = encoder.encode('{"generation":0}');
  const root = await timed(checks, "root create", now, () => args.store.putIfAbsent(rootKey, initialRoot, args.signal));
  invariant(root.created, "root create failed");

  const stale = await timed(checks, "stale CAS rejection", now, () =>
    args.store.compareAndSwap(rootKey, "definitely-not-the-current-etag", encoder.encode('{"generation":1}'), args.signal),
  );
  invariant(!stale.updated, "stale If-Match unexpectedly changed the root");

  const missing = await timed(checks, "missing-key CAS rejection", now, () =>
    args.store.compareAndSwap(`${prefix}/missing-root.json`, "missing-etag", encoder.encode("{}"), args.signal),
  );
  invariant(!missing.updated && missing.reason === "missing", "missing-key CAS did not report a definite miss");

  const candidateA = encoder.encode('{"generation":1,"writer":"a"}');
  const candidateB = encoder.encode('{"generation":1,"writer":"b"}');
  const raced = await timed(checks, "concurrent CAS serialization", now, () =>
    Promise.all([
      args.store.compareAndSwap(rootKey, root.etag, candidateA, args.signal),
      args.store.compareAndSwap(rootKey, root.etag, candidateB, args.signal),
    ]),
  );
  invariant(raced.filter((result) => result.updated).length === 1, "concurrent CAS did not produce exactly one winner");

  const finalRoot = await timed(checks, "winning root visibility", now, () => args.store.get(rootKey, args.signal));
  invariant(finalRoot, "root disappeared after a successful CAS");
  const winnerBytes = raced[0].updated ? candidateA : candidateB;
  const winnerEtag = raced.find((result) => result.updated)!.etag;
  invariant(equalBytes(finalRoot.bytes, winnerBytes), "root bytes do not match the CAS winner");
  invariant(finalRoot.etag === winnerEtag, "root ETag does not match the CAS winner");

  return { prefix, checks, createdKeys };
}

async function timed<T>(
  checks: ObjectStoreConformanceResult["checks"],
  name: string,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const started = now();
  try {
    return await operation();
  } finally {
    checks.push({ name, durationMs: Math.max(0, now() - started) });
  }
}

function disposablePrefix(value: string, nonce: string): string {
  const prefix = value.replace(/^\/+|\/+$/gu, "");
  if (!prefix || !/^[A-Za-z0-9._/-]+$/u.test(prefix)) throw new Error("Conformance prefix is invalid.");
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(nonce)) throw new Error("Conformance nonce is invalid.");
  return `${prefix}/${nonce}`;
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Object-store conformance failed: ${message}`);
}

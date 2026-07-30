/**
 * The one recursive freeze in this build.
 *
 * `function deepFreeze` was declared twenty times, in two behaviours, under one
 * name. Twelve copies froze the parent before recursing; eight recursed first,
 * so the `Object.isFrozen` guard was never reached on the way back round a
 * cycle and the same object recursed until the stack overflowed. Journal-derived
 * records reach these freezers, and a record that references a sibling — a fork
 * seed that points back at its parent turn, an audit entry that carries the
 * session it belongs to — turned "make this immutable" into a RangeError in
 * eight subsystems and a no-op in twelve.
 *
 * Freezing before recursing is the variant that wins, because it is the only one
 * that terminates on a self-referential object: the guard sees the parent as
 * already frozen when the cycle comes back to it.
 *
 * Returning `T` rather than `Readonly<T>` is deliberate. `T` is assignable to
 * `Readonly<T>`, so the two call sites that annotated their local copy
 * `Readonly<T>` keep type-checking, while a caller that needs the value's own
 * type back is not forced through a cast.
 */
export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

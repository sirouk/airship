/**
 * Where the return ledger is kept, split out from the ledger itself.
 *
 * The shell needs this accessor on the boot path and the ledger's logic on a
 * deferred one — `return-ledger.ts` is dynamically imported precisely so it does
 * not sit in the entry chunk, which has 20 bytes of headroom under its 112 KiB
 * ceiling. Importing the accessor from there would have dragged the whole module
 * back in. Deletion is the third caller: a conversation the person deliberately
 * removed must be forgotten by the ledger in the same breath, or a later return
 * mourns work that was thrown away on purpose.
 */
export type ReturnLedgerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserReturnLedgerStorage(): ReturnLedgerStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

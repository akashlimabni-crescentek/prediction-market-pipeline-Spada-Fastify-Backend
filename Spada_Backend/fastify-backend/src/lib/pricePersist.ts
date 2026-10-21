/** True when two price arrays are the same length and the same numbers. */
export function sameNumericPrices(a: number[] | undefined, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A live tick still broadcasts over the WebSocket.
 * The markets row is rewritten only when the persisted prices actually change.
 */
export function pricesNeedPersist(
  lastPersisted: number[] | undefined,
  next: number[]
): boolean {
  return !sameNumericPrices(lastPersisted, next);
}

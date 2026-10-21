/**
 * Markets a browser has open. The price worker unions these onto the
 * exchange sockets so the chart on screen receives ticks even when the
 * market is outside the rotating 150-market pool.
 */
const counts = new Map<string, number>();
const listeners = new Set<(canonicalId: string, pinned: boolean) => void>();

export function watchLivePins(
  listener: (canonicalId: string, pinned: boolean) => void
): () => void {
  listeners.add(listener);
  for (const canonicalId of counts.keys()) listener(canonicalId, true);
  return () => {
    listeners.delete(listener);
  };
}

export function livePinnedIds(): string[] {
  return [...counts.keys()];
}

export function pinLiveMarket(canonicalId: string): void {
  const id = canonicalId.trim();
  if (!id) return;
  const next = (counts.get(id) ?? 0) + 1;
  counts.set(id, next);
  if (next === 1) {
    for (const listener of listeners) listener(id, true);
  }
}

export function unpinLiveMarket(canonicalId: string): void {
  const id = canonicalId.trim();
  if (!id) return;
  const current = counts.get(id) ?? 0;
  if (current <= 1) {
    counts.delete(id);
    for (const listener of listeners) listener(id, false);
  } else {
    counts.set(id, current - 1);
  }
}

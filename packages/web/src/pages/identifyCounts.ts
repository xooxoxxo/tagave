/**
 * The Identify counts shown outside the tab's own figures: Home's "To do ›
 * Identify albums", the Library care tab badge, and the reason chips above
 * the list of albums that could not be matched.
 */
interface CountStats {
  states: { pending: number; unidentified: number };
  reasons?: Record<string, number>;
}

/**
 * Albums that still need identifying: the ones waiting for a lookup and the
 * ones it could not match. Matches waiting for a decision are counted under
 * "Review matches", not here.
 */
export function identifyTodoCount(stats: CountStats | undefined): number | undefined {
  if (!stats) return undefined;
  return stats.states.pending + stats.states.unidentified;
}

/**
 * The number on a reason chip. "All" (no reason) is every album the
 * unfiltered list shows: the albums that could not be matched.
 */
export function reasonChipCount(reason: string | null, stats: CountStats | undefined): number {
  if (!stats) return 0;
  if (reason === null) return stats.states.unidentified;
  return stats.reasons?.[reason] ?? 0;
}

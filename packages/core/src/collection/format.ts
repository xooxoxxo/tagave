/**
 * One short format line for a physical record ("CD", "2×Vinyl, CD") from
 * whatever shape the row carries: a Discogs collection item's formats
 * ({ name, qty }), a release's media list ({ format }) or plain strings.
 */
export function physicalFormatLabel(formats: unknown): string | null {
  if (!Array.isArray(formats)) return null;
  const counts = new Map<string, number>();
  for (const f of formats) {
    let name: string | null = null;
    let qty = 1;
    if (typeof f === 'string') name = f;
    else if (f && typeof f === 'object') {
      const o = f as Record<string, unknown>;
      name = typeof o['name'] === 'string' ? o['name'] : typeof o['format'] === 'string' ? o['format'] : null;
      const q = typeof o['qty'] === 'string' ? parseInt(o['qty'], 10) : typeof o['qty'] === 'number' ? o['qty'] : NaN;
      if (Number.isFinite(q) && q > 0) qty = q;
    }
    if (!name || name === 'All Media') continue;
    counts.set(name, (counts.get(name) ?? 0) + qty);
  }
  if (counts.size === 0) return null;
  return [...counts].map(([name, n]) => (n > 1 ? `${n}×${name}` : name)).join(', ');
}

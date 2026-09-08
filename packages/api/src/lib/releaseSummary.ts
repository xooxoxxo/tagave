/**
 * One-line summaries of a release's media and label for candidate rows, so two
 * Discogs releases with the same title, date and track count can be told
 * apart on the album page (2026-09-08 review: 30139532 vs 30139541).
 */

/** "CD", "2×LP", "CD + DVD" from releases.media ({position, format, trackCount} per medium). */
export function mediaSummary(media: unknown): string | null {
  if (!Array.isArray(media) || media.length === 0) return null;
  const counts = new Map<string, number>();
  for (const m of media) {
    const raw = (m as { format?: unknown } | null)?.format;
    const format = typeof raw === 'string' && raw.trim() ? raw.trim() : 'Unknown';
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }
  return [...counts].map(([format, n]) => (n > 1 ? `${n}×${format}` : format)).join(' + ');
}

/** "Label · CATNO" from the first releases.labels entry ({name, catalogNumber}; older rows used catno). */
export function labelSummary(labels: unknown): string | null {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  const first = labels[0] as { name?: unknown; catalogNumber?: unknown; catno?: unknown } | null;
  const name = typeof first?.name === 'string' ? first.name.trim() : '';
  const catno = typeof first?.catalogNumber === 'string'
    ? first.catalogNumber.trim()
    : typeof first?.catno === 'string' ? first.catno.trim() : '';
  if (!name && !catno) return null;
  return [name, catno].filter(Boolean).join(' · ');
}

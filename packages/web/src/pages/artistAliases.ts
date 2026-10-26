/** Case, spaces and punctuation set aside: "aphex+twin" and "AphexTwin" are "Aphex Twin". */
const key = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The aliases worth showing under an artist's name: not the name itself, and
 * not a spelling that differs from the name or an earlier alias only in case,
 * spaces or punctuation (MusicBrainz search hints such as "aphex+twin").
 */
export function shownAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set([key(name)]);
  const out: string[] = [];
  for (const alias of aliases) {
    const k = key(alias);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(alias);
  }
  return out;
}

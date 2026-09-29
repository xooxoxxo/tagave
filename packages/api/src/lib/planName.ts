/**
 * The name a plan should carry after albums were added to it, or null to keep
 * the one it has.
 *
 * The wizard names a new album plan after what it covers: "Artist — Title
 * tags" for one album, "3 albums tags" for several. Once a second album joins
 * a plan named after its first album, that name describes only part of it.
 * Only names the wizard made are rewritten; anything the user typed stays.
 *
 * @param name        the plan's current name
 * @param newCount    how many albums the plan covers after the add
 * @param firstTitles titles of the plan's albums before the add (local and
 *                    canonical); a one-album name is recognised by containing
 *                    one of them
 */
export function grownPlanName(name: string, prevCount: number, newCount: number, firstTitles: string[]): string | null {
  if (newCount <= prevCount || newCount < 2) return null;
  const trimmed = name.trim();

  // "3 albums tags" (wizard, several albums)
  if (/^\d+ albums? tags$/i.test(trimmed)) return `${newCount} albums tags`;

  const more = (base: string) => {
    const extra = newCount - 1;
    return `${base} + ${extra} more album${extra === 1 ? '' : 's'} tags`;
  };

  // "Artist — Title + 2 more albums tags" (grown here before)
  const grown = /^(.+) \+ \d+ more albums? tags$/i.exec(trimmed);
  if (grown) return more(grown[1]!);

  // "Artist — Title tags" (wizard, one album)
  if (prevCount === 1 && /\s+tags$/i.test(trimmed)) {
    const base = trimmed.replace(/\s+tags$/i, '');
    const lowered = base.toLowerCase();
    if (firstTitles.some((t) => t.trim() !== '' && lowered.includes(t.trim().toLowerCase()))) return more(base);
  }
  return null;
}

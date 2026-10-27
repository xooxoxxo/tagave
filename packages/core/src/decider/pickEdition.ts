/**
 * The edition inside a chosen tracklist, by the owner's rules and never by a
 * model: prefer the owner's source when it has an edition that passes,
 * official only when asked (a Discogs edition has no status and passes),
 * then the matcher's best distance, then release id for a stable result.
 * A member without a finite distance never passes. No passing edition is
 * null: the album gets no decision rather than one outside the rules.
 */
import { statusTag } from '@tagave/shared';

export interface EditionChoice { releaseId: string; distance: number; provider: 'musicbrainz' | 'discogs'; status: string | null; source: string }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: EditionChoice, b: EditionChoice) =>
  a.distance - b.distance || cmp(a.releaseId, b.releaseId) || cmp(a.provider, b.provider) || cmp(a.source, b.source);

export function pickEdition(members: EditionChoice[], rules: { preferSource: 'musicbrainz' | 'discogs' | 'either'; officialOnly: boolean }): EditionChoice | null {
  const passes = (e: EditionChoice) => Number.isFinite(e.distance) && (!rules.officialOnly || statusTag(e.status) === null);
  let field = members;
  if (rules.preferSource !== 'either') {
    const preferred = members.filter((e) => e.provider === rules.preferSource);
    if (preferred.some(passes)) field = preferred;
  }
  return field.filter(passes).sort(order)[0] ?? null;
}

import { describe, it, expect } from 'vitest';
import { pickEdition, type EditionChoice } from './pickEdition.js';
const e = (id: string, distance: number, provider: 'musicbrainz' | 'discogs', status: string | null): EditionChoice => ({ releaseId: id, distance, provider, status, source: 'mb_search' });
const either = { preferSource: 'either' as const, officialOnly: true };

describe('pickEdition', () => {
  it('best distance among official editions', () => {
    expect(pickEdition([e('boot', 0.01, 'musicbrainz', 'Bootleg'), e('uk', 0.05, 'musicbrainz', 'Official'), e('de', 0.04, 'musicbrainz', 'Official')], either)!.releaseId).toBe('de');
  });
  it('a Discogs edition has no status and counts as official', () => {
    expect(pickEdition([e('dg', 0.03, 'discogs', null)], either)!.releaseId).toBe('dg');
  });
  it('prefers the owner\'s source when it has a passing edition', () => {
    expect(pickEdition([e('dg', 0.01, 'discogs', null), e('mb', 0.05, 'musicbrainz', 'Official')], { preferSource: 'musicbrainz', officialOnly: true })!.releaseId).toBe('mb');
  });
  it('falls back to the other source when the preferred has none passing', () => {
    expect(pickEdition([e('dg', 0.01, 'discogs', null), e('mb', 0.05, 'musicbrainz', 'Promotion')], { preferSource: 'musicbrainz', officialOnly: true })!.releaseId).toBe('dg');
  });
  it('no official edition in the group: none', () => {
    expect(pickEdition([e('boot', 0.01, 'musicbrainz', 'Bootleg')], either)).toBeNull();
  });
  it('officialOnly off takes the best distance', () => {
    expect(pickEdition([e('boot', 0.01, 'musicbrainz', 'Bootleg'), e('uk', 0.05, 'musicbrainz', 'Official')], { preferSource: 'either', officialOnly: false })!.releaseId).toBe('boot');
  });
  it('ties break on release id', () => {
    expect(pickEdition([e('b', 0.05, 'musicbrainz', 'Official'), e('a', 0.05, 'musicbrainz', 'Official')], either)!.releaseId).toBe('a');
  });

  it('a tie gives the same choice in any input order', () => {
    const members = [e('c', 0.05, 'discogs', null), e('a', 0.05, 'musicbrainz', 'Official'), e('b', 0.05, 'musicbrainz', 'official ')];
    const picks = [members, [...members].reverse(), [members[1]!, members[2]!, members[0]!]].map((m) => pickEdition(m, either)!.releaseId);
    expect(picks).toEqual(['a', 'a', 'a']);
  });
  it('no members: none', () => {
    expect(pickEdition([], either)).toBeNull();
  });
  it('a member without a usable distance is never picked', () => {
    expect(pickEdition([e('nan', Number.NaN, 'musicbrainz', 'Official'), e('ok', 0.2, 'musicbrainz', 'Official')], either)!.releaseId).toBe('ok');
    expect(pickEdition([e('nan', Number.NaN, 'musicbrainz', 'Official')], either)).toBeNull();
  });
  it('does not reorder the caller\'s array', () => {
    const members = [e('b', 0.05, 'musicbrainz', 'Official'), e('a', 0.01, 'musicbrainz', 'Official')];
    pickEdition(members, either);
    expect(members.map((m) => m.releaseId)).toEqual(['b', 'a']);
  });
});

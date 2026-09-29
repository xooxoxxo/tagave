/**
 * What the owner pasted into "match manually": a MusicBrainz release or
 * release-group URL, a bare MusicBrainz id (release or release group — the
 * worker finds out which), or a Discogs release / master URL or id. Any other
 * MusicBrainz page gets a sentence saying what to paste instead.
 */
import { parseDiscogsRef } from '@liner/core';

export type MatchTarget =
  | { source: 'musicbrainz'; entity: 'release' | 'release-group' | 'unknown'; mbid: string }
  | { source: 'discogs'; kind: 'release' | 'master'; id: number };

export type MatchInputResult = { ok: true; target: MatchTarget } | { ok: false; message: string };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const MB_ENTITY_NAME: Record<string, string> = {
  artist: 'an artist', recording: 'a recording', work: 'a work', label: 'a label', track: 'a track',
  event: 'an event', place: 'a place', area: 'an area', series: 'a series', instrument: 'an instrument',
  url: 'a URL', cdtoc: 'a disc id',
};

export function parseMatchInput(raw: string | null | undefined): MatchInputResult {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, message: 'Paste a MusicBrainz or Discogs release URL or ID.' };

  const mbUrl = input.match(/musicbrainz\.org\/([a-z-]+)\/([0-9a-f-]{36})/i);
  if (mbUrl) {
    const entity = mbUrl[1]!.toLowerCase();
    const mbid = mbUrl[2]!.toLowerCase();
    if (entity === 'release') return { ok: true, target: { source: 'musicbrainz', entity: 'release', mbid } };
    if (entity === 'release-group') return { ok: true, target: { source: 'musicbrainz', entity: 'release-group', mbid } };
    const what = MB_ENTITY_NAME[entity] ?? `a ${entity}`;
    return { ok: false, message: `That is ${what} page on MusicBrainz, not an album. Open the album's release page (musicbrainz.org/release/…) or its release group and paste that.` };
  }
  if (/musicbrainz\.org/i.test(input)) {
    return { ok: false, message: 'That MusicBrainz address names no release. Paste a release page (musicbrainz.org/release/…).' };
  }

  const discogs = parseDiscogsRef(input);
  if (discogs) return { ok: true, target: { source: 'discogs', kind: discogs.kind, id: discogs.id } };
  if (/discogs\.com/i.test(input)) {
    return { ok: false, message: 'That Discogs address is not a release or master page. Paste discogs.com/release/… or discogs.com/master/….' };
  }

  const bare = input.match(UUID);
  if (bare && input.replace(UUID, '').replace(/[\s/]/g, '') === '') {
    return { ok: true, target: { source: 'musicbrainz', entity: 'unknown', mbid: bare[0].toLowerCase() } };
  }
  return { ok: false, message: 'No MusicBrainz ID or Discogs release / master found. Paste a MusicBrainz release URL or ID, or a Discogs release / master URL or ID.' };
}

/** identify.album job data for a parsed target. */
export function pinnedJobData(target: MatchTarget): Record<string, unknown> {
  if (target.source === 'discogs') return { pinnedDiscogs: { kind: target.kind, id: target.id } };
  if (target.entity === 'release-group') return { pinnedReleaseGroup: target.mbid };
  return { pinnedMbid: target.mbid };
}

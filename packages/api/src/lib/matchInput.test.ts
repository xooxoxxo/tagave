import { describe, it, expect } from 'vitest';
import { parseMatchInput, pinnedJobData } from './matchInput.js';

const RG = '593f3c1a-3529-39e6-92ef-395dd48f840c';
const REL = 'f52cf3d9-c1f2-492f-99d5-b4b2cbd5d081';

describe('parseMatchInput', () => {
  it('reads a MusicBrainz release URL', () => {
    expect(parseMatchInput(`https://musicbrainz.org/release/${REL}`)).toEqual({ ok: true, target: { source: 'musicbrainz', entity: 'release', mbid: REL } });
    expect(parseMatchInput(`https://beta.musicbrainz.org/release/${REL.toUpperCase()}/discids`)).toEqual({ ok: true, target: { source: 'musicbrainz', entity: 'release', mbid: REL } });
  });

  it('accepts a release-group URL', () => {
    expect(parseMatchInput(`https://musicbrainz.org/release-group/${RG}`)).toEqual({ ok: true, target: { source: 'musicbrainz', entity: 'release-group', mbid: RG } });
  });

  it('leaves a bare id to the worker to tell release from release group', () => {
    expect(parseMatchInput(`  ${RG} `)).toEqual({ ok: true, target: { source: 'musicbrainz', entity: 'unknown', mbid: RG } });
  });

  it('refuses other MusicBrainz pages with what to paste instead', () => {
    const r = parseMatchInput(`https://musicbrainz.org/artist/${RG}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/artist page on MusicBrainz, not an album/);
    const rec = parseMatchInput(`https://musicbrainz.org/recording/${RG}`);
    if (!rec.ok) expect(rec.message).toMatch(/a recording page/);
    expect(parseMatchInput('https://musicbrainz.org/search?query=x').ok).toBe(false);
  });

  it('reads Discogs releases and masters', () => {
    expect(parseMatchInput('https://www.discogs.com/release/1234567-Stephane-Pompougnac-Hotel-Costes-11')).toEqual({ ok: true, target: { source: 'discogs', kind: 'release', id: 1234567 } });
    expect(parseMatchInput('https://www.discogs.com/de/master/358698')).toEqual({ ok: true, target: { source: 'discogs', kind: 'master', id: 358698 } });
    expect(parseMatchInput('[m358698]')).toEqual({ ok: true, target: { source: 'discogs', kind: 'master', id: 358698 } });
    expect(parseMatchInput('15803887')).toEqual({ ok: true, target: { source: 'discogs', kind: 'release', id: 15803887 } });
  });

  it('refuses a Discogs page that is not a release or master', () => {
    const r = parseMatchInput('https://www.discogs.com/artist/12345-Someone');
    expect(r.ok).toBe(false);
  });

  it('says what to paste for empty or unrelated input', () => {
    expect(parseMatchInput('')).toMatchObject({ ok: false });
    expect(parseMatchInput('hotel costes 11')).toMatchObject({ ok: false });
    expect(parseMatchInput(`see ${RG} maybe`)).toMatchObject({ ok: false });
  });
});

describe('pinnedJobData', () => {
  it('maps each target to the identify.album payload', () => {
    expect(pinnedJobData({ source: 'musicbrainz', entity: 'release', mbid: REL })).toEqual({ pinnedMbid: REL });
    expect(pinnedJobData({ source: 'musicbrainz', entity: 'unknown', mbid: RG })).toEqual({ pinnedMbid: RG });
    expect(pinnedJobData({ source: 'musicbrainz', entity: 'release-group', mbid: RG })).toEqual({ pinnedReleaseGroup: RG });
    expect(pinnedJobData({ source: 'discogs', kind: 'master', id: 1 })).toEqual({ pinnedDiscogs: { kind: 'master', id: 1 } });
  });
});

import { describe, it, expect } from 'vitest';
import {
  compareEdition, everyCheckAgrees, matchPercent, matchStrength, statusTag,
  DEFAULT_AUTO_ACCEPT_RULES, autoAcceptRulesSchema, type AutoAcceptRules,
} from '@liner/shared';
import { evaluateAutoAccept, type RuleCandidate } from './autoAcceptRules.js';
import { MATCHING_THRESHOLDS } from './types.js';

const album = { title: 'Kosmonument', artist: 'Oranssi Pazuzu', year: 2011, trackCount: 10 };
const clean = { album: 0, artist: 0, trackTitle: 0, tracks: 0, year: 0 };

let n = 0;
function cand(over: Partial<RuleCandidate> = {}): RuleCandidate {
  n += 1;
  return {
    id: `c${n}`,
    title: 'Kosmonument',
    artist: 'Oranssi Pazuzu',
    date: '2011-03-01',
    country: 'FI',
    trackCount: 10,
    breakdown: clean,
    distance: 0.02,
    provider: 'musicbrainz',
    status: 'Official',
    ...over,
  };
}

const rules = (over: Partial<AutoAcceptRules> = {}): AutoAcceptRules => ({ ...DEFAULT_AUTO_ACCEPT_RULES, enabled: true, ...over });

describe('matchPercent', () => {
  it('is (1 − distance) as a whole percent', () => {
    expect(matchPercent(0)).toBe(100);
    expect(matchPercent(0.103)).toBe(90);
    expect(matchPercent(0.1)).toBe(90);
    expect(matchPercent(1)).toBe(0);
  });

  it('lines up with the matcher bands: auto-accept is 96 % and up, the review band 75 % and up', () => {
    expect(matchPercent(MATCHING_THRESHOLDS.strong)).toBe(96);
    expect(matchPercent(MATCHING_THRESHOLDS.medium)).toBe(75);
    expect(matchStrength(matchPercent(MATCHING_THRESHOLDS.medium))).toBe('Good');
  });

  it('clamps out-of-range and broken distances', () => {
    expect(matchPercent(-0.2)).toBe(100);
    expect(matchPercent(1.4)).toBe(0);
    expect(matchPercent(Number.NaN)).toBe(0);
  });

  it('names the strength: Strong ≥ 90, Good ≥ 75, Weak below', () => {
    expect([90, 89, 75, 74].map(matchStrength)).toEqual(['Strong', 'Good', 'Good', 'Weak']);
  });
});

describe('compareEdition', () => {
  it('agrees field by field for a clean edition, and says nothing about country', () => {
    const rows = compareEdition(album, cand());
    expect(rows.map((r) => [r.field, r.verdict])).toEqual([
      ['album', 'agrees'], ['artist', 'agrees'], ['year', 'agrees'], ['country', 'unknown'], ['tracks', 'agrees'],
    ]);
    expect(rows.find((r) => r.field === 'tracks')).toMatchObject({ disk: '10 tracks', edition: '10 tracks' });
    expect(everyCheckAgrees(rows)).toBe(true);
  });

  it('reads album and artist from the matcher distance with the chip thresholds', () => {
    const rows = compareEdition(album, cand({ breakdown: { album: 0.2, artist: 0.7 } }));
    expect(rows[0]!.verdict).toBe('close');
    expect(rows[1]!.verdict).toBe('differs');
    expect(everyCheckAgrees(rows)).toBe(false);
  });

  it('year: one or two apart is close, further differs, unknown when either side has none', () => {
    expect(compareEdition(album, cand({ date: '2012' }))[2]!.verdict).toBe('close');
    expect(compareEdition(album, cand({ date: '2017-01-01' }))[2]!.verdict).toBe('differs');
    expect(compareEdition(album, cand({ date: null }))[2]!.verdict).toBe('unknown');
    expect(compareEdition({ ...album, year: null }, cand())[2]!.verdict).toBe('unknown');
  });

  it('tracks: other count differs; same count with unpaired tracks is close', () => {
    expect(compareEdition(album, cand({ trackCount: 12 }))[4]!.verdict).toBe('differs');
    expect(compareEdition(album, cand({ breakdown: { ...clean, unmatchedTracks: 0.1 } }))[4]!.verdict).toBe('close');
  });

  it('shows the status tag only when it is not Official', () => {
    expect(statusTag('Official')).toBeNull();
    expect(statusTag(null)).toBeNull();
    expect(statusTag('Promotion')).toBe('Promotion');
  });
});

describe('autoAcceptRulesSchema', () => {
  it('accepts the defaults and rejects out-of-range values', () => {
    expect(autoAcceptRulesSchema.parse(DEFAULT_AUTO_ACCEPT_RULES)).toEqual(DEFAULT_AUTO_ACCEPT_RULES);
    expect(autoAcceptRulesSchema.safeParse({ ...DEFAULT_AUTO_ACCEPT_RULES, minMatch: 40 }).success).toBe(false);
    expect(autoAcceptRulesSchema.safeParse({ ...DEFAULT_AUTO_ACCEPT_RULES, clearWinnerGap: 51 }).success).toBe(false);
    expect(autoAcceptRulesSchema.safeParse({ ...DEFAULT_AUTO_ACCEPT_RULES, preferSource: 'spotify' }).success).toBe(false);
    expect(autoAcceptRulesSchema.safeParse({ ...DEFAULT_AUTO_ACCEPT_RULES, extra: 1 }).success).toBe(false);
  });
});

describe('evaluateAutoAccept', () => {
  it('accepts a lone clean edition above the minimum', () => {
    const d = evaluateAutoAccept(rules(), album, [cand({ distance: 0.03 })]);
    expect(d).toMatchObject({ accept: true, percent: 97 });
    expect(d.accept && d.reason).toBe('97% match, every check agrees, official, only edition (MusicBrainz)');
  });

  it('refuses without editions', () => {
    expect(evaluateAutoAccept(rules(), album, [])).toEqual({ accept: false, reason: 'no editions' });
  });

  it('refuses under the minimum match', () => {
    const d = evaluateAutoAccept(rules({ minMatch: 98 }), album, [cand({ distance: 0.03 })]);
    expect(d).toEqual({ accept: false, reason: 'best edition 97% is under 98%' });
  });

  it('every check agrees: a differing track count blocks it; off, it passes', () => {
    const c = [cand({ distance: 0.03, trackCount: 11 })];
    expect(evaluateAutoAccept(rules(), album, c).accept).toBe(false);
    expect(evaluateAutoAccept(rules({ allChecksAgree: false }), album, c).accept).toBe(true);
  });

  it('official only: skips a promo and takes the official edition behind it when it is clear', () => {
    const promo = cand({ distance: 0.01, status: 'Promotion' });
    const official = cand({ distance: 0.03 });
    // the promo scores 99, the official 97: a 2-point rival blocks a 5-point gap
    expect(evaluateAutoAccept(rules(), album, [promo, official])).toMatchObject({ accept: false });
    const d = evaluateAutoAccept(rules({ clearWinnerGap: 0 }), album, [promo, official]);
    expect(d.accept && d.candidate.id).toBe(official.id);
    // and a Discogs release (no status) is not treated as unofficial
    expect(evaluateAutoAccept(rules(), album, [cand({ provider: 'discogs', status: null })]).accept).toBe(true);
  });

  it('clear winner: the next edition must be the gap behind', () => {
    const a = cand({ distance: 0.02 });
    const b = cand({ distance: 0.05 });
    expect(evaluateAutoAccept(rules({ clearWinnerGap: 5 }), album, [a, b])).toEqual({ accept: false, reason: 'next edition is 3 points behind, under 5' });
    const ok = evaluateAutoAccept(rules({ clearWinnerGap: 3 }), album, [b, a]);
    expect(ok.accept && ok.candidate.id).toBe(a.id);
    expect(ok.accept && ok.reason).toContain('3 points ahead');
  });

  it('prefer source: the same edition on both providers is compared within the preferred one', () => {
    const mb = cand({ distance: 0.02, provider: 'musicbrainz' });
    const dc = cand({ distance: 0.02, provider: 'discogs', status: null });
    expect(evaluateAutoAccept(rules({ preferSource: 'either' }), album, [mb, dc]).accept).toBe(false);
    const viaMb = evaluateAutoAccept(rules({ preferSource: 'musicbrainz' }), album, [dc, mb]);
    expect(viaMb.accept && viaMb.candidate.id).toBe(mb.id);
    const viaDc = evaluateAutoAccept(rules({ preferSource: 'discogs' }), album, [mb, dc]);
    expect(viaDc.accept && viaDc.candidate.id).toBe(dc.id);
    expect(viaDc.accept && viaDc.reason).toContain('(Discogs)');
  });

  it('prefer source falls back to every edition when the preferred one has none that passes', () => {
    const mbBad = cand({ distance: 0.01, provider: 'musicbrainz', trackCount: 14 });
    const dc = cand({ distance: 0.02, provider: 'discogs', status: null });
    // the field is both providers, so the better-scoring MB edition is a rival
    expect(evaluateAutoAccept(rules({ preferSource: 'musicbrainz' }), album, [mbBad, dc])).toMatchObject({ accept: false });
    const d = evaluateAutoAccept(rules({ preferSource: 'musicbrainz', clearWinnerGap: 0 }), album, [mbBad, dc]);
    expect(d.accept && d.candidate.id).toBe(dc.id);
  });

  it('ignores the master switch (the worker checks it; the dry run previews)', () => {
    expect(evaluateAutoAccept({ ...rules(), enabled: false }, album, [cand()]).accept).toBe(true);
  });
});

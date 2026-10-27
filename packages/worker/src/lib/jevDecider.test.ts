/**
 * Jev as a Decider, over a fake fetch: one request per album with one
 * question per group, the dated model and token count passed through, and a
 * group the answer leaves out (or answers without a number) left out of the
 * probabilities, so the decision reads the answer as invalid, not as "no".
 */
import { describe, it, expect } from 'vitest';
import { buildAlbumEvidence, buildCandidateEvidence, buildJevRequest, decideFromProbabilities, groupTracklists, JEV_SPEC, jevSpecHash, type GroupingCandidate } from '@tagave/core';
import { jevDecider } from './jevDecider.js';

const album = buildAlbumEvidence({
  artist: 'Kuunvalo', title: 'Kuunvalo', titleSource: 'tag', year: 2001, yearSource: 'tag', discsKnown: false, discCount: null,
  tracks: ['Ilta', 'Aamu'].map((t, i) => ({ title: t, titleSource: 'tag' as const, duration: 200 + i * 10 })),
});
const cand = (releaseId: string, titles: string[], distance: number): GroupingCandidate => ({
  releaseId, distance,
  evidence: buildCandidateEvidence(
    { source: 'musicbrainz', title: 'Kuunvalo', artists: ['Kuunvalo'], tracks: titles.map((t, i) => ({ title: t, duration: 200 + i * 10 })) },
    { alignment: [0, 1].map((i) => ({ localIndex: i, canonicalIndex: i, distance: 0.01, title: { local: '' }, duration: { local: 0 } })), missingRemote: titles.map((_, i) => i).filter((i) => i > 1) },
    2),
});
const groups = groupTracklists([cand('r1', ['Ilta', 'Aamu'], 0.05), cand('r2', ['Ilta', 'Aamu', 'Lisä'], 0.2)], { discsKnown: false });
const request = buildJevRequest(album, groups, 'jev-latest');

function fakeFetch(answers: Record<string, unknown>) {
  const bodies: any[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: 'jev-2026-09-15', answers, usage: { input_tokens: 1234, output_tokens: 5 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

describe('jevDecider', () => {
  it('asks one question per group and passes the dated model and tokens through', async () => {
    const { f, bodies } = fakeFetch({ is_A: { type: 'noul', noul: 0.97 }, is_B: { type: 'noul', noul: 0.02 } });
    const d = jevDecider({ apiKey: 'test-key', baseUrl: 'http://fake.invalid', fetchImpl: f, maxRetries: 0 });
    expect(d).toMatchObject({ id: 'jev', specHash: jevSpecHash() });
    const a = await d.ask({ album, groups, request }, { model: 'jev-latest' });
    expect(bodies).toHaveLength(1);
    // the request it was given, as it is
    expect(bodies[0]).toEqual(JSON.parse(JSON.stringify(request)));
    expect(bodies[0].model).toBe('jev-latest');
    expect(Object.keys(bodies[0].questions)).toEqual(['is_A', 'is_B']);
    expect(a).toMatchObject({ probabilities: { A: 0.97, B: 0.02 }, model: 'jev-2026-09-15', inputTokens: 1234 });
    expect(a.requestBytes).toBe(new TextEncoder().encode(JSON.stringify(bodies[0])).length);
  });

  it('a group left unanswered is left out, so the answer is no answer', async () => {
    const { f } = fakeFetch({ is_A: { type: 'noul', noul: 0.99 }, is_B: { type: 'noul' } });
    const a = await jevDecider({ apiKey: 'test-key', baseUrl: 'http://fake.invalid', fetchImpl: f, maxRetries: 0 }).ask({ album, groups, request }, { model: 'jev-latest' });
    expect(a.probabilities).toEqual({ A: 0.99 });
    expect(decideFromProbabilities(a.probabilities, JEV_SPEC, { labels: groups.map((g) => g.label) })).toMatchObject({ kind: 'none', reason: 'invalid_answer' });
  });

  it('refuses a request built for another model, sending nothing', async () => {
    const { f, bodies } = fakeFetch({ is_A: { type: 'noul', noul: 0.99 } });
    await expect(jevDecider({ apiKey: 'test-key', baseUrl: 'http://fake.invalid', fetchImpl: f, maxRetries: 0 }).ask({ album, groups, request }, { model: 'jev-2026-09-15' }))
      .rejects.toThrow(/another model/);
    expect(bodies).toHaveLength(0);
  });
});

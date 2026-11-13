import { describe, expect, it } from 'vitest';
import type { AlbumEvidence, CandidateEvidence } from '../matching/evidence.js';
import { NotSendableError } from './jevPayload.js';
import { decideFromProbabilities, jevSpecHash } from './jevSpec.js';
import { LOCAL_DECIDER_ID, localDecider, type LocalPayload } from './localDecider.js';
import { LOCAL_FEATURE_NAMES, featuresSchemaHash, groupFeatures } from './localFeatures.js';
import { calibratedProbability, modelVersion, type LocalModel } from './localModel.js';

const ev = (titles: string[]): CandidateEvidence => ({
  v: 1, tracks: titles.map((title, i) => [1, title, 200 + i * 30]), align: [], unmatchedLocal: [], missingRemote: [], capped: false,
} as unknown as CandidateEvidence);

const album = { v: 1, discsKnown: true, title: 'Album', titleSource: 'tag' } as unknown as AlbumEvidence;

/** A model whose score falls with the distance alone: distance times -40, then a straight calibration. */
function model(): LocalModel {
  const n = LOCAL_FEATURE_NAMES.length;
  return {
    version: 1,
    featuresSchemaHash: featuresSchemaHash(),
    logistic: {
      intercept: 6, coefficients: LOCAL_FEATURE_NAMES.map((nm) => (nm === 'distance' ? -40 : 0)),
      means: new Array(n).fill(0), stds: new Array(n).fill(1), featureNames: LOCAL_FEATURE_NAMES, iterations: 1, converged: true,
    },
    isotonic: { blocks: [{ lo: 0, hi: 0, p: 0.01, weight: 1 }, { lo: 1, hi: 1, p: 0.999, weight: 1 }] },
  } as unknown as LocalModel;
}

const a = ev(['one', 'two', 'three']);
const b = ev(['four', 'five']);
const cands = [
  { releaseId: 'r2', distance: 0.2, acoustidCoverage: null, evidence: a, breakdown: { album: 0.1 }, provider: 'discogs' as const },
  { releaseId: 'r1', distance: 0.02, acoustidCoverage: 0.9, evidence: a, breakdown: { album: 0 }, provider: 'musicbrainz' as const },
  { releaseId: 'r3', distance: 0.6, acoustidCoverage: null, evidence: b, breakdown: '{"album":0.5}', provider: 'musicbrainz' as const },
];

describe('localDecider', () => {
  const m = model();
  const version = modelVersion(m);
  const d = localDecider(m, version);

  it('is free, asks the shared question spec, and is called local', () => {
    expect(d).toMatchObject({ id: LOCAL_DECIDER_ID, billing: 'free', specHash: jevSpecHash() });
  });

  it('builds every tracklist group, sends nothing, and scores what training scores', async () => {
    const built = d.build(album, cands, { model: version });
    expect(built.bytes).toBe(0);
    expect(built.groups.map((g) => g.members.map((x) => x.releaseId))).toEqual([['r1', 'r2'], ['r3']]);
    expect(built.sent).toEqual(built.groups);
    expect(built.labels).toEqual(['A', 'B']);
    expect(built.candidates.map((c) => c.releaseId)).toEqual(['r1', 'r2', 'r3']);
    const rows = (built.payload as LocalPayload).features;
    expect(rows).toEqual(groupFeatures(built.groups, [
      { releaseId: 'r1', distance: 0.02, acoustidCoverage: 0.9, breakdown: { album: 0 }, provider: 'musicbrainz' },
      { releaseId: 'r2', distance: 0.2, acoustidCoverage: null, breakdown: { album: 0.1 }, provider: 'discogs' },
      { releaseId: 'r3', distance: 0.6, acoustidCoverage: null, breakdown: { album: 0.5 }, provider: 'musicbrainz' },
    ]));
    const answer = await d.ask({ album, groups: built.sent, payload: built.payload }, { model: version });
    expect(answer).toMatchObject({ model: version, inputTokens: 0, requestBytes: 0 });
    expect(answer.probabilities['A']).toBe(calibratedProbability(m, rows[0]!.features));
    expect(answer.probabilities['A']!).toBeGreaterThan(answer.probabilities['B']!);
    expect(decideFromProbabilities(answer.probabilities, undefined, { labels: built.labels })).toMatchObject({ kind: 'pick', label: 'A' });
  });

  it('decides nothing for a partial or empty candidate set', () => {
    expect(() => d.build(album, cands, { model: version, partial: true })).toThrow(NotSendableError);
    expect(() => d.build(album, [], { model: version })).toThrow(NotSendableError);
  });

  it('answers only for its own model', async () => {
    const built = d.build(album, cands, { model: version });
    await expect(d.ask({ album, groups: built.sent, payload: built.payload }, { model: 'local@other' })).rejects.toThrow();
  });
});

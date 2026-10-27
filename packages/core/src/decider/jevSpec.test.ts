import { describe, it, expect } from 'vitest';
import { JEV_SPEC, bandOf, decideFromProbabilities, jevSpecHash } from './jevSpec.js';

describe('the Jev question spec', () => {
  it('has a stable hash that covers the margin, the bands and the wording', () => {
    expect(jevSpecHash()).toMatch(/^tagave-tracklist-v1@[0-9a-f]{12}$/);
    expect(jevSpecHash()).toBe(jevSpecHash());
    expect(jevSpecHash({ ...JEV_SPEC, margin: 0.31 } as any)).not.toBe(jevSpecHash());
    expect(jevSpecHash({ ...JEV_SPEC, instructions: JEV_SPEC.instructions + ' ' } as any)).not.toBe(jevSpecHash());
    expect(JEV_SPEC.margin).toBe(0.3);
  });
  it('bands by probability; under the cut-off is no band', () => {
    expect([0.999, 0.99, 0.985, 0.97, 0.96, 0.95, 0.93, 0.9, 0.899].map((p) => bandOf(p))).toEqual(['p99', 'p99', 'p97', 'p97', 'p95', 'p95', 'p90', 'p90', null]);
  });

  it('carries the fixed values', () => {
    expect(JEV_SPEC.cutoff).toBe(0.9);
    expect(JEV_SPEC.bands).toEqual([{ id: 'p99', min: 0.99 }, { id: 'p97', min: 0.97 }, { id: 'p95', min: 0.95 }, { id: 'p90', min: 0.9 }]);
    expect(JEV_SPEC.placeholders).toEqual({ title: 'track {n}', year: 'year unknown' });
    expect(JEV_SPEC.grouping).toEqual({ meanTitleTolerance: 0.15, maxTitleDistance: 0.5, durationToleranceS: 10 });
    expect(JEV_SPEC.stateTemplate).toBe(1);
  });

  it('the hash does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(JEV_SPEC).reverse().map(([k, v]) => [
      k,
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    ]));
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(JEV_SPEC)[0]);
    expect(jevSpecHash(reordered as any)).toBe(jevSpecHash());
  });

  it('the hash changes when any field changes', () => {
    const base = jevSpecHash();
    const variants: Array<Record<string, unknown>> = [
      { cutoff: 0.91 },
      { bands: [{ id: 'p99', min: 0.995 }, ...JEV_SPEC.bands.slice(1)] },
      { grouping: { ...JEV_SPEC.grouping, durationToleranceS: 11 } },
      { grouping: { ...JEV_SPEC.grouping, meanTitleTolerance: 0.2 } },
      { grouping: { ...JEV_SPEC.grouping, maxTitleDistance: 0.6 } },
      { stateTemplate: 2 },
      { placeholders: { ...JEV_SPEC.placeholders, title: 'track #{n}' } },
      { placeholders: { ...JEV_SPEC.placeholders, year: 'unknown year' } },
      { task: JEV_SPEC.task + '.' },
      { criteria: { ...JEV_SPEC.criteria, true: 'yes' } },
      { criteria: { ...JEV_SPEC.criteria, false: 'no' } },
    ];
    const hashes = variants.map((v) => jevSpecHash({ ...JEV_SPEC, ...v } as any));
    for (const h of hashes) expect(h).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
    // id and version name the hash prefix
    expect(jevSpecHash({ ...JEV_SPEC, version: 2 } as any)).toMatch(/^tagave-tracklist-v2@/);
  });

  it('the spec cannot be changed at run time', () => {
    expect(Object.isFrozen(JEV_SPEC)).toBe(true);
    expect(Object.isFrozen(JEV_SPEC.grouping)).toBe(true);
    expect(Object.isFrozen(JEV_SPEC.bands[0])).toBe(true);
  });

  it('no band for a value that is not a probability', () => {
    expect([Number.NaN, Infinity, -Infinity, 1.0001, -0.5].map((p) => bandOf(p))).toEqual([null, null, null, null, null]);
    expect(bandOf(1)).toBe('p99');
  });
});

describe('decideFromProbabilities', () => {
  it('picks the most probable group when it beats the next by the margin and passes the cut-off', () => {
    expect(decideFromProbabilities({ A: 0.995, B: 0.4 })).toEqual({ kind: 'pick', label: 'A', probability: 0.995, margin: 0.595, band: 'p99' });
  });
  it('one group: the margin is to nothing', () => {
    expect(decideFromProbabilities({ A: 0.93 })).toMatchObject({ kind: 'pick', label: 'A', margin: 0.93, band: 'p90' });
  });
  it('a close second is none, even above the cut-off', () => {
    expect(decideFromProbabilities({ A: 0.97, B: 0.68 })).toMatchObject({ kind: 'none', reason: 'margin', label: 'A' });
  });
  it('exactly the margin passes', () => {
    expect(decideFromProbabilities({ A: 0.95, B: 0.65 }).kind).toBe('pick');
  });
  it('under the cut-off is none', () => {
    expect(decideFromProbabilities({ A: 0.89, B: 0.01 })).toMatchObject({ kind: 'none', reason: 'below_cutoff' });
  });
  it('no groups is none', () => {
    expect(decideFromProbabilities({})).toEqual({ kind: 'none', reason: 'no_groups', label: null, probability: null, margin: null });
  });
  it('a tie is none whatever the labels', () => {
    expect(decideFromProbabilities({ B: 0.99, A: 0.99 })).toMatchObject({ kind: 'none', reason: 'margin' });
  });

  it('probabilities are per question, not a distribution: two high answers are allowed', () => {
    expect(decideFromProbabilities({ A: 0.99, B: 0.6, C: 0.2 })).toMatchObject({ kind: 'pick', label: 'A', margin: 0.39 });
  });

  it('the probability is passed through as given, not rounded', () => {
    const d = decideFromProbabilities({ A: 0.987654321 });
    expect(d).toMatchObject({ kind: 'pick', probability: 0.987654321, band: 'p97' });
  });

  describe('an answer that is not a set of probabilities is none, never a pick', () => {
    const invalid = { kind: 'none', reason: 'invalid_answer', label: null, probability: null, margin: null };
    const bad: Array<[string, unknown]> = [
      ['NaN on the top group', { A: Number.NaN, B: 0.1 }],
      ['NaN on another group', { A: 0.99, B: Number.NaN }],
      ['over 1', { A: 1.2, B: 0.1 }],
      ['under 0', { A: 0.99, B: -0.1 }],
      ['infinite', { A: Infinity }],
      ['a string', { A: '0.99' }],
      ['null', { A: null }],
      ['an empty label', { '': 0.99 }],
      ['not an object', null],
      ['an array', [0.99]],
    ];
    for (const [name, probs] of bad) {
      it(name, () => expect(decideFromProbabilities(probs as any)).toEqual(invalid));
    }

    it('a group that was asked about but has no answer', () => {
      expect(decideFromProbabilities({ A: 0.99 }, undefined, { labels: ['A', 'B'] })).toEqual(invalid);
    });
    it('an answer for a group that was not asked about', () => {
      expect(decideFromProbabilities({ A: 0.99, Z: 0.1 }, undefined, { labels: ['A'] })).toEqual(invalid);
    });
    it('every group answered: decides as usual', () => {
      expect(decideFromProbabilities({ B: 0.1, A: 0.99 }, undefined, { labels: ['A', 'B'] })).toMatchObject({ kind: 'pick', label: 'A' });
    });
    it('groups asked but no answers at all is invalid, not no_groups', () => {
      expect(decideFromProbabilities({}, undefined, { labels: ['A'] })).toEqual(invalid);
    });
  });

  it('0 and 1 are valid probabilities', () => {
    expect(decideFromProbabilities({ A: 1, B: 0 })).toEqual({ kind: 'pick', label: 'A', probability: 1, margin: 1, band: 'p99' });
  });
});

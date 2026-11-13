import { describe, expect, it } from 'vitest';
import { provenanceLine, type MatchProvenance } from '@tagave/shared';

const base = { decidedBy: 'system' as const, deciderId: null, deciderVersion: null, probability: null, batch: null, person: null, reason: null };

describe('provenanceLine', () => {
  it.each([
    [{ ...base, decidedKind: 'model', deciderId: 'jev', deciderVersion: 'jev-2026-09-15', probability: 0.994, batch: { id: 'b', createdAt: '2026-10-27T09:00:00Z', startedBy: 'Ada' } }, 'Automatic: Jev 2026-09, probability 0.994, batch of 27 Oct, run by Ada'],
    [{ ...base, decidedKind: 'model', deciderId: 'local', deciderVersion: 'local@0123456789ab', probability: 0.991 }, 'Automatic: Local, probability 0.991'],
    [{ ...base, decidedKind: 'rule', batch: { id: 'b', createdAt: '2026-10-27T09:00:00Z', startedBy: null } }, 'Automatic: your rules, batch of 27 Oct'],
    [{ ...base, decidedKind: 'rule' }, 'Automatic: your rules'],
    [{ ...base, decidedKind: 'system' }, 'Automatic: matcher'],
    [{ ...base, decidedKind: 'user', decidedBy: 'user', person: 'Ada' }, 'By Ada'],
    [{ ...base, decidedKind: 'user', decidedBy: 'user' }, 'By a person'],
    [{ ...base, decidedKind: 'unknown' }, 'Decided before provenance was kept'],
  ])('%#', (p, want) => expect(provenanceLine(p as MatchProvenance, { locale: 'en-GB' })).toBe(want));
});

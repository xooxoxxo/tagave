import { describe, it, expect } from 'vitest';
import { isManualRequest } from './identifyRuns.js';

describe('isManualRequest', () => {
  it('counts the owner marker and pinned ids', () => {
    expect(isManualRequest({ force: true, requestedBy: 'owner' })).toBe(true);
    expect(isManualRequest({ force: true, pinnedMbid: 'x' })).toBe(true); // queued before the marker existed
    expect(isManualRequest({ pinnedReleaseGroup: 'x' })).toBe(true);
    expect(isManualRequest({ pinnedDiscogs: { kind: 'release', id: 1 } })).toBe(true);
  });

  it('does not count the system force:true runs or the sweep', () => {
    expect(isManualRequest({ force: true })).toBe(false); // disc repair
    expect(isManualRequest({ force: true, acoustidMbids: ['m'] } as never)).toBe(false); // fingerprint lookup
    expect(isManualRequest({})).toBe(false); // sweep
  });
});

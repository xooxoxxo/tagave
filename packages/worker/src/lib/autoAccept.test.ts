/** The version a rules batch is stamped with: the rules that decide, not the switch. */
import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTO_ACCEPT_RULES } from '@tagave/shared';
import { rulesVersion } from './autoAccept.js';

describe('rulesVersion', () => {
  it('is rules@ and 8 hex characters', () => {
    expect(rulesVersion(DEFAULT_AUTO_ACCEPT_RULES)).toMatch(/^rules@[0-9a-f]{8}$/);
  });

  it('does not depend on key order or on the master switch', () => {
    const r = DEFAULT_AUTO_ACCEPT_RULES;
    const reordered = {
      officialOnly: r.officialOnly, preferSource: r.preferSource, clearWinnerGap: r.clearWinnerGap,
      allChecksAgree: r.allChecksAgree, minMatch: r.minMatch, enabled: !r.enabled,
    };
    expect(rulesVersion(reordered)).toBe(rulesVersion(r));
  });

  it('changes when any rule changes', () => {
    const base = rulesVersion(DEFAULT_AUTO_ACCEPT_RULES);
    expect(rulesVersion({ ...DEFAULT_AUTO_ACCEPT_RULES, minMatch: 96 })).not.toBe(base);
    expect(rulesVersion({ ...DEFAULT_AUTO_ACCEPT_RULES, officialOnly: false })).not.toBe(base);
    expect(rulesVersion({ ...DEFAULT_AUTO_ACCEPT_RULES, preferSource: 'musicbrainz' })).not.toBe(base);
    expect(rulesVersion({ ...DEFAULT_AUTO_ACCEPT_RULES, allChecksAgree: !DEFAULT_AUTO_ACCEPT_RULES.allChecksAgree })).not.toBe(base);
    expect(rulesVersion({ ...DEFAULT_AUTO_ACCEPT_RULES, clearWinnerGap: DEFAULT_AUTO_ACCEPT_RULES.clearWinnerGap + 1 })).not.toBe(base);
  });
});

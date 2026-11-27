/**
 * packages/db keeps its own copy of the music folder reach values and
 * reasons (it does not depend on @tagave/shared). The api depends on both,
 * so it checks the copies agree.
 */
import { describe, expect, it } from 'vitest';
import { ROOT_REACH_REASONS, ROOT_REACH_VALUES } from '@tagave/db';
import { REACH_REASONS, REACH_VALUES } from '@tagave/shared';

describe('reach copies', () => {
  it('db and shared list the same reach values and reasons', () => {
    expect([...ROOT_REACH_VALUES]).toEqual([...REACH_VALUES]);
    expect([...ROOT_REACH_REASONS]).toEqual([...REACH_REASONS]);
  });
});

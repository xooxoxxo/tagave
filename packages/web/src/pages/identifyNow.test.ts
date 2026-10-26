import { describe, expect, it } from 'vitest';
import { actionProblem } from './identifyNow';

describe('actionProblem', () => {
  it('shows what the server said', () => {
    expect(actionProblem({ status: 500, title: 'Internal Server Error', detail: 'cannot cast type record to uuid[]' }, 'Could not queue the albums.'))
      .toBe('cannot cast type record to uuid[]');
    expect(actionProblem({ status: 502, title: 'Bad Gateway' }, 'Could not queue the albums.')).toBe('Bad Gateway');
  });

  it('falls back when nothing came back', () => {
    expect(actionProblem(new TypeError('Failed to fetch'), 'Could not queue the albums.')).toBe('Could not queue the albums.');
    expect(actionProblem(undefined, 'Could not queue the albums.')).toBe('Could not queue the albums.');
  });
});

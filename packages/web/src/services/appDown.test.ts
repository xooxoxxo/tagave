import { afterEach, describe, expect, it } from 'vitest';
import { DOWN_AFTER, appAnswers, getAppDown, isGoneStatus, noticeTrouble, resetAppDownForTests } from './appDown';

afterEach(() => resetAppDownForTests());

/** A probe that misses `misses` times, then answers. */
function probe(misses: number) {
  let n = 0;
  const seen: boolean[] = [];
  return {
    answers: async () => { n++; return n > misses; },
    sleep: async () => { seen.push(getAppDown().down); },
    seen,
  };
}

describe('the app going down for an update', () => {
  it('takes one miss for a blip: never down', async () => {
    const p = probe(1);
    await noticeTrouble({ answers: p.answers, sleep: p.sleep, newBuild: async () => null });
    expect(p.seen).toEqual([false]);
    expect(getAppDown()).toEqual({ down: false, since: null, switchPending: false });
  });

  it(`is down after ${DOWN_AFTER} misses in a row and lifts on the first answer`, async () => {
    const p = probe(4);
    await noticeTrouble({ answers: p.answers, sleep: p.sleep, newBuild: async () => null, now: () => 1000 });
    expect(p.seen.slice(0, 4)).toEqual([false, true, true, true]);
    expect(getAppDown().down).toBe(false);
    expect(getAppDown().switchPending).toBe(false);
  });

  it('notes a newer build once back, for a switch when nothing plays', async () => {
    const p = probe(3);
    await noticeTrouble({ answers: p.answers, sleep: p.sleep, newBuild: async () => ({ sha: 'abc1234', version: '0.13.0' }) });
    expect(getAppDown()).toMatchObject({ down: false, switchPending: true });
  });

  it('asks no build when the app was never down', async () => {
    let asked = 0;
    await noticeTrouble({ answers: async () => true, sleep: async () => undefined, newBuild: async () => { asked++; return null; } });
    expect(asked).toBe(0);
  });

  it('runs one probe at a time', () => {
    const p = probe(0);
    const a = noticeTrouble({ answers: p.answers, sleep: p.sleep, newBuild: async () => null });
    expect(noticeTrouble()).toBe(a);
    return a;
  });
});

describe('what counts as the app answering', () => {
  const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
  it('any answer from the app, a 401 too; not a gateway error or a refused connection', async () => {
    expect(await appAnswers(answer(200))).toBe(true);
    expect(await appAnswers(answer(401))).toBe(true);
    expect(await appAnswers(answer(503))).toBe(false);
    expect(await appAnswers(answer(502))).toBe(false);
    expect(await appAnswers((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toBe(false);
    expect([500, 502, 503, 504].map(isGoneStatus)).toEqual([false, true, true, true]);
  });
});

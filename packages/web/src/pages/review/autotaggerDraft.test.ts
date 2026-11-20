/**
 * Library care › Autotagger › 1 · Decider, the setup's rules: the draft,
 * the one patch Save sends, a key change that keeps the draft, the price a
 * Jev run needs, the model suggestions, when Save waits, and the API's key
 * error in tagave's words.
 */
import { describe, expect, it } from 'vitest';
import {
  FIELD_ERROR, draftOf, inlinePriceFault, modelSuggestions, patchOf, priceFor, priceNeeded, rebase, saveState, setupError, stillBad,
} from './autotaggerDraft';
import { readFileSync } from 'node:fs';
import { LIBRARY_JEV, LIBRARY_LOCAL, LIBRARY_NO_KEY, MODULE, MODULE_NO_PRICES, MODULE_PRICE_EUR } from '../../stories/autotaggerFixtures';

describe('the setup draft', () => {
  it('the draft reads the saved settings', () => {
    expect(draftOf(LIBRARY_JEV)).toEqual({ decider: 'jev', model: 'jev-latest', monthlyCap: '20', currency: 'USD', maxErrorRate: '1', maxRequestBytes: '' });
    expect(draftOf(LIBRARY_LOCAL).decider).toBe('local');
  });

  it('the form patches only what changed, and names a wrong field', () => {
    const d = draftOf(LIBRARY_JEV);
    expect(d.maxErrorRate).toBe('1');
    expect(patchOf(d, LIBRARY_JEV)).toEqual({ patch: {} });
    expect(patchOf({ ...d, maxErrorRate: '2', monthlyCap: '' }, LIBRARY_JEV)).toEqual({ patch: { maxErrorRate: 0.02, monthlyCap: null } });
    expect(patchOf({ ...d, decider: 'local' }, LIBRARY_JEV)).toEqual({ patch: { decider: 'local' } });
    expect(patchOf({ ...d, currency: 'eu' }, LIBRARY_JEV)).toEqual({ field: 'currency' });
    expect(patchOf({ ...d, maxRequestBytes: '12' }, LIBRARY_JEV)).toEqual({ field: 'maxRequestBytes' });
    expect(FIELD_ERROR.decider).toBe('');
    expect(FIELD_ERROR.currency).toBe('Three letters');
  });

  it('one patch for everything that changed', () => {
    const r = patchOf({ ...draftOf(LIBRARY_LOCAL), decider: 'jev', model: 'jev-2026-09-15', monthlyCap: '30', maxErrorRate: '2' }, LIBRARY_LOCAL);
    expect('patch' in r).toBe(true);
    if (!('patch' in r)) return;
    expect(Object.keys(r.patch).sort()).toEqual(['decider', 'maxErrorRate', 'model', 'monthlyCap']);
    expect(r.patch).toEqual({ decider: 'jev', model: 'jev-2026-09-15', monthlyCap: 30, maxErrorRate: 0.02 });
  });

  it('a key change keeps the draft', () => {
    const after = { ...LIBRARY_LOCAL, keySet: true, config: { ...LIBRARY_LOCAL.config, monthlyCap: 15 } };
    const next = rebase({ ...draftOf(LIBRARY_LOCAL), decider: 'jev', model: 'jev-2026-09-15' }, LIBRARY_LOCAL, after);
    expect(next.decider).toBe('jev');
    expect(next.model).toBe('jev-2026-09-15');
    // a field the person left alone takes the new saved value
    expect(next.monthlyCap).toBe('15');
    expect(rebase(draftOf(LIBRARY_LOCAL), LIBRARY_LOCAL, { ...LIBRARY_LOCAL, keySet: true })).toEqual(draftOf(LIBRARY_LOCAL));
  });
});

describe('prices', () => {
  it("priceFor: the model's own, else Any model, else none", () => {
    expect(priceFor('jev-2026-09-15', MODULE.prices)?.perMillionInput).toBe(0.35);
    expect(priceFor('jev-latest', MODULE.prices)?.model).toBe('*');
    expect(priceFor('jev-latest', MODULE_NO_PRICES.prices)).toBeNull();
  });

  it("Price needed, or the price's other currency", () => {
    const jev = draftOf(LIBRARY_JEV);
    expect(priceNeeded(jev, MODULE_NO_PRICES.prices)).toEqual({ needed: true, value: 'Price needed' });
    expect(priceNeeded({ ...jev, currency: 'USD' }, MODULE_PRICE_EUR.prices)).toEqual({ needed: true, value: 'Price in EUR' });
    expect(priceNeeded({ ...jev, currency: 'eur' }, MODULE_PRICE_EUR.prices)).toEqual({ needed: false });
    expect(priceNeeded(jev, MODULE.prices)).toEqual({ needed: false });
    expect(priceNeeded(draftOf(LIBRARY_LOCAL), MODULE_NO_PRICES.prices)).toEqual({ needed: false });
  });

  it('suggestions: jev-latest first, no Any model, no repeats', () => {
    const prices = [
      ...MODULE.prices,
      { model: 'jev-2026-01-10', perMillionInput: 0.3, currency: 'EUR' },
      { model: 'jev-2026-09-15', perMillionInput: 0.33, currency: 'EUR' },
      { model: 'jev-latest', perMillionInput: 0.5, currency: 'USD' },
    ];
    expect(modelSuggestions(prices)).toEqual(['jev-latest', 'jev-2026-01-10', 'jev-2026-09-15']);
    expect(modelSuggestions([])).toEqual(['jev-latest']);
  });
});

describe('Save', () => {
  it('Save waits for the key', () => {
    expect(saveState(draftOf(LIBRARY_NO_KEY), LIBRARY_NO_KEY)).toEqual({ disabled: true, reason: 'Set the key first' });
    expect(saveState(draftOf(LIBRARY_JEV), LIBRARY_JEV)).toEqual({ disabled: true, reason: null });
    expect(saveState({ ...draftOf(LIBRARY_JEV), monthlyCap: '25' }, LIBRARY_JEV)).toEqual({ disabled: false, reason: null });
    // a wrong field keeps Save enabled: pressing it names the field
    expect(saveState({ ...draftOf(LIBRARY_JEV), currency: 'eu' }, LIBRARY_JEV)).toEqual({ disabled: false, reason: null });
  });

  it("the API's key error in tagave's words", () => {
    expect(setupError('No TypeSafe key')).toBe('Set the key first');
    expect(setupError('module is off')).toBe('Module is off.');
    expect(setupError(null)).toBe('Not saved.');
    expect(setupError('  ')).toBe('Not saved.');
  });
});

describe('the Price row and stale flags', () => {
  const d = draftOf(LIBRARY_JEV);

  it("the Price row's refusal names the field that is wrong, not always the amount", () => {
    expect(inlinePriceFault('0.4', d)).toBeNull();
    expect(inlinePriceFault('0', d)).toBeNull();
    expect(inlinePriceFault('', d)).toBe('amount');
    expect(inlinePriceFault('-1', d)).toBe('amount');
    expect(inlinePriceFault('0.4', { ...d, model: 'Bad Model' })).toBe('model');
    expect(inlinePriceFault('0.4', { ...d, model: '' })).toBe('model');
    expect(inlinePriceFault('0.4', { ...d, currency: 'US' })).toBe('currency');
    expect(inlinePriceFault('0.4', { ...d, currency: 'usd' })).toBeNull();
  });

  it('the setup shows the model and currency faults under their own fields', () => {
    const tsx = readFileSync(new URL('./AutotaggerSetup.tsx', import.meta.url), 'utf8');
    expect(tsx).toMatch(/inlinePriceFault\(inlineAmount, draft\)/);
    expect(tsx).toMatch(/error=\{inlineBad === 'amount' \? '0 or more' : undefined\}/);
    expect(tsx).toMatch(/bad === k \|\| inlineBad === k/);
  });

  it("a flag Save raised goes once its field changes, wherever the change came from", () => {
    expect(stillBad('currency', d, { ...d, model: 'jev-2026-09-15' })).toBe('currency');
    expect(stillBad('currency', d, { ...d, currency: 'EUR' })).toBeNull();
    expect(stillBad(null, d, d)).toBeNull();
    expect(stillBad('model', d, null)).toBeNull();
  });

  it('Saved goes after a key or price action, and a rebase or edit rechecks the flag', () => {
    const tsx = readFileSync(new URL('./AutotaggerPanel.tsx', import.meta.url), 'utf8');
    const body = (name: string) => tsx.slice(tsx.indexOf(`const ${name} = async`), tsx.indexOf('};', tsx.indexOf(`const ${name} = async`)));
    expect(body('onKey')).toContain('setSavedNow(false)');
    expect(body('priceAction')).toContain('setSavedNow(false)');
    expect(tsx).toMatch(/setBad\(stillBad\(bad, draft, next\)\)/);
    expect(tsx).toMatch(/onDraft=\{\(d\) => \{ setBad\(stillBad\(bad, draft, d\)\)/);
  });
});

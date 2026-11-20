/**
 * Library care › Autotagger › 1 · Decider, the setup's rules (pure): the
 * form's text from the saved settings, the one patch Save sends, a draft
 * kept across a key change, the price a Jev run needs, the model
 * suggestions, when Save waits, and the API's errors in tagave's words.
 * Prices are not in the draft: they are their own instant action.
 */
import type { AutotaggerConfigPatch, AutotaggerLibraryView, DeciderChoice, DeciderPrice } from '@tagave/shared';
import { sentence } from '../../components/InAppUpdate';

/** The form's text, from the saved settings. */
export interface SetupDraft {
  decider: DeciderChoice;
  model: string;
  monthlyCap: string;
  currency: string;
  maxErrorRate: string;
  maxRequestBytes: string;
}

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function draftOf(v: AutotaggerLibraryView): SetupDraft {
  const c = v.config;
  return {
    decider: c.decider,
    model: c.model,
    monthlyCap: c.monthlyCap === null ? '' : String(c.monthlyCap),
    currency: c.currency,
    maxErrorRate: String(Math.round(c.maxErrorRate * 1000) / 10),
    maxRequestBytes: c.maxRequestBytes === null ? '' : String(c.maxRequestBytes),
  };
}

/** The patch the draft makes (only what differs from the saved settings), or the field that is wrong. */
export function patchOf(d: SetupDraft, v: AutotaggerLibraryView): { patch: AutotaggerConfigPatch } | { field: keyof SetupDraft } {
  const patch: AutotaggerConfigPatch = {};
  const c = v.config;
  if (d.decider !== c.decider) patch.decider = d.decider;
  const model = d.model.trim();
  if (!MODEL_RE.test(model)) return { field: 'model' };
  if (model !== c.model) patch.model = model;
  const cap = d.monthlyCap.trim() === '' ? null : Number(d.monthlyCap);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 100_000)) return { field: 'monthlyCap' };
  if (cap !== c.monthlyCap) patch.monthlyCap = cap;
  const currency = d.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) return { field: 'currency' };
  if (currency !== c.currency) patch.currency = currency;
  const rate = Number(d.maxErrorRate) / 100;
  if (!Number.isFinite(rate) || rate < 0.001 || rate > 0.2) return { field: 'maxErrorRate' };
  if (Math.abs(rate - c.maxErrorRate) > 1e-9) patch.maxErrorRate = rate;
  const bytes = d.maxRequestBytes.trim() === '' ? null : Number(d.maxRequestBytes);
  if (bytes !== null && (!Number.isInteger(bytes) || bytes < 1024 || bytes > 10_000_000)) return { field: 'maxRequestBytes' };
  if (bytes !== c.maxRequestBytes) patch.maxRequestBytes = bytes;
  return { patch };
}

/** What a wrong field shows under itself. */
export const FIELD_ERROR: Record<keyof SetupDraft, string> = {
  decider: '',
  model: 'a-z, 0-9, . _ -',
  monthlyCap: '0 to 100,000',
  currency: 'Three letters',
  maxErrorRate: '0.1 to 20',
  maxRequestBytes: '1,024 to 10,000,000',
};

const FIELDS = Object.keys(FIELD_ERROR) as Array<keyof SetupDraft>;

/**
 * The draft after the saved settings changed under it (a key Set, Replace
 * or Forget, a Save elsewhere): a field the person changed stays, every
 * other field takes the new saved value.
 */
export function rebase(draft: SetupDraft, before: AutotaggerLibraryView, after: AutotaggerLibraryView): SetupDraft {
  const was = draftOf(before);
  const now = draftOf(after);
  const next = { ...draft };
  for (const k of FIELDS) if (draft[k] === was[k]) (next as Record<keyof SetupDraft, string>)[k] = now[k];
  return next;
}

/** The price a run of `model` pays: the model's own row, else the Any model row, else none. */
export function priceFor(model: string, prices: DeciderPrice[]): DeciderPrice | null {
  return prices.find((p) => p.model === model) ?? prices.find((p) => p.model === '*') ?? null;
}

/** Whether a Jev draft's run would pause for its price: none at all, or one in another currency than the cap's. */
export function priceNeeded(d: SetupDraft, prices: DeciderPrice[]): { needed: false } | { needed: true; value: string } {
  if (d.decider !== 'jev') return { needed: false };
  const price = priceFor(d.model.trim(), prices);
  if (!price) return { needed: true, value: 'Price needed' };
  if (price.currency !== d.currency.trim().toUpperCase()) return { needed: true, value: `Price in ${price.currency}` };
  return { needed: false };
}

/** The Model field's suggestions: `jev-latest` first, then every priced model (not Any model), sorted, once each. */
export function modelSuggestions(prices: DeciderPrice[]): string[] {
  const models = [...new Set(prices.map((p) => p.model).filter((m) => m !== '*' && m !== 'jev-latest'))].sort();
  return ['jev-latest', ...models];
}

/**
 * Save's state: Jev drafted without a stored key waits for the key; a
 * draft equal to the saved settings has nothing to save. A wrong field
 * keeps Save enabled, so pressing it names the field.
 */
export function saveState(d: SetupDraft, v: AutotaggerLibraryView): { disabled: boolean; reason: 'Set the key first' | null } {
  if (d.decider === 'jev' && !v.keySet) return { disabled: true, reason: 'Set the key first' };
  const r = patchOf(d, v);
  if ('patch' in r && Object.keys(r.patch).length === 0) return { disabled: true, reason: null };
  return { disabled: false, reason: null };
}

/** An API error's detail as the setup shows it; the key's 409 in tagave's words. */
export function setupError(detail: string | null | undefined): string {
  if ((detail ?? '').trim() === 'No TypeSafe key') return 'Set the key first';
  return sentence(detail) || 'Not saved.';
}

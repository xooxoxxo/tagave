/**
 * Settings › Modules › Autotagger, under its Off | On (SettingsModulesPage):
 * the library's decider (On this machine / Jev), the TypeSafe key (its hint
 * only), the model, the monthly cap and its currency, the maximum error
 * rate of the spot-check gate, the request limit, what this month cost,
 * the price table, and the agreement of the decider with the owner (the
 * backtest and the review queue, per band). The owner's alone.
 */
import { useEffect, useState } from 'react';
import type { AgreementRow, AgreementView, AutotaggerConfigPatch, AutotaggerLibraryView, AutotaggerModuleView, DeciderChoice, DeciderPrice } from '@tagave/shared';
import { Button, Input, SegmentedControl, TextField } from '../components/ui';
import { useStepUpAction } from '../components/users/useStepUpAction';
import { sentence } from '../components/InAppUpdate';
import { useCurrentLibrary } from '../hooks';
import {
  useAgreement, useAutotaggerLibrary, useAutotaggerModule, useDeleteDeciderPrice, usePatchAutotaggerConfig, useSetAutotaggerKey, useSetDeciderPrice,
} from '../hooks/useAutotagger';
import { Values } from './review/autotaggerParts';
import { BAND_LABEL, count, money } from './review/autotaggerSteps';
import review from './review/autotagger.module.css';
import styles from './SettingsModulesPage.module.css';

const DECIDERS: Array<{ value: DeciderChoice; label: string }> = [
  { value: 'local', label: 'On this machine' },
  { value: 'jev', label: 'Jev' },
];

/** The form's text, from the saved settings. */
export interface ConfigDraft { model: string; monthlyCap: string; currency: string; maxErrorRate: string; maxRequestBytes: string }

export function draftOf(v: AutotaggerLibraryView): ConfigDraft {
  const c = v.config;
  return {
    model: c.model,
    monthlyCap: c.monthlyCap === null ? '' : String(c.monthlyCap),
    currency: c.currency,
    maxErrorRate: String(Math.round(c.maxErrorRate * 1000) / 10),
    maxRequestBytes: c.maxRequestBytes === null ? '' : String(c.maxRequestBytes),
  };
}

/** The patch the draft makes, or the field that is wrong. */
export function patchOf(d: ConfigDraft, v: AutotaggerLibraryView): { patch: AutotaggerConfigPatch } | { field: keyof ConfigDraft } {
  const patch: AutotaggerConfigPatch = {};
  const c = v.config;
  const model = d.model.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)) return { field: 'model' };
  if (model !== c.model) patch.model = model;
  const cap = d.monthlyCap.trim() === '' ? null : Number(d.monthlyCap);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 100_000)) return { field: 'monthlyCap' };
  if (cap !== c.monthlyCap) patch.monthlyCap = cap;
  const currency = d.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { field: 'currency' };
  if (currency !== c.currency) patch.currency = currency;
  const rate = Number(d.maxErrorRate) / 100;
  if (!Number.isFinite(rate) || rate < 0.001 || rate > 0.2) return { field: 'maxErrorRate' };
  if (Math.abs(rate - c.maxErrorRate) > 1e-9) patch.maxErrorRate = rate;
  const bytes = d.maxRequestBytes.trim() === '' ? null : Number(d.maxRequestBytes);
  if (bytes !== null && (!Number.isInteger(bytes) || bytes < 1024 || bytes > 10_000_000)) return { field: 'maxRequestBytes' };
  if (bytes !== c.maxRequestBytes) patch.maxRequestBytes = bytes;
  return { patch };
}

const FIELD_ERROR: Record<keyof ConfigDraft, string> = {
  model: 'a-z, 0-9, . _ -',
  monthlyCap: '0 to 100,000',
  currency: 'Three letters',
  maxErrorRate: '0.1 to 20',
  maxRequestBytes: '1,024 to 10,000,000',
};

function AgreementTable({ label, rows }: { label: string; rows: AgreementRow[] }) {
  return (
    <div className={review.figuresWrap}>
      <table className={review.figures} aria-label={label}>
        <thead><tr><th scope="col">Band</th><th scope="col">Decided</th><th scope="col">Agree</th><th scope="col">Disagree</th><th scope="col">No decision</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.band}>
              <td>{r.band in BAND_LABEL ? BAND_LABEL[r.band as keyof typeof BAND_LABEL] : 'None'}</td>
              <td>{count(r.decided)}</td>
              <td>{count(r.agree)}</td>
              <td>{count(r.disagree)}</td>
              <td>{count(r.noDecision)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface AutotaggerSettingsViewProps {
  module: AutotaggerModuleView;
  library: AutotaggerLibraryView;
  agreement: AgreementView | null;
  onDecider: (d: DeciderChoice) => void;
  onSave: (patch: AutotaggerConfigPatch) => void;
  onKey: (key: string | null) => void;
  onPrice: (price: DeciderPrice) => void;
  onDeletePrice: (model: string) => void;
  pending?: { decider?: boolean; save?: boolean; key?: boolean; price?: boolean };
  error?: string | null;
}

export function AutotaggerSettingsView({ module: m, library: v, agreement, onDecider, onSave, onKey, onPrice, onDeletePrice, pending = {}, error = null }: AutotaggerSettingsViewProps) {
  const [draft, setDraft] = useState<ConfigDraft>(() => draftOf(v));
  const [bad, setBad] = useState<keyof ConfigDraft | null>(null);
  const [key, setKey] = useState('');
  const [price, setPrice] = useState({ model: '*', perMillionInput: '', currency: v.currency });
  useEffect(() => { setDraft(draftOf(v)); setBad(null); }, [v]);
  const set = (k: keyof ConfigDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const save = () => {
    const r = patchOf(draft, v);
    if ('field' in r) { setBad(r.field); return; }
    setBad(null);
    if (Object.keys(r.patch).length > 0) onSave(r.patch);
  };
  const err = (k: keyof ConfigDraft) => (bad === k ? FIELD_ERROR[k] : undefined);
  const perMillion = Number(price.perMillionInput);
  const priceOk = price.perMillionInput.trim() !== '' && Number.isFinite(perMillion) && perMillion >= 0 && /^[A-Z]{3}$/.test(price.currency) && (price.model === '*' || /^[a-z0-9][a-z0-9._-]{0,79}$/.test(price.model));

  return (
    <div className={review.panel}>
      <Values rows={[['Runs', count(m.runs)], ['Decisions', count(m.decisions)], ['Spent this month', money(v.spentThisMonth, v.currency)], ...v.spentOther.map((s) => [`Spent · ${s.currency}`, money(s.amount, s.currency)] as [string, string])]} />

      <section className={review.section} aria-label="Decider">
        <h3 className={review.sectionTitle}>Decider</h3>
        <SegmentedControl
          label="Decider"
          value={v.config.decider}
          onChange={(d) => { if (!pending.decider) onDecider(d); }}
          options={DECIDERS.map((d) => ({ ...d, disabled: d.value === 'jev' && !v.keySet }))}
        />
      </section>

      <section className={review.section} aria-label="Key">
        <h3 className={review.sectionTitle}>Key</h3>
        <Values rows={[['TypeSafe key', v.keySet ? (v.keyHint ? `Set · ••••${v.keyHint}` : 'Set') : 'Not set']]} />
        <div className={review.actions}>
          <Input type="password" autoComplete="off" aria-label={v.keySet ? 'Replace key' : 'Set key'} placeholder={v.keySet ? 'Replace key' : 'Key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <Button size="sm" variant="secondary" loading={!!pending.key} disabled={key.trim().length < 16} onClick={() => { onKey(key.trim()); setKey(''); }}>{v.keySet ? 'Replace' : 'Set'}</Button>
          {v.keySet && <Button size="sm" variant="quiet-danger" onClick={() => onKey(null)}>Forget</Button>}
        </div>
      </section>

      <section className={review.section} aria-label="Limits">
        <h3 className={review.sectionTitle}>Limits</h3>
        <div className={review.values}>
          <TextField label="Model" value={draft.model} onChange={set('model')} error={err('model')} dense />
          <TextField label="Monthly cap" inputMode="decimal" placeholder="No cap" value={draft.monthlyCap} onChange={set('monthlyCap')} error={err('monthlyCap')} dense />
          <TextField label="Currency" maxLength={3} value={draft.currency} onChange={set('currency')} error={err('currency')} dense />
          <TextField label="Maximum error rate · %" inputMode="decimal" value={draft.maxErrorRate} onChange={set('maxErrorRate')} error={err('maxErrorRate')} dense />
          <TextField label="Request limit · bytes" inputMode="numeric" placeholder="Decider’s own" value={draft.maxRequestBytes} onChange={set('maxRequestBytes')} error={err('maxRequestBytes')} dense />
        </div>
        <div className={review.actions}><Button variant="primary" loading={!!pending.save} onClick={save}>Save</Button></div>
      </section>

      <section className={review.section} aria-label="Prices">
        <h3 className={review.sectionTitle}>Prices</h3>
        {m.prices.length === 0 ? <Values rows={[['Prices', 'None']]} /> : (
          <ul className={review.items} aria-label="Prices">
            {m.prices.map((p) => (
              <li key={p.model}>
                <span>{`${p.model === '*' ? 'Any model' : p.model} · ${money(p.perMillionInput, p.currency)} per million input`}</span>
                <Button size="sm" variant="quiet-danger" aria-label={`Remove ${p.model === '*' ? 'any model' : p.model}`} onClick={() => onDeletePrice(p.model)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        <div className={review.values}>
          <TextField dense label="Model · * any" value={price.model} onChange={(e) => setPrice((p) => ({ ...p, model: e.target.value.trim() }))} />
          <TextField dense label="Per million input" inputMode="decimal" value={price.perMillionInput} onChange={(e) => setPrice((p) => ({ ...p, perMillionInput: e.target.value }))} />
          <TextField dense label="Currency" maxLength={3} value={price.currency} onChange={(e) => setPrice((p) => ({ ...p, currency: e.target.value.toUpperCase() }))} />
        </div>
        <div className={review.actions}>
          <Button size="sm" variant="secondary" loading={!!pending.price} disabled={!priceOk} onClick={() => { onPrice({ model: price.model, perMillionInput: perMillion, currency: price.currency }); setPrice((p) => ({ ...p, perMillionInput: '' })); }}>Add price</Button>
        </div>
      </section>

      <section className={review.section} aria-label="Agreement">
        <h3 className={review.sectionTitle}>Agreement</h3>
        {agreement?.backtest ? <><h4 className={review.tracklistHead}>Backtest</h4><AgreementTable label="Backtest" rows={agreement.backtest.rows} /></> : <Values rows={[['Backtest', 'None']]} />}
        {agreement && agreement.queue.length > 0 ? <><h4 className={review.tracklistHead}>Review queue</h4><AgreementTable label="Review queue" rows={agreement.queue} /></> : <Values rows={[['Review queue', 'None']]} />}
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

/** The settings under the module's Off | On, wired to the api (shown while it is on). */
export function SettingsAutotaggerContent() {
  const { libraryId } = useCurrentLibrary();
  const mod = useAutotaggerModule();
  const library = useAutotaggerLibrary(libraryId);
  const agreement = useAgreement(libraryId);
  const patch = usePatchAutotaggerConfig(libraryId);
  const setKey = useSetAutotaggerKey(libraryId);
  const setPrice = useSetDeciderPrice();
  const deletePrice = useDeleteDeciderPrice();
  const { run, dialog } = useStepUpAction();
  const [error, setError] = useState<string | null>(null);
  if (!mod.data || !library.data) return null;
  const act = async (verb: string, fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await run(verb, fn);
    } catch (e) {
      const x = e as { detail?: string; title?: string } | null;
      setError(sentence(x?.detail ?? x?.title) || 'Not saved.');
    }
  };
  return (
    <>
      <AutotaggerSettingsView
        module={mod.data}
        library={library.data}
        agreement={agreement.data ?? null}
        onDecider={(d) => void act('Changing the decider', () => patch.mutateAsync({ decider: d }))}
        onSave={(p) => void act('Saving the autotagger', () => patch.mutateAsync(p))}
        onKey={(k) => void act(k === null ? 'Forgetting the key' : 'Setting the key', () => setKey.mutateAsync(k))}
        onPrice={(p) => void act('Setting a price', () => setPrice.mutateAsync(p))}
        onDeletePrice={(model) => void act('Removing a price', () => deletePrice.mutateAsync(model))}
        pending={{ decider: patch.isPending, save: patch.isPending, key: setKey.isPending, price: setPrice.isPending }}
        error={error}
      />
      {dialog}
    </>
  );
}

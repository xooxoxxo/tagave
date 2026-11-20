/**
 * Library care › Autotagger › 1 · Decider, the owner's setup, in the order
 * it is filled: the decider (a draft until Save), its block (the local
 * model with Train, or Jev with its key first, model, cap and currency,
 * spend and payload, and the price a run needs when it has none), the
 * spot-check gate, Advanced (request limit, prices), one Save. The key and
 * prices are their own actions, never Save's. A pure view: the draft and
 * Advanced's open state come in as props; only the key and the new price
 * being typed live here (a secret leaves only through `onKey`).
 */
import { useId, useState, type ReactNode } from 'react';
import type { AutotaggerLibraryView, AutotaggerModuleView, DeciderChoice, DeciderPrice, LocalModelsView, PayloadPreview } from '@tagave/shared';
import { Button, Collapse, Input, SegmentedControl, SettingsGroup, SettingsRow } from '../../components/ui';
import { LocalModelBlock } from './DeciderPanel';
import { PayloadPreviewView } from './PayloadPreview';
import { FIELD_ERROR, inlinePriceFault, modelSuggestions, priceNeeded, saveState, type SetupDraft } from './autotaggerDraft';
import { money } from './autotaggerSteps';
import styles from './autotagger.module.css';

const DECIDERS: Array<{ value: DeciderChoice; label: string }> = [
  { value: 'local', label: 'On this machine · Free' },
  { value: 'jev', label: 'Jev · Paid' },
];

export interface AutotaggerSetupViewProps {
  library: AutotaggerLibraryView;
  module: AutotaggerModuleView;
  models: LocalModelsView | null;
  draft: SetupDraft;
  onDraft: (d: SetupDraft) => void;
  /** the field Save found wrong */
  bad?: keyof SetupDraft | null;
  onSave: () => void;
  onKey: (key: string | null) => void;
  onPrice: (p: DeciderPrice) => void;
  onDeletePrice: (model: string) => void;
  onTrain: () => void;
  preview?: PayloadPreview | null;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  onSeen?: () => void;
  advancedOpen: boolean;
  onAdvanced: (open: boolean) => void;
  pending?: { save?: boolean; key?: boolean; price?: boolean; train?: boolean; seen?: boolean };
  /** beside Save, e.g. "✓ Saved" */
  status?: ReactNode;
  error?: string | null;
}

const PRICE_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const priceName = (model: string) => (model === '*' ? 'Any model' : model);

/** A typed per-million price, or null when it is not one. */
function amountOf(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** A wrong field's error, under it in its row. */
function FieldError({ id, error }: { id: string; error: string | undefined }) {
  return error ? <span id={id} className={styles.fieldError}>{error}</span> : null;
}

export function AutotaggerSetupView({
  library: v, module: m, models, draft, onDraft, bad = null, onSave, onKey, onPrice, onDeletePrice, onTrain,
  preview = null, previewOpen = false, onTogglePreview, onSeen, advancedOpen, onAdvanced, pending = {}, status = null, error = null,
}: AutotaggerSetupViewProps) {
  const id = useId();
  const [key, setKey] = useState('');
  const [inlineAmount, setInlineAmount] = useState('');
  // the Price row's refusal, with the values it refused: it clears once any of them changes
  const [inlineFault, setInlineFault] = useState<{ field: 'model' | 'currency' | 'amount'; amount: string; model: string; currency: string } | null>(null);
  const [add, setAdd] = useState({ model: '', perMillionInput: '', currency: v.currency });
  const [addBad, setAddBad] = useState<'model' | 'perMillionInput' | 'currency' | null>(null);

  const inlineBad = inlineFault && inlineFault.amount === inlineAmount && inlineFault.model === draft.model && inlineFault.currency === draft.currency
    ? inlineFault.field
    : null;
  const set = (k: keyof SetupDraft) => (e: { target: { value: string } }) => onDraft({ ...draft, [k]: e.target.value });
  const flagged = (k: keyof SetupDraft) => bad === k || inlineBad === k;
  const err = (k: keyof SetupDraft) => (flagged(k) ? FIELD_ERROR[k] : undefined);
  const errId = (k: string) => `${id}-${k}-error`;
  const invalid = (k: keyof SetupDraft) => (flagged(k) ? { 'aria-invalid': true, 'aria-describedby': errId(k) } : {});

  const save = saveState(draft, v);
  const need = priceNeeded(draft, m.prices);
  const draftModel = draft.model.trim();
  const draftCurrency = draft.currency.trim().toUpperCase();
  const seen = !!v.config.payloadSeenAt;
  const listId = `${id}-models`;
  const advancedId = `${id}-advanced`;

  const addInline = () => {
    const field = inlinePriceFault(inlineAmount, draft);
    const amount = amountOf(inlineAmount);
    if (field || amount === null) {
      setInlineFault({ field: field ?? 'amount', amount: inlineAmount, model: draft.model, currency: draft.currency });
      return;
    }
    setInlineFault(null);
    onPrice({ model: draftModel, perMillionInput: amount, currency: draftCurrency });
    setInlineAmount('');
  };
  const addPrice = () => {
    const model = add.model.trim() === '' ? '*' : add.model.trim();
    const amount = amountOf(add.perMillionInput);
    const currency = add.currency.trim().toUpperCase();
    if (model !== '*' && !PRICE_MODEL_RE.test(model)) { setAddBad('model'); return; }
    if (amount === null) { setAddBad('perMillionInput'); return; }
    if (!/^[A-Z]{3}$/.test(currency)) { setAddBad('currency'); return; }
    setAddBad(null);
    onPrice({ model, perMillionInput: amount, currency });
    setAdd((a) => ({ ...a, model: '', perMillionInput: '' }));
  };

  return (
    <div className={styles.setup}>
      <SettingsGroup title="Decider">
        <SettingsRow as="div" label="Decider">
          <span className={styles.choice}>
            <SegmentedControl label="Decider" value={draft.decider} onChange={(d) => onDraft({ ...draft, decider: d })} options={DECIDERS} />
          </span>
        </SettingsRow>
      </SettingsGroup>

      {draft.decider === 'local' ? (
        <SettingsGroup
          title="On this machine"
          after={(
            <div className={styles.section}>
              <LocalModelBlock models={models} />
              <div className={styles.actions}>
                <Button size="sm" variant="secondary" loading={!!pending.train} onClick={onTrain}>{models?.active ? 'Train again' : 'Train'}</Button>
              </div>
            </div>
          )}
        />
      ) : (
        <SettingsGroup title="Jev" after={previewOpen && preview && v.keySet ? <PayloadPreviewView preview={preview} /> : null}>
          <SettingsRow as="div" label="Jev key">
            <span className={styles.inlineRow}>
              <span className={styles.rowValue}>{v.keySet ? (v.keyHint ? `Set · ••••${v.keyHint}` : 'Set') : 'Not set'}</span>
              <Input
                dense
                className={styles.wide}
                type="password"
                autoComplete="off"
                aria-label={v.keySet ? 'Replace key' : 'Jev key'}
                placeholder={v.keySet ? 'Replace key' : 'Set the key first'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button size="sm" variant="secondary" loading={!!pending.key} disabled={key.trim().length < 16} onClick={() => { onKey(key.trim()); setKey(''); }}>{v.keySet ? 'Replace' : 'Set'}</Button>
              {v.keySet && <Button size="sm" variant="quiet-danger" disabled={!!pending.key} onClick={() => onKey(null)}>Forget</Button>}
            </span>
          </SettingsRow>
          <SettingsRow label="Model">
            <span className={styles.inlineRow}>
              <Input dense className={styles.wide} aria-label="Model" list={listId} autoComplete="off" spellCheck={false} value={draft.model} onChange={set('model')} {...invalid('model')} />
              <datalist id={listId}>{modelSuggestions(m.prices).map((s) => <option key={s} value={s} />)}</datalist>
              <FieldError id={errId('model')} error={err('model')} />
            </span>
          </SettingsRow>
          {need.needed && (
            <SettingsRow as="div" label="Price">
              <span className={styles.inlineRow}>
                <span className={styles.rowValue}>{need.value}</span>
                <Input
                  dense
                  aria-label="Per million input"
                  inputMode="decimal"
                  value={inlineAmount}
                  onChange={(e) => setInlineAmount(e.target.value)}
                  {...(inlineBad === 'amount' ? { 'aria-invalid': true, 'aria-describedby': errId('inline-price') } : {})}
                />
                <span className={styles.suffix}>{draftCurrency}</span>
                <Button size="sm" variant="secondary" loading={!!pending.price} onClick={addInline}>Add price</Button>
                <FieldError id={errId('inline-price')} error={inlineBad === 'amount' ? '0 or more' : undefined} />
              </span>
            </SettingsRow>
          )}
          <SettingsRow as="div" label="Monthly cap">
            <span className={styles.inlineRow}>
              <span className={styles.pair}>
                <Input dense aria-label="Monthly cap" inputMode="decimal" placeholder="No cap" value={draft.monthlyCap} onChange={set('monthlyCap')} {...invalid('monthlyCap')} />
                <Input dense className={styles.short} aria-label="Currency" maxLength={3} autoComplete="off" value={draft.currency} onChange={set('currency')} {...invalid('currency')} />
              </span>
              <FieldError id={errId('monthlyCap')} error={err('monthlyCap')} />
              <FieldError id={errId('currency')} error={err('currency')} />
            </span>
          </SettingsRow>
          <SettingsRow as="div" label="Spent this month" value={<span className={styles.rowValue}>{money(v.spentThisMonth, v.currency)}</span>} />
          {v.spentOther.map((s) => (
            <SettingsRow key={s.currency} as="div" label={`Spent · ${s.currency}`} value={<span className={styles.rowValue}>{money(s.amount, s.currency)}</span>} />
          ))}
          <SettingsRow as="div" label="Payload">
            <span className={styles.inlineRow}>
              <span className={styles.rowValue}>{seen ? 'Seen' : 'Not seen'}</span>
              {v.keySet && <Button size="sm" variant="secondary" aria-expanded={previewOpen} onClick={onTogglePreview}>Payload</Button>}
              {v.keySet && previewOpen && preview && (
                <Button size="sm" variant={seen ? 'secondary' : 'primary'} loading={!!pending.seen} disabled={seen} onClick={onSeen}>{seen ? 'Seen ✓' : 'Seen'}</Button>
              )}
            </span>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title="Spot-check gate">
        <SettingsRow label="Spot-check gate">
          <span className={styles.inlineRow}>
            <Input dense className={styles.short} aria-label="Spot-check gate" inputMode="decimal" value={draft.maxErrorRate} onChange={set('maxErrorRate')} {...invalid('maxErrorRate')} />
            <span className={styles.suffix}>%</span>
            <FieldError id={errId('maxErrorRate')} error={err('maxErrorRate')} />
          </span>
        </SettingsRow>
      </SettingsGroup>

      <div className={styles.advanced}>
        <Button size="sm" variant="quiet" aria-expanded={advancedOpen} aria-controls={advancedId} onClick={() => onAdvanced(!advancedOpen)}>Advanced</Button>
        <Collapse id={advancedId} open={advancedOpen}>
          <div className={styles.advancedBody}>
            <SettingsGroup title="Requests">
              <SettingsRow label="Request limit">
                <span className={styles.inlineRow}>
                  <Input dense aria-label="Request limit" inputMode="numeric" placeholder="Decider’s own" value={draft.maxRequestBytes} onChange={set('maxRequestBytes')} {...invalid('maxRequestBytes')} />
                  <span className={styles.suffix}>bytes</span>
                  <FieldError id={errId('maxRequestBytes')} error={err('maxRequestBytes')} />
                </span>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Prices">
              {m.prices.length === 0 && <SettingsRow as="div" label="Prices" value={<span className={styles.rowValue}>None</span>} />}
              {m.prices.map((p) => (
                <SettingsRow key={p.model} as="div" label={`${priceName(p.model)} · ${money(p.perMillionInput, p.currency)} per million input`}>
                  <Button size="sm" variant="quiet-danger" aria-label={`Remove ${p.model === '*' ? 'any model' : p.model}`} disabled={!!pending.price} onClick={() => onDeletePrice(p.model)}>Remove</Button>
                </SettingsRow>
              ))}
              <SettingsRow as="div" label="New price">
                <span className={styles.inlineRow}>
                  <Input
                    dense
                    aria-label="Model"
                    placeholder="Any model"
                    list={listId}
                    autoComplete="off"
                    spellCheck={false}
                    value={add.model}
                    onChange={(e) => setAdd((a) => ({ ...a, model: e.target.value }))}
                    {...(addBad === 'model' ? { 'aria-invalid': true, 'aria-describedby': errId('add') } : {})}
                  />
                  <Input
                    dense
                    aria-label="Per million input"
                    inputMode="decimal"
                    value={add.perMillionInput}
                    onChange={(e) => setAdd((a) => ({ ...a, perMillionInput: e.target.value }))}
                    {...(addBad === 'perMillionInput' ? { 'aria-invalid': true, 'aria-describedby': errId('add') } : {})}
                  />
                  <Input
                    dense
                    className={styles.short}
                    aria-label="Currency"
                    maxLength={3}
                    autoComplete="off"
                    value={add.currency}
                    onChange={(e) => setAdd((a) => ({ ...a, currency: e.target.value.toUpperCase() }))}
                    {...(addBad === 'currency' ? { 'aria-invalid': true, 'aria-describedby': errId('add') } : {})}
                  />
                  <Button size="sm" variant="secondary" loading={!!pending.price} onClick={addPrice}>Add price</Button>
                  <FieldError id={errId('add')} error={addBad === 'model' ? FIELD_ERROR.model : addBad === 'currency' ? FIELD_ERROR.currency : addBad ? '0 or more' : undefined} />
                </span>
              </SettingsRow>
            </SettingsGroup>
          </div>
        </Collapse>
      </div>

      <div className={styles.actions}>
        <Button variant="primary" loading={!!pending.save} disabled={save.disabled} onClick={onSave}>Save</Button>
        {save.reason && <span className={styles.muted}>{save.reason}</span>}
        {status}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

/**
 * Library care › Autotagger › 1 · Decider as the owner fills it: the
 * decider, its block (the local model, or Jev key first), the spot-check
 * gate, Advanced, one Save. A pure view: the draft comes in as a prop.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AutotaggerLibraryView } from '@tagave/shared';
import { AutotaggerSetupView, type AutotaggerSetupViewProps } from './AutotaggerSetup';
import { draftOf } from './autotaggerDraft';
import {
  LIBRARY_JEV, LIBRARY_LOCAL, LIBRARY_NO_KEY, LIBRARY_NOT_SEEN, MODELS, MODULE, MODULE_NO_PRICES, PAYLOAD,
} from '../../stories/autotaggerFixtures';

const noop = () => undefined;
/** the <button> whose label is `label` (its markup), or '' */
const button = (html: string, label: string) => {
  for (const m of html.matchAll(/<button[^>]*>(.*?)<\/button>/g)) {
    const text = m[1]!.replace(/<[^>]+>/g, '');
    if (text === label || text.startsWith(label)) return m[0];
  }
  return '';
};

const view = (p: Partial<AutotaggerSetupViewProps> & { library?: AutotaggerLibraryView } = {}) => {
  const library = p.library ?? LIBRARY_JEV;
  return renderToStaticMarkup(
    <AutotaggerSetupView
      library={library}
      module={MODULE}
      models={MODELS}
      draft={draftOf(library)}
      onDraft={noop}
      onSave={noop}
      onKey={noop}
      onPrice={noop}
      onDeletePrice={noop}
      onTrain={noop}
      advancedOpen={false}
      onAdvanced={noop}
      {...p}
    />,
  );
};
const jevOver = (library: AutotaggerLibraryView) => ({ library, draft: { ...draftOf(library), decider: 'jev' as const } });

describe('the setup form', () => {
  it('spec order', () => {
    const html = view();
    const at = [html.indexOf('aria-label="Decider"'), html.indexOf('aria-label="Jev"'), html.indexOf('aria-label="Spot-check gate"'), html.indexOf('>Advanced<'), html.indexOf(button(html, 'Save'))];
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('two choices, always selectable', () => {
    const html = view({ library: LIBRARY_NO_KEY });
    expect(html).toContain('On this machine · Free');
    expect(html).toContain('Jev · Paid');
    // the Decider is the form's only radio group
    expect(html.match(/role="radiogroup"/g)).toHaveLength(1);
    const inputs = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(2);
    for (const i of inputs) expect(i).not.toMatch(/disabled/);
  });

  it('the draft picks the block', () => {
    const local = view({ library: LIBRARY_LOCAL });
    expect(local).toContain('aria-label="On this machine"');
    expect(button(local, 'Train again')).not.toBe('');
    expect(local).not.toContain('Jev key');
    const jev = view(jevOver(LIBRARY_LOCAL));
    expect(jev).toContain('Jev key');
    expect(button(jev, 'Train')).toBe('');
    expect(jev).not.toContain('aria-label="On this machine"');
  });

  it('the Jev block, key first', () => {
    const html = view();
    const at = ['Jev key', 'Model', 'Monthly cap', 'Spent this month', 'Payload'].map((s) => html.indexOf(s));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('the key by its hint, Replace and Forget', () => {
    const set = view();
    expect(set).toContain('Set · ••••9f2c');
    expect(button(set, 'Replace')).not.toBe('');
    expect(button(set, 'Forget')).not.toBe('');
    const none = view({ library: LIBRARY_NO_KEY });
    expect(none).toContain('Not set');
    expect(button(none, 'Set')).not.toBe('');
    expect(button(none, 'Forget')).toBe('');
    expect(none).toContain('placeholder="Set the key first"');
  });

  it('no key with Jev drafted: Save waits', () => {
    const html = view(jevOver(LIBRARY_LOCAL));
    const save = button(html, 'Save');
    expect(save).toMatch(/disabled/);
    const after = html.slice(html.indexOf(save) + save.length);
    expect(after).toMatch(/^[^<]*<span[^>]*>Set the key first<\/span>/);
  });

  it('Model suggests the priced models and jev-latest', () => {
    const html = view();
    const id = /<datalist id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    const list = html.slice(html.indexOf(`<datalist id="${id}"`), html.indexOf('</datalist>'));
    expect(list).toContain('<option value="jev-latest"');
    expect(list).toContain('<option value="jev-2026-09-15"');
    expect(list).not.toContain('<option value="*"');
    expect(/<input[^>]*aria-label="Model"[^>]*>/.exec(html)?.[0]).toContain(`list="${id}"`);
  });

  it('the cap and its currency in one row', () => {
    const html = view();
    const row = html.slice(html.indexOf('Monthly cap'), html.indexOf('Spent this month'));
    expect(row).toMatch(/<input[^>]*aria-label="Monthly cap"/);
    expect(row).toContain('aria-label="Currency"');
    // one item for the amount and its currency, so a phone never splits them
    expect(row).toMatch(/<span class="[^"]*pair[^"]*"><input[^>]*aria-label="Monthly cap"[^>]*><input[^>]*aria-label="Currency"[^>]*><\/span>/);
  });

  it('on a phone the labels keep one line and the choices sit under the Decider label', () => {
    const css = readFileSync(new URL('./autotagger.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.inlineRow \{[^}]*flex: 1 1 0;/);
    expect(css).toMatch(/\.choice label \{ white-space: nowrap; \}/);
    expect(css).toMatch(/\.setup :has\(> \.choice\) \{ flex-wrap: wrap;/);
    expect(view()).toMatch(/<span class="[^"]*choice[^"]*"><div[^>]*role="radiogroup"/);
  });

  it('Price needed sits in the Jev block', () => {
    const html = view({ module: MODULE_NO_PRICES });
    const advanced = html.indexOf('>Advanced<');
    expect(html.indexOf('Price needed')).toBeGreaterThan(-1);
    expect(html.indexOf('Price needed')).toBeLessThan(advanced);
    const add = button(html, 'Add price');
    expect(add).not.toBe('');
    expect(html.indexOf(add)).toBeLessThan(advanced);
    expect(view()).not.toContain('Price needed');
  });

  it("prices are their own action, not Save's", () => {
    const html = view({ module: MODULE_NO_PRICES });
    const add = button(html, 'Add price');
    expect(add).toContain('type="button"');
    expect(add).not.toMatch(/disabled/);
    expect(button(html, 'Save')).toMatch(/disabled/);
    const open = view({ advancedOpen: true });
    expect(button(open, 'Remove')).toContain('type="button"');
    // SetupDraft has no price field
    expect(Object.keys(draftOf(LIBRARY_JEV)).sort()).toEqual(['currency', 'decider', 'maxErrorRate', 'maxRequestBytes', 'model', 'monthlyCap']);
  });

  it('Advanced starts closed', () => {
    const closed = view();
    expect(button(closed, 'Advanced')).toContain('aria-expanded="false"');
    expect(closed).not.toContain('Request limit');
    const open = view({ advancedOpen: true });
    expect(button(open, 'Advanced')).toContain('aria-expanded="true"');
    expect(open).toContain('Request limit');
    expect(open).toContain('bytes');
    expect(open).toContain('Any model · $0.40 per million input');
    expect(button(open, 'Remove')).not.toBe('');
  });

  it('copy', () => {
    for (const html of [view({ advancedOpen: true }), view({ library: LIBRARY_LOCAL, advancedOpen: true }), view({ module: MODULE_NO_PRICES, advancedOpen: true })]) {
      for (const bad of ['TypeSafe', 'Maximum error rate', 'Max error rate', '* any', '· bytes', '—']) expect(html).not.toContain(bad);
    }
    const html = view({ advancedOpen: true });
    for (const good of ['Jev key', 'Spot-check gate', 'Request limit', 'Any model']) expect(html).toContain(good);
  });

  it('the gate row and its input are both Spot-check gate', () => {
    const html = view();
    const group = html.slice(html.indexOf('aria-label="Spot-check gate"'), html.indexOf('>Advanced<'));
    expect(group).toMatch(/<input[^>]*aria-label="Spot-check gate"/);
    // the group's name, the row's label and the input's
    expect(group.match(/Spot-check gate/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('Payload and Seen need a key', () => {
    const html = view({ library: LIBRARY_NOT_SEEN, previewOpen: true, preview: PAYLOAD });
    expect(button(html, 'Hide')).not.toBe('');
    expect(button(html, 'Seen')).not.toBe('');
    expect(html).toContain('aria-label="Request"');
    const none = view({ library: LIBRARY_NO_KEY, previewOpen: true, preview: PAYLOAD });
    expect(button(none, 'Hide')).toBe('');
    expect(button(none, 'Seen')).toBe('');
  });

  it('a wrong field names itself, the error shows as an alert', () => {
    const html = view({ bad: 'currency', error: 'Set the key first', state: 'saved' });
    expect(html).toContain('Three letters');
    expect(/<input[^>]*aria-label="Currency"[^>]*>/.exec(html)?.[0]).toContain('aria-invalid="true"');
    expect(html).toMatch(/role="alert"[^>]*>Set the key first</);
    expect(html).toContain('✓ Saved');
  });
});

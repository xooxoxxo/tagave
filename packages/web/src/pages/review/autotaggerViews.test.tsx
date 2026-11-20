/**
 * Library care › Autotagger (layout B · Steps), as pure views: the gate per
 * band, the accept dialog, the run step (paused, waiting for the payload,
 * the owner's run stats), the decider step (the owner's setup, an editor's
 * read view), the spot-check card and its keys, Agreement under the gates,
 * the batches, the step strip, and the provenance line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { BandTableView, GatesPanelView } from './BandTable';
import { AcceptBandDialogView } from './AcceptBandDialog';
import { DeciderStepView, RunStepView, StepStripView } from './DeciderPanel';
import { SpotCheckCardView, handleVerdictKey } from './SpotCheckView';
import { BatchListView, canUndo } from './BatchList';
import { AutotaggerView, type AutotaggerViewProps } from './AutotaggerPanel';
import { defaultStep, deciderReady, gateLabel, stepTiles, verdictForKey } from './autotaggerSteps';
import { ProvenanceLine } from '../../components/ProvenanceLine';
import {
  ACCEPT_PREVIEW, AGREEMENT, BANDS, BANDS_CLOSED, BATCH_ACCEPTED, BATCH_DETAIL, BATCH_UNDONE, CHECK, CHECK_STALE, HAND_MATCH, LIBRARY_JEV, LIBRARY_LOCAL,
  LIBRARY_NO_KEY, LIBRARY_NOT_SEEN, MODEL_MATCH, MODELS, MODULE, NO_MODELS, RULE_MATCH, RUN_DONE, RUN_RUNNING, runPaused,
} from '../../stories/autotaggerFixtures';

const render = (el: ReactElement) => renderToStaticMarkup(el);
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const noop = () => undefined;
/** the <button> whose label is `label` (its markup), or '' */
const button = (html: string, label: string) => {
  for (const m of html.matchAll(/<button[^>]*>(.*?)<\/button>/g)) {
    const text = m[1]!.replace(/<[^>]+>/g, '');
    if (text === label || text.startsWith(label)) return m[0];
  }
  return '';
};

const P99 = BANDS[0]!;
const P99_OPEN = P99;

/** the whole tab: the owner, a done run, the spot check of the 97% band */
const TAB: AutotaggerViewProps = {
  owner: true, library: LIBRARY_LOCAL, models: MODELS, run: RUN_DONE, runs: [RUN_DONE], bands: BANDS, band: 'p97', onBand: noop, check: CHECK,
  step: null, onStep: noop, history: false, onHistory: noop, population: 'needs_review', onPopulation: noop, batches: [], onAcceptBand: noop,
  onConfirmAccept: noop, onCancelAccept: noop, onRun: noop, onResume: noop, onCancel: noop, onTrain: noop, onVerdict: noop, onDraw: noop, onUndo: noop, onPickRun: noop,
  agreement: null,
};

describe('the gate per band', () => {
  it('a closed gate shows how many checks are still needed and no accept button', () => {
    const html = render(<BandTableView rows={[{ ...P99, checked: 298, allowed: false, stillNeeded: 1 }]} onDraw={noop} onAccept={noop} canAccept />);
    expect(html).toContain('Needs 1 more');
    expect(button(html, 'Accept band')).toBe('');
    expect(button(html, 'Check 25')).not.toBe('');
  });

  it('an open gate offers Accept band to the owner only', () => {
    expect(button(render(<BandTableView rows={[P99_OPEN]} onDraw={noop} onAccept={noop} canAccept />), 'Accept band')).not.toBe('');
    expect(button(render(<BandTableView rows={[P99_OPEN]} onDraw={noop} onAccept={noop} canAccept={false} />), 'Accept band')).toBe('');
  });

  it('labels: Open, Needs <n> more, — before any check, Closed when it cannot be reached', () => {
    expect(gateLabel(P99).label).toBe('Open');
    expect(gateLabel(BANDS[1]!).label).toBe('Needs 360 more');
    expect(gateLabel(BANDS[2]!).label).toBe('—');
    expect(gateLabel({ ...BANDS[1]!, stillNeeded: null }).label).toBe('Closed');
  });

  it('the gates panel offers Go to Accept with the open albums, to the owner', () => {
    const html = render(<GatesPanelView rows={BANDS} maxErrorRate={0.01} canAccept onGoToAccept={noop} />);
    expect(html).toContain('Gates · limit 1.0%');
    expect(button(html, 'Go to Accept · 1,204 albums')).not.toBe('');
    expect(button(render(<GatesPanelView rows={BANDS} maxErrorRate={0.01} canAccept={false} onGoToAccept={noop} />), 'Go to Accept')).toBe('');
    expect(button(render(<GatesPanelView rows={BANDS_CLOSED} maxErrorRate={0.01} canAccept onGoToAccept={noop} />), 'Go to Accept')).toBe('');
  });
});

describe('the accept dialog', () => {
  it('lists what cannot be undone, the counts and the nights', () => {
    const html = render(<AcceptBandDialogView preview={ACCEPT_PREVIEW} onConfirm={noop} onCancel={noop} onDrainFaster={noop} />);
    for (const l of ACCEPT_PREVIEW.cannotUndo) expect(html).toContain(l);
    expect(html).toContain('Cannot be undone');
    expect(html).toContain('about 2 nights');
    expect(button(html, 'Drain faster')).not.toBe('');
    expect(button(html, 'Accept 1,203 albums')).not.toMatch(/disabled/);
  });

  it('no Drain faster at the fastest pace; no confirm while the gate is shut', () => {
    const html = render(<AcceptBandDialogView preview={{ ...ACCEPT_PREVIEW, gate: { upper: 0.02, allowed: false, stillNeeded: 40 } }} onConfirm={noop} onCancel={noop} />);
    expect(button(html, 'Drain faster')).toBe('');
    expect(button(html, 'Accept 1,203 albums')).toMatch(/disabled/);
  });
});

describe('the run step', () => {
  const handlers = { owner: true, population: 'needs_review' as const, onPopulation: noop, onRun: noop, onResume: noop, onCancel: noop };

  it('a paused run says why, as a label', () => {
    const html = render(<RunStepView run={runPaused('cap_reached')} ready={{ ready: true, blocker: null }} {...handlers} />);
    expect(html).toContain('Cap reached');
    expect(button(html, 'Resume')).not.toBe('');
  });

  it.each([['module_off', 'Module off'], ['no_key', 'No key'], ['no_cap', 'No cap'], ['no_price', 'No price'], ['key_refused', 'Key refused'], ['spec_changed', 'Question changed']])(
    'pause %s reads %s', (reason, label) => {
      expect(render(<RunStepView run={runPaused(reason)} ready={{ ready: true, blocker: null }} {...handlers} />)).toContain(label);
    },
  );

  it('the run button waits for the payload to be seen', () => {
    const ready = deciderReady({ library: LIBRARY_NOT_SEEN, models: null });
    expect(ready).toEqual({ ready: false, blocker: 'Payload not seen' });
    const html = render(<RunStepView run={null} ready={ready} {...handlers} />);
    expect(button(html, 'Run')).toMatch(/disabled/);
    expect(html).toContain('Payload not seen');
  });

  it('a running run shows spent and projected; an editor gets no Run, Resume or Cancel', () => {
    const owner = render(<RunStepView run={RUN_RUNNING} ready={{ ready: true, blocker: null }} {...handlers} />);
    expect(owner).toContain('$1.84');
    expect(owner).toContain('$5.81');
    expect(button(owner, 'Cancel')).not.toBe('');
    // no projection yet: no Projected row, and no dash in its place
    const unprojected = render(<RunStepView run={{ ...RUN_RUNNING, projected: null }} ready={{ ready: true, blocker: null }} {...handlers} />);
    expect(unprojected).not.toContain('Projected');
    expect(unprojected).not.toContain('—');
    const editor = render(<RunStepView run={RUN_RUNNING} ready={{ ready: true, blocker: null }} {...handlers} owner={false} />);
    expect(button(editor, 'Cancel')).toBe('');
    expect(button(render(<RunStepView run={RUN_DONE} ready={{ ready: true, blocker: null }} {...handlers} owner={false} />), 'Run')).toBe('');
  });

  it('what blocks the decider: no model, no key, the payload, no cap', () => {
    expect(deciderReady({ library: LIBRARY_LOCAL, models: NO_MODELS }).blocker).toBe('No model');
    expect(deciderReady({ library: LIBRARY_LOCAL, models: MODELS }).ready).toBe(true);
    expect(deciderReady({ library: LIBRARY_NO_KEY, models: null }).blocker).toBe('No key');
    expect(deciderReady({ library: { ...LIBRARY_JEV, config: { ...LIBRARY_JEV.config, monthlyCap: null } }, models: null }).blocker).toBe('No cap');
    expect(deciderReady({ library: LIBRARY_JEV, models: null }).ready).toBe(true);
  });
});

describe('the decider step', () => {
  it('local: the active model and its held-out figures, Train again for the owner', () => {
    const html = render(<DeciderStepView library={LIBRARY_LOCAL} models={MODELS} owner onTrain={noop} />);
    expect(html).toContain('Model v3');
    expect(html).toContain('1,912');
    expect(button(html, 'Train again')).not.toBe('');
    expect(button(render(<DeciderStepView library={LIBRARY_LOCAL} models={MODELS} owner={false} onTrain={noop} />), 'Train again')).toBe('');
  });

  it('a band with no error rate yet shows an empty cell, never a dash', () => {
    const active = MODELS.active!;
    const models = { ...MODELS, active: { ...active, metrics: { ...active.metrics, bands: active.metrics.bands.map((b) => ({ ...b, errorRate: null })) } } };
    const html = render(<DeciderStepView library={LIBRARY_LOCAL} models={models} owner onTrain={noop} />);
    expect(html).toContain('Error rate');
    expect(html).not.toContain('—');
  });

  it('Jev: the key by its hint and whether the payload was seen, read only (the setup shows the payload)', () => {
    const html = render(<DeciderStepView library={LIBRARY_NOT_SEEN} models={null} owner onTrain={noop} />);
    expect(html).toContain('••••9f2c');
    expect(html).toContain('Not seen');
    expect(html).toContain('jev-latest');
    expect(html).toContain('Jev key');
    expect(button(html, 'Payload')).toBe('');
    expect(button(html, 'Seen')).toBe('');
  });
});

describe('the spot-check card', () => {
  const card = (p: Partial<Parameters<typeof SpotCheckCardView>[0]> = {}) =>
    render(<SpotCheckCardView band="p97" bands={BANDS} onBand={noop} item={CHECK} onVerdict={noop} onDraw={noop} {...p} />);

  it('the files beside the picked release, the edition line and n of m', () => {
    const html = card();
    expect(html).toContain('Your files');
    expect(html).toContain('Picked release');
    expect(html).toContain('Northlight · 1997 · CD · GB · 1 of 6 editions with this tracklist');
    expect(html).toContain('113 of 125');
    expect(html).toContain('Mira Vale · 1985 · 8 files');
    expect(html).not.toContain('Changed since');
    expect(card({ item: CHECK_STALE })).toContain('Changed since');
  });

  it('Correct, Wrong and Unsure carry their keys C, W and U', () => {
    const html = card();
    expect(button(html, 'Correct')).toContain('aria-keyshortcuts="C"');
    expect(button(html, 'Wrong')).toContain('aria-keyshortcuts="W"');
    expect(button(html, 'Unsure')).toContain('aria-keyshortcuts="U"');
  });

  it('with no check waiting: Check 25 draws more', () => {
    const html = card({ item: null, band: 'p95' });
    expect(html).toContain('0 pending');
    expect(button(html, 'Check 25')).not.toBe('');
  });
});

describe('verdict keys', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, target: null, preventDefault: vi.fn(), ...extra });

  it('C, W and U in either case; nothing with a modifier', () => {
    expect(verdictForKey(key('c'))).toBe('correct');
    expect(verdictForKey(key('W'))).toBe('wrong');
    expect(verdictForKey(key('u'))).toBe('unsure');
    expect(verdictForKey(key('c', { metaKey: true }))).toBeNull();
    expect(verdictForKey(key('x'))).toBeNull();
  });

  it('a key gives the verdict once, and moves on through the handler', () => {
    const onVerdict = vi.fn();
    const e = key('w');
    expect(handleVerdictKey(e, { item: CHECK, pending: false, onVerdict }, false)).toBe(true);
    expect(onVerdict).toHaveBeenCalledWith('wrong');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('not while typing, while a dialog is open, while a verdict is on its way, on a held key, or with no check', () => {
    const onVerdict = vi.fn();
    const field = { closest: (s: string) => (s.includes('input') ? {} : null) } as unknown as EventTarget;
    expect(handleVerdictKey(key('c', { target: field }), { item: CHECK, pending: false, onVerdict }, false)).toBe(false);
    expect(handleVerdictKey(key('c'), { item: CHECK, pending: false, onVerdict }, true)).toBe(false);
    expect(handleVerdictKey(key('c'), { item: CHECK, pending: true, onVerdict }, false)).toBe(false);
    expect(handleVerdictKey(key('c', { repeat: true }), { item: CHECK, pending: false, onVerdict }, false)).toBe(false);
    expect(handleVerdictKey(key('c'), { item: null, pending: false, onVerdict }, false)).toBe(false);
    expect(onVerdict).not.toHaveBeenCalled();
  });
});

describe('batches', () => {
  it('show undone and left albums with their labels', () => {
    const html = render(<BatchListView items={[BATCH_UNDONE]} detail={BATCH_DETAIL} onUndo={noop} onOpen={noop} />);
    expect(html).toContain('Left as is');
    expect(html).toContain('Newer decision');
    expect(html).toContain('Field locked');
    expect(html).toContain('Undone 38');
  });

  it('Undo: a rule batch for anyone who may edit, a model batch for the owner; never once undone', () => {
    expect(canUndo(BATCH_ACCEPTED, true)).toBe(true);
    expect(canUndo(BATCH_ACCEPTED, false)).toBe(false);
    expect(canUndo({ ...BATCH_ACCEPTED, decidedKind: 'rule' }, false)).toBe(true);
    expect(canUndo(BATCH_UNDONE, true)).toBe(false);
    expect(button(render(<BatchListView items={[BATCH_ACCEPTED]} onUndo={noop} owner={false} />), 'Undo')).toBe('');
    expect(button(render(<BatchListView items={[BATCH_ACCEPTED]} onUndo={noop} owner />), 'Undo')).not.toBe('');
  });
});

describe('the steps', () => {
  it('done steps show what they made; the spot check opens once the run is done', () => {
    const tiles = stepTiles({ library: LIBRARY_LOCAL, models: MODELS, run: RUN_DONE, bands: BANDS, band: 'p97' });
    expect(tiles.map((t) => t.value)).toEqual(['Model v3 ✓', '1,812 albums ✓', '97% band', '1 band ready']);
    expect(tiles[1]!.sub).toBe('1,646 picked');
    expect(tiles[3]!.sub).toBe('1,204 albums');
    expect(defaultStep(tiles)).toBe('check');
  });

  it('blocked by: no key, and a run that paused', () => {
    const noKey = stepTiles({ library: LIBRARY_NO_KEY, models: null, run: null, bands: null, band: 'p99' });
    expect(noKey[0]).toMatchObject({ status: 'blocked', value: 'No key' });
    expect(defaultStep(noKey)).toBe('decider');
    const paused = stepTiles({ library: LIBRARY_JEV, models: null, run: runPaused('cap_reached'), bands: null, band: 'p99' });
    expect(paused[1]).toMatchObject({ status: 'blocked', value: 'Paused', sub: 'Cap reached' });
    expect(defaultStep(paused)).toBe('run');
  });

  it('the strip marks the current step', () => {
    const tiles = stepTiles({ library: LIBRARY_LOCAL, models: MODELS, run: RUN_DONE, bands: BANDS, band: 'p97' });
    const html = render(<StepStripView tiles={tiles} current="check" onStep={noop} />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('3 · Spot check');
  });

  it('the whole tab: the card and the gates, no sentence', () => {
    const html = render(<AutotaggerView {...TAB} />);
    expect(html).toContain('Spot check');
    expect(html).toContain('Gates · limit');
    expect(button(html, 'Past runs and batches')).not.toBe('');
    expect(html).not.toMatch(/Liner/);
  });
});

describe('the tab, step by step', () => {
  it('the owner’s step 1 is the setup', () => {
    const html = render(<AutotaggerView {...TAB} library={LIBRARY_JEV} step="decider" setup={<i data-setup />} />);
    expect(html).toContain('data-setup');
    expect(button(html, 'Payload')).toBe('');
  });

  it('an editor’s step 1 has no form', () => {
    const html = render(<AutotaggerView {...TAB} owner={false} library={LIBRARY_JEV} step="decider" />);
    expect(html).not.toContain('<input');
    expect(button(html, 'Save')).toBe('');
    expect(button(html, 'Add price')).toBe('');
    expect(html).not.toContain('••••');
    expect(button(html, 'Payload')).toBe('');
    expect(html).toContain('<dt>Jev key</dt><dd>Set</dd>');
  });

  it('run stats sit in step 2, the owner’s', () => {
    const html = render(<AutotaggerView {...TAB} step="run" stats={MODULE} />);
    expect(html).toContain('<dt>Runs</dt><dd>4</dd>');
    expect(html).toContain('<dt>Decisions</dt><dd>5,612</dd>');
    expect(render(<AutotaggerView {...TAB} step="run" stats={null} />)).not.toContain('<dt>Runs</dt>');
  });

  it('Agreement sits in step 3 under the gates', () => {
    const html = render(<AutotaggerView {...TAB} step="check" agreement={AGREEMENT} />);
    expect(html.indexOf('aria-label="Backtest"')).toBeGreaterThan(html.indexOf('Gates'));
    expect(html.indexOf('Gates')).toBeGreaterThan(-1);
    const first = render(<AutotaggerView {...TAB} step="check" run={null} runs={[]} bands={null} agreement={AGREEMENT} />);
    expect(first.indexOf('Run first')).toBeGreaterThan(-1);
    expect(first.indexOf('aria-label="Agreement"')).toBeGreaterThan(first.indexOf('Run first'));
  });

  it('the tab has no Off view', () => {
    const panel = source('./AutotaggerPanel.tsx');
    expect(panel).not.toContain("'Autotagger', 'Off'");
    expect(panel).not.toContain('/settings/modules');
    // @ts-expect-error the view takes no `enabled`: the tab shows only while the module is on
    const props: AutotaggerViewProps = { ...TAB, enabled: true };
    expect(props).toBeTruthy();
  });

  it('the panel renders only while the module is on', () => {
    const panel = source('./AutotaggerPanel.tsx');
    expect(panel).toContain('if (!enabled) return null');
    expect(panel.slice(panel.indexOf('<AutotaggerView'))).not.toMatch(/\benabled=\{/);
  });

  it('no link to the old settings page', () => {
    expect(source('./AutotaggerPanel.tsx')).not.toContain("module: 'autotagger'");
    expect(existsSync(new URL('../SettingsAutotagger.tsx', import.meta.url))).toBe(false);
  });

  it('the panel asks for the owner’s module view only as the owner', () => {
    expect(source('./AutotaggerPanel.tsx')).toMatch(/useAutotaggerModule\(owner/);
  });
});

describe('the provenance line', () => {
  it('model, rule and a person', () => {
    expect(render(<ProvenanceLine match={MODEL_MATCH} locale="en-GB" />)).toContain('Automatic: Jev 2026-09, probability 0.994');
    expect(render(<ProvenanceLine match={RULE_MATCH} locale="en-GB" />)).toContain('Automatic: your rules, batch of 27 Oct');
    expect(render(<ProvenanceLine match={HAND_MATCH} />)).toBe('<span>By Ada</span>');
    expect(render(<ProvenanceLine match={{ decidedBy: 'system' }} />)).toBe('');
  });
});

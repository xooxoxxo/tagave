/**
 * Settings › Updates › Repair: when the Repair button shows, and the repair
 * view (the headline, the details behind "?", nothing that spins while it
 * waits for the music share).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateRun, UpdaterStatus } from '@tagave/shared';
import type { PartState } from '@tagave/shared/updater';
import { RepairRunView, showRepair } from './RepairRun';
import { REPAIR_WAITING_NOW, heldRun, nowAt, repairCrashLoopRun, repairDiskFullRun, repairRunning, repairWaitingRun, repairedRun, rolledBackRun, simulatedRun } from '../stories/updateFixtures';

const SERVICES = ['app', 'postgres', 'worker-identify', 'worker-files', 'player'];
const parts = (stuck: Partial<Record<string, PartState['state']>> = {}): PartState[] =>
  SERVICES.map((service) => ({ service, state: stuck[service] ?? 'running', health: null }));
const status = (over: Partial<UpdaterStatus> = {}): UpdaterStatus => ({
  version: '0.12.0', configuredVersion: '0.12.0', role: 'all', services: SERVICES, run: null, parts: parts(), repair: null, ...over,
});
const finished = (s: UpdateRun['status']): UpdateRun => ({ ...rolledBackRun(), status: s });

/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');
/** The markup without the hidden hints. */
const visible = (html: string) => html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, '');

describe('showRepair', () => {
  it('hides the button when every part runs and nothing waits', () => {
    expect(showRepair(null)).toBe(false);
    expect(showRepair(status())).toBe(false);
    expect(showRepair(status({ run: simulatedRun(88) }))).toBe(false);
    expect(showRepair(status({ repair: repairedRun() }))).toBe(false);
    // an updater before repair reports no parts at all
    const { parts: _p, repair: _r, ...old } = status();
    expect(showRepair(old)).toBe(false);
  });

  it('shows it when any part is not running', () => {
    for (const state of ['starting', 'stopped', 'stuck', 'missing'] as const) {
      expect(showRepair(status({ parts: parts({ 'worker-files': state }) })), state).toBe(true);
    }
  });

  it('shows it when the last update ended held or with a failed roll back, not after other ends', () => {
    expect(showRepair(status({ run: heldRun() }))).toBe(true);
    expect(showRepair(status({ run: finished('rollback_failed') }))).toBe(true);
    for (const s of ['succeeded', 'rolled_back', 'failed', 'interrupted', 'running'] as const) {
      expect(showRepair(status({ run: finished(s) })), s).toBe(false);
    }
  });

  it('shows it while a repair waits for the music share', () => {
    expect(showRepair(status({ repair: repairWaitingRun() }))).toBe(true);
    expect(showRepair(status({ repair: repairDiskFullRun() }))).toBe(false);
  });
});

describe('RepairRunView', () => {
  const render = (run = repairWaitingRun(), now = REPAIR_WAITING_NOW) =>
    renderToStaticMarkup(<RepairRunView run={run} now={now} onDismiss={() => undefined} />);

  it('shows the headline as the title', () => {
    const html = render(repairedRun());
    expect(html).toMatch(/<h2[^>]*>Repaired\. All 5 parts running\.<\/h2>/);
    expect(html).toContain('data-update-takeover');
  });

  it('keeps the details behind "?" until it is opened', () => {
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(hidden(html)).toContain('4 of 5 parts running.');
    expect(hidden(html)).toContain('The file worker waits for the share.');
    expect(visible(html)).not.toContain('4 of 5 parts running.');
  });

  it('says when the share was last checked, behind "?", from checkedAt', () => {
    const html = render();
    expect(hidden(html)).toContain('Checked 2 min ago');
    expect(visible(html)).not.toContain('Checked');
    expect(hidden(render(repairWaitingRun(), Date.parse(repairWaitingRun().checkedAt!) + 20_000))).toContain('Checked now');
  });

  it('shows no spinner and no running step while it waits', () => {
    const html = render();
    expect(html).not.toContain('aria-current="step"');
    expect(html).not.toMatch(/spinner/);
    // the step it waits on is still listed
    expect(html).toContain('Check the music share');
    // a running repair does mark its step
    expect(render(repairRunning(), nowAt(12))).toContain('aria-current="step"');
  });

  it('has Done once the run is not running', () => {
    expect(render()).toContain('>Done<');
    expect(render(repairDiskFullRun())).toContain('>Done<');
    expect(render(repairCrashLoopRun())).toContain('>Done<');
    expect(render(repairRunning(), nowAt(12))).not.toContain('>Done<');
  });

  it('says what the owner has to do in the title when it needs them', () => {
    expect(render(repairDiskFullRun())).toContain('The disk is full (180 MB free). Free up space, then press Repair.');
    expect(render(repairCrashLoopRun())).toContain('The file worker keeps stopping. tagave restarted it once.');
    expect(hidden(render(repairCrashLoopRun()))).toContain('Last error: Error: EACCES');
  });

  it('has a title while it runs, before the updater sends a headline', () => {
    expect(render(repairRunning(), nowAt(12))).toMatch(/<h2[^>]*>Repairing tagave<\/h2>/);
  });
});

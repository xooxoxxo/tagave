/**
 * Settings › Updates › Repair: when the Repair button shows, and the repair
 * view (the headline, the details behind "?", nothing that spins while it
 * waits for the music share).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { UpdateRun, UpdaterStatus } from '@tagave/shared';
import type { PartState } from '@tagave/shared/updater';
import { RepairRunView, copyText, repairAction, repairTickMs, showRepair } from './RepairRun';
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

  it('hides it once a repair after the held or failed update repaired everything', () => {
    const held = heldRun(); // finished at 400 s
    const after = { ...repairedRun(), finishedAt: new Date(Date.parse(held.finishedAt!) + 60_000).toISOString() };
    const before = { ...repairedRun(), finishedAt: new Date(Date.parse(held.finishedAt!) - 60_000).toISOString() };
    expect(showRepair(status({ run: held, repair: after }))).toBe(false);
    expect(showRepair(status({ run: finished('rollback_failed'), repair: { ...after, finishedAt: new Date(Date.parse(finished('rollback_failed').finishedAt!) + 1000).toISOString() } }))).toBe(false);
    // a repair from before the update does not count
    expect(showRepair(status({ run: held, repair: before }))).toBe(true);
    // a repair that did not repair does not count
    expect(showRepair(status({ run: held, repair: { ...repairDiskFullRun(), finishedAt: after.finishedAt } }))).toBe(true);
    // a part that stopped since still shows it
    expect(showRepair(status({ run: held, repair: after, parts: parts({ 'worker-files': 'stopped' }) }))).toBe(true);
  });

  it('shows it while a repair waits for the music share', () => {
    expect(showRepair(status({ repair: repairWaitingRun() }))).toBe(true);
    expect(showRepair(status({ repair: repairDiskFullRun() }))).toBe(false);
  });
});

/** A view with a link needs a router. */
async function inRouter(node: ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: '/settings/$section' })]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}
const routed = (run = repairWaitingRun(), now = REPAIR_WAITING_NOW) => inRouter(<RepairRunView run={run} now={now} onDismiss={() => undefined} />);
const count = (html: string, text: string) => html.split(text).length - 1;

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

  it('has Done once the run is not running', async () => {
    expect(render()).toContain('>Done<');
    expect(await routed(repairDiskFullRun())).toContain('>Done<');
    expect(render(repairCrashLoopRun())).toContain('>Done<');
    expect(render(repairRunning(), nowAt(12))).not.toContain('>Done<');
  });

  it('says what the owner has to do in the title when it needs them', async () => {
    expect(await routed(repairDiskFullRun())).toContain('The disk is full (180 MB free). Free up space, then press Repair.');
    expect(render(repairCrashLoopRun())).toContain('The file worker keeps stopping. tagave restarted it once.');
    expect(hidden(render(repairCrashLoopRun()))).toContain('Last error: Error: EACCES');
  });

  it("shows the updater's action lines as it writes them", () => {
    // repair.ts: `Started ${partName(s)} again from scratch.` for a recreate
    expect(render(repairCrashLoopRun())).toContain('Started the file worker again from scratch.');
    expect(render(repairCrashLoopRun())).not.toContain('fresh container');
    // the run log names the parts by their label
    expect(render(repairCrashLoopRun())).toContain('parts: the web app running, the database running');
  });

  it('has a title while it runs, before the updater sends a headline', () => {
    expect(render(repairRunning(), nowAt(12))).toMatch(/<h2[^>]*>Repairing tagave<\/h2>/);
  });
});

describe('RepairRunView, the help per cause and the clock', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('links Settings › Status (where Storage is) behind "?" when the disk is full', async () => {
    const html = await routed(repairDiskFullRun());
    expect(hidden(html)).toMatch(/<a[^>]*href="\/settings\/status"[^>]*>Storage in Settings › Status<\/a>/);
    expect(hidden(html)).toContain('tagave never deletes files for you.');
    expect(renderToStaticMarkup(<RepairRunView run={repairWaitingRun()} now={REPAIR_WAITING_NOW} onDismiss={() => undefined} />)).not.toContain('Settings › Status');
  });

  it('offers Copy details behind "?" for a crash loop, copying the last error and the details', () => {
    const run = repairCrashLoopRun();
    const html = renderToStaticMarkup(<RepairRunView run={run} now={nowAt(45)} onDismiss={() => undefined} />);
    expect(hidden(html)).toContain('>Copy details<');
    expect(renderToStaticMarkup(<RepairRunView run={repairWaitingRun()} now={REPAIR_WAITING_NOW} onDismiss={() => undefined} />)).not.toContain('Copy details');
    expect(copyText(run)).toBe([run.headline, ...run.details].join('\n'));
    expect(copyText(run)).toContain('Last error: Error: EACCES');
  });

  it('says the headline once: no note under the failed step repeats it', () => {
    const html = renderToStaticMarkup(<RepairRunView run={repairCrashLoopRun()} now={nowAt(45)} onDismiss={() => undefined} />);
    expect(count(html, 'keeps stopping')).toBe(1);
    // without a headline (an older updater) the failed step still says why
    const bare = { ...repairCrashLoopRun(), headline: null, reason: 'the file worker keeps stopping' };
    expect(renderToStaticMarkup(<RepairRunView run={bare} now={nowAt(45)} onDismiss={() => undefined} />)).toContain('The file worker keeps stopping');
  });

  it('ticks every second while it runs and every minute while it waits; a fixed clock never ticks', () => {
    expect(repairTickMs(repairRunning(), false)).toBe(1000);
    expect(repairTickMs(repairWaitingRun(), false)).toBe(60_000);
    expect(repairTickMs(repairedRun(), false)).toBeNull();
    expect(repairTickMs(repairWaitingRun(), true)).toBeNull();
  });

  it('reads "Checked" from the browser clock without a fixed one', () => {
    const run = repairWaitingRun();
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(run.checkedAt!) + 10_000);
    expect(hidden(renderToStaticMarkup(<RepairRunView run={run} onDismiss={() => undefined} />))).toContain('Checked now');
    vi.setSystemTime(Date.parse(run.checkedAt!) + 3 * 60_000);
    expect(hidden(renderToStaticMarkup(<RepairRunView run={run} onDismiss={() => undefined} />))).toContain('Checked 3 min ago');
  });
});

describe('repairAction (the Repair button)', () => {
  it('shows a repair that runs, and starts one otherwise: pressing Repair while it waits starts again at check', () => {
    expect(repairAction(repairRunning())).toBe('show');
    expect(repairAction(repairWaitingRun())).toBe('start');
    expect(repairAction(repairedRun())).toBe('start');
    expect(repairAction(repairDiskFullRun())).toBe('start');
    expect(repairAction(null)).toBe('start');
    expect(repairAction(undefined)).toBe('start');
  });
});

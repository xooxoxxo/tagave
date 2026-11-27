/**
 * Work cut off by an offline music folder: a paused split's task says so with
 * its help behind "?" and keeps Continue off until the folder is back; a move
 * cut off reads as paused (Undo stays); the album page's toast says so too;
 * a tag plan that waits says so where its status shows.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PAUSED_OFFLINE_STAGE, type MaintenanceTaskView } from '@tagave/shared';
import { MaintenanceTaskStatusView } from './MaintenanceTaskStatus';
import { MoveError } from '../pages/MovedPage';
import { movedToast, undoneToast } from '../utils/offlinePaused';
import { MoveStatus } from './MoveSheet';
import { PlanStatusBadge } from './PlanStatusBadge';
import { planStatusView } from '../utils/planStatus';

const noop = () => undefined;
/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');
const visible = (html: string) => html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, '').replace(/<[^>]+>/g, '');
const continueButton = (html: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*Continue(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)?.[0] ?? '';

const task = (over: Partial<MaintenanceTaskView> = {}): MaintenanceTaskView => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'split', subjectId: null, state: 'interrupted',
  stage: PAUSED_OFFLINE_STAGE, progress: { done: 3, total: 11 }, error: null, attempt: 1,
  updatedAt: '2026-11-24T14:02:00.000Z', cancelRequested: false, workerAvailable: true, actions: ['continue'],
  waitsForFolder: true, ...over,
});

describe('a split paused while the music folder is offline', () => {
  it('shows the stage, its help behind "?", and Continue off while the folder is away', () => {
    const html = renderToStaticMarkup(<MaintenanceTaskStatusView task={task()} pending={false} failed={false} onAction={noop} />);
    expect(visible(html)).toContain('Paused while the music folder is offline · 3 of 11');
    expect(hidden(html)).toBe('Press Continue when the folder is back.');
    expect(html).toContain('aria-label="Help: Paused while the music folder is offline"');
    expect(continueButton(html)).toContain('disabled=""');
  });

  it('lets Continue go once the folder is back, the help still there', () => {
    const html = renderToStaticMarkup(<MaintenanceTaskStatusView task={task({ waitsForFolder: false })} pending={false} failed={false} onAction={noop} />);
    expect(hidden(html)).toBe('Press Continue when the folder is back.');
    expect(continueButton(html)).not.toContain('disabled=""');
  });

  it('leaves any other stage as it was: no "?"', () => {
    const html = renderToStaticMarkup(<MaintenanceTaskStatusView task={task({ stage: 'Splitting', waitsForFolder: undefined })} pending={false} failed={false} onAction={noop} />);
    expect(html).not.toContain('Help:');
    expect(continueButton(html)).not.toContain('disabled=""');
  });
});

describe('a move cut off by the offline folder', () => {
  it('reads as paused in Moved, quiet and with no "?" (a move offers only Undo)', () => {
    const html = renderToStaticMarkup(<div><MoveError error={PAUSED_OFFLINE_STAGE} /></div>);
    expect(visible(html)).toBe('Paused while the music folder is offline');
    expect(html).not.toContain('Help:');
    expect(html).not.toContain('Press Continue');
  });

  it('reads as paused in the move sheet, not in danger, with no "?"', () => {
    const paused = renderToStaticMarkup(<MoveStatus status={PAUSED_OFFLINE_STAGE} failed={false} />);
    expect(visible(paused)).toBe('Paused while the music folder is offline');
    expect(paused).not.toContain('Help:');
    expect(paused).not.toContain('statusFailed');
    expect(renderToStaticMarkup(<MoveStatus status="Name taken" failed />)).toContain('statusFailed');
  });

  it('an undo cut off by the folder says so quietly; any other end of an undo as before', () => {
    expect(undoneToast({ state: 'done', error: PAUSED_OFFLINE_STAGE })).toEqual({ message: 'Paused while the music folder is offline' });
    expect(undoneToast({ state: 'undone', error: null })).toEqual({ message: 'Undone' });
    expect(undoneToast({ state: 'failed', error: 'Disk full' })).toEqual({ message: 'Disk full', tone: 'danger' });
    expect(undoneToast(null)).toEqual({ message: 'Not undone', tone: 'danger' });
  });

  it('keeps any other error as it was', () => {
    const html = renderToStaticMarkup(<div><MoveError error="Name taken" /></div>);
    expect(visible(html)).toBe('Name taken');
    expect(html).not.toContain('Help:');
  });

  it('the album page\'s toast says it paused, not Moved', () => {
    expect(movedToast(2, null)).toBe('2 songs · Moved');
    expect(movedToast(1, null)).toBe('1 song · Moved');
    expect(movedToast(2, PAUSED_OFFLINE_STAGE)).toBe('Paused while the music folder is offline');
  });
});

describe('a tag plan waiting for its music folder', () => {
  it('shows the status with its help behind "?"', () => {
    const html = renderToStaticMarkup(<PlanStatusBadge view={planStatusView('waiting')} />);
    expect(visible(html)).toBe('Waiting for the music folder?');
    expect(hidden(html)).toBe('tagave writes these tags when the folder is back. Nothing is lost.');
  });

  it('a plan paused by the offline folder: paused, Continue behind "?"', () => {
    const html = renderToStaticMarkup(<PlanStatusBadge view={planStatusView('paused', null, PAUSED_OFFLINE_STAGE)} />);
    expect(visible(html)).toBe('paused?');
    expect(hidden(html)).toBe('Press Continue when the folder is back.');
  });

  it('any other status: the badge alone', () => {
    const html = renderToStaticMarkup(<PlanStatusBadge view={planStatusView('applied')} />);
    expect(html).not.toContain('Help:');
  });
});

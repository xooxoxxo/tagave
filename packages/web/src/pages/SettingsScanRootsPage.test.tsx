/**
 * Settings › Library › Music folders: Add music folder keeps its Tag writes
 * choice, and a folder the worker cannot use says why, as an alert.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScanRoot } from '@tagave/shared';
import { describe, expect, it } from 'vitest';
import { MusicFoldersView, folderCheck } from './SettingsScanRootsPage';

const at = '2026-11-01T10:00:00.000Z';
const root = (over: Partial<ScanRoot> = {}): ScanRoot => ({
  id: '11111111-1111-4111-8111-111111111111', libraryId: '22222222-2222-4222-8222-222222222222', path: '/music', displayName: 'Music',
  writable: true, enabled: true, pollIntervalS: 21600, validationStatus: 'ok', validationMessage: null, probeWritable: true,
  lastScanAt: at, lastStatus: 'done', albumsFound: 3, tracksFound: 30, folderLink: null, createdAt: at, updatedAt: at, ...over,
});
const noop = () => undefined;
const view = (roots: ScanRoot[]) => renderToStaticMarkup(
  <MusicFoldersView roots={roots} onUpdate={() => Promise.resolve(null)} onScan={noop} onCheck={noop} onRemove={noop} onAdd={() => true} />,
);
/** The markup of the group titled `title`, up to the next form. */
const group = (html: string, title: string) => {
  const at = html.indexOf(`>${title}<`);
  if (at < 0) throw new Error(`no ${title}`);
  const end = html.indexOf('</form>', at);
  return html.slice(at, end < 0 ? undefined : end);
};
/** The markup of the row labelled `label` inside `html`. */
const row = (html: string, label: string) => {
  const at = html.indexOf(`>${label}</span>`);
  if (at < 0) throw new Error(`no ${label} row`);
  return html.slice(at, html.indexOf('</div>', at));
};

describe('Add music folder', () => {
  it('has a Tag writes Off/On choice, On by default', () => {
    const add = group(view([]), 'Add music folder');
    const writes = add.slice(add.indexOf('>Tag writes<'));
    expect(writes).toMatch(/>Off</);
    expect(writes).toMatch(/>On</);
    expect(writes).toMatch(/checked="" value="on"/);
  });

  it('the choice joins Add: the new folder carries it', () => {
    const source = readFileSync(new URL('./SettingsScanRootsPage.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/writable: true \};/);
    expect(source).not.toMatch(/create\.mutate\(\{ \.\.\.f, writable: true/);
    expect(source).toMatch(/create\.mutate\(\{ \.\.\.f, enabled: true \}/);
  });
});

describe('the Check row', () => {
  it('says a problem as an alert, the worker\'s words behind its ?', () => {
    const html = view([root({ validationStatus: 'missing', validationMessage: 'No such file or directory' })]);
    const check = row(html, 'Check');
    expect(check).toMatch(/role="alert"[^>]*>Missing</);
    expect(html).toContain('No such file or directory');
  });

  it('keeps OK quiet', () => {
    const check = row(view([root()]), 'Check');
    expect(check).toContain('>OK<');
    expect(check).not.toContain('role="alert"');
  });

  it('gives the worker\'s message as help for Missing, Not a directory and Unreadable', () => {
    for (const validationStatus of ['missing', 'not_directory', 'unreadable'] as const) {
      expect(folderCheck(root({ validationStatus, validationMessage: 'why' })).help, validationStatus).toBe('why');
      expect(folderCheck(root({ validationStatus, validationMessage: null })).help, validationStatus).toBeUndefined();
    }
    expect(folderCheck(root({ validationStatus: 'pending', validationMessage: 'queued' })).help).toBeUndefined();
  });
});

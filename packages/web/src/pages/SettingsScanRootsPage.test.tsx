/**
 * Settings › Library › Music folders: Add music folder keeps its Tag writes
 * choice, and a folder the worker cannot use says why, as an alert.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScanRoot } from '@tagave/shared';
import { describe, expect, it } from 'vitest';
import { MusicFoldersView, folderCheck, folderPatch } from './SettingsScanRootsPage';

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

describe('Allow writes, the folder\'s own switch', () => {
  it('a folder\'s switch is Allow writes, not a second Tag writes', () => {
    const html = view([root()]);
    expect(html).toMatch(/role="radiogroup" aria-label="Allow writes"/);
    expect(html).not.toContain('Tag writes</span>');
    expect(html).not.toMatch(/aria-label="Tag writes"/);
    // its help says the library's switch still has the last word
    expect(html).toContain('Nothing is written while Tag writes is off in Tag writing');
  });
});

describe('Add music folder', () => {
  it('has an Allow writes Off/On choice, On by default', () => {
    const add = group(view([]), 'Add music folder');
    expect(add).not.toContain('>Tag writes<');
    const writes = add.slice(add.indexOf('>Allow writes<'));
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

describe('a folder\'s Save: Folder link and Rescan every', () => {
  it('Rescan every is a field of the folder, not a read-only value', () => {
    const rescan = row(view([root()]), 'Rescan every');
    expect(rescan).toMatch(/<input[^>]*type="number"[^>]*value="21600"/);
    expect(rescan).toMatch(/min="60"/);
  });

  it('one Save for the group, named Save', () => {
    const html = group(view([root()]), 'Music');
    expect(html.match(/>Save</g)).toHaveLength(1);
    expect(html).not.toContain('Save link');
    expect(html).not.toContain('Remove link');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
  });

  it('sends what changed, both in one request', () => {
    const base = { folderLink: 'smb://nas.example.com/music/', pollIntervalS: 21600 };
    expect(folderPatch(base, base)).toEqual({ patch: null, problem: null });
    expect(folderPatch(base, { ...base, pollIntervalS: 3600 })).toEqual({ patch: { pollIntervalS: 3600 }, problem: null });
    expect(folderPatch(base, { folderLink: 'smb://nas.example.com/other/', pollIntervalS: 600 }).patch).toEqual({ folderLink: 'smb://nas.example.com/other/', pollIntervalS: 600 });
    // clearing the link still removes it
    expect(folderPatch(base, { ...base, folderLink: '  ' }).patch).toEqual({ folderLink: null });
  });

  it('less than 60 seconds is a problem, not a save', () => {
    const base = { folderLink: '', pollIntervalS: 21600 };
    expect(folderPatch(base, { ...base, pollIntervalS: 30 })).toEqual({ patch: null, problem: { pollIntervalS: 'At least 60 seconds' } });
    // a folder stored below 60 s still saves its link
    const low = { ...base, pollIntervalS: 30 };
    expect(folderPatch(low, { ...low, folderLink: 'smb://nas/music/' }).problem).toBeNull();
    expect(folderPatch(base, { ...base, pollIntervalS: Number.NaN }).problem).toEqual({ pollIntervalS: 'At least 60 seconds' });
    expect(folderPatch(base, { ...base, folderLink: 'not a link' }).problem?.folderLink).toBeTruthy();
  });
});

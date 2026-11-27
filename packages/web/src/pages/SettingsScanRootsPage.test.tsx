/**
 * Settings › Library › Music folders: Add music folder keeps its Tag writes
 * choice, and a folder the worker cannot use says why, as an alert.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScanRoot } from '@tagave/shared';
import { describe, expect, it } from 'vitest';
import { MusicFoldersView, folderCheck, folderPatch, scanToast, waitingText } from './SettingsScanRootsPage';

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

/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');
/** The markup without the hidden hints. */
const visible = (html: string) => html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, '');
/** renderToStaticMarkup escapes apostrophes */
const plain = (s: string) => s.replace(/&#x27;/g, "'");

const OFFLINE_HELP = "tagave can't reach this folder. Your library, tags and plays are safe. Scans and tag writes wait and start again on their own when it's back.";
const UNMOUNTED_HELP = "The folder is there but its share isn't connected. tagave tries to connect it again. If it can't, connect the drive or share.";
const WAITING_HELP = 'Work that needs the files. It starts when the folder is back.';
const nowLocal = new Date('2026-11-24T16:00:00');
const NONE = { scans: 0, tagWrites: 0, other: 0 };

describe('the Check row reads the folder watch (reach)', () => {
  it('says every copy row of Settings › Library', () => {
    const rows: Array<[Partial<ScanRoot>, { text: string; problem: boolean; help?: string }]> = [
      [{ reach: 'online' }, { text: 'Online', problem: false }],
      [{ reach: 'offline', reachSince: '2026-11-24T14:02:00' }, { text: 'Offline since 14:02', problem: true, help: OFFLINE_HELP }],
      [{ reach: 'offline', reachSince: '2026-11-23T09:10:00' }, { text: 'Offline since 23 Nov, 09:10', problem: true, help: OFFLINE_HELP }],
      [{ reach: 'unmounted', reachSince: '2026-11-24T14:02:00' }, { text: 'Not connected since 14:02', problem: true, help: UNMOUNTED_HELP }],
      [{ reach: 'unknown' }, { text: 'Checking', problem: false }],
      // no reading time yet: the state alone
      [{ reach: 'offline', reachSince: null }, { text: 'Offline', problem: true, help: OFFLINE_HELP }],
    ];
    for (const [over, want] of rows) expect(folderCheck(root(over), nowLocal), JSON.stringify(over)).toEqual(want);
  });

  it('reach wins over the last scan: an offline folder is not "Unreachable"', () => {
    expect(folderCheck(root({ reach: 'offline', reachSince: '2026-11-24T14:02:00', lastStatus: 'aborted' }), nowLocal).text).toBe('Offline since 14:02');
  });

  it('an online folder still says what the worker found wrong there', () => {
    expect(folderCheck(root({ reach: 'online', probeWritable: false })).text).toBe('Mount is read-only');
    expect(folderCheck(root({ reach: 'online', validationMessage: 'folder is empty' })).text).toBe('Empty');
  });

  it('an older API (no reach) keeps the rules it had', () => {
    expect(folderCheck(root()).text).toBe('OK');
    expect(folderCheck(root({ lastStatus: 'aborted' })).text).toBe('Unreachable');
    expect(folderCheck(root({ validationStatus: 'pending' })).text).toBe('Pending');
  });

  it('keeps the Offline and Not connected help behind "?" until it is opened', () => {
    for (const [reach, help] of [['offline', OFFLINE_HELP], ['unmounted', UNMOUNTED_HELP]] as const) {
      const html = view([root({ reach, reachSince: new Date().toISOString(), waiting: NONE })]);
      expect(html).toMatch(/aria-label="Help: Check" aria-expanded="false"/);
      expect(plain(hidden(html))).toContain(help);
      expect(plain(visible(html))).not.toContain(help);
    }
  });

  it('the view reads "since" against its now', () => {
    const html = renderToStaticMarkup(
      <MusicFoldersView roots={[root({ reach: 'offline', reachSince: '2026-11-23T09:10:00', waiting: NONE })]} now={nowLocal} onUpdate={() => Promise.resolve(null)} onScan={noop} onCheck={noop} onRemove={noop} onAdd={() => true} />,
    );
    expect(row(html, 'Check')).toMatch(/role="alert"[^>]*>Offline since 23 Nov, 09:10</);
  });

  it('Online and Checking have no help', () => {
    for (const reach of ['online', 'unknown'] as const) {
      const html = view([root({ reach, waiting: NONE })]);
      expect(row(html, 'Check')).toContain(reach === 'online' ? '>Online<' : '>Checking<');
      expect(html).not.toContain('Help: Check');
    }
  });
});

describe('waitingText', () => {
  it('names what waits: tag writes, scans, other', () => {
    expect(waitingText(undefined)).toBe('Nothing');
    expect(waitingText(NONE)).toBe('Nothing');
    expect(waitingText({ scans: 1, tagWrites: 3, other: 0 })).toBe('3 tag writes, 1 scan');
    expect(waitingText({ scans: 0, tagWrites: 1, other: 0 })).toBe('1 tag write');
    expect(waitingText({ scans: 2, tagWrites: 0, other: 0 })).toBe('2 scans');
    expect(waitingText({ scans: 0, tagWrites: 0, other: 2 })).toBe('2 other tasks');
    expect(waitingText({ scans: 0, tagWrites: 0, other: 1 })).toBe('1 other task');
    expect(waitingText({ scans: 1, tagWrites: 2, other: 4 })).toBe('2 tag writes, 1 scan, 4 other tasks');
  });
});

describe('the Waiting row', () => {
  it('sits under Check, its help behind "?"', () => {
    const html = view([root({ reach: 'offline', reachSince: new Date().toISOString(), waiting: { scans: 1, tagWrites: 3, other: 0 } })]);
    expect(html.indexOf('>Waiting</span>')).toBeGreaterThan(html.indexOf('>Check</span>'));
    expect(row(html, 'Waiting')).toContain('>3 tag writes, 1 scan<');
    expect(html).toMatch(/aria-label="Help: Waiting" aria-expanded="false"/);
    expect(hidden(html)).toContain(WAITING_HELP);
    expect(visible(html)).not.toContain(WAITING_HELP);
  });

  it('says Nothing, with no help, when nothing waits', () => {
    const html = view([root({ reach: 'online', waiting: NONE })]);
    expect(row(html, 'Waiting')).toContain('>Nothing<');
    expect(html).not.toContain('Help: Waiting');
  });

  it('an older API (no waiting counts) shows no Waiting row', () => {
    expect(view([root()])).not.toContain('>Waiting</span>');
  });
});

describe('Scan while the folder is offline', () => {
  it('the Scan button stays enabled', () => {
    for (const reach of ['offline', 'unmounted'] as const) {
      const html = group(view([root({ reach, reachSince: new Date().toISOString(), waiting: NONE })]), 'Music');
      expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>(<span[^>]*>)?Scan</);
    }
  });

  it('a queued scan says it runs when the folder is back', () => {
    expect(scanToast({ id: 'j', type: 'scan.root', mode: 'full', state: 'created', createdAt: at, waiting: true })).toBe('Scan queued. It runs when the folder is back.');
    expect(scanToast({ id: 'j', type: 'scan.root', mode: 'full', state: 'created', createdAt: at })).toBeNull();
    expect(scanToast(undefined)).toBeNull();
  });

  it('the connected page shows that toast after a scan', () => {
    const source = readFileSync(new URL('./SettingsScanRootsPage.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/scan\.mutate\(root\.id, \{ onSuccess: \(body\) => \{ const message = scanToast\(body\); if \(message\) showToast\(\{ message \}\); \}/);
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

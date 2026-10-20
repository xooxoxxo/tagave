import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupEntryView, BackupKindView, BackupsStatus } from '@tagave/shared';
import { SettingsBackupsPage, versionLabel } from './SettingsBackupsPage';

const none = { count: 0, bytes: 0, names: [] };
const status = (over: Partial<BackupsStatus> = {}): BackupsStatus => ({
  dir: '/backups',
  dedicated: true,
  timeZone: 'UTC',
  settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null },
  running: false,
  lastRun: null,
  lastNightly: null,
  backups: [],
  restoreCommand: 'node packages/doctor/dist/cli.js restore {file} --yes',
  kinds: [
    { kind: 'nightly', count: 0, bytes: 0, newest: null, pendingDelete: none },
    { kind: 'pre-migration', count: 0, bytes: 0, newest: null, pendingDelete: none },
    { kind: 'manual', count: 0, bytes: 0, newest: null, pendingDelete: none },
  ],
  totalBytes: 0,
  error: null,
  ...over,
});

const entry = (name: string, kind: BackupKindView, createdAt: string, over: Partial<BackupEntryView> = {}): BackupEntryView => ({
  name, kind, createdAt, bytes: 1024, verified: true, version: null, versionInferred: false, toVersion: null, ...over,
});

function render(data: BackupsStatus): string {
  const client = new QueryClient();
  client.setQueryData(['backups'], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}><SettingsBackupsPage /></QueryClientProvider>);
}

describe('SettingsBackupsPage', () => {
  it('says there are none yet and offers Back up now', () => {
    const html = render(status());
    expect(html).toContain('No backups yet');
    expect(html).toContain('Back up now');
  });

  it('groups the backups by kind: date, version and size, with the totals on top', () => {
    const html = render(status({
      backups: [
        entry('tagave-2026-09-29T03-00-00Z-nightly.pgdump', 'nightly', '2026-09-29T03:00:00.000Z', { bytes: 2048, version: '0.11.0' }),
        entry('tagave-2026-09-28T10-00-00Z-pre-migration.pgdump', 'pre-migration', '2026-09-28T10:00:00.000Z', { version: '0.10.0', toVersion: '0.11.0' }),
      ],
      totalBytes: 3072,
    }));
    for (const title of ['>Nightly</h3>', '>Before update</h3>', '>Manual</h3>']) expect(html).toContain(title);
    expect(html).toContain('2 · 3.0 KB');
    expect(html).toContain('0.11.0');
    expect(html).toContain('0.10.0<span');
    expect(html).toContain('→ 0.11.0');
    expect(html).not.toContain('>Before restore</h3>');
  });

  it('marks a version worked out from the update history, and an unknown one', () => {
    expect(versionLabel({ version: '0.10.0', versionInferred: false })).toBe('0.10.0');
    expect(versionLabel({ version: '0.10.0', versionInferred: true })).toBe('~0.10.0');
    expect(versionLabel({ version: null, versionInferred: false })).toBe('—');
  });

  it('has one select per setting, with Off as the first time and All for manual', () => {
    const html = render(status());
    expect(html.match(/<select/g)).toHaveLength(5);
    expect(html).toContain('<option value="off">Off</option>');
    expect(html).toContain('<option value="all" selected="">All</option>');
    expect(html).toContain('<option value="7" selected="">7 days</option>');
    expect(html).toContain('<option value="4" selected="">4 weeks</option>');
    // nothing to press: changes save on their own
    expect(html).not.toContain('>Save<');
  });

  it('keeps a saved number that is not on the ladder', () => {
    const html = render(status({ settings: { enabled: false, hour: 3, keepDaily: 9, keepWeekly: 4, keepPreUpdate: 3, keepManual: 7 } }));
    expect(html).toContain('<option value="9" selected="">9 days</option>');
    expect(html).toContain('<option value="7" selected="">7</option>');
    expect(html).toContain('<option value="off" selected="">Off</option>');
  });

  it('marks the backups the next run deletes', () => {
    const pre = (d: string) => entry(`tagave-2026-10-0${d}T10-00-00Z-pre-migration.pgdump`, 'pre-migration', `2026-10-0${d}T10:00:00.000Z`);
    const html = render(status({
      backups: [pre('4'), pre('3'), pre('2')],
      kinds: [
        { kind: 'nightly', count: 0, bytes: 0, newest: null, pendingDelete: none },
        { kind: 'pre-migration', count: 3, bytes: 3072, newest: '2026-10-04T10:00:00.000Z', pendingDelete: { count: 2, bytes: 2048, names: [pre('2').name, pre('3').name] } },
        { kind: 'manual', count: 0, bytes: 0, newest: null, pendingDelete: none },
      ],
    }));
    expect(html.match(/Expires/g)).toHaveLength(2);
    expect(html).not.toContain('Next run deletes');
  });

  it('shows the before-restore group only when there is one', () => {
    const html = render(status({
      backups: [entry('tagave-2026-10-01T10-00-00Z-pre-restore.pgdump', 'pre-restore', '2026-10-01T10:00:00.000Z')],
      kinds: [...status().kinds, { kind: 'pre-restore', count: 1, bytes: 1024, newest: '2026-10-01T10:00:00.000Z', pendingDelete: none }],
    }));
    expect(html).toContain('>Before restore</h3>');
  });

  it('shows a failed night, a changed file and a folder that is not dedicated', () => {
    const html = render(status({
      dedicated: false,
      dir: '/cache/backups',
      backups: [entry('tagave-2026-09-28T10-00-00Z.pgdump', 'manual', '2026-09-28T10:00:00.000Z', { verified: false })],
      lastNightly: { kind: 'nightly', startedAt: '2026-09-29T03:00:00.000Z', finishedAt: '2026-09-29T03:00:01.000Z', ok: false, file: null, error: 'pg_dump: disk full', pruned: [] },
    }));
    expect(html).toContain('failed: pg_dump: disk full');
    expect(html).toContain('cache folder');
    expect(html).toContain('BACKUP_DIR');
    expect(html).toContain('Changed since');
    expect(html).toContain('<code>/cache/backups</code>');
    expect(html).toContain('How to restore');
  });

  it('shows "Backing up…" while a backup runs', () => {
    expect(render(status({ running: true }))).toContain('Backing up…');
  });
});

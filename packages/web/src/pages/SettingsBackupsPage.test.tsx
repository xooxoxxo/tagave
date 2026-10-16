import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupsStatus } from '@tagave/shared';
import { SettingsBackupsPage } from './SettingsBackupsPage';

const status = (over: Partial<BackupsStatus> = {}): BackupsStatus => ({
  dir: '/backups',
  dedicated: true,
  timeZone: 'UTC',
  settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null },
  running: false,
  lastRun: null,
  lastNightly: null,
  backups: [],
  kinds: [
    { kind: 'nightly', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
    { kind: 'pre-migration', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
    { kind: 'manual', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
  ],
  totalBytes: 0,
  error: null,
  ...over,
});

function render(data: BackupsStatus): string {
  const client = new QueryClient();
  client.setQueryData(['backups'], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}><SettingsBackupsPage /></QueryClientProvider>);
}

describe('SettingsBackupsPage', () => {
  it('says when the first nightly backup runs when there are none', () => {
    const html = render(status());
    expect(html).toContain('No backups yet. The first nightly backup runs at 03:00.');
    expect(html).toContain('Back up now');
  });

  it('lists backups with kind, size, the check result and an authenticated download link', () => {
    const html = render(status({
      backups: [
        { name: 'tagave-2026-09-29T03-00-00Z-nightly.pgdump', kind: 'nightly', createdAt: '2026-09-29T03:00:00.000Z', bytes: 2048, verified: true },
        { name: 'tagave-2026-09-28T10-00-00Z-pre-migration.pgdump', kind: 'pre-migration', createdAt: '2026-09-28T10:00:00.000Z', bytes: 1024, verified: null },
      ],
      totalBytes: 3072,
    }));
    expect(html).toContain('Nightly');
    expect(html).toContain('Before update');
    expect(html).toContain('Readable');
    expect(html).toContain('Not checked');
    expect(html).toContain('href="/api/v1/backups/tagave-2026-09-29T03-00-00Z-nightly.pgdump/download"');
    expect(html).toContain('2 backups, 3.0 KB in all.');
  });

  it('shows a failed night and a folder that is not dedicated', () => {
    const html = render(status({
      dedicated: false,
      dir: '/cache/backups',
      lastNightly: { kind: 'nightly', startedAt: '2026-09-29T03:00:00.000Z', finishedAt: '2026-09-29T03:00:01.000Z', ok: false, file: null, error: 'pg_dump: disk full', pruned: [] },
    }));
    expect(html).toContain('failed: pg_dump: disk full');
    expect(html).toContain('cache folder');
    expect(html).toContain('BACKUP_DIR');
  });

  it('shows "Backing up…" while a backup runs', () => {
    expect(render(status({ running: true }))).toContain('Backing up…');
  });

  it('shows each kind with its count, size, newest date and its own retention control', () => {
    const pre = (d: string) => ({ name: `tagave-2026-10-0${d}T10-00-00Z-pre-migration.pgdump`, kind: 'pre-migration' as const, createdAt: `2026-10-0${d}T10:00:00.000Z`, bytes: 1024 * 1024, verified: true });
    const html = render(status({
      backups: [pre('4'), pre('3'), pre('2'), pre('1')],
      totalBytes: 4 * 1024 * 1024,
      settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 2, keepManual: null },
      kinds: [
        { kind: 'nightly', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
        { kind: 'pre-migration', count: 4, bytes: 4 * 1024 * 1024, newest: '2026-10-04T10:00:00.000Z', pendingDelete: { count: 3, bytes: 3 * 1024 * 1024, names: [pre('1').name, pre('2').name, pre('3').name] } },
        { kind: 'manual', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
      ],
    }));
    for (const title of ['Keeping backups', '>Nightly</h4>', '>Before update</h4>', '>Manual</h4>']) expect(html).toContain(title);
    expect(html).toContain('4 backups, 4.0 MB, newest');
    expect(html).toContain('Keep the newest');
    expect(html).toContain('min="1"');
    expect(html).toContain('Back up now and backups taken by hand are kept until you delete them.');
    // what goes at the next update, with the total size and which backups
    expect(html).toContain('3 older backups (3.0 MB) go at the next run:');
    expect(html).toContain(pre('1').name);
    // no restore block until there is a pre-restore backup
    expect(html).not.toContain('>Before restore</h4>');
  });

  it('shows the before-restore block only when there is one, without a retention control', () => {
    const html = render(status({
      kinds: [
        ...status().kinds,
        { kind: 'pre-restore', count: 1, bytes: 2048, newest: '2026-10-01T10:00:00.000Z', pendingDelete: { count: 0, bytes: 0, names: [] } },
      ],
    }));
    expect(html).toContain('>Before restore</h4>');
    expect(html).toContain('1 backup, 2.0 KB, newest');
    expect(html).toContain('Kept until you delete them.');
  });

  it('says nothing goes when the saved numbers keep everything', () => {
    expect(render(status())).not.toContain('at the next run:');
  });
});

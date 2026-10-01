import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupsStatus } from '@liner/shared';
import { SettingsBackupsPage } from './SettingsBackupsPage';

const status = (over: Partial<BackupsStatus> = {}): BackupsStatus => ({
  dir: '/backups',
  dedicated: true,
  timeZone: 'UTC',
  settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4 },
  running: false,
  lastRun: null,
  lastNightly: null,
  backups: [],
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
        { name: 'liner-2026-09-29T03-00-00Z-nightly.pgdump', kind: 'nightly', createdAt: '2026-09-29T03:00:00.000Z', bytes: 2048, verified: true },
        { name: 'liner-2026-09-28T10-00-00Z-pre-migration.pgdump', kind: 'pre-migration', createdAt: '2026-09-28T10:00:00.000Z', bytes: 1024, verified: null },
      ],
      totalBytes: 3072,
    }));
    expect(html).toContain('Nightly');
    expect(html).toContain('Before update');
    expect(html).toContain('Readable');
    expect(html).toContain('Not checked');
    expect(html).toContain('href="/api/v1/backups/liner-2026-09-29T03-00-00Z-nightly.pgdump/download"');
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
});

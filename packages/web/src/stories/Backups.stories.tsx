import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupEntryView, BackupKindView, BackupsStatus } from '@tagave/shared';
import { SettingsBackupsPage } from '../pages/SettingsBackupsPage';

const MB = 1024 ** 2;
const dump = (iso: string, kind: BackupKindView, bytes: number): BackupEntryView => ({
  name: `tagave-${iso.replace(/:/g, '-').replace('.000Z', 'Z')}${kind === 'manual' ? '' : `-${kind}`}.pgdump`,
  kind,
  createdAt: iso,
  bytes,
  verified: true,
});

const nightly = ['2026-10-16', '2026-10-15', '2026-10-14'].map((d) => dump(`${d}T03:00:00.000Z`, 'nightly', 690 * MB));
const preUpdate = ['2026-10-12', '2026-10-09', '2026-10-05', '2026-10-01', '2026-09-24'].map((d) => dump(`${d}T09:00:00.000Z`, 'pre-migration', 700 * MB));
const manual = [dump('2026-10-10T18:30:00.000Z', 'manual', 680 * MB)];
const restore = [dump('2026-09-30T20:00:00.000Z', 'pre-restore', 650 * MB)];

function block(kind: BackupKindView, list: BackupEntryView[], going: BackupEntryView[] = []) {
  return {
    kind,
    count: list.length,
    bytes: list.reduce((s, b) => s + b.bytes, 0),
    newest: list[0]?.createdAt ?? null,
    pendingDelete: { count: going.length, bytes: going.reduce((s, b) => s + b.bytes, 0), names: going.map((b) => b.name) },
  };
}

const backups = [...nightly, ...preUpdate, ...manual, ...restore].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const data: BackupsStatus = {
  dir: '/backups',
  dedicated: true,
  timeZone: 'Europe/Amsterdam',
  settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null },
  running: false,
  lastRun: null,
  lastNightly: null,
  backups,
  // keep 3 before-update backups: the next update writes one and the three oldest go
  kinds: [block('nightly', nightly), block('pre-migration', preUpdate, preUpdate.slice(2).reverse()), block('manual', manual), block('pre-restore', restore)],
  totalBytes: backups.reduce((s, b) => s + b.bytes, 0),
  error: null,
};

/** The page with its data already loaded; nothing is fetched. */
function Page({ status }: { status: BackupsStatus }) {
  const [client] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    c.setQueryData(['backups'], status);
    return c;
  });
  return <QueryClientProvider client={client}><div style={{ padding: '0 16px' }}><SettingsBackupsPage /></div></QueryClientProvider>;
}

const meta = {
  title: 'Pages/Backups',
  component: Page,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { status: data },
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Settings › Backups: every dump, then one block per kind (nightly, before update, manual, and before restore when there is one) with its count, size, newest date, retention, and what its next run deletes.' } },
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Phone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };

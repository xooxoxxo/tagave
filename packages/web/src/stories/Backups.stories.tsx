import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupEntryView, BackupKindView, BackupsStatus } from '@tagave/shared';
import { SettingsBackupsPage } from '../pages/SettingsBackupsPage';

const MB = 1024 ** 2;
const dump = (iso: string, kind: BackupKindView, mb: number, version: string | null, versionInferred = false, toVersion: string | null = null): BackupEntryView => ({
  name: `tagave-${iso.replace(/:/g, '-').replace('.000Z', 'Z')}${kind === 'manual' ? '' : `-${kind}`}.pgdump`,
  kind,
  createdAt: iso,
  bytes: Math.round(mb * MB),
  verified: true,
  version,
  versionInferred,
  toVersion,
});

// versions 0.9.0 to 0.11.0: recorded ones, ones worked out from the update history (~), and one unknown
const nightly = [
  dump('2026-10-20T03:00:00.000Z', 'nightly', 694, '0.11.0'),
  dump('2026-10-19T03:00:00.000Z', 'nightly', 692, '0.11.0'),
  dump('2026-10-18T03:00:00.000Z', 'nightly', 690, '0.11.0'),
  dump('2026-10-17T03:00:00.000Z', 'nightly', 688, '0.11.0'),
  dump('2026-10-12T03:00:00.000Z', 'nightly', 671, '0.10.0', true),
  dump('2026-10-05T03:00:00.000Z', 'nightly', 655, '0.10.0', true),
  dump('2026-09-28T03:00:00.000Z', 'nightly', 631, '0.9.0', true),
];
const preUpdate = [
  dump('2026-10-16T16:40:00.000Z', 'pre-migration', 686, '0.10.0', false, '0.11.0'),
  dump('2026-10-02T07:10:00.000Z', 'pre-migration', 648, '0.9.0', false, '0.10.0'),
];
const manual = [dump('2026-10-15T12:12:00.000Z', 'manual', 684, '0.10.0'), dump('2026-09-14T17:30:00.000Z', 'manual', 598, null)];

function block(kind: BackupKindView, list: BackupEntryView[], going: BackupEntryView[] = []) {
  return {
    kind,
    count: list.length,
    bytes: list.reduce((s, b) => s + b.bytes, 0),
    newest: list[0]?.createdAt ?? null,
    pendingDelete: { count: going.length, bytes: going.reduce((s, b) => s + b.bytes, 0), names: going.map((b) => b.name) },
  };
}

function status(over: Partial<BackupsStatus> & { lists?: Partial<Record<BackupKindView, BackupEntryView[]>>; going?: Partial<Record<BackupKindView, BackupEntryView[]>> } = {}): BackupsStatus {
  const { lists = { nightly, 'pre-migration': preUpdate, manual }, going = {}, ...rest } = over;
  const all = Object.values(lists).flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kinds: BackupKindView[] = ['nightly', 'pre-migration', 'manual', ...(lists['pre-restore'] ? ['pre-restore' as const] : [])];
  return {
    dir: '/backups',
    dedicated: true,
    timeZone: 'Europe/Amsterdam',
    settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 5, keepManual: null },
    running: false,
    lastRun: null,
    lastNightly: null,
    backups: all,
    restoreCommand: 'docker compose stop app worker-identify worker-files\ndocker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore {file} --yes\ndocker compose up -d',
    kinds: kinds.map((k) => block(k, lists[k] ?? [], going[k] ?? [])),
    totalBytes: all.reduce((s, b) => s + b.bytes, 0),
    error: null,
    ...rest,
  };
}

/** The page with its data already loaded; nothing is fetched. */
function Page({ status: data }: { status: BackupsStatus }) {
  const [client] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    c.setQueryData(['backups'], data);
    return c;
  });
  return <QueryClientProvider client={client}><div style={{ padding: '0 16px', maxWidth: 850 }}><SettingsBackupsPage /></div></QueryClientProvider>;
}

const meta = {
  title: 'Pages/Backups',
  component: Page,
  args: { status: status() },
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Settings › Backups: one grouped list per kind (nightly, before update, manual, and before restore when there is one). Each setting is a row with one select, saved as it changes; under it, the kind\'s backups: date · version (~ when worked out from the update history, — when unknown) · size · ⋯ (Download, Copy restore command, Delete).' } },
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Phone: Story = { tags: ['phone', 'shot-full'], globals: { viewport: { value: 'phone' } } };

/** A fresh install: no backups, nightly on. */
export const Empty: Story = { args: { status: status({ lists: { nightly: [], 'pre-migration': [], manual: [] } }) } };

/** The night failed, the folder is the fallback in the cache, two dumps go at the next run, one changed on disk, and a restore left a dump behind. */
export const Problems: Story = {
  args: {
    status: status({
      dedicated: false,
      dir: '/cache/backups',
      lastNightly: { kind: 'nightly', startedAt: '2026-10-20T03:00:00.000Z', finishedAt: '2026-10-20T03:00:04.000Z', ok: false, file: null, error: 'pg_dump: could not write to file: No space left on device', pruned: [] },
      settings: { enabled: true, hour: 3, keepDaily: 3, keepWeekly: 1, keepPreUpdate: 5, keepManual: null },
      lists: {
        nightly: nightly.slice(0, 5),
        'pre-migration': preUpdate,
        manual: [{ ...manual[0]!, verified: false }],
        'pre-restore': [dump('2026-10-18T20:00:00.000Z', 'pre-restore', 690, '0.11.0')],
      },
      going: { nightly: nightly.slice(3, 5) },
    }),
  },
};

/** Nightly off: the time select says Off. */
export const NightlyOff: Story = {
  args: { status: status({ settings: { enabled: false, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 5, keepManual: 10 } }) },
};

/** The ⋯ menu of the newest backup. */
export const BackupMenu: Story = {
  tags: ['shot-viewport'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: /^More for the backup of/ })[0]!);
    await expect(within(document.body).getByRole('menuitem', { name: 'Copy restore command' })).toBeVisible();
  },
};

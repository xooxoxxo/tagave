import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ScanRoot } from '@tagave/shared';
import { MusicFoldersView } from '../pages/SettingsScanRootsPage';

// Local times (no Z) for both, so "since" reads the same in every time zone.
const NOW = new Date('2026-11-24T16:00:00');
const SINCE = '2026-11-24T14:02:00';
const at = '2026-11-01T10:00:00.000Z';
const noop = () => undefined;

const root = (over: Partial<ScanRoot> = {}): ScanRoot => ({
  id: '11111111-1111-4111-8111-111111111111', libraryId: '22222222-2222-4222-8222-222222222222', path: '/mnt/music', displayName: 'Music',
  writable: true, enabled: true, pollIntervalS: 21600, validationStatus: 'ok', validationMessage: null, probeWritable: true,
  lastScanAt: at, lastStatus: 'done', albumsFound: 1204, tracksFound: 14873, folderLink: 'smb://music.example.com/music/', createdAt: at, updatedAt: at,
  reach: 'online', reachSince: '2026-11-20T08:00:00', waiting: { scans: 0, tagWrites: 0, other: 0 }, ...over,
});

const online = [root()];
const offline = [root({ reach: 'offline', reachSince: SINCE, waiting: { scans: 1, tagWrites: 3, other: 0 } })];
const notConnected = [root({ reach: 'unmounted', reachSince: SINCE, waiting: { scans: 1, tagWrites: 0, other: 2 } })];

const meta = {
  title: 'Settings/Library',
  component: MusicFoldersView,
  args: { roots: online, now: NOW, onUpdate: () => Promise.resolve(null), onScan: noop, onCheck: noop, onRemove: noop, onAdd: () => true },
  parameters: {
    docs: { description: { component: 'Settings › Library, Music folders: each folder’s Check says what the folder watch last saw (Online, Offline since, Not connected since, Checking), and Waiting what work waits for the folder to come back. The help for each sits behind its "?". Scan stays on while the folder is offline: it is queued and runs when the folder is back.' } },
  },
} satisfies Meta<typeof MusicFoldersView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Online, nothing waits. */
export const Online: Story = {};
/** Offline since 14:02: three tag writes and a scan wait. */
export const Offline: Story = { args: { roots: offline } };
/** The folder is there but its share isn't connected. */
export const NotConnected: Story = { name: 'Not connected', args: { roots: notConnected } };
/** No reading from the folder watch yet. */
export const Checking: Story = { args: { roots: [root({ reach: 'unknown', reachSince: null })] } };

export const PhoneOnline: Story = { name: 'Phone, online', tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneOffline: Story = { name: 'Phone, offline', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { roots: offline } };
export const PhoneNotConnected: Story = { name: 'Phone, not connected', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { roots: notConnected } };
export const PhoneChecking: Story = { name: 'Phone, checking', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { roots: [root({ reach: 'unknown', reachSince: null })] } };

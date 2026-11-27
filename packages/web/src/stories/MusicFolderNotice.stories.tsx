import type { Meta, StoryObj } from '@storybook/react-vite';
import type { MusicFolderView } from '@tagave/shared';
import { MusicFolderNoticeView } from '../components/MusicFolderNotice';

// Local times (no Z) for both, so the banner reads the same in every time zone.
const NOW = new Date('2026-11-24T16:00:00');
const SINCE = '2026-11-24T14:02:00';

const folder = (over: Partial<MusicFolderView> = {}): MusicFolderView => ({
  id: 'root-1', name: 'Music', path: '/mnt/music', reach: 'offline', since: SINCE, reason: 'server_silent',
  waiting: { scans: 1, tagWrites: 0, other: 0 }, ...over,
});

const meta = {
  title: 'Pages/Music folder notice',
  component: MusicFolderNoticeView,
  args: { state: { kind: 'offline', folders: [folder()] }, now: NOW, action: <a href="#library">Music folders</a> },
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'The owner’s notice above every page but Settings › Library while tagave can’t reach a music folder: since when, or how many, with the way to Music folders. Reconnecting while the updater mounts it again.' } },
  },
} satisfies Meta<typeof MusicFolderNoticeView>;
export default meta;
type Story = StoryObj<typeof meta>;

const notConnected = { state: { kind: 'offline', folders: [folder({ reach: 'unmounted', reason: 'not_mounted' })] } } satisfies Story['args'];
const several = { state: { kind: 'offline', folders: [folder(), folder({ id: 'root-2', name: 'Vinyl rips', path: '/mnt/vinyl', since: '2026-11-23T09:10:00' })] } } satisfies Story['args'];
const reconnecting = { state: { kind: 'healing', folders: [] } } satisfies Story['args'];

export const Offline: Story = {};
export const NotConnected: Story = { name: 'Not connected', args: notConnected };
export const Several: Story = { args: several };
export const Reconnecting: Story = { args: reconnecting };
export const PhoneOffline: Story = { name: 'Phone, offline', tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const PhoneNotConnected: Story = { name: 'Phone, not connected', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: notConnected };
export const PhoneSeveral: Story = { name: 'Phone, several', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: several };
export const PhoneReconnecting: Story = { name: 'Phone, reconnecting', tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: reconnecting };

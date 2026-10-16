import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DiskSpaceView } from '@tagave/shared';
import { DiskSpaceNoticeView } from '../components/DiskSpaceNotice';
import { DiskSpace } from '../pages/SettingsStoragePage';

const GB = 1024 ** 3;
const disk = (usedPct: number, status: DiskSpaceView['status']): DiskSpaceView => ({
  status,
  warnPct: 85,
  failPct: 95,
  checkedAt: '2026-10-16T08:00:00.000Z',
  filesystems: [
    { totalBytes: 200 * GB, usedBytes: usedPct * 2 * GB, freeBytes: (100 - usedPct) * 2 * GB, usedPct, status, paths: [{ key: 'backups', label: 'Backups', path: '/backups' }, { key: 'cache', label: 'Cache', path: '/cache' }] },
  ],
  unmeasured: [{ key: 'database', label: 'Database', path: null, reason: 'Postgres runs on "postgres", so its disk cannot be measured from here. Run df -h on the machine that holds its data (in Docker, the Docker host)' }],
});

function Both({ data }: { data: DiskSpaceView }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
    <DiskSpaceNoticeView disk={data} action={<a href="#storage">Open Settings › Storage</a>} />
    <div style={{ padding: '0 16px' }}><DiskSpace disk={data} /></div>
  </div>;
}

const meta = {
  title: 'Pages/Disk space',
  component: Both,
  // No screenshot baseline yet: render one on the CI runner (DESIGN.md) and drop `no-shot`.
  tags: ['no-shot'],
  args: { data: disk(42, 'pass') },
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Free space per disk on Settings › Storage, and the owner’s notice above every page while a disk tagave writes is filling up (85 % used) or almost full (95 %).' } },
  },
} satisfies Meta<typeof Both>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Fine: Story = {};
export const FillingUp: Story = { args: { data: disk(88, 'warn') } };
export const AlmostFull: Story = { args: { data: disk(97, 'fail') } };
export const AlmostFullPhone: Story = { args: { data: disk(97, 'fail') }, tags: ['phone'], globals: { viewport: { value: 'phone' } } };

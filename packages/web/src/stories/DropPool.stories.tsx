import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DropPoolView } from '@tagave/shared';
import { DropPoolSettingsView } from '../components/naming/DropPoolSettings';

const ROOT = '11111111-1111-4111-8111-111111111111';
const base: DropPoolView = {
  enabled: true,
  scanRootId: ROOT,
  dirPath: '_Inbox',
  path: '/mnt/music/_Inbox',
  hostPath: '/srv/music/_Inbox',
  roots: [{ id: ROOT, path: '/mnt/music' }],
  counts: { waiting: 1, inbox: 3, imported: 42, skipped: 0 },
  problem: null,
  state: 'ready',
};
const noop = () => undefined;

const meta = {
  title: 'Settings/Library/Drop pool',
  component: DropPoolSettingsView,
  args: { view: base, onPut: noop },
  parameters: {
    docs: {
      description: {
        component: 'Settings › Library › Drop pool: Off | On, the folder, and one line with what the file worker last found there: Ready · the folder, Can’t reach the music folder (the worker does not see the music share), or Folder missing.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 850, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof DropPoolSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Unreachable: Story = { args: { view: { ...base, state: 'unreachable' } } };
export const Missing: Story = { args: { view: { ...base, state: 'missing' } } };
export const ReadyPhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const UnreachablePhone: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { view: { ...base, state: 'unreachable' } } };

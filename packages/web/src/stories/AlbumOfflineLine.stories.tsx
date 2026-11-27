import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlbumOfflineLine, offlineLine } from '../pages/albumOffline';

// pinned, so "since 14:02" reads the same on every run
const NOW = new Date(2026, 10, 24, 18, 0);
const SINCE = new Date(2026, 10, 24, 14, 2).toISOString();
const all = offlineLine({ filesOffline: 'all', offlineSince: SINCE }, NOW)!;
const some = offlineLine({ filesOffline: 'some', offlineSince: SINCE }, NOW)!;

const meta = {
  title: 'Album/Files offline line',
  component: AlbumOfflineLine,
  args: { line: all },
  // the album column: the phone's 22px gutters
  decorators: [(Story) => <div style={{ padding: '24px 22px' }}><Story /></div>],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The quiet line under the album\'s facts while its music folder can\'t be reached: "Files offline since 14:02" for all of its files, "Some files offline" for part of them. What it means is behind the "?" (HelpToggle). Everyone sees it; it does not depend on the player. The albums grid says the same with a small "Files offline" tag on the tile.',
      },
    },
  },
} satisfies Meta<typeof AlbumOfflineLine>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FilesOffline: Story = {};
export const PhoneFilesOffline: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } } };
export const SomeFilesOffline: Story = { args: { line: some } };
export const PhoneSomeFilesOffline: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { line: some } };

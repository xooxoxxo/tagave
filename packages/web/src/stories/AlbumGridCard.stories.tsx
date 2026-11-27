import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AlbumSummary } from '@tagave/shared';
import { AlbumGridCard } from '../pages/AlbumGridCard';
import { COVERS } from './adaptiveCovers';

const album = (n: number, cover: keyof typeof COVERS, over: Partial<AlbumSummary> = {}): AlbumSummary => ({
  id: `00000000-0000-7000-8000-00000000000${n}`, libraryId: '00000000-0000-7000-8000-000000000100', localAlbumId: `00000000-0000-7000-8000-00000000020${n}`,
  title: COVERS[cover].album, artistCredit: COVERS[cover].artist, year: 2019 + n, formats: ['flac'], isLossless: true, state: 'matched', trackCount: 9 + n,
  coverUrl: COVERS[cover].src, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', ...over,
});
const OFFLINE = album(2, 'bright', { filesOffline: 'all', offlineSince: '2026-11-24T14:02:00.000Z' });
const ROW = [album(1, 'moody'), OFFLINE, album(3, 'pastel', { formats: ['mp3'], isLossless: false })];

const meta = {
  title: 'Albums/Grid tile',
  component: AlbumGridCard,
  args: { album: OFFLINE, width: 200, pad: 16, narrow: false, selected: false, maintenance: false, attention: false },
  // a row of the grid, the offline album in the middle (the grid's own gaps: 24px, 4px on a phone)
  render: (args) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: args.narrow ? 4 : 24, padding: args.narrow ? '16px' : '24px' }}>
      {ROW.map((a) => <AlbumGridCard key={a.id} {...args} album={a} />)}
    </div>
  ),
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'One album of the albums grid. While its music folder can\'t be reached, the stats line starts with a small "Files offline" Badge, for everyone; the cover still shows. The tag sits inside the stats line, so every card keeps the one height the grid\'s virtualizer uses.',
      },
    },
  },
} satisfies Meta<typeof AlbumGridCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FilesOffline: Story = {};
// a phone's grid: two tight cards a row (390px less 16px gutters and the 4px gap, a pixel spare)
export const PhoneFilesOffline: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { width: 176, pad: 8, narrow: true } };

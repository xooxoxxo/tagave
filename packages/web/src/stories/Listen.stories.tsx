import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { ListenLinkView } from '@tagave/shared';
import { ListenControl, MissingListenLinks } from '../components/ListenControl';
import { AlbumGrid } from '../pages/ArtistParts';
import type { ArtistAlbum } from '../hooks';

const qobuz: ListenLinkView = { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/album/0634904078164', kind: 'exact' };
const spotify: ListenLinkView = { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', kind: 'artist' };
const apple: ListenLinkView = { platform: 'apple', name: 'Apple Music', url: 'https://music.apple.com/search?term=Radiohead%20Amnesiac', kind: 'search' };

const missing = (key: string, title: string, year: number): ArtistAlbum => ({
  key: `rg:${key}`, localAlbumId: null, releaseGroupId: key, title, year, primaryType: 'Album',
  ownership: 'missing', trackCount: null, coverUrl: null, matchedBy: 'gap', gapId: `gap-${key}`,
});
const ALBUMS = [missing('rg1', 'Amnesiac', 2001), missing('rg2', 'Hail to the Thief', 2003), missing('rg3', 'In Rainbows', 2007)];

const meta = {
  title: 'Album/Listen',
  component: ListenControl,
  args: { links: [qobuz] },
  parameters: {
    docs: {
      description: {
        component: 'Listen elsewhere (the listen-links module): one control on a missing album, the platforms the person picked in Settings › Listen elsewhere. One platform: a direct link with its name. Several: a Listen key with a menu, in the person\'s order. A link that is not the album itself is marked Artist page or Search. Opens in a new tab, or the platform\'s app on a phone.',
      },
    },
  },
  decorators: [(Story) => <div style={{ padding: 24 }}><Story /></div>],
} satisfies Meta<typeof ListenControl>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OnePlatform: Story = {};
export const OnePlatformSearch: Story = { args: { links: [apple] } };
export const SeveralPlatforms: Story = {
  args: { links: [qobuz, spotify, apple] },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Listen' }));
    await expect(await within(document.body).findByRole('menu')).toBeVisible();
  },
};

/** The artist page's "Not in your library": each missing album with its Listen control. */
export const MissingAlbums: Story = {
  render: () => (
    <MissingListenLinks.Provider value={{ rg1: [qobuz], rg2: [qobuz, spotify, apple], rg3: [apple] }}>
      <div style={{ maxWidth: 760 }}><AlbumGrid albums={ALBUMS} /></div>
    </MissingListenLinks.Provider>
  ),
};
export const MissingAlbumsPhone: Story = { ...MissingAlbums, tags: ['phone'], globals: { viewport: { value: 'phone' } } };

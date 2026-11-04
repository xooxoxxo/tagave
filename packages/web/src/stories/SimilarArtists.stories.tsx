import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { ArtistSimilarView, ListenLinkView } from '@tagave/shared';
import { SimilarArtistsView } from '../pages/SimilarArtists';

const search = (name: string): ListenLinkView[] => [
  { platform: 'qobuz', name: 'Qobuz', url: `https://www.qobuz.com/search?q=${encodeURIComponent(name)}`, kind: 'search' },
  { platform: 'spotify', name: 'Spotify', url: `https://open.spotify.com/search/${encodeURIComponent(name)}`, kind: 'search' },
];

const VIEW: ArtistSimilarView = {
  available: true,
  pending: false,
  primary: 'qobuz',
  inLibrary: [
    { artistId: 'a1', name: 'Portishead', coverAlbumIds: [], albums: 3 },
    { artistId: 'a2', name: 'Massive Attack', coverAlbumIds: [], albums: 5 },
    { artistId: 'a3', name: 'Björk', coverAlbumIds: [], albums: 1 },
  ],
  elsewhere: [
    { mbid: 'm1', name: 'Thom Yorke', comment: 'English musician, Radiohead', artistId: null, followed: false, listen: search('Thom Yorke') },
    { mbid: 'm2', name: 'The Smile', comment: 'UK rock band', artistId: 'a9', followed: true, listen: search('The Smile') },
    { mbid: 'm3', name: 'Atoms for Peace', comment: null, artistId: null, followed: false, listen: search('Atoms for Peace') },
    { mbid: 'm4', name: 'Sigur Rós', comment: 'Icelandic post-rock band', artistId: null, followed: false, listen: [] },
  ],
};

const meta = {
  title: 'Artist/Similar artists',
  component: SimilarArtistsView,
  args: { view: VIEW, onFollow: () => undefined, onPlay: () => undefined },
  parameters: {
    docs: {
      description: {
        component: 'The artist page\'s Similar artists (the similar-artists module): the artists in your library first (their card, Play), then the rest dimmed with Listen elsewhere and Follow. A phone shows the cards in one sideways row.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 900 }}><Story /></div>],
} satisfies Meta<typeof SimilarArtistsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Both: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByRole('link', { name: /Portishead/ })).toBeVisible();
    await expect(c.getAllByRole('button', { name: 'Follow' })).toHaveLength(3);
    await expect(c.getByRole('button', { name: 'Play Portishead' })).toBeVisible();
    await expect(c.getByText('Following')).toBeVisible();
  },
};

/** A listener: no Follow; no player: no Play. */
export const Listener: Story = { render: (args) => <SimilarArtistsView view={args.view} /> };

export const OnlyElsewhere: Story = { args: { view: { ...VIEW, inLibrary: [] } } };

/** The first fetch on its way. */
export const Loading: Story = { args: { view: { ...VIEW, pending: true, inLibrary: [], elsewhere: [] } } };

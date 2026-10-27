import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaylistsGrid } from '../pages/PlaylistsPage';
import { PlaylistPageView } from '../pages/PlaylistPage';
import { TrackActions } from '../components/player/TrackActions';
import { PlaylistsModuleRow } from '../pages/SettingsModulesPage';
import { playlistsKey } from '../hooks/usePlaylists';
import { COVERS, PLAYLIST, PLAYLISTS } from './queueFixtures';

const noop = () => undefined;

/** A query cache holding the person's playlists, as the app would have them. */
function WithLists({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    c.setQueryData(playlistsKey, PLAYLISTS);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
  title: 'Components/Playlists',
  decorators: [(Story) => <WithLists><Story /></WithLists>],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Playlists, a module of their own: each person\'s private lists. The Playlists page is a grid of mosaic covers (the first four albums of a list). A track\'s ⋮ has Play next, Add to queue and Add to playlist: on a desktop a submenu of the person\'s lists, New playlist first; on a phone the drawer turns into the list. A playlist page plays from a row, reorders by its handles, renames in place, and its ⋮ exports or deletes it; a track that left the library stays, dimmed, as Missing. Export and import use *.tagave-playlist.json (version 1, no file paths); M3U8 and XSPF import too.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Grid: Story = { tags: ['shot-viewport'], render: () => <div style={{ padding: 24 }}><PlaylistsGrid playlists={PLAYLISTS} /></div> };
export const GridNew: Story = { name: 'Grid · New playlist', tags: ['shot-viewport'], render: () => <div style={{ padding: 24 }}><PlaylistsGrid playlists={PLAYLISTS} naming onCreate={async () => undefined} /></div> };
export const GridPhone: Story = { name: 'Grid · Phone', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => <div style={{ padding: 16 }}><PlaylistsGrid playlists={PLAYLISTS} /></div> };

const page = (over: Partial<Parameters<typeof PlaylistPageView>[0]> = {}) => (
  <PlaylistPageView
    playlist={PLAYLIST} canPlay playing={null} currentTrackId={null}
    onPlay={noop} onShuffle={noop} onToggle={noop} onRename={async () => undefined} onMove={noop} onRemove={noop} onDelete={noop} onExport={noop}
    {...over}
  />
);
export const Playlist: Story = { tags: ['shot-viewport', 'shot-full'], render: () => page() };
export const PlaylistPlaying: Story = { name: 'Playlist · playing', tags: ['shot-viewport', 'shot-full'], render: () => page({ playing: 'playing', currentTrackId: 'l2' }) };
export const PlaylistPhone: Story = { name: 'Playlist · Phone', tags: ['phone', 'shot-full'], globals: { viewport: { value: 'phone' } }, render: () => page() };

const actions = { label: 'More for Blue in Green', summary: { title: 'Blue in Green', subtitle: 'Miles Davis · Kind of Blue', coverUrl: COVERS.kob }, source: { trackIds: ['l1'] }, albumId: 'album-kob', abilities: { queue: true, playlists: true } };
export const TrackMenuDesktop: Story = {
  name: 'Track ⋮ · Desktop, Add to playlist',
  tags: ['shot-viewport'],
  render: () => <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 24px' }}><TrackActions {...actions} drawer={false} defaultOpen defaultStep="playlists" /></div>,
};
export const TrackMenuPhone: Story = {
  name: 'Track ⋮ · Phone drawer',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => <TrackActions {...actions} drawer defaultOpen />,
};
export const TrackMenuPhonePlaylists: Story = {
  name: 'Track ⋮ · Phone, Add to playlist',
  tags: ['phone'],
  globals: { viewport: { value: 'phone' } },
  render: () => <TrackActions {...actions} drawer defaultOpen defaultStep="playlists" />,
};

export const ModuleRow: Story = {
  name: 'Settings › Modules row',
  render: () => <div style={{ padding: 24, maxWidth: 760 }}><PlaylistsModuleRow view={{ enabled: true, playlists: 14, people: 3 }} onTurnOn={noop} onTurnOff={noop} /></div>,
};
export const ModuleRowOff: Story = {
  name: 'Settings › Modules row · off',
  render: () => <div style={{ padding: 24, maxWidth: 760 }}><PlaylistsModuleRow view={{ enabled: false, playlists: 14, people: 3 }} onTurnOn={noop} onTurnOff={noop} /></div>,
};
